//! Integración de WinSlim Terminal con Windows, siempre por usuario (HKCU).
//! Nunca escribe HKLM ni suplanta los CLSID de delegación de consola: Windows
//! solo admite como terminal predeterminada moderna a hosts que implementan su
//! servidor de delegación. Sí registra App Paths, protocolo y menús de carpeta.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsIntegrationStatus {
    pub supported: bool,
    pub context_menu_registered: bool,
    pub protocol_registered: bool,
    pub app_path_registered: bool,
    pub nsudo_available: bool,
    pub nsudo_path: Option<String>,
    pub modern_default_terminal_supported: bool,
    pub note: String,
}

#[cfg(windows)]
fn command_value(exe: &std::path::Path) -> String {
    format!("\"{}\" \"%V\"", exe.display())
}

#[cfg(windows)]
fn key_exists(path: &str) -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(path).is_ok()
}

#[cfg(windows)]
pub fn status() -> WindowsIntegrationStatus {
    let nsudo_path = super::nsudo_path();
    WindowsIntegrationStatus {
        supported: true,
        context_menu_registered: key_exists(r"Software\Classes\Directory\Background\shell\WinSlimTerminal"),
        protocol_registered: key_exists(r"Software\Classes\winslim\shell\open\command"),
        app_path_registered: key_exists(r"Software\Microsoft\Windows\CurrentVersion\App Paths\winslim-terminal.exe"),
        nsudo_available: nsudo_path.is_some(),
        nsudo_path,
        modern_default_terminal_supported: false,
        note: "Windows exige un servidor COM de delegación para sustituir el host de consola moderno; la integración segura registra menús, App Paths y el protocolo winslim://.".into(),
    }
}

#[cfg(not(windows))]
pub fn status() -> WindowsIntegrationStatus {
    WindowsIntegrationStatus {
        supported: false,
        context_menu_registered: false,
        protocol_registered: false,
        app_path_registered: false,
        nsudo_available: false,
        nsudo_path: None,
        modern_default_terminal_supported: false,
        note: "Integración disponible únicamente en Windows.".into(),
    }
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<WindowsIntegrationStatus, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let command = command_value(&exe);
    let keys = [
        r"Software\Classes\Directory\Background\shell\WinSlimTerminal",
        r"Software\Classes\Directory\shell\WinSlimTerminal",
    ];
    if enabled {
        for path in keys {
            let (key, _) = hkcu
                .create_subkey(path)
                .map_err(|error| error.to_string())?;
            key.set_value("", &"Abrir con WinSlim Terminal")
                .map_err(|error| error.to_string())?;
            key.set_value("Icon", &exe.to_string_lossy().as_ref())
                .map_err(|error| error.to_string())?;
            let (command_key, _) = key
                .create_subkey("command")
                .map_err(|error| error.to_string())?;
            command_key
                .set_value("", &command)
                .map_err(|error| error.to_string())?;
        }
        let (protocol, _) = hkcu
            .create_subkey(r"Software\Classes\winslim")
            .map_err(|error| error.to_string())?;
        protocol
            .set_value("", &"URL:WinSlim Terminal Protocol")
            .map_err(|error| error.to_string())?;
        protocol
            .set_value("URL Protocol", &"")
            .map_err(|error| error.to_string())?;
        let (protocol_command, _) = protocol
            .create_subkey(r"shell\open\command")
            .map_err(|error| error.to_string())?;
        protocol_command
            .set_value("", &format!("\"{}\" \"%1\"", exe.display()))
            .map_err(|error| error.to_string())?;
        let (app_path, _) = hkcu
            .create_subkey(
                r"Software\Microsoft\Windows\CurrentVersion\App Paths\winslim-terminal.exe",
            )
            .map_err(|error| error.to_string())?;
        app_path
            .set_value("", &exe.to_string_lossy().as_ref())
            .map_err(|error| error.to_string())?;
        if let Some(parent) = exe.parent() {
            app_path
                .set_value("Path", &parent.to_string_lossy().as_ref())
                .map_err(|error| error.to_string())?;
        }
    } else {
        for path in keys {
            let _ = hkcu.delete_subkey_all(path);
        }
        let _ = hkcu.delete_subkey_all(r"Software\Classes\winslim");
        let _ = hkcu.delete_subkey_all(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\winslim-terminal.exe",
        );
    }
    Ok(status())
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<WindowsIntegrationStatus, String> {
    Err("La integración con el Registro solo existe en Windows".into())
}

#[tauri::command]
pub fn windows_integration_status() -> WindowsIntegrationStatus {
    status()
}

#[tauri::command(async)]
pub fn windows_integration_set(enabled: bool) -> Result<WindowsIntegrationStatus, String> {
    set_enabled(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn fuera_de_windows_la_integracion_se_declara_no_disponible() {
        let integration = status();
        assert!(!integration.supported);
        assert!(!integration.context_menu_registered);
        assert!(!integration.protocol_registered);
        assert!(!integration.app_path_registered);
        assert!(!integration.nsudo_available);
        assert_eq!(integration.nsudo_path, None);
        assert!(!integration.modern_default_terminal_supported);
        assert!(integration.note.contains("únicamente en Windows"));
    }

    #[cfg(not(windows))]
    #[test]
    fn fuera_de_windows_no_intenta_escribir_el_registro() {
        let error = set_enabled(true).expect_err("Linux no debe registrar integración Windows");
        assert!(error.contains("solo existe en Windows"));
    }
}
