//! WinSlim Terminal / LTerminal — backend.
//!
//! Migración de `electron/main.js` (Electron + node-pty) a Tauri 2 + Rust.
//! Cada módulo anota de qué archivo de la versión anterior viene, para poder
//! cotejarlos mientras dure la migración.

#[macro_use]
pub mod logger;

pub mod alias_profiles;
pub mod android_env;
pub mod command_not_found;
pub mod commands;
pub mod commands_install;
pub mod commands_panels;
pub mod commands_projects;
pub mod commands_update;
pub mod console_ui;
pub mod current_dir;
pub mod docker_env;
pub mod environments;
pub mod file_explorer;
pub mod file_viewers;
pub mod github;
pub mod i18n;
pub mod identity;
pub mod install_actions;
pub mod install_dir;
pub mod language_env;
pub mod migration;
pub mod package_aliases;
pub mod path_env;
pub mod paths;
pub mod preferences;
pub mod process;
pub mod pty;
pub mod recycle;
pub mod scripts;
pub mod self_update;
pub mod session_files;
pub mod settings;
pub mod shell_paths;
pub mod spawn_cwd;
pub mod state;
pub mod stream;
pub mod system_info;
pub mod tabs;
pub mod virtualization;
pub mod wsl_env;

use std::time::Instant;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::state::AppState;

/// Unifica los datos que pudieran haber quedado bajo el nombre visible de la
/// app (la ruta que usaba Electron) con la ruta estable basada en el slug.
fn migrate_local_data() {
    let report = migration::migrate_user_data(&paths::LEGACY_USER_DATA_DIR, &paths::USER_DATA_DIR);
    if report.migrated {
        log_info!(
            "Datos locales unificados en la ruta estable",
            serde_json::json!({
                "from": paths::LEGACY_USER_DATA_DIR.to_string_lossy(),
                "to": paths::USER_DATA_DIR.to_string_lossy(),
                "settingsMerged": report.settings_merged,
                "scriptsCopied": report.scripts_copied,
            })
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_started = Instant::now();
    let migration_started = Instant::now();
    migrate_local_data();
    let migration_ms = migration_started.elapsed().as_millis();
    system_info::prewarm_hardware_info();

    let identity = identity::current();
    let conpty = pty::sideloaded_conpty();
    logger::banner(
        &format!("ARRANQUE {}", identity.name),
        Some(serde_json::json!({
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "userData": paths::USER_DATA_DIR.to_string_lossy(),
            "conpty": conpty.as_ref().map(|path| path.to_string_lossy().to_string()),
            "migrationMs": migration_ms,
        })),
    );
    if cfg!(windows) && conpty.is_none() {
        // Sin ella la app arranca igual, pero en un Windows recortado las
        // pestañas se quedarán en blanco varios minutos antes de fallar. Ver
        // vendor/conpty/README.md.
        log_error!(
            "Falta conpty.dll junto al ejecutable: se usará el ConPTY del sistema, \
             que en algunos Windows no consigue arrancar la shell"
        );
    }

    let state_started = Instant::now();
    let app_state = std::sync::Arc::new(AppState::new());
    log_info!(
        "Estado inicial preparado",
        serde_json::json!({
            "durationMs": state_started.elapsed().as_millis(),
            "startupMs": startup_started.elapsed().as_millis(),
        })
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::tabs_list,
            commands::tabs_create,
            commands::tabs_close,
            commands::tabs_activate,
            commands::tabs_ready,
            commands::pty_input,
            commands::pty_resize,
            commands::env_list,
            commands::env_refresh,
            commands::env_switch,
            commands::settings_get,
            commands::settings_save,
            commands::settings_reset,
            commands::app_info,
            commands::log_frontend_error,
            commands::log_open_folder,
            commands_panels::scripts_list,
            commands_panels::scripts_list_here,
            commands_panels::scripts_choose_folder,
            commands_panels::scripts_choose_here_folder,
            commands_panels::scripts_pick_target,
            commands_panels::scripts_open,
            commands_panels::scripts_cd,
            commands_panels::scripts_run,
            commands_panels::scripts_pin,
            commands_panels::explorer_list,
            commands_panels::explorer_follow,
            commands_panels::explorer_create,
            commands_panels::explorer_open,
            commands_panels::explorer_rename,
            commands_panels::explorer_clip,
            commands_panels::explorer_paste,
            commands_panels::explorer_trash,
            commands_panels::explorer_cd,
            commands_panels::explorer_open_directory,
            commands_panels::explorer_open_directory_with,
            commands_install::install_list,
            commands_install::install_refresh,
            commands_install::install_run,
            commands_projects::projects_state_get,
            commands_projects::projects_downloaded,
            commands_projects::projects_cd,
            commands_projects::projects_lookup,
            commands_projects::projects_release,
            commands_projects::projects_download_release,
            commands_projects::projects_pin,
            commands_projects::projects_choose_folder,
            commands_projects::projects_open_github,
            commands_projects::projects_run,
            commands_update::update_check,
            commands_update::update_install,
        ])
        .setup(move |app| {
            let setup_started = Instant::now();
            let state = app.state::<std::sync::Arc<AppState>>();

            // La primera pestaña se crea antes de mostrar la ventana: su shell
            // ya está escribiendo el banner mientras el frontend monta el
            // xterm, y la salida se le entrega en cuanto avisa con `tabs_ready`.
            let tab_started = Instant::now();
            match state.default_environment() {
                Some(env) => {
                    state.tabs.create_tab(&app.handle().clone(), &env, None);
                }
                None => log_error!("No se detectó ninguna shell en el sistema"),
            }
            let first_tab_ms = tab_started.elapsed().as_millis();

            // Restos de una actualización anterior y, en segundo plano, si hay
            // una nueva publicada.
            commands_update::on_startup(&app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                window.set_title(identity::current().name)?;
                window.show()?;
                log_info!(
                    "Ventana inicial mostrada",
                    serde_json::json!({
                        "firstTabMs": first_tab_ms,
                        "setupMs": setup_started.elapsed().as_millis(),
                        "startupMs": startup_started.elapsed().as_millis(),
                    })
                );
                // En depuración las herramientas de desarrollo se abren solas:
                // sin ellas, un fallo del frontend se ve como una ventana en
                // negro y sin ninguna pista de por qué.
                #[cfg(debug_assertions)]
                window.open_devtools();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<std::sync::Arc<AppState>>() {
                    state.tabs.shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("no se pudo construir la aplicación")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<std::sync::Arc<AppState>>() {
                    state.tabs.shutdown();
                }
                session_files::cleanup();
                logger::banner(&format!("CIERRE {}", identity::current().name), None);
            }
        });
}

/// `api.ts` ocupa el sitio del antiguo `preload.js`: es el único punto del
/// frontend que conoce los nombres de los comandos. Un comando registrado aquí
/// y sin puente allí no lo puede llamar nadie, y el fallo no se ve hasta que
/// alguien va a escribir el panel que lo necesitaba.
#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    fn leer(relativo: &str) -> String {
        let raiz = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(raiz.join(relativo))
            .unwrap_or_else(|error| panic!("no se pudo leer {relativo}: {error}"))
    }

    /// Los nombres del bloque `generate_handler!` de este mismo archivo.
    fn comandos_registrados() -> Vec<String> {
        let fuente = leer("src/lib.rs");
        let inicio = fuente
            .find("tauri::generate_handler![")
            .expect("falta el bloque de comandos");
        let bloque = &fuente[inicio..];
        let fin = bloque.find("])").expect("el bloque de comandos no cierra");
        bloque[..fin]
            .lines()
            .filter_map(|linea| {
                let limpia = linea.trim().trim_end_matches(',');
                let (_, nombre) = limpia.rsplit_once("::")?;
                nombre
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                    .then(|| nombre.to_string())
            })
            .collect()
    }

    #[test]
    fn todo_comando_registrado_tiene_su_puente_en_api_ts() {
        let api = leer("../src/lib/api.ts");
        let comandos = comandos_registrados();
        assert!(comandos.len() > 30, "el bloque de comandos no se leyó bien");
        let sin_puente: Vec<&String> = comandos
            .iter()
            .filter(|nombre| !api.contains(&format!("'{nombre}'")))
            .collect();
        assert!(
            sin_puente.is_empty(),
            "comandos sin funcion en src/lib/api.ts: {sin_puente:?}"
        );
    }

    #[test]
    fn api_ts_no_invoca_comandos_que_el_backend_no_registra() {
        let api = leer("../src/lib/api.ts");
        let comandos = comandos_registrados();
        // Los nombres que api.ts le pasa a `invoke`, que son los unicos textos
        // entre comillas simples justo despues de un parentesis de apertura.
        let invocados: Vec<String> = api
            .match_indices("invoke")
            .filter_map(|(inicio, _)| {
                let resto = &api[inicio..];
                let abre = resto.find("('")? + 2;
                let cierra = resto[abre..].find('\'')? + abre;
                Some(resto[abre..cierra].to_string())
            })
            .collect();
        assert!(!invocados.is_empty());
        let inventados: Vec<&String> = invocados
            .iter()
            .filter(|nombre| !comandos.contains(nombre))
            .collect();
        assert!(
            inventados.is_empty(),
            "api.ts llama a comandos que no existen en el backend: {inventados:?}"
        );
    }
}
