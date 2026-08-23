mod path;

use std::path::PathBuf;
use std::process::Command;

use super::traits::{HostPlatform, PathPlatform, ProcessPlatform};

pub struct LinuxPlatform;

impl ProcessPlatform for LinuxPlatform {
    fn configure_background_command(&self, _command: &mut Command) {}

    fn configure_detached_command(&self, _command: &mut Command) {}

    fn sideloaded_conpty(&self) -> Option<PathBuf> {
        None
    }
}

impl PathPlatform for LinuxPlatform {
    fn path_separator(&self) -> char {
        ':'
    }

    fn normalize_path_key(&self, entry: &str) -> String {
        entry
            .trim()
            .trim_matches('"')
            .trim_end_matches(['\\', '/'])
            .to_string()
    }

    fn find_executable(&self, command: &str, path_value: &str) -> Option<PathBuf> {
        path::find_executable(command, path_value)
    }

    fn persistent_path_entries(&self) -> Vec<String> {
        // Linux no tiene un almacén global equivalente al Registro de
        // Windows, pero los gestores de usuario sí tienen ubicaciones
        // convencionales. La app puede llevar horas abierta cuando el
        // usuario instala una herramienta desde una terminal, así que no
        // basta con confiar en el PATH que heredó al arrancar.
        let Some(home) = std::env::var_os("HOME") else {
            return Vec::new();
        };
        let home = PathBuf::from(home);
        let candidates = [
            home.join(".cargo/bin"),
            home.join("go/bin"),
            home.join(".mix/escripts"),
            home.join(".dotnet/tools"),
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
        ];
        candidates
            .into_iter()
            .filter(|path| path.is_dir())
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }
}

impl HostPlatform for LinuxPlatform {
    fn is_windows(&self) -> bool {
        false
    }

    fn platform_id(&self) -> &'static str {
        "linux"
    }
}

pub fn run_wsl(_args: &[&str], _timeout: std::time::Duration) -> Option<std::process::Output> {
    None
}

pub fn probe_virtualization() -> Option<String> {
    None
}

pub fn nsudo_path() -> Option<String> {
    None
}

pub fn open_path(_app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    crate::file_viewers::open_linux_associated_path(path)
}

pub fn open_directory(_app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    crate::file_viewers::open_linux_directory(path)
}
