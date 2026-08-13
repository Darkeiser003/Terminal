//! Integración con Docker: arranque automático del daemon si está parado, y
//! detección de los entornos Docker REALES de la máquina (imágenes locales y
//! contenedores en ejecución) para ofrecerlos en el selector de entorno, en vez
//! de una imagen fija predefinida.
//!
//! Port de `electron/main/dockerEnv.js`.
//!
//! Todas las llamadas a `docker` llevan plazo: si el daemon está caído, el CLI
//! puede quedarse esperando, y esta detección corre durante el arranque de la
//! app (no debe bloquearla).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::environments::{Environment, ShellKind, Transport};
use crate::platform::traits::{HostPlatform, ProcessPlatform};
use crate::{paths, process};

/// Plazo por defecto de cada llamada al CLI de Docker.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(4000);

/// Cuántos entornos Docker como máximo se añaden al selector. Una máquina de
/// desarrollo puede tener decenas de imágenes; volcarlas todas convertiría el
/// desplegable en algo inusable.
pub const MAX_DOCKER_ENVS: usize = 25;

/// Comando de arranque dentro del contenedor: prefiere bash si la imagen lo
/// trae, y si no cae a sh (alpine, busybox y muchas imágenes slim solo traen
/// sh). Si la imagen no tiene ninguna shell, el error se ve en la terminal como
/// con cualquier otro comando.
const SHELL_FALLBACK: [&str; 3] = [
    "sh",
    "-c",
    "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
];

fn run_docker(args: &[&str], timeout: Duration) -> Option<String> {
    process::output_text("docker", args, timeout)
}

/// El daemon está listo cuando `docker version` puede responder la versión del
/// SERVIDOR (el cliente responde aunque el daemon esté caído, por eso se pide
/// explícitamente `.Server.Version`).
pub fn is_daemon_ready(timeout: Duration) -> bool {
    run_docker(&["version", "--format", "{{.Server.Version}}"], timeout)
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Rutas típicas del ejecutable de Docker Desktop en Windows, en orden de
/// preferencia. Se usa la primera que exista.
fn docker_desktop_windows_paths() -> Vec<PathBuf> {
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let program_files_x86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
    let mut paths = vec![
        PathBuf::from(&program_files)
            .join("Docker")
            .join("Docker")
            .join("Docker Desktop.exe"),
        PathBuf::from(&program_files_x86)
            .join("Docker")
            .join("Docker")
            .join("Docker Desktop.exe"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local)
                .join("Docker")
                .join("Docker Desktop.exe"),
        );
    }
    paths
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartResult {
    Started { via: String },
    NotStarted { reason: String },
}

/// Arranca Docker en segundo plano. En Windows/macOS es una app de usuario que
/// no requiere elevación, así que se puede lanzar directamente. En Linux el
/// daemon es un servicio del sistema y arrancarlo pide sudo: ahí no se hace
/// nada por detrás (el panel "Entorno y dependencias" ofrece el comando para
/// que el usuario lo ejecute y lo vea).
pub fn start_docker_daemon() -> StartResult {
    if crate::platform::host().is_windows() {
        let Some(exe) = docker_desktop_windows_paths()
            .into_iter()
            .find(|path| path.exists())
        else {
            return StartResult::NotStarted {
                reason: "No se encontró Docker Desktop.exe en las rutas habituales".into(),
            };
        };
        return match spawn_detached(&exe.to_string_lossy(), &[]) {
            Ok(()) => StartResult::Started {
                via: exe.to_string_lossy().to_string(),
            },
            Err(error) => StartResult::NotStarted {
                reason: error.to_string(),
            },
        };
    }
    StartResult::NotStarted {
        reason: "En Linux el daemon requiere privilegios: usa \"sudo systemctl start docker\" \
                 desde el panel de dependencias"
            .into(),
    }
}

/// Lanza y se desentiende: no se espera al proceso ni se leen sus tuberías.
fn spawn_detached(program: &str, args: &[&str]) -> std::io::Result<()> {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::platform::host().configure_detached_command(&mut command);
    crate::process::sanitize_child_environment(&mut command);
    command.spawn().map(|_| ())
}

/// Espera a que el daemon responda, sondeando cada `interval`. Devuelve `true`
/// si llegó a estar listo dentro del plazo. Docker Desktop tarda típicamente
/// entre 15 y 60 segundos en arrancar del todo.
pub fn wait_for_daemon(max_wait: Duration, interval: Duration) -> bool {
    let deadline = Instant::now() + max_wait;
    while Instant::now() < deadline {
        if is_daemon_ready(Duration::from_secs(3)) {
            return true;
        }
        std::thread::sleep(interval);
    }
    false
}

pub fn parse_images(out: &str) -> Vec<String> {
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // Imágenes intermedias/huérfanas: no sirven para abrir una shell.
        .filter(|line| !line.contains("<none>"))
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningContainer {
    pub name: String,
    pub image: String,
}

pub fn parse_running_containers(out: &str) -> Vec<RunningContainer> {
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            // El formato pide dos columnas separadas por tabulador; si llegan
            // más (una imagen con tabulador en el nombre no es posible), se
            // ignoran las de sobra en vez de pegarlas a la imagen.
            let mut parts = line.split('\t');
            let name = parts.next().unwrap_or("").trim();
            if name.is_empty() {
                return None;
            }
            Some(RunningContainer {
                name: name.to_string(),
                image: parts.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

#[derive(Debug, Default)]
pub struct DockerInventory {
    pub ready: bool,
    pub envs: Vec<Environment>,
    /// Cuántos entornos había antes de recortar a `MAX_DOCKER_ENVS`.
    pub total: usize,
    pub container_count: usize,
    pub image_count: usize,
}

/// Construye la lista de entornos Docker disponibles ahora mismo:
///  - un entorno por cada contenedor EN EJECUCIÓN (`docker exec`: entra en el
///    contenedor vivo, conservando su estado),
///  - un entorno por cada imagen local (`docker run --rm`: contenedor nuevo y
///    efímero a partir de esa imagen).
///
/// El directorio del usuario se monta en `/workspace` para poder trabajar con
/// los archivos del host desde dentro del contenedor.
pub fn detect_docker_environments(timeout: Duration) -> DockerInventory {
    if !is_daemon_ready(timeout) {
        return DockerInventory::default();
    }

    let cwd = paths::home_cwd().to_string_lossy().to_string();
    let mut envs = Vec::new();

    // `group` es solo para la UI: separa en el desplegable los contenedores
    // vivos de las imágenes. Sin esa separación, ver la misma imagen dos veces
    // (una como contenedor en marcha y otra como imagen) parece un duplicado,
    // cuando en realidad son dos acciones distintas.
    let containers = run_docker(&["ps", "--format", "{{.Names}}\t{{.Image}}"], timeout)
        .map(|out| parse_running_containers(&out))
        .unwrap_or_default();
    for container in &containers {
        let mut args = vec![
            "exec".to_string(),
            "-it".to_string(),
            container.name.clone(),
        ];
        args.extend(SHELL_FALLBACK.iter().map(|arg| arg.to_string()));
        envs.push(Environment {
            id: format!("docker:container:{}", container.name),
            label: format!(
                "Docker ▶ {} · bash/sh{}",
                container.name,
                if container.image.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", container.image)
                }
            ),
            group: "Docker · contenedores en ejecución".into(),
            kind: ShellKind::Bash,
            transport: Transport::Docker,
            exe: "docker".into(),
            args,
            ..Default::default()
        });
    }

    let images = run_docker(
        &["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
        timeout,
    )
    .map(|out| parse_images(&out))
    .unwrap_or_default();
    for image in &images {
        let mut args = vec![
            "run".to_string(),
            "--rm".to_string(),
            "-it".to_string(),
            "-v".to_string(),
            format!("{cwd}:/workspace"),
            "-w".to_string(),
            "/workspace".to_string(),
            image.clone(),
        ];
        args.extend(SHELL_FALLBACK.iter().map(|arg| arg.to_string()));
        envs.push(Environment {
            id: format!("docker:image:{image}"),
            label: format!("Docker: {image} · bash/sh"),
            group: "Docker · imágenes (contenedor nuevo)".into(),
            kind: ShellKind::Bash,
            transport: Transport::Docker,
            exe: "docker".into(),
            args,
            host_root: Some(cwd.clone()),
            container_root: Some("/workspace".into()),
            initial_host_cwd: Some(cwd.clone()),
            ..Default::default()
        });
    }

    let total = envs.len();
    envs.truncate(MAX_DOCKER_ENVS);
    DockerInventory {
        ready: true,
        envs,
        total,
        container_count: containers.len(),
        image_count: images.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn se_descartan_las_imagenes_huerfanas() {
        let out = "nginx:latest\r\n<none>:<none>\r\nubuntu:22.04\r\n\r\n";
        assert_eq!(parse_images(out), vec!["nginx:latest", "ubuntu:22.04"]);
    }

    #[test]
    fn una_salida_vacia_no_da_imagenes() {
        assert!(parse_images("").is_empty());
        assert!(parse_images("   \n\n").is_empty());
    }

    #[test]
    fn se_leen_nombre_e_imagen_de_cada_contenedor() {
        let out = "web\tnginx:latest\napi\tnode:20\n";
        assert_eq!(
            parse_running_containers(out),
            vec![
                RunningContainer {
                    name: "web".into(),
                    image: "nginx:latest".into()
                },
                RunningContainer {
                    name: "api".into(),
                    image: "node:20".into()
                },
            ]
        );
    }

    #[test]
    fn un_contenedor_sin_imagen_sigue_siendo_valido() {
        assert_eq!(
            parse_running_containers("solo-nombre\n"),
            vec![RunningContainer {
                name: "solo-nombre".into(),
                image: String::new()
            }]
        );
    }

    #[test]
    fn una_linea_en_blanco_se_descarta() {
        assert!(parse_running_containers("\t\n   \n\n").is_empty());
    }

    #[test]
    fn una_columna_de_sobra_no_se_pega_al_nombre_de_la_imagen() {
        assert_eq!(
            parse_running_containers("web\tnginx\tresto\n"),
            vec![RunningContainer {
                name: "web".into(),
                image: "nginx".into()
            }]
        );
    }

    #[test]
    fn en_linux_no_se_intenta_arrancar_el_daemon_por_detras() {
        if cfg!(windows) || cfg!(target_os = "macos") {
            return;
        }
        match start_docker_daemon() {
            StartResult::NotStarted { reason } => assert!(reason.contains("systemctl")),
            other => panic!("no debería arrancar nada en Linux: {other:?}"),
        }
    }

    #[test]
    fn sin_daemon_el_inventario_queda_vacio_y_no_listo() {
        // Con un plazo mínimo, `docker version` no llega a responder ni aunque
        // esté instalado: es la misma rama que cuando el daemon está caído.
        let inventory = detect_docker_environments(Duration::from_millis(1));
        assert!(!inventory.ready);
        assert!(inventory.envs.is_empty());
        assert_eq!(inventory.container_count, 0);
        assert_eq!(inventory.image_count, 0);
    }
}
