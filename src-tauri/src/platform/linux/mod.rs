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
        // En Linux el PATH persistente depende de la shell y sus perfiles.
        // Las pestañas interactivas lo recalculan al arrancar; no existe un
        // almacén global equivalente al Registro de Windows.
        Vec::new()
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
