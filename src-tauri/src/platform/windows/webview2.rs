//! Preflight del runtime WebView2 para la copia portable de Windows.
//!
//! `WebView2Loader.dll` es únicamente el puente nativo; el motor Evergreen se
//! instala aparte en Windows. El instalador NSIS ya lo prepara, pero una copia
//! portable puede ejecutarse antes de que exista. En ese caso intentamos usar
//! el bootstrapper distribuido junto al ejecutable o, en el portable de un
//! solo archivo, el que lleva dentro (`single_file`).

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

use super::CREATE_NO_WINDOW;

const WEBVIEW2_CLIENT: &str =
    r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_CLIENT_WOW6432: &str =
    r"Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const BOOTSTRAPPER_NAMES: [&str; 2] =
    ["MicrosoftEdgeWebView2Setup.exe", "WebView2Bootstrapper.exe"];

type RegistryRoot = *mut std::ffi::c_void;

fn registered_runtime(root: RegistryRoot, path: &str, view: u32) -> bool {
    RegKey::predef(root)
        .open_subkey_with_flags(path, KEY_READ | view)
        .ok()
        .and_then(|key| key.get_value::<String, _>("pv").ok())
        .is_some_and(|version| !version.trim().is_empty())
}

fn runtime_is_registered() -> bool {
    [
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT),
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_WOW6432),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_WOW6432),
    ]
    .into_iter()
    .any(|(root, path)| {
        registered_runtime(root, path, KEY_WOW64_64KEY)
            || registered_runtime(root, path, KEY_WOW64_32KEY)
    })
}

fn bootstrapper_path() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    BOOTSTRAPPER_NAMES
        .iter()
        .map(|name| exe_dir.join(name))
        .find(|path| path.is_file())
}

/// El instalador que lleva dentro el portable de un solo archivo, sacado a una
/// carpeta temporal propia que se borra al terminar la instalación.
struct EmbeddedInstaller {
    folder: PathBuf,
    path: PathBuf,
}

impl EmbeddedInstaller {
    fn extract() -> Option<Self> {
        let payload = crate::single_file::current()?;
        let folder =
            std::env::temp_dir().join(format!("WTerminal-WebView2-{}", std::process::id()));
        let path = folder.join(crate::single_file::WEBVIEW2_INSTALLER);
        match payload.extract(crate::single_file::WEBVIEW2_INSTALLER, &path) {
            Ok(()) => Some(Self { folder, path }),
            Err(error) => {
                eprintln!("No se pudo preparar el instalador embebido de WebView2: {error}");
                let _ = std::fs::remove_dir_all(&folder);
                None
            }
        }
    }
}

impl Drop for EmbeddedInstaller {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

/// Comprueba WebView2 y, si el portable trae el bootstrapper (junto al
/// ejecutable o dentro de él), lo instala de forma silenciosa antes de que
/// Tauri cree la primera ventana.
pub fn ensure_runtime() -> bool {
    if runtime_is_registered() {
        return true;
    }
    if std::env::var("LTERMINAL_WEBVIEW2_AUTO_INSTALL").as_deref() == Ok("0") {
        eprintln!("WebView2 Runtime ausente; instalación automática desactivada.");
        return false;
    }
    // Vive hasta el final de la función: su carpeta temporal se borra al
    // soltarlo, cuando la instalación ya ha terminado.
    let embedded: Option<EmbeddedInstaller>;
    let installer = match bootstrapper_path() {
        Some(path) => path,
        None => {
            embedded = EmbeddedInstaller::extract();
            let Some(embedded) = embedded.as_ref() else {
                eprintln!("WebView2 Runtime ausente y no se encontró el bootstrapper portable.");
                return false;
            };
            embedded.path.clone()
        }
    };

    eprintln!(
        "WebView2 Runtime ausente; instalando desde {}.",
        installer.display()
    );
    let mut command = Command::new(&installer);
    command.args(["/silent", "/install"]);
    command.creation_flags(CREATE_NO_WINDOW);
    match command.status() {
        Ok(status) if status.success() => runtime_is_registered(),
        Ok(status) => {
            eprintln!("El bootstrapper de WebView2 terminó con {}.", status);
            false
        }
        Err(error) => {
            eprintln!("No se pudo ejecutar el bootstrapper de WebView2: {error}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn los_nombres_del_bootstrapper_son_portables_y_explicitos() {
        assert!(BOOTSTRAPPER_NAMES.iter().all(|name| Path::new(name)
            .extension()
            .is_some_and(|extension| extension == "exe")));
    }

    #[test]
    fn las_claves_cubren_hklm_hkcu_y_las_dos_vistas() {
        assert!(WEBVIEW2_CLIENT.contains("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5"));
        assert!(WEBVIEW2_CLIENT_WOW6432.contains("WOW6432Node"));
    }
}
