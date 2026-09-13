mod path;

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use super::traits::{HostPlatform, PathPlatform, ProcessPlatform};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct WindowsPlatform;

impl ProcessPlatform for WindowsPlatform {
    fn configure_background_command(&self, command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    fn configure_detached_command(&self, command: &mut Command) {
        // DETACHED_PROCESS | CREATE_NO_WINDOW
        command.creation_flags(0x0000_0008 | CREATE_NO_WINDOW);
    }

    fn sideloaded_conpty(&self) -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let folder = exe.parent()?;
        let dll = folder.join("conpty.dll");
        let host = folder.join("OpenConsole.exe");
        // `conpty.dll` carga este host al crear la pseudoconsola. Devolver la
        // DLL como válida si falta el ejecutable deja la pestaña sin shell y
        // oculta la causa real en el arranque.
        (dll.is_file() && host.is_file()).then_some(dll)
    }
}

impl PathPlatform for WindowsPlatform {
    fn path_separator(&self) -> char {
        ';'
    }

    fn normalize_path_key(&self, entry: &str) -> String {
        entry
            .trim()
            .trim_matches('"')
            .to_lowercase()
            .trim_end_matches(['\\', '/'])
            .to_string()
    }

    fn find_executable(&self, command: &str, path_value: &str) -> Option<PathBuf> {
        path::find_executable(command, path_value)
    }

    fn persistent_path_entries(&self) -> Vec<String> {
        path::persistent_path_entries()
    }
}

impl HostPlatform for WindowsPlatform {
    fn is_windows(&self) -> bool {
        true
    }

    fn platform_id(&self) -> &'static str {
        "windows"
    }
}

pub fn run_wsl(args: &[&str], timeout: std::time::Duration) -> Option<std::process::Output> {
    crate::process::run_with_timeout("wsl.exe", args, timeout)
}

pub fn probe_virtualization() -> Option<String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    let script = "$p = @(Get-CimInstance Win32_Processor)[0]; \
                  $c = Get-CimInstance Win32_ComputerSystem; \
                  Write-Output $p.VirtualizationFirmwareEnabled; \
                  Write-Output $c.HypervisorPresent";
    crate::process::output_text(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
        PROBE_TIMEOUT,
    )
}

pub fn nsudo_path() -> Option<String> {
    // NSudoLC es el ejecutable de consola. WSCore no siempre está instalado
    // en C:, y durante el desarrollo el binario puede vivir en una subcarpeta
    // de la instalación, así que no basta con una ruta absoluta fija.
    const NSUDO_NAMES: [&str; 3] = ["NSudoLC.exe", "NSudoC.exe", "NSudo.exe"];
    let mut directories = vec![
        PathBuf::from(r"C:\WSCore\Components\Hooks\NSudo"),
        PathBuf::from(r"C:\Program Files\NSudo"),
        PathBuf::from(r"C:\Program Files\NSudo Launcher"),
        PathBuf::from(r"C:\Program Files (x86)\NSudo"),
        PathBuf::from(r"C:\Tools\NSudo"),
    ];

    // Busca también la carpeta WSCore a partir de la copia que realmente se
    // está ejecutando (por ejemplo D:\WSCore o una instalación portátil).
    if let Ok(exe) = std::env::current_exe() {
        let mut ancestor = exe.parent();
        while let Some(directory) = ancestor {
            directories.push(directory.join(r"Components\Hooks\NSudo"));
            ancestor = directory.parent();
        }
    }

    for directory in directories {
        for name in NSUDO_NAMES {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }

    let path_value = std::env::var("PATH").unwrap_or_default();
    NSUDO_NAMES
        .into_iter()
        .find_map(|name| path::find_executable(name, &path_value))
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn open_path(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn open_directory(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    open_path(app, path)
}
