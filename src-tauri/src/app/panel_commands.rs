//! Los comandos de los dos paneles laterales: Scripts y Explorador.
//!
//! Port de los canales `scripts:*` y `explorer:*` de `electron/main.js`.
//!
//! Regla que atraviesa todo el módulo: el frontend nunca manda una ruta que el
//! backend no le haya dado antes. Lo que se ejecuta, se abre o se borra tiene
//! que estar en la lista blanca del último escaneo (`visible_item`), dentro de
//! la carpeta que el explorador está enseñando o ser una ruta que el panel
//! acaba de mostrar. Una ruta suelta se rechaza.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::environments::{Environment, ShellKind, Transport};
use crate::file_explorer::{self, EntryKind};
use crate::file_viewers;
use crate::platform::traits::HostPlatform;
use crate::preferences;
use crate::scripts::{self, FileCategory, LaunchContext, ScanOptions, Scope, ScriptEntry};
use crate::state::AppState;

/// Tope de la cadena de argumentos que el usuario escribe para un script.
const MAX_SCRIPT_ARGS_CHARS: usize = 8192;

fn launch_context(env: &Environment) -> LaunchContext {
    LaunchContext {
        transport: Some(env.transport),
        host_root: env.host_root.clone(),
        container_root: env.container_root.clone(),
        // En producción manda el sistema donde se compiló.
        windows_host: None,
    }
}

fn categories_from(raw: Option<Vec<String>>) -> Vec<FileCategory> {
    scripts::normalize_categories(raw.as_deref())
}

fn categories_from_here(raw: Option<Vec<String>>) -> Vec<FileCategory> {
    match raw {
        None => scripts::default_here_categories(),
        Some(ref values) => scripts::normalize_categories(Some(values)),
    }
}

// ---- Panel de scripts ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOption {
    pub id: &'static str,
    pub label: &'static str,
    pub default: bool,
}

fn filter_options(is_here: bool) -> Vec<FilterOption> {
    let defaults = if is_here {
        scripts::default_here_categories()
    } else {
        scripts::default_categories()
    };
    scripts::file_filters()
        .into_iter()
        .map(|filter| FilterOption {
            id: filter.id.id(),
            label: filter.label,
            default: defaults.contains(&filter.id),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptsPanel {
    /// `library` o `here`.
    pub mode: &'static str,
    pub dir: String,
    pub scripts: Vec<ScriptEntry>,
    pub filters: Vec<FilterOption>,
    /// Solo en modo «Aquí»: hasta dónde se ha bajado y los topes del control.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    pub min_depth: u32,
    pub max_depth: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan: Option<scripts::scan::ScanInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Los scripts anclados, con su carpeta y su tipo. En Ruta actual se usan
    /// para marcar correctamente las estrellas; su lista se renderiza en
    /// Acceso rápido, por encima de los dos ámbitos.
    pub pinned: Vec<ScriptEntry>,
}

/// Los anclados que siguen existiendo. De paso poda de `settings.json` los que
/// ya no están: un script borrado no tiene por qué sobrevivir en la lista para
/// siempre.
fn pinned_scripts(state: &AppState) -> Vec<ScriptEntry> {
    let guardados = scripts::pins::load(&crate::settings::load_settings());
    if guardados.is_empty() {
        return Vec::new();
    }
    let (entradas, vivas) =
        scripts::pins::resolve(&guardados, &|ruta| scripts::scan::describe_path(ruta));
    if vivas.len() != guardados.len() {
        crate::settings::save_settings(&scripts::pins::patch(&vivas));
    }
    // Un anclado se puede lanzar aunque no esté en el escaneo visible: entra en
    // la misma lista blanca que el resto de lo que el panel enseña.
    state.allow_visible_items(&entradas);
    entradas
}

impl ScriptsPanel {
    fn empty(mode: &'static str, dir: &str, error: Option<String>) -> ScriptsPanel {
        let is_here = mode == "here";
        ScriptsPanel {
            mode,
            dir: dir.to_string(),
            scripts: Vec::new(),
            filters: filter_options(is_here),
            depth: None,
            min_depth: scripts::MIN_HERE_DEPTH,
            max_depth: scripts::MAX_HERE_DEPTH,
            scan: None,
            error,
            // Los rellena quien tenga el estado a mano; `empty` no lo tiene.
            pinned: Vec::new(),
        }
    }
}

fn bundled_operation_scripts(app: &AppHandle, categories: &[FileCategory]) -> Vec<ScriptEntry> {
    let Ok(resource_dir) = app.path().resource_dir() else {
        return Vec::new();
    };
    let is_windows = crate::platform::host().is_windows();
    let mut found = Vec::new();
    for folder_name in ["containers", "operations"] {
        let folder = resource_dir.join("scripts").join(folder_name);
        found.extend(scripts::list_all_scripts(&folder, categories));
    }
    found.retain(|entry| is_native_bundled_script(entry, is_windows));
    let source = bundled_source_label(is_windows);
    for entry in &mut found {
        entry.source = source.to_string();
    }
    found
}

fn bundled_source_label(is_windows: bool) -> &'static str {
    if is_windows {
        crate::config::identity::WINDOWS.name
    } else {
        crate::config::identity::LINUX.name
    }
}

fn is_native_bundled_script(entry: &ScriptEntry, is_windows: bool) -> bool {
    // Si el usuario activa todos los filtros, no se mezclan los gestores POSIX
    // con los de PowerShell: cada build enseña su variante nativa.
    //
    // No se filtra por la presencia del binario asociado. El script forma parte
    // de la Biblioteca y debe seguir visible para poder abrir su menú, mostrar
    // su diagnóstico y guiar a Entorno y dependencias. Si Docker, kubectl, SSH
    // o ADB faltan, el propio script lo explica; si lo ocultamos aquí
    // desaparecen también sus acciones rápidas.
    !(entry.ext == ".ps1" && !is_windows || entry.ext == ".sh" && is_windows)
}

fn library_panel(app: &AppHandle, state: &AppState, categories: &[FileCategory]) -> ScriptsPanel {
    let folder = crate::tabs::scripts_folder();
    let mut found = bundled_operation_scripts(app, categories);
    let mut personal = scripts::list_all_scripts(&folder, categories);
    found.append(&mut personal);
    state.remember_visible_items(&found);
    ScriptsPanel {
        dir: folder.to_string_lossy().to_string(),
        scripts: found,
        // Después de `remember_visible_items`, que vacía la lista blanca: los
        // anclados se añaden encima para poder lanzarse desde cualquier modo.
        pinned: pinned_scripts(state),
        ..ScriptsPanel::empty("library", "", None)
    }
}

/// `scripts:list`
#[tauri::command(async)]
pub fn scripts_list(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    categories: Option<Vec<String>>,
) -> ScriptsPanel {
    library_panel(&app, &state, &categories_from(categories))
}

fn here_panel(
    state: &AppState,
    tab_id: &str,
    categories: &[FileCategory],
    depth: u32,
) -> ScriptsPanel {
    let Some(dir) = state.tabs.here_dir(tab_id) else {
        return ScriptsPanel::empty(
            "here",
            "",
            Some(
                "No se pudo traducir el directorio actual a una carpeta del host. \
                 Puedes usar el Explorador para revisar la ruta disponible."
                    .into(),
            ),
        );
    };
    if !Path::new(&dir).is_dir() {
        state.remember_visible_items(&[]);
        return ScriptsPanel {
            depth: Some(depth),
            pinned: pinned_scripts(state),
            ..ScriptsPanel::empty(
                "here",
                &dir,
                Some(
                    "No se pudo traducir el directorio actual a una carpeta del host. \
                     Puedes usar el Explorador para revisar la ruta disponible."
                        .into(),
                ),
            )
        };
    }

    state.tabs.set_here_dir(tab_id, &dir, false);
    let scan_request = state.begin_script_scan();
    let _scan_guard = state.script_scan_guard();
    // Otra petición puede haber llegado mientras esperábamos el turno. No
    // merece la pena tocar el disco para una respuesta que el frontend ya no
    // mostrará.
    if !state.script_scan_is_current(scan_request) {
        return ScriptsPanel {
            depth: Some(depth),
            ..ScriptsPanel::empty("here", &dir, None)
        };
    }
    let total_started = std::time::Instant::now();
    let scan_started = std::time::Instant::now();
    let result = scripts::list_scripts(
        Path::new(&dir),
        &ScanOptions {
            scope: Scope::Here,
            categories,
            max_depth: depth,
            source: "Aquí".to_string(),
            cancel_generation: Some((state.script_scan_generation(), scan_request)),
        },
    );
    if !state.script_scan_is_current(scan_request) {
        return ScriptsPanel {
            depth: Some(depth),
            ..ScriptsPanel::empty("here", &dir, None)
        };
    }
    let scan_ms = scan_started.elapsed().as_millis() as u64;
    let whitelist_started = std::time::Instant::now();
    state.remember_visible_items(&result.scripts);
    let whitelist_ms = whitelist_started.elapsed().as_millis() as u64;
    let pinned_started = std::time::Instant::now();
    let pinned = pinned_scripts(state);
    let pinned_ms = pinned_started.elapsed().as_millis() as u64;
    log_info!(
        "Escaneo de scripts Aquí completado",
        serde_json::json!({
            "tabId": tab_id,
            "dir": dir,
            "depth": depth,
            "results": result.scripts.len(),
            "visitedDirectories": result.info.visited_directories,
            "skippedDirectories": result.info.skipped_directories,
            "stopReason": result.info.stop_reason,
            "scanMs": scan_ms,
            "whitelistMs": whitelist_ms,
            "pinnedMs": pinned_ms,
            "elapsedMs": total_started.elapsed().as_millis() as u64,
        })
    );
    ScriptsPanel {
        dir,
        scripts: result.scripts,
        depth: Some(depth),
        scan: Some(result.info),
        pinned,
        ..ScriptsPanel::empty("here", "", None)
    }
}

fn selected_here_depth(requested: Option<i64>) -> u32 {
    let fallback = crate::preferences::current().scripts_here_depth as u32;
    scripts::normalize_here_depth(requested, fallback.min(scripts::MAX_HERE_DEPTH))
}

/// `scripts:listHere`
#[tauri::command(async)]
pub fn scripts_list_here(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    categories: Option<Vec<String>>,
    depth: Option<i64>,
) -> ScriptsPanel {
    if !state.tabs.exists(&tab_id) {
        let translator = crate::i18n::Translator::new(&crate::i18n::active_language());
        return ScriptsPanel::empty(
            "here",
            "",
            Some(translator.t("error.noTab", "No hay una pestaña activa.")),
        );
    }
    here_panel(
        &state,
        &tab_id,
        &categories_from_here(categories),
        selected_here_depth(depth),
    )
}

/// Diálogo nativo de carpeta. El plugin de Tauri es asíncrono con callback;
/// aquí se espera su respuesta para poder devolverla en el mismo comando, como
/// hacía `dialog.showOpenDialog`.
fn pick_folder(app: &AppHandle, start_at: Option<&str>) -> Option<String> {
    let mut builder = app.dialog().file();
    if let Some(start) = start_at.filter(|path| Path::new(path).is_dir()) {
        builder = builder.set_directory(start);
    }
    builder.blocking_pick_folder().map(|path| path.to_string())
}

fn pick_file(app: &AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_file()
        .map(|p| p.to_string())
}

/// `scripts:pickTarget`. Elegir el archivo o la carpeta sobre la que actuará un
/// script: muchas de las utilidades importadas esperan una ruta como argumento
/// y sin ella no hacen nada útil.
#[tauri::command(async)]
pub fn scripts_pick_target(app: AppHandle, mode: String) -> Option<String> {
    if mode == "directory" {
        pick_folder(&app, None)
    } else {
        pick_file(&app)
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Qué visor haría falta instalar, cuando el sistema no supo abrir el
    /// archivo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<file_viewers::ViewerSuggestion>,
    /// El comando que se ha escrito en la terminal, para poder enseñarlo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// La pestaña donde se ha lanzado, que puede no ser la que lo pidió.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

impl ActionResult {
    pub(crate) fn ok() -> ActionResult {
        ActionResult {
            ok: true,
            ..Default::default()
        }
    }

    pub(crate) fn failed(error: impl Into<String>) -> ActionResult {
        ActionResult {
            ok: false,
            error: Some(error.into()),
            ..Default::default()
        }
    }

    /// Errores fijos que se muestran directamente en los paneles. Se
    /// resuelven antes de cruzar IPC; los diagnósticos de procesos externos
    /// siguen viajando tal cual porque no son frases del catálogo.
    pub(crate) fn failed_t(key: &str, fallback: &str) -> ActionResult {
        let translator = crate::i18n::Translator::new(&crate::i18n::active_language());
        Self::failed(translator.t(key, fallback))
    }
}

/// Abre una ruta con la aplicación predeterminada del sistema. Si no hay
/// ninguna asociada, se devuelve además qué visor haría falta, para que la
/// interfaz pueda ofrecer instalarlo (nunca se instala nada sin aceptar).
fn open_with_system(app: &AppHandle, path: &str, extension: &str) -> ActionResult {
    let opened = crate::platform::open_path(app, path);
    match opened {
        Ok(()) => ActionResult::ok(),
        Err(error) => {
            let suggestion = file_viewers::suggest_viewer(extension, std::env::consts::OS);
            log_warn!(
                "No se pudo abrir un archivo",
                serde_json::json!({
                    "error": &error,
                    "suggestedApp": suggestion.as_ref().map(|s| s.app),
                })
            );
            ActionResult {
                ok: false,
                error: Some(error),
                suggestion,
                ..Default::default()
            }
        }
    }
}

/// `scripts:open`
#[tauri::command(async)]
pub fn scripts_open(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    item_path: String,
) -> ActionResult {
    let Some(item) = state.visible_item(&item_path) else {
        return ActionResult::failed_t(
            "error.notAuthorised",
            "El archivo no está autorizado para abrirse desde este panel.",
        );
    };
    if !item.openable {
        return ActionResult::failed_t(
            "error.notAuthorised",
            "El archivo no está autorizado para abrirse desde este panel.",
        );
    }
    let result = open_with_system(&app, &item.path, &item.ext);
    if result.ok {
        log_info!(
            "Archivo abierto desde el panel",
            serde_json::json!({ "name": item.name })
        );
    }
    result
}

/// Escribe un comando completo en nombre de un panel: se ve en la terminal
/// antes de ejecutarse, como si lo hubiera tecleado el usuario.
fn write_command(state: &AppState, tab_id: &str, command: &str) -> bool {
    state.tabs.write_command(tab_id, command)
}

/// `scripts:cd`
#[tauri::command(async)]
pub fn scripts_cd(state: State<'_, Arc<AppState>>, tab_id: String, item_path: String) {
    if !state.tabs.has_session(&tab_id) {
        return;
    }
    let Some(item) = state.visible_item(&item_path) else {
        return;
    };
    let Some(env) = state.tabs.environment_of(&tab_id) else {
        return;
    };
    if env.repl {
        log_info!(
            "cd ignorado: la pestaña activa es un REPL, no una shell",
            serde_json::json!({ "tabId": tab_id, "envId": env.id })
        );
        return;
    }
    let Some(command) =
        scripts::build_cd_command(&item.path, env.kind, false, &launch_context(&env))
    else {
        return;
    };
    log_info!(
        "Cambio de carpeta desde el panel",
        serde_json::json!({ "tabId": tab_id, "item": item.name })
    );
    write_command(&state, &tab_id, &command);
}

/// `scripts:cdDirectory`: lleva la terminal a la carpeta que el panel está
/// mostrando. La ruta se valida en backend antes de escribir el comando para
/// que el panel no pueda convertir una entrada arbitraria en una orden.
#[tauri::command(async)]
pub fn scripts_cd_directory(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    directory: String,
) -> ActionResult {
    if !state.tabs.has_session(&tab_id) {
        return ActionResult::failed_t("error.noTab", "La pestaña activa ya no está disponible.");
    }
    let target = directory.trim();
    let target_path = Path::new(target);
    if target.is_empty() || !target_path.is_dir() {
        return ActionResult::failed_t(
            "error.folderNotInView",
            "La ruta mostrada ya no existe o no es una carpeta.",
        );
    }
    let normalized_target = target_path.canonicalize().ok();
    let allowed = [
        crate::tabs::scripts_folder().to_string_lossy().to_string(),
        state.tabs.here_dir(&tab_id).unwrap_or_default(),
    ]
    .into_iter()
    .filter(|candidate| !candidate.is_empty())
    .filter_map(|candidate| Path::new(&candidate).canonicalize().ok())
    .any(|candidate| Some(candidate) == normalized_target);
    if !allowed {
        return ActionResult::failed_t(
            "error.notInView",
            "La ruta no pertenece a una vista válida del panel.",
        );
    }
    let Some(env) = state.tabs.environment_of(&tab_id) else {
        return ActionResult::failed_t("error.noTab", "La pestaña activa ya no está disponible.");
    };
    if env.repl {
        return ActionResult::failed_t(
            "error.replNotShell",
            "La pestaña activa es un intérprete, no una shell.",
        );
    }
    let Some(command) = scripts::build_cd_command(target, env.kind, true, &launch_context(&env))
    else {
        return ActionResult::failed_t(
            "error.folderNotInView",
            "Esta ruta no se puede alcanzar desde este entorno.",
        );
    };
    if !write_command(&state, &tab_id, &command) {
        return ActionResult::failed_t("error.writeFailed", "No se pudo escribir en la terminal.");
    }
    log_info!(
        "Cambio de carpeta desde la ruta del panel",
        serde_json::json!({ "tabId": tab_id, "directory": target })
    );
    ActionResult {
        ok: true,
        command: Some(command),
        ..Default::default()
    }
}

/// `scripts:pin`
///
/// Solo se puede anclar algo que el panel haya enseñado: la ruta no se acepta
/// directamente del frontend, igual que en el resto del módulo. Desanclar sí
/// admite cualquier ruta de la lista guardada, porque quitar no es una acción
/// peligrosa y un script ya borrado tiene que poder quitarse.
#[tauri::command(async)]
pub fn scripts_pin(
    state: State<'_, Arc<AppState>>,
    item_path: String,
    pinned: bool,
) -> Vec<ScriptEntry> {
    let guardados = scripts::pins::load(&crate::settings::load_settings());
    let permitido = !pinned || state.visible_item(&item_path).is_some();
    if permitido {
        let lista = scripts::pins::toggle(&guardados, &item_path, pinned);
        crate::settings::save_settings(&scripts::pins::patch(&lista));
        log_info!(
            "Script anclado o desanclado",
            serde_json::json!({ "anclado": pinned, "total": lista.len() })
        );
    }
    // Solo cambia la colección de anclados. Devolver un ScriptsPanel completo
    // reconstruía la Biblioteca y pisaba falsamente una vista de Ruta actual.
    pinned_scripts(&state)
}

/// Busca una pestaña abierta con una shell de una de las familias pedidas, o
/// devuelve el entorno con el que habría que abrir una nueva.
fn tab_for_kinds(state: &AppState, kinds: &[ShellKind]) -> Option<(String, Environment)> {
    let list = state.tabs.list();
    for kind in kinds {
        for summary in &list.tabs {
            if let Some(env) = state.tabs.environment_of(&summary.id) {
                if env.kind == *kind && !env.repl && !env.no_auto_select {
                    return Some((summary.id.clone(), env));
                }
            }
        }
    }
    None
}

/// `noAutoSelect` deja fuera entornos que hablan la misma familia pero no
/// comparten el sistema de archivos del host: el cmd.exe de Wine es de familia
/// `cmd`, y elegirlo solo por eso mandaría una ruta que dentro de Wine no
/// existe. Sigue disponible en el selector para quien lo elija a mano.
fn environment_for_kinds(state: &AppState, kinds: &[ShellKind]) -> Option<Environment> {
    let envs = state.environments();
    kinds.iter().find_map(|kind| {
        envs.iter()
            .find(|env| env.kind == *kind && env.available && !env.no_auto_select && !env.repl)
            .cloned()
    })
}

/// Entorno preferido para ejecutar un script shell cuando hay que abrir una
/// pestaña nueva. Si el usuario eligió uno en Ajustes, se respeta. Si no, y el
/// script pide una familia unix (bash/sh/zsh), se prefieren las distribuciones
/// WSL sobre Git Bash (Msys): así Git Bash no es el por defecto en Windows y el
/// usuario trabaja en la distro que usa de verdad. Wine queda excluido: su
/// aislamiento de filesystem lo hace inadecuado como opción por defecto.
fn preferred_script_environment(state: &AppState, kinds: &[ShellKind]) -> Option<Environment> {
    let envs = state.environments();

    let preference = preferences::current().default_script_environment_id;
    if let Some(env) = configured_script_environment(&envs, &preference) {
        return Some(env);
    }

    let is_unix_family = |kind: &ShellKind| {
        matches!(
            kind,
            ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh | ShellKind::Fish
        )
    };

    if kinds.iter().all(is_unix_family) {
        for transport in [Transport::Wsl, Transport::Native, Transport::Msys] {
            for kind in kinds {
                if let Some(env) = envs.iter().find(|env| {
                    env.kind == *kind
                        && env.transport == transport
                        && env.available
                        && !env.no_auto_select
                        && !env.repl
                }) {
                    return Some(env.clone());
                }
            }
        }
        return None;
    }

    environment_for_kinds(state, kinds)
}

fn configured_script_environment(envs: &[Environment], preference: &str) -> Option<Environment> {
    if preference.is_empty() {
        return None;
    }
    envs.iter()
        .find(|env| env.id == preference && env.available && !env.repl && !env.no_auto_select)
        .cloned()
}

/// `scripts:run`
#[tauri::command(async)]
pub fn scripts_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    path: String,
    as_admin: Option<bool>,
    args: Option<String>,
) -> ActionResult {
    if !state.tabs.has_session(&tab_id) {
        return ActionResult::failed_t("error.noTab", "La pestaña activa ya no está disponible.");
    }
    // Solo se puede actuar sobre un archivo devuelto por el último escaneo
    // visible. La ruta no se acepta directamente del frontend.
    let Some(script) = state.visible_item(&path) else {
        return ActionResult::failed_t(
            "error.notInView",
            "El script ya no pertenece a la vista actual.",
        );
    };
    if !script.runnable {
        return ActionResult::failed_t("scripts.openFailed", "Ese archivo no se ejecuta: se abre.");
    }
    let as_admin = as_admin.unwrap_or(false);
    let args: String = args
        .unwrap_or_default()
        .chars()
        .take(MAX_SCRIPT_ARGS_CHARS)
        .collect();

    let Some(current_env) = state.tabs.environment_of(&tab_id) else {
        return ActionResult::failed_t("error.noTab", "La pestaña activa ya no está disponible.");
    };

    // Un REPL no puede lanzar el script: hace falta una shell de verdad.
    let preferred = scripts::environment_kinds_for_script(&script);
    let mut target_tab = tab_id.clone();
    let mut env = current_env;

    if env.repl {
        let shells = [
            ShellKind::Cmd,
            ShellKind::Powershell,
            ShellKind::Bash,
            ShellKind::Zsh,
            ShellKind::Sh,
            ShellKind::Fish,
        ];
        match tab_for_kinds(&state, &shells) {
            Some((found_tab, found_env)) => {
                target_tab = found_tab;
                env = found_env;
            }
            None => {
                let Some(shell_env) = environment_for_kinds(&state, &shells) else {
                    return ActionResult::failed_t(
                        "error.noShell",
                        "No hay una shell disponible para lanzar el script.",
                    );
                };
                let created = state.tabs.create_tab(&app, &shell_env, None);
                target_tab = created.id;
                env = shell_env;
            }
        }
    }

    // El script pide una familia concreta (PowerShell para .ps1, cmd para
    // .bat): si la pestaña actual no la habla, se busca o se abre una que sí.
    // Para shells unix, preferred_script_environment evita que Git Bash sea el
    // por defecto en Windows y prefiere WSL si hay una disponible.
    if !preferred.is_empty() && !preferred.contains(&env.kind) {
        match tab_for_kinds(&state, &preferred) {
            Some((found_tab, found_env)) => {
                target_tab = found_tab;
                env = found_env;
            }
            None => {
                let Some(shell_env) = preferred_script_environment(&state, &preferred) else {
                    return ActionResult::failed_t(
                        "error.noShell",
                        "Este script necesita una shell que no está disponible en este sistema.",
                    );
                };
                let created = state.tabs.create_tab(&app, &shell_env, None);
                target_tab = created.id;
                env = shell_env;
            }
        }
    }

    let Some(command) =
        scripts::build_launch_command(&script, env.kind, as_admin, &args, &launch_context(&env))
    else {
        return ActionResult::failed_t(
            "error.notAuthorised",
            "Este script no se puede lanzar desde el entorno de esta pestaña.",
        );
    };

    log_info!(
        "Script lanzado desde el panel",
        serde_json::json!({
            "tabId": target_tab, "name": script.name, "asAdmin": as_admin, "envId": env.id
        })
    );
    // Lanzar un script deja la terminal ocupada un rato y su salida se mezcla
    // con lo que hubiera antes: la cabecera dice cuál se está ejecutando y con
    // qué argumentos, y el cierre si terminó bien. Sin pausa: un script no es
    // una consulta de un panel, la terminal se queda como estaba al acabar.
    let t = crate::i18n::Translator::new(&crate::i18n::active_language());
    let notice =
        crate::console_ui::Notice::new(t.t("verb.run", "Ejecutar"), &script.name, &command).note(
            as_admin.then(|| {
                t.t(
                    "console.asAdmin",
                    "Se pedirá elevación: acepta el aviso de Windows para que arranque.",
                )
            }),
        );
    let decorated = crate::console_ui::decorate(&command, &notice, env.kind, false, &t);

    if !write_command(&state, &target_tab, &decorated) {
        return ActionResult::failed_t("error.writeFailed", "No se pudo escribir en la terminal.");
    }
    ActionResult {
        ok: true,
        command: Some(command),
        tab_id: Some(target_tab),
        ..Default::default()
    }
}

// ---- Explorador lateral ----

/// Comprueba que una ruta es una entrada directa de la carpeta que el
/// explorador está enseñando para esta pestaña. Es la lista blanca del
/// explorador: sin esto, el frontend podría pedir borrar cualquier cosa.
fn entry_in_current_dir(
    state: &AppState,
    tab_id: &str,
    item_path: &str,
) -> Option<(String, String)> {
    let dir = state.tabs.explorer_dir(tab_id)?;
    let listing = file_explorer::list_directory(&dir);
    if !listing.ok {
        return None;
    }
    listing
        .entries
        .iter()
        .find(|entry| entry.path == item_path)
        .map(|entry| (dir.clone(), entry.name.clone()))
}

/// `explorer:list`
#[tauri::command(async)]
pub fn explorer_list(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    dir: Option<String>,
) -> file_explorer::Listing {
    let target = dir
        .filter(|value| !value.is_empty())
        .or_else(|| state.tabs.explorer_dir(&tab_id))
        .unwrap_or_default();
    if target.is_empty() {
        return file_explorer::list_directory("");
    }
    let listing = file_explorer::list_directory(&target);
    if listing.ok {
        state.tabs.set_explorer_dir(&tab_id, &target);
    }
    listing
}

/// `explorer:follow`: vuelve a seguir al directorio de la shell.
#[tauri::command(async)]
pub fn explorer_follow(state: State<'_, Arc<AppState>>, tab_id: String) -> file_explorer::Listing {
    let target = state
        .tabs
        .cwd_of(&tab_id)
        .map(|cwd| cwd.to_string_lossy().to_string())
        .unwrap_or_default();
    if !target.is_empty() {
        state.tabs.set_explorer_dir(&tab_id, &target);
    }
    file_explorer::list_directory(&target)
}

/// `explorer:create`
#[tauri::command(async)]
pub fn explorer_create(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    name: String,
    kind: String,
) -> file_explorer::FsResult {
    let Some(dir) = state.tabs.explorer_dir(&tab_id) else {
        return file_explorer::FsResult {
            ok: false,
            error: Some(
                crate::i18n::Translator::new(&crate::i18n::active_language())
                    .t("error.noFolderOpen", "No hay una carpeta abierta."),
            ),
            path: None,
            name: None,
            renamed: false,
        };
    };
    let kind = if kind == "directory" {
        EntryKind::Directory
    } else {
        EntryKind::File
    };
    let etiqueta = format!("{kind:?}");
    let result = file_explorer::create_entry(&dir, &name, kind);
    // Igual que la papelera y el lanzador de scripts: lo que cambia el disco
    // deja rastro. Sin esto, "aqui habia una carpeta" no se puede reconstruir
    // desde el log aunque todo lo demas si este.
    if result.ok {
        log_info!(
            "Elemento creado desde el explorador",
            serde_json::json!({ "name": name, "kind": etiqueta })
        );
    }
    result
}

/// `explorer:open`: abre un archivo del explorador con la app del sistema, o
/// entra en la carpeta si es un directorio.
#[tauri::command(async)]
pub fn explorer_open(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    item_path: String,
) -> ActionResult {
    if entry_in_current_dir(&state, &tab_id, &item_path).is_none() {
        return ActionResult::failed_t(
            "error.notInView",
            "Ese elemento no pertenece a la carpeta abierta.",
        );
    }
    let path = Path::new(&item_path);
    if path.is_dir() {
        state.tabs.set_explorer_dir(&tab_id, &item_path);
        return ActionResult::ok();
    }
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    open_with_system(&app, &item_path, &extension)
}

/// `explorer:rename`
#[tauri::command(async)]
pub fn explorer_rename(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    item_path: String,
    new_name: String,
) -> file_explorer::FsResult {
    let Some((dir, _)) = entry_in_current_dir(&state, &tab_id, &item_path) else {
        return file_explorer::FsResult {
            ok: false,
            error: Some(
                crate::i18n::Translator::new(&crate::i18n::active_language()).t(
                    "error.notInView",
                    "Ese elemento no pertenece a la carpeta abierta.",
                ),
            ),
            path: None,
            name: None,
            renamed: false,
        };
    };
    let result = file_explorer::rename_entry(&dir, &item_path, &new_name);
    if result.ok {
        log_info!(
            "Elemento renombrado desde el explorador",
            serde_json::json!({ "from": item_path, "to": new_name })
        );
    }
    result
}

/// `explorer:clip`: recuerda qué se ha copiado o cortado.
#[tauri::command]
pub fn explorer_clip(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    item_path: String,
    mode: String,
) -> ActionResult {
    if entry_in_current_dir(&state, &tab_id, &item_path).is_none() {
        return ActionResult::failed_t(
            "error.notInView",
            "Ese elemento no pertenece a la carpeta abierta.",
        );
    }
    state.set_clipboard(&item_path, mode == "cut");
    ActionResult::ok()
}

/// `explorer:paste`
#[tauri::command(async)]
pub fn explorer_paste(state: State<'_, Arc<AppState>>, tab_id: String) -> file_explorer::FsResult {
    let translator = crate::i18n::Translator::new(&crate::i18n::active_language());
    let failed = |message: &str| file_explorer::FsResult {
        ok: false,
        error: Some(message.to_string()),
        path: None,
        name: None,
        renamed: false,
    };
    let Some(item) = state.take_clipboard() else {
        return failed(&translator.t("error.nothingCopied", "No hay nada que pegar."));
    };
    let Some(dir) = state.tabs.explorer_dir(&tab_id) else {
        return failed(&translator.t("error.noFolderOpen", "No hay una carpeta abierta."));
    };
    let result = file_explorer::paste_entry(&item.path, &dir, item.cut);
    if result.ok {
        // `renamed` importa en el log: si el nombre cambió para no pisar nada,
        // buscar el original después no encontraría el archivo.
        log_info!(
            "Elemento pegado desde el explorador",
            serde_json::json!({
                "from": item.path, "into": dir, "cut": item.cut, "renamed": result.renamed
            })
        );
    }
    // Lo cortado solo se pega una vez: después ya no está en su sitio.
    if result.ok && item.cut {
        state.clear_clipboard();
    }
    result
}

/// `explorer:trash`: manda a la papelera, no borra. Es reversible desde el
/// propio sistema, que es lo que el usuario espera de un explorador.
#[tauri::command(async)]
pub fn explorer_trash(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    item_path: String,
) -> ActionResult {
    if entry_in_current_dir(&state, &tab_id, &item_path).is_none() {
        return ActionResult::failed_t(
            "error.notInView",
            "Ese elemento no pertenece a la carpeta abierta.",
        );
    }
    match crate::recycle::send_to_trash(&item_path) {
        Ok(()) => {
            log_info!(
                "Elemento enviado a la papelera",
                serde_json::json!({ "path": item_path })
            );
            ActionResult::ok()
        }
        Err(error) => ActionResult::failed(format!("No se pudo enviar a la papelera: {error}")),
    }
}

/// `explorer:cd`: lleva la terminal a la carpeta que el explorador enseña.
#[tauri::command(async)]
pub fn explorer_cd(state: State<'_, Arc<AppState>>, tab_id: String) -> ActionResult {
    let Some(dir) = state.tabs.explorer_dir(&tab_id) else {
        return ActionResult::failed_t("error.noFolderOpen", "No hay una carpeta abierta.");
    };
    let Some(env) = state.tabs.environment_of(&tab_id) else {
        return ActionResult::failed_t("error.noTab", "La pestaña activa ya no está disponible.");
    };
    if env.repl {
        return ActionResult::failed_t(
            "error.replNotShell",
            "La pestaña activa es un intérprete, no una shell.",
        );
    }
    let Some(command) = scripts::build_cd_command(&dir, env.kind, true, &launch_context(&env))
    else {
        return ActionResult::failed_t(
            "error.folderNotInView",
            "Esa carpeta no se puede alcanzar desde este entorno.",
        );
    };
    if !write_command(&state, &tab_id, &command) {
        return ActionResult::failed_t("error.writeFailed", "No se pudo escribir en la terminal.");
    }
    ActionResult {
        ok: true,
        command: Some(command),
        ..Default::default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDirectoryResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Con qué gestores se puede abrir, cuando el sistema no supo hacerlo solo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<file_viewers::ManagerChoices>,
}

/// `explorer:openDirectory`: abre una CARPETA en el gestor de archivos del
/// sistema. Si no hay ninguno, se devuelve con qué se puede abrir o instalar, y
/// la elección vuelve por `explorer_open_directory_with` con el identificador
/// de la tabla, nunca con una ruta a un ejecutable.
#[tauri::command(async)]
pub fn explorer_open_directory(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    item_path: Option<String>,
) -> OpenDirectoryResult {
    let target = item_path
        .filter(|value| !value.is_empty())
        .or_else(|| state.tabs.explorer_dir(&tab_id))
        .unwrap_or_default();
    if target.is_empty() || !Path::new(&target).is_dir() {
        return OpenDirectoryResult {
            ok: false,
            error: Some(
                crate::i18n::Translator::new(&crate::i18n::active_language())
                    .t("error.noFolderOpen", "No hay una carpeta que abrir."),
            ),
            choices: None,
        };
    }

    // Si el usuario ya eligió un gestor concreto, se respeta.
    let preferred = crate::preferences::current().file_manager_id;
    if !preferred.is_empty() {
        if let Some(manager) = file_viewers::file_manager_by_id(std::env::consts::OS, &preferred) {
            return launch_file_manager(manager.cmd, &target);
        }
    }

    let opened = crate::platform::open_directory(&app, &target);
    match opened {
        Ok(()) => OpenDirectoryResult {
            ok: true,
            error: None,
            choices: None,
        },
        Err(error) => {
            // En Linux el gestor natural depende del escritorio; se prueba con
            // él antes de preguntar.
            let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
            if let Some(manager) = file_viewers::file_manager_for_desktop(&desktop, &|cmd| {
                crate::path_env::which(cmd).is_some()
            }) {
                return launch_file_manager(manager.cmd, &target);
            }
            OpenDirectoryResult {
                ok: false,
                error: Some(error),
                choices: Some(file_viewers::file_manager_choices(
                    std::env::consts::OS,
                    &|cmd| crate::path_env::which(cmd).is_some(),
                )),
            }
        }
    }
}

fn launch_file_manager(cmd: &str, directory: &str) -> OpenDirectoryResult {
    match crate::process::hidden_command(cmd).arg(directory).spawn() {
        Ok(_) => OpenDirectoryResult {
            ok: true,
            error: None,
            choices: None,
        },
        Err(error) => OpenDirectoryResult {
            ok: false,
            error: Some(error.to_string()),
            choices: None,
        },
    }
}

/// `explorer:openDirectoryWith`: abre la carpeta con el gestor que el usuario
/// eligió de la lista. Llega el identificador de la tabla, no una ruta.
#[tauri::command(async)]
pub fn explorer_open_directory_with(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    item_path: Option<String>,
    manager_id: String,
    remember: Option<bool>,
) -> OpenDirectoryResult {
    let Some(manager) = file_viewers::file_manager_by_id(std::env::consts::OS, &manager_id) else {
        return OpenDirectoryResult {
            ok: false,
            error: Some(
                crate::i18n::Translator::new(&crate::i18n::active_language()).t(
                    "explorer.noManager",
                    "Ese gestor de archivos no está en la lista.",
                ),
            ),
            choices: None,
        };
    };
    let target = item_path
        .filter(|value| !value.is_empty())
        .or_else(|| state.tabs.explorer_dir(&tab_id))
        .unwrap_or_default();
    if target.is_empty() {
        return OpenDirectoryResult {
            ok: false,
            error: Some(
                crate::i18n::Translator::new(&crate::i18n::active_language())
                    .t("error.noFolderOpen", "No hay una carpeta que abrir."),
            ),
            choices: None,
        };
    }
    if remember.unwrap_or(false) {
        crate::settings::save_key(
            "fileManagerId",
            serde_json::Value::String(manager.id.to_string()),
        );
    }
    launch_file_manager(manager.cmd, &target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_profundidad_pedida_manda_sobre_la_preferencia() {
        assert_eq!(selected_here_depth(Some(5)), 5);
        assert_eq!(selected_here_depth(Some(99)), scripts::MAX_HERE_DEPTH);
        assert_eq!(selected_here_depth(Some(-1)), scripts::MIN_HERE_DEPTH);
    }

    #[test]
    fn los_filtros_conservan_los_identificadores_del_original() {
        let ids: Vec<&str> = filter_options(false).iter().map(|f| f.id).collect();
        assert!(ids.contains(&"other-script"));
        assert!(ids.contains(&"powershell"));
        assert_eq!(ids.len(), scripts::file_filters().len());
    }

    #[test]
    fn el_entorno_de_scripts_no_elige_wine_ni_entornos_no_automaticos() {
        let mut wine = Environment::new("wine-cmd", "Wine", ShellKind::Cmd, "wine", &[]);
        wine.no_auto_select = true;
        assert!(configured_script_environment(&[wine], "wine-cmd").is_none());
    }

    #[test]
    fn un_panel_vacio_lleva_los_topes_de_profundidad() {
        let panel = ScriptsPanel::empty("here", "/x", None);
        assert_eq!(panel.min_depth, scripts::MIN_HERE_DEPTH);
        assert_eq!(panel.max_depth, scripts::MAX_HERE_DEPTH);
        assert!(panel.scripts.is_empty());
    }

    #[test]
    fn el_resultado_de_una_accion_viaja_con_los_nombres_esperados() {
        let value = serde_json::to_value(ActionResult::failed("x")).unwrap();
        assert_eq!(value["ok"], serde_json::json!(false));
        assert_eq!(value["error"], serde_json::json!("x"));
        // Lo que no aplica no viaja.
        assert!(value.get("suggestion").is_none());
        assert!(value.get("tabId").is_none());
    }

    #[test]
    fn los_scripts_integrados_se_muestran_sin_exigir_la_herramienta_previa() {
        let ps1 = ScriptEntry {
            name: "docker-manager.ps1".into(),
            ext: ".ps1".into(),
            kind: crate::scripts::ScriptType::Powershell,
            category: FileCategory::Powershell,
            interpreter: Some("powershell".into()),
            runnable: true,
            openable: false,
            instruction: "".into(),
            path: r"C:\app\scripts\operations\docker-manager.ps1".into(),
            rel_dir: "operations".into(),
            source: "LTerminal".into(),
            hint: None,
        };
        let sh = ScriptEntry {
            name: "docker-manager.sh".into(),
            ext: ".sh".into(),
            kind: crate::scripts::ScriptType::Shell,
            category: FileCategory::Shell,
            interpreter: Some("bash".into()),
            runnable: true,
            openable: false,
            instruction: "".into(),
            path: "/app/scripts/operations/docker-manager.sh".into(),
            rel_dir: "operations".into(),
            source: "LTerminal".into(),
            hint: None,
        };
        assert!(is_native_bundled_script(&ps1, true));
        assert!(!is_native_bundled_script(&ps1, false));
        assert!(is_native_bundled_script(&sh, false));
        assert!(!is_native_bundled_script(&sh, true));
    }

    #[test]
    fn los_scripts_integrados_usan_la_marca_de_la_build() {
        assert_eq!(bundled_source_label(false), "LTerminal");
        assert_eq!(bundled_source_label(true), "WinSlim Terminal");
    }
}
