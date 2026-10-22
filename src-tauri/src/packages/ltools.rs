//! Integración opcional con LTools / WinSlim-Tools.
//!
//! LTools publica un catálogo declarativo (`ltools-actions-v1`) para que los
//! hosts no tengan que duplicar sus botones ni construir comandos de shell.
//! Este módulo solo consume la lista de acciones del ejecutable encontrado en
//! el PATH. No descarga nada, no instala nada y nunca ejecuta una cadena
//! recibida del frontend: al ejecutar se vuelve a consultar el catálogo y se
//! reconstruye el comando canónico `actions run <id>` a partir del catálogo
//! validado.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands_install::shell_tab;
use crate::environments::ShellKind;
use crate::state::AppState;

const ACTIONS_SCHEMA: &str = "ltools-actions-v1";
/// Tope de acciones que se publican. Un catálogo más largo no se rechaza: se
/// usan las primeras, para que una versión nueva de Tools con más acciones
/// nunca deje la Biblioteca vacía.
const MAX_ACTIONS: usize = 1000;
const MAX_ID: usize = 100;
const MAX_TEXT: usize = 1024;
const MAX_ARGUMENTS: usize = 32;
const MAX_ARGUMENT: usize = 512;
/// El catálogo de WTools 1.0.0 ocupa unos 72 KB con 75 acciones.
const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
/// Responde en menos de 100 ms, pero la primera ejecución de un `.exe` recién
/// actualizado puede esperar al análisis del antivirus.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_VERSION_BYTES: usize = 160;
const MAX_RELEASE_DIRECTORIES: usize = 64;
const SUPPORTED_LANGUAGES: &[&str] = &[
    "ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "pl", "pt", "ro", "ru", "uk", "zh",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LToolsAction {
    pub id: String,
    pub action_key: String,
    pub scope: String,
    pub operation: String,
    pub label: String,
    #[serde(default)]
    pub short_label: Option<String>,
    pub group: String,
    pub description: String,
    pub command: String,
    pub executable: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub shell: String,
    #[serde(default = "default_current")]
    pub working_directory: String,
    #[serde(default)]
    pub terminal: bool,
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub requires_admin: bool,
    #[serde(default)]
    pub confirmation: String,
    #[serde(default)]
    pub safe: bool,
    #[serde(default)]
    pub supports: Vec<String>,
    pub target: String,
    pub target_policy: String,
    pub mutating: bool,
    pub profile: String,
    /// Calculado por LTerminal: solo se publican acciones sin objetivo
    /// obligatorio, aptas para un botón sin pedir parámetros adicionales.
    #[serde(default)]
    pub requirements_available: bool,
    /// Preferencia opcional publicada por el catálogo. El host la usa para
    /// proponer acciones nuevas sin tener que actualizar su código.
    #[serde(default)]
    pub quick: bool,
}

fn default_current() -> String {
    "current".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LToolsActionList {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub actions: Vec<LToolsAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LToolsRunResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub created: bool,
}

fn failed(error: impl Into<String>) -> LToolsRunResult {
    LToolsRunResult {
        error: Some(error.into()),
        ..Default::default()
    }
}

fn disabled_catalog() -> LToolsActionList {
    LToolsActionList {
        available: false,
        executable: None,
        version: None,
        actions: Vec::new(),
        error: Some("La integración experimental de LTools está desactivada en Ajustes.".into()),
    }
}

fn executable_candidates() -> &'static [&'static str] {
    if cfg!(windows) {
        // La release Windows de Tools publica `wtools-cli.exe` (asInvoker) y
        // `wtools.exe` (GUI con manifiesto requireAdministrator). La GUI no es
        // candidata: lanzarla desde una terminal no elevada falla con
        // ERROR_ELEVATION_REQUIRED y el contrato de acciones ya declara
        // `wtools-cli.exe`. Los nombres `ltools*` se conservan para builds
        // locales y versiones anteriores.
        &[
            "wtools-cli.exe",
            "ltools-cli.exe",
            "ltools.exe",
            "winslim-tools.exe",
            "ltools-cli",
            "ltools",
            "winslim-tools",
        ]
    } else {
        &[
            "ltools-cli",
            "ltools",
            "winslim-tools",
            "ltools-cli.exe",
            "ltools.exe",
            "winslim-tools.exe",
        ]
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    let executable = std::fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false);
    #[cfg(not(unix))]
    let executable = true;
    executable
}

fn is_supported_filename(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if executable_candidates()
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
    {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    if cfg!(windows) {
        lower.starts_with("ltools-") && lower.contains("-windows-") && lower.ends_with(".exe")
    } else {
        lower.starts_with("ltools-") && lower.contains("-linux-") && lower.ends_with(".appimage")
    }
}

fn add_directory_candidates(directory: &Path, output: &mut Vec<PathBuf>) {
    if !directory.is_dir() {
        return;
    }
    for candidate in executable_candidates() {
        let path = directory.join(candidate);
        if is_executable_file(&path) && !output.contains(&path) {
            output.push(path);
        }
    }
    // Las releases de Tools llevan versión y plataforma en el nombre. Solo se
    // inspecciona el contenido directo de carpetas candidatas; nunca se hace
    // un escaneo recursivo del HOME ni se ejecutan archivos desconocidos.
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_supported_filename(&path) && is_executable_file(&path) && !output.contains(&path) {
            output.push(path);
        }
    }
}

fn release_directory_name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && (name.eq_ignore_ascii_case("latest")
            || name.starts_with('v')
            || name.starts_with('V')
            || name
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit()))
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_+".contains(character))
}

/// `projects_download_release` guarda cada adjunto en una carpeta cuyo nombre
/// es el tag de la release. Solo se inspecciona el primer nivel de los dos
/// almacenes conocidos y se limita el número de entradas; nunca se convierte
/// el descubrimiento en un recorrido recursivo del HOME.
fn versioned_release_directories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(MAX_RELEASE_DIRECTORIES)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            (path.is_dir() && release_directory_name_is_safe(name)).then_some(path)
        })
        .collect()
}

fn configured_release_root(projects_folder: &str) -> PathBuf {
    PathBuf::from(projects_folder)
        .join("_releases")
        .join("Darkeiser003")
        .join("Tools")
}

fn discovery_directories() -> Vec<PathBuf> {
    let home = crate::paths::home_dir();
    let mut roots = Vec::new();
    let mut add = |path: PathBuf| {
        if !roots.contains(&path) {
            roots.push(path);
        }
    };

    // Permite instalaciones explícitas sin obligar al usuario a modificar el
    // PATH de la aplicación (especialmente útil al abrir un AppImage desde el
    // explorador de archivos).
    if let Some(path) = std::env::var_os("LTOOLS_PATH") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            add(path);
        } else if let Some(parent) = path.parent() {
            add(parent.to_path_buf());
        }
    }
    if let Some(path) = std::env::var_os("LTOOLS_HOME") {
        add(PathBuf::from(path));
    }

    // Instalador NSIS de WTools (`$PROGRAMFILES64\WTools`).
    #[cfg(windows)]
    if let Some(program_files) =
        std::env::var_os("ProgramW6432").or_else(|| std::env::var_os("ProgramFiles"))
    {
        add(PathBuf::from(program_files).join("WTools"));
    }
    add(home.join(".local/bin"));
    add(home.join(".local/share/ltools"));
    add(home.join("bin"));
    add(crate::paths::documents_dir().join("LTerminal Projects/Darkeiser003/Tools"));
    add(crate::paths::documents_dir().join("WTerminal Projects/Darkeiser003/Tools"));
    // Compatibilidad con instalaciones anteriores a la marca WTerminal.
    add(crate::paths::documents_dir().join("WinSlim Projects/Darkeiser003/Tools"));
    // `projects_download_release` guarda los adjuntos en `_releases` para no
    // mezclar descargas con clones. Esa carpeta también es una instalación
    // válida: si el usuario pulsa «Obtener LTools», el siguiente escaneo debe
    // encontrar el CLI sin exigir que copie archivos a mano a ~/.local/bin.
    add(crate::paths::documents_dir().join("LTerminal Projects/_releases/Darkeiser003/Tools"));
    add(crate::paths::documents_dir().join("WTerminal Projects/_releases/Darkeiser003/Tools"));
    add(crate::paths::documents_dir().join("WinSlim Projects/_releases/Darkeiser003/Tools"));
    for release_root in [
        crate::paths::documents_dir().join("LTerminal Projects/_releases/Darkeiser003/Tools"),
        crate::paths::documents_dir().join("WTerminal Projects/_releases/Darkeiser003/Tools"),
        crate::paths::documents_dir().join("WinSlim Projects/_releases/Darkeiser003/Tools"),
        // Las descargas de releases respetan la carpeta de proyectos elegida
        // por el usuario. Sin esta ruta, el archivo sí se bajaba, pero el
        // catálogo seguía mostrando «LTools no está instalado» cuando esa
        // carpeta se encontraba fuera de Documentos.
        configured_release_root(&crate::projects::github::projects_folder()),
    ] {
        for release_directory in versioned_release_directories(&release_root) {
            add(release_directory);
        }
    }
    for directory in [
        dirs::download_dir(),
        dirs::desktop_dir(),
        Some(crate::paths::documents_dir()),
    ]
    .into_iter()
    .flatten()
    {
        add(directory.join("Tools"));
        add(directory.join("LTools"));
        add(directory.join("WTools"));
        // «Download ZIP» de GitHub descomprime el repositorio como
        // `Tools-main`; su `release/WTools-<versión>` es una copia válida.
        add(directory.join("Tools-main"));
        add(directory.join("Tools").join("Tools-main"));
    }

    // Si se ejecuta desde un checkout o desde una carpeta de releases, se
    // consideran sus ancestros cercanos y el hermano `Tools`, sin recorrer
    // directorios ajenos de forma ilimitada.
    if let Ok(current) = std::env::current_dir() {
        let mut ancestor = Some(current.as_path());
        for _ in 0..4 {
            let Some(directory) = ancestor else { break };
            add(directory.to_path_buf());
            add(directory.join("Tools"));
            ancestor = directory.parent();
        }
    }

    let mut expanded = Vec::new();
    for root in roots {
        for suffix in ["", "release", "dist", "bin", "rust/target/release"] {
            let directory = if suffix.is_empty() {
                root.clone()
            } else {
                root.join(suffix)
            };
            if !expanded.contains(&directory) {
                expanded.push(directory.clone());
            }
            // El ZIP portable de Windows se descomprime como `WTools-<versión>`.
            for portable in portable_windows_directories(&directory) {
                if !expanded.contains(&portable) {
                    expanded.push(portable);
                }
            }
        }
    }
    expanded
}

fn portable_windows_directory_name_is_safe(name: &str) -> bool {
    name.len() <= 64
        && name
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("wtools-"))
        && name[7..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_+".contains(character))
}

/// Solo el primer nivel y con el mismo límite que las releases descargadas.
fn portable_windows_directories(root: &Path) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    // Se filtra por nombre antes de limitar: en carpetas con muchos archivos
    // (Descargas, Escritorio) `WTools-<versión>` no tiene por qué estar entre
    // las primeras entradas.
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            (portable_windows_directory_name_is_safe(name) && path.is_dir()).then_some(path)
        })
        .take(MAX_RELEASE_DIRECTORIES)
        .collect()
}

/// Un AppImage CLI se prefiere a la variante GUI cuando ambas existen. Solo
/// cuenta el nombre del archivo: una carpeta como `my-client` no debe
/// adelantar una GUI.
fn cli_rank(path: &Path) -> u8 {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.contains("-cli") {
        0
    } else {
        1
    }
}

/// Orden de preferencia: `LTOOLS_PATH` (elección explícita), después el
/// PATH y, por último, las copias encontradas en las carpetas conocidas. En
/// ese último grupo gana la más reciente: al actualizar Tools suele quedar
/// una copia antigua en otra carpeta (una release descargada antes), y la
/// Biblioteca debe mostrar el catálogo nuevo, no el de esa copia.
fn order_candidates(
    explicit: Option<PathBuf>,
    on_path: Vec<PathBuf>,
    discovered: Vec<(PathBuf, Option<std::time::SystemTime>)>,
) -> Vec<PathBuf> {
    let mut on_path = on_path;
    on_path.sort_by_key(|path| cli_rank(path));
    let mut discovered = discovered;
    discovered.sort_by(|(left, left_time), (right, right_time)| {
        cli_rank(left)
            .cmp(&cli_rank(right))
            .then_with(|| right_time.cmp(left_time))
    });
    let mut result = Vec::new();
    for path in explicit
        .into_iter()
        .chain(on_path)
        .chain(discovered.into_iter().map(|(path, _)| path))
    {
        if !result.contains(&path) {
            result.push(path);
        }
    }
    result
}

fn find_executables() -> Vec<PathBuf> {
    let explicit = std::env::var_os("LTOOLS_PATH")
        .map(PathBuf::from)
        .filter(|path| is_executable_file(path));
    let on_path = executable_candidates()
        .iter()
        .filter_map(|candidate| crate::path_env::which(candidate))
        .collect();
    let mut discovered = Vec::new();
    for directory in discovery_directories() {
        add_directory_candidates(&directory, &mut discovered);
    }
    let discovered = discovered
        .into_iter()
        .map(|path| {
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok();
            (path, modified)
        })
        .collect();
    order_candidates(explicit, on_path, discovered)
}

fn text_is_safe(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && !value.chars().any(|character| character.is_control())
}

fn id_is_safe(value: &str) -> bool {
    text_is_safe(value, MAX_ID)
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || ".-_".contains(character)
        })
}

fn executable_name_is_safe(value: &str) -> bool {
    if executable_candidates()
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
    {
        return true;
    }
    Path::new(value)
        .file_name()
        .map(Path::new)
        .map(is_supported_filename)
        .unwrap_or(false)
}

fn action_is_safe(action: &LToolsAction) -> bool {
    id_is_safe(&action.id)
        && text_is_safe(&action.label, 240)
        && text_is_safe(&action.group, 160)
        && text_is_safe(&action.description, MAX_TEXT)
        && text_is_safe(&action.command, MAX_TEXT)
        && action
            .short_label
            .as_deref()
            .map_or(true, |value| text_is_safe(value, 240))
        && text_is_safe(&action.profile, 160)
        && action
            .command
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
        && executable_name_is_safe(&action.executable)
        && action.args.len() <= MAX_ARGUMENTS
        && action
            .args
            .iter()
            .all(|argument| text_is_safe(argument, MAX_ARGUMENT))
        && action.aliases.len() <= MAX_ARGUMENTS
        && action
            .aliases
            .iter()
            .all(|alias| text_is_safe(alias, MAX_ARGUMENT))
        && action.supports.len() <= MAX_ARGUMENTS
        && action
            .supports
            .iter()
            .all(|support| text_is_safe(support, MAX_ARGUMENT))
        && action.shell == "none"
        && action.working_directory == "current"
        && action.terminal
        && action.target == "none"
        && action.target_policy == "none"
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLToolsAction {
    id: String,
    #[serde(default)]
    action_key: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    operation: Option<String>,
    category: String,
    #[serde(default)]
    group: Option<String>,
    command: String,
    args: Vec<String>,
    target: String,
    target_policy: String,
    mutating: bool,
    confirmation: String,
    profile: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    supports: Vec<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    short_label: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    quick: bool,
}

fn humanize_label(value: &str) -> String {
    let normalized = value.replace(['-', '_'], " ");
    let mut chars = normalized.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Acción".into(),
    }
}

fn human_label(id: &str) -> String {
    match id.rsplit_once('.') {
        Some((scope, verb)) => {
            let scope_label = scope
                .split('.')
                .map(humanize_label)
                .collect::<Vec<_>>()
                .join(" · ");
            format!("{} · {}", scope_label, humanize_label(verb))
        }
        None => humanize_label(id),
    }
}

fn optional_safe_text(value: Option<String>, limit: usize) -> Option<String> {
    value.filter(|value| text_is_safe(value, limit))
}

fn parse_actions(output: &[u8], executable: &str) -> Result<Vec<LToolsAction>, String> {
    let value: Value = serde_json::from_slice(output)
        .map_err(|error| format!("LTools devolvió JSON no válido: {error}"))?;
    if value.get("schema").and_then(Value::as_str) != Some(ACTIONS_SCHEMA) {
        return Err("LTools devolvió un catálogo incompatible o sin versión.".into());
    }
    let expected_platform = if cfg!(windows) { "windows" } else { "linux" };
    if value.get("platform").and_then(Value::as_str) != Some(expected_platform) {
        return Err("LTools publicó acciones de otra plataforma.".into());
    }
    let raw_actions = value
        .get("actions")
        .and_then(Value::as_array)
        .ok_or("El catálogo de LTools no contiene una lista de acciones.")?;

    // Tools evoluciona aparte: una acción con una forma que esta versión no
    // entiende se descarta sola, igual que una insegura, en vez de dejar sin
    // botones todas las demás.
    let mut seen = HashSet::new();
    let mut actions = Vec::with_capacity(raw_actions.len().min(MAX_ACTIONS));
    let mut malformed = 0usize;
    for raw in raw_actions {
        if actions.len() >= MAX_ACTIONS {
            break;
        }
        let Ok(raw) = serde_json::from_value::<RawLToolsAction>(raw.clone()) else {
            malformed += 1;
            continue;
        };
        let fallback_label = human_label(&raw.id);
        let action_key =
            optional_safe_text(raw.action_key, MAX_ID).unwrap_or_else(|| raw.id.clone());
        let scope = optional_safe_text(raw.scope, MAX_ID).unwrap_or_else(|| raw.category.clone());
        let operation =
            optional_safe_text(raw.operation, MAX_ID).unwrap_or_else(|| raw.id.replace('.', "-"));
        let group = optional_safe_text(raw.group, 240).unwrap_or_else(|| scope.clone());
        let label = optional_safe_text(raw.label, 240).unwrap_or_else(|| fallback_label.clone());
        let short_label = optional_safe_text(raw.short_label, 240).or_else(|| Some(label.clone()));
        let description = optional_safe_text(raw.description, MAX_TEXT).unwrap_or_else(|| {
            format!(
                "Acción {} de LTools (perfil {}; objetivo: ninguno).",
                if raw.mutating {
                    "modificadora"
                } else {
                    "de consulta"
                },
                raw.profile
            )
        });
        let action = LToolsAction {
            id: raw.id.clone(),
            action_key,
            scope,
            operation,
            label,
            short_label,
            group,
            description,
            command: raw.command,
            executable: executable.to_string(),
            args: raw.args,
            aliases: raw.aliases,
            shell: "none".into(),
            working_directory: "current".into(),
            terminal: true,
            interactive: false,
            requires_admin: false,
            confirmation: raw.confirmation,
            safe: !raw.mutating,
            supports: raw.supports,
            target: raw.target,
            target_policy: raw.target_policy,
            mutating: raw.mutating,
            profile: raw.profile,
            requirements_available: true,
            quick: raw.quick,
        };
        if !action_is_safe(&action) || !seen.insert(action.id.clone()) {
            continue;
        }
        actions.push(action);
    }
    if malformed > 0 || raw_actions.len() > MAX_ACTIONS {
        crate::log_info!(
            "Catálogo de LTools leído con acciones omitidas",
            serde_json::json!({
                "published": raw_actions.len(),
                "accepted": actions.len(),
                "malformed": malformed,
                "limit": MAX_ACTIONS,
            })
        );
    }
    if actions.is_empty() {
        return Err(
            "El catálogo de LTools no contiene acciones compatibles con esta terminal.".into(),
        );
    }
    Ok(actions)
}

fn version_for(executable: &str) -> Option<String> {
    run_ltools_command(executable, &["--version"], Duration::from_secs(2))
        .filter(|output| output.status.success())
        .and_then(|output| {
            let bytes = if output.stdout.is_empty() {
                output.stderr
            } else {
                output.stdout
            };
            String::from_utf8(bytes)
                .ok()
                .map(|value| value.chars().take(MAX_VERSION_BYTES).collect::<String>())
        })
        .map(|value| value.lines().next().unwrap_or_default().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn run_ltools_command(
    executable: &str,
    args: &[&str],
    timeout: Duration,
) -> Option<std::process::Output> {
    if Path::new(executable)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("appimage"))
    {
        // AppImage no siempre puede montar FUSE en equipos mínimos. Esta es
        // la ruta oficial de extracción temporal y conserva el mismo CLI.
        return crate::process::run_with_timeout_env(
            executable,
            args,
            timeout,
            &[("APPIMAGE_EXTRACT_AND_RUN", "1")],
        );
    }
    crate::process::run_with_timeout(executable, args, timeout)
}

fn run_ltools_command_owned(
    executable: &str,
    args: &[String],
    timeout: Duration,
) -> Option<std::process::Output> {
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_ltools_command(executable, &borrowed, timeout)
}

fn list_actions(language: Option<&str>) -> LToolsActionList {
    let candidates = find_executables();
    if candidates.is_empty() {
        return LToolsActionList {
            available: false,
            executable: None,
            version: None,
            actions: Vec::new(),
            error: None,
        };
    };
    let first = candidates[0].to_string_lossy().into_owned();
    let mut last_error = "LTools terminó con un error al consultar sus acciones.".to_string();
    for path in candidates {
        let executable = path.to_string_lossy().into_owned();
        let mut args = vec![
            "actions".to_string(),
            "list".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        if let Some(language) = language.filter(|value| SUPPORTED_LANGUAGES.contains(value)) {
            args.splice(0..0, ["--lang".to_string(), language.to_string()]);
        }
        let Some(output) = run_ltools_command_owned(&executable, &args, CATALOG_TIMEOUT) else {
            last_error = "LTools no respondió dentro del tiempo permitido.".into();
            continue;
        };
        if !output.status.success() {
            last_error = "LTools terminó con un error al consultar sus acciones.".into();
            continue;
        }
        if output.stdout.len() > MAX_CATALOG_BYTES {
            last_error = "El catálogo de LTools supera el tamaño permitido.".into();
            continue;
        }
        match parse_actions(&output.stdout, &executable) {
            Ok(actions) => {
                return LToolsActionList {
                    available: true,
                    executable: Some(executable.clone()),
                    version: version_for(&executable),
                    actions,
                    error: None,
                }
            }
            Err(error) => last_error = error,
        }
    }
    LToolsActionList {
        available: true,
        executable: Some(first),
        version: None,
        actions: Vec::new(),
        error: Some(last_error),
    }
}

#[tauri::command(async)]
pub fn ltools_actions_list(language: Option<String>) -> LToolsActionList {
    if !crate::preferences::current().ltools_enabled {
        return disabled_catalog();
    }
    list_actions(language.as_deref())
}

fn quote_for_shell(value: &str, kind: ShellKind) -> String {
    let simple = value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_./:-=@%+".contains(character));
    if simple {
        return value.to_string();
    }
    if kind == ShellKind::Cmd {
        format!("\"{}\"", value.replace('\"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn command_for_action(action: &LToolsAction, executable: &str, kind: ShellKind) -> String {
    let appimage_extract_prefix = if cfg!(unix)
        && matches!(
            kind,
            ShellKind::Bash | ShellKind::Zsh | ShellKind::Fish | ShellKind::Sh
        )
        && Path::new(executable)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("appimage"))
    {
        Some("APPIMAGE_EXTRACT_AND_RUN=1")
    } else {
        None
    };

    let mut parts = Vec::with_capacity(5);
    if let Some(prefix) = appimage_extract_prefix {
        parts.push(prefix.to_string());
    }
    parts.push(quote_for_shell(executable, kind));
    parts.extend(["actions", "run"].into_iter().map(str::to_string));
    parts.push(quote_for_shell(&action.id, kind));
    parts.join(" ")
}

#[tauri::command(async)]
pub fn ltools_action_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    action_id: String,
) -> LToolsRunResult {
    if !crate::preferences::current().ltools_enabled {
        return failed("La integración experimental de LTools está desactivada en Ajustes.");
    }
    if action_id.len() > MAX_ID || !id_is_safe(&action_id) {
        return failed("Identificador de acción no válido.");
    }
    if !state.tabs.has_session(&tab_id) {
        return failed("La pestaña ya no está disponible.");
    }
    let catalog = list_actions(None);
    let Some(executable) = catalog.executable else {
        return failed("LTools no está instalado. Puedes obtenerlo desde Proyectos.");
    };
    let Some(action) = catalog
        .actions
        .into_iter()
        .find(|action| action.id == action_id)
    else {
        return failed("La acción ya no está disponible; refresca la Biblioteca.");
    };
    if !action.requirements_available {
        return failed("Falta una dependencia del anfitrión para esta acción.");
    }
    let Some((target_tab, environment, created)) = shell_tab(&app, &state, &tab_id) else {
        return failed("No hay una shell disponible para ejecutar esta acción.");
    };
    let command = command_for_action(&action, &executable, environment.kind);
    if !state.tabs.write_command(&target_tab, &command) {
        return failed("No se pudo escribir en la terminal activa.");
    }
    LToolsRunResult {
        ok: true,
        error: None,
        action_id: Some(action.id),
        tab_id: Some(target_tab),
        created,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(action: Value) -> Vec<LToolsAction> {
        parse_actions(
            serde_json::to_vec(&serde_json::json!({
                "schema": ACTIONS_SCHEMA,
                "platform": if cfg!(windows) { "windows" } else { "linux" },
                "actions": [action]
            }))
            .unwrap()
            .as_slice(),
            "ltools",
        )
        .unwrap()
    }

    #[test]
    fn solo_acepta_el_esquema_y_el_ejecutable_conocidos() {
        let actions = catalog(serde_json::json!({
            "id":"audit.quick", "category":"audit", "command":"audit",
            "args":["--no-mounts"], "target":"none", "targetPolicy":"none",
            "mutating":false, "confirmation":"none", "profile":"safe-default",
            "aliases":[], "supports":["dry-run", "plan"]
        }));
        assert_eq!(actions.len(), 1);
        assert!(actions[0].requirements_available);
    }

    #[test]
    fn conserva_metadatos_de_presentacion_y_preferencia_del_catalogo() {
        let actions = catalog(serde_json::json!({
            "id":"native.network-status", "category":"native",
            "actionKey":"native.network.status", "scope":"native", "operation":"native-network-status", "group":"Red",
            "command":"native", "args":[], "target":"none",
            "targetPolicy":"none", "mutating":false, "confirmation":"none",
            "profile":"safe-default", "label":"Estado de red",
            "shortLabel":"Red", "description":"Consulta la red del equipo.",
            "quick":true
        }));
        assert_eq!(actions[0].action_key, "native.network.status");
        assert_eq!(actions[0].scope, "native");
        assert_eq!(actions[0].operation, "native-network-status");
        assert_eq!(actions[0].group, "Red");
        assert_eq!(actions[0].label, "Estado de red");
        assert_eq!(actions[0].short_label.as_deref(), Some("Red"));
        assert_eq!(actions[0].description, "Consulta la red del equipo.");
        assert!(actions[0].quick);
    }

    #[test]
    fn el_fallback_de_etiqueta_conserva_el_ambito_para_evitar_duplicados() {
        assert_eq!(human_label("packages.inventory"), "Packages · Inventory");
        assert_eq!(human_label("games.inventory"), "Games · Inventory");
        assert_eq!(
            human_label("native.security-status"),
            "Native · Security status"
        );
        assert_eq!(
            human_label("system.packages.inventory"),
            "System · Packages · Inventory"
        );
    }

    #[test]
    fn usa_fallbacks_si_los_metadatos_opcionales_no_son_utilizables() {
        let actions = catalog(serde_json::json!({
            "id":"audit.quick", "category":"audit", "command":"audit",
            "args":[], "target":"none", "targetPolicy":"none",
            "mutating":false, "confirmation":"none", "profile":"safe-default",
            "label":"texto\nno seguro", "shortLabel":"", "description":"\u{0001}"
        }));
        assert_eq!(actions[0].label, "Audit · Quick");
        assert_eq!(actions[0].short_label.as_deref(), Some("Audit · Quick"));
        assert!(actions[0].description.contains("Acción de consulta"));
        assert!(!actions[0].quick);
    }

    #[test]
    fn descarta_acciones_que_podrian_inyectar_otra_shell() {
        let result = parse_actions(
            &serde_json::to_vec(&serde_json::json!({
                "schema": ACTIONS_SCHEMA,
                "platform": if cfg!(windows) { "windows" } else { "linux" },
                "actions": [{
            "id":"bad", "category":"audit", "command":"sh -c evil", "args":[],
            "target":"none", "targetPolicy":"none", "mutating":false,
            "confirmation":"none", "profile":"safe-default"
                }]
            }))
            .unwrap(),
            "ltools",
        );
        assert!(result.is_err());
    }

    #[test]
    fn descarta_acciones_que_requieren_un_objetivo() {
        let result = parse_actions(
            &serde_json::to_vec(&serde_json::json!({
                "schema": ACTIONS_SCHEMA,
                "platform": if cfg!(windows) { "windows" } else { "linux" },
                "actions": [{
                    "id":"storage.mount", "category":"storage", "command":"storage",
                    "args":["mount"], "target":"path", "targetPolicy":"manual",
                    "mutating":true, "confirmation":"required", "profile":"advanced"
                }]
            }))
            .unwrap(),
            "ltools",
        );
        assert!(result.is_err());
    }

    #[test]
    fn construye_la_orden_canonica_sin_reutilizar_los_argumentos_del_catalogo() {
        let action = &catalog(serde_json::json!({
            "id":"audit.quick", "category":"audit", "command":"audit",
            "args":["--no-mounts", "texto con espacios"], "target":"none",
            "targetPolicy":"none", "mutating":false, "confirmation":"none",
            "profile":"safe-default"
        }))[0];
        assert_eq!(
            command_for_action(action, "/opt/L Tools/ltools", ShellKind::Bash),
            "'/opt/L Tools/ltools' actions run audit.quick"
        );
    }

    #[test]
    fn ejecuta_appimage_sin_requerir_fuse_en_shell_posix() {
        let action = &catalog(serde_json::json!({
            "id":"defaults.show", "category":"defaults", "command":"defaults",
            "args":[], "target":"none", "targetPolicy":"none",
            "mutating":false, "confirmation":"none", "profile":"safe-default"
        }))[0];
        let expected_fish_command = if cfg!(unix) {
            "APPIMAGE_EXTRACT_AND_RUN=1 '/opt/L Tools/ltools-1.0.0-linux-x86_64-cli.AppImage' actions run defaults.show"
        } else {
            "'/opt/L Tools/ltools-1.0.0-linux-x86_64-cli.AppImage' actions run defaults.show"
        };
        assert_eq!(
            command_for_action(
                action,
                "/opt/L Tools/ltools-1.0.0-linux-x86_64-cli.AppImage",
                ShellKind::Fish
            ),
            expected_fish_command
        );
        assert_eq!(
            command_for_action(
                action,
                "C:\\Tools\\ltools-1.0.0-windows-x86_64-cli.exe",
                ShellKind::Cmd
            ),
            "\"C:\\Tools\\ltools-1.0.0-windows-x86_64-cli.exe\" actions run defaults.show"
        );
    }

    #[test]
    fn cita_rutas_con_espacios_sin_construir_un_shell_interno() {
        assert_eq!(
            quote_for_shell("/tmp/l tools/ltools", ShellKind::Bash),
            "'/tmp/l tools/ltools'"
        );
        assert_eq!(
            quote_for_shell(r#"C:\Program Files\LTools\ltools.exe"#, ShellKind::Cmd),
            r#""C:\Program Files\LTools\ltools.exe""#
        );
    }

    fn raw_action(id: &str) -> Value {
        serde_json::json!({
            "id": id, "category": "audit", "command": "audit", "args": [],
            "target": "none", "targetPolicy": "none", "mutating": false,
            "confirmation": "none", "profile": "safe-default"
        })
    }

    fn parse_catalog(actions: Vec<Value>) -> Result<Vec<LToolsAction>, String> {
        parse_actions(
            serde_json::to_vec(&serde_json::json!({
                "schema": ACTIONS_SCHEMA,
                "platform": if cfg!(windows) { "windows" } else { "linux" },
                "actions": actions
            }))
            .unwrap()
            .as_slice(),
            "ltools",
        )
    }

    #[test]
    fn una_accion_mal_formada_no_deja_sin_las_demas() {
        // Una versión futura de Tools puede publicar una acción con una forma
        // que esta terminal no entiende (aquí, sin `args` ni `category`).
        let actions = parse_catalog(vec![
            raw_action("audit.quick"),
            serde_json::json!({ "id": "nueva.forma", "command": "nueva", "target": "none" }),
            raw_action("audit.full"),
        ])
        .unwrap();
        let ids: Vec<&str> = actions.iter().map(|action| action.id.as_str()).collect();
        assert_eq!(ids, ["audit.quick", "audit.full"]);
    }

    #[test]
    fn un_catalogo_mas_largo_que_el_tope_se_recorta_en_vez_de_rechazarse() {
        let actions = parse_catalog(
            (0..MAX_ACTIONS + 25)
                .map(|index| raw_action(&format!("audit.a{index}")))
                .collect(),
        )
        .unwrap();
        assert_eq!(actions.len(), MAX_ACTIONS);
        assert_eq!(actions[0].id, "audit.a0");
    }

    #[test]
    fn los_campos_nuevos_del_catalogo_se_ignoran() {
        // WTools 1.0.0 ya publica `legacyId`, `invocation`, `menuPath`…
        let mut action = raw_action("windows.boot.status");
        action["legacyId"] = serde_json::json!("boot.status");
        action["menuPath"] = serde_json::json!(["Arranque", "Consultar arranque"]);
        action["invocation"] = serde_json::json!({ "executable": "wtools.exe", "args": ["actions", "run", "windows.boot.status"] });
        action["campoQueAunNoExiste"] = serde_json::json!({ "x": 1 });
        assert_eq!(parse_catalog(vec![action]).unwrap().len(), 1);
    }

    #[test]
    fn prefiere_la_eleccion_explicita_el_path_y_luego_la_copia_mas_reciente() {
        let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let new = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(2_000);
        let discovered = vec![
            (
                PathBuf::from("/r/Latest/ltools-latest-windows-x86_64-cli.exe"),
                Some(old),
            ),
            (
                PathBuf::from("/d/Tools-main/release/WTools-1.0.0/wtools-cli.exe"),
                Some(new),
            ),
            (PathBuf::from("/d/Tools/ltools.exe"), Some(new)),
        ];
        let ordered = order_candidates(None, Vec::new(), discovered.clone());
        assert_eq!(
            ordered[0],
            PathBuf::from("/d/Tools-main/release/WTools-1.0.0/wtools-cli.exe"),
            "la copia actualizada gana a una release antigua"
        );
        assert_eq!(
            ordered[2],
            PathBuf::from("/d/Tools/ltools.exe"),
            "la GUI va al final"
        );
        let ordered = order_candidates(
            Some(PathBuf::from("/x/elegido-cli.exe")),
            vec![PathBuf::from("/p/wtools-cli.exe")],
            discovered,
        );
        assert_eq!(ordered[0], PathBuf::from("/x/elegido-cli.exe"));
        assert_eq!(ordered[1], PathBuf::from("/p/wtools-cli.exe"));
        assert_eq!(ordered.len(), 5);
    }

    #[test]
    fn rechaza_un_catalogo_de_otra_plataforma() {
        let platform = if cfg!(windows) { "linux" } else { "windows" };
        let result = parse_actions(
            serde_json::to_vec(&serde_json::json!({
                "schema": ACTIONS_SCHEMA,
                "platform": platform,
                "actions": []
            }))
            .unwrap()
            .as_slice(),
            "ltools",
        );
        assert!(result.is_err());
    }

    #[test]
    fn reconoce_nombres_de_releases_locales_sin_aceptar_archivos_ajenos() {
        let linux_cli = Path::new("ltools-1.0.0-linux-x86_64-cli.AppImage");
        let linux_gui = Path::new("ltools-1.0.0-linux-x86_64.AppImage");
        let unrelated = Path::new("terminal-1.0.0-x86_64.AppImage");
        if cfg!(windows) {
            assert!(!is_supported_filename(linux_cli));
            assert!(!is_supported_filename(linux_gui));
        } else {
            assert!(is_supported_filename(linux_cli));
            assert!(is_supported_filename(linux_gui));
            assert!(!is_supported_filename(unrelated));
        }
    }

    #[test]
    fn acepta_el_ejecutable_versionado_que_se_ha_encontrado_en_disco() {
        let executable = if cfg!(windows) {
            r"C:\Tools\ltools-1.0.0-windows-x86_64-cli.exe"
        } else {
            "/home/ana/Tools/ltools-1.0.0-linux-x86_64-cli.AppImage"
        };
        assert!(executable_name_is_safe(executable));
    }

    #[cfg(windows)]
    #[test]
    fn reconoce_los_ejecutables_publicados_de_wtools() {
        assert_eq!(executable_candidates()[0], "wtools-cli.exe");
        // La GUI exige elevación; nunca se usa para consultar el catálogo.
        assert!(!executable_name_is_safe("wtools.exe"));
        assert!(executable_name_is_safe(
            r"C:\Program Files\WTools\wtools-cli.exe"
        ));
        assert!(portable_windows_directory_name_is_safe("WTools-1.0.0"));
        assert!(!portable_windows_directory_name_is_safe(
            "WTools-1.0.0-x64-setup.exe/.."
        ));
        assert!(!portable_windows_directory_name_is_safe("WTools-latest"));
    }

    #[test]
    fn las_rutas_de_tools_se_expanden_sin_recurrir_al_home_completo() {
        let directories = discovery_directories();
        assert!(directories.iter().any(|path| path.ends_with(".local/bin")));
        assert!(directories
            .iter()
            .all(|path| path.components().count() < 32));
    }

    #[test]
    fn encuentra_releases_bajo_la_carpeta_de_proyectos_personalizada() {
        let root = Path::new("/tmp/proyectos-personalizados");
        assert_eq!(
            configured_release_root(root.to_str().unwrap()),
            root.join("_releases/Darkeiser003/Tools")
        );
    }

    #[test]
    fn reconoce_el_directorio_de_tag_de_una_release_descargada() {
        let root = std::env::temp_dir().join(format!(
            "lterminal-ltools-release-discovery-{}",
            std::process::id()
        ));
        let tagged = root.join("v1.0.0");
        let latest = root.join("Latest");
        let unrelated = root.join("cache");
        std::fs::create_dir_all(&tagged).unwrap();
        std::fs::create_dir_all(&latest).unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();
        let found = versioned_release_directories(&root);
        assert!(found.contains(&tagged));
        assert!(found.contains(&latest));
        assert!(!found.contains(&unrelated));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn acepta_tags_de_release_con_v_mayuscula() {
        assert!(release_directory_name_is_safe("V1.0.0"));
        assert!(release_directory_name_is_safe("Latest"));
        assert!(!release_directory_name_is_safe("../outside"));
    }

    #[test]
    fn solo_activa_extraccion_para_un_appimage() {
        assert!(Path::new("ltools-1.0.0-linux-x86_64-cli.AppImage")
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("appimage")));
        assert!(!Path::new("ltools-1.0.0-windows-x86_64-cli.exe")
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("appimage")));
    }
}
