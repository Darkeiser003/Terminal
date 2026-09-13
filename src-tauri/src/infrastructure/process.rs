//! Ejecutar procesos auxiliares sin que asomen ventanas de consola.
//!
//! En la versión Electron esto era `execFileSync(..., { windowsHide: true })`.
//! En Windows, `std::process::Command` abre una ventana de consola para cada
//! proceso hijo si el padre es una app GUI, así que todas las llamadas pasan
//! por aquí para aplicar `CREATE_NO_WINDOW`.

use std::process::{Command, Output, Stdio};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(unix)]
use libc::{kill, setpgid, SIGKILL};

use crate::platform::traits::ProcessPlatform;

const APPIMAGE_PRIVATE_ENV: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
];

fn running_from_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some()
        || std::env::var("LD_LIBRARY_PATH")
            .ok()
            .is_some_and(|value| value.contains("/tmp/.mount_"))
}

/// Entorno que pueden heredar comandos y shells. Un AppImage monta sus
/// bibliotecas privadas en `/tmp/.mount_*`; heredarlas hace que binarios del
/// sistema como git carguen una versión incompatible de libpcre2.
pub fn child_environment() -> Vec<(String, String)> {
    let isolate_appimage = running_from_appimage();
    std::env::vars()
        .filter(|(key, _)| !isolate_appimage || !APPIMAGE_PRIVATE_ENV.contains(&key.as_str()))
        .collect()
}

/// Aplica el aislamiento al `Command` normal de Rust. Los procesos creados
/// desde una AppImage siguen viendo PATH, locale y preferencias del usuario,
/// pero nunca las bibliotecas del montaje efímero.
pub fn sanitize_child_environment(command: &mut Command) {
    if running_from_appimage() {
        for key in APPIMAGE_PRIVATE_ENV {
            command.env_remove(key);
        }
    }
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
    command
}

/// Ejecuta y espera, con un tope de tiempo. Un proceso que se cuelga (un
/// `wsl.exe` esperando a un servicio, un `docker` sin daemon) no debe dejar la
/// app bloqueada: pasado el plazo se mata y se devuelve `None`.
pub fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<Output> {
    let mut command = hidden_command(program);
    configure_process_tree(&mut command);
    let mut child = command.args(args).spawn().ok()?;

    // `Child` no ofrece espera con plazo en la biblioteca estándar. Un sondeo
    // corto es suficiente: estas llamadas o responden en milisegundos o no
    // responden nunca.
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
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
    }
    child.wait_with_output().ok()
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
    let output = run_with_timeout(program, args, timeout)?;
    if !output.status.success() {
        return None;
    }
    Some(decode_console_output(&output.stdout))
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
        assert!(!APPIMAGE_PRIVATE_ENV.contains(&"PATH"));
    }
}
