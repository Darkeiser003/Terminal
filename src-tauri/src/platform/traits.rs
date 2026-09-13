use std::path::PathBuf;
use std::process::Command;

/// Capacidades mínimas que el backend necesita para crear procesos del host.
pub trait ProcessPlatform {
    fn configure_background_command(&self, command: &mut Command);
    fn configure_detached_command(&self, command: &mut Command);
    fn sideloaded_conpty(&self) -> Option<PathBuf>;
}

/// Operaciones de PATH cuya implementación depende del sistema operativo.
/// La caché y la actualización del entorno del proceso permanecen en el
/// dominio `path_env`, porque son política compartida y no mecanismo del SO.
pub trait PathPlatform {
    fn path_separator(&self) -> char;
    fn normalize_path_key(&self, entry: &str) -> String;
    fn find_executable(&self, command: &str, path: &str) -> Option<PathBuf>;
    fn persistent_path_entries(&self) -> Vec<String>;
}

pub trait HostPlatform: ProcessPlatform + PathPlatform {
    fn is_windows(&self) -> bool;
    fn platform_id(&self) -> &'static str;
}
