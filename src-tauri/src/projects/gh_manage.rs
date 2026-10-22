//! «Mi GitHub» ampliado: gestionar un repositorio de la cuenta con GitHub CLI.
//!
//! Detalles (descripción, web, temas, rama por defecto, issues y wiki),
//! releases (crear con notas y adjuntos, subir más adjuntos, publicar un
//! borrador, borrar), pull requests (crear y fusionar), issues (crear y
//! cerrar) y Actions (ver y relanzar lo que falló).
//!
//! Las mismas reglas que `gh_cli`: órdenes `gh` con argumentos fijos y
//! validados, sin shell de por medio, y solo sobre repositorios que han salido
//! del listado de la propia cuenta en esta sesión. Lo que se lee de `gh` se
//! sanea antes de llegar al panel.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::projects::gh_cli::{self, GhResult};

/// Consultas y cambios pequeños.
const QUICK: Duration = Duration::from_secs(45);
/// Crear una release con adjuntos o subirlos: depende del tamaño y la red.
const UPLOAD: Duration = Duration::from_secs(30 * 60);
const LIST_LIMIT: &str = "30";
const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_CHARS: usize = 20_000;
const MAX_DESCRIPTION_CHARS: usize = 350;
const MAX_TOPICS: usize = 20;
const MAX_FILES: usize = 50;

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

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

// ---- Validación ----

/// Nombre de rama o etiqueta: un subconjunto prudente de lo que acepta git
/// (`check-ref-format`). Nunca empieza por guion: `gh` y `git` lo tomarían
/// por una opción.
pub fn valid_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._/-+".contains(character))
}

/// Una línea de texto (título, descripción): sin caracteres de control,
/// recortada.
pub fn clean_line(text: &str, max: usize) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Un texto largo (notas, cuerpo): conserva saltos de línea y tabuladores.
pub fn clean_body(text: &str, max: usize) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Tema de GitHub: minúsculas, números y guiones, hasta 50.
pub fn valid_topic(topic: &str) -> bool {
    !topic.is_empty()
        && topic.len() <= 50
        && !topic.starts_with('-')
        && topic.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

/// Web del repositorio: vacía (se borra) o una URL http(s) sin espacios.
pub fn valid_homepage(url: &str) -> bool {
    url.is_empty()
        || ((url.starts_with("https://") || url.starts_with("http://"))
            && url.len() <= 200
            && !url
                .chars()
                .any(|character| character.is_whitespace() || character.is_control()))
}

/// Temas a añadir y a quitar para pasar de `current` a `desired`.
pub fn topic_changes(current: &[String], desired: &[String]) -> (Vec<String>, Vec<String>) {
    let current: BTreeSet<&str> = current.iter().map(String::as_str).collect();
    let desired: BTreeSet<&str> = desired.iter().map(String::as_str).collect();
    (
        desired
            .difference(&current)
            .map(|topic| (*topic).to_string())
            .collect(),
        current
            .difference(&desired)
            .map(|topic| (*topic).to_string())
            .collect(),
    )
}

/// Archivos para adjuntar: rutas absolutas a archivos que existen, sin `#`
/// (`gh` lo leería como «archivo#etiqueta»), sin repetir y como mucho 50.
pub fn valid_files(files: &[String]) -> Result<Vec<String>, String> {
    let mut seen = BTreeSet::new();
    let mut valid = Vec::new();
    for file in files {
        let file = file.trim();
        if file.is_empty() {
            continue;
        }
        let path = Path::new(file);
        if !path.is_absolute() || file.contains('#') || file.starts_with('-') {
            return Err(format!("Ruta de adjunto no válida: {file}"));
        }
        if !path.is_file() {
            return Err(format!("No existe el archivo: {file}"));
        }
        if seen.insert(file.to_lowercase()) {
            valid.push(file.to_string());
        }
    }
    if valid.len() > MAX_FILES {
        return Err(format!("Como mucho {MAX_FILES} adjuntos a la vez."));
    }
    Ok(valid)
}

/// Nombre de un adjunto ya subido.
pub fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('-')
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

// ---- Detalles del repositorio ----

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetails {
    pub description: String,
    pub homepage: String,
    pub topics: Vec<String>,
    pub default_branch: String,
    pub issues: bool,
    pub wiki: bool,
}

const DETAILS_FIELDS: &str =
    "description,homepageUrl,repositoryTopics,defaultBranchRef,hasIssuesEnabled,hasWikiEnabled";

pub fn parse_details(json: &str) -> Option<RepoDetails> {
    let raw: Value = serde_json::from_str(json).ok()?;
    let text = |key: &str| raw.get(key).and_then(Value::as_str).unwrap_or_default();
    Some(RepoDetails {
        description: clean_line(text("description"), MAX_DESCRIPTION_CHARS),
        homepage: Some(text("homepageUrl"))
            .filter(|url| valid_homepage(url))
            .unwrap_or_default()
            .to_string(),
        topics: raw
            .get("repositoryTopics")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|topic| {
                        topic
                            .get("name")
                            .and_then(Value::as_str)
                            .or_else(|| topic.as_str())
                    })
                    .filter(|topic| valid_topic(topic))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        default_branch: raw
            .get("defaultBranchRef")
            .and_then(|branch| branch.get("name"))
            .and_then(Value::as_str)
            .filter(|name| valid_ref_name(name))
            .unwrap_or_default()
            .to_string(),
        issues: raw
            .get("hasIssuesEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        wiki: raw
            .get("hasWikiEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    })
}

/// Lo que se puede cambiar de un repositorio. `current_topics` son los que
/// tenía al abrir el formulario: de ahí salen los que se añaden y se quitan.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoEdit {
    pub description: String,
    pub homepage: String,
    pub topics: Vec<String>,
    pub current_topics: Vec<String>,
    pub default_branch: String,
    pub issues: bool,
    pub wiki: bool,
}

pub fn edit_args(full_name: &str, edit: &RepoEdit) -> Result<Vec<String>, String> {
    let homepage = edit.homepage.trim();
    if !valid_homepage(homepage) {
        return Err("La web tiene que empezar por https:// o http://.".into());
    }
    let mut desired: Vec<String> = edit
        .topics
        .iter()
        .map(|topic| topic.trim().to_lowercase())
        .filter(|topic| !topic.is_empty())
        .collect();
    desired.sort();
    desired.dedup();
    if let Some(bad) = desired.iter().find(|topic| !valid_topic(topic)) {
        return Err(format!(
            "Tema no válido: {bad} (minúsculas, números y guiones, hasta 50)."
        ));
    }
    if desired.len() > MAX_TOPICS {
        return Err(format!("Como mucho {MAX_TOPICS} temas."));
    }
    let branch = edit.default_branch.trim();
    if !branch.is_empty() && !valid_ref_name(branch) {
        return Err(format!("Rama no válida: {branch}"));
    }
    let mut args = strings(&["repo", "edit", full_name]);
    args.push("--description".into());
    args.push(clean_line(&edit.description, MAX_DESCRIPTION_CHARS));
    args.push("--homepage".into());
    args.push(homepage.to_string());
    if !branch.is_empty() {
        args.push("--default-branch".into());
        args.push(branch.to_string());
    }
    args.push(format!("--enable-issues={}", edit.issues));
    args.push(format!("--enable-wiki={}", edit.wiki));
    let (add, remove) = topic_changes(&edit.current_topics, &desired);
    if !add.is_empty() {
        args.push("--add-topic".into());
        args.push(add.join(","));
    }
    if !remove.is_empty() {
        args.push("--remove-topic".into());
        args.push(remove.join(","));
    }
    Ok(args)
}

// ---- Releases ----

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRelease {
    pub tag: String,
    pub name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub latest: bool,
    pub published_at: String,
}

pub fn parse_releases(json: &str) -> Vec<GhRelease> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|raw| {
            let tag = raw.get("tagName")?.as_str()?;
            if !valid_ref_name(tag) {
                return None;
            }
            let flag = |key: &str| raw.get(key).and_then(Value::as_bool).unwrap_or(false);
            let name = clean_line(
                raw.get("name").and_then(Value::as_str).unwrap_or(tag),
                MAX_TITLE_CHARS,
            );
            Some(GhRelease {
                tag: tag.to_string(),
                name: if name.is_empty() {
                    tag.to_string()
                } else {
                    name
                },
                draft: flag("isDraft"),
                prerelease: flag("isPrerelease"),
                latest: flag("isLatest"),
                published_at: clean_line(
                    raw.get("publishedAt")
                        .or_else(|| raw.get("createdAt"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    40,
                ),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAsset {
    pub name: String,
    pub size: u64,
    pub downloads: u64,
}

pub fn parse_assets(json: &str) -> Vec<GhAsset> {
    let Ok(raw) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    raw.get("assets")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|asset| {
                    let name = asset.get("name")?.as_str()?;
                    valid_asset_name(name).then(|| GhAsset {
                        name: name.to_string(),
                        size: asset.get("size").and_then(Value::as_u64).unwrap_or(0),
                        downloads: asset
                            .get("downloadCount")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Una release nueva. Sin notas ni «notas automáticas» se manda `--notes ""`:
/// sin nada, `gh` intentaría abrir un editor.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReleaseDraft {
    pub tag: String,
    pub title: String,
    pub notes: String,
    pub generate_notes: bool,
    pub draft: bool,
    pub prerelease: bool,
    /// Rama o commit del que sale la etiqueta si aún no existe.
    pub target: String,
    pub files: Vec<String>,
}

pub fn release_create_args(full_name: &str, draft: &ReleaseDraft) -> Result<Vec<String>, String> {
    let tag = draft.tag.trim();
    if !valid_ref_name(tag) {
        return Err("Etiqueta no válida (por ejemplo, v1.2.0).".into());
    }
    let target = draft.target.trim();
    if !target.is_empty() && !valid_ref_name(target) {
        return Err(format!("Rama de destino no válida: {target}"));
    }
    let files = valid_files(&draft.files)?;
    let mut args = strings(&["release", "create", tag]);
    args.extend(files);
    args.push("--repo".into());
    args.push(full_name.to_string());
    let title = clean_line(&draft.title, MAX_TITLE_CHARS);
    if !title.is_empty() {
        args.push("--title".into());
        args.push(title);
    }
    let notes = clean_body(&draft.notes, MAX_BODY_CHARS);
    if draft.generate_notes {
        args.push("--generate-notes".into());
    }
    if !draft.generate_notes || !notes.is_empty() {
        args.push("--notes".into());
        args.push(notes);
    }
    if draft.draft {
        args.push("--draft".into());
    }
    if draft.prerelease {
        args.push("--prerelease".into());
    }
    if !target.is_empty() {
        args.push("--target".into());
        args.push(target.to_string());
    }
    Ok(args)
}

pub fn release_upload_args(
    full_name: &str,
    tag: &str,
    files: &[String],
) -> Result<Vec<String>, String> {
    if !valid_ref_name(tag) {
        return Err("Etiqueta no válida.".into());
    }
    let files = valid_files(files)?;
    if files.is_empty() {
        return Err("Elige al menos un archivo.".into());
    }
    let mut args = strings(&["release", "upload", tag]);
    args.extend(files);
    args.extend(strings(&["--repo", full_name, "--clobber"]));
    Ok(args)
}

pub fn release_publish_args(full_name: &str, tag: &str) -> Result<Vec<String>, String> {
    if !valid_ref_name(tag) {
        return Err("Etiqueta no válida.".into());
    }
    Ok(strings(&[
        "release",
        "edit",
        tag,
        "--repo",
        full_name,
        "--draft=false",
    ]))
}

pub fn release_delete_args(
    full_name: &str,
    tag: &str,
    cleanup_tag: bool,
) -> Result<Vec<String>, String> {
    if !valid_ref_name(tag) {
        return Err("Etiqueta no válida.".into());
    }
    let mut args = strings(&["release", "delete", tag, "--repo", full_name, "--yes"]);
    if cleanup_tag {
        args.push("--cleanup-tag".into());
    }
    Ok(args)
}

pub fn release_delete_asset_args(
    full_name: &str,
    tag: &str,
    asset: &str,
) -> Result<Vec<String>, String> {
    if !valid_ref_name(tag) || !valid_asset_name(asset) {
        return Err("Etiqueta o adjunto no válidos.".into());
    }
    Ok(strings(&[
        "release",
        "delete-asset",
        tag,
        asset,
        "--repo",
        full_name,
        "--yes",
    ]))
}

// ---- Pull requests, issues y Actions ----

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPull {
    pub number: u64,
    pub title: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
    pub url: String,
}

fn github_url(raw: &Value) -> String {
    raw.get("url")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://github.com/") && url.len() <= 300)
        .unwrap_or_default()
        .to_string()
}

pub fn parse_pulls(json: &str) -> Vec<GhPull> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|raw| {
            let number = raw.get("number")?.as_u64().filter(|number| *number > 0)?;
            let branch = |key: &str| {
                raw.get(key)
                    .and_then(Value::as_str)
                    .filter(|name| valid_ref_name(name))
                    .unwrap_or_default()
                    .to_string()
            };
            Some(GhPull {
                number,
                title: clean_line(
                    raw.get("title").and_then(Value::as_str).unwrap_or_default(),
                    MAX_TITLE_CHARS,
                ),
                head: branch("headRefName"),
                base: branch("baseRefName"),
                draft: raw.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
                url: github_url(raw),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

pub fn parse_issues(json: &str) -> Vec<GhIssue> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|raw| {
            let number = raw.get("number")?.as_u64().filter(|number| *number > 0)?;
            Some(GhIssue {
                number,
                title: clean_line(
                    raw.get("title").and_then(Value::as_str).unwrap_or_default(),
                    MAX_TITLE_CHARS,
                ),
                url: github_url(raw),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRun {
    pub id: u64,
    pub title: String,
    pub workflow: String,
    pub branch: String,
    /// `queued`, `in_progress`, `completed`…
    pub status: String,
    /// `success`, `failure`, `cancelled`… (vacío mientras no termina).
    pub conclusion: String,
    pub created_at: String,
    pub url: String,
}

pub fn parse_runs(json: &str) -> Vec<GhRun> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let word = |raw: &Value, key: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() <= 40 && value.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
            })
            .unwrap_or_default()
            .to_string()
    };
    items
        .iter()
        .filter_map(|raw| {
            let id = raw.get("databaseId")?.as_u64().filter(|id| *id > 0)?;
            Some(GhRun {
                id,
                title: clean_line(
                    raw.get("displayTitle")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    MAX_TITLE_CHARS,
                ),
                workflow: clean_line(
                    raw.get("workflowName")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    100,
                ),
                branch: raw
                    .get("headBranch")
                    .and_then(Value::as_str)
                    .filter(|name| valid_ref_name(name))
                    .unwrap_or_default()
                    .to_string(),
                status: word(raw, "status"),
                conclusion: word(raw, "conclusion"),
                created_at: clean_line(
                    raw.get("createdAt")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    40,
                ),
                url: github_url(raw),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub fn parse(value: &str) -> Option<MergeMethod> {
        match value {
            "merge" => Some(MergeMethod::Merge),
            "squash" => Some(MergeMethod::Squash),
            "rebase" => Some(MergeMethod::Rebase),
            _ => None,
        }
    }

    fn flag(self) -> &'static str {
        match self {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

pub fn pull_create_args(
    full_name: &str,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<Vec<String>, String> {
    let (head, base) = (head.trim(), base.trim());
    if !valid_ref_name(head) || !valid_ref_name(base) {
        return Err("Rama de origen o de destino no válida.".into());
    }
    if head == base {
        return Err("La rama de origen y la de destino son la misma.".into());
    }
    let title = clean_line(title, MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err("Escribe un título.".into());
    }
    let mut args = strings(&[
        "pr", "create", "--repo", full_name, "--head", head, "--base", base,
    ]);
    args.extend([
        "--title".to_string(),
        title,
        "--body".to_string(),
        clean_body(body, MAX_BODY_CHARS),
    ]);
    if draft {
        args.push("--draft".into());
    }
    Ok(args)
}

pub fn pull_merge_args(
    full_name: &str,
    number: u64,
    method: MergeMethod,
    delete_branch: bool,
) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("Número de pull request no válido.".into());
    }
    let mut args = strings(&[
        "pr",
        "merge",
        &number.to_string(),
        "--repo",
        full_name,
        method.flag(),
    ]);
    if delete_branch {
        args.push("--delete-branch".into());
    }
    Ok(args)
}

pub fn issue_create_args(full_name: &str, title: &str, body: &str) -> Result<Vec<String>, String> {
    let title = clean_line(title, MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err("Escribe un título.".into());
    }
    let mut args = strings(&["issue", "create", "--repo", full_name, "--title"]);
    args.extend([
        title,
        "--body".to_string(),
        clean_body(body, MAX_BODY_CHARS),
    ]);
    Ok(args)
}

pub fn issue_close_args(full_name: &str, number: u64) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("Número de issue no válido.".into());
    }
    Ok(strings(&[
        "issue",
        "close",
        &number.to_string(),
        "--repo",
        full_name,
    ]))
}

pub fn run_rerun_args(full_name: &str, id: u64) -> Result<Vec<String>, String> {
    if id == 0 {
        return Err("Ejecución no válida.".into());
    }
    Ok(strings(&[
        "run",
        "rerun",
        &id.to_string(),
        "--repo",
        full_name,
        "--failed",
    ]))
}

// ---- Ejecución ----

/// El nombre canónico del repositorio si es de la cuenta; si no, el error que
/// se enseña.
fn own_full_name(full_name: &str) -> Result<String, String> {
    gh_cli::own(full_name)
        .map(|repository| repository.repository.full_name)
        .ok_or_else(|| "El repositorio no está en el listado de tu cuenta.".to_string())
}

fn act(
    full_name: &str,
    build: impl FnOnce(&str) -> Result<Vec<String>, String>,
    timeout: Duration,
    message: impl FnOnce(&str) -> String,
) -> GhResult {
    let full_name = match own_full_name(full_name) {
        Ok(name) => name,
        Err(error) => return failed(error),
    };
    let args = match build(&full_name) {
        Ok(args) => args,
        Err(error) => return failed(error),
    };
    match gh_cli::run_args(&args, timeout) {
        Ok(output) => GhResult {
            url: output
                .lines()
                .map(str::trim)
                .find(|line| line.starts_with("https://github.com/"))
                .map(str::to_string),
            ..done(message(&full_name))
        },
        Err(error) => failed(error),
    }
}

fn query<T>(
    full_name: &str,
    build: impl FnOnce(&str) -> Vec<String>,
    parse: impl FnOnce(&str) -> T,
) -> Result<T, String> {
    let full_name = own_full_name(full_name)?;
    gh_cli::run_args(&build(&full_name), QUICK).map(|json| parse(&json))
}

pub fn details(full_name: &str) -> Result<RepoDetails, String> {
    query(
        full_name,
        |name| strings(&["repo", "view", name, "--json", DETAILS_FIELDS]),
        parse_details,
    )?
    .ok_or_else(|| "GitHub CLI devolvió unos detalles que no se entienden.".to_string())
}

pub fn edit(full_name: &str, change: &RepoEdit) -> GhResult {
    act(
        full_name,
        |name| edit_args(name, change),
        QUICK,
        |name| format!("{name} actualizado."),
    )
}

pub fn releases(full_name: &str) -> Result<Vec<GhRelease>, String> {
    query(
        full_name,
        |name| {
            strings(&[
                "release",
                "list",
                "--repo",
                name,
                "--limit",
                LIST_LIMIT,
                "--json",
                "tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt",
            ])
        },
        parse_releases,
    )
}

pub fn assets(full_name: &str, tag: &str) -> Result<Vec<GhAsset>, String> {
    if !valid_ref_name(tag) {
        return Err("Etiqueta no válida.".into());
    }
    query(
        full_name,
        |name| strings(&["release", "view", tag, "--repo", name, "--json", "assets"]),
        parse_assets,
    )
}

pub fn release_create(full_name: &str, draft: &ReleaseDraft) -> GhResult {
    let tag = draft.tag.trim().to_string();
    act(
        full_name,
        |name| release_create_args(name, draft),
        UPLOAD,
        |name| format!("Release {tag} creada en {name}."),
    )
}

pub fn release_upload(full_name: &str, tag: &str, files: &[String]) -> GhResult {
    act(
        full_name,
        |name| release_upload_args(name, tag, files),
        UPLOAD,
        |_| format!("Adjuntos subidos a {tag}."),
    )
}

pub fn release_publish(full_name: &str, tag: &str) -> GhResult {
    act(
        full_name,
        |name| release_publish_args(name, tag),
        QUICK,
        |_| format!("{tag} publicada."),
    )
}

/// Borrar exige escribir la etiqueta tal cual.
pub fn release_delete(
    full_name: &str,
    tag: &str,
    confirmation: &str,
    cleanup_tag: bool,
) -> GhResult {
    if confirmation.trim() != tag {
        return failed(format!("Para borrarla escribe exactamente {tag}."));
    }
    act(
        full_name,
        |name| release_delete_args(name, tag, cleanup_tag),
        QUICK,
        |_| format!("Release {tag} borrada."),
    )
}

pub fn release_delete_asset(full_name: &str, tag: &str, asset: &str) -> GhResult {
    act(
        full_name,
        |name| release_delete_asset_args(name, tag, asset),
        QUICK,
        |_| format!("{asset} quitado de {tag}."),
    )
}

pub fn pulls(full_name: &str) -> Result<Vec<GhPull>, String> {
    query(
        full_name,
        |name| {
            strings(&[
                "pr",
                "list",
                "--repo",
                name,
                "--state",
                "open",
                "--limit",
                LIST_LIMIT,
                "--json",
                "number,title,headRefName,baseRefName,isDraft,url",
            ])
        },
        parse_pulls,
    )
}

pub fn pull_create(
    full_name: &str,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> GhResult {
    act(
        full_name,
        |name| pull_create_args(name, head, base, title, body, draft),
        QUICK,
        |_| "Pull request creada.".to_string(),
    )
}

pub fn pull_merge(
    full_name: &str,
    number: u64,
    method: MergeMethod,
    delete_branch: bool,
) -> GhResult {
    act(
        full_name,
        |name| pull_merge_args(name, number, method, delete_branch),
        QUICK,
        |_| format!("Pull request #{number} fusionada."),
    )
}

pub fn issues(full_name: &str) -> Result<Vec<GhIssue>, String> {
    query(
        full_name,
        |name| {
            strings(&[
                "issue",
                "list",
                "--repo",
                name,
                "--state",
                "open",
                "--limit",
                LIST_LIMIT,
                "--json",
                "number,title,url",
            ])
        },
        parse_issues,
    )
}

pub fn issue_create(full_name: &str, title: &str, body: &str) -> GhResult {
    act(
        full_name,
        |name| issue_create_args(name, title, body),
        QUICK,
        |_| "Issue creada.".to_string(),
    )
}

pub fn issue_close(full_name: &str, number: u64) -> GhResult {
    act(
        full_name,
        |name| issue_close_args(name, number),
        QUICK,
        |_| format!("Issue #{number} cerrada."),
    )
}

pub fn runs(full_name: &str) -> Result<Vec<GhRun>, String> {
    query(
        full_name,
        |name| {
            strings(&[
                "run",
                "list",
                "--repo",
                name,
                "--limit",
                "10",
                "--json",
                "databaseId,displayTitle,status,conclusion,workflowName,headBranch,createdAt,url",
            ])
        },
        parse_runs,
    )
}

pub fn run_rerun(full_name: &str, id: u64) -> GhResult {
    act(
        full_name,
        |name| run_rerun_args(name, id),
        QUICK,
        |_| "Se relanzan los trabajos que fallaron.".to_string(),
    )
}

// ---- Comandos ----

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, fallback: T) -> T {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(fallback)
}

fn lost() -> String {
    "GitHub CLI no terminó.".to_string()
}

#[tauri::command]
pub async fn github_repo_details(full_name: String) -> Result<RepoDetails, String> {
    blocking(move || details(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_repo_edit(full_name: String, change: RepoEdit) -> GhResult {
    blocking(move || edit(&full_name, &change), failed(lost())).await
}

#[tauri::command]
pub async fn github_releases(full_name: String) -> Result<Vec<GhRelease>, String> {
    blocking(move || releases(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_release_assets(full_name: String, tag: String) -> Result<Vec<GhAsset>, String> {
    blocking(move || assets(&full_name, &tag), Err(lost())).await
}

#[tauri::command]
pub async fn github_release_create(full_name: String, draft: ReleaseDraft) -> GhResult {
    blocking(move || release_create(&full_name, &draft), failed(lost())).await
}

#[tauri::command]
pub async fn github_release_upload(full_name: String, tag: String, files: Vec<String>) -> GhResult {
    blocking(
        move || release_upload(&full_name, &tag, &files),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_release_publish(full_name: String, tag: String) -> GhResult {
    blocking(move || release_publish(&full_name, &tag), failed(lost())).await
}

#[tauri::command]
pub async fn github_release_delete(
    full_name: String,
    tag: String,
    confirmation: String,
    cleanup_tag: bool,
) -> GhResult {
    blocking(
        move || release_delete(&full_name, &tag, &confirmation, cleanup_tag),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_release_delete_asset(
    full_name: String,
    tag: String,
    asset: String,
) -> GhResult {
    blocking(
        move || release_delete_asset(&full_name, &tag, &asset),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_pulls(full_name: String) -> Result<Vec<GhPull>, String> {
    blocking(move || pulls(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_pull_create(
    full_name: String,
    head: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
) -> GhResult {
    blocking(
        move || pull_create(&full_name, &head, &base, &title, &body, draft),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_pull_merge(
    full_name: String,
    number: u64,
    method: String,
    delete_branch: bool,
) -> GhResult {
    let Some(method) = MergeMethod::parse(&method) else {
        return failed("Forma de fusionar desconocida.");
    };
    blocking(
        move || pull_merge(&full_name, number, method, delete_branch),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_issues(full_name: String) -> Result<Vec<GhIssue>, String> {
    blocking(move || issues(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_issue_create(full_name: String, title: String, body: String) -> GhResult {
    blocking(
        move || issue_create(&full_name, &title, &body),
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_issue_close(full_name: String, number: u64) -> GhResult {
    blocking(move || issue_close(&full_name, number), failed(lost())).await
}

#[tauri::command]
pub async fn github_runs(full_name: String) -> Result<Vec<GhRun>, String> {
    blocking(move || runs(&full_name), Err(lost())).await
}

#[tauri::command]
pub async fn github_run_rerun(full_name: String, id: u64) -> GhResult {
    blocking(move || run_rerun(&full_name, id), failed(lost())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_ramas_y_etiquetas_siguen_las_reglas_de_git_y_nunca_empiezan_por_guion() {
        for good in [
            "main",
            "v1.2.0",
            "feature/login",
            "release-2026",
            "v1.0.0+build",
        ] {
            assert!(valid_ref_name(good), "{good}");
        }
        for bad in [
            "", "-rm", "--delete", "a..b", "a//b", "/a", "a/", "a.lock", ".x", "x.", "a b", "a@{b",
            "ñ", "a;b",
        ] {
            assert!(!valid_ref_name(bad), "{bad}");
        }
    }

    #[test]
    fn editar_construye_argumentos_fijos_y_solo_cambia_los_temas_que_cambian() {
        let change = RepoEdit {
            description: "Terminal\u{0007} moderna".into(),
            homepage: "https://example.com/wterminal".into(),
            topics: vec!["Rust".into(), "terminal".into(), "rust".into()],
            current_topics: vec!["terminal".into(), "viejo".into()],
            default_branch: "main".into(),
            issues: true,
            wiki: false,
        };
        assert_eq!(
            edit_args("owner/demo", &change).unwrap(),
            vec![
                "repo",
                "edit",
                "owner/demo",
                "--description",
                "Terminal moderna",
                "--homepage",
                "https://example.com/wterminal",
                "--default-branch",
                "main",
                "--enable-issues=true",
                "--enable-wiki=false",
                "--add-topic",
                "rust",
                "--remove-topic",
                "viejo",
            ]
        );
        for (field, value) in [
            ("homepage", "javascript:alert(1)"),
            ("topic", "Con Espacio"),
            ("branch", "-x"),
        ] {
            let mut bad = change.clone();
            match field {
                "homepage" => bad.homepage = value.into(),
                "topic" => bad.topics = vec![value.into()],
                _ => bad.default_branch = value.into(),
            }
            assert!(edit_args("owner/demo", &bad).is_err(), "{field}");
        }
    }

    #[test]
    fn los_detalles_de_gh_se_leen_saneados() {
        let details = parse_details(
            r#"{"description":"Hola","homepageUrl":"ftp://x","repositoryTopics":[{"name":"rust"},{"name":"Mal Tema"}],"defaultBranchRef":{"name":"main"},"hasIssuesEnabled":false,"hasWikiEnabled":true}"#,
        )
        .unwrap();
        assert_eq!(
            details,
            RepoDetails {
                description: "Hola".into(),
                homepage: String::new(),
                topics: vec!["rust".into()],
                default_branch: "main".into(),
                issues: false,
                wiki: true,
            }
        );
        assert!(parse_details("no es json").is_none());
    }

    #[test]
    fn crear_una_release_pide_notas_y_valida_los_adjuntos() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app.zip");
        std::fs::write(&file, b"zip").unwrap();
        let file = file.to_string_lossy().into_owned();
        let draft = ReleaseDraft {
            tag: "v1.0.0".into(),
            title: "Primera".into(),
            notes: String::new(),
            generate_notes: false,
            draft: true,
            prerelease: false,
            target: "main".into(),
            files: vec![file.clone(), file.clone()],
        };
        assert_eq!(
            release_create_args("owner/demo", &draft).unwrap(),
            vec![
                "release".to_string(),
                "create".into(),
                "v1.0.0".into(),
                file.clone(),
                "--repo".into(),
                "owner/demo".into(),
                "--title".into(),
                "Primera".into(),
                "--notes".into(),
                String::new(),
                "--draft".into(),
                "--target".into(),
                "main".into(),
            ]
        );
        let generated = ReleaseDraft {
            generate_notes: true,
            draft: false,
            target: String::new(),
            files: vec![],
            ..draft.clone()
        };
        let args = release_create_args("owner/demo", &generated).unwrap();
        assert!(
            args.contains(&"--generate-notes".to_string())
                && !args.contains(&"--notes".to_string())
        );
        for bad in [
            ReleaseDraft {
                tag: "-v1".into(),
                ..draft.clone()
            },
            ReleaseDraft {
                files: vec!["relativo.zip".into()],
                ..draft.clone()
            },
            ReleaseDraft {
                files: vec![format!("{file}#etiqueta")],
                ..draft.clone()
            },
            ReleaseDraft {
                files: vec![dir
                    .path()
                    .join("no-existe.zip")
                    .to_string_lossy()
                    .into_owned()],
                ..draft.clone()
            },
        ] {
            assert!(release_create_args("owner/demo", &bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            release_upload_args("owner/demo", "v1.0.0", &[file.clone()]).unwrap(),
            vec![
                "release".to_string(),
                "upload".into(),
                "v1.0.0".into(),
                file,
                "--repo".into(),
                "owner/demo".into(),
                "--clobber".into()
            ]
        );
        assert!(release_upload_args("owner/demo", "v1.0.0", &[]).is_err());
    }

    #[test]
    fn publicar_borrar_y_quitar_adjuntos_llevan_argumentos_fijos() {
        assert_eq!(
            release_publish_args("owner/demo", "v1").unwrap(),
            vec![
                "release",
                "edit",
                "v1",
                "--repo",
                "owner/demo",
                "--draft=false"
            ]
        );
        assert_eq!(
            release_delete_args("owner/demo", "v1", true).unwrap(),
            vec![
                "release",
                "delete",
                "v1",
                "--repo",
                "owner/demo",
                "--yes",
                "--cleanup-tag"
            ]
        );
        assert_eq!(
            release_delete_asset_args("owner/demo", "v1", "app.zip").unwrap(),
            vec![
                "release",
                "delete-asset",
                "v1",
                "app.zip",
                "--repo",
                "owner/demo",
                "--yes"
            ]
        );
        assert!(release_delete_asset_args("owner/demo", "v1", "../x").is_err());
        assert!(release_delete_asset_args("owner/demo", "v1", "-x").is_err());
    }

    #[test]
    fn pull_requests_issues_y_actions_se_construyen_y_se_leen() {
        assert_eq!(
            pull_create_args(
                "owner/demo",
                "feature/x",
                "main",
                "Arreglo",
                "Cuerpo\r\nlínea",
                true
            )
            .unwrap(),
            vec![
                "pr",
                "create",
                "--repo",
                "owner/demo",
                "--head",
                "feature/x",
                "--base",
                "main",
                "--title",
                "Arreglo",
                "--body",
                "Cuerpo\nlínea",
                "--draft"
            ]
        );
        assert!(pull_create_args("owner/demo", "main", "main", "x", "", false).is_err());
        assert!(pull_create_args("owner/demo", "a", "main", "  ", "", false).is_err());
        assert_eq!(
            pull_merge_args("owner/demo", 7, MergeMethod::Squash, true).unwrap(),
            vec![
                "pr",
                "merge",
                "7",
                "--repo",
                "owner/demo",
                "--squash",
                "--delete-branch"
            ]
        );
        assert!(pull_merge_args("owner/demo", 0, MergeMethod::Merge, false).is_err());
        assert_eq!(MergeMethod::parse("borrar-todo"), None);
        assert_eq!(
            issue_create_args("owner/demo", "Fallo", "").unwrap(),
            vec![
                "issue",
                "create",
                "--repo",
                "owner/demo",
                "--title",
                "Fallo",
                "--body",
                ""
            ]
        );
        assert_eq!(
            issue_close_args("owner/demo", 3).unwrap(),
            vec!["issue", "close", "3", "--repo", "owner/demo"]
        );
        assert_eq!(
            run_rerun_args("owner/demo", 99).unwrap(),
            vec!["run", "rerun", "99", "--repo", "owner/demo", "--failed"]
        );
        let pulls = parse_pulls(
            r#"[{"number":4,"title":"Hola","headRefName":"x","baseRefName":"main","isDraft":false,"url":"https://github.com/owner/demo/pull/4"},{"number":0}]"#,
        );
        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].head, "x");
        let runs = parse_runs(
            r#"[{"databaseId":9,"displayTitle":"CI","status":"completed","conclusion":"failure","workflowName":"ci","headBranch":"main","createdAt":"2026-10-21T10:00:00Z","url":"https://evil.example/x"}]"#,
        );
        assert_eq!(runs[0].conclusion, "failure");
        assert!(runs[0].url.is_empty(), "una URL ajena no llega al panel");
        let releases = parse_releases(
            r#"[{"tagName":"v1","name":"","isDraft":true,"isLatest":false},{"tagName":"-mal"}]"#,
        );
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].name, "v1");
        assert!(releases[0].draft);
        let assets = parse_assets(
            r#"{"assets":[{"name":"a.zip","size":3,"downloadCount":1},{"name":"../b"}]}"#,
        );
        assert_eq!(
            assets,
            vec![GhAsset {
                name: "a.zip".into(),
                size: 3,
                downloads: 1
            }]
        );
    }

    #[test]
    fn solo_se_gestionan_repositorios_del_listado_de_la_cuenta() {
        assert!(!edit("ajeno/repo", &RepoEdit::default()).ok);
        assert!(!release_publish("ajeno/repo", "v1").ok);
        assert!(releases("ajeno/repo").is_err());
        assert!(!release_delete("ajeno/repo", "v1", "otra", false).ok);
    }
}
