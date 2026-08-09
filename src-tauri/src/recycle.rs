//! Enviar a la papelera del sistema.
//!
//! En la versión Electron esto lo hacía `shell.trashItem`. El equivalente
//! natural en Rust sería el crate `trash`, pero sus versiones 4 y 5 no
//! compilan con el toolchain de este proyecto (un error dentro de su binding
//! de Windows), así que se hace con lo que cada sistema ya trae:
//!
//!   - Windows: el método de VisualBasic que expone PowerShell, que es la vía
//!     documentada para reciclar desde un script y respeta la configuración de
//!     la papelera del usuario.
//!   - Linux: `gio trash`, presente en cualquier escritorio con GLib, y si no
//!     está, la especificación freedesktop escrita a mano.
//!   - macOS: Finder vía `osascript`.
//!
//! Borrar de verdad no es una opción: el explorador ofrece "enviar a la
//! papelera" justamente porque es reversible desde el propio sistema.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::process;

const TRASH_TIMEOUT: Duration = Duration::from_secs(15);

/// Escapa una ruta para meterla en una cadena literal de PowerShell.
#[allow(dead_code)]
fn ps_literal(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
}

pub fn send_to_trash(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err("El archivo o la carpeta ya no existe.".into());
    }
    send_to_platform_trash(path, target)
}

#[cfg(windows)]
fn send_to_platform_trash(path: &str, target: &Path) -> Result<(), String> {
    {
        // `DeleteFile` para archivos y `DeleteDirectory` para carpetas: son dos
        // métodos distintos y llamar al que no toca falla.
        let method = if target.is_dir() {
            "DeleteDirectory"
        } else {
            "DeleteFile"
        };
        let script = format!(
            "Add-Type -AssemblyName Microsoft.VisualBasic; \
             [Microsoft.VisualBasic.FileIO.FileSystem]::{method}({}, \
             'OnlyErrorDialogs', 'SendToRecycleBin')",
            ps_literal(path)
        );
        run_or_error(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        )
    }
}

#[cfg(target_os = "macos")]
fn send_to_platform_trash(path: &str, _target: &Path) -> Result<(), String> {
    let script = format!(
        "tell application \"Finder\" to delete POSIX file \"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    );
    run_or_error("osascript", &["-e", &script])
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn send_to_platform_trash(path: &str, target: &Path) -> Result<(), String> {
    if crate::path_env::which("gio").is_some() {
        return run_or_error("gio", &["trash", "--", path]);
    }
    freedesktop_trash(target)
}

#[allow(dead_code)]
fn run_or_error(program: &str, args: &[&str]) -> Result<(), String> {
    match process::run_with_timeout(program, args, TRASH_TIMEOUT) {
        Some(output) if output.status.success() => Ok(()),
        Some(_) => Err("El sistema rechazó enviarlo a la papelera.".into()),
        None => Err(format!("No se pudo ejecutar {program}.")),
    }
}

/// La papelera de freedesktop: el archivo se mueve a
/// `~/.local/share/Trash/files` y se deja al lado un `.trashinfo` con su origen
/// y la fecha, que es lo que permite restaurarlo.
#[allow(dead_code)]
fn freedesktop_trash(target: &Path) -> Result<(), String> {
    let home = crate::paths::home_dir();
    let trash = home.join(".local").join("share").join("Trash");
    let files = trash.join("files");
    let info = trash.join("info");
    std::fs::create_dir_all(&files).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&info).map_err(|error| error.to_string())?;

    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or("La ruta no tiene nombre.")?;
    let (final_name, destination) = free_name(&files, &name);

    let absolute = std::fs::canonicalize(target)
        .unwrap_or_else(|_| PathBuf::from(target))
        .to_string_lossy()
        .to_string();
    let entry = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        urlencode(&absolute),
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S")
    );
    std::fs::write(info.join(format!("{final_name}.trashinfo")), entry)
        .map_err(|error| error.to_string())?;
    std::fs::rename(target, &destination).map_err(|error| error.to_string())
}

/// Un nombre libre dentro de la papelera: dos archivos distintos pueden
/// llamarse igual y el segundo no debe pisar al primero.
#[allow(dead_code)]
fn free_name(files: &Path, name: &str) -> (String, PathBuf) {
    if !files.join(name).exists() {
        return (name.to_string(), files.join(name));
    }
    let (base, ext) = match name.rfind('.') {
        Some(0) | None => (name, ""),
        Some(index) => (&name[..index], &name[index..]),
    };
    for index in 2..10_000 {
        let candidate = format!("{base}.{index}{ext}");
        if !files.join(&candidate).exists() {
            return (candidate.clone(), files.join(candidate));
        }
    }
    (name.to_string(), files.join(name))
}

/// Los `.trashinfo` guardan la ruta con codificación de URL, según la
/// especificación.
#[allow(dead_code)]
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_ruta_que_no_existe_se_rechaza_sin_tocar_el_sistema() {
        let result = send_to_trash("/ruta/que/no/existe/lterminal-xyz");
        assert_eq!(result, Err("El archivo o la carpeta ya no existe.".into()));
    }

    #[test]
    fn la_comilla_simple_no_rompe_el_literal_de_powershell() {
        assert_eq!(ps_literal("C:\\L'App\\x.txt"), "'C:\\L''App\\x.txt'");
    }

    #[test]
    fn la_ruta_del_trashinfo_va_codificada() {
        assert_eq!(
            urlencode("/home/ana/mi archivo.txt"),
            "/home/ana/mi%20archivo.txt"
        );
        assert_eq!(urlencode("/home/ana/dato.txt"), "/home/ana/dato.txt");
        assert_eq!(urlencode("/tmp/ñ"), "/tmp/%C3%B1");
    }

    #[test]
    fn en_la_papelera_dos_archivos_del_mismo_nombre_no_se_pisan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notas.md"), "").unwrap();
        let (name, _) = free_name(dir.path(), "notas.md");
        assert_eq!(name, "notas.2.md");

        let (libre, _) = free_name(dir.path(), "otro.md");
        assert_eq!(libre, "otro.md");
    }
}
