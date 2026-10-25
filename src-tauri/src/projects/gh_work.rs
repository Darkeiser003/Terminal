//! Â«Mi GitHubÂ» â†’ Gestionarâ€¦, fase 2 del punto 3 del plan de mejoras: el
//! trabajo diario sobre pull requests, issues y Actions sin salir de la app.
//!
//! - Pull requests e issues: ver la descripciÃ³n, las etiquetas y los
//!   comentarios (y, en una PR, los archivos que cambia), comentar, cerrar y
//!   reabrir; en una PR, ademÃ¡s, pasar de borrador a lista y revisarla
//!   (aprobar, pedir cambios o comentar).
//! - Issues: la lista abiertas, cerradas o todas.
//! - Actions: el log de lo que fallÃ³ en una ejecuciÃ³n y cancelarla.
//!
//! Mismas reglas que `gh_manage`: Ã³rdenes `gh` con argumentos fijos y
//! validados, sin shell, solo sobre repositorios del listado de la cuenta, y
//! lo que se lee se sanea y se recorta antes de llegar al panel.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::projects::gh_cli::{self, GhResult};
use crate::projects::gh_manage::{clean_body, clean_line, parse_issues, GhIssue};

const QUICK: Duration = Duration::from_secs(45);
const MAX_COMMENT_CHARS: usize = 20_000;
const MAX_SHOWN_COMMENTS: usize = 100;
const MAX_LOG_CHARS: usize = 60_000;

/// Si el elemento es una issue o una pull request: cambia la orden de `gh`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Issue,
    Pull,
}

impl ItemKind {
    pub fn parse(value: &str) -> Option<ItemKind> {
        match value {
            "issue" => Some(ItemKind::Issue),
            "pr" => Some(ItemKind::Pull),
            _ => None,
        }
    }

    fn command(self) -> &'static str {
        match self {
            ItemKind::Issue => "issue",
            ItemKind::Pull => "pr",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPullFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhItemView {
    pub body: String,
    /// `OPEN`, `CLOSED` o `MERGED`.
    pub state: String,
    pub labels: Vec<String>,
    pub comments: Vec<GhComment>,
    /// Solo en pull requests.
    pub files: Vec<GhPullFile>,
    pub draft: bool,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` o vacÃ­o.
    pub review_decision: String,
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
        .ok_or_else(|| "El repositorio no estÃ¡ en el listado de tu cuenta.".to_string())
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn word(raw: &Value, key: &str, max: usize) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() <= max && value.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
        })
        .unwrap_or_default()
        .to_string()
}

pub fn parse_item_view(json: &str) -> Option<GhItemView> {
    let raw: Value = serde_json::from_str(json).ok()?;
    let labels = raw
        .get("labels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|label| label.get("name").and_then(Value::as_str))
                .map(|name| clean_line(name, 50))
                .filter(|name| !name.is_empty())
                .take(30)
                .collect()
        })
        .unwrap_or_default();
    let comments = raw
        .get("comments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .rev()
                .take(MAX_SHOWN_COMMENTS)
                .rev()
                .map(|comment| GhComment {
                    author: clean_line(
                        comment
                            .pointer("/author/login")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        40,
                    ),
                    body: clean_body(
                        comment
                            .get("body")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        MAX_COMMENT_CHARS,
                    ),
                    created_at: clean_line(
                        comment
                            .get("createdAt")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        30,
                    ),
                })
                .collect()
        })
        .unwrap_or_default();
    let files = raw
        .get("files")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(300)
                .map(|file| GhPullFile {
                    path: clean_line(
                        file.get("path").and_then(Value::as_str).unwrap_or_default(),
                        400,
                    ),
                    additions: file.get("additions").and_then(Value::as_u64).unwrap_or(0),
                    deletions: file.get("deletions").and_then(Value::as_u64).unwrap_or(0),
                })
                .filter(|file| !file.path.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Some(GhItemView {
        body: clean_body(
            raw.get("body").and_then(Value::as_str).unwrap_or_default(),
            MAX_COMMENT_CHARS,
        ),
        state: word(&raw, "state", 20),
        labels,
        comments,
        files,
        draft: raw.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        review_decision: word(&raw, "reviewDecision", 30),
    })
}

pub fn item_view_args(full_name: &str, kind: ItemKind, number: u64) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("NÃºmero no vÃ¡lido.".into());
    }
    let fields = match kind {
        ItemKind::Issue => "body,state,labels,comments",
        ItemKind::Pull => "body,state,labels,comments,files,isDraft,reviewDecision",
    };
    Ok(strings(&[
        kind.command(),
        "view",
        &number.to_string(),
        "--repo",
        full_name,
        "--json",
        fields,
    ]))
}

pub fn comment_args(
    full_name: &str,
    kind: ItemKind,
    number: u64,
    body: &str,
) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("NÃºmero no vÃ¡lido.".into());
    }
    let body = clean_body(body, MAX_COMMENT_CHARS);
    if body.trim().is_empty() {
        return Err("Escribe el comentario.".into());
    }
    let mut args = strings(&[
        kind.command(),
        "comment",
        &number.to_string(),
        "--repo",
        full_name,
        "--body",
    ]);
    args.push(body);
    Ok(args)
}

/// `close` o `reopen`. Cerrar una PR no la fusiona.
pub fn state_args(
    full_name: &str,
    kind: ItemKind,
    number: u64,
    action: &str,
) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("NÃºmero no vÃ¡lido.".into());
    }
    if !matches!(action, "close" | "reopen") {
        return Err("AcciÃ³n no vÃ¡lida.".into());
    }
    Ok(strings(&[
        kind.command(),
        action,
        &number.to_string(),
        "--repo",
        full_name,
    ]))
}

pub fn ready_args(full_name: &str, number: u64) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("NÃºmero no vÃ¡lido.".into());
    }
    Ok(strings(&[
        "pr",
        "ready",
        &number.to_string(),
        "--repo",
        full_name,
    ]))
}

/// RevisiÃ³n de una PR: `approve`, `request-changes` o `comment`. Pedir cambios
/// y comentar necesitan texto; aprobar puede ir sin Ã©l.
pub fn review_args(
    full_name: &str,
    number: u64,
    decision: &str,
    body: &str,
) -> Result<Vec<String>, String> {
    if number == 0 {
        return Err("NÃºmero no vÃ¡lido.".into());
    }
    let flag = match decision {
        "approve" => "--approve",
        "request-changes" => "--request-changes",
        "comment" => "--comment",
        _ => return Err("RevisiÃ³n no vÃ¡lida.".into()),
    };
    let body = clean_body(body, MAX_COMMENT_CHARS);
    if flag != "--approve" && body.trim().is_empty() {
        return Err("Explica en el texto quÃ© hay que cambiar o quÃ© comentas.".into());
    }
    let mut args = strings(&[
        "pr",
        "review",
        &number.to_string(),
        "--repo",
        full_name,
        flag,
    ]);
    if !body.trim().is_empty() {
        args.push("--body".into());
        args.push(body);
    }
    Ok(args)
}

pub fn issues_args(full_name: &str, state: &str) -> Result<Vec<String>, String> {
    if !matches!(state, "open" | "closed" | "all") {
        return Err("Estado no vÃ¡lido.".into());
    }
    Ok(strings(&[
        "issue",
        "list",
        "--repo",
        full_name,
        "--state",
        state,
        "--limit",
        "50",
        "--json",
        "number,title,url",
    ]))
}

pub fn run_log_args(full_name: &str, id: u64) -> Result<Vec<String>, String> {
    if id == 0 {
        return Err("EjecuciÃ³n no vÃ¡lida.".into());
    }
    Ok(strings(&[
        "run",
        "view",
        &id.to_string(),
        "--repo",
        full_name,
        "--log-failed",
    ]))
}

pub fn run_cancel_args(full_name: &str, id: u64) -> Result<Vec<String>, String> {
    if id == 0 {
        return Err("EjecuciÃ³n no vÃ¡lida.".into());
    }
    Ok(strings(&[
        "run",
        "cancel",
        &id.to_string(),
        "--repo",
        full_name,
    ]))
}

/// El log de Actions trae colores ANSI y marcas de tiempo; se quitan los
/// caracteres de control (menos saltos y tabuladores) y se recorta por el
/// final, que es donde suele estar el error.
pub fn clean_log(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let without_ansi = strip_ansi(&cleaned);
    let total = without_ansi.chars().count();
    if total <= MAX_LOG_CHARS {
        return without_ansi;
    }
    let tail: String = without_ansi.chars().skip(total - MAX_LOG_CHARS).collect();
    format!("â€¦ (recortado: se muestran los Ãºltimos {MAX_LOG_CHARS} caracteres)\n{tail}")
}

/// Restos de secuencias `[..m` que quedan al quitar el ESC.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            let lookahead = chars.clone();
            let mut consumed = 0;
            let mut valid = false;
            for next in lookahead {
                consumed += 1;
                if next.is_ascii_digit() || next == ';' {
                    continue;
                }
                valid = next == 'm' && consumed > 1;
                break;
            }
            if valid {
                for _ in 0..consumed {
                    chars.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn act(
    full_name: &str,
    build: impl FnOnce(&str) -> Result<Vec<String>, String>,
    message: &str,
) -> GhResult {
    let full_name = match own_full_name(full_name) {
        Ok(name) => name,
        Err(error) => return failed(error),
    };
    let args = match build(&full_name) {
        Ok(args) => args,
        Err(error) => return failed(error),
    };
    match gh_cli::run_args(&args, QUICK) {
        Ok(_) => done(message),
        Err(error) => failed(error),
    }
}

fn query<T>(
    full_name: &str,
    build: impl FnOnce(&str) -> Result<Vec<String>, String>,
    parse: impl FnOnce(&str) -> T,
) -> Result<T, String> {
    let full_name = own_full_name(full_name)?;
    gh_cli::run_args(&build(&full_name)?, QUICK).map(|output| parse(&output))
}

fn kind_of(kind: &str) -> Result<ItemKind, String> {
    ItemKind::parse(kind).ok_or_else(|| "Tipo no vÃ¡lido.".to_string())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, fallback: T) -> T {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(fallback)
}

fn lost() -> String {
    "GitHub CLI no terminÃ³.".to_string()
}

#[tauri::command]
pub async fn github_item_view(
    full_name: String,
    kind: String,
    number: u64,
) -> Result<GhItemView, String> {
    blocking(
        move || {
            let kind = kind_of(&kind)?;
            query(
                &full_name,
                |name| item_view_args(name, kind, number),
                parse_item_view,
            )?
            .ok_or_else(|| "GitHub CLI devolviÃ³ algo que no se entiende.".to_string())
        },
        Err(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_item_comment(
    full_name: String,
    kind: String,
    number: u64,
    body: String,
) -> GhResult {
    blocking(
        move || match kind_of(&kind) {
            Ok(kind) => act(
                &full_name,
                |name| comment_args(name, kind, number, &body),
                "Comentario publicado.",
            ),
            Err(error) => failed(error),
        },
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_item_state(
    full_name: String,
    kind: String,
    number: u64,
    action: String,
) -> GhResult {
    blocking(
        move || match kind_of(&kind) {
            Ok(kind) => act(
                &full_name,
                |name| state_args(name, kind, number, &action),
                if action == "reopen" {
                    "Reabierta."
                } else {
                    "Cerrada."
                },
            ),
            Err(error) => failed(error),
        },
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_pull_ready(full_name: String, number: u64) -> GhResult {
    blocking(
        move || {
            act(
                &full_name,
                |name| ready_args(name, number),
                "Lista para revisar.",
            )
        },
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_pull_review(
    full_name: String,
    number: u64,
    decision: String,
    body: String,
) -> GhResult {
    blocking(
        move || {
            act(
                &full_name,
                |name| review_args(name, number, &decision, &body),
                "RevisiÃ³n enviada.",
            )
        },
        failed(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_issues_by_state(
    full_name: String,
    state: String,
) -> Result<Vec<GhIssue>, String> {
    blocking(
        move || query(&full_name, |name| issues_args(name, &state), parse_issues),
        Err(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_run_log(full_name: String, id: u64) -> Result<String, String> {
    blocking(
        move || query(&full_name, |name| run_log_args(name, id), clean_log),
        Err(lost()),
    )
    .await
}

#[tauri::command]
pub async fn github_run_cancel(full_name: String, id: u64) -> GhResult {
    blocking(
        move || {
            act(
                &full_name,
                |name| run_cancel_args(name, id),
                "EjecuciÃ³n cancelada.",
            )
        },
        failed(lost()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_ordenes_llevan_argumentos_fijos_y_validados() {
        assert_eq!(
            comment_args("o/r", ItemKind::Pull, 7, "Hola").unwrap(),
            ["pr", "comment", "7", "--repo", "o/r", "--body", "Hola"]
        );
        assert!(comment_args("o/r", ItemKind::Issue, 7, "   ").is_err());
        assert!(comment_args("o/r", ItemKind::Issue, 0, "x").is_err());
        assert_eq!(
            state_args("o/r", ItemKind::Issue, 3, "reopen").unwrap(),
            ["issue", "reopen", "3", "--repo", "o/r"]
        );
        assert!(state_args("o/r", ItemKind::Issue, 3, "delete").is_err());
        assert_eq!(
            review_args("o/r", 7, "approve", "").unwrap(),
            ["pr", "review", "7", "--repo", "o/r", "--approve"]
        );
        assert!(review_args("o/r", 7, "request-changes", "").is_err());
        assert!(review_args("o/r", 7, "merge", "x").is_err());
        assert!(issues_args("o/r", "abiertas").is_err());
        assert_eq!(
            run_cancel_args("o/r", 99).unwrap(),
            ["run", "cancel", "99", "--repo", "o/r"]
        );
        assert_eq!(ItemKind::parse("pr"), Some(ItemKind::Pull));
        assert_eq!(ItemKind::parse("x"), None);
    }

    #[test]
    fn la_vista_sanea_comentarios_etiquetas_y_archivos() {
        let view = parse_item_view(
            r#"{"body":"Texto","state":"OPEN","isDraft":true,"reviewDecision":"REVIEW_REQUIRED",
                "labels":[{"name":"bug"},{"name":""}],
                "comments":[{"author":{"login":"ana"},"body":"Visto","createdAt":"2026-10-22T10:00:00Z"}],
                "files":[{"path":"src/a.rs","additions":3,"deletions":1},{"path":""}]}"#,
        )
        .unwrap();
        assert_eq!(view.state, "OPEN");
        assert_eq!(view.labels, ["bug"]);
        assert_eq!(view.comments[0].author, "ana");
        assert_eq!(view.files.len(), 1);
        assert!(view.draft);
        assert!(parse_item_view("no es json").is_none());
    }

    #[test]
    fn el_log_pierde_colores_y_se_recorta_por_el_final() {
        assert_eq!(
            clean_log("\u{1b}[31mError\u{1b}[0m en paso"),
            "Error en paso"
        );
        let long = "x".repeat(MAX_LOG_CHARS + 10);
        let cleaned = clean_log(&long);
        assert!(cleaned.starts_with("â€¦ (recortado"));
        assert!(cleaned.ends_with('x'));
    }
}
