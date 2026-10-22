//! LTerminal / WTerminal — backend.
//!
//! Migración de `electron/main.js` (Electron + node-pty) a Tauri 2 + Rust.
//! Cada módulo anota de qué archivo de la versión anterior viene, para poder
//! cotejarlos mientras dure la migración.

// Los tests unitarios se enlazan en un ejecutable propio y no heredan el
// manifiesto de Tauri. El recurso se prepara en `build.rs` y se enlaza solo
// cuando rustc compila este crate con `cfg(test)`, evitando duplicarlo en la
// aplicación normal.
#[cfg(all(test, windows))]
#[link(name = "windows-test.manifest", kind = "static")]
unsafe extern "C" {}

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
pub use config::{
    i18n, identity, install_dir, migration, paths, preferences, settings, single_file,
    toolchain_store,
};
pub use environments::{
    android as android_env, docker as docker_env, languages as language_env, wsl as wsl_env,
};
pub use explorer::{files as file_explorer, recycle, viewers as file_viewers};
pub use infrastructure::{path_env, process};
pub use packages::{
    actions as install_actions, aliases as package_aliases, command_not_found,
    commands as commands_install, ltools,
};
pub use projects::{commands as commands_projects, github};
pub use system::{info as system_info, virtualization};
pub use terminal::{
    aliases as alias_profiles, console_ui, current_dir, pty, semantic_zones, session_files,
    shell_paths, spawn_cwd, stream, tabs,
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

/// El smoke de Windows se inicia con `ShellExecute` porque el ejecutable pide
/// UAC. En ese camino Windows no conserva de forma fiable las variables de
/// entorno temporales del proceso que lanzó la prueba. Aceptamos los pocos
/// overrides de prueba como argumentos privados y los convertimos antes de
/// tocar cualquier `Lazy` de rutas o configuración.
fn apply_runtime_argument_overrides() {
    let mut args = std::env::args_os().skip(1);
    while let Some(raw) = args.next() {
        let argument = raw.to_string_lossy();
        let (key, inline_value) = argument
            .split_once('=')
            .map_or((argument.as_ref(), None), |(key, value)| (key, Some(value)));

        let variable = match key {
            "--wterminal-smoke-token" => Some("LTERMINAL_SMOKE_TOKEN"),
            "--wterminal-log-file" => Some("LTERMINAL_LOG_FILE"),
            "--wterminal-e2e-app-data-dir" => Some("LTERMINAL_E2E_APP_DATA_DIR"),
            _ => None,
        };
        if let Some(variable) = variable {
            let value = inline_value.map(str::to_owned).or_else(|| {
                args.next()
                    .map(|value| value.to_string_lossy().into_owned())
            });
            if let Some(value) = value.filter(|value| !value.is_empty()) {
                std::env::set_var(variable, value);
            }
            continue;
        }

        let variable = match key {
            "--wterminal-smoke-auto-exit" => Some("LTERMINAL_SMOKE_AUTO_EXIT"),
            "--wterminal-e2e-testing" => Some("LTERMINAL_E2E_TESTING"),
            "--wterminal-e2e-disable-admin" => Some("LTERMINAL_E2E_DISABLE_ADMIN"),
            "--wterminal-e2e-disable-path-auto" => Some("LTERMINAL_E2E_DISABLE_PATH_AUTO"),
            _ => None,
        };
        if let Some(variable) = variable {
            std::env::set_var(variable, "1");
        }
    }
}

/// Hilos del runtime asíncrono: cuatro por núcleo, entre 16 y 64.
///
/// Tauri ejecuta los comandos síncronos marcados `#[tauri::command(async)]`
/// dentro de los hilos de su runtime, que por defecto son tantos como
/// núcleos. Cada uno que espera (una medición de carpetas, una sonda con
/// timeout) bloquea uno; con ocho esperando a la vez la app dejaba de
/// atender cualquier comando asíncrono, también guardar las preferencias.
/// Los comandos largos van además a `spawn_blocking`; este margen evita que
/// cualquier otro que se alargue vuelva a dejar la interfaz sin respuesta.
fn async_worker_threads(cores: usize) -> usize {
    (cores.max(1) * 4).clamp(16, 64)
}

static ASYNC_RUNTIME: std::sync::OnceLock<tauri::async_runtime::TokioRuntime> =
    std::sync::OnceLock::new();

fn install_async_runtime() {
    let cores = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(4);
    let built = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(async_worker_threads(cores))
        .thread_name("wterminal-async")
        .enable_all()
        .build();
    match built {
        Ok(runtime) => {
            let runtime = ASYNC_RUNTIME.get_or_init(|| runtime);
            tauri::async_runtime::set(runtime.handle().clone());
        }
        // Sin runtime propio, Tauri crea el suyo de fábrica al primer uso.
        Err(error) => log_warn!(
            "No se pudo crear el runtime asíncrono ampliado",
            serde_json::json!({ "error": error.to_string() })
        ),
    }
}

/// «Iniciar siempre como administrador»: si está activado, esta copia no es
/// administrador, no es ya un relanzamiento y no es un E2E ni el smoke del
/// build (`StartElevation::should_relaunch`), se relanza con UAC. Devuelve si se lanzó la copia elevada (entonces esta termina); con el
/// aviso cancelado sigue abierta sin elevar.
#[cfg(windows)]
fn relaunch_elevated_on_start() -> bool {
    use crate::platform::windows_integration::{StartElevation, ELEVATED_RELAUNCH_ARG};
    let decision = StartElevation {
        relaunched: std::env::args().any(|argument| argument == ELEVATED_RELAUNCH_ARG),
        automated: ["LTERMINAL_E2E_TESTING", "LTERMINAL_E2E_DISABLE_ADMIN"]
            .iter()
            .any(|name| std::env::var(name).as_deref() == Ok("1")),
        start_as_admin: crate::preferences::current().start_as_admin,
        elevated: crate::platform::is_process_elevated(),
    };
    if !decision.should_relaunch() {
        return false;
    }
    match crate::platform::windows_integration::relaunch_elevated() {
        Ok(()) => {
            log_info!("Inicio como administrador: copia elevada lanzada");
            true
        }
        Err(error) => {
            log_warn!(
                "Inicio como administrador cancelado; se sigue sin elevar",
                serde_json::json!({ "error": error })
            );
            false
        }
    }
}

/// Si esta copia arrancó como administrador (para el log de arranque).
fn startup_elevated() -> bool {
    #[cfg(windows)]
    {
        crate::platform::is_process_elevated()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_async_runtime();
    apply_runtime_argument_overrides();
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
    #[cfg(windows)]
    if relaunch_elevated_on_start() {
        return;
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
            "elevated": cfg!(windows) && startup_elevated(),
        })),
    );
    #[cfg(target_os = "windows")]
    if std::env::var("LTERMINAL_WINE_HEADLESS_SMOKE").as_deref() != Ok("1")
        && !platform::webview2::ensure_runtime()
    {
        log_error!(
            "WebView2 Runtime no está disponible; el portable necesita el runtime de Microsoft o su bootstrapper (junto al ejecutable o embebido)"
        );
    }
    if platform::host().is_windows() && conpty.is_none() {
        // Sin ella la app arranca igual, pero en un Windows recortado las
        // pestañas se quedarán en blanco varios minutos antes de fallar. Ver
        // La explicación completa se mantiene en la sección «conpty.dll» del
        // README raíz, junto con los pasos de la build.
        log_error!(
            "Falta conpty.dll (junto al ejecutable o embebida en el portable): se usará \
             el ConPTY del sistema, que en algunos Windows no consigue arrancar la shell"
        );
    }

    // Las cachés centralizadas deben estar publicadas antes de la primera
    // pestaña y de las sondas de detección que arrancan con la app.
    toolchain_store::refresh_environment();

    // Temporales de ejecuciones anteriores que no se cerraron limpiamente.
    let _ = std::thread::Builder::new()
        .name("session-prune".into())
        .spawn(|| {
            session_files::prune_orphaned_sessions();
        });

    // Sincroniza el PATH antes de crear la primera pestaña y antes de que el
    // frontend pueda pedir el catálogo de dependencias. Esto incluye
    // WindowsApps, donde reside winget en instalaciones modernas, aunque el
    // lanzador no haya heredado esa entrada.
    if platform::host().is_windows() {
        let path_refresh = path_env::refresh_system_path();
        if path_refresh.changed {
            log_info!(
                "PATH del proceso actualizado al arrancar",
                serde_json::json!({ "added": path_refresh.added })
            );
        }
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

    if std::env::var("LTERMINAL_WINE_HEADLESS_SMOKE").as_deref() == Ok("1") {
        run_wine_headless_smoke(&app_state, startup_started);
        return;
    }

    let context = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    let context = {
        let mut context = context;
        let wine_smoke = std::env::var("LTERMINAL_WINE_SMOKE").as_deref() == Ok("1");
        if wine_smoke {
            if let Some(window) = context
                .config_mut()
                .app
                .windows
                .iter_mut()
                .find(|config| config.label == "main")
            {
                // Wine devuelve BadWindow al crear la ventana oculta y
                // desocultarla después. En esta validación se mantiene
                // visible desde el primer frame; Windows nativo conserva el
                // arranque oculto y su reveal sincronizado con el frontend.
                window.visible = true;
                // WebView2 reutiliza el proceso del navegador asociado a su
                // carpeta de datos. Un smoke anterior que terminó por un
                // crash de Wine puede dejar ese proceso vivo con otros flags
                // gráficos y hacer que la siguiente ejecución vuelva a
                // conectar con él. Un directorio por ejecución evita esa
                // contaminación y además respeta la regla de WebView2 de no
                // mezclar configuraciones distintas de argumentos.
                window.data_directory = Some(std::path::PathBuf::from(format!(
                    "EBWebView-WineSmoke-{}",
                    std::process::id()
                )));
            }
        }
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
                // contexto usa CoreWebView2EnvironmentOptions.
                let mut browser_args =
                    String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
                browser_args.push_str(" --remote-debugging-port=0");
                // El binario `e2e:build` es de depuración y se ejecuta en
                // máquinas recortadas/VM donde WebView2 puede abortar su
                // proceso GPU antes de abrir DevTools. Solo afecta a las
                // rutas explícitas de validación; las builds normales
                // conservan GPU.
                if cfg!(debug_assertions)
                    || std::env::var("LTERMINAL_E2E_DISABLE_GPU").as_deref() == Ok("1")
                {
                    browser_args.push_str(
                        " --disable-gpu --disable-gpu-compositing \
                         --disable-features=CalculateNativeWinOcclusion",
                    );
                }
                window.additional_browser_args = Some(browser_args);
                log_info!(
                    "Automatización WebView2 preparada",
                    serde_json::json!({ "remoteDebuggingPort": "dynamic", "mode": "webdriver" })
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
            commands::frontend_reveal,
            commands::pty_input,
            commands::internal_command_parse,
            commands::pty_resize,
            commands::pty_print_banner,
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
            platform::windows_integration::app_restart_as_admin,
            platform::windows_integration::app_restart_unelevated,
            platform::windows_integration::windows_run_as_admin_set,
            terminal::banner_image::banner_image_read,
            platform::path_integration::path_integration_status,
            toolchain_store::toolchain_store_status,
            terminal::shell_assist::shell_assist_status,
            terminal::links::terminal_open_link,
            toolchain_store::toolchain_store_external_sizes,
            toolchain_store::toolchain_store_clear_caches,
            platform::path_integration::path_integration_set,
            commands::app_info,
            commands::log_frontend_error,
            commands::log_frontend_performance,
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
            commands_install::install_catalog,
            commands_install::install_check,
            commands_install::install_refresh,
            commands_install::install_run,
            ltools::ltools_actions_list,
            ltools::ltools_action_run,
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
            commands_projects::github_cli_repositories,
            commands_projects::github_cli_terminal,
            projects::gh_manage::github_repo_details,
            projects::gh_manage::github_repo_edit,
            projects::gh_manage::github_releases,
            projects::gh_manage::github_release_assets,
            projects::gh_manage::github_release_create,
            projects::gh_manage::github_release_upload,
            projects::gh_manage::github_release_publish,
            projects::gh_manage::github_release_delete,
            projects::gh_manage::github_release_delete_asset,
            projects::gh_manage::github_pulls,
            projects::gh_manage::github_pull_create,
            projects::gh_manage::github_pull_merge,
            projects::gh_manage::github_issues,
            projects::gh_manage::github_issue_create,
            projects::gh_manage::github_issue_close,
            projects::gh_manage::github_runs,
            projects::gh_manage::github_run_rerun,
            projects::git_local::git_local_status,
            projects::git_local::git_local_commit,
            projects::git_local::git_local_branch,
            commands_projects::github_git_terminal,
            projects::gh_cli::github_cli_status,
            projects::gh_cli::github_cli_create,
            projects::gh_cli::github_cli_change,
            projects::gh_cli::github_cli_rename,
            projects::gh_cli::github_cli_delete,
            commands_update::update_check,
            commands_update::update_check_on_startup,
            commands_update::package_updates_check,
            commands_update::update_install,
        ])
        .setup(move |app| {
            let setup_started = Instant::now();
            let state = app.state::<std::sync::Arc<AppState>>();
            state.tabs.attach_app(app.handle());

            if let Err(error) = platform::path_integration::ensure_default_enabled() {
                log_warn!(
                    "No se pudo añadir WTerminal automáticamente al PATH",
                    serde_json::json!({ "error": error })
                );
            }
            // Las carpetas bin de las herramientas centralizadas, también en el
            // PATH del usuario mientras la integración esté activa.
            if let Err(error) = platform::path_integration::sync_tool_bins() {
                log_warn!(
                    "No se pudieron poner las carpetas de herramientas en el PATH",
                    serde_json::json!({ "error": error })
                );
            }

            // La primera pestaña se crea antes de mostrar la ventana: su shell
            // prepara aliases y el banner esencial para imprimirlo una sola vez
            // dentro del xterm cuando el frontend confirme el tamaño real.
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
                // Como Windows Terminal: el título dice si la ventana (y todas
                // sus pestañas) es administrador.
                #[cfg(windows)]
                let title = if crate::platform::is_process_elevated() {
                    format!(
                        "{} {}",
                        crate::i18n::Translator::new(&crate::i18n::active_language())
                            .t("app.adminTitle", "Administrador:"),
                        identity::current().name
                    )
                } else {
                    identity::current().name.to_string()
                };
                #[cfg(not(windows))]
                let title = identity::current().name.to_string();
                window.set_title(&title)?;
                log_info!(
                    "Ventana inicial preparada (aún oculta)",
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
            let _ = std::thread::Builder::new()
                .name("update-startup".into())
                .spawn(commands_update::on_startup);
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

/// Smoke funcional del ejecutable Windows sin WebView2. Ejecuta el arranque
/// real, envía un comando por stdin y exige recuperar su marcador por stdout
/// antes de aceptar la salida de la shell. No valida la ventana ni ConPTY:
/// Wine usa aquí el backend temporal de pipes.
fn run_wine_headless_smoke(state: &std::sync::Arc<AppState>, startup_started: Instant) {
    let Some(environment) = state.default_environment() else {
        log_error!("Smoke Wine headless sin shell disponible");
        std::process::exit(1);
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("C:\\"));
    let (exit_tx, exit_rx) = std::sync::mpsc::channel();
    let (output_tx, output_rx) = std::sync::mpsc::channel();
    let session = match pty::spawn(
        pty::SpawnConfig {
            exe: &environment.exe,
            args: &environment.args,
            cwd: &cwd,
            viewport: pty::Viewport::default(),
        },
        move |event| {
            if let crate::stream::PtyEvent::Data(text) = event {
                let _ = output_tx.send(text);
            }
        },
        move |code| {
            let _ = exit_tx.send(code);
        },
    ) {
        Ok(session) => session,
        Err(error) => {
            log_error!(
                "Smoke Wine headless no pudo crear la sesión",
                serde_json::json!({
                    "envId": environment.id,
                    "error": error.to_string(),
                })
            );
            std::process::exit(1);
        }
    };

    log_info!(
        "pty spawneado",
        serde_json::json!({
            "envId": environment.id,
            "exe": environment.exe,
            "mode": "wine-headless",
            "smokeToken": std::env::var("LTERMINAL_SMOKE_TOKEN").ok(),
        })
    );
    log_info!(
        "Smoke Wine headless preparado",
        serde_json::json!({
            "mode": "wine-headless",
            "startupMs": startup_started.elapsed().as_millis(),
            "smokeToken": std::env::var("LTERMINAL_SMOKE_TOKEN").ok(),
        })
    );

    let stdout_token = format!("LTERMINAL_WINE_STDOUT_{}", std::process::id());
    let stderr_token = format!("LTERMINAL_WINE_STDERR_{}", std::process::id());
    let shell_exe = environment.exe.to_ascii_lowercase();
    let command = if shell_exe.ends_with("cmd.exe") {
        // El prefijo @ evita confundir el eco interactivo de cmd con salida real.
        format!("@echo {stdout_token}\r\n@echo {stderr_token} 1>&2\r\nexit\r\n")
    } else if shell_exe.ends_with("powershell.exe") || shell_exe.ends_with("pwsh.exe") {
        format!(
            "[Console]::Out.WriteLine('{stdout_token}')\r\n[Console]::Error.WriteLine('{stderr_token}')\r\nexit 0\r\n"
        )
    } else {
        format!("printf '%s\\n' '{stdout_token}'; printf '%s\\n' '{stderr_token}' >&2; exit 0\n")
    };
    if let Err(error) = session.write(&command) {
        session.kill();
        log_error!(
            "Smoke Wine headless no pudo enviar el comando",
            serde_json::json!({ "error": error.to_string() })
        );
        std::process::exit(1);
    }

    let output_deadline = Instant::now() + std::time::Duration::from_secs(8);
    let mut stdout_observed = false;
    let mut stderr_observed = false;
    let mut observed_output = String::new();
    while !(stdout_observed && stderr_observed) {
        let remaining = output_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match output_rx.recv_timeout(remaining) {
            Ok(text) => {
                observed_output.push_str(&text);
                stdout_observed |= observed_output.contains(&stdout_token);
                stderr_observed |= observed_output.contains(&stderr_token);
            }
            Err(_) => break,
        }
    }
    if !(stdout_observed && stderr_observed) {
        session.kill();
        log_error!("Smoke Wine headless no recibió el marcador del comando");
        std::process::exit(1);
    }

    let exit_code = match exit_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Some(code)) if code == 0 => code,
        Ok(code) => {
            log_error!(
                "Smoke Wine headless terminó con código inesperado",
                serde_json::json!({ "exitCode": code })
            );
            std::process::exit(1);
        }
        Err(_) => {
            session.kill();
            log_error!("Smoke Wine headless no recibió la salida de la shell");
            std::process::exit(1);
        }
    };
    log_info!(
        "Smoke Wine headless comando ejecutado",
        serde_json::json!({
            "mode": "wine-headless",
            "stdoutTokenObserved": stdout_observed,
            "stderrTokenObserved": stderr_observed,
            "exitCode": exit_code,
            "smokeToken": std::env::var("LTERMINAL_SMOKE_TOKEN").ok(),
        })
    );
    log_info!(
        "Smoke Wine headless completado",
        serde_json::json!({
            "mode": "wine-headless",
            "smokeToken": std::env::var("LTERMINAL_SMOKE_TOKEN").ok(),
        })
    );
    std::process::exit(0);
}

/// `api.ts` ocupa el sitio del antiguo `preload.js`: es el único punto del
/// frontend que conoce los nombres de los comandos. Un comando registrado aquí
/// y sin puente allí no lo puede llamar nadie, y el fallo no se ve hasta que
/// alguien va a escribir el panel que lo necesitaba.
#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn el_runtime_asincrono_tiene_margen_para_comandos_que_esperan() {
        // 8 hilos (el Ryzen 5 del equipo de pruebas) → 32: ocho mediciones
        // esperando ya no dejan la app sin hilos.
        assert_eq!(super::async_worker_threads(8), 32);
        assert_eq!(super::async_worker_threads(1), 16);
        assert_eq!(super::async_worker_threads(0), 16);
        assert_eq!(super::async_worker_threads(64), 64);
    }

    #[test]
    fn los_comandos_de_almacenamiento_no_ocupan_hilos_del_runtime() {
        let source = leer("src/config/toolchain_store.rs");
        for command in [
            "pub async fn toolchain_store_status()",
            "pub async fn toolchain_store_external_sizes(",
            "pub async fn toolchain_store_clear_caches()",
        ] {
            assert!(source.contains(command), "{command}");
        }
        assert_eq!(
            source
                .matches("tauri::async_runtime::spawn_blocking(")
                .count(),
            3
        );
    }

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
