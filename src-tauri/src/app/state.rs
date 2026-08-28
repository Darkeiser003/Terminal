//! El estado compartido de la aplicación.
//!
//! En la versión Electron esto era el `windowState` de `main.js`: un objeto por
//! ventana con sus pestañas, su inventario de entornos y su último tamaño
//! medido. Aquí hay una sola ventana, así que es un único `State` que Tauri
//! inyecta en cada comando.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

use crate::environments::{self, Environment, Inventory};
use crate::platform::traits::HostPlatform;
use crate::preferences;
use crate::pty::Viewport;
use crate::tabs::TabManager;

pub struct AppState {
    pub tabs: Arc<TabManager>,
    /// Base monotónica para medir el camino hasta la primera terminal sin
    /// consultar relojes del sistema ni afectar al comportamiento.
    startup_started: Instant,
    inventory: Mutex<Option<Inventory>>,
    /// Ya se lanzó la detección completa. Solo hace falta una vez por arranque:
    /// las siguientes las pide el usuario con el botón de refrescar.
    full_detection_started: Mutex<bool>,
    /// Los archivos que el último escaneo visible dejó en el panel.
    ///
    /// Es la lista blanca de lo que se puede ejecutar o abrir: el frontend
    /// manda una ruta, y solo se atiende si salió de un escaneo que hizo el
    /// propio backend. Sin esto, una inyección en el frontend podría pedir que
    /// se lanzara cualquier archivo del disco.
    allowed_items: Mutex<HashMap<String, crate::scripts::ScriptEntry>>,
    /// Lo que el explorador tiene copiado o cortado. Lo recuerda el backend, no
    /// el frontend, para que la ruta de origen sea siempre una que se validó
    /// contra la carpeta abierta.
    clipboard: Mutex<Option<ClipboardItem>>,
    /// Lo que el panel de dependencias enseñó la última vez.
    ///
    /// El frontend manda solo el id de la acción, nunca su comando: lo que se
    /// ejecuta tiene que ser exactamente lo que el backend generó y filtró para
    /// este sistema.
    install_actions: Mutex<Option<Vec<crate::install_actions::InstallAction>>>,
    /// Los repositorios que el panel de Proyectos ha llegado a enseñar.
    ///
    /// Es la lista blanca de sobre qué se puede consultar o clonar: el frontend
    /// manda un `owner/repo`, y solo se atiende si salió de una consulta que
    /// hizo el propio backend.
    allowed_repositories: Mutex<HashMap<String, crate::github::Repository>>,
    /// La última release que se enseñó. La descarga solo acepta adjuntos de
    /// esta, nunca una URL que llegue del frontend.
    pending_release: Mutex<Option<(String, crate::github::Release)>>,
    /// Impide que varios comandos que leen el mismo árbol compitan por el
    /// disco. El token permite cancelar el recorrido anterior cuando llega
    /// una petición más reciente (cambiar filtros, profundidad o carpeta).
    script_scan_lock: Mutex<()>,
    script_scan_generation: Arc<AtomicU64>,
}

#[derive(Debug, Clone)]
pub struct ClipboardItem {
    pub path: String,
    /// `true` = cortar (mover), `false` = copiar.
    pub cut: bool,
}

impl AppState {
    pub fn new() -> AppState {
        // El tamaño de la última sesión: la primera pestaña nace ya con él en
        // vez de escribir su banner a 80x24 y tener que reflujarlo al medir.
        let prefs = preferences::current();
        let viewport = Viewport {
            cols: prefs.viewport_cols.clamp(1, 1000) as u16,
            rows: prefs.viewport_rows.clamp(1, 500) as u16,
        };
        AppState {
            tabs: Arc::new(TabManager::new(viewport)),
            startup_started: Instant::now(),
            inventory: Mutex::new(None),
            full_detection_started: Mutex::new(false),
            allowed_items: Mutex::new(HashMap::new()),
            clipboard: Mutex::new(None),
            install_actions: Mutex::new(None),
            allowed_repositories: Mutex::new(HashMap::new()),
            pending_release: Mutex::new(None),
            script_scan_lock: Mutex::new(()),
            script_scan_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Marca el comienzo de una petición de escaneo. Solo la petición con el
    /// token más nuevo puede seguir recorriendo el disco.
    pub fn begin_script_scan(&self) -> u64 {
        self.script_scan_generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn script_scan_guard(&self) -> MutexGuard<'_, ()> {
        self.script_scan_lock.lock()
    }

    pub fn script_scan_generation(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.script_scan_generation)
    }

    pub fn script_scan_is_current(&self, request: u64) -> bool {
        self.script_scan_generation.load(Ordering::Relaxed) == request
    }

    /// Añade a la lista blanca sin borrar lo anterior: el panel alterna entre
    /// los anclados y el resultado de una búsqueda, y las dos vistas siguen
    /// siendo válidas.
    ///
    /// Una búsqueda pública puede devolver hasta 100 repositorios: el tope evita
    /// conservar indefinidamente perfiles consultados hace mucho.
    pub fn remember_repositories<'a>(
        &self,
        repositories: impl Iterator<Item = &'a crate::github::Repository>,
    ) {
        let mut allowed = self.allowed_repositories.lock();
        for repository in repositories {
            allowed.insert(repository.full_name.to_lowercase(), repository.clone());
        }
        if allowed.len() > 500 {
            allowed.clear();
        }
    }

    pub fn visible_repository(&self, full_name: &str) -> Option<crate::github::Repository> {
        self.allowed_repositories
            .lock()
            .get(&full_name.to_lowercase())
            .cloned()
    }

    pub fn remember_release(&self, full_name: &str, release: &crate::github::Release) {
        *self.pending_release.lock() = Some((full_name.to_string(), release.clone()));
    }

    pub fn pending_release(&self) -> Option<(String, crate::github::Release)> {
        self.pending_release.lock().clone()
    }

    pub fn remember_install_actions(&self, actions: &[crate::install_actions::InstallAction]) {
        *self.install_actions.lock() = Some(actions.to_vec());
    }

    pub fn install_actions(&self) -> Option<Vec<crate::install_actions::InstallAction>> {
        self.install_actions.lock().clone()
    }

    /// Registra lo que el panel acaba de enseñar. Reemplaza la lista anterior:
    /// lo que ya no se ve, ya no se puede lanzar.
    pub fn remember_visible_items(&self, items: &[crate::scripts::ScriptEntry]) {
        let mut allowed = self.allowed_items.lock();
        allowed.clear();
        for item in items {
            allowed.insert(item.path.clone(), item.clone());
        }
    }

    /// Añade a la lista blanca sin borrar lo anterior: la Biblioteca y «Aquí»
    /// son dos vistas del mismo panel y el usuario puede alternar entre ellas.
    pub fn allow_visible_items(&self, items: &[crate::scripts::ScriptEntry]) {
        let mut allowed = self.allowed_items.lock();
        for item in items {
            allowed.insert(item.path.clone(), item.clone());
        }
    }

    /// Recupera un archivo de la lista blanca, comprobando además que sigue
    /// existiendo como archivo.
    pub fn visible_item(&self, path: &str) -> Option<crate::scripts::ScriptEntry> {
        // Un tope de longitud antes de tocar el disco: una ruta más larga que
        // el máximo de Windows no puede ser una entrada real del panel.
        if path.is_empty() || path.len() > 32_767 {
            return None;
        }
        let item = self.allowed_items.lock().get(path)?.clone();
        std::path::Path::new(&item.path).is_file().then_some(item)
    }

    pub fn set_clipboard(&self, path: &str, cut: bool) {
        *self.clipboard.lock() = Some(ClipboardItem {
            path: path.to_string(),
            cut,
        });
    }

    pub fn take_clipboard(&self) -> Option<ClipboardItem> {
        self.clipboard.lock().clone()
    }

    pub fn clear_clipboard(&self) {
        *self.clipboard.lock() = None;
    }

    /// El inventario de entornos. La primera vez detecta solo las shells
    /// nativas: la ventana inicial no espera a que arranquen distros WSL en
    /// frío ni el daemon de Docker.
    pub fn inventory(&self) -> Inventory {
        let mut cache = self.inventory.lock();
        if cache.is_none() {
            *cache = Some(environments::detect_environments(true));
        }
        cache.clone().unwrap_or_default()
    }

    pub fn environments(&self) -> Vec<Environment> {
        let hidden = preferences::current().hidden_environment_ids;
        let hidden: std::collections::HashSet<&str> =
            hidden.split(',').filter(|id| !id.is_empty()).collect();
        self.inventory()
            .envs
            .into_iter()
            .filter(|env| !hidden.contains(env.id.as_str()))
            .collect()
    }

    /// Vuelve a detectar los entornos desde cero, esta vez con todo: WSL,
    /// Docker, ADB e intérpretes de lenguajes.
    pub fn refresh_environments(&self) -> Inventory {
        crate::path_env::clear_which_cache();
        let detected = environments::detect_environments(false);
        *self.inventory.lock() = Some(detected.clone());
        let hidden = preferences::current().hidden_environment_ids;
        let hidden: std::collections::HashSet<&str> =
            hidden.split(',').filter(|id| !id.is_empty()).collect();
        let mut visible = detected;
        visible.envs.retain(|env| !hidden.contains(env.id.as_str()));
        visible
    }

    /// Lanza la detección completa en segundo plano y avisa al frontend cuando
    /// termina. La lista de entornos puede crecer sola después del arranque
    /// (p. ej. cuando Docker termina de arrancar y aparecen sus imágenes).
    pub fn start_full_detection(self: &Arc<Self>, app: &AppHandle) {
        {
            let mut started = self.full_detection_started.lock();
            if *started {
                return;
            }
            *started = true;
        }
        log_info!(
            "Primera terminal preparada; se programa el inventario completo",
            serde_json::json!({
                "afterStateMs": self.startup_started.elapsed().as_millis(),
                "deferredMs": FULL_DETECTION_DEFER,
            })
        );
        let state = Arc::clone(self);
        let app = app.clone();
        std::thread::Builder::new()
            .name("env-detect".into())
            .spawn(move || {
                // Dar un pequeño margen al WebView para montar el xterm y a
                // la primera shell para mostrar su prompt. Las sondas de WSL,
                // Docker y ADB pueden consumir CPU/IO durante varios segundos
                // y no deben competir con abrir una segunda pestaña.
                std::thread::sleep(std::time::Duration::from_millis(FULL_DETECTION_DEFER));
                let started = Instant::now();
                maybe_start_docker_on_windows();
                let inventory = state.refresh_environments();
                log_info!(
                    "Inventario de entornos completo",
                    serde_json::json!({
                        "envs": inventory.envs.len(),
                        "dockerReady": inventory.docker_daemon_ready,
                        "androidDevices": inventory.android_device_count,
                        "durationMs": started.elapsed().as_millis(),
                    })
                );
                let _ = app.emit("envs-updated", inventory);
            })
            .ok();
    }

    pub fn environment_by_id(&self, env_id: &str) -> Option<Environment> {
        self.environments().into_iter().find(|env| env.id == env_id)
    }

    /// El entorno con el que nace una pestaña sin elección explícita: el
    /// preferido por el usuario si sigue existiendo, si no el de la plataforma.
    pub fn default_environment(&self) -> Option<Environment> {
        let envs = self.environments();
        let preferred = preferences::current().default_environment_id;
        if !preferred.is_empty() {
            if let Some(found) = envs.iter().find(|env| env.id == preferred && env.available) {
                return Some(found.clone());
            }
        }
        let default_id = environments::default_env_id(&envs)?;
        envs.into_iter().find(|env| env.id == default_id)
    }
}

const FULL_DETECTION_DEFER: u64 = 750;

/// La preferencia de arranque automático solo puede actuar de forma segura en
/// Windows: allí Docker Desktop es una aplicación de usuario que se puede
/// lanzar sin pedir privilegios. En Linux Docker es un daemon del sistema y
/// `systemctl` requiere autorización explícita del usuario; nunca se intenta
/// ejecutar Docker Desktop ni elevar privilegios desde el arranque.
fn maybe_start_docker_on_windows() {
    let preferences = preferences::current();
    if !preferences.auto_start_docker
        || !crate::platform::host().is_windows()
        || !crate::path_env::is_tool_installed("docker")
    {
        return;
    }

    if crate::docker_env::is_daemon_ready(crate::docker_env::DEFAULT_TIMEOUT) {
        return;
    }

    let start = Instant::now();
    log_info!(
        "Docker no responde; se intentará iniciar Docker Desktop en Windows",
        serde_json::json!({ "platform": "windows" })
    );
    match crate::docker_env::start_docker_daemon() {
        crate::docker_env::StartResult::Started { via } => {
            let ready = crate::docker_env::wait_for_daemon(
                std::time::Duration::from_secs(60),
                std::time::Duration::from_millis(750),
            );
            log_info!(
                "Arranque de Docker Desktop finalizado",
                serde_json::json!({
                    "via": via,
                    "ready": ready,
                    "durationMs": start.elapsed().as_millis(),
                })
            );
        }
        crate::docker_env::StartResult::NotStarted { reason } => {
            log_warn!(
                "No se pudo iniciar Docker Desktop automáticamente",
                serde_json::json!({
                    "reason": reason,
                    "durationMs": start.elapsed().as_millis(),
                })
            );
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        AppState::new()
    }
}
