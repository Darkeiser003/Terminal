//! Ejecutar procesos auxiliares sin que asomen ventanas de consola.
//!
//! En la versión Electron esto era `execFileSync(..., { windowsHide: true })`.
//! En Windows, `std::process::Command` abre una ventana de consola para cada
//! proceso hijo si el padre es una app GUI, así que todas las llamadas pasan
//! por aquí para aplicar `CREATE_NO_WINDOW`.

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(unix)]
use libc::{kill, setpgid, SIGKILL};

use crate::platform::traits::ProcessPlatform;

/// Resultado de una sonda de detección. `None` no basta para el panel: un
/// ejecutable ausente, un comando que devuelve error y un proceso que agota el
/// plazo no significan lo mismo para decidir si se ofrece «Instalar».
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutput {
    Success(String),
    Failed,
    NotFound,
    TimedOut,
}

const APPIMAGE_PRIVATE_ENV: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "APPIMAGE_EXTRACT_AND_RUN",
    "ARGV0",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    // linuxdeploy's AppRun exports these for the application process itself.
    // If a host Python tool (notably xonsh) inherits them, it tries to load
    // the AppImage's private stdlib and fails before its prompt is created.
    "PYTHONHOME",
    "PYTHONPATH",
];

fn running_from_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some()
        || std::env::var_os("APPDIR").is_some()
        || std::env::var("APPIMAGE_EXTRACT_AND_RUN").as_deref() == Ok("1")
        || std::env::var("LD_LIBRARY_PATH")
            .ok()
            .is_some_and(|value| contains_appimage_runtime_path(&value))
        || std::env::var("PYTHONHOME")
            .ok()
            .is_some_and(|value| contains_appimage_runtime_path(&value))
}

fn contains_appimage_runtime_path(value: &str) -> bool {
    value.contains("/.mount_") || value.contains("/appimage_extracted_")
}

/// AppImage's extract-and-run wrapper does not reliably export APPDIR. Its
/// PythonHOME still points to `<extraction>/usr`, which lets us identify the
/// private executable directories to remove from children as well.
fn appimage_directory() -> Option<std::ffi::OsString> {
    appimage_directory_from(std::env::var_os("APPDIR"), std::env::var_os("PYTHONHOME"))
}

fn appimage_directory_from(
    appdir: Option<std::ffi::OsString>,
    python_home: Option<std::ffi::OsString>,
) -> Option<std::ffi::OsString> {
    appdir.or_else(|| {
        let path = Path::new(python_home.as_deref()?);
        (path.file_name() == Some(std::ffi::OsStr::new("usr")))
            .then(|| path.parent().map(|parent| parent.as_os_str().to_owned()))
            .flatten()
    })
}

/// Entorno que pueden heredar comandos y shells. Un AppImage monta sus
/// bibliotecas, rutas de ejecutables y Python privados; heredarlos puede hacer
/// que herramientas del host carguen librerías incompatibles o que xonsh use
/// una biblioteca estándar que no existe dentro del AppDir.
/// Variables que la app añade a todo lo que lanza (terminales y sondas): hoy,
/// las rutas de las cachés centralizadas de `config::toolchain_store`. Las
/// calcula la capa de configuración al arrancar y al guardar Ajustes; aquí
/// solo se aplican, sin leer preferencias del disco en cada proceso.
static EXTRA_ENVIRONMENT: once_cell::sync::Lazy<parking_lot::RwLock<Vec<(String, String)>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(Vec::new()));

pub fn set_extra_environment(variables: Vec<(String, String)>) {
    *EXTRA_ENVIRONMENT.write() = variables;
}

pub fn extra_environment() -> Vec<(String, String)> {
    EXTRA_ENVIRONMENT.read().clone()
}

/// Carpetas que van DELANTE del PATH en todo lo que lanza WTerminal: los
/// `bin` de las herramientas instaladas en la carpeta propia
/// (`config::toolchain_store`). No se escriben en el PATH del sistema.
static EXTRA_PATH: once_cell::sync::Lazy<parking_lot::RwLock<Vec<String>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(Vec::new()));

pub fn set_extra_path(dirs: Vec<String>) {
    *EXTRA_PATH.write() = dirs;
}

/// `path` con las carpetas extra delante, sin repetir las que ya estén.
pub fn path_with_extra(path: &str) -> String {
    prepend_path(&EXTRA_PATH.read(), path)
}

fn prepend_path(extra: &[String], path: &str) -> String {
    if extra.is_empty() {
        return path.to_string();
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    let key = |entry: &str| {
        let trimmed = entry.trim_end_matches(['\\', '/']);
        if cfg!(windows) {
            trimmed.to_ascii_lowercase()
        } else {
            trimmed.to_string()
        }
    };
    let existing: Vec<&str> = path
        .split(separator)
        .filter(|entry| !entry.is_empty())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut parts: Vec<&str> = Vec::new();
    for entry in extra.iter().map(String::as_str).chain(existing) {
        if seen.insert(key(entry)) {
            parts.push(entry);
        }
    }
    parts.join(&separator.to_string())
}

pub fn child_environment() -> Vec<(String, String)> {
    let mut environment = inherited_environment();
    for (key, value) in environment.iter_mut() {
        let is_path = if cfg!(windows) {
            key.eq_ignore_ascii_case("PATH")
        } else {
            key == "PATH"
        };
        if is_path {
            *value = path_with_extra(value);
        }
    }
    for (key, value) in extra_environment() {
        // Nunca se pisa una variable que ya trae el entorno del usuario.
        let present = environment.iter().any(|(existing, _)| {
            if cfg!(windows) {
                existing.eq_ignore_ascii_case(&key)
            } else {
                *existing == key
            }
        });
        if !present {
            environment.push((key, value));
        }
    }
    environment
}

fn inherited_environment() -> Vec<(String, String)> {
    let isolate_appimage = running_from_appimage();
    let appdir = isolate_appimage.then(appimage_directory).flatten();
    std::env::vars()
        .filter(|(key, _)| !isolate_appimage || !APPIMAGE_PRIVATE_ENV.contains(&key.as_str()))
        .map(|(key, value)| {
            let value = if key == "PATH" {
                appdir
                    .as_deref()
                    .map(|appdir| strip_appdir_paths(&value, appdir))
                    .unwrap_or(value)
            } else {
                value
            };
            (key, value)
        })
        .collect()
}

/// Reduce a PATH to entries outside the AppDir. Kept separate from process
/// state so the relocation behavior can be tested without mutating global env.
fn strip_appdir_paths(value: &str, appdir: &std::ffi::OsStr) -> String {
    let appdir = Path::new(appdir);
    let host_paths = std::env::split_paths(value)
        .filter(|entry| !entry.starts_with(appdir))
        .collect::<Vec<_>>();
    std::env::join_paths(host_paths)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| value.to_owned())
}

/// Aplica el aislamiento al `Command` normal de Rust. Los procesos creados
/// desde una AppImage siguen viendo PATH, locale y preferencias del usuario,
/// pero nunca las bibliotecas del montaje efímero.
pub fn sanitize_child_environment(command: &mut Command) {
    if running_from_appimage() {
        for key in APPIMAGE_PRIVATE_ENV {
            command.env_remove(key);
        }
        if let (Some(appdir), Ok(path)) = (appimage_directory(), std::env::var("PATH")) {
            command.env("PATH", strip_appdir_paths(&path, &appdir));
        }
    }
}

/// El `CommandBuilder` de `portable-pty` precarga el entorno global. Añadirle
/// solo las variables saneadas no basta: las variables omitidas siguen dentro
/// de su mapa base. Hay que quitarlas explícitamente antes de arrancar shells.
pub fn sanitize_pty_child_environment(command: &mut portable_pty::CommandBuilder) {
    if !running_from_appimage() {
        return;
    }

    remove_appimage_private_environment_from_pty(command);
    if let (Some(appdir), Ok(path)) = (appimage_directory(), std::env::var("PATH")) {
        command.env("PATH", strip_appdir_paths(&path, &appdir));
    }
}

fn remove_appimage_private_environment_from_pty(command: &mut portable_pty::CommandBuilder) {
    for key in APPIMAGE_PRIVATE_ENV {
        command.env_remove(key);
    }
}

/// ¿Es `program` Windows PowerShell 5.1 (`powershell` o `powershell.exe`,
/// con o sin ruta)? PowerShell 7 es `pwsh` y no entra aquí.
pub fn is_windows_powershell(program: &str) -> bool {
    let name = Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name == "powershell" || name == "powershell.exe"
}

/// `PSModulePath` para un Windows PowerShell 5.1 lanzado desde WTerminal.
///
/// Si WTerminal se abrió desde PowerShell 7, hereda su `PSModulePath`, con
/// las carpetas de pwsh y sin la de usuario de 5.1: el PowerShell 5.1 hijo
/// no veía el PSReadLine instalado en `Documentos\WindowsPowerShell\Modules`
/// (la sonda lo daba por ausente y lo ofrecía otra vez) y sus pestañas
/// cargaban el 2.0 del sistema, sin sugerencias. Se quitan las carpetas de
/// PowerShell 7, se conservan las demás (también las personalizadas) y se
/// asegura que estén las tres de 5.1, con la de usuario delante.
pub fn windows_powershell_module_path(
    inherited: &str,
    documents: &Path,
    program_files: &Path,
    system_root: &Path,
) -> String {
    let defaults = [
        documents.join("WindowsPowerShell").join("Modules"),
        program_files.join("WindowsPowerShell").join("Modules"),
        system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("Modules"),
    ];
    let is_pwsh_dir = |entry: &str| {
        let lower = entry.replace('/', "\\").to_ascii_lowercase();
        lower.contains("\\powershell\\") && !lower.contains("\\windowspowershell\\")
    };
    let mut entries: Vec<String> = vec![defaults[0].to_string_lossy().into_owned()];
    entries.extend(
        inherited
            .split(';')
            .map(str::trim)
            .filter(|entry| !entry.is_empty() && !is_pwsh_dir(entry))
            .map(str::to_string),
    );
    entries.extend(
        defaults[1..]
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );
    let mut seen = std::collections::HashSet::new();
    entries
        .into_iter()
        .filter(|entry| seen.insert(entry.trim_end_matches('\\').to_ascii_lowercase()))
        .collect::<Vec<_>>()
        .join(";")
}

/// El `PSModulePath` de 5.1 para este equipo y este proceso.
pub fn current_windows_powershell_module_path() -> String {
    let program_files = std::env::var_os("ProgramFiles")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Program Files"));
    let system_root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    windows_powershell_module_path(
        &std::env::var("PSModulePath").unwrap_or_default(),
        &crate::paths::documents_dir(),
        &program_files,
        &system_root,
    )
}

/// Un `Command` con la salida capturada, sin stdin y sin ventana.
pub fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::platform::host().configure_background_command(&mut command);
    sanitize_child_environment(&mut command);
    // Las sondas (por ejemplo `npm root -g` o `pip list`) deben ver las
    // mismas cachés que las terminales; las variables del usuario mandan.
    for (key, value) in extra_environment() {
        if std::env::var_os(&key).is_none() {
            command.env(key, value);
        }
    }
    if !EXTRA_PATH.read().is_empty() {
        command.env(
            "PATH",
            path_with_extra(&std::env::var("PATH").unwrap_or_default()),
        );
    }
    if cfg!(windows) && is_windows_powershell(program) {
        command.env("PSModulePath", current_windows_powershell_module_path());
    }
    command
}

/// Ejecuta y espera, con un tope de tiempo. Un proceso que se cuelga (un
/// `wsl.exe` esperando a un servicio, un `docker` sin daemon) no debe dejar la
/// app bloqueada: pasado el plazo se mata y se devuelve `None`.
pub fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<Output> {
    run_with_timeout_env(program, args, timeout, &[])
}

/// Variante que aplica variables de entorno controladas antes de arrancar el
/// proceso. Se usa para obtener salida estable de herramientas del sistema
/// (por ejemplo, listados de paquetes en locale C) sin mutar el entorno global
/// de LTerminal ni cambiar el comportamiento de los demás procesos.
pub fn run_with_timeout_env(
    program: &str,
    args: &[&str],
    timeout: Duration,
    environment: &[(&str, &str)],
) -> Option<Output> {
    run_with_timeout_inner(program, args, timeout, environment, false)
}

/// Como `run_with_timeout_env`, pero también recoge la salida de errores:
/// para herramientas cuyo motivo de fallo hay que enseñar (por ejemplo `gh`).
pub fn run_with_timeout_capture(
    program: &str,
    args: &[&str],
    timeout: Duration,
    environment: &[(&str, &str)],
) -> Option<Output> {
    run_with_timeout_inner(program, args, timeout, environment, true)
}

fn run_with_timeout_inner(
    program: &str,
    args: &[&str],
    timeout: Duration,
    environment: &[(&str, &str)],
    capture_stderr: bool,
) -> Option<Output> {
    let mut command = hidden_command(program);
    configure_process_tree(&mut command);
    command.envs(environment.iter().copied());
    if capture_stderr {
        command.stderr(Stdio::piped());
    }
    let mut child = command.args(args).spawn().ok()?;
    // La salida se lee mientras el proceso corre: si solo se leyera al
    // terminar, un hijo que escribe más de lo que cabe en la tubería (el
    // catálogo de WTools, un `winget list` largo) se quedaría bloqueado
    // escribiendo y la espera acabaría en timeout.
    let stdout = child.stdout.take().map(drain_in_background);
    let stderr = child.stderr.take().map(drain_in_background);

    // `Child` no ofrece espera con plazo en la biblioteca estándar. Un sondeo
    // corto es suficiente: estas llamadas o responden en milisegundos o no
    // responden nunca.
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    terminate_process_tree(&mut child);
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => {
                terminate_process_tree(&mut child);
                return None;
            }
        }
    };
    // Un nieto que siga vivo con la tubería heredada no deja llegar el fin de
    // archivo: se espera como mucho lo que quede del plazo (y un margen
    // mínimo para vaciar lo ya escrito), nunca indefinidamente.
    let grace = deadline
        .saturating_duration_since(std::time::Instant::now())
        .max(Duration::from_millis(500));
    let collect = |reader: Option<std::sync::mpsc::Receiver<Vec<u8>>>| match reader {
        Some(reader) => reader.recv_timeout(grace).ok(),
        None => Some(Vec::new()),
    };
    Some(Output {
        status,
        stdout: collect(stdout)?,
        stderr: collect(stderr)?,
    })
}

/// Lee una tubería hasta el final en un hilo aparte y entrega el contenido.
fn drain_in_background(
    mut pipe: impl std::io::Read + Send + 'static,
) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        let _ = sender.send(buffer);
    });
    receiver
}

/// Hace que el proceso y sus descendientes compartan una unidad de apagado.
/// En Unix es un grupo de procesos; en Windows `taskkill /T` recorre el árbol
/// del PID aunque el hijo haya creado PowerShell, WSL o herramientas auxiliares.
fn configure_process_tree(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    #[cfg(not(unix))]
    let _ = command;
}

fn terminate_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // El PID es también el ID del grupo creado en `configure_process_tree`.
        // El signo negativo de kill() apunta al grupo completo, no solo al
        // proceso que heredó el timeout.
        let pid = child.id() as libc::pid_t;
        unsafe {
            let _ = kill(-pid, SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let mut killer = hidden_command("taskkill");
        let _ = killer.args(["/PID", &pid, "/T", "/F"]).status();
    }

    // Fallback para permisos, procesos que terminaron durante la carrera o
    // plataformas donde no se pudo crear el grupo.
    let _ = child.kill();
    let _ = child.wait();
}

/// La salida estándar como texto, o `None` si el proceso falló, no existe o
/// agotó el plazo.
pub fn output_text(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    match output_text_probe(program, args, timeout) {
        ProbeOutput::Success(output) => Some(output),
        ProbeOutput::Failed | ProbeOutput::NotFound | ProbeOutput::TimedOut => None,
    }
}

/// Igual que `output_text`, pero conserva la causa de un resultado no válido
/// para que la detección no confunda un timeout con una herramienta ausente.
pub fn output_text_probe(program: &str, args: &[&str], timeout: Duration) -> ProbeOutput {
    let mut command = hidden_command(program);
    configure_process_tree(&mut command);
    let Ok(mut child) = command.args(args).spawn() else {
        return ProbeOutput::NotFound;
    };

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    terminate_process_tree(&mut child);
                    return ProbeOutput::TimedOut;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => {
                terminate_process_tree(&mut child);
                return ProbeOutput::Failed;
            }
        }
    }

    let Ok(output) = child.wait_with_output() else {
        return ProbeOutput::Failed;
    };
    if output.status.success() {
        ProbeOutput::Success(decode_console_output(&output.stdout))
    } else {
        ProbeOutput::Failed
    }
}

/// WinGet no admite bien consultas simultáneas: con cuatro `winget list` a la
/// vez, una de ellas termina al instante con error y sin salida aunque las
/// demás respondan. Al arrancar coincidían el aviso de actualizaciones y las
/// listas de la precarga de Dependencias; la que perdía dejaba decenas de
/// familias sin confirmar. Todas las consultas de la app pasan por aquí.
static WINGET_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Un fallo de contención llega antes de que WinGet imprima nada.
const WINGET_FAST_FAILURE: Duration = Duration::from_millis(1500);
const WINGET_RETRY_DELAY: Duration = Duration::from_millis(400);

/// Fallo inmediato y sin salida: el patrón de otra instancia de WinGet
/// ocupando su estado. Un «no encontrado» real sí escribe un mensaje.
fn winget_contention_failure(output: &Output, elapsed: Duration) -> bool {
    !output.status.success()
        && elapsed < WINGET_FAST_FAILURE
        && output.stdout.iter().all(u8::is_ascii_whitespace)
}

/// Ejecuta WinGet con el cerrojo tomado. Si falla por contención (otra
/// instancia ajena a la app, como una terminal del usuario o la Store), se
/// reintenta una vez tras una pausa breve.
pub fn winget_run_env(
    args: &[&str],
    timeout: Duration,
    environment: &[(&str, &str)],
) -> Option<Output> {
    let _guard = WINGET_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let started = std::time::Instant::now();
    let first = run_with_timeout_env("winget", args, timeout, environment)?;
    if !winget_contention_failure(&first, started.elapsed()) {
        return Some(first);
    }
    std::thread::sleep(WINGET_RETRY_DELAY);
    run_with_timeout_env("winget", args, timeout, environment)
}

/// Consulta de solo lectura a WinGet, serializada, con la misma clasificación
/// que `output_text_probe`.
pub fn winget_probe(args: &[&str], timeout: Duration) -> ProbeOutput {
    let _guard = WINGET_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let attempt = || {
        let started = std::time::Instant::now();
        let output = run_with_timeout_env("winget", args, timeout, &[]);
        (output, started.elapsed())
    };
    let (mut output, mut elapsed) = attempt();
    if output
        .as_ref()
        .is_some_and(|output| winget_contention_failure(output, elapsed))
    {
        std::thread::sleep(WINGET_RETRY_DELAY);
        (output, elapsed) = attempt();
    }
    match output {
        Some(output) if output.status.success() => {
            ProbeOutput::Success(decode_console_output(&output.stdout))
        }
        Some(_) => ProbeOutput::Failed,
        // `run_with_timeout_env` devuelve `None` tanto si no pudo arrancar
        // como si agotó el plazo; el tiempo transcurrido los distingue.
        None if elapsed >= timeout => ProbeOutput::TimedOut,
        None => ProbeOutput::NotFound,
    }
}

/// La salida de las utilidades de consola de Windows no siempre es UTF-8 (`reg`
/// y `where` usan la página de códigos OEM). Se decoda de forma tolerante: lo
/// que interesa de estas salidas son rutas y palabras clave ASCII.
fn decode_console_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_carpetas_extra_van_delante_del_path_sin_repetirse() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let extra = vec!["/wt/npm".to_string(), "/wt/cargo/bin".to_string()];
        let path = ["/usr/bin", "/wt/cargo/bin/", "/bin"].join(sep);
        assert_eq!(
            prepend_path(&extra, &path),
            ["/wt/npm", "/wt/cargo/bin", "/usr/bin", "/bin"].join(sep)
        );
        // Sin carpetas extra el PATH no cambia.
        assert_eq!(prepend_path(&[], &path), path);
    }

    #[test]
    fn un_programa_inexistente_no_entra_en_panico() {
        let result = output_text(
            "programa-que-no-existe-en-ningun-sistema",
            &[],
            Duration::from_millis(500),
        );
        assert!(result.is_none());
    }

    #[test]
    fn devuelve_la_salida_de_un_comando_que_si_existe() {
        // `cmd /c echo` en Windows, `echo` en el resto: los dos están siempre.
        let output = if cfg!(windows) {
            output_text("cmd", &["/c", "echo", "hola"], Duration::from_secs(5))
        } else {
            output_text("echo", &["hola"], Duration::from_secs(5))
        };
        assert_eq!(output.unwrap_or_default().trim(), "hola");
    }

    fn output_with(code: u32, stdout: &str) -> Output {
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(code)
        };
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw((code as i32) << 8)
        };
        Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn winget_solo_reintenta_el_fallo_inmediato_sin_salida() {
        let fast = Duration::from_millis(300);
        // Contención: error al instante y sin una sola línea.
        assert!(winget_contention_failure(&output_with(1, ""), fast));
        assert!(winget_contention_failure(&output_with(1, " \r\n"), fast));
        // Un «no hay paquete» real escribe su mensaje: no se repite.
        assert!(!winget_contention_failure(
            &output_with(1, "No se encontró ningún paquete instalado."),
            fast
        ));
        // Ni los éxitos ni los fallos lentos son contención.
        assert!(!winget_contention_failure(&output_with(0, ""), fast));
        assert!(!winget_contention_failure(
            &output_with(1, ""),
            Duration::from_secs(3)
        ));
    }

    #[test]
    fn la_sonda_distingue_un_programa_ausente() {
        assert_eq!(
            output_text_probe(
                "programa-que-no-existe-en-ningun-sistema",
                &[],
                Duration::from_millis(250),
            ),
            ProbeOutput::NotFound
        );
    }

    #[cfg(windows)]
    #[test]
    fn la_sonda_distingue_un_timeout_de_un_comando_ausente() {
        assert_eq!(
            output_text_probe(
                "cmd",
                &["/c", "ping -n 8 127.0.0.1 >nul"],
                Duration::from_millis(50),
            ),
            ProbeOutput::TimedOut
        );
    }

    #[test]
    fn windows_powershell_51_no_hereda_las_carpetas_de_modulos_de_pwsh() {
        let documents = Path::new(r"C:\Users\Ana\Documents");
        let program_files = Path::new(r"C:\Program Files");
        let system_root = Path::new(r"C:\Windows");
        // Lo que hereda WTerminal si se abrió desde PowerShell 7.
        let from_pwsh = r"C:\Users\Ana\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;c:\program files\powershell\7\Modules;D:\MisModulos;C:\Program Files\WindowsPowerShell\Modules;C:\Windows\system32\WindowsPowerShell\v1.0\Modules";
        let fixed =
            windows_powershell_module_path(from_pwsh, documents, program_files, system_root);
        assert_eq!(
            fixed,
            r"C:\Users\Ana\Documents\WindowsPowerShell\Modules;D:\MisModulos;C:\Program Files\WindowsPowerShell\Modules;C:\Windows\system32\WindowsPowerShell\v1.0\Modules"
        );
        // Ya correcto: no cambia ni se duplica nada.
        assert_eq!(
            windows_powershell_module_path(&fixed, documents, program_files, system_root),
            fixed
        );
        // Vacío: las tres carpetas de 5.1, la de usuario delante.
        assert_eq!(
            windows_powershell_module_path("", documents, program_files, system_root),
            r"C:\Users\Ana\Documents\WindowsPowerShell\Modules;C:\Program Files\WindowsPowerShell\Modules;C:\Windows\System32\WindowsPowerShell\v1.0\Modules"
        );
        assert!(is_windows_powershell("powershell"));
        assert!(is_windows_powershell(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        ));
        assert!(!is_windows_powershell("pwsh"));
        assert!(!is_windows_powershell(
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        ));
    }

    /// Un catálogo grande (el de WTools ronda 75 KB) no cabe en la tubería: si
    /// solo se leyera al terminar, el hijo se bloquearía al escribir y la
    /// espera acabaría en timeout aunque el programa respondiera al instante.
    #[test]
    fn una_salida_mayor_que_la_tuberia_llega_entera_y_sin_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("grande.txt");
        let line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuv\n";
        let content = line.repeat(300 * 1024 / line.len());
        std::fs::write(&file, &content).unwrap();
        let path = file.to_string_lossy().into_owned();
        let output = if cfg!(windows) {
            run_with_timeout("cmd", &["/d", "/c", "type", &path], Duration::from_secs(10))
        } else {
            run_with_timeout("cat", &[&path], Duration::from_secs(10))
        }
        .expect("el proceso responde aunque su salida no quepa en la tubería");
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), content.len());
    }

    #[cfg(unix)]
    #[test]
    fn la_sonda_distingue_un_timeout_de_un_comando_ausente() {
        assert_eq!(
            output_text_probe("sh", &["-c", "sleep 5"], Duration::from_millis(50)),
            ProbeOutput::TimedOut
        );
    }

    #[cfg(unix)]
    #[test]
    fn el_timeout_termina_tambien_a_los_hijos_de_la_shell() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let script = format!(
            "sleep 30 & child=$!; printf '%s' \"$child\" > '{}'; wait",
            pid_file.display()
        );
        assert!(run_with_timeout("sh", &["-c", &script], Duration::from_millis(250)).is_none());

        let child_pid = std::fs::read_to_string(&pid_file).unwrap();
        let mut sigue_vivo = false;
        for _ in 0..20 {
            sigue_vivo = Command::new("kill")
                .args(["-0", child_pid.trim()])
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !sigue_vivo {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if sigue_vivo {
            let _ = Command::new("kill")
                .args(["-KILL", child_pid.trim()])
                .stderr(Stdio::null())
                .status();
        }
        assert!(!sigue_vivo, "el hijo de la shell sobrevivió al timeout");
    }

    #[test]
    fn las_variables_privadas_del_appimage_son_conocidas_y_acotadas() {
        assert!(APPIMAGE_PRIVATE_ENV.contains(&"LD_LIBRARY_PATH"));
        assert!(APPIMAGE_PRIVATE_ENV.contains(&"APPIMAGE"));
        assert!(APPIMAGE_PRIVATE_ENV.contains(&"APPIMAGE_EXTRACT_AND_RUN"));
        assert!(APPIMAGE_PRIVATE_ENV.contains(&"PYTHONHOME"));
        assert!(APPIMAGE_PRIVATE_ENV.contains(&"PYTHONPATH"));
        assert!(!APPIMAGE_PRIVATE_ENV.contains(&"PATH"));
    }

    #[test]
    fn el_pty_quita_del_entorno_base_las_variables_privadas_del_appimage() {
        let mut command = portable_pty::CommandBuilder::new("xonsh");
        for key in APPIMAGE_PRIVATE_ENV {
            command.env(key, "valor-privado-de-prueba");
        }

        remove_appimage_private_environment_from_pty(&mut command);

        for key in APPIMAGE_PRIVATE_ENV {
            assert!(command.get_env(key).is_none(), "{key} sigue en el PTY");
        }
    }

    #[test]
    fn una_shell_del_appimage_conserva_path_del_host_y_no_hereda_el_appdir() {
        let appdir = std::env::temp_dir().join("LTerminal.AppDir");
        let private_bin = appdir.join("usr").join("bin");
        let host_bins = [
            std::env::temp_dir().join("host-tools"),
            std::env::temp_dir().join("system-bin"),
        ];
        let original =
            std::env::join_paths([private_bin, host_bins[0].clone(), host_bins[1].clone()])
                .unwrap()
                .to_string_lossy()
                .into_owned();

        let sanitized = strip_appdir_paths(&original, appdir.as_os_str());
        let entries = std::env::split_paths(std::ffi::OsStr::new(&sanitized)).collect::<Vec<_>>();

        assert_eq!(entries, host_bins);
    }

    #[test]
    fn appimage_extract_and_run_se_puede_identificar_desde_pythonhome() {
        let appdir = std::env::temp_dir().join("appimage_extracted_regression");
        let python_home = appdir.join("usr");
        let identified = appimage_directory_from(None, Some(python_home.into_os_string()));
        assert_eq!(identified.as_deref(), Some(appdir.as_os_str()));
    }

    #[test]
    fn detecta_las_rutas_temporales_de_appimage_montado_y_extraido() {
        assert!(contains_appimage_runtime_path(
            "/tmp/.mount_LTerminal/usr/lib"
        ));
        assert!(contains_appimage_runtime_path(
            "/tmp/appimage_extracted_1234/usr"
        ));
        assert!(!contains_appimage_runtime_path("/opt/python/usr"));
    }
}
