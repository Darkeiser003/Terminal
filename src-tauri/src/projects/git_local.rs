//! «Mi GitHub» ampliado: git en la copia local de un repositorio de la cuenta.
//!
//! Ver los cambios, hacer commit y crear, cambiar o borrar ramas se hace aquí
//! con `git -C <copia>` y argumentos fijos: son operaciones locales que no
//! piden credenciales. Subir (push), traer (pull) y publicar una rama van a una
//! pestaña visible (`commands::github_git_terminal`), porque pueden preguntar.
//!
//! La carpeta nunca la elige el panel: sale de la carpeta de proyectos y del
//! nombre del repositorio (`<proyectos>/<propietario>/<nombre>`), y solo para
//! repositorios del listado de la cuenta.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::projects::gh_cli::{self, GhResult};
use crate::projects::gh_manage::{clean_body, valid_ref_name};

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_FILES_SHOWN: usize = 200;
const MAX_MESSAGE_CHARS: usize = 5_000;
/// Git nunca pregunta: sin terminal ni ventanas de credenciales.
const GIT_ENVIRONMENT: [(&str, &str); 2] =
    [("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "never")];

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Las dos letras de `git status --porcelain` (`M `, ` M`, `??`…).
    pub code: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGitStatus {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ChangedFile>,
    /// Hay más cambios que los que se enseñan.
    pub truncated: bool,
    pub branches: Vec<String>,
}

/// Lee la salida de `git status --porcelain=v1 --branch`.
pub fn parse_status(output: &str) -> LocalGitStatus {
    let mut status = LocalGitStatus::default();
    for line in output.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            parse_branch_header(header, &mut status);
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        if status.files.len() >= MAX_FILES_SHOWN {
            status.truncated = true;
            continue;
        }
        let (code, path) = line.split_at(2);
        status.files.push(ChangedFile {
            code: code.to_string(),
            path: path.trim_start().trim_matches('"').to_string(),
        });
    }
    status
}

fn parse_branch_header(header: &str, status: &mut LocalGitStatus) {
    // «No commits yet on main», «HEAD (no branch)», «main...origin/main [ahead 1, behind 2]».
    let header = header.strip_prefix("No commits yet on ").unwrap_or(header);
    let (names, counts) = match header.split_once(" [") {
        Some((names, counts)) => (names, counts.trim_end_matches(']')),
        None => (header, ""),
    };
    match names.split_once("...") {
        Some((branch, upstream)) => {
            status.branch = branch.to_string();
            status.upstream = Some(upstream.to_string());
        }
        None => status.branch = names.to_string(),
    }
    for part in counts.split(", ") {
        if let Some(number) = part.strip_prefix("ahead ") {
            status.ahead = number.parse().unwrap_or(0);
        } else if let Some(number) = part.strip_prefix("behind ") {
            status.behind = number.parse().unwrap_or(0);
        }
    }
}

/// Mensaje de commit: sin caracteres de control salvo saltos de línea.
pub fn commit_message(message: &str) -> Result<String, String> {
    let message = clean_body(message, MAX_MESSAGE_CHARS);
    if message.is_empty() {
        return Err("Escribe un mensaje para el commit.".into());
    }
    Ok(message)
}

/// Qué se hace con una rama.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchAction {
    Create,
    Switch,
    Delete,
}

impl BranchAction {
    pub fn parse(value: &str) -> Option<BranchAction> {
        match value {
            "create" => Some(BranchAction::Create),
            "switch" => Some(BranchAction::Switch),
            "delete" => Some(BranchAction::Delete),
            _ => None,
        }
    }
}

/// `git switch -c`, `git switch` o `git branch -d` (nunca `-D`: una rama sin
/// fusionar no se borra).
pub fn branch_args(action: BranchAction, name: &str) -> Result<Vec<String>, String> {
    let name = name.trim();
    if !valid_ref_name(name) {
        return Err(format!("Nombre de rama no válido: {name}"));
    }
    let args: &[&str] = match action {
        BranchAction::Create => &["switch", "-c"],
        BranchAction::Switch => &["switch"],
        BranchAction::Delete => &["branch", "-d"],
    };
    Ok(args
        .iter()
        .map(|arg| (*arg).to_string())
        .chain(std::iter::once(name.to_string()))
        .collect())
}

fn git(path: &Path, args: &[String]) -> Result<String, String> {
    let path = path.to_string_lossy().into_owned();
    let mut full: Vec<&str> = vec!["-C", &path];
    full.extend(args.iter().map(String::as_str));
    let output =
        crate::process::run_with_timeout_capture("git", &full, GIT_TIMEOUT, &GIT_ENVIRONMENT)
            .ok_or_else(|| "git no respondió a tiempo (¿está instalado?).".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Err(gh_cli::short_message(if stderr.trim().is_empty() {
        &stdout
    } else {
        &stderr
    }))
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

pub fn status_at(path: &Path) -> Result<LocalGitStatus, String> {
    let mut status = parse_status(&git(
        path,
        &strings(&[
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
        ]),
    )?);
    status.branches = git(path, &strings(&["branch", "--format=%(refname:short)"]))?
        .lines()
        .map(str::trim)
        .filter(|name| valid_ref_name(name))
        .map(str::to_string)
        .collect();
    Ok(status)
}

/// Añade todos los cambios y hace commit con el mensaje.
pub fn commit_at(path: &Path, message: &str) -> GhResult {
    let message = match commit_message(message) {
        Ok(message) => message,
        Err(error) => return failed(error),
    };
    if let Err(error) = git(path, &strings(&["add", "--all"])) {
        return failed(error);
    }
    match git(path, &["commit".to_string(), "-m".to_string(), message]) {
        Ok(_) => done("Commit hecho. Súbelo con «Subir (push)»."),
        Err(error)
            if error.contains("nothing to commit") || error.contains("nada para hacer commit") =>
        {
            failed("No hay cambios que guardar.")
        }
        Err(error)
            if error.contains("user.email") || error.contains("Please tell me who you are") =>
        {
            failed(
                "git no sabe quién eres: configura user.name y user.email (git config --global).",
            )
        }
        Err(error) => failed(error),
    }
}

pub fn branch_at(path: &Path, action: BranchAction, name: &str) -> GhResult {
    let args = match branch_args(action, name) {
        Ok(args) => args,
        Err(error) => return failed(error),
    };
    match git(path, &args) {
        Ok(_) => done(match action {
            BranchAction::Create => format!("Rama {} creada; ahora estás en ella.", name.trim()),
            BranchAction::Switch => format!("Ahora estás en {}.", name.trim()),
            BranchAction::Delete => format!("Rama {} borrada.", name.trim()),
        }),
        Err(error) => failed(error),
    }
}

fn failed(message: impl Into<String>) -> GhResult {
    GhResult {
        ok: false,
        message: message.into(),
        ..GhResult::default()
    }
}

fn done(message: impl Into<String>) -> GhResult {
    GhResult {
        ok: true,
        message: message.into(),
        ..GhResult::default()
    }
}

/// La copia local de un repositorio de la cuenta, si está clonada.
pub fn local_clone(full_name: &str) -> Result<PathBuf, String> {
    let repository = gh_cli::own(full_name)
        .ok_or_else(|| "El repositorio no está en el listado de tu cuenta.".to_string())?
        .repository;
    let state = crate::projects::github::local_repository_state(
        &crate::projects::github::projects_folder(),
        &repository,
    )
    .ok_or_else(|| "No se pudo resolver su carpeta.".to_string())?;
    if !state.repository_exists {
        return Err("Todavía no está clonado: pulsa «Clonar» primero.".into());
    }
    Ok(PathBuf::from(state.local_path))
}

#[tauri::command]
pub async fn git_local_status(full_name: String) -> Result<LocalGitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_at(&local_clone(&full_name)?))
        .await
        .unwrap_or_else(|_| Err("git no terminó.".to_string()))
}

#[tauri::command]
pub async fn git_local_commit(full_name: String, message: String) -> GhResult {
    tauri::async_runtime::spawn_blocking(move || match local_clone(&full_name) {
        Ok(path) => commit_at(&path, &message),
        Err(error) => failed(error),
    })
    .await
    .unwrap_or_else(|_| failed("git no terminó."))
}

#[tauri::command]
pub async fn git_local_branch(full_name: String, action: String, name: String) -> GhResult {
    let Some(action) = BranchAction::parse(&action) else {
        return failed("Acción de rama desconocida.");
    };
    tauri::async_runtime::spawn_blocking(move || match local_clone(&full_name) {
        Ok(path) => branch_at(&path, action, &name),
        Err(error) => failed(error),
    })
    .await
    .unwrap_or_else(|_| failed("git no terminó."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_estado_de_git_se_lee_con_rama_seguimiento_y_archivos() {
        let status = parse_status(
            "## main...origin/main [ahead 2, behind 1]\n M src/main.rs\n?? nuevo.txt\nA  \"con espacio.txt\"\n",
        );
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(
            status.files,
            vec![
                ChangedFile {
                    code: " M".into(),
                    path: "src/main.rs".into()
                },
                ChangedFile {
                    code: "??".into(),
                    path: "nuevo.txt".into()
                },
                ChangedFile {
                    code: "A ".into(),
                    path: "con espacio.txt".into()
                },
            ]
        );
        let fresh = parse_status("## No commits yet on main\n");
        assert_eq!(fresh.branch, "main");
        assert_eq!(fresh.upstream, None);
        let only_behind = parse_status("## dev...origin/dev [behind 3]\n");
        assert_eq!((only_behind.ahead, only_behind.behind), (0, 3));
    }

    #[test]
    fn las_ramas_se_crean_cambian_y_borran_con_argumentos_fijos() {
        assert_eq!(
            branch_args(BranchAction::Create, "feature/x").unwrap(),
            vec!["switch", "-c", "feature/x"]
        );
        assert_eq!(
            branch_args(BranchAction::Switch, "main").unwrap(),
            vec!["switch", "main"]
        );
        assert_eq!(
            branch_args(BranchAction::Delete, "vieja").unwrap(),
            vec!["branch", "-d", "vieja"]
        );
        assert!(branch_args(BranchAction::Delete, "-D").is_err());
        assert_eq!(BranchAction::parse("force-delete"), None);
        assert!(commit_message(" \u{0007} ").is_err());
        assert_eq!(
            commit_message("Arreglo\r\n\ndetalle").unwrap(),
            "Arreglo\n\ndetalle"
        );
    }

    #[test]
    fn solo_las_copias_de_repositorios_de_la_cuenta() {
        assert!(local_clone("ajeno/repo").is_err());
    }

    /// Con git de verdad en una carpeta temporal: commit, estado y ramas.
    #[test]
    fn commit_y_ramas_en_una_copia_real() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let setup = |args: &[&str]| git(path, &strings(args));
        if setup(&["init", "--initial-branch=main"]).is_err() {
            eprintln!("git no está disponible: se omite la prueba con una copia real");
            return;
        }
        setup(&["config", "user.name", "WTerminal"]).unwrap();
        setup(&["config", "user.email", "wterminal@example.com"]).unwrap();
        setup(&["config", "commit.gpgsign", "false"]).unwrap();
        std::fs::write(path.join("a.txt"), "hola").unwrap();
        let status = status_at(path).unwrap();
        assert_eq!(
            status.files,
            vec![ChangedFile {
                code: "??".into(),
                path: "a.txt".into()
            }]
        );
        assert!(!commit_at(path, "  ").ok, "sin mensaje no hay commit");
        let first = commit_at(path, "Primer commit");
        assert!(first.ok, "{}", first.message);
        let clean = status_at(path).unwrap();
        assert!(clean.files.is_empty());
        assert_eq!(clean.branch, "main");
        assert_eq!(clean.branches, vec!["main"]);
        assert!(!commit_at(path, "Otra vez").ok, "sin cambios no hay commit");
        assert!(branch_at(path, BranchAction::Create, "feature/x").ok);
        assert_eq!(status_at(path).unwrap().branch, "feature/x");
        assert!(branch_at(path, BranchAction::Switch, "main").ok);
        assert!(branch_at(path, BranchAction::Delete, "feature/x").ok);
        assert_eq!(status_at(path).unwrap().branches, vec!["main"]);
    }
}
