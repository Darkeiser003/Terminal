//! «Mi GitHub» → «Gestionar…»: las áreas que faltaban del diseño del 23-10.
//!
//! - **Actions**: artefactos (descargar y borrar), workflows (lanzar con
//!   entradas, activar o desactivar), secretos (el valor va por la entrada
//!   estándar de `gh secret set`, nunca en los argumentos ni en el registro),
//!   variables y entornos.
//! - **Configuración**: colaboradores, webhooks, claves de despliegue, Pages y
//!   protección de ramas (antes de cambiarla se lee la que hay: el PUT la
//!   sustituye entera y se conserva lo que el panel no gestiona).
//! - **Seguridad**: alertas de Dependabot, de code scanning y de secret
//!   scanning, y activar las alertas de vulnerabilidades.
//! - **Comunidad**: el perfil de comunidad (README, licencia, CONTRIBUTING…).
//! - **Cuenta**: el perfil, y las claves SSH y GPG de la cuenta.
//!
//! Las mismas reglas que `gh_manage`: cada operación se traduce a una orden
//! `gh` con método y ruta fijos y parámetros validados, nunca una ruta libre,
//! y solo sobre repositorios del listado de la propia cuenta. Lo que pide un
//! permiso que `gh auth login` no concede devuelve `needs_admin_scope` y el
//! panel ofrece pedirlo en una pestaña visible (`TerminalAction::GrantAdmin`).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::projects::gh_cli::{self, GhResult};
use crate::projects::gh_manage::{clean_line, valid_ref_name};

const QUICK: Duration = Duration::from_secs(45);
/// Descargar un artefacto: depende de su tamaño y de la red.
const DOWNLOAD: Duration = Duration::from_secs(30 * 60);
const MAX_INPUTS: usize = 20;
const MAX_VALUE_CHARS: usize = 1_000;
const MAX_SECRET_CHARS: usize = 48 * 1024;

/// Una fila de cualquier lista de estas áreas: así el panel las pinta todas
/// igual.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminRow {
    pub id: String,
    pub title: String,
    pub detail: String,
    /// Estado corto (`activo`, `expirado`, `crítica`…), vacío si no hay.
    pub state: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminList {
    pub rows: Vec<AdminRow>,
    /// Lo que se enseña cuando la lista no aplica (Pages sin activar, rama
    /// sin proteger, alertas apagadas).
    pub note: Option<String>,
    pub needs_admin_scope: bool,
}

/// Las listas que se pueden pedir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Area {
    Artifacts,
    Workflows,
    Secrets,
    Variables,
    Environments,
    Collaborators,
    Hooks,
    DeployKeys,
    Pages,
    Protection,
    Dependabot,
    CodeScanning,
    SecretScanning,
    Community,
    Account,
    SshKeys,
    GpgKeys,
}

impl Area {
    /// Las de la cuenta no dependen de ningún repositorio.
    fn is_account(self) -> bool {
        matches!(self, Area::Account | Area::SshKeys | Area::GpgKeys)
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn failed(message: impl Into<String>) -> GhResult {
    let message = message.into();
    GhResult {
        needs_admin_scope: needs_scope(&message),
        ok: false,
        message,
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

/// `gh` dice que falta un permiso del token (`admin:public_key`,
/// `admin:repo_hook`, `workflow`…).
pub fn needs_scope(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("admin:public_key")
        || error.contains("admin:gpg_key")
        || error.contains("admin:repo_hook")
        || error.contains("write:public_key")
        || (error.contains("workflow") && error.contains("scope"))
        || error.contains("gh auth refresh")
}

fn not_found(error: &str) -> bool {
    error.contains("HTTP 404") || error.to_ascii_lowercase().contains("not found")
}

/// `gh` dice que la rama no tiene protección (o que no existe).
fn unprotected(error: &str) -> bool {
    not_found(error) || error.contains("Branch not protected")
}

// ---- Validación ----

/// Nombre de secreto o variable de Actions: letras, números y `_`, sin
/// empezar por número ni por `GITHUB_` (reservado).
pub fn valid_secret_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(|character: char| character.is_ascii_digit())
        && !name.to_ascii_uppercase().starts_with("GITHUB_")
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Nombre de una entrada de `workflow_dispatch`.
pub fn valid_input_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
}

pub fn valid_permission(permission: &str) -> bool {
    matches!(
        permission,
        "pull" | "triage" | "push" | "maintain" | "admin"
    )
}

/// Solo `https://`, sin espacios ni comillas: es la dirección a la que GitHub
/// mandará cada evento.
pub fn valid_hook_url(url: &str) -> bool {
    url.len() <= 500
        && url.starts_with("https://")
        && url.len() > "https://".len()
        && !url.chars().any(|character| {
            character.is_whitespace() || character.is_control() || "\"'<>`".contains(character)
        })
}

/// Una clave pública SSH en una línea (`ssh-ed25519 AAAA… comentario`).
pub fn valid_public_key(key: &str) -> bool {
    let key = key.trim();
    key.len() <= 4096
        && !key.contains(['\n', '\r'])
        && [
            "ssh-ed25519 ",
            "ssh-rsa ",
            "ecdsa-sha2-",
            "sk-ssh-ed25519@",
            "sk-ecdsa-sha2-",
        ]
        .iter()
        .any(|prefix| key.starts_with(prefix))
        && !key.contains("PRIVATE KEY")
}

// ---- Lo que se pide a `gh` para cada lista ----

pub fn list_args(full_name: &str, area: Area, branch: &str) -> Result<Vec<String>, String> {
    let api = |path: String| {
        Ok(strings(&[
            "api",
            "-H",
            "Accept: application/vnd.github+json",
            &path,
        ]))
    };
    match area {
        Area::Artifacts => api(format!("repos/{full_name}/actions/artifacts?per_page=50")),
        Area::Workflows => api(format!("repos/{full_name}/actions/workflows?per_page=100")),
        Area::Secrets => Ok(strings(&[
            "secret",
            "list",
            "--repo",
            full_name,
            "--json",
            "name,updatedAt",
        ])),
        Area::Variables => Ok(strings(&[
            "variable",
            "list",
            "--repo",
            full_name,
            "--json",
            "name,value,updatedAt",
        ])),
        Area::Environments => api(format!("repos/{full_name}/environments?per_page=100")),
        Area::Collaborators => api(format!("repos/{full_name}/collaborators?per_page=100")),
        Area::Hooks => api(format!("repos/{full_name}/hooks?per_page=100")),
        Area::DeployKeys => api(format!("repos/{full_name}/keys?per_page=100")),
        Area::Pages => api(format!("repos/{full_name}/pages")),
        Area::Protection => {
            if !valid_ref_name(branch) {
                return Err("Rama no válida.".into());
            }
            api(format!("repos/{full_name}/branches/{branch}/protection"))
        }
        Area::Dependabot => api(format!(
            "repos/{full_name}/dependabot/alerts?state=open&per_page=50"
        )),
        Area::CodeScanning => api(format!(
            "repos/{full_name}/code-scanning/alerts?state=open&per_page=50"
        )),
        Area::SecretScanning => api(format!(
            "repos/{full_name}/secret-scanning/alerts?state=open&per_page=50"
        )),
        Area::Community => api(format!("repos/{full_name}/community/profile")),
        Area::Account => api("user".to_string()),
        Area::SshKeys => api("user/keys?per_page=100".to_string()),
        Area::GpgKeys => api("user/gpg_keys?per_page=100".to_string()),
    }
}

fn text(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) => clean_line(text, 300),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn url(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://github.com/"))
        .map(str::to_string)
}

fn array<'a>(value: &'a Value, pointer: &str) -> Vec<&'a Value> {
    match value.pointer(pointer) {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn size(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

/// Convierte la respuesta de `gh` en filas. Pura: se prueba con JSON de
/// ejemplo de la API.
pub fn parse_list(area: Area, json: &str) -> AdminList {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return AdminList::default();
    };
    let rows: Vec<AdminRow> = match area {
        Area::Artifacts => array(&value, "/artifacts")
            .into_iter()
            .map(|item| AdminRow {
                // `artefacto|ejecución`: borrar usa el primero y descargar
                // el segundo con el nombre.
                id: format!("{}|{}", text(item, "/id"), text(item, "/workflow_run/id")),
                title: text(item, "/name"),
                detail: format!(
                    "{} · {}",
                    size(
                        item.pointer("/size_in_bytes")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                    ),
                    text(item, "/created_at")
                ),
                state: if item.pointer("/expired").and_then(Value::as_bool) == Some(true) {
                    "expirado".into()
                } else {
                    String::new()
                },
                url: None,
            })
            .collect(),
        Area::Workflows => array(&value, "/workflows")
            .into_iter()
            .map(|item| AdminRow {
                id: text(item, "/id"),
                title: text(item, "/name"),
                detail: text(item, "/path"),
                state: text(item, "/state"),
                url: url(item, "/html_url"),
            })
            .collect(),
        Area::Secrets => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/name"),
                        title: text(item, "/name"),
                        detail: text(item, "/updatedAt"),
                        ..AdminRow::default()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::Variables => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/name"),
                        title: text(item, "/name"),
                        detail: text(item, "/value"),
                        state: text(item, "/updatedAt"),
                        url: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::Environments => array(&value, "/environments")
            .into_iter()
            .map(|item| AdminRow {
                id: text(item, "/name"),
                title: text(item, "/name"),
                detail: format!(
                    "{} reglas de protección",
                    array(item, "/protection_rules").len()
                ),
                state: String::new(),
                url: url(item, "/html_url"),
            })
            .collect(),
        Area::Collaborators => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/login"),
                        title: text(item, "/login"),
                        detail: text(item, "/role_name"),
                        state: String::new(),
                        url: url(item, "/html_url"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::Hooks => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/id"),
                        title: text(item, "/config/url"),
                        detail: array(item, "/events")
                            .iter()
                            .filter_map(|event| event.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                        state: if item.pointer("/active").and_then(Value::as_bool) == Some(true) {
                            "activo".into()
                        } else {
                            "inactivo".into()
                        },
                        url: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::DeployKeys | Area::SshKeys => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/id"),
                        title: text(item, "/title"),
                        // Solo el principio de la clave: basta para reconocerla.
                        detail: text(item, "/key").chars().take(40).collect::<String>() + "…",
                        state: match item.pointer("/read_only").and_then(Value::as_bool) {
                            Some(true) => "solo lectura".into(),
                            Some(false) => "lectura y escritura".into(),
                            None => String::new(),
                        },
                        url: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::GpgKeys => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/id"),
                        title: text(item, "/key_id"),
                        detail: array(item, "/emails")
                            .iter()
                            .filter_map(|email| email.pointer("/email").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join(", "),
                        state: text(item, "/expires_at"),
                        url: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::Pages => vec![AdminRow {
            id: "pages".into(),
            title: text(&value, "/html_url"),
            detail: format!(
                "{} {}",
                text(&value, "/source/branch"),
                text(&value, "/source/path")
            )
            .trim()
            .to_string(),
            state: text(&value, "/status"),
            url: url(&value, "/html_url").or_else(|| {
                value
                    .pointer("/html_url")
                    .and_then(Value::as_str)
                    .filter(|url| url.starts_with("https://"))
                    .map(str::to_string)
            }),
        }],
        // El panel rellena su formulario con `reviews`, `enforceAdmins` y
        // `linearHistory`: su `detail` es el valor tal cual de la API (vacío
        // si la rama no lo tiene). Las demás filas enseñan lo que «Proteger»
        // conserva sin tocarlo.
        Area::Protection => vec![
            AdminRow {
                id: "reviews".into(),
                title: "Revisiones obligatorias".into(),
                detail: text(
                    &value,
                    "/required_pull_request_reviews/required_approving_review_count",
                ),
                ..AdminRow::default()
            },
            AdminRow {
                id: "enforceAdmins".into(),
                title: "También para administradores".into(),
                detail: text(&value, "/enforce_admins/enabled"),
                ..AdminRow::default()
            },
            AdminRow {
                id: "linearHistory".into(),
                title: "Historial lineal".into(),
                detail: text(&value, "/required_linear_history/enabled"),
                ..AdminRow::default()
            },
            AdminRow {
                id: "forcePushes".into(),
                title: "Permite force push".into(),
                detail: text(&value, "/allow_force_pushes/enabled"),
                ..AdminRow::default()
            },
            AdminRow {
                id: "statusChecks".into(),
                title: "Comprobaciones obligatorias".into(),
                detail: {
                    let checks: Vec<&str> = match value.pointer("/required_status_checks/checks") {
                        Some(Value::Array(checks)) => checks
                            .iter()
                            .filter_map(|check| check.get("context").and_then(Value::as_str))
                            .collect(),
                        _ => array(&value, "/required_status_checks/contexts")
                            .into_iter()
                            .filter_map(Value::as_str)
                            .collect(),
                    };
                    clean_line(&checks.join(", "), 300)
                },
                ..AdminRow::default()
            },
            AdminRow {
                id: "codeOwners".into(),
                title: "Revisión de CODEOWNERS".into(),
                detail: text(
                    &value,
                    "/required_pull_request_reviews/require_code_owner_reviews",
                ),
                ..AdminRow::default()
            },
            AdminRow {
                id: "conversationResolution".into(),
                title: "Conversaciones resueltas".into(),
                detail: text(&value, "/required_conversation_resolution/enabled"),
                ..AdminRow::default()
            },
            AdminRow {
                id: "deletions".into(),
                title: "Permite borrar la rama".into(),
                detail: text(&value, "/allow_deletions/enabled"),
                ..AdminRow::default()
            },
        ],
        Area::Dependabot => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/number"),
                        title: text(item, "/security_advisory/summary"),
                        detail: text(item, "/dependency/package/name"),
                        state: text(item, "/security_vulnerability/severity"),
                        url: url(item, "/html_url"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::CodeScanning => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/number"),
                        title: text(item, "/rule/description"),
                        detail: text(item, "/most_recent_instance/location/path"),
                        state: text(item, "/rule/severity"),
                        url: url(item, "/html_url"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::SecretScanning => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AdminRow {
                        id: text(item, "/number"),
                        title: text(item, "/secret_type_display_name"),
                        detail: text(item, "/created_at"),
                        state: text(item, "/state"),
                        url: url(item, "/html_url"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Area::Community => {
            let mut rows = vec![AdminRow {
                id: "health".into(),
                title: "Salud de la comunidad".into(),
                detail: format!("{} %", text(&value, "/health_percentage")),
                ..AdminRow::default()
            }];
            for (key, label) in [
                ("readme", "README"),
                ("license", "Licencia"),
                ("contributing", "CONTRIBUTING"),
                ("code_of_conduct", "Código de conducta"),
                ("issue_template", "Plantilla de issues"),
                ("pull_request_template", "Plantilla de pull requests"),
            ] {
                let present = value
                    .pointer(&format!("/files/{key}"))
                    .is_some_and(|file| !file.is_null());
                rows.push(AdminRow {
                    id: key.into(),
                    title: label.into(),
                    detail: String::new(),
                    state: if present {
                        "sí".into()
                    } else {
                        "falta".into()
                    },
                    url: url(&value, &format!("/files/{key}/html_url")),
                });
            }
            rows
        }
        Area::Account => vec![AdminRow {
            id: text(&value, "/login"),
            title: {
                let name = text(&value, "/name");
                if name.is_empty() {
                    text(&value, "/login")
                } else {
                    format!("{name} ({})", text(&value, "/login"))
                }
            },
            detail: format!(
                "{} repositorios públicos · {} seguidores · {}",
                text(&value, "/public_repos"),
                text(&value, "/followers"),
                text(&value, "/bio")
            ),
            state: text(&value, "/plan/name"),
            url: url(&value, "/html_url"),
        }],
    };
    AdminList {
        rows,
        note: None,
        needs_admin_scope: false,
    }
}

/// Lo que se enseña cuando `gh` contesta que no hay nada que enseñar.
fn note_for(area: Area, error: &str) -> Option<String> {
    match area {
        Area::Pages if not_found(error) => Some("GitHub Pages no está activado en este repositorio.".into()),
        Area::Protection if unprotected(error) => {
            Some("La rama no está protegida.".into())
        }
        Area::Dependabot | Area::CodeScanning | Area::SecretScanning
            if error.contains("disabled") || error.contains("not enabled") || not_found(error) || error.contains("HTTP 403") =>
        {
            Some(format!("Estas alertas no están activadas en este repositorio o tu cuenta no puede verlas ({error})."))
        }
        _ => None,
    }
}

pub fn list(full_name: &str, area: Area, branch: &str) -> Result<AdminList, String> {
    let name = if area.is_account() {
        String::new()
    } else {
        gh_cli::own(full_name)
            .map(|repository| repository.repository.full_name)
            .ok_or_else(|| "El repositorio no está en el listado de tu cuenta.".to_string())?
    };
    let args = list_args(&name, area, branch)?;
    match gh_cli::run_args(&args, QUICK) {
        Ok(json) => Ok(parse_list(area, &json)),
        Err(error) => {
            if let Some(note) = note_for(area, &error) {
                return Ok(AdminList {
                    note: Some(note),
                    ..AdminList::default()
                });
            }
            if needs_scope(&error) {
                return Ok(AdminList {
                    note: Some(error),
                    needs_admin_scope: true,
                    ..AdminList::default()
                });
            }
            Err(error)
        }
    }
}

// ---- Cambios ----

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AdminAction {
    #[serde(rename_all = "camelCase")]
    ArtifactDelete {
        id: u64,
    },
    #[serde(rename_all = "camelCase")]
    ArtifactDownload {
        run_id: u64,
        name: String,
        dir: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowRun {
        workflow: u64,
        git_ref: String,
        inputs: Vec<(String, String)>,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowEnable {
        workflow: u64,
        enable: bool,
    },
    #[serde(rename_all = "camelCase")]
    SecretSet {
        name: String,
        value: String,
    },
    #[serde(rename_all = "camelCase")]
    SecretDelete {
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    VariableSet {
        name: String,
        value: String,
    },
    #[serde(rename_all = "camelCase")]
    VariableDelete {
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    CollaboratorAdd {
        login: String,
        permission: String,
    },
    #[serde(rename_all = "camelCase")]
    CollaboratorRemove {
        login: String,
    },
    #[serde(rename_all = "camelCase")]
    HookCreate {
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    HookPing {
        id: u64,
    },
    #[serde(rename_all = "camelCase")]
    HookDelete {
        id: u64,
    },
    #[serde(rename_all = "camelCase")]
    DeployKeyAdd {
        title: String,
        key: String,
        read_only: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeployKeyDelete {
        id: u64,
    },
    #[serde(rename_all = "camelCase")]
    PagesEnable {
        branch: String,
        path: String,
    },
    PagesDisable,
    #[serde(rename_all = "camelCase")]
    ProtectionSet {
        branch: String,
        /// Aprobaciones que pide cada pull request (0 a 6); `None` si la rama
        /// no exige pull request.
        reviews: Option<u8>,
        enforce_admins: bool,
        linear_history: bool,
    },
    #[serde(rename_all = "camelCase")]
    ProtectionRemove {
        branch: String,
    },
    #[serde(rename_all = "camelCase")]
    VulnerabilityAlerts {
        enable: bool,
    },
    #[serde(rename_all = "camelCase")]
    SshKeyAdd {
        title: String,
        key: String,
    },
    #[serde(rename_all = "camelCase")]
    SshKeyDelete {
        id: u64,
    },
}

/// Una orden de `gh` lista para ejecutar: argumentos, lo que va por la
/// entrada estándar (nunca en los argumentos) y el mensaje si sale bien.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub args: Vec<String>,
    pub input: Option<String>,
    pub message: String,
    pub timeout: Duration,
}

fn plan(args: Vec<String>, message: impl Into<String>) -> Plan {
    Plan {
        args,
        input: None,
        message: message.into(),
        timeout: QUICK,
    }
}

/// Un campo de `gh api`. Cada uno dice lo que es en vez de adivinarlo por el
/// valor: un título «2025» o una rama «2024» son texto, y GitHub contesta 422
/// si le llegan como número.
#[derive(Debug, Clone, PartialEq)]
enum Field {
    /// `-f`: texto tal cual.
    Text(String),
    /// `-F`: `gh` lo convierte en booleano de JSON.
    Bool(bool),
}

fn api_call(
    method: &str,
    path: String,
    fields: &[(&str, Field)],
    message: impl Into<String>,
) -> Plan {
    let mut args = strings(&[
        "api",
        "-X",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        &path,
    ]);
    for (key, field) in fields {
        let (flag, value) = match field {
            Field::Text(value) => ("-f", value.clone()),
            Field::Bool(flag) => ("-F", flag.to_string()),
        };
        args.push(flag.to_string());
        args.push(format!("{key}={value}"));
    }
    plan(args, message)
}

/// Lo que ya hay en GitHub y cambia la orden. `act` lo averigua antes de
/// llamar a [`action_plan`], que así sigue siendo pura.
#[derive(Debug, Clone, Copy, Default)]
pub struct Current<'a> {
    /// El repositorio es de la cuenta personal, no de una organización:
    /// GitHub da a sus colaboradores lectura y escritura sin mirar el permiso.
    pub personal: bool,
    /// La protección que ya tiene la rama (`GET …/protection`), o `None` si
    /// no tiene ninguna.
    pub protection: Option<&'a Value>,
}

/// Hoy todos los repositorios de `own()` son de la cuenta personal: salen de
/// `gh repo list` sin propietario, que solo lista los de la cuenta con la
/// sesión. Si el listado llega a incluir los de una organización, esto tiene
/// que mirar el tipo del propietario, y el panel puede volver a ofrecer el
/// permiso de cada colaborador.
fn is_personal(_repository: &gh_cli::GhRepository) -> bool {
    true
}

/// `GET …/protection` devuelve los usuarios, equipos y apps como objetos; el
/// PUT los quiere por su nombre (`login` o `slug`).
fn actor_names(value: &Value) -> Value {
    let names = |list: &str, field: &str| -> Vec<Value> {
        array(value, &format!("/{list}"))
            .into_iter()
            .filter_map(|item| item.get(field).and_then(Value::as_str))
            .map(|name| Value::String(name.to_string()))
            .collect()
    };
    serde_json::json!({
        "users": names("users", "login"),
        "teams": names("teams", "slug"),
        "apps": names("apps", "slug"),
    })
}

/// Las comprobaciones obligatorias tal como las pide el PUT. `checks` dice
/// además qué app tiene que dar cada una: `null` es «cualquiera», que en el
/// PUT se escribe -1 (sin `app_id`, GitHub ataría la comprobación a la última
/// app que la dio).
fn status_checks_body(current: Option<&Value>) -> Value {
    let Some(current) = current.filter(|current| current.is_object()) else {
        return Value::Null;
    };
    let strict = current
        .get("strict")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match current.get("checks").and_then(Value::as_array) {
        Some(checks) => serde_json::json!({
            "strict": strict,
            "checks": checks
                .iter()
                .filter_map(|check| {
                    let context = check.get("context")?.as_str()?;
                    Some(serde_json::json!({
                        "context": context,
                        "app_id": check.get("app_id").and_then(Value::as_i64).unwrap_or(-1),
                    }))
                })
                .collect::<Vec<_>>(),
        }),
        None => serde_json::json!({
            "strict": strict,
            "contexts": array(current, "/contexts")
                .into_iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
        }),
    }
}

/// Las revisiones: el número es del panel; lo demás (descartar aprobaciones
/// antiguas, CODEOWNERS, aprobar el último push, quién puede descartarlas o
/// saltárselas) se conserva de lo que ya tenía la rama.
fn reviews_body(current: Option<&Value>, reviews: Option<u8>) -> Value {
    let Some(count) = reviews else {
        return Value::Null;
    };
    let mut body = serde_json::json!({ "required_approving_review_count": count });
    let Some(current) = current.filter(|current| current.is_object()) else {
        return body;
    };
    for key in [
        "dismiss_stale_reviews",
        "require_code_owner_reviews",
        "require_last_push_approval",
    ] {
        if let Some(flag) = current.get(key).and_then(Value::as_bool) {
            body[key] = Value::Bool(flag);
        }
    }
    for key in ["dismissal_restrictions", "bypass_pull_request_allowances"] {
        if let Some(actors) = current.get(key).filter(|actors| actors.is_object()) {
            body[key] = actor_names(actors);
        }
    }
    body
}

/// El cuerpo del PUT de la protección de una rama. El PUT sustituye la
/// protección entera, así que se parte de la que ya tiene la rama (`current`,
/// de `GET …/protection`) y solo cambia lo que gestiona el panel: revisiones,
/// administradores e historial lineal. Lo demás (comprobaciones obligatorias
/// con sus contextos, restricciones, force push, borrar la rama,
/// conversaciones resueltas, bloqueo y las subopciones de las revisiones) se
/// conserva tal cual. Pura: se prueba con JSON de ejemplo de la API.
pub fn protection_body(
    current: Option<&Value>,
    reviews: Option<u8>,
    enforce_admins: bool,
    linear_history: bool,
) -> Value {
    let field = |key: &str| current.and_then(|current| current.get(key));
    let mut body = serde_json::json!({
        "required_status_checks": status_checks_body(field("required_status_checks")),
        "enforce_admins": enforce_admins,
        "required_pull_request_reviews": reviews_body(field("required_pull_request_reviews"), reviews),
        // Solo existen en los repositorios de organización.
        "restrictions": field("restrictions")
            .filter(|restrictions| restrictions.is_object())
            .map(actor_names)
            .unwrap_or(Value::Null),
        "required_linear_history": linear_history,
    });
    for key in [
        "allow_force_pushes",
        "allow_deletions",
        "required_conversation_resolution",
        "block_creations",
        "lock_branch",
        "allow_fork_syncing",
    ] {
        if let Some(flag) = field(key)
            .and_then(|setting| setting.get("enabled"))
            .and_then(Value::as_bool)
        {
            body[key] = Value::Bool(flag);
        }
    }
    body
}

/// Traduce cada cambio a su orden de `gh`. Puro: se prueba sin `gh`; lo que
/// hay que saber de GitHub llega en `current`.
pub fn action_plan(
    full_name: &str,
    action: &AdminAction,
    current: Current<'_>,
) -> Result<Plan, String> {
    let repo = full_name;
    Ok(match action {
        AdminAction::ArtifactDelete { id } => {
            if *id == 0 {
                return Err("Artefacto no válido.".into());
            }
            api_call(
                "DELETE",
                format!("repos/{repo}/actions/artifacts/{id}"),
                &[],
                "Artefacto borrado.",
            )
        }
        AdminAction::ArtifactDownload { run_id, name, dir } => {
            let name = clean_line(name, 256);
            if *run_id == 0 || name.is_empty() || name.starts_with('-') {
                return Err("Artefacto no válido.".into());
            }
            let path = std::path::Path::new(dir);
            if !path.is_absolute() || !path.is_dir() {
                return Err("Elige una carpeta que exista.".into());
            }
            Plan {
                timeout: DOWNLOAD,
                ..plan(
                    strings(&[
                        "run",
                        "download",
                        &run_id.to_string(),
                        "--repo",
                        repo,
                        "--name",
                        &name,
                        "--dir",
                        dir,
                    ]),
                    format!("«{name}» descargado en {dir}."),
                )
            }
        }
        AdminAction::WorkflowRun {
            workflow,
            git_ref,
            inputs,
        } => {
            if *workflow == 0 || !valid_ref_name(git_ref) {
                return Err("Workflow o rama no válidos.".into());
            }
            if inputs.len() > MAX_INPUTS {
                return Err(format!("Como mucho {MAX_INPUTS} entradas."));
            }
            let mut args = strings(&[
                "workflow",
                "run",
                &workflow.to_string(),
                "--repo",
                repo,
                "--ref",
                git_ref,
            ]);
            for (key, value) in inputs {
                if !valid_input_name(key) {
                    return Err(format!("Nombre de entrada no válido: {key}"));
                }
                args.push("-f".into());
                args.push(format!("{key}={}", clean_line(value, MAX_VALUE_CHARS)));
            }
            plan(args, format!("Workflow lanzado en {git_ref}."))
        }
        AdminAction::WorkflowEnable { workflow, enable } => {
            if *workflow == 0 {
                return Err("Workflow no válido.".into());
            }
            plan(
                strings(&[
                    "workflow",
                    if *enable { "enable" } else { "disable" },
                    &workflow.to_string(),
                    "--repo",
                    repo,
                ]),
                if *enable {
                    "Workflow activado."
                } else {
                    "Workflow desactivado."
                },
            )
        }
        AdminAction::SecretSet { name, value } => {
            if !valid_secret_name(name) {
                return Err(
                    "Nombre de secreto no válido: letras, números y _, sin empezar por GITHUB_."
                        .into(),
                );
            }
            if value.is_empty() || value.len() > MAX_SECRET_CHARS {
                return Err("El valor está vacío o es demasiado largo.".into());
            }
            Plan {
                input: Some(value.clone()),
                ..plan(
                    strings(&["secret", "set", name, "--repo", repo]),
                    format!("Secreto {name} guardado."),
                )
            }
        }
        AdminAction::SecretDelete { name } => {
            if !valid_secret_name(name) {
                return Err("Nombre de secreto no válido.".into());
            }
            plan(
                strings(&["secret", "delete", name, "--repo", repo]),
                format!("Secreto {name} borrado."),
            )
        }
        AdminAction::VariableSet { name, value } => {
            if !valid_secret_name(name) {
                return Err("Nombre de variable no válido.".into());
            }
            let value = clean_line(value, MAX_VALUE_CHARS);
            plan(
                strings(&["variable", "set", name, "--body", &value, "--repo", repo]),
                format!("Variable {name} guardada."),
            )
        }
        AdminAction::VariableDelete { name } => {
            if !valid_secret_name(name) {
                return Err("Nombre de variable no válido.".into());
            }
            plan(
                strings(&["variable", "delete", name, "--repo", repo]),
                format!("Variable {name} borrada."),
            )
        }
        AdminAction::CollaboratorAdd { login, permission } => {
            if !crate::github::is_github_owner(login) || !valid_permission(permission) {
                return Err("Usuario o permiso no válidos.".into());
            }
            // GitHub solo mira `permission` en los repositorios de una
            // organización: en uno personal el colaborador siempre tiene
            // lectura y escritura. Mejor no dejar creer que tendrá menos.
            if current.personal && permission != "push" {
                return Err(
                    "En un repositorio de tu cuenta personal, cada colaborador tiene lectura y escritura (push): GitHub no admite otro permiso."
                        .into(),
                );
            }
            api_call(
                "PUT",
                format!("repos/{repo}/collaborators/{login}"),
                &[("permission", Field::Text(permission.clone()))],
                if current.personal {
                    format!("Invitación enviada a {login}: tendrá lectura y escritura.")
                } else {
                    format!("Invitación enviada a {login}.")
                },
            )
        }
        AdminAction::CollaboratorRemove { login } => {
            if !crate::github::is_github_owner(login) {
                return Err("Usuario no válido.".into());
            }
            api_call(
                "DELETE",
                format!("repos/{repo}/collaborators/{login}"),
                &[],
                format!("{login} ya no colabora."),
            )
        }
        AdminAction::HookCreate { url } => {
            if !valid_hook_url(url) {
                return Err("La dirección del webhook tiene que empezar por https://".into());
            }
            api_call(
                "POST",
                format!("repos/{repo}/hooks"),
                &[
                    ("name", Field::Text("web".into())),
                    ("config[url]", Field::Text(url.clone())),
                    ("config[content_type]", Field::Text("json".into())),
                    ("active", Field::Bool(true)),
                    ("events[]", Field::Text("push".into())),
                ],
                "Webhook creado (eventos push).",
            )
        }
        AdminAction::HookPing { id } => api_call(
            "POST",
            format!("repos/{repo}/hooks/{id}/pings"),
            &[],
            "Ping enviado.",
        ),
        AdminAction::HookDelete { id } => api_call(
            "DELETE",
            format!("repos/{repo}/hooks/{id}"),
            &[],
            "Webhook borrado.",
        ),
        AdminAction::DeployKeyAdd {
            title,
            key,
            read_only,
        } => {
            let title = clean_line(title, 100);
            if title.is_empty() || !valid_public_key(key) {
                return Err("Hace falta un título y una clave pública SSH (ssh-ed25519 …).".into());
            }
            api_call(
                "POST",
                format!("repos/{repo}/keys"),
                &[
                    ("title", Field::Text(title)),
                    ("key", Field::Text(key.trim().to_string())),
                    ("read_only", Field::Bool(*read_only)),
                ],
                "Clave de despliegue añadida.",
            )
        }
        AdminAction::DeployKeyDelete { id } => api_call(
            "DELETE",
            format!("repos/{repo}/keys/{id}"),
            &[],
            "Clave de despliegue borrada.",
        ),
        AdminAction::PagesEnable { branch, path } => {
            if !valid_ref_name(branch) || !matches!(path.as_str(), "/" | "/docs") {
                return Err("Rama o carpeta no válidas (la carpeta es / o /docs).".into());
            }
            api_call(
                "POST",
                format!("repos/{repo}/pages"),
                &[
                    ("source[branch]", Field::Text(branch.clone())),
                    ("source[path]", Field::Text(path.clone())),
                ],
                "GitHub Pages activado.",
            )
        }
        AdminAction::PagesDisable => api_call(
            "DELETE",
            format!("repos/{repo}/pages"),
            &[],
            "GitHub Pages desactivado.",
        ),
        AdminAction::ProtectionSet {
            branch,
            reviews,
            enforce_admins,
            linear_history,
        } => {
            if !valid_ref_name(branch) || reviews.is_some_and(|count| count > 6) {
                return Err("Rama o número de revisiones no válidos (0 a 6).".into());
            }
            let body = protection_body(
                current.protection,
                *reviews,
                *enforce_admins,
                *linear_history,
            );
            Plan {
                input: Some(body.to_string()),
                ..plan(
                    strings(&[
                        "api",
                        "-X",
                        "PUT",
                        "-H",
                        "Accept: application/vnd.github+json",
                        &format!("repos/{repo}/branches/{branch}/protection"),
                        "--input",
                        "-",
                    ]),
                    format!("Rama {branch} protegida."),
                )
            }
        }
        AdminAction::ProtectionRemove { branch } => {
            if !valid_ref_name(branch) {
                return Err("Rama no válida.".into());
            }
            api_call(
                "DELETE",
                format!("repos/{repo}/branches/{branch}/protection"),
                &[],
                format!("Rama {branch} sin protección."),
            )
        }
        AdminAction::VulnerabilityAlerts { enable } => api_call(
            if *enable { "PUT" } else { "DELETE" },
            format!("repos/{repo}/vulnerability-alerts"),
            &[],
            if *enable {
                "Alertas de vulnerabilidades activadas."
            } else {
                "Alertas de vulnerabilidades desactivadas."
            },
        ),
        AdminAction::SshKeyAdd { title, key } => {
            let title = clean_line(title, 100);
            if title.is_empty() || !valid_public_key(key) {
                return Err("Hace falta un título y una clave pública SSH (ssh-ed25519 …).".into());
            }
            api_call(
                "POST",
                "user/keys".into(),
                &[
                    ("title", Field::Text(title)),
                    ("key", Field::Text(key.trim().to_string())),
                ],
                "Clave SSH añadida a tu cuenta.",
            )
        }
        AdminAction::SshKeyDelete { id } => api_call(
            "DELETE",
            format!("user/keys/{id}"),
            &[],
            "Clave SSH borrada de tu cuenta.",
        ),
    })
}

fn is_account_action(action: &AdminAction) -> bool {
    matches!(
        action,
        AdminAction::SshKeyAdd { .. } | AdminAction::SshKeyDelete { .. }
    )
}

/// La protección que ya tiene la rama, o `None` si no tiene ninguna. Es la
/// misma orden fija que la lista del área.
fn read_protection(repo: &str, branch: &str) -> Result<Option<Value>, String> {
    let args = list_args(repo, Area::Protection, branch)?;
    match gh_cli::run_args(&args, QUICK) {
        Ok(json) => serde_json::from_str::<Value>(&json)
            .map(Some)
            .map_err(|_| "Respuesta de GitHub no válida; no se ha cambiado nada.".to_string()),
        Err(error) if unprotected(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn act(full_name: &str, action: &AdminAction) -> GhResult {
    let repository = if is_account_action(action) {
        None
    } else {
        match gh_cli::own(full_name) {
            Some(repository) => Some(repository),
            None => return failed("El repositorio no está en el listado de tu cuenta."),
        }
    };
    let name = repository
        .as_ref()
        .map(|repository| repository.repository.full_name.clone())
        .unwrap_or_default();
    // El PUT de la protección la sustituye entera: antes se lee la que hay,
    // para conservar lo que el panel no gestiona. Si no se puede leer, no se
    // cambia nada.
    let protection = match action {
        AdminAction::ProtectionSet { branch, .. } => match read_protection(&name, branch) {
            Ok(protection) => protection,
            Err(error) => return failed(error),
        },
        _ => None,
    };
    let current = Current {
        personal: repository.as_ref().is_some_and(is_personal),
        protection: protection.as_ref(),
    };
    let plan = match action_plan(&name, action, current) {
        Ok(plan) => plan,
        Err(error) => return failed(error),
    };
    let result = match &plan.input {
        Some(input) => gh_cli::run_args_with_input(&plan.args, input, plan.timeout),
        None => gh_cli::run_args(&plan.args, plan.timeout),
    };
    match result {
        Ok(_) => done(plan.message),
        Err(error) => failed(error),
    }
}

// ---- Órdenes de Tauri ----

#[tauri::command]
pub async fn github_admin_list(
    full_name: String,
    area: Area,
    branch: Option<String>,
) -> Result<AdminList, String> {
    let branch = branch.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || list(&full_name, area, &branch))
        .await
        .map_err(|_| "GitHub CLI no terminó.".to_string())?
}

#[tauri::command]
pub async fn github_admin_action(full_name: String, action: AdminAction) -> GhResult {
    tauri::async_runtime::spawn_blocking(move || act(&full_name, &action))
        .await
        .unwrap_or_else(|_| failed("GitHub CLI no terminó."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_valor_de_un_secreto_va_por_la_entrada_estandar_y_nunca_en_los_argumentos() {
        let plan = action_plan(
            "ana/web",
            &AdminAction::SecretSet {
                name: "TOKEN_DE_PRUEBA".into(),
                value: "s3cr3t-valor".into(),
            },
            Current::default(),
        )
        .unwrap();
        assert_eq!(
            plan.args,
            strings(&["secret", "set", "TOKEN_DE_PRUEBA", "--repo", "ana/web"])
        );
        assert!(plan.args.iter().all(|arg| !arg.contains("s3cr3t")));
        assert_eq!(plan.input.as_deref(), Some("s3cr3t-valor"));
    }

    #[test]
    fn los_nombres_de_secretos_no_admiten_reservados_ni_caracteres_raros() {
        assert!(valid_secret_name("NPM_TOKEN"));
        assert!(!valid_secret_name("GITHUB_TOKEN"));
        assert!(!valid_secret_name("1TOKEN"));
        assert!(!valid_secret_name("TOKEN; rm"));
        assert!(!valid_secret_name(""));
    }

    #[test]
    fn lanzar_un_workflow_valida_rama_y_entradas() {
        let plan = action_plan(
            "ana/web",
            &AdminAction::WorkflowRun {
                workflow: 42,
                git_ref: "main".into(),
                inputs: vec![("version".into(), "1.2.3".into())],
            },
            Current::default(),
        )
        .unwrap();
        assert_eq!(
            plan.args,
            strings(&[
                "workflow",
                "run",
                "42",
                "--repo",
                "ana/web",
                "--ref",
                "main",
                "-f",
                "version=1.2.3"
            ])
        );
        assert!(action_plan(
            "ana/web",
            &AdminAction::WorkflowRun {
                workflow: 42,
                git_ref: "--help".into(),
                inputs: vec![]
            },
            Current::default()
        )
        .is_err());
        assert!(action_plan(
            "ana/web",
            &AdminAction::WorkflowRun {
                workflow: 42,
                git_ref: "main".into(),
                inputs: vec![("-x".into(), "1".into())]
            },
            Current::default()
        )
        .is_err());
    }

    #[test]
    fn las_rutas_de_la_api_son_fijas_con_el_repositorio_validado() {
        assert_eq!(
            list_args("ana/web", Area::Hooks, "").unwrap(),
            strings(&[
                "api",
                "-H",
                "Accept: application/vnd.github+json",
                "repos/ana/web/hooks?per_page=100"
            ])
        );
        assert!(list_args("ana/web", Area::Protection, "../../user").is_err());
        let protect = action_plan(
            "ana/web",
            &AdminAction::ProtectionSet {
                branch: "main".into(),
                reviews: Some(1),
                enforce_admins: true,
                linear_history: false,
            },
            Current::default(),
        )
        .unwrap();
        assert_eq!(
            protect.args,
            strings(&[
                "api",
                "-X",
                "PUT",
                "-H",
                "Accept: application/vnd.github+json",
                "repos/ana/web/branches/main/protection",
                "--input",
                "-"
            ])
        );
        let body: Value = serde_json::from_str(protect.input.as_deref().unwrap()).unwrap();
        assert_eq!(
            body["required_pull_request_reviews"]["required_approving_review_count"],
            1
        );
        assert_eq!(body["enforce_admins"], true);
        // Sin protección previa no hay nada que conservar.
        assert_eq!(body["required_status_checks"], Value::Null);
        assert_eq!(body["restrictions"], Value::Null);
        // Más de 6 revisiones no vale.
        assert!(action_plan(
            "ana/web",
            &AdminAction::ProtectionSet {
                branch: "main".into(),
                reviews: Some(7),
                enforce_admins: false,
                linear_history: false,
            },
            Current::default()
        )
        .is_err());
    }

    /// Lo que devuelve `GET …/protection` de una rama con comprobaciones
    /// obligatorias, CODEOWNERS y restricciones (repositorio de organización).
    const PROTECTED_MAIN: &str = r#"{
        "required_status_checks": {"strict": true, "contexts": ["CI", "lint"], "checks": [{"context": "CI", "app_id": 15368}, {"context": "lint", "app_id": null}]},
        "enforce_admins": {"enabled": true},
        "required_pull_request_reviews": {
            "dismiss_stale_reviews": true,
            "require_code_owner_reviews": true,
            "required_approving_review_count": 2,
            "require_last_push_approval": false,
            "dismissal_restrictions": {"users": [{"login": "ana"}], "teams": [{"slug": "core"}], "apps": []},
            "bypass_pull_request_allowances": {"users": [], "teams": [{"slug": "release"}], "apps": [{"slug": "bot"}]}
        },
        "restrictions": {"users": [{"login": "ana"}], "teams": [], "apps": [{"slug": "deployer"}]},
        "required_linear_history": {"enabled": false},
        "allow_force_pushes": {"enabled": false},
        "allow_deletions": {"enabled": true},
        "block_creations": {"enabled": false},
        "required_conversation_resolution": {"enabled": true},
        "lock_branch": {"enabled": false},
        "allow_fork_syncing": {"enabled": false},
        "required_signatures": {"enabled": false}
    }"#;

    #[test]
    fn proteger_conserva_lo_que_el_panel_no_gestiona() {
        let current: Value = serde_json::from_str(PROTECTED_MAIN).unwrap();
        // Solo se activa el historial lineal, con lo demás del panel como estaba.
        let plan = action_plan(
            "ana/web",
            &AdminAction::ProtectionSet {
                branch: "main".into(),
                reviews: Some(2),
                enforce_admins: true,
                linear_history: true,
            },
            Current {
                personal: false,
                protection: Some(&current),
            },
        )
        .unwrap();
        let body: Value = serde_json::from_str(plan.input.as_deref().unwrap()).unwrap();
        assert_eq!(body["required_linear_history"], true);
        assert_eq!(body["enforce_admins"], true);
        // Las comprobaciones obligatorias siguen, cada una con su app; la que
        // vale de cualquier app va con -1.
        assert_eq!(
            body["required_status_checks"],
            serde_json::json!({
                "strict": true,
                "checks": [{"context": "CI", "app_id": 15368}, {"context": "lint", "app_id": -1}]
            })
        );
        let reviews = &body["required_pull_request_reviews"];
        assert_eq!(reviews["required_approving_review_count"], 2);
        assert_eq!(reviews["dismiss_stale_reviews"], true);
        assert_eq!(reviews["require_code_owner_reviews"], true);
        assert_eq!(reviews["require_last_push_approval"], false);
        assert_eq!(
            reviews["dismissal_restrictions"],
            serde_json::json!({"users": ["ana"], "teams": ["core"], "apps": []})
        );
        assert_eq!(
            reviews["bypass_pull_request_allowances"],
            serde_json::json!({"users": [], "teams": ["release"], "apps": ["bot"]})
        );
        assert_eq!(
            body["restrictions"],
            serde_json::json!({"users": ["ana"], "teams": [], "apps": ["deployer"]})
        );
        assert_eq!(body["allow_force_pushes"], false);
        assert_eq!(body["allow_deletions"], true);
        assert_eq!(body["required_conversation_resolution"], true);
        assert_eq!(body["block_creations"], false);
        assert_eq!(body["lock_branch"], false);
        assert_eq!(body["allow_fork_syncing"], false);
        // El PUT no admite `required_signatures`: tiene su propia ruta.
        assert!(body.get("required_signatures").is_none());

        // Sin pull request obligatoria se quitan las revisiones, pero no lo demás.
        let without_reviews = protection_body(Some(&current), None, false, false);
        assert_eq!(
            without_reviews["required_pull_request_reviews"],
            Value::Null
        );
        assert_eq!(without_reviews["enforce_admins"], false);
        assert_eq!(
            without_reviews["required_status_checks"]["checks"][0]["context"],
            "CI"
        );
        // Una pull request sin aprobaciones también es una protección.
        let zero = protection_body(Some(&current), Some(0), true, false);
        assert_eq!(
            zero["required_pull_request_reviews"]["required_approving_review_count"],
            0
        );
        assert_eq!(
            zero["required_pull_request_reviews"]["require_code_owner_reviews"],
            true
        );
    }

    /// Repositorio personal: GitHub no manda restricciones ni quién puede
    /// descartar revisiones, y aquí las comprobaciones solo traen `contexts`.
    const PERSONAL_MAIN: &str = r#"{
        "required_status_checks": {"strict": false, "contexts": ["build"]},
        "enforce_admins": {"enabled": false},
        "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": false, "require_code_owner_reviews": true},
        "allow_deletions": {"enabled": false}
    }"#;

    #[test]
    fn proteger_una_rama_personal_no_inventa_restricciones() {
        let current: Value = serde_json::from_str(PERSONAL_MAIN).unwrap();
        let body = protection_body(Some(&current), Some(1), false, true);
        assert_eq!(body["restrictions"], Value::Null);
        assert_eq!(
            body["required_status_checks"],
            serde_json::json!({"strict": false, "contexts": ["build"]})
        );
        let reviews = &body["required_pull_request_reviews"];
        assert_eq!(reviews["require_code_owner_reviews"], true);
        assert!(reviews.get("dismissal_restrictions").is_none());
        assert!(reviews.get("bypass_pull_request_allowances").is_none());
        assert_eq!(body["allow_deletions"], false);
        assert!(body.get("allow_force_pushes").is_none());
        // Sin protección previa, solo lo del panel.
        let fresh = protection_body(None, None, true, true);
        assert_eq!(
            fresh,
            serde_json::json!({
                "required_status_checks": null,
                "enforce_admins": true,
                "required_pull_request_reviews": null,
                "restrictions": null,
                "required_linear_history": true
            })
        );
    }

    #[test]
    fn la_lista_de_la_proteccion_trae_lo_que_rellena_el_formulario() {
        let list = parse_list(Area::Protection, PROTECTED_MAIN);
        let detail = |id: &str| {
            list.rows
                .iter()
                .find(|row| row.id == id)
                .map(|row| row.detail.clone())
                .unwrap()
        };
        assert_eq!(detail("reviews"), "2");
        assert_eq!(detail("enforceAdmins"), "true");
        assert_eq!(detail("linearHistory"), "false");
        assert_eq!(detail("statusChecks"), "CI, lint");
        assert_eq!(detail("codeOwners"), "true");
        // Sin pull request obligatoria, `reviews` va vacío (no «0»).
        let none = parse_list(Area::Protection, r#"{"enforce_admins":{"enabled":false}}"#);
        assert_eq!(none.rows[0].id, "reviews");
        assert_eq!(none.rows[0].detail, "");
    }

    /// `flag` seguido de `value` en los argumentos.
    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value)
    }

    #[test]
    fn en_un_repositorio_personal_el_colaborador_solo_puede_tener_push() {
        fn invite(permission: &str, current: Current<'_>) -> Result<Plan, String> {
            action_plan(
                "ana/web",
                &AdminAction::CollaboratorAdd {
                    login: "bob".into(),
                    permission: permission.into(),
                },
                current,
            )
        }
        let personal = Current {
            personal: true,
            protection: None,
        };
        let error = invite("pull", personal).unwrap_err();
        assert!(error.contains("lectura y escritura"), "{error}");
        assert!(invite("admin", personal).is_err());
        let push = invite("push", personal).unwrap();
        assert!(push.message.contains("lectura y escritura"));
        assert!(has_pair(&push.args, "-f", "permission=push"));
        // En una organización el permiso sí cuenta.
        let pull = invite("pull", Current::default()).unwrap();
        assert!(has_pair(&pull.args, "-f", "permission=pull"));
        assert!(invite("todo", Current::default()).is_err());
    }

    #[test]
    fn cada_campo_dice_si_va_como_texto_o_como_booleano() {
        // Un título o una rama que parecen números siguen siendo texto (-f);
        // `-F` solo para los booleanos, que gh convierte.
        let key = action_plan(
            "ana/web",
            &AdminAction::DeployKeyAdd {
                title: "2025".into(),
                key: "ssh-ed25519 AAAA ci".into(),
                read_only: false,
            },
            Current::default(),
        )
        .unwrap();
        assert!(has_pair(&key.args, "-f", "title=2025"));
        assert!(has_pair(&key.args, "-F", "read_only=false"));
        let ssh = action_plan(
            "",
            &AdminAction::SshKeyAdd {
                title: "007".into(),
                key: "ssh-ed25519 AAAA pc".into(),
            },
            Current::default(),
        )
        .unwrap();
        assert!(has_pair(&ssh.args, "-f", "title=007"));
        assert!(!ssh.args.contains(&"-F".to_string()));
        let pages = action_plan(
            "ana/web",
            &AdminAction::PagesEnable {
                branch: "2024".into(),
                path: "/".into(),
            },
            Current::default(),
        )
        .unwrap();
        assert!(has_pair(&pages.args, "-f", "source[branch]=2024"));
        let hook = action_plan(
            "ana/web",
            &AdminAction::HookCreate {
                url: "https://ejemplo.dev/hook".into(), // link-check: ignore
            },
            Current::default(),
        )
        .unwrap();
        assert!(has_pair(&hook.args, "-F", "active=true"));
        assert!(has_pair(&hook.args, "-f", "events[]=push"));
        assert!(has_pair(
            &hook.args,
            "-f",
            "config[url]=https://ejemplo.dev/hook" // link-check: ignore
        ));
    }

    #[test]
    fn solo_claves_publicas_y_webhooks_https() {
        assert!(valid_public_key(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI ana@pc"
        ));
        assert!(!valid_public_key("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(!valid_public_key("ssh-ed25519 AAAA\nssh-rsa BBBB"));
        assert!(valid_hook_url("https://ejemplo.dev/hook")); // link-check: ignore
        assert!(!valid_hook_url("http://ejemplo.dev/hook")); // link-check: ignore
        assert!(!valid_hook_url("https://ejemplo.dev/a b")); // link-check: ignore
        let add = action_plan(
            "ana/web",
            &AdminAction::DeployKeyAdd {
                title: "CI".into(),
                key: "ssh-ed25519 AAAA ci".into(),
                read_only: true,
            },
            Current::default(),
        )
        .unwrap();
        assert!(has_pair(&add.args, "-F", "read_only=true"));
        assert!(has_pair(&add.args, "-f", "title=CI"));
    }

    #[test]
    fn las_listas_se_leen_de_la_respuesta_de_la_api() {
        let artifacts = parse_list(
            Area::Artifacts,
            r#"{"artifacts":[{"id":7,"name":"wterminal-x64","size_in_bytes":2097152,"expired":false,"created_at":"2026-11-09T10:00:00Z","workflow_run":{"id":99}}]}"#,
        );
        assert_eq!(artifacts.rows.len(), 1);
        assert_eq!(artifacts.rows[0].id, "7|99");
        assert_eq!(artifacts.rows[0].title, "wterminal-x64");
        assert!(artifacts.rows[0].detail.starts_with("2.0 MB"));
        let community = parse_list(
            Area::Community,
            // link-check: ignore
            r#"{"health_percentage":71,"files":{"readme":{"html_url":"https://github.com/ana/web/blob/main/README.md"},"license":null,"contributing":null,"code_of_conduct":null,"issue_template":null,"pull_request_template":null}}"#,
        );
        assert_eq!(community.rows[0].detail, "71 %");
        assert_eq!(
            community
                .rows
                .iter()
                .find(|row| row.id == "readme")
                .unwrap()
                .state,
            "sí"
        );
        assert_eq!(
            community
                .rows
                .iter()
                .find(|row| row.id == "license")
                .unwrap()
                .state,
            "falta"
        );
        let dependabot = parse_list(
            Area::Dependabot,
            // link-check: ignore
            r#"[{"number":3,"html_url":"https://github.com/ana/web/security/dependabot/3","security_advisory":{"summary":"ReDoS"},"security_vulnerability":{"severity":"high"},"dependency":{"package":{"name":"lodash"}}}]"#,
        );
        assert_eq!(dependabot.rows.len(), 1);
        assert_eq!(dependabot.rows[0].state, "high");
    }

    #[test]
    fn sin_pages_o_sin_proteccion_se_explica_en_vez_de_fallar() {
        assert!(note_for(Area::Pages, "HTTP 404: Not Found").is_some());
        assert!(note_for(Area::Protection, "HTTP 404: Branch not protected").is_some());
        assert!(note_for(Area::Hooks, "HTTP 404: Not Found").is_none());
        assert!(needs_scope("This API operation needs the \"admin:public_key\" scope. To request it, run:  gh auth refresh -h github.com -s admin:public_key"));
    }
}
