//! Los comandos que el frontend puede invocar.
//!
//! Sustituyen a los canales `ipcMain.handle` / `ipcMain.on` de la versión
//! Electron. La correspondencia es uno a uno y está anotada en cada comando,
//! para poder cotejarlos con `electron/preload.js` mientras dure la migración.

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::environments::Environment;
use crate::preferences::{
    self, FontFamily, Preferences, ThemePreset, FONT_FAMILIES, THEME_PRESETS,
};
use crate::state::AppState;
use crate::tabs::{TabList, TabSummary, MAX_PTY_INPUT_CHARS};
use crate::{i18n, identity, logger, settings};

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
) -> Option<TabSummary> {
    let env = match env_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => state.environment_by_id(id)?,
        None => state.default_environment()?,
    };
    // La pestaña nueva hereda el directorio de la que estaba en uso: abrir WSL
    // desde un cmd situado en C:\proyecto empieza en /mnt/c/proyecto.
    let inherited = state.tabs.active_cwd();
    Some(state.tabs.create_tab(&app, &env, inherited.as_deref()))
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
    // La detección completa habla con WSL, Docker y adb. Se inicia únicamente
    // cuando xterm ya puede recibir y pintar la salida de la primera pestaña,
    // para que esas sondas no compitan con el camino crítico del arranque.
    // `AppState` garantiza que las pestañas siguientes no la repitan.
    state.start_full_detection(&app);
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

/// `pty-resize`
#[tauri::command]
pub fn pty_resize(state: State<'_, Arc<AppState>>, tab_id: String, cols: i64, rows: i64) {
    let Some(viewport) = crate::tabs::valid_viewport(cols, rows) else {
        return;
    };
    state.tabs.resize(&tab_id, viewport.cols, viewport.rows);
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
    // La sesión nueva empieza donde estaba la anterior.
    let inherited = state.tabs.active_cwd();
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
pub fn settings_save(incoming: Value) -> PreferencesPayload {
    let sanitized = preferences::sanitize_preferences(&incoming);
    match serde_json::to_value(&sanitized) {
        Ok(Value::Object(patch)) => {
            if settings::save_settings(&patch).is_none() {
                log_error!("No se pudieron guardar las preferencias");
            }
        }
        _ => log_error!("Las preferencias no se pudieron serializar"),
    }
    payload_for(sanitized)
}

/// `settings:reset`
#[tauri::command(async)]
pub fn settings_reset() -> PreferencesPayload {
    let defaults = Preferences::default();
    if let Ok(Value::Object(patch)) = serde_json::to_value(&defaults) {
        settings::save_settings(&patch);
    }
    log_info!("Preferencias restablecidas");
    payload_for(defaults)
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
    /// Dónde vive `settings.json`, para poder abrirlo o respaldarlo a mano.
    pub settings_path: String,
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
        settings_path: settings::settings_path().to_string_lossy().to_string(),
    }
}

/// `log:renderer-error`: los errores del frontend acaban en el mismo archivo
/// que los del backend, que es donde se mira cuando algo falla.
#[tauri::command]
pub fn log_frontend_error(payload: Value) {
    log_error!("Error en el frontend", payload);
}

/// `log:open-folder`
#[tauri::command(async)]
pub fn log_open_folder(app: AppHandle) -> Option<String> {
    let dir = logger::log_dir()?;
    let path = dir.to_string_lossy().to_string();
    #[cfg(target_os = "linux")]
    let opened = {
        let _ = app;
        crate::file_viewers::open_linux_directory(&path)
    };
    #[cfg(not(target_os = "linux"))]
    let opened = tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(&path, None::<&str>)
        .map_err(|error| error.to_string());
    if let Err(error) = opened {
        log_error!(
            "No se pudo abrir la carpeta de logs",
            serde_json::json!({ "dir": path, "error": error })
        );
        return None;
    }
    Some(path)
}
