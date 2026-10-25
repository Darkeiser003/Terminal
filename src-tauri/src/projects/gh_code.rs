//! «Mi GitHub» → Código (fase 1 del punto 3 del plan de mejoras): explorar
//! archivos y carpetas por rama, ver un archivo, el historial de commits con
//! sus cambios, y listar, crear y borrar ramas y etiquetas.
//!
//! Mismas reglas que `gh_manage`: solo repositorios del listado de la propia
//! cuenta, `gh api` con método y ruta fijos (nunca una ruta que llegue del
//! panel tal cual) y parámetros validados. Lo que devuelve GitHub se sanea y
//! se recorta antes de llegar al panel.

use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;

use crate::projects::gh_cli::{self, GhResult};
use crate::projects::gh_manage::{clean_line, valid_ref_name};

const QUICK: Duration = Duration::from_secs(45);
const MAX_ENTRIES: usize = 1000;
const MAX_COMMITS: &str = "30";
/// Lo que se enseña de un archivo; GitHub entrega hasta 1 MB por la API.
const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_PATCH_CHARS: usize = 20_000;
const MAX_PATH_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhBranch {
    pub name: String,
    pub sha: String,
    pub protected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhTag {
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhChangedFile {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    /// El diff unificado, recortado; `None` en binarios o diffs enormes.
    pub patch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhEntry {
    pub name: String,
    pub path: String,
    /// `file`, `dir`, `symlink` o `submodule`.
    pub kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum GhContents {
    Dir {
        entries: Vec<GhEntry>,
    },
    File {
        path: String,
        size: u64,
        /// Texto UTF-8 del archivo; `None` si es binario.
        text: Option<String>,
        truncated: bool,
    },
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

fn own_full_name(full_name: &str) -> Result<String, String> {
    gh_cli::own(full_name)
        .map(|repository| repository.repository.full_name)
        .ok_or_else(|| "El repositorio no está en el listado de tu cuenta.".to_string())
}

fn str_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Una ruta dentro del repositorio: segmentos sin `..` ni vacíos, caracteres
/// prudentes y cada segmento codificado para la URL de la API.
pub fn encode_repo_path(path: &str) -> Option<String> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Some(String::new());
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return None;
    }
    let mut encoded = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        if segment
            .chars()
            .any(|c| c.is_control() || "\\?#%\"<>|*:".contains(c))
        {
            return None;
        }
        let mut piece = String::new();
        for byte in segment.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    piece.push(byte as char)
                }
                _ => piece.push_str(&format!("%{byte:02X}")),
            }
        }
        encoded.push(piece);
    }
    Some(encoded.join("/"))
}

fn valid_sha(sha: &str) -> bool {
    (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

fn api_get(path: &str) -> Result<Value, String> {
    let output = gh_cli::run_args(&["api".to_string(), path.to_string()], QUICK)?;
    serde_json::from_str(&output)
        .map_err(|_| "GitHub devolvió una respuesta que no se entiende.".to_string())
}

pub fn parse_branches(value: &Value) -> Vec<GhBranch> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let name = str_of(item, "name");
                    valid_ref_name(&name).then(|| GhBranch {
                        sha: item
                            .pointer("/commit/sha")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        protected: item
                            .get("protected")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_tags(value: &Value) -> Vec<GhTag> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let name = str_of(item, "name");
                    valid_ref_name(&name).then(|| GhTag {
                        sha: item
                            .pointer("/commit/sha")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_commits(value: &Value) -> Vec<GhCommit> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .map(|item| GhCommit {
                    sha: str_of(item, "sha"),
                    message: clean_line(
                        item.pointer("/commit/message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .lines()
                            .next()
                            .unwrap_or_default(),
                        200,
                    ),
                    author: clean_line(
                        item.pointer("/commit/author/name")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        80,
                    ),
                    date: item
                        .pointer("/commit/author/date")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    url: str_of(item, "html_url"),
                })
                .filter(|commit| {
                    valid_sha(&commit.sha) && commit.url.starts_with("https://github.com/")
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_changed_files(value: &Value) -> Vec<GhChangedFile> {
    value
        .get("files")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(300)
                .map(|item| GhChangedFile {
                    filename: clean_line(&str_of(item, "filename"), MAX_PATH_CHARS),
                    status: clean_line(&str_of(item, "status"), 20),
                    additions: item.get("additions").and_then(Value::as_u64).unwrap_or(0),
                    deletions: item.get("deletions").and_then(Value::as_u64).unwrap_or(0),
                    patch: item
                        .get("patch")
                        .and_then(Value::as_str)
                        .map(|patch| patch.chars().take(MAX_PATCH_CHARS).collect()),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_contents(value: &Value) -> Option<GhContents> {
    if let Some(list) = value.as_array() {
        let mut entries: Vec<GhEntry> = list
            .iter()
            .take(MAX_ENTRIES)
            .map(|item| GhEntry {
                name: clean_line(&str_of(item, "name"), 255),
                path: clean_line(&str_of(item, "path"), MAX_PATH_CHARS),
                kind: match item.get("type").and_then(Value::as_str) {
                    Some("dir") => "dir",
                    Some("symlink") => "symlink",
                    Some("submodule") => "submodule",
                    _ => "file",
                }
                .to_string(),
                size: item.get("size").and_then(Value::as_u64).unwrap_or(0),
            })
            .filter(|entry| encode_repo_path(&entry.path).is_some())
            .collect();
        // Carpetas primero, como en github.com.
        entries.sort_by(|a, b| {
            (a.kind != "dir")
                .cmp(&(b.kind != "dir"))
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        return Some(GhContents::Dir { entries });
    }
    let size = value.get("size").and_then(Value::as_u64).unwrap_or(0);
    let path = clean_line(&str_of(value, "path"), MAX_PATH_CHARS);
    let encoded: String = str_of(value, "content").split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let truncated = bytes.len() > MAX_FILE_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_FILE_BYTES)];
    // Un NUL en el primer bloque es la señal habitual de un binario.
    let binary = slice.iter().take(8000).any(|byte| *byte == 0);
    let text = if binary {
        None
    } else {
        Some(String::from_utf8_lossy(slice).into_owned())
    };
    Some(GhContents::File {
        path,
        size,
        text,
        truncated,
    })
}

pub fn branches(full_name: &str) -> Result<Vec<GhBranch>, String> {
    let name = own_full_name(full_name)?;
    api_get(&format!("repos/{name}/branches?per_page=100")).map(|value| parse_branches(&value))
}

pub fn tags(full_name: &str) -> Result<Vec<GhTag>, String> {
    let name = own_full_name(full_name)?;
    api_get(&format!("repos/{name}/tags?per_page=100")).map(|value| parse_tags(&value))
}

pub fn commits(full_name: &str, reference: &str) -> Result<Vec<GhCommit>, String> {
    let name = own_full_name(full_name)?;
    if !reference.is_empty() && !valid_ref_name(reference) {
        return Err("Rama o etiqueta no válida.".into());
    }
    let suffix = if reference.is_empty() {
        String::new()
    } else {
        format!("&sha={reference}")
    };
    api_get(&format!(
        "repos/{name}/commits?per_page={MAX_COMMITS}{suffix}"
    ))
    .map(|value| parse_commits(&value))
}

pub fn commit_files(full_name: &str, sha: &str) -> Result<Vec<GhChangedFile>, String> {
    let name = own_full_name(full_name)?;
    if !valid_sha(sha) {
        return Err("Commit no válido.".into());
    }
    api_get(&format!("repos/{name}/commits/{sha}")).map(|value| parse_changed_files(&value))
}

pub fn compare(full_name: &str, base: &str, head: &str) -> Result<Vec<GhChangedFile>, String> {
    let name = own_full_name(full_name)?;
    if !valid_ref_name(base) || !valid_ref_name(head) {
        return Err("Rama o etiqueta no válida.".into());
    }
    api_get(&format!("repos/{name}/compare/{base}...{head}"))
        .map(|value| parse_changed_files(&value))
}

pub fn contents(full_name: &str, path: &str, reference: &str) -> Result<GhContents, String> {
    let name = own_full_name(full_name)?;
    let encoded = encode_repo_path(path).ok_or_else(|| "Ruta no válida.".to_string())?;
    if !reference.is_empty() && !valid_ref_name(reference) {
        return Err("Rama o etiqueta no válida.".into());
    }
    let query = if reference.is_empty() {
        String::new()
    } else {
        format!("?ref={reference}")
    };
    let value = api_get(&format!("repos/{name}/contents/{encoded}{query}"))?;
    parse_contents(&value)
        .ok_or_else(|| "GitHub devolvió un contenido que no se entiende.".to_string())
}

/// Crea una rama a partir de otra rama o etiqueta.
pub fn branch_create(full_name: &str, branch: &str, from: &str) -> GhResult {
    let name = match own_full_name(full_name) {
        Ok(name) => name,
        Err(error) => return failed(error),
    };
    if !valid_ref_name(branch) || !valid_ref_name(from) {
        return failed("Nombre de rama no válido.");
    }
    let sha = match api_get(&format!("repos/{name}/commits/{from}")) {
        Ok(value) => str_of(&value, "sha"),
        Err(error) => return failed(error),
    };
    if !valid_sha(&sha) {
        return failed("No se encontró el commit de origen.");
    }
    let args: Vec<String> = [
        "api",
        "-X",
        "POST",
        &format!("repos/{name}/git/refs"),
        "-f",
        &format!("ref=refs/heads/{branch}"),
        "-f",
        &format!("sha={sha}"),
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    match gh_cli::run_args(&args, QUICK) {
        Ok(_) => done(format!("Rama {branch} creada desde {from}.")),
        Err(error) => failed(error),
    }
}

/// Borra una rama remota. Nunca la rama por defecto.
pub fn branch_delete(full_name: &str, branch: &str, confirm: &str) -> GhResult {
    let name = match own_full_name(full_name) {
        Ok(name) => name,
        Err(error) => return failed(error),
    };
    if !valid_ref_name(branch) || confirm != branch {
        return failed("Escribe el nombre exacto de la rama para borrarla.");
    }
    if let Ok(value) = api_get(&format!("repos/{name}")) {
        if str_of(&value, "default_branch") == branch {
            return failed("No se puede borrar la rama por defecto.");
        }
    }
    let args = vec![
        "api".to_string(),
        "-X".to_string(),
        "DELETE".to_string(),
        format!("repos/{name}/git/refs/heads/{branch}"),
    ];
    match gh_cli::run_args(&args, QUICK) {
        Ok(_) => done(format!("Rama {branch} borrada.")),
        Err(error) => failed(error),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, fallback: T) -> T {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(fallback)
}

fn lost() -> String {
    "GitHub CLI no terminó.".to_string()
}

#[tauri::command]
pub async fn github_code_branches(full_name: String) -> Result<Vec<GhBranch>, String> {
    blocking(move || branches(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_code_tags(full_name: String) -> Result<Vec<GhTag>, String> {
    blocking(move || tags(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_code_commits(
    full_name: String,
    reference: String,
) -> Result<Vec<GhCommit>, String> {
    blocking(move || commits(&full_name, &reference), Err(lost())).await
}

#[tauri::command]
pub async fn github_code_commit_files(
    full_name: String,
    sha: String,
) -> Result<Vec<GhChangedFile>, String> {
    blocking(move || commit_files(&full_name, &sha), Err(lost())).await
}

#[tauri::command]
pub async fn github_code_compare(
    full_name: String,
    base: String,
    head: String,
) -> Result<Vec<GhChangedFile>, String> {
    blocking(move || compare(&full_name, &base, &head), Err(lost())).await
}

#[tauri::command]
pub async fn github_code_contents(
    full_name: String,
    path: String,
    reference: String,
) -> Result<GhContents, String> {
    blocking(move || contents(&full_name, &path, &reference), Err(lost())).await
}

#[tauri::command]
pub async fn github_code_branch_create(
    full_name: String,
    branch: String,
    from: String,
) -> GhResult {
    blocking(
        move || branch_create(&full_name, &branch, &from),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_code_branch_delete(
    full_name: String,
    branch: String,
    confirm: String,
) -> GhResult {
    blocking(
        move || branch_delete(&full_name, &branch, &confirm),
        failed(lost()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn las_rutas_del_repositorio_se_codifican_y_rechazan_saltos() {
        assert_eq!(encode_repo_path("").as_deref(), Some(""));
        assert_eq!(encode_repo_path("/src/lib/").as_deref(), Some("src/lib"));
        assert_eq!(
            encode_repo_path("notas/Guía rápida.md").as_deref(),
            Some("notas/Gu%C3%ADa%20r%C3%A1pida.md")
        );
        for bad in ["../etc", "src/../x", "a//b", "a?b", "a#b", "C:\\x", "a%2e"] {
            assert!(encode_repo_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn el_panel_recibe_el_tipo_de_contenido_en_minusculas() {
        // `GithubRepoManager.svelte` compara `type === 'dir'`: el contrato es
        // la forma serializada, no el nombre de la variante.
        let dir = serde_json::to_value(GhContents::Dir {
            entries: Vec::new(),
        })
        .unwrap();
        assert_eq!(dir["type"], "dir");
        let file = serde_json::to_value(GhContents::File {
            path: "a".into(),
            size: 0,
            text: None,
            truncated: false,
        })
        .unwrap();
        assert_eq!(file["type"], "file");
    }

    #[test]
    fn el_contenido_distingue_carpetas_texto_y_binarios() {
        let dir = parse_contents(&json!([
            { "name": "b.txt", "path": "b.txt", "type": "file", "size": 3 },
            { "name": "src", "path": "src", "type": "dir", "size": 0 }
        ]))
        .unwrap();
        match dir {
            GhContents::Dir { entries } => assert_eq!(entries[0].name, "src"),
            _ => panic!("esperaba una carpeta"),
        }
        let text = parse_contents(&json!({ "path": "a.txt", "size": 5, "content": "aG9sYQo=\n" }))
            .unwrap();
        assert_eq!(
            text,
            GhContents::File {
                path: "a.txt".into(),
                size: 5,
                text: Some("hola\n".into()),
                truncated: false
            }
        );
        let binary =
            parse_contents(&json!({ "path": "a.bin", "size": 3, "content": "AAEC" })).unwrap();
        assert!(matches!(binary, GhContents::File { text: None, .. }));
    }

    #[test]
    fn los_commits_sin_sha_o_url_de_github_se_descartan() {
        let commits = parse_commits(&json!([
            { "sha": "0123456789abcdef0123456789abcdef01234567", "html_url": "https://github.com/o/r/commit/0123", // link-check: ignore
              "commit": { "message": "Primera línea\n\ncuerpo", "author": { "name": "Ana", "date": "2026-10-22T10:00:00Z" } } },
            { "sha": "zz", "html_url": "https://github.com/o/r/commit/zz", "commit": {} }, // link-check: ignore
            { "sha": "0123456789abcdef0123456789abcdef01234567", "html_url": "https://evil.example/x", "commit": {} }
        ]));
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].message, "Primera línea");
    }
}
