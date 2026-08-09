//! Qué shells/entornos hay disponibles en el sistema del usuario, para poblar
//! el selector de entorno y decidir cómo traducir los alias.
//!
//! Port de `electron/main/shellDetect.js`. Las shells nativas se detectan aquí;
//! WSL, Docker, ADB y los intérpretes de lenguajes los aportan `wsl_env`,
//! `docker_env`, `android_env` y `language_env`, y `detect_environments` los
//! junta todos.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::path_env::which;
use crate::wsl_env;

/// Cómo se llega hasta la shell. Determina si las rutas del host valen dentro
/// de ella y si se le pueden pasar archivos de inicialización.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// Se ejecuta en el propio sistema: las rutas del host valen tal cual.
    Native,
    /// Git Bash: el host se ve como `/c/...`.
    Msys,
    /// `wsl.exe`: el host se ve como `/mnt/c/...`.
    Wsl,
    /// Dentro de un contenedor: no comparte el sistema de archivos del host.
    Docker,
    /// `adb shell`: tampoco lo comparte.
    Android,
    /// `wine cmd`: las unidades se ven como `Z:\`.
    Wine,
}

impl Transport {
    /// Docker, ADB y Wine no llegan a los temporales del host: allí el banner
    /// lo escribe la app en el xterm y no se intenta cargar inicialización
    /// ninguna.
    pub fn loads_host_files(self) -> bool {
        matches!(self, Transport::Native | Transport::Msys | Transport::Wsl)
    }
}

/// La familia de sintaxis de la shell, que decide cómo se escriben sus alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Cmd,
    Powershell,
    Bash,
    Zsh,
    Fish,
    Sh,
    /// Un intérprete interactivo de lenguaje (Python, Node, irb...). No es una
    /// shell: no admite alias ni comandos, y quien quiera ejecutar algo tiene
    /// que buscarse una pestaña de verdad.
    Repl,
    /// La shell de un dispositivo Android. No es ninguna de las familias
    /// conocidas (allí la shell es mksh), así que tampoco recibe alias.
    Android,
}

impl ShellKind {
    pub fn from_name(name: &str) -> ShellKind {
        match name {
            "cmd" => ShellKind::Cmd,
            "powershell" | "pwsh" => ShellKind::Powershell,
            "zsh" => ShellKind::Zsh,
            "fish" => ShellKind::Fish,
            "sh" => ShellKind::Sh,
            _ => ShellKind::Bash,
        }
    }
}

pub const SYSTEM_SHELLS_GROUP: &str = "Shells del sistema";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub label: String,
    pub kind: ShellKind,
    pub transport: Transport,
    pub exe: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Apartado del desplegable. Las shells del sistema van todas al mismo,
    /// separadas de Docker y de ADB.
    pub group: String,
    /// Nombre del binario cuando no coincide con `kind` (`pwsh` -> powershell).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Distribución WSL a la que pertenece, si viene de ahí.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    /// Aviso que se pinta en amarillo bajo el banner de la pestaña.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Directorio propio del entorno, cuando no puede heredar el del host
    /// (Docker monta una carpeta fija).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_host_cwd: Option<String>,
    /// A qué carpeta del host corresponde el `~` de esta shell. Sin esto, un
    /// prompt que enseñe `~` no se puede traducir a una ruta navegable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_home: Option<String>,
    /// Los dos extremos de la carpeta que Docker monta dentro del contenedor:
    /// qué se ve desde el host y en qué punto del contenedor aparece.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_root: Option<String>,
    /// Aparece en el selector pero no se puede abrir todavía: un dispositivo
    /// Android sin autorizar, por ejemplo. Verlo con su estado es más útil que
    /// no verlo, y el motivo va en `note`.
    #[serde(default = "yes")]
    pub available: bool,
    /// No sirve como "la shell del sistema" para lanzar scripts del panel: se
    /// elige a mano desde el selector, nunca automáticamente.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_auto_select: bool,
    /// Es un intérprete de lenguaje, no una shell. Ver `ShellKind::Repl`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repl: bool,
    /// Qué lenguaje, cuando `repl` es cierto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

// Los entornos se construyen desde cinco módulos distintos y casi todos sus
// campos son opcionales. Con `Default` cada uno rellena solo lo suyo y
// `..Default::default()` cubre el resto, en vez de repetir una docena de
// `None` en cada sitio.
impl Default for Environment {
    fn default() -> Self {
        Environment {
            id: String::new(),
            label: String::new(),
            kind: ShellKind::Bash,
            transport: Transport::Native,
            exe: String::new(),
            args: Vec::new(),
            group: SYSTEM_SHELLS_GROUP.to_string(),
            shell: None,
            distro: None,
            note: None,
            initial_host_cwd: None,
            host_home: None,
            host_root: None,
            container_root: None,
            available: true,
            no_auto_select: false,
            repl: false,
            language: None,
        }
    }
}

fn yes() -> bool {
    true
}

impl Environment {
    pub fn new(id: &str, label: &str, kind: ShellKind, exe: &str, args: &[&str]) -> Environment {
        Environment {
            id: id.to_string(),
            label: label.to_string(),
            kind,
            exe: exe.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            ..Default::default()
        }
    }
}

/// Windows incluye varios lanzadores llamados `bash.exe` (WSL antiguo,
/// utilidades de terceros, etc.). Solo una ruta que pertenezca a una
/// instalación real de Git for Windows debe usar el transporte MSYS (`/c/...`).
/// Confundir el lanzador de WSL con Git Bash producía rutas inválidas dentro de
/// Ubuntu, donde el mismo archivo vive bajo `/mnt/c/...`.
pub fn is_git_bash_path(candidate: &str) -> bool {
    if candidate.is_empty() {
        return false;
    }
    let normalized = candidate.replace('/', "\\").to_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
}

pub fn find_git_bash() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key) {
            let root = Path::new(&root);
            candidates.push(root.join("Git").join("bin").join("bash.exe"));
            candidates.push(root.join("Git").join("usr").join("bin").join("bash.exe"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let programs = Path::new(&local).join("Programs").join("Git");
        candidates.push(programs.join("bin").join("bash.exe"));
        candidates.push(programs.join("usr").join("bin").join("bash.exe"));
    }
    candidates.extend(which("bash.exe"));
    candidates.extend(which("bash"));

    candidates.into_iter().find(|candidate| {
        candidate.to_str().map(is_git_bash_path).unwrap_or(false) && candidate.exists()
    })
}

fn detect_windows_shells() -> Vec<Environment> {
    let mut envs = Vec::new();

    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    envs.push(Environment::new(
        "cmd",
        "cmd.exe",
        ShellKind::Cmd,
        &comspec,
        &[],
    ));

    if let Some(ps5) = which("powershell.exe").or_else(|| which("powershell")) {
        envs.push(Environment::new(
            "powershell",
            "Windows PowerShell",
            ShellKind::Powershell,
            &ps5.to_string_lossy(),
            &["-NoLogo"],
        ));
    }

    if let Some(ps7) = which("pwsh.exe").or_else(|| which("pwsh")) {
        envs.push(Environment::new(
            "pwsh",
            "PowerShell 7",
            ShellKind::Powershell,
            &ps7.to_string_lossy(),
            &["-NoLogo"],
        ));
    }

    if let Some(git_bash) = find_git_bash() {
        let mut env = Environment::new(
            "gitbash",
            "Git Bash · bash",
            ShellKind::Bash,
            &git_bash.to_string_lossy(),
            &["--login", "-i"],
        );
        env.transport = Transport::Msys;
        env.shell = Some("bash".to_string());
        envs.push(env);
    }

    envs
}

fn detect_unix_shells() -> Vec<Environment> {
    let mut envs = Vec::new();
    let defs: [(&str, ShellKind, &[&str]); 5] = [
        ("bash", ShellKind::Bash, &["-i"]),
        ("zsh", ShellKind::Zsh, &["-i"]),
        ("fish", ShellKind::Fish, &["-i"]),
        ("sh", ShellKind::Sh, &["-i"]),
        ("pwsh", ShellKind::Powershell, &["-NoLogo"]),
    ];

    for (name, kind, args) in defs {
        let Some(exe) = which(name) else { continue };
        // Para bash/zsh/fish/sh el nombre y el tipo coinciden: "fish · fish" no
        // aporta nada, así que solo se desdobla cuando de verdad son cosas
        // distintas (pwsh -> PowerShell).
        let label = if name == "pwsh" {
            "PowerShell · pwsh".to_string()
        } else {
            name.to_string()
        };
        let mut env = Environment::new(name, &label, kind, &exe.to_string_lossy(), args);
        env.shell = Some(name.to_string());
        envs.push(env);
    }

    // Wine trae su propio cmd.exe: es la única forma de abrir una sesión CMD
    // fuera de Windows, y el panel ya ofrece instalarlo desde "Compatibilidad
    // Windows". Si está, aparece como entorno igual que cualquier shell.
    if let Some(wine) = which("wine") {
        let mut env = Environment::new(
            "wine-cmd",
            "cmd.exe · Wine",
            ShellKind::Cmd,
            &wine.to_string_lossy(),
            &["cmd"],
        );
        env.transport = Transport::Wine;
        env.no_auto_select = true;
        env.note = Some(
            "CMD proporcionado por Wine. Sirve para .bat/.cmd sencillos, pero no es Windows: \
             las unidades se ven como Z:\\ (raíz del sistema) y lo que dependa del registro \
             o de servicios de Windows fallará."
                .to_string(),
        );
        envs.push(env);
    }

    envs
}

/// Las shells nativas del sistema. No habla con ningún servicio externo, así
/// que es lo bastante rápida para el arranque de la primera ventana.
pub fn detect_system_shells() -> Vec<Environment> {
    if cfg!(windows) {
        detect_windows_shells()
    } else {
        detect_unix_shells()
    }
}

/// Las distros WSL instaladas, cada una como un entorno.
fn detect_wsl_environments(options: wsl_env::ContextOptions) -> Vec<Environment> {
    let context = wsl_env::get_wsl_context(options);
    let mut envs = Vec::new();
    for distro in context.installed {
        let note = distro.probe_error.then(|| {
            "La distribución está instalada, pero WSL no respondió durante la detección. \
             Refresca el selector o revisa wsl --status."
                .to_string()
        });
        envs.push(Environment {
            id: format!("wsl:{}", distro.name),
            label: format!(
                "WSL: {} · {}{}",
                distro.name,
                distro.shell,
                if distro.probe_error {
                    " (sin comprobar)"
                } else {
                    ""
                }
            ),
            kind: ShellKind::from_name(&distro.shell),
            shell: Some(distro.shell.clone()),
            transport: Transport::Wsl,
            distro: Some(distro.name.clone()),
            exe: "wsl.exe".into(),
            args: vec!["-d".into(), distro.name.clone()],
            note,
            ..Default::default()
        });

        // Si el inventario detallado ya está en caché (se obtiene al abrir
        // Entorno y dependencias), cada shell instalada se ofrece también como
        // entorno explícito sin obligarla a ser la login shell.
        for shell in distro.shells.iter().filter(|shell| **shell != distro.shell) {
            envs.push(Environment {
                id: format!("wsl:{}:{shell}", distro.name),
                label: format!("WSL: {} · {shell}", distro.name),
                kind: ShellKind::from_name(shell),
                shell: Some(shell.clone()),
                transport: Transport::Wsl,
                distro: Some(distro.name.clone()),
                exe: "wsl.exe".into(),
                args: vec![
                    "-d".into(),
                    distro.name.clone(),
                    "--".into(),
                    shell.clone(),
                    "-i".into(),
                ],
                ..Default::default()
            });
        }
    }
    envs
}

/// Lo que se sabe del sistema además de la lista de entornos. La UI lo usa para
/// el panel de dependencias y para decidir si merece la pena ofrecer arrancar
/// el daemon de Docker.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub envs: Vec<Environment>,
    pub language_count: usize,
    pub docker_installed: bool,
    pub docker_daemon_ready: bool,
    pub docker_container_count: usize,
    pub docker_image_count: usize,
    pub android_installed: bool,
    pub android_device_count: usize,
    /// El gestor de paquetes de este sistema, si es de los que el catálogo de
    /// dependencias sabe manejar. En Windows no hay ninguno que detectar: allí
    /// las acciones van todas por winget.
    pub pkg_manager: Option<String>,
}

/// El primer gestor de paquetes conocido que esté en el PATH. El orden importa:
/// una distribución puede tener varios instalados (un Fedora con `apt` de algún
/// contenedor), y el primero de la lista es el nativo de esa familia.
fn detect_pkg_manager() -> Option<String> {
    let managers: &[&str] = match std::env::consts::OS {
        "windows" => &[],
        "macos" => &["brew"],
        _ => &["apt", "dnf", "pacman", "zypper"],
    };
    managers
        .iter()
        .find(|manager| which(manager).is_some())
        .map(|manager| (*manager).to_string())
}

/// Inventario completo.
///
/// `quick` es lo que pide el arranque de la ventana: solo las shells nativas,
/// sin esperar a que WSL, Docker o adb respondan. El inventario completo llega
/// después y se le manda al frontend por `envs-updated`.
///
/// Ni los entornos Docker ni los de ADB son una lista fija: se consultan al
/// sistema en cada detección (imágenes/contenedores de ESTA máquina,
/// dispositivos Android conectados). Si la herramienta no está instalada, o no
/// hay nada conectado, esa parte de la lista queda vacía y el resto de entornos
/// funciona con normalidad.
pub fn detect_environments(quick: bool) -> Inventory {
    // Antes de detectar nada se re-sincroniza el PATH del proceso: si el
    // usuario acaba de instalar algo desde la propia terminal, la herramienta
    // ya está en el PATH persistente pero no en el que la app heredó al
    // arrancar.
    if !quick {
        crate::path_env::refresh_system_path();
        crate::android_env::ensure_adb_on_path();
    }

    let mut envs = detect_system_shells();

    if quick {
        return Inventory {
            envs,
            ..Default::default()
        };
    }

    if cfg!(windows) {
        envs.extend(detect_wsl_environments(wsl_env::ContextOptions {
            online: false,
            details: false,
            probe: true,
        }));
    }

    // Intérpretes interactivos de los lenguajes presentes en el sistema. Solo
    // se comprueba la existencia del ejecutable, con la salvedad de Python que
    // aplica `is_tool_installed`.
    let languages = crate::language_env::detect_language_environments(
        std::env::consts::OS,
        &crate::language_env::Probe {
            is_installed: &crate::path_env::is_tool_installed,
            resolve_path: &|exe| which(exe).map(|path| path.to_string_lossy().to_string()),
        },
    );

    let docker_installed = which("docker").is_some();

    // Las dos detecciones hablan con servicios externos (daemon de Docker,
    // servidor de adb) y son independientes: en paralelo, el arranque tarda lo
    // que la más lenta en vez de la suma de las dos.
    let (docker, android) = std::thread::scope(|scope| {
        let docker = scope.spawn(move || {
            if docker_installed {
                crate::docker_env::detect_docker_environments(crate::docker_env::DEFAULT_TIMEOUT)
            } else {
                crate::docker_env::DockerInventory::default()
            }
        });
        let android = scope.spawn(crate::android_env::detect_android_environments);
        (
            docker.join().unwrap_or_default(),
            android.join().unwrap_or_default(),
        )
    });

    let language_count = languages.len();
    envs.extend(languages);
    envs.extend(docker.envs);
    envs.extend(android.envs);

    Inventory {
        envs,
        language_count,
        docker_installed,
        docker_daemon_ready: docker.ready,
        docker_container_count: docker.container_count,
        docker_image_count: docker.image_count,
        android_installed: android.installed,
        android_device_count: android.device_count,
        pkg_manager: detect_pkg_manager(),
    }
}

/// Entorno por defecto al arrancar: cmd.exe en Windows (igual que el .hta
/// original), o la shell activa del usuario (`$SHELL`) en Linux/Mac.
pub fn default_env_id(envs: &[Environment]) -> Option<String> {
    if envs.is_empty() {
        return None;
    }
    if cfg!(windows) {
        return Some(
            envs.iter()
                .find(|env| env.id == "cmd")
                .unwrap_or(&envs[0])
                .id
                .clone(),
        );
    }
    let shell_path = std::env::var("SHELL").unwrap_or_default();
    let shell_name = shell_path.rsplit('/').next().unwrap_or("");
    let chosen = envs
        .iter()
        .find(|env| env.id == shell_name)
        .or_else(|| envs.iter().find(|env| env.id == "bash"))
        .unwrap_or(&envs[0]);
    Some(chosen.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(id: &str) -> Environment {
        Environment::new(id, id, ShellKind::Bash, "/bin/sh", &[])
    }

    #[test]
    fn solo_una_ruta_de_git_for_windows_es_git_bash() {
        assert!(is_git_bash_path("C:\\Program Files\\Git\\bin\\bash.exe"));
        assert!(is_git_bash_path("C:/Program Files/Git/usr/bin/bash.exe"));
        assert!(!is_git_bash_path("C:\\Windows\\System32\\bash.exe"));
        assert!(!is_git_bash_path("C:\\Tools\\bash.exe"));
        assert!(!is_git_bash_path(""));
    }

    #[test]
    fn los_transportes_que_no_ven_el_host_no_cargan_archivos() {
        assert!(Transport::Native.loads_host_files());
        assert!(Transport::Msys.loads_host_files());
        assert!(Transport::Wsl.loads_host_files());
        assert!(!Transport::Docker.loads_host_files());
        assert!(!Transport::Android.loads_host_files());
        assert!(!Transport::Wine.loads_host_files());
    }

    #[test]
    fn sin_entornos_no_hay_entorno_por_defecto() {
        assert_eq!(default_env_id(&[]), None);
    }

    #[test]
    fn el_entorno_por_defecto_cae_al_primero_si_no_encuentra_el_suyo() {
        let envs = vec![fake("zsh"), fake("fish")];
        assert_eq!(default_env_id(&envs), Some("zsh".to_string()));
    }

    #[cfg(not(windows))]
    #[test]
    fn en_unix_manda_la_shell_del_usuario() {
        let original = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", "/usr/bin/fish");
        let envs = vec![fake("bash"), fake("fish")];
        assert_eq!(default_env_id(&envs), Some("fish".to_string()));
        match original {
            Some(value) => std::env::set_var("SHELL", value),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn en_windows_manda_cmd() {
        let envs = vec![fake("pwsh"), fake("cmd"), fake("gitbash")];
        assert_eq!(default_env_id(&envs), Some("cmd".to_string()));
    }

    #[test]
    fn el_json_del_entorno_usa_los_nombres_de_la_version_electron() {
        let env = fake("bash");
        let value = serde_json::to_value(&env).unwrap();
        assert_eq!(value["transport"], serde_json::json!("native"));
        assert_eq!(value["kind"], serde_json::json!("bash"));
        assert_eq!(value["group"], serde_json::json!(SYSTEM_SHELLS_GROUP));
        // Los opcionales sin valor no viajan.
        assert!(value.get("distro").is_none());
        assert!(value.get("note").is_none());
        assert!(value.get("noAutoSelect").is_none());
    }

    #[test]
    fn la_deteccion_real_devuelve_al_menos_una_shell() {
        let envs = detect_system_shells();
        assert!(!envs.is_empty(), "ningún sistema se queda sin shell");
        assert!(default_env_id(&envs).is_some());
    }
}
