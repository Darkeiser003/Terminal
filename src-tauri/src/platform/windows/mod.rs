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

    fn find_executable(&self, command: &str, _path_value: &str) -> Option<PathBuf> {
        path::find_executable(command)
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
    const KNOWN: [&str; 5] = [
        r"C:\WSCore\Components\Hooks\NSudo\NSudoLC.exe",
        r"C:\Program Files\NSudo\NSudoLC.exe",
        r"C:\Program Files\NSudo Launcher\NSudoLC.exe",
        r"C:\Program Files (x86)\NSudo\NSudoLC.exe",
        r"C:\Tools\NSudo\NSudoLC.exe",
    ];
    if let Some(path) = KNOWN
        .iter()
        .find(|path| std::path::Path::new(path).is_file())
    {
        return Some((*path).to_string());
    }
    path::find_executable("NSudoLC.exe")
        .or_else(|| path::find_executable("NSudo.exe"))
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
