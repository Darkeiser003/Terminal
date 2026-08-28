//! Los comandos que el frontend puede invocar.
//!
//! Sustituyen a los canales `ipcMain.handle` / `ipcMain.on` de la versión
//! Electron. La correspondencia es uno a uno y está anotada en cada comando,
//! para poder cotejarlos con `electron/preload.js` mientras dure la migración.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use crate::environments::Environment;
use crate::preferences::{
    self, FontFamily, Preferences, ThemePreset, FONT_FAMILIES, THEME_PRESETS,
};
use crate::state::AppState;
use crate::tabs::{TabList, TabSummary, MAX_PTY_INPUT_CHARS};
use crate::{i18n, identity, logger, settings};

static SMOKE_EXIT_SCHEDULED: AtomicBool = AtomicBool::new(false);

// ---- Pestañas (`tabs:*`) ----

/// `tabs:list`
#[tauri::command]
pub fn tabs_list(state: State<'_, Arc<AppState>>) -> TabList {
    state.tabs.list()
}

/// `tabs:create`. `env_id` vacío = el entorno por defecto.
#[tauri::command(async)]
pub fn tabs_create(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    env_id: Option<String>,
    pane_count: Option<i64>,
) -> Option<TabSummary> {
    let env = match env_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => state.environment_by_id(id)?,
        None => state.default_environment()?,
    };
    // La pestaña nueva hereda el directorio de la que estaba en uso: abrir WSL
    // desde un cmd situado en C:\proyecto empieza en /mnt/c/proyecto.
    let inherited = state.tabs.active_cwd();
    let pane_count = pane_count
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| (2..=4).contains(value))
        .unwrap_or(1);
    Some(
        state
            .tabs
            .create_tab_with_panes(&app, &env, inherited.as_deref(), pane_count),
    )
}

/// `tabs:close`
#[tauri::command(async)]
pub fn tabs_close(app: AppHandle, state: State<'_, Arc<AppState>>, tab_id: String) {
    state.tabs.close_tab(&app, &tab_id, "petición del usuario");
}

/// `tabs:activate`
#[tauri::command]
pub fn tabs_activate(state: State<'_, Arc<AppState>>, tab_id: String) {
    state.tabs.activate(&tab_id);
}

/// `tabs:ready`
#[tauri::command]
pub fn tabs_ready(app: AppHandle, state: State<'_, Arc<AppState>>, tab_id: String) {
    state.tabs.mark_ready(&app, &tab_id);
    state
        .tabs
        .refresh_banner_when_system_info_ready(&app, &tab_id);
    // La detección completa habla con WSL, Docker y adb. Se inicia únicamente
    // cuando xterm ya puede recibir y pintar la salida de la primera pestaña,
    // para que esas sondas no compitan con el camino crítico del arranque.
    // `AppState` garantiza que las pestañas siguientes no la repitan.
    state.start_full_detection(&app);
}

/// Confirma que el JavaScript cargó, creó un xterm y completó su primer IPC.
/// La build usa el token de entorno para distinguir este arranque de logs
/// antiguos: que el proceso siga vivo no demuestra que la interfaz funcione.
#[tauri::command]
pub fn frontend_ready(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
) -> Result<(), String> {
    let smoke_token = std::env::var("LTERMINAL_SMOKE_TOKEN").ok();
    if !state.tabs.has_session(&tab_id) {
        // Montar xterm no demuestra que la shell ni el PTY hayan arrancado.
        // En particular, un ConPTY/DLL roto podía dejar el frontend visible y
        // hacer que el build creyera que el smoke había pasado.
        log_error!(
            "Frontend preparado pero sin sesión PTY",
            serde_json::json!({ "tabId": tab_id, "smokeToken": smoke_token })
        );
        return Err("La sesión PTY no está disponible todavía".into());
    }
    log_info!(
        "Frontend y terminal preparados",
        serde_json::json!({ "tabId": tab_id, "smokeToken": smoke_token })
    );
    // El build de Windows arranca una instancia temporal. Cerrar el proceso
    // desde PowerShell con TerminateProcess mientras el hijo aún está
    // conectando al ConPTY provoca precisamente el diálogo 0xc0000142 que
    // aparenta ser una DLL rota. Pedimos una salida normal, que pasa por
    // `tabs.shutdown()` y suelta primero la shell y el pseudoterminal.
    if std::env::var("LTERMINAL_SMOKE_AUTO_EXIT").as_deref() == Ok("1")
        && !SMOKE_EXIT_SCHEDULED.swap(true, Ordering::AcqRel)
    {
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("smoke-graceful-exit".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                app.exit(0);
            });
    }
    Ok(())
}

// ---- pty (`pty-*`) ----

/// `pty-input`
#[tauri::command]
pub fn pty_input(state: State<'_, Arc<AppState>>, tab_id: String, data: String) {
    if data.len() > MAX_PTY_INPUT_CHARS {
        return;
    }
    state.tabs.note_user_input(&tab_id, &data);
    state.tabs.write(&tab_id, &data);
}

#[tauri::command]
pub fn internal_command_parse(
    line: String,
) -> Option<crate::terminal::internal_commands::InternalCommand> {
    crate::terminal::internal_commands::parse(&line)
}

/// `pty-resize`
#[tauri::command]
pub fn pty_resize(state: State<'_, Arc<AppState>>, tab_id: String, cols: i64, rows: i64) {
    let Some(viewport) = crate::tabs::valid_viewport(cols, rows) else {
        return;
    };
    state.tabs.resize(&tab_id, viewport.cols, viewport.rows);
}

/// Redibuja la cabecera informativa sin enviar ningún comando a la shell.
///
/// El banner se generó antes de que xterm pudiera medir el panel. Después de
/// dividir o redimensionar la ventana hay que volver a calcular sus anchos,
/// pero hacerlo escribiendo en el PTY alteraría la entrada que el usuario esté
/// editando. `TabManager` lo entrega como salida visual y conserva el cursor.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_refresh_banner(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    cols: i64,
    rows: i64,
    pane_count: i64,
    cursor_row: Option<i64>,
    cursor_col: Option<i64>,
) -> bool {
    let Some(viewport) = crate::tabs::valid_viewport(cols, rows) else {
        return false;
    };
    let started = Instant::now();
    let applied = state.tabs.refresh_banner(
        &app,
        &tab_id,
        viewport.cols,
        viewport.rows,
        pane_count.max(1) as usize,
        cursor_row.and_then(|row| u16::try_from(row).ok()),
        cursor_col.and_then(|col| u16::try_from(col).ok()),
    );
    log_info!(
        "Repintado de banner solicitado",
        serde_json::json!({
            "tabId": tab_id,
            "cols": viewport.cols,
            "rows": viewport.rows,
            "paneCount": pane_count.max(1),
            "durationMs": started.elapsed().as_millis(),
        })
    );
    applied
}

// ---- Entornos (`env:*`) ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentList {
    pub envs: Vec<Environment>,
    pub active_env_id: Option<String>,
}

/// `env:list`. Devuelve inmediatamente lo detectado hasta ahora. La detección
/// completa empieza desde `tabs:ready`, cuando la primera terminal ya puede
/// pintar, y su resultado llega después por `envs-updated`.
#[tauri::command(async)]
pub fn env_list(state: State<'_, Arc<AppState>>, tab_id: Option<String>) -> EnvironmentList {
    let envs = state.environments();
    EnvironmentList {
        active_env_id: active_env_id(&state, tab_id.as_deref()),
        envs,
    }
}

/// `env:refresh`
#[tauri::command(async)]
pub fn env_refresh(state: State<'_, Arc<AppState>>, tab_id: Option<String>) -> EnvironmentList {
    let envs = state.refresh_environments().envs;
    EnvironmentList {
        active_env_id: active_env_id(&state, tab_id.as_deref()),
        envs,
    }
}

fn active_env_id(state: &AppState, tab_id: Option<&str>) -> Option<String> {
    let target = tab_id
        .map(str::to_string)
        .or_else(|| state.tabs.active_tab_id())?;
    state
        .tabs
        .list()
        .tabs
        .into_iter()
        .find(|tab| tab.id == target)
        .and_then(|tab| tab.env_id)
}

/// `env:switch`: reemplaza la shell de una pestaña sin cerrarla.
#[tauri::command(async)]
pub fn env_switch(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    env_id: String,
) -> bool {
    let Some(env) = state.environment_by_id(&env_id) else {
        return false;
    };
    // Un entorno marcado como no disponible (un móvil sin autorizar, por
    // ejemplo) no se abre: `adb shell` fallaría al instante y la pestaña se
    // quedaría con una sesión muerta.
    if !env.available || !state.tabs.exists(&tab_id) {
        return false;
    }
    // La sesión nueva empieza donde estaba ESTA pestaña. `active_cwd()` puede
    // pertenecer a otra si el usuario cambió el selector mientras había varias
    // pestañas visibles, y entonces la shell nueva caía en el home.
    let inherited = state.tabs.cwd_of(&tab_id);
    state.tabs.clear_view(&app, &tab_id);
    let ok = state
        .tabs
        .spawn_pty(&app, &tab_id, &env, inherited.as_deref());
    if ok {
        log_info!(
            "Entorno cambiado",
            serde_json::json!({ "tabId": tab_id, "envId": env_id })
        );
        // El frontend afina el nombre de la pestaña con la etiqueta real que
        // devuelve el backend.
        let _ = app.emit(
            "env-changed",
            crate::tabs::EnvChangedEvent {
                tab_id,
                id: env.id.clone(),
                label: env.label.clone(),
            },
        );
    }
    ok
}

// ---- Preferencias (`settings:*`) ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesPayload {
    pub preferences: Preferences,
    pub defaults: Preferences,
    pub themes: &'static Vec<ThemePreset>,
    pub fonts: &'static Vec<FontFamily>,
    pub languages: &'static Vec<i18n::Language>,
    pub catalog: i18n::CatalogPayload,
}

fn payload_for(prefs: Preferences) -> PreferencesPayload {
    let language = i18n::resolve_language(&prefs.language, &i18n::system_locale());
    PreferencesPayload {
        catalog: i18n::catalog_for(&language),
        preferences: prefs,
        defaults: Preferences::default(),
        themes: &THEME_PRESETS,
        fonts: &FONT_FAMILIES,
        languages: &i18n::LANGUAGES,
    }
}

/// `settings:get`
#[tauri::command]
pub fn settings_get() -> PreferencesPayload {
    payload_for(preferences::current())
}

/// `settings:save`. Lo que llegue se valida antes de guardarlo: el frontend no
/// puede escribir valores fuera de rango ni claves desconocidas.
#[tauri::command(async)]
pub fn settings_save(incoming: Value) -> Result<PreferencesPayload, String> {
    let sanitized = preferences::sanitize_preferences(&incoming);
    let Value::Object(patch) = serde_json::to_value(&sanitized)
        .map_err(|error| format!("Las preferencias no se pudieron serializar: {error}"))?
    else {
        return Err("Las preferencias no se pudieron serializar como objeto".to_string());
    };
    let saved = settings::save_settings(&patch)
        .ok_or_else(|| "No se pudieron guardar las preferencias en settings.json".to_string())?;
    Ok(payload_for(preferences::sanitize_preferences(
        &Value::Object(saved),
    )))
}

/// `settings:reset`
#[tauri::command(async)]
pub fn settings_reset() -> Result<PreferencesPayload, String> {
    let defaults = Preferences::default();
    let Value::Object(patch) = serde_json::to_value(&defaults)
        .map_err(|error| format!("Las preferencias no se pudieron serializar: {error}"))?
    else {
        return Err("Las preferencias no se pudieron serializar como objeto".to_string());
    };
    let saved = settings::save_settings(&patch).ok_or_else(|| {
        "No se pudieron restablecer las preferencias en settings.json".to_string()
    })?;
    log_info!("Preferencias restablecidas");
    Ok(payload_for(preferences::sanitize_preferences(
        &Value::Object(saved),
    )))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTransferResult {
    pub ok: bool,
    pub error: Option<String>,
    pub preferences: Option<PreferencesPayload>,
}

fn valid_profile_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["winslim-profile", "lterminal-profile", "sh", "ps1"]
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

const PROFILE_BEGIN: &str = "WINSLIM_PROFILE_JSON_BEGIN";
const PROFILE_END: &str = "WINSLIM_PROFILE_JSON_END";

fn profile_script(path: &Path, document: &str) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let template = match extension.as_str() {
        "sh" => include_str!("../../resources/profile-bootstrap.sh.in"),
        "ps1" => include_str!("../../resources/profile-bootstrap.ps1.in"),
        _ => return None,
    };
    Some(template.replace("{{PROFILE_JSON}}", document))
}

fn embedded_profile(path: &Path, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("winslim-profile")
        || extension.eq_ignore_ascii_case("lterminal-profile")
    {
        return Ok(bytes);
    }
    let text =
        String::from_utf8(bytes).map_err(|_| "El script exportado no es UTF-8".to_string())?;
    let start = text
        .find(PROFILE_BEGIN)
        .ok_or_else(|| "El script no contiene un perfil portable".to_string())?;
    let payload = &text[start + PROFILE_BEGIN.len()..];
    let payload = payload
        .split(PROFILE_END)
        .next()
        .ok_or_else(|| "El script no contiene el final del perfil".to_string())?;
    Ok(payload.trim().as_bytes().to_vec())
}

fn read_profile_document(path: &Path) -> Result<Value, String> {
    if !valid_profile_path(path) {
        return Err(
            "El perfil debe terminar en .winslim-profile, .lterminal-profile, .sh o .ps1".into(),
        );
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > 1_048_576 {
        return Err("El perfil supera 1 MiB".into());
    }
    let bytes = embedded_profile(path, bytes)?;
    let document: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("Perfil JSON inválido: {error}"))?;
    if document.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || document.get("application").and_then(Value::as_str) != Some("winslim-terminal")
    {
        return Err("Formato o versión de perfil incompatible".into());
    }
    Ok(document)
}

/// Importa un perfil antes de crear la ventana. Lo usa tanto el comando de la
/// interfaz como el script portable, de modo que ambos caminos tienen
/// exactamente la misma validación y no hay una segunda lógica de instalación.
pub fn import_profile_file(path: &Path) -> Result<Preferences, String> {
    let document = read_profile_document(path)?;
    let sanitized =
        preferences::sanitize_preferences(document.get("preferences").unwrap_or(&Value::Null));
    let Value::Object(patch) = serde_json::to_value(&sanitized)
        .map_err(|error| format!("No se pudo serializar el perfil: {error}"))?
    else {
        return Err("El perfil saneado no es un objeto".into());
    };
    if let Some(raw_plugins) = document.get("plugins") {
        let bundle: Vec<crate::config::plugins::PluginTransfer> =
            serde_json::from_value(raw_plugins.clone())
                .map_err(|error| format!("Plugins del perfil inválidos: {error}"))?;
        crate::config::plugins::import_bundle(&bundle)?;
    }
    if settings::save_settings(&patch).is_none() {
        return Err("No se pudo guardar el perfil importado".into());
    }
    Ok(sanitized)
}

/// Busca la opción usada por los scripts portables. Se mantiene aquí, junto a
/// la validación del perfil, para que una versión futura pueda ampliar el
/// protocolo sin que cada instalador tenga que conocer rutas internas.
pub fn profile_import_argument() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--import-profile" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

/// Ruta que Windows entrega al verbo «Abrir con WinSlim Terminal». Se usa solo
/// para elegir la carpeta inicial de la pestaña; el archivo nunca se ejecuta
/// de forma silenciosa.
pub fn open_path_argument() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--open-path" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

/// Exporta preferencias saneadas como perfil JSON o como script reproducible.
/// Los scripts informan explícitamente de lo que incluyen y excluyen: no se
/// convierten en instaladores silenciosos ni transportan credenciales.
#[tauri::command(async)]
pub fn profile_export(path: String) -> ProfileTransferResult {
    let target = Path::new(&path);
    if !valid_profile_path(target) {
        return ProfileTransferResult {
            ok: false,
            error: Some(
                "El perfil debe terminar en .winslim-profile, .lterminal-profile, .sh o .ps1"
                    .into(),
            ),
            preferences: None,
        };
    }
    let document = serde_json::json!({
        "schemaVersion": 1,
        "application": "winslim-terminal",
        "preferences": preferences::current(),
        "plugins": crate::config::plugins::export_bundle(),
    });
    let result = serde_json::to_string_pretty(&document)
        .map_err(|error| error.to_string())
        .and_then(|json| {
            let content = profile_script(target, &json).unwrap_or(json);
            std::fs::write(target, content).map_err(|error| error.to_string())
        });
    match result {
        Ok(()) => ProfileTransferResult {
            ok: true,
            error: None,
            preferences: None,
        },
        Err(error) => ProfileTransferResult {
            ok: false,
            error: Some(error),
            preferences: None,
        },
    }
}

#[tauri::command(async)]
pub fn profile_import(path: String) -> ProfileTransferResult {
    let target = Path::new(&path);
    match import_profile_file(target) {
        Ok(sanitized) => ProfileTransferResult {
            ok: true,
            error: None,
            preferences: Some(payload_for(sanitized)),
        },
        Err(error) => ProfileTransferResult {
            ok: false,
            error: Some(error),
            preferences: None,
        },
    }
}

// ---- Registro (`log:*`) ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub slug: &'static str,
    pub version: String,
    pub platform: &'static str,
    /// Créditos definidos en el catálogo de distribución, no en el código: una
    /// build para otro proyecto cambia el JSON y no la aplicación.
    pub developers: Vec<String>,
    /// Perfiles oficiales del catálogo: dueños del proyecto, además de
    /// desarrolladores.
    pub owners: Vec<String>,
    /// Creadores y responsables de la dirección del proyecto.
    pub project_leads: Vec<String>,
    /// Créditos adicionales propios de la distribución. WinSlim puede
    /// reconocer a sus colaboradores sin atribuirlos a LTerminal/Linux.
    pub collaborators: Vec<CollaboratorCredit>,
    /// Dónde vive `settings.json`, para poder abrirlo o respaldarlo a mano.
    pub settings_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaboratorCredit {
    pub login: &'static str,
    pub role: &'static str,
}

/// Datos de identidad que el frontend pinta en el título y el panel de ajustes.
#[tauri::command(async)]
pub fn app_info(app: AppHandle) -> AppInfo {
    let identity = identity::current();
    let catalog = crate::github::default_catalog();
    AppInfo {
        name: identity.name,
        slug: identity.slug,
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        developers: catalog.developers,
        owners: catalog.owners,
        project_leads: catalog.project_leads,
        collaborators: (identity.slug == "winslim-terminal")
            .then_some(vec![CollaboratorCredit {
                login: "Christianlg97",
                role: "Colaborador y desarrollador de WinSlim",
            }])
            .unwrap_or_default(),
        settings_path: settings::settings_path().to_string_lossy().to_string(),
    }
}

/// `log:renderer-error`: los errores del frontend acaban en el mismo archivo
/// que los del backend, que es donde se mira cuando algo falla.
#[tauri::command]
pub fn log_frontend_error(payload: Value) {
    log_error!("Error en el frontend", payload);
}

/// Una métrica que nace en el WebView, con el reloj monotónico del navegador.
/// `sinceStartMs` permite reconstruir el camino visible desde el arranque y
/// `durationMs` mide una operación concreta sin depender de la hora del sistema.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendPerformancePayload {
    pub metric: String,
    pub kind: String,
    pub since_start_ms: Option<f64>,
    pub duration_ms: Option<f64>,
    pub status: Option<String>,
    pub tab_id: Option<String>,
    pub details: Option<Value>,
}

/// `log:frontend-performance`: une las métricas del navegador al mismo
/// `main.log` que usa el backend. Se descartan nombres imposibles o tiempos no
/// finitos para que un WebView corrupto no genere líneas inanalizables.
#[tauri::command]
pub fn log_frontend_performance(payload: FrontendPerformancePayload) {
    if payload.metric.trim().is_empty()
        || payload.metric.len() > 120
        || payload.kind.len() > 40
        || payload
            .since_start_ms
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        || payload
            .duration_ms
            .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return;
    }
    let mut meta = serde_json::json!({
        "metric": payload.metric,
        "kind": payload.kind,
    });
    if let Some(value) = payload.since_start_ms {
        meta["sinceStartMs"] = serde_json::json!(value);
    }
    if let Some(value) = payload.duration_ms {
        meta["durationMs"] = serde_json::json!(value);
    }
    if let Some(value) = payload.status {
        meta["status"] = serde_json::json!(value);
    }
    if let Some(value) = payload.tab_id {
        meta["tabId"] = serde_json::json!(value);
    }
    if let Some(value) = payload.details {
        meta["details"] = value;
    }
    log_info!("Métrica de rendimiento frontend", meta);
}

/// `log:open-folder`
#[tauri::command(async)]
pub fn log_open_folder(app: AppHandle) -> Option<String> {
    let dir = logger::log_dir()?;
    let path = dir.to_string_lossy().to_string();
    let opened = crate::platform::open_directory(&app, &path);
    if let Err(error) = opened {
        log_error!(
            "No se pudo abrir la carpeta de logs",
            serde_json::json!({ "dir": path, "error": error })
        );
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_perfil_se_puede_extraer_de_los_dos_scripts() {
        let document = r#"{"schemaVersion":1,"application":"winslim-terminal","preferences":{}}"#;
        for extension in ["sh", "ps1"] {
            let path = Path::new(if extension == "sh" {
                "perfil.sh"
            } else {
                "perfil.ps1"
            });
            let script = profile_script(path, document).expect("script generado");
            let extracted = embedded_profile(path, script.into_bytes()).expect("perfil extraído");
            assert_eq!(String::from_utf8(extracted).unwrap(), document);
        }
    }

    #[test]
    fn los_perfiles_json_siguen_siendo_validos() {
        assert!(valid_profile_path(Path::new("perfil.winslim-profile")));
        assert!(valid_profile_path(Path::new("perfil.lterminal-profile")));
        assert!(valid_profile_path(Path::new("perfil.sh")));
        assert!(valid_profile_path(Path::new("perfil.ps1")));
        assert!(!valid_profile_path(Path::new("perfil.exe")));
    }
}
