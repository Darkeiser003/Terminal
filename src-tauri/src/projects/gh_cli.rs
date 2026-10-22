//! «Mi GitHub» en Proyectos: la cuenta y los repositorios del usuario a través
//! de GitHub CLI (`gh`).
//!
//! WTerminal no guarda tokens ni contraseñas: la sesión es la de `gh`
//! (`gh auth login --web` en una terminal visible, con el navegador). Lo demás
//! son órdenes `gh` con argumentos fijos y validados, sin shell de por medio,
//! y solo sobre repositorios que han salido del listado de la propia cuenta en
//! esta sesión: el frontend no puede pedir que se borre un repositorio
//! cualquiera escribiendo su nombre.

use std::collections::HashMap;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::github::{is_github_owner, is_github_repo_name, Repository};

/// Las consultas a la API responden en uno o dos segundos; crear o borrar un
/// repositorio puede tardar algo más.
const GH_TIMEOUT: Duration = Duration::from_secs(45);
const LIST_LIMIT: &str = "300";
const LIST_FIELDS: &str = "name,nameWithOwner,description,visibility,isArchived,isFork,updatedAt,url,stargazerCount,forkCount,primaryLanguage";
const MAX_DESCRIPTION_CHARS: usize = 350;

/// Que `gh` no pregunte, no pinte colores ni avise de versiones nuevas.
const GH_ENVIRONMENT: [(&str, &str); 4] = [
    ("GH_PROMPT_DISABLED", "1"),
    ("NO_COLOR", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GH_SPINNER_DISABLED", "1"),
];

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    pub account: Option<String>,
    /// Un fallo que no es «sin sesión» (red, versión rara de `gh`…).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepository {
    #[serde(flatten)]
    pub repository: Repository,
    pub private: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhResult {
    pub ok: bool,
    pub message: String,
    pub url: Option<String>,
    /// Falta el permiso `delete_repo`: el panel ofrece pedirlo.
    pub needs_delete_scope: bool,
}

impl GhResult {
    fn failed(message: impl Into<String>) -> GhResult {
        GhResult {
            ok: false,
            message: message.into(),
            ..GhResult::default()
        }
    }
}

/// Cambios que se pueden hacer sobre un repositorio de la cuenta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepositoryChange {
    MakePublic,
    MakePrivate,
    Archive,
    Unarchive,
}

impl RepositoryChange {
    pub fn parse(value: &str) -> Option<RepositoryChange> {
        match value {
            "make-public" => Some(RepositoryChange::MakePublic),
            "make-private" => Some(RepositoryChange::MakePrivate),
            "archive" => Some(RepositoryChange::Archive),
            "unarchive" => Some(RepositoryChange::Unarchive),
            _ => None,
        }
    }
}

/// Órdenes que necesitan al usuario delante (navegador, confirmaciones) y se
/// escriben en una terminal visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalAction {
    Login,
    Logout,
    /// Pide el permiso `delete_repo`, que `gh auth login` no concede.
    GrantDelete,
}

impl TerminalAction {
    pub fn parse(value: &str) -> Option<TerminalAction> {
        match value {
            "login" => Some(TerminalAction::Login),
            "logout" => Some(TerminalAction::Logout),
            "grant-delete" => Some(TerminalAction::GrantDelete),
            _ => None,
        }
    }

    /// Argumentos de `gh`, siempre los mismos.
    pub fn args(self) -> &'static [&'static str] {
        match self {
            TerminalAction::Login => &[
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--git-protocol",
                "https",
                "--web",
            ],
            TerminalAction::Logout => &["auth", "logout", "--hostname", "github.com"],
            TerminalAction::GrantDelete => &[
                "auth",
                "refresh",
                "--hostname",
                "github.com",
                "--scopes",
                "delete_repo",
            ],
        }
    }
}

/// Repositorios de la cuenta vistos en el último listado.
static OWN_REPOSITORIES: Lazy<Mutex<HashMap<String, GhRepository>>> = Lazy::new(Default::default);
/// `gh auth setup-git` ya se ejecutó en esta sesión.
static GIT_CONFIGURED: Lazy<Mutex<bool>> = Lazy::new(Default::default);

/// Ruta de `gh`. Antes se resincroniza el PATH con el del sistema: si se
/// acaba de instalar desde Entorno y dependencias, ya aparece.
pub fn gh_path() -> Option<String> {
    if crate::path_env::which("gh").is_none() {
        crate::path_env::refresh_system_path();
    }
    crate::path_env::which("gh").map(|path| path.to_string_lossy().into_owned())
}

/// Las primeras líneas con texto, como mucho 400 caracteres: lo que se
/// enseña de un error de `gh`.
pub fn short_message(text: &str) -> String {
    let joined = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    joined.chars().take(400).collect()
}

fn run(gh: &str, args: &[&str]) -> Result<String, String> {
    run_for(gh, args, GH_TIMEOUT)
}

fn run_for(gh: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let output = crate::process::run_with_timeout_capture(gh, args, timeout, &GH_ENVIRONMENT)
        .ok_or_else(|| "GitHub CLI no respondió a tiempo.".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(short_message(if stderr.is_empty() {
        &stdout
    } else {
        &stderr
    }))
}

/// `gh` sin sesión dice cómo iniciarla; cualquier otro fallo es un error.
pub fn looks_logged_out(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("gh auth login")
        || error.contains("not logged")
        || error.contains("no oauth token")
        || error.contains("http 401")
        || error.contains("bad credentials")
}

/// `login` de `gh api user`.
pub fn parse_login(json: &str) -> Option<String> {
    serde_json::from_str::<Value>(json)
        .ok()?
        .get("login")?
        .as_str()
        .filter(|login| is_github_owner(login))
        .map(str::to_string)
}

fn parse_repository(raw: &Value) -> Option<GhRepository> {
    let full_name = raw.get("nameWithOwner")?.as_str()?;
    let (owner, name) = full_name.split_once('/')?;
    if !is_github_owner(owner) || !is_github_repo_name(name) {
        return None;
    }
    let text = |key: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let url = text("url");
    let html_url = if url.starts_with("https://github.com/") {
        url
    } else {
        format!("https://github.com/{full_name}")
    };
    Some(GhRepository {
        repository: Repository {
            owner: owner.to_string(),
            name: name.to_string(),
            full_name: full_name.to_string(),
            description: text("description"),
            language: raw
                .get("primaryLanguage")
                .and_then(|language| language.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            stars: raw
                .get("stargazerCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            forks: raw.get("forkCount").and_then(Value::as_u64).unwrap_or(0),
            archived: raw
                .get("isArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            fork: raw.get("isFork").and_then(Value::as_bool).unwrap_or(false),
            updated_at: text("updatedAt"),
            clone_url: format!("https://github.com/{full_name}.git"),
            html_url,
        },
        private: !text("visibility").eq_ignore_ascii_case("public"),
    })
}

/// Salida de `gh repo list --json …`. Lo que no tenga un nombre válido se
/// descarta en vez de llegar al panel.
pub fn parse_repositories(json: &str) -> Vec<GhRepository> {
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Array(items)) => items.iter().filter_map(parse_repository).collect(),
        _ => Vec::new(),
    }
}

pub fn status() -> GhStatus {
    let Some(gh) = gh_path() else {
        return GhStatus::default();
    };
    let version = run(&gh, &["--version"])
        .ok()
        .and_then(|text| text.lines().next().map(str::to_string));
    let mut status = GhStatus {
        installed: true,
        path: Some(gh.clone()),
        version,
        ..GhStatus::default()
    };
    match run(&gh, &["api", "user"]) {
        Ok(json) => {
            status.account = parse_login(&json);
            status.logged_in = status.account.is_some();
        }
        Err(error) if looks_logged_out(&error) => {}
        Err(error) => status.error = Some(error),
    }
    // Con sesión, git usa las credenciales de `gh` para clonar y actualizar
    // los repositorios privados (lo mismo que ofrece `gh auth login`).
    if status.logged_in {
        let mut configured = GIT_CONFIGURED.lock();
        if !*configured {
            *configured = run(&gh, &["auth", "setup-git", "--hostname", "github.com"]).is_ok();
        }
    }
    status
}

/// Lista los repositorios de la cuenta y los recuerda como propios.
pub fn repositories() -> Result<Vec<GhRepository>, String> {
    let gh = gh_path().ok_or_else(|| "GitHub CLI no está instalado.".to_string())?;
    let json = run(
        &gh,
        &["repo", "list", "--limit", LIST_LIMIT, "--json", LIST_FIELDS],
    )?;
    let repositories = parse_repositories(&json);
    let mut own = OWN_REPOSITORIES.lock();
    own.clear();
    for repository in &repositories {
        own.insert(
            repository.repository.full_name.to_lowercase(),
            repository.clone(),
        );
    }
    Ok(repositories)
}

fn own_repository(full_name: &str) -> Option<GhRepository> {
    OWN_REPOSITORIES
        .lock()
        .get(&full_name.to_lowercase())
        .cloned()
}

/// El repositorio, si ha salido del listado de la propia cuenta: lo que
/// necesitan `gh_manage` y `git_local` antes de tocar nada.
pub fn own(full_name: &str) -> Option<GhRepository> {
    own_repository(full_name)
}

/// `gh` con argumentos ya validados y un tiempo límite propio (subir los
/// adjuntos de una release puede tardar bastante más que una consulta).
pub fn run_args(args: &[String], timeout: Duration) -> Result<String, String> {
    let gh = gh_path().ok_or_else(|| "GitHub CLI no está instalado.".to_string())?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_for(&gh, &args, timeout)
}

/// Nombre para un repositorio nuevo o renombrado: las reglas de GitHub y,
/// además, ni `.`/`..` ni un guion delante, que `gh` tomaría por una opción.
pub fn valid_new_repo_name(name: &str) -> bool {
    is_github_repo_name(name) && !name.starts_with('-') && name != "." && name != ".."
}

/// Argumentos de `gh repo create`. El nombre sigue las reglas de GitHub y la
/// descripción va sin caracteres de control y recortada.
pub fn create_args(
    name: &str,
    description: &str,
    private: bool,
    readme: bool,
) -> Result<Vec<String>, String> {
    let name = name.trim();
    if !valid_new_repo_name(name) {
        return Err(
            "Nombre no válido: letras, números, guiones, puntos o guion bajo (hasta 100).".into(),
        );
    }
    let description: String = description
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DESCRIPTION_CHARS)
        .collect();
    let mut args = vec![
        "repo".to_string(),
        "create".to_string(),
        name.to_string(),
        if private { "--private" } else { "--public" }.to_string(),
    ];
    if !description.trim().is_empty() {
        args.push("--description".into());
        args.push(description.trim().to_string());
    }
    if readme {
        args.push("--add-readme".into());
    }
    Ok(args)
}

pub fn change_args(full_name: &str, change: RepositoryChange) -> Vec<String> {
    let full_name = full_name.to_string();
    let args: Vec<&str> = match change {
        RepositoryChange::MakePublic => vec![
            "repo",
            "edit",
            &full_name,
            "--visibility",
            "public",
            "--accept-visibility-change-consequences",
        ],
        RepositoryChange::MakePrivate => vec![
            "repo",
            "edit",
            &full_name,
            "--visibility",
            "private",
            "--accept-visibility-change-consequences",
        ],
        RepositoryChange::Archive => vec!["repo", "archive", &full_name, "--yes"],
        RepositoryChange::Unarchive => vec!["repo", "unarchive", &full_name, "--yes"],
    };
    args.into_iter().map(str::to_string).collect()
}

pub fn rename_args(full_name: &str, new_name: &str) -> Result<Vec<String>, String> {
    let new_name = new_name.trim();
    if !valid_new_repo_name(new_name) {
        return Err(
            "Nombre no válido: letras, números, guiones, puntos o guion bajo (hasta 100).".into(),
        );
    }
    Ok(["repo", "rename", new_name, "--repo", full_name, "--yes"]
        .into_iter()
        .map(str::to_string)
        .collect())
}

pub fn delete_args(full_name: &str) -> Vec<String> {
    ["repo", "delete", full_name, "--yes"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn run_owned(args: &[String]) -> Result<String, String> {
    let gh = gh_path().ok_or_else(|| "GitHub CLI no está instalado.".to_string())?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&gh, &args)
}

pub fn create(name: &str, description: &str, private: bool, readme: bool) -> GhResult {
    let args = match create_args(name, description, private, readme) {
        Ok(args) => args,
        Err(error) => return GhResult::failed(error),
    };
    match run_owned(&args) {
        Ok(output) => GhResult {
            ok: true,
            message: format!("Repositorio {} creado.", name.trim()),
            url: output
                .lines()
                .map(str::trim)
                .find(|line| line.starts_with("https://github.com/"))
                .map(str::to_string),
            ..GhResult::default()
        },
        Err(error) => GhResult::failed(error),
    }
}

pub fn change(full_name: &str, change: RepositoryChange) -> GhResult {
    let Some(repository) = own_repository(full_name) else {
        return GhResult::failed("El repositorio no está en el listado de tu cuenta.");
    };
    match run_owned(&change_args(&repository.repository.full_name, change)) {
        Ok(_) => GhResult {
            ok: true,
            message: format!("{} actualizado.", repository.repository.full_name),
            ..GhResult::default()
        },
        Err(error) => GhResult::failed(error),
    }
}

pub fn rename(full_name: &str, new_name: &str) -> GhResult {
    let Some(repository) = own_repository(full_name) else {
        return GhResult::failed("El repositorio no está en el listado de tu cuenta.");
    };
    let args = match rename_args(&repository.repository.full_name, new_name) {
        Ok(args) => args,
        Err(error) => return GhResult::failed(error),
    };
    match run_owned(&args) {
        Ok(_) => GhResult {
            ok: true,
            message: format!(
                "{} ahora se llama {}.",
                repository.repository.full_name,
                new_name.trim()
            ),
            ..GhResult::default()
        },
        Err(error) => GhResult::failed(error),
    }
}

/// Borrar exige escribir el nombre completo (`propietario/nombre`) tal cual.
pub fn delete(full_name: &str, confirmation: &str) -> GhResult {
    let Some(repository) = own_repository(full_name) else {
        return GhResult::failed("El repositorio no está en el listado de tu cuenta.");
    };
    if confirmation.trim() != repository.repository.full_name {
        return GhResult::failed(format!(
            "Para borrarlo escribe exactamente {}.",
            repository.repository.full_name
        ));
    }
    match run_owned(&delete_args(&repository.repository.full_name)) {
        Ok(_) => {
            OWN_REPOSITORIES
                .lock()
                .remove(&repository.repository.full_name.to_lowercase());
            GhResult {
                ok: true,
                message: format!("{} borrado.", repository.repository.full_name),
                ..GhResult::default()
            }
        }
        Err(error) => GhResult {
            needs_delete_scope: error.contains("delete_repo"),
            ..GhResult::failed(error)
        },
    }
}

#[tauri::command]
pub async fn github_cli_status() -> GhStatus {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn github_cli_create(
    name: String,
    description: String,
    private: bool,
    readme: bool,
) -> GhResult {
    tauri::async_runtime::spawn_blocking(move || create(&name, &description, private, readme))
        .await
        .unwrap_or_else(|_| GhResult::failed("No se pudo crear el repositorio."))
}

#[tauri::command]
pub async fn github_cli_change(full_name: String, change: String) -> GhResult {
    let Some(parsed) = RepositoryChange::parse(&change) else {
        return GhResult::failed("Cambio desconocido.");
    };
    tauri::async_runtime::spawn_blocking(move || self::change(&full_name, parsed))
        .await
        .unwrap_or_else(|_| GhResult::failed("No se pudo cambiar el repositorio."))
}

#[tauri::command]
pub async fn github_cli_rename(full_name: String, new_name: String) -> GhResult {
    tauri::async_runtime::spawn_blocking(move || rename(&full_name, &new_name))
        .await
        .unwrap_or_else(|_| GhResult::failed("No se pudo renombrar el repositorio."))
}

#[tauri::command]
pub async fn github_cli_delete(full_name: String, confirmation: String) -> GhResult {
    tauri::async_runtime::spawn_blocking(move || delete(&full_name, &confirmation))
        .await
        .unwrap_or_else(|_| GhResult::failed("No se pudo borrar el repositorio."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_listado_de_gh_se_convierte_en_repositorios_validos() {
        // Cuenta «owner»: verify-links omite github.com/owner como fixture; una
        // cuenta real hacía que comprobara repos inexistentes con git ls-remote.
        let json = r#"[
            {"name":"demo","nameWithOwner":"owner/demo","description":"Prueba","visibility":"PRIVATE","isArchived":false,"isFork":false,"updatedAt":"2026-10-20T10:00:00Z","url":"https://github.com/owner/demo","stargazerCount":3,"forkCount":1,"primaryLanguage":{"name":"Rust"}},
            {"name":"web","nameWithOwner":"owner/web","visibility":"PUBLIC","isArchived":true,"url":"https://evil.example/x","primaryLanguage":null},
            {"name":"mal","nameWithOwner":"owner/../../etc","visibility":"PUBLIC"},
            {"nameWithOwner":"sin-barra"}
        ]"#;
        let repositories = parse_repositories(json);
        assert_eq!(repositories.len(), 2);
        let demo = &repositories[0];
        assert!(demo.private);
        assert_eq!(demo.repository.full_name, "owner/demo");
        assert_eq!(demo.repository.language, "Rust");
        assert_eq!(demo.repository.stars, 3);
        assert_eq!(
            demo.repository.clone_url,
            "https://github.com/owner/demo.git"
        );
        let web = &repositories[1];
        assert!(!web.private && web.repository.archived);
        // Una URL ajena nunca llega al panel: se rehace desde el nombre.
        assert_eq!(web.repository.html_url, "https://github.com/owner/web");
        assert!(parse_repositories("no es json").is_empty());
        assert!(parse_repositories("{}").is_empty());
    }

    #[test]
    fn la_sesion_se_lee_de_gh_api_user_y_sin_sesion_no_es_un_error() {
        assert_eq!(
            parse_login(r#"{"login":"Romen","id":1}"#).as_deref(),
            Some("Romen")
        );
        assert_eq!(parse_login(r#"{"login":"no valido!"}"#), None);
        assert!(looks_logged_out(
            "To get started with GitHub CLI, please run:  gh auth login"
        ));
        assert!(looks_logged_out(
            // link-check: ignore (texto de un error de gh, no un enlace)
            "HTTP 401: Bad credentials (https://api.github.com/user)"
        ));
        assert!(!looks_logged_out(
            "dial tcp: lookup api.github.com: no such host"
        ));
        assert_eq!(
            short_message("\n uno \n\n dos \n tres \n cuatro"),
            "uno dos tres"
        );
    }

    #[test]
    fn las_ordenes_de_gh_llevan_argumentos_fijos_y_validados() {
        assert_eq!(
            create_args("mi-repo", "Una\u{7}descripción", true, true).unwrap(),
            vec![
                "repo",
                "create",
                "mi-repo",
                "--private",
                "--description",
                "Unadescripción",
                "--add-readme"
            ]
        );
        assert_eq!(
            create_args(" otro ", "  ", false, false).unwrap(),
            vec!["repo", "create", "otro", "--public"]
        );
        for bad in [
            "",
            "con espacio",
            "a/b",
            "..",
            "x".repeat(101).as_str(),
            "--delete",
        ] {
            assert!(create_args(bad, "", false, false).is_err(), "{bad}");
            assert!(rename_args("owner/demo", bad).is_err(), "{bad}");
        }
        assert_eq!(
            change_args("owner/demo", RepositoryChange::MakePublic),
            vec![
                "repo",
                "edit",
                "owner/demo",
                "--visibility",
                "public",
                "--accept-visibility-change-consequences"
            ]
        );
        assert_eq!(
            change_args("owner/demo", RepositoryChange::Archive),
            vec!["repo", "archive", "owner/demo", "--yes"]
        );
        assert_eq!(
            rename_args("owner/demo", "nuevo").unwrap(),
            vec!["repo", "rename", "nuevo", "--repo", "owner/demo", "--yes"]
        );
        assert_eq!(
            delete_args("owner/demo"),
            vec!["repo", "delete", "owner/demo", "--yes"]
        );
        assert_eq!(
            RepositoryChange::parse("unarchive"),
            Some(RepositoryChange::Unarchive)
        );
        assert_eq!(RepositoryChange::parse("rm -rf"), None);
        assert_eq!(
            TerminalAction::parse("login").unwrap().args()[..2],
            ["auth", "login"]
        );
        assert!(TerminalAction::Login.args().contains(&"--web"));
        assert_eq!(TerminalAction::parse("borrar-todo"), None);
    }

    #[test]
    fn solo_se_actua_sobre_repositorios_del_listado_y_borrar_pide_el_nombre() {
        OWN_REPOSITORIES.lock().clear();
        assert!(!change("Ajeno/repo", RepositoryChange::Archive).ok);
        assert!(!rename("Ajeno/repo", "x").ok);
        assert!(!delete("Ajeno/repo", "Ajeno/repo").ok);
        let listed = parse_repositories(
            r#"[{"name":"demo","nameWithOwner":"owner/demo","visibility":"PUBLIC"}]"#,
        );
        OWN_REPOSITORIES
            .lock()
            .insert("owner/demo".into(), listed[0].clone());
        let refused = delete("owner/demo", "demo");
        assert!(!refused.ok && refused.message.contains("owner/demo"));
        OWN_REPOSITORIES.lock().clear();
    }
}
