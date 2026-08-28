//! LTerminal / WinSlim Terminal — backend.
//!
//! Migración de `electron/main.js` (Electron + node-pty) a Tauri 2 + Rust.
//! Cada módulo anota de qué archivo de la versión anterior viene, para poder
//! cotejarlos mientras dure la migración.

#[macro_use]
#[path = "infrastructure/logger.rs"]
pub mod logger;
pub mod app;
pub mod config;
pub mod environments;
pub mod explorer;
pub mod infrastructure;
pub mod packages;
pub mod platform;
pub mod projects;
pub mod scripts;
pub mod system;
pub mod terminal;
pub mod updater;

// Compatibilidad interna durante la migración por dominios. Los consumidores
// nuevos deben importar el módulo de dominio; estos reexports evitan cambiar
// de golpe las APIs Tauri y los módulos ya probados.
pub use app::{commands, panel_commands as commands_panels, state};
pub use config::{i18n, identity, install_dir, migration, paths, preferences, settings};
pub use environments::{
    android as android_env, docker as docker_env, languages as language_env, wsl as wsl_env,
};
pub use explorer::{files as file_explorer, recycle, viewers as file_viewers};
pub use infrastructure::{path_env, process};
pub use packages::{
    actions as install_actions, aliases as package_aliases, command_not_found,
    commands as commands_install,
};
pub use projects::{commands as commands_projects, github};
pub use system::{info as system_info, virtualization};
pub use terminal::{
    aliases as alias_profiles, console_ui, current_dir, pty, session_files, shell_paths, spawn_cwd,
    stream, tabs,
};
pub use updater::{commands as commands_update, self_update};

use std::time::Instant;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::platform::traits::HostPlatform;
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
    if let Some(profile) = commands::profile_import_argument() {
        match commands::import_profile_file(&profile) {
            Ok(_) => log_info!(
                "Perfil portable importado antes del arranque",
                serde_json::json!({ "path": profile.to_string_lossy() })
            ),
            Err(error) => {
                eprintln!("No se pudo importar el perfil portable: {error}");
                log_error!(
                    "No se pudo importar el perfil portable antes del arranque",
                    serde_json::json!({
                        "path": profile.to_string_lossy(),
                        "error": error,
                    })
                );
                std::process::exit(1);
            }
        }
    }
    let open_path = commands::open_path_argument();
    let migration_ms = migration_started.elapsed().as_millis();
    system_info::prewarm_hardware_info();

    // `GithubClient` usa reqwest bloqueante porque las consultas de Proyectos
    // y del actualizador necesitan compartir caché y conexiones. Se inicializa
    // aquí, antes de entrar en el runtime de Tokio de Tauri: crear un cliente
    // reqwest bloqueante dentro de una tarea async hace que Tokio intente
    // destruir un runtime anidado y termina en pánico.
    let _ = github::shared_client();

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
    if platform::host().is_windows() && conpty.is_none() {
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

    let context = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    let context = {
        let mut context = context;
        if std::env::var("LTERMINAL_E2E_WEBDRIVER").as_deref() == Ok("1") {
            if let Some(window) = context
                .config_mut()
                .app
                .windows
                .iter_mut()
                .find(|config| config.label == "main")
            {
                // EdgeDriver transmite los argumentos mediante entorno, pero
                // WebView2 puede ignorarlos en un host elevado. Aplicarlos al
                // contexto usa CoreWebView2EnvironmentOptions y mantiene la
                // creación automática y estable de la ventana principal.
                window.additional_browser_args = Some(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                     --remote-debugging-port=0"
                        .into(),
                );
                log_info!(
                    "Automatización WebView2 preparada",
                    serde_json::json!({ "remoteDebuggingPort": "dynamic" })
                );
            }
        }
        context
    };

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
            commands::frontend_ready,
            commands::pty_input,
            commands::internal_command_parse,
            commands::pty_resize,
            commands::pty_refresh_banner,
            commands::env_list,
            commands::env_refresh,
            commands::env_switch,
            commands::settings_get,
            commands::settings_save,
            commands::settings_reset,
            commands::profile_export,
            commands::profile_import,
            config::plugins::plugins_list,
            config::plugins::plugins_set_enabled,
            config::plugins::plugins_install,
            config::plugins::plugins_remove,
            platform::windows_integration::windows_integration_status,
            platform::windows_integration::windows_integration_set,
            commands::app_info,
            commands::log_frontend_error,
            commands::log_frontend_performance,
            commands::log_open_folder,
            commands_panels::scripts_list,
            commands_panels::scripts_list_here,
            commands_panels::scripts_pick_target,
            commands_panels::scripts_open,
            commands_panels::scripts_cd,
            commands_panels::scripts_cd_directory,
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
                    let initial_cwd = open_path.as_deref().and_then(|path| {
                        if path.is_dir() {
                            Some(path)
                        } else {
                            path.parent()
                        }
                    });
                    state
                        .tabs
                        .create_tab(&app.handle().clone(), &env, initial_cwd);
                }
                None => log_error!("No se detectó ninguna shell en el sistema"),
            }
            let first_tab_ms = tab_started.elapsed().as_millis();

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
                // El inspector visual solo se abre cuando se solicita de forma
                // explícita. El E2E necesita el protocolo de DevTools disponible,
                // pero abrir su ventana roba el foco y puede hacer que EdgeDriver
                // cierre la sesión antes de crearla.
                #[cfg(debug_assertions)]
                if std::env::var_os("LTERMINAL_OPEN_DEVTOOLS").is_some() {
                    window.open_devtools();
                }
            }
            // La limpieza de una actualización anterior toca disco y después
            // se consulta GitHub. Ninguna de las dos cosas es necesaria para
            // abrir la primera terminal, así que queda fuera del hilo de setup
            // y empieza después de solicitar que se muestre la ventana.
            let update_app = app.handle().clone();
            let _ = std::thread::Builder::new()
                .name("update-startup".into())
                .spawn(move || commands_update::on_startup(&update_app));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<std::sync::Arc<AppState>>() {
                    state.tabs.shutdown();
                }
            }
        })
        .build(context)
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
