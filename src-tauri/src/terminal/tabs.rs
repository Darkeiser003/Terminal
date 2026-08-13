//! Las pestañas de la ventana y su pty.
//!
//! Port de la gestión de pestañas de `electron/main.js`. Cada pestaña tiene su
//! propio pty; el frontend las distingue por `tabId`, que viaja en todos los
//! eventos y en todos los comandos.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::environments::Environment;
use crate::platform::traits::HostPlatform;
use crate::pty::{self, PtySession, SpawnConfig, Viewport};
use crate::stream::PtyEvent;
use crate::{paths, spawn_cwd};

/// Una sesión que se muere nada más nacer y con error no ha llegado a ser
/// usable: casi siempre es un entorno mal configurado (una distro WSL que no
/// arranca, un contenedor que sale al instante, un dispositivo ADB que rechaza
/// la shell). Ahí la pestaña se queda abierta con el código a la vista, porque
/// cerrarla haría desaparecer la única pista de qué ha pasado.
const FAILED_SESSION: Duration = Duration::from_millis(3000);

/// La salida del pty empieza a llegar en cuanto se spawnea, pero el frontend
/// puede no estar listo todavía para esa pestaña: en el primer arranque ni
/// siquiera se ha montado el componente, y en una pestaña nueva el xterm se
/// crea después de que `create_tab` devuelva. Sin esto, el banner y el primer
/// prompt de la shell se perderían.
///
/// El tope evita que el buffer crezca sin límite si el frontend nunca llega a
/// estar listo (p. ej. falla al cargar): se descartan los mensajes más
/// antiguos, conservando los recientes.
const MAX_PENDING_OUTPUT: usize = 500;

pub const MAX_PTY_INPUT_CHARS: usize = 4 * 1024 * 1024;

// ---- Eventos hacia el frontend ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEvent {
    pub tab_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEvent {
    pub tab_id: String,
    pub code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabIdEvent {
    pub tab_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabClosedEvent {
    pub tab_id: String,
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandNotFoundEvent {
    pub tab_id: String,
    pub suggestion: crate::command_not_found::ToolSuggestion,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvChangedEvent {
    pub tab_id: String,
    pub id: String,
    pub label: String,
}

/// Recorta una cola de texto a sus últimos `max` caracteres, sin partir un
/// carácter multibyte por la mitad.
fn trim_to_last_chars(buffer: &mut String, max: usize) {
    let length = buffer.chars().count();
    if length <= max {
        return;
    }
    let start = buffer
        .char_indices()
        .nth(length - max)
        .map(|(index, _)| index)
        .unwrap_or(0);
    buffer.drain(..start);
}

/// El gestor de paquetes de Windows de esta máquina, detectado una sola vez.
fn windows_package_manager() -> Option<&'static str> {
    if !crate::platform::host().is_windows() {
        return None;
    }
    static MANAGER: once_cell::sync::Lazy<Option<&'static str>> =
        once_cell::sync::Lazy::new(|| {
            crate::package_aliases::detect_windows_manager(&crate::path_env::is_tool_installed)
        });
    *MANAGER
}

/// La carpeta de scripts del usuario: la que haya elegido o la de fábrica.
pub fn scripts_folder() -> PathBuf {
    crate::settings::string_setting(&crate::settings::load_settings(), "scriptsFolder")
        .map(PathBuf::from)
        .unwrap_or_else(paths::default_scripts_dir)
}

/// Un alias por script detectado, con su comando de lanzamiento ya construido
/// para esta shell. Los scripts que no se pueden lanzar desde aquí (un `.ps1`
/// dentro de un contenedor, por ejemplo) se quedan fuera.
fn script_aliases_for(env: &Environment) -> Vec<crate::alias_profiles::ScriptAlias> {
    let categories = crate::scripts::types::default_categories();
    let scripts = crate::scripts::list_all_scripts(&scripts_folder(), &categories);
    let context = crate::scripts::LaunchContext {
        transport: Some(env.transport),
        host_root: env.host_root.clone(),
        container_root: env.container_root.clone(),
        windows_host: None,
    };
    let mut aliases: Vec<_> = crate::scripts::resolve_script_aliases(&scripts, env.kind)
        .into_iter()
        .filter_map(|(alias_name, script)| {
            let launch_command =
                crate::scripts::build_launch_command(script, env.kind, false, "", &context)?;
            Some(crate::alias_profiles::ScriptAlias {
                alias_name,
                launch_command,
            })
        })
        .collect();
    for alias in manual_aliases_from_text(&crate::preferences::current().manual_aliases_text) {
        if aliases
            .iter()
            .any(|known| known.alias_name == alias.alias_name)
        {
            continue;
        }
        aliases.push(alias);
    }
    aliases
}

fn manual_aliases_from_text(text: &str) -> Vec<crate::alias_profiles::ScriptAlias> {
    let mut aliases = Vec::new();
    for line in text.lines().take(200) {
        let Some((raw_name, raw_command)) = line.split_once('=') else {
            continue;
        };
        let name = raw_name.trim();
        let command = raw_command.trim();
        if name.is_empty() || command.is_empty() || name.len() > 40 || command.len() > 2048 {
            continue;
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        if aliases
            .iter()
            .any(|alias: &crate::alias_profiles::ScriptAlias| alias.alias_name == name)
        {
            continue;
        }
        aliases.push(crate::alias_profiles::ScriptAlias {
            alias_name: name.to_string(),
            launch_command: command.to_string(),
        });
    }
    aliases
}

/// El idioma con el que se generan los textos que escribe el backend.
fn active_language() -> String {
    let preference = crate::preferences::current().language;
    crate::i18n::resolve_language(&preference, &crate::i18n::system_locale())
}

/// Lo que se le entrega al frontend, ya sea al momento o desde la cola.
#[derive(Debug, Clone)]
enum Outbound {
    Data(String),
    Clear,
    Exit(Option<i32>),
}

impl Outbound {
    fn emit(self, app: &AppHandle, tab_id: &str) {
        let result = match self {
            Outbound::Data(data) => app.emit(
                "pty-data",
                DataEvent {
                    tab_id: tab_id.to_string(),
                    data,
                },
            ),
            Outbound::Clear => app.emit(
                "pty-clear",
                TabIdEvent {
                    tab_id: tab_id.to_string(),
                },
            ),
            Outbound::Exit(code) => app.emit(
                "pty-exit",
                ExitEvent {
                    tab_id: tab_id.to_string(),
                    code,
                },
            ),
        };
        if let Err(error) = result {
            log_debug!(
                "No se pudo emitir un evento de pestaña",
                serde_json::json!({ "tabId": tab_id, "error": error.to_string() })
            );
        }
    }
}

/// Lo que el frontend ve de una pestaña.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSummary {
    pub id: String,
    pub label: String,
    pub env_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabList {
    pub tabs: Vec<TabSummary>,
    pub active_tab_id: Option<String>,
}

// ---- Estado ----

/// Cuánta salida reciente se conserva para reconocer el prompt y los mensajes
/// de "comando no encontrado". El prompt cabe de sobra en 4 KiB; para el
/// directorio se guarda más porque un comando ruidoso puede empujarlo lejos.
const OUTPUT_BUFFER_CHARS: usize = 4_000;
const CWD_BUFFER_CHARS: usize = 12_000;

struct Tab {
    id: String,
    label: String,
    env_id: Option<String>,
    /// El entorno con el que corre ahora mismo. Hace falta entero para traducir
    /// las rutas del prompt y para saber a qué distro apunta una sugerencia de
    /// instalación.
    env: Option<Environment>,
    cwd: Option<PathBuf>,
    /// Sube en cada respawn. Una entrega que llega con una generación vieja es
    /// de un pty ya reemplazado y se descarta.
    generation: u64,
    session: Option<Arc<PtySession>>,
    /// El frontend aún no tiene un xterm para esta pestaña.
    ready: bool,
    pending: VecDeque<Outbound>,
    /// El título completo de la última limpieza. Repetirlo significa que ConPTY
    /// ha reemitido un título antiguo, no que la shell haya limpiado otra vez.
    last_clear_marker: Option<String>,
    /// Cola de salida reciente para el detector de "comando no encontrado".
    output_buffer: String,
    /// Cola más larga, para reconocer el prompt aunque haya scrolleado.
    cwd_buffer: String,
    /// El último comando que se reportó como no encontrado, para no sugerir lo
    /// mismo dos veces seguidas.
    last_missing_command: Option<String>,
    /// Carpeta que el panel «Aquí» está escaneando para esta pestaña.
    here_scripts_dir: Option<String>,
    /// La eligió el usuario a mano: entonces no la pisa el cwd de la shell.
    here_manual: bool,
    /// Carpeta que el explorador lateral enseña para esta pestaña.
    explorer_dir: Option<String>,
    /// La shell está esperando el Enter de una pausa, no un comando. Ver
    /// `write_command`.
    awaiting_pause: bool,
}

impl Tab {
    fn summary(&self) -> TabSummary {
        TabSummary {
            id: self.id.clone(),
            label: self.label.clone(),
            env_id: self.env_id.clone(),
        }
    }
}

#[derive(Default)]
struct Registry {
    /// En orden de creación: el frontend pinta las pestañas en este orden y el
    /// cierre de la activa pasa a la primera que quede.
    tabs: Vec<Tab>,
    active_tab_id: Option<String>,
    counter: u64,
}

impl Registry {
    fn find(&self, tab_id: &str) -> Option<&Tab> {
        self.tabs.iter().find(|tab| tab.id == tab_id)
    }

    fn find_mut(&mut self, tab_id: &str) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|tab| tab.id == tab_id)
    }
}

pub struct TabManager {
    registry: Mutex<Registry>,
    viewport: Mutex<Viewport>,
    viewport_saver: ViewportSaver,
}

impl TabManager {
    pub fn new(viewport: Viewport) -> TabManager {
        TabManager {
            registry: Mutex::new(Registry::default()),
            viewport: Mutex::new(viewport),
            viewport_saver: ViewportSaver::default(),
        }
    }

    pub fn viewport(&self) -> Viewport {
        *self.viewport.lock()
    }

    pub fn list(&self) -> TabList {
        let registry = self.registry.lock();
        TabList {
            tabs: registry.tabs.iter().map(Tab::summary).collect(),
            active_tab_id: registry.active_tab_id.clone(),
        }
    }

    pub fn active_tab_id(&self) -> Option<String> {
        self.registry.lock().active_tab_id.clone()
    }

    /// Directorio de la pestaña en uso: una pestaña nueva se abre donde estaba
    /// el usuario, no en su carpeta personal.
    pub fn active_cwd(&self) -> Option<PathBuf> {
        let registry = self.registry.lock();
        let active = registry.active_tab_id.as_deref()?;
        registry.find(active)?.cwd.clone()
    }

    pub fn activate(&self, tab_id: &str) {
        let mut registry = self.registry.lock();
        if registry.find(tab_id).is_some() {
            registry.active_tab_id = Some(tab_id.to_string());
        }
    }

    pub fn exists(&self, tab_id: &str) -> bool {
        self.registry.lock().find(tab_id).is_some()
    }

    /// El entorno con el que corre una pestaña ahora mismo.
    pub fn environment_of(&self, tab_id: &str) -> Option<Environment> {
        self.registry.lock().find(tab_id)?.env.clone()
    }

    pub fn cwd_of(&self, tab_id: &str) -> Option<PathBuf> {
        self.registry.lock().find(tab_id)?.cwd.clone()
    }

    pub fn has_session(&self, tab_id: &str) -> bool {
        self.registry
            .lock()
            .find(tab_id)
            .map(|tab| tab.session.is_some())
            .unwrap_or(false)
    }

    /// La carpeta que el panel «Aquí» escanea para esta pestaña. Si el usuario
    /// no ha elegido ninguna a mano, sigue al directorio de la shell.
    pub fn here_dir(&self, tab_id: &str) -> Option<String> {
        let mut registry = self.registry.lock();
        let tab = registry.find_mut(tab_id)?;
        let current_cwd = tab
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().to_string());
        // Si el prompt reveló un cwd nuevo desde la última búsqueda, se usa ese
        // directorio en vez de conservar una selección anterior obsoleta.
        if !tab.here_manual && current_cwd.is_some() && current_cwd != tab.here_scripts_dir {
            tab.here_scripts_dir = current_cwd.clone();
        }
        tab.here_scripts_dir.clone().or(current_cwd)
    }

    pub fn set_here_dir(&self, tab_id: &str, dir: &str, manual: bool) {
        let mut registry = self.registry.lock();
        if let Some(tab) = registry.find_mut(tab_id) {
            tab.here_scripts_dir = Some(dir.to_string());
            tab.here_manual = manual;
        }
    }

    /// La carpeta que el explorador lateral enseña. Sin una elegida, la de la
    /// shell.
    pub fn explorer_dir(&self, tab_id: &str) -> Option<String> {
        let registry = self.registry.lock();
        let tab = registry.find(tab_id)?;
        tab.explorer_dir.clone().or_else(|| {
            tab.cwd
                .as_ref()
                .map(|cwd| cwd.to_string_lossy().to_string())
        })
    }

    pub fn set_explorer_dir(&self, tab_id: &str, dir: &str) {
        let mut registry = self.registry.lock();
        if let Some(tab) = registry.find_mut(tab_id) {
            tab.explorer_dir = Some(dir.to_string());
        }
    }

    pub fn is_empty(&self) -> bool {
        self.registry.lock().tabs.is_empty()
    }

    /// El frontend ya creó el xterm de esta pestaña: se le entrega todo lo que
    /// el pty haya escrito mientras tanto (banner + primer prompt de la shell).
    pub fn mark_ready(&self, app: &AppHandle, tab_id: &str) {
        let pending = {
            let mut registry = self.registry.lock();
            let Some(tab) = registry.find_mut(tab_id) else {
                return;
            };
            tab.ready = true;
            std::mem::take(&mut tab.pending)
        };
        for message in pending {
            message.emit(app, tab_id);
        }
    }

    fn send(&self, app: &AppHandle, tab_id: &str, message: Outbound) {
        {
            let mut registry = self.registry.lock();
            let Some(tab) = registry.find_mut(tab_id) else {
                return;
            };
            if !tab.ready {
                tab.pending.push_back(message);
                if tab.pending.len() > MAX_PENDING_OUTPUT {
                    tab.pending.pop_front();
                }
                return;
            }
        }
        message.emit(app, tab_id);
    }

    /// Limpia el xterm antes de reemplazar un entorno. Debe emitirse antes de
    /// arrancar la nueva PTY: shells rápidas pueden imprimir su prompt antes de
    /// que llegue `env-changed`, mezclándolo con el historial anterior.
    pub fn clear_view(&self, app: &AppHandle, tab_id: &str) {
        self.send(app, tab_id, Outbound::Clear);
    }

    // ---- Ciclo de vida ----

    /// Crea una pestaña y arranca su pty. Devuelve `None` si la shell no pudo
    /// arrancar; en ese caso la pestaña sí queda creada, con el error a la
    /// vista, igual que en la versión Electron.
    pub fn create_tab(
        self: &Arc<Self>,
        app: &AppHandle,
        env: &Environment,
        initial_cwd: Option<&Path>,
    ) -> TabSummary {
        let tab_id = {
            let mut registry = self.registry.lock();
            registry.counter += 1;
            let id = format!("tab-{}", registry.counter);
            registry.tabs.push(Tab {
                id: id.clone(),
                label: env.label.clone(),
                env_id: None,
                env: None,
                cwd: None,
                generation: 0,
                session: None,
                ready: false,
                pending: VecDeque::new(),
                last_clear_marker: None,
                output_buffer: String::new(),
                cwd_buffer: String::new(),
                last_missing_command: None,
                here_scripts_dir: None,
                here_manual: false,
                explorer_dir: None,
                awaiting_pause: false,
            });
            registry.active_tab_id = Some(id.clone());
            id
        };

        self.spawn_pty(app, &tab_id, env, initial_cwd);
        let summary = self
            .registry
            .lock()
            .find(&tab_id)
            .map(Tab::summary)
            .unwrap_or(TabSummary {
                id: tab_id.clone(),
                label: env.label.clone(),
                env_id: Some(env.id.clone()),
            });
        log_info!(
            "Pestaña creada",
            serde_json::json!({ "tabId": summary.id, "envId": env.id })
        );
        summary
    }

    /// Arranca (o reemplaza) el pty de una pestaña.
    pub fn spawn_pty(
        self: &Arc<Self>,
        app: &AppHandle,
        tab_id: &str,
        env: &Environment,
        initial_cwd: Option<&Path>,
    ) -> bool {
        let generation = {
            let mut registry = self.registry.lock();
            let Some(tab) = registry.find_mut(tab_id) else {
                return false;
            };
            tab.generation += 1;
            // La sesión anterior se mata antes de nacer la nueva.
            if let Some(previous) = tab.session.take() {
                previous.kill();
            }
            tab.generation
        };

        let spawn_dir = spawn_cwd::resolve_spawn_cwd(initial_cwd, env, &paths::home_cwd());
        let viewport = self.viewport();

        let manager = Arc::clone(self);
        let app_for_data = app.clone();
        let tab_for_data = tab_id.to_string();

        let exit_manager = Arc::clone(self);
        let app_for_exit = app.clone();
        let tab_for_exit = tab_id.to_string();
        let started_at = Instant::now();

        let exe = env.exe.clone();
        let args = env.args.clone();
        let cwd = spawn_dir.clone();
        let (spawn_tx, spawn_rx) = std::sync::mpsc::sync_channel(1);
        let spawn_thread = std::thread::Builder::new()
            .name(format!("pty-spawn-{tab_id}"))
            .spawn(move || {
                let result = pty::spawn(
                    SpawnConfig {
                        exe: &exe,
                        args: &args,
                        cwd: &cwd,
                        viewport,
                    },
                    move |event| {
                        manager.on_pty_event(&app_for_data, &tab_for_data, generation, event)
                    },
                    move |code| {
                        exit_manager.on_pty_exit(
                            &app_for_exit,
                            &tab_for_exit,
                            generation,
                            code,
                            started_at.elapsed(),
                        );
                    },
                );
                let _ = spawn_tx.send(result);
            });

        let session = match spawn_thread {
            Err(error) => Err(anyhow::anyhow!("no se pudo crear el hilo PTY: {error}")),
            Ok(_) => match spawn_rx.recv_timeout(std::time::Duration::from_secs(3)) {
                Ok(result) => result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Si el sistema devuelve finalmente un PTY, se destruye:
                    // esta generación ya se ha comunicado como fallida.
                    let _ = std::thread::Builder::new()
                        .name(format!("pty-timeout-cleanup-{tab_id}"))
                        .spawn(move || {
                            if let Ok(Ok(late)) = spawn_rx.recv() {
                                late.kill();
                            }
                        });
                    Err(anyhow::anyhow!(
                        "la creación del PTY superó el límite de 3 segundos"
                    ))
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(anyhow::anyhow!(
                    "el hilo de creación del PTY terminó sin resultado"
                )),
            },
        };

        match session {
            Ok(session) => {
                let mut registry = self.registry.lock();
                let Some(tab) = registry.find_mut(tab_id) else {
                    // La pestaña se cerró mientras arrancaba la shell.
                    session.kill();
                    return false;
                };
                if tab.generation != generation {
                    session.kill();
                    return false;
                }
                tab.session = Some(Arc::new(session));
                tab.env_id = Some(env.id.clone());
                tab.env = Some(env.clone());
                tab.label = env.label.clone();
                tab.cwd = Some(spawn_dir.clone());
                tab.last_clear_marker = None;
                tab.output_buffer.clear();
                tab.cwd_buffer.clear();
                tab.last_missing_command = None;
                drop(registry);

                log_info!(
                    "pty spawneado",
                    serde_json::json!({
                        "tabId": tab_id,
                        "envId": env.id,
                        "label": env.label,
                        "exe": env.exe,
                        "generation": generation,
                        "cwd": spawn_dir.to_string_lossy(),
                    })
                );

                // Los alias y el banner van en un archivo que la shell carga
                // con una línea corta; si este entorno no puede leer los
                // temporales del host, el banner lo pinta la app.
                let t = crate::i18n::Translator::new(&active_language());
                let aliases = script_aliases_for(env);
                // La fachada devuelve siempre None fuera de Windows. Así el
                // alias NSudo no puede filtrarse a builds Linux ni siquiera si
                // existe un ejecutable con ese nombre en PATH.
                let nsudo_path = crate::platform::nsudo_path();
                let session_files = crate::session_files::write_session_files(
                    &crate::session_files::SessionRequest {
                        tab_id,
                        env,
                        script_aliases: &aliases,
                        app_name: crate::identity::current().name,
                        nsudo_path: nsudo_path.as_deref(),
                        windows_manager: windows_package_manager(),
                        manager_label: windows_package_manager()
                            .and_then(crate::package_aliases::windows_manager_by_id)
                            .map(|manager| manager.label),
                        show_banner: crate::preferences::current().show_system_banner,
                        // El ancho de la pestaña, para que el marco no salga
                        // más ancho que la casilla donde se va a leer.
                        banner: &crate::system_info::build_banner(
                            &env.label,
                            crate::identity::current().name,
                            viewport.cols,
                            self.list().tabs.len(),
                            &t,
                        ),
                    },
                    &t,
                );

                match session_files.init_command {
                    Some(command) => {
                        self.write(tab_id, &format!("{command}\r"));
                    }
                    None => {
                        if !session_files.banner_text.is_empty() {
                            self.send(app, tab_id, Outbound::Data(session_files.banner_text));
                        }
                    }
                }
                true
            }
            Err(error) => {
                // Invalida también los callbacks de una creación que haya
                // terminado tarde después del timeout.
                if let Some(tab) = self.registry.lock().find_mut(tab_id) {
                    if tab.generation == generation {
                        tab.generation += 1;
                    }
                }
                log_warn!(
                    "No se pudo spawnear el pty",
                    serde_json::json!({
                        "tabId": tab_id,
                        "envId": env.id,
                        "exe": env.exe,
                        "error": error.to_string(),
                    })
                );
                self.send(
                    app,
                    tab_id,
                    Outbound::Data(format!(
                        "\r\n\x1b[31m[No se pudo iniciar {}: {}]\x1b[0m\r\n",
                        env.label, error
                    )),
                );
                false
            }
        }
    }

    /// Lee la salida al vuelo para dos cosas que no se pueden preguntar al
    /// sistema: dónde está la shell (se reconoce su prompt) y si acaba de
    /// quejarse de un comando que no existe.
    fn inspect_output(&self, app: &AppHandle, tab_id: &str, data: &str) {
        let suggestion = {
            let mut registry = self.registry.lock();
            let Some(tab) = registry.find_mut(tab_id) else {
                return;
            };
            let Some(env) = tab.env.clone() else {
                return;
            };

            tab.output_buffer.push_str(data);
            trim_to_last_chars(&mut tab.output_buffer, OUTPUT_BUFFER_CHARS);
            tab.cwd_buffer.push_str(data);
            trim_to_last_chars(&mut tab.cwd_buffer, CWD_BUFFER_CHARS);

            let previous = tab
                .cwd
                .as_ref()
                .map(|cwd| cwd.to_string_lossy().to_string());
            if let Some(next) = crate::current_dir::detect_current_directory(
                &tab.cwd_buffer,
                &env,
                previous.as_deref(),
            ) {
                tab.cwd = Some(PathBuf::from(next));
            }

            let missing = crate::command_not_found::detect_missing_command(&tab.output_buffer);
            match missing {
                Some(missing) if tab.last_missing_command.as_deref() != Some(&missing) => {
                    tab.last_missing_command = Some(missing.clone());
                    crate::command_not_found::resolve_tool_suggestion(
                        &missing,
                        std::env::consts::OS,
                        &crate::command_not_found::SuggestionContext {
                            is_wsl: env.transport == crate::environments::Transport::Wsl,
                            distro: env.distro.clone(),
                        },
                    )
                }
                _ => None,
            }
        };

        if let Some(suggestion) = suggestion {
            log_info!(
                "Comando no encontrado",
                serde_json::json!({ "tabId": tab_id, "tool": suggestion.tool })
            );
            let _ = app.emit(
                "command-not-found",
                CommandNotFoundEvent {
                    tab_id: tab_id.to_string(),
                    suggestion,
                },
            );
        }
    }

    fn is_current(&self, tab_id: &str, generation: u64) -> bool {
        self.registry
            .lock()
            .find(tab_id)
            .map(|tab| tab.generation == generation)
            .unwrap_or(false)
    }

    fn on_pty_event(&self, app: &AppHandle, tab_id: &str, generation: u64, event: PtyEvent) {
        if !self.is_current(tab_id, generation) {
            return;
        }
        match event {
            PtyEvent::Data(data) => {
                if !data.is_empty() {
                    self.inspect_output(app, tab_id, &data);
                    self.send(app, tab_id, Outbound::Data(data));
                }
            }
            PtyEvent::Clear(marker) => {
                {
                    let mut registry = self.registry.lock();
                    let Some(tab) = registry.find_mut(tab_id) else {
                        return;
                    };
                    // Una reemisión del mismo título no es una limpieza nueva.
                    // Sin esto, cada proceso hijo que restaura el título de la
                    // consola al terminar borraba la salida que acababa de dejar.
                    if !marker.is_empty() && tab.last_clear_marker.as_deref() == Some(&marker) {
                        return;
                    }
                    tab.last_clear_marker = Some(marker);
                }
                // El marcador se emite antes del clear nativo: se elimina la
                // pantalla anterior antes de que ConPTY pinte banner/prompt.
                self.send(app, tab_id, Outbound::Clear);
            }
        }
    }

    fn on_pty_exit(
        self: &Arc<Self>,
        app: &AppHandle,
        tab_id: &str,
        generation: u64,
        code: Option<i32>,
        elapsed: Duration,
    ) {
        if !self.is_current(tab_id, generation) {
            log_debug!(
                "Salida ignorada de un pty reemplazado",
                serde_json::json!({ "tabId": tab_id, "code": code, "generation": generation })
            );
            return;
        }
        {
            let mut registry = self.registry.lock();
            if let Some(tab) = registry.find_mut(tab_id) {
                tab.session = None;
            }
        }
        log_info!(
            "pty finalizado",
            serde_json::json!({
                "tabId": tab_id,
                "code": code,
                "generation": generation,
                "elapsedMs": elapsed.as_millis() as u64,
            })
        );

        if code.unwrap_or(-1) != 0 && elapsed < FAILED_SESSION {
            self.send(app, tab_id, Outbound::Exit(code));
            return;
        }

        // El caso normal: el usuario escribió `exit` (o Ctrl+D). La pestaña se
        // cierra sola, como en cualquier terminal, y con la última se cierra la
        // aplicación.
        let reason = match code {
            Some(code) => format!("la shell terminó con código {code}"),
            None => "la shell terminó por una señal".to_string(),
        };
        self.close_tab(app, tab_id, &reason);
    }

    /// Cierre de una pestaña, tanto si lo pide el usuario con la ✕ como si la
    /// shell termina sola (`exit`, Ctrl+D, o el proceso que se cae). Las dos
    /// cosas dejan lo mismo: una pestaña sin sesión detrás, que no sirve para
    /// nada.
    pub fn close_tab(self: &Arc<Self>, app: &AppHandle, tab_id: &str, reason: &str) {
        let (removed, remaining, active_tab_id) = {
            let mut registry = self.registry.lock();
            let Some(index) = registry.tabs.iter().position(|tab| tab.id == tab_id) else {
                return;
            };
            let tab = registry.tabs.remove(index);
            if let Some(session) = tab.session {
                session.kill();
            }
            if registry.active_tab_id.as_deref() == Some(tab_id) {
                registry.active_tab_id = registry.tabs.first().map(|tab| tab.id.clone());
            }
            (true, registry.tabs.len(), registry.active_tab_id.clone())
        };
        if !removed {
            return;
        }
        crate::session_files::remove_for_tab(tab_id);
        log_info!(
            "Pestaña cerrada",
            serde_json::json!({ "tabId": tab_id, "reason": reason })
        );

        if remaining == 0 {
            // Sin pestañas no queda nada útil que mostrar: se cierra la
            // ventana, igual que la mayoría de terminales con pestañas.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            return;
        }

        // El frontend no sabe que la pestaña se cerró hasta que se lo
        // confirmamos (matar el pty no genera por sí solo una señal
        // distinguible de "cierre pedido por el usuario" vs. "el proceso
        // simplemente terminó").
        let _ = app.emit(
            "tab-closed",
            TabClosedEvent {
                tab_id: tab_id.to_string(),
                active_tab_id,
            },
        );
    }

    // ---- Entrada y tamaño ----

    fn session_of(&self, tab_id: &str) -> Option<Arc<PtySession>> {
        self.registry.lock().find(tab_id)?.session.clone()
    }

    /// Escribir en un pty cuyo proceso acaba de morir da error. Puede pasar en
    /// carreras normales: el usuario teclea justo cuando la shell sale, o un
    /// panel lanza un comando en una pestaña que se está cerrando. No es un
    /// fallo de la app.
    pub fn write(&self, tab_id: &str, data: &str) -> bool {
        let Some(session) = self.session_of(tab_id) else {
            return false;
        };
        match session.write(data) {
            Ok(()) => true,
            Err(error) => {
                log_warn!(
                    "No se pudo escribir en el pty (proceso terminado)",
                    serde_json::json!({ "tabId": tab_id, "error": error.to_string() })
                );
                false
            }
        }
    }

    /// Escribe un comando completo en nombre de un panel (dependencias,
    /// scripts, proyectos, explorador).
    ///
    /// Las acciones del panel de dependencias terminan en una pausa (`read`,
    /// `pause`) para que su salida se pueda leer. Mientras esa pausa sigue ahí,
    /// la shell no está esperando un comando sino una respuesta: el comando
    /// siguiente se consumía como tal y no llegaba a ejecutarse nunca. Se veía
    /// en la propia terminal, pegado al mensaje: "Pulsa Enter para volver a la
    /// terminal wine cmd /c ver". Un Enter previo cierra la pausa pendiente
    /// antes de escribir nada.
    pub fn write_command(&self, tab_id: &str, command: &str) -> bool {
        let pending = {
            let mut registry = self.registry.lock();
            match registry.find_mut(tab_id) {
                Some(tab) => std::mem::replace(&mut tab.awaiting_pause, false),
                None => return false,
            }
        };
        let prefix = if pending { "\r" } else { "" };
        self.write(tab_id, &format!("{prefix}{command}\r"))
    }

    /// Marca (o desmarca) que la pestaña se ha quedado esperando el Enter de
    /// una pausa.
    pub fn set_awaiting_pause(&self, tab_id: &str, awaiting: bool) {
        if let Some(tab) = self.registry.lock().find_mut(tab_id) {
            tab.awaiting_pause = awaiting;
        }
    }

    /// El usuario contesta a la pausa por su cuenta la mayoría de las veces: un
    /// Enter suyo la cierra igual que el que escribiría `write_command`.
    pub fn note_user_input(&self, tab_id: &str, data: &str) {
        if data.contains('\r') || data.contains('\n') {
            self.set_awaiting_pause(tab_id, false);
        }
    }

    /// El último tamaño medido por el frontend es con el que nacerán las
    /// sesiones siguientes. Se guarda aunque el pty ya no esté: sigue siendo el
    /// tamaño de la ventana.
    pub fn resize(&self, tab_id: &str, cols: u16, rows: u16) {
        let viewport = Viewport { cols, rows };
        *self.viewport.lock() = viewport;
        self.viewport_saver.remember(viewport);

        let Some(session) = self.session_of(tab_id) else {
            return;
        };
        if let Err(error) = session.resize(viewport) {
            log_debug!(
                "Resize PTY ignorado durante una transición",
                serde_json::json!({
                    "tabId": tab_id, "cols": cols, "rows": rows, "error": error.to_string()
                })
            );
        }
    }

    /// Mata todos los pty al cerrar la app, para no dejar shells huérfanas.
    pub fn shutdown(&self) {
        let mut registry = self.registry.lock();
        for tab in &mut registry.tabs {
            if let Some(session) = tab.session.take() {
                session.kill();
            }
        }
    }
}

/// Guardar el tamaño en cada evento de resize escribiría en disco decenas de
/// veces mientras se arrastra el borde de la ventana. Se retiene el último y se
/// escribe cuando el usuario para.
#[derive(Default)]
struct ViewportSaver {
    pending: Arc<Mutex<Option<Viewport>>>,
    scheduled: Arc<Mutex<bool>>,
}

const VIEWPORT_SAVE_DELAY: Duration = Duration::from_millis(800);

impl ViewportSaver {
    fn remember(&self, viewport: Viewport) {
        *self.pending.lock() = Some(viewport);
        let mut scheduled = self.scheduled.lock();
        if *scheduled {
            return;
        }
        *scheduled = true;
        drop(scheduled);

        let pending = Arc::clone(&self.pending);
        let flag = Arc::clone(&self.scheduled);
        std::thread::Builder::new()
            .name("viewport-saver".into())
            .spawn(move || {
                std::thread::sleep(VIEWPORT_SAVE_DELAY);
                let value = pending.lock().take();
                *flag.lock() = false;
                let Some(viewport) = value else { return };
                let mut patch = serde_json::Map::new();
                patch.insert("viewportCols".into(), viewport.cols.into());
                patch.insert("viewportRows".into(), viewport.rows.into());
                crate::settings::save_settings(&patch);
            })
            .ok();
    }
}

/// Límites del tamaño que acepta el backend, iguales a los de la versión
/// Electron. Un valor fuera de rango se ignora en vez de recortarse: viene de
/// una medición del frontend que ha salido mal.
pub fn valid_viewport(cols: i64, rows: i64) -> Option<Viewport> {
    if (1..=1000).contains(&cols) && (1..=500).contains(&rows) {
        Some(Viewport {
            cols: cols as u16,
            rows: rows as u16,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_tamano_se_rechaza_fuera_de_rango() {
        assert!(valid_viewport(80, 24).is_some());
        assert!(valid_viewport(1, 1).is_some());
        assert!(valid_viewport(1000, 500).is_some());
        assert!(valid_viewport(0, 24).is_none());
        assert!(valid_viewport(80, 0).is_none());
        assert!(valid_viewport(1001, 24).is_none());
        assert!(valid_viewport(80, 501).is_none());
        assert!(valid_viewport(-5, 24).is_none());
    }

    #[test]
    fn los_alias_manuales_se_validan_acotan_y_no_se_duplican() {
        let aliases = manual_aliases_from_text(
            "gs=git status\nmal nombre=echo no\ngs=echo duplicado\nvacio=\nserve=npm run dev",
        );
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases[0].alias_name, "gs");
        assert_eq!(aliases[0].launch_command, "git status");
        assert_eq!(aliases[1].alias_name, "serve");
    }

    #[test]
    fn la_cola_de_salida_descarta_lo_mas_antiguo() {
        let mut pending: VecDeque<Outbound> = VecDeque::new();
        for index in 0..(MAX_PENDING_OUTPUT + 10) {
            pending.push_back(Outbound::Data(index.to_string()));
            if pending.len() > MAX_PENDING_OUTPUT {
                pending.pop_front();
            }
        }
        assert_eq!(pending.len(), MAX_PENDING_OUTPUT);
        let primero = match pending.front() {
            Some(Outbound::Data(text)) => text.clone(),
            _ => panic!("se esperaba salida de texto"),
        };
        assert_eq!(primero, "10");
    }

    #[test]
    fn una_pestana_nueva_no_esta_lista_hasta_que_lo_diga_el_frontend() {
        let manager = TabManager::new(Viewport::default());
        let mut registry = manager.registry.lock();
        registry.tabs.push(Tab {
            id: "tab-1".into(),
            label: "cmd.exe".into(),
            env_id: Some("cmd".into()),
            env: None,
            cwd: None,
            generation: 0,
            session: None,
            ready: false,
            pending: VecDeque::new(),
            last_clear_marker: None,
            output_buffer: String::new(),
            cwd_buffer: String::new(),
            last_missing_command: None,
            here_scripts_dir: None,
            here_manual: false,
            explorer_dir: None,
            awaiting_pause: false,
        });
        assert!(!registry.find("tab-1").unwrap().ready);
        assert!(registry.find("tab-2").is_none());
    }

    #[test]
    fn el_resumen_solo_expone_lo_que_ve_el_frontend() {
        let tab = Tab {
            id: "tab-3".into(),
            label: "Windows PowerShell".into(),
            env_id: Some("powershell".into()),
            env: None,
            cwd: Some(PathBuf::from("/tmp")),
            generation: 2,
            session: None,
            ready: true,
            pending: VecDeque::new(),
            last_clear_marker: None,
            output_buffer: String::new(),
            cwd_buffer: String::new(),
            last_missing_command: None,
            here_scripts_dir: None,
            here_manual: false,
            explorer_dir: None,
            awaiting_pause: false,
        };
        let value = serde_json::to_value(tab.summary()).unwrap();
        assert_eq!(value["id"], serde_json::json!("tab-3"));
        assert_eq!(value["envId"], serde_json::json!("powershell"));
        assert!(value.get("cwd").is_none());
        assert!(value.get("generation").is_none());
    }
}
