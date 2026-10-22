//! Integración de WTerminal con Windows, siempre por usuario (HKCU).
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
    /// WTerminal se está ejecutando como administrador.
    pub elevated: bool,
    /// Cómo se abrirá NSudo: `direct`, `gsudo`, `windows-sudo` o
    /// `needs-admin` (`environments::NsudoLauncher`).
    pub nsudo_launcher: String,
    pub gsudo_path: Option<String>,
    /// Modo del sudo de Windows: `missing`, `disabled`, `new-window`,
    /// `input-disabled` o `inline`.
    pub windows_sudo: String,
    /// Este ejecutable lleva la marca de compatibilidad RUNASADMIN (escudo en
    /// el icono y UAC antes de abrirse). Solo la pone el usuario desde Ajustes.
    pub run_as_admin_flag: bool,
}

/// Donde Windows guarda, por usuario, la compatibilidad de cada ejecutable.
#[cfg(windows)]
const LAYERS_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";
const RUN_AS_ADMIN: &str = "RUNASADMIN";

/// Valor de `Layers` con la marca RUNASADMIN puesta o quitada, conservando las
/// demás marcas (`~ WIN8RTM RUNASADMIN`). `None` si no queda ninguna: entonces
/// el valor se borra en vez de dejarlo vacío.
pub fn layers_with_run_as_admin(existing: &str, enabled: bool) -> Option<String> {
    let mut flags: Vec<&str> = existing
        .split_whitespace()
        .filter(|flag| *flag != "~" && !flag.eq_ignore_ascii_case(RUN_AS_ADMIN))
        .collect();
    if enabled {
        flags.push(RUN_AS_ADMIN);
    }
    (!flags.is_empty()).then(|| format!("~ {}", flags.join(" ")))
}

#[cfg(windows)]
fn current_layers() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let name = std::env::current_exe().ok()?.to_string_lossy().into_owned();
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(LAYERS_KEY)
        .ok()?
        .get_value::<String, _>(&name)
        .ok()
}

#[cfg(windows)]
fn run_as_admin_flag_set() -> bool {
    current_layers().is_some_and(|value| {
        value
            .split_whitespace()
            .any(|flag| flag.eq_ignore_ascii_case(RUN_AS_ADMIN))
    })
}

/// Pone o quita la marca RUNASADMIN de este ejecutable, solo para el usuario
/// actual. Es la alternativa a «Iniciar siempre como administrador» para quien
/// quiere el escudo en el icono: Windows pide el UAC antes de abrirlo.
#[cfg(windows)]
pub fn set_run_as_admin_flag(enabled: bool) -> Result<WindowsIntegrationStatus, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = exe.to_string_lossy().into_owned();
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(LAYERS_KEY)
        .map_err(|error| error.to_string())?;
    let existing: String = key.get_value(&name).unwrap_or_default();
    match layers_with_run_as_admin(&existing, enabled) {
        Some(value) => key
            .set_value(&name, &value)
            .map_err(|error| error.to_string())?,
        None => {
            let _ = key.delete_value(&name);
        }
    }
    log_info!(
        "Marca de compatibilidad «ejecutar como administrador» actualizada",
        serde_json::json!({ "exe": name, "enabled": enabled })
    );
    Ok(status())
}

#[cfg(windows)]
fn command_value(exe: &std::path::Path, placeholder: &str) -> String {
    format!("\"{}\" \"--open-path\" \"{placeholder}\"", exe.display())
}

#[cfg(windows)]
fn key_exists(path: &str) -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(path).is_ok()
}

#[cfg(windows)]
fn context_menu_keys_registered() -> bool {
    [
        r"Software\Classes\Directory\Background\shell\WTerminal",
        r"Software\Classes\Directory\shell\WTerminal",
        r"Software\Classes\*\shell\WTerminal",
    ]
    .into_iter()
    .all(key_exists)
}

#[cfg(windows)]
pub fn status() -> WindowsIntegrationStatus {
    let nsudo_path = super::nsudo_path();
    WindowsIntegrationStatus {
        supported: true,
        context_menu_registered: context_menu_keys_registered(),
        protocol_registered: key_exists(r"Software\Classes\wterminal\shell\open\command"),
        app_path_registered: key_exists(r"Software\Microsoft\Windows\CurrentVersion\App Paths\wterminal.exe"),
        nsudo_available: nsudo_path.is_some(),
        nsudo_path,
        modern_default_terminal_supported: false,
        note: "Windows exige un servidor COM de delegación para sustituir el host de consola moderno; la integración segura registra menús, App Paths y el protocolo wterminal://.".into(),
        elevated: super::is_process_elevated(),
        nsudo_launcher: crate::environments::current_nsudo_launcher().as_str().to_string(),
        gsudo_path: super::gsudo_path().map(|path| path.to_string_lossy().into_owned()),
        windows_sudo: super::windows_sudo().as_str().to_string(),
        run_as_admin_flag: run_as_admin_flag_set(),
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
        elevated: false,
        nsudo_launcher: "direct".into(),
        gsudo_path: None,
        windows_sudo: "missing".into(),
        run_as_admin_flag: false,
    }
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<WindowsIntegrationStatus, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory_command = command_value(&exe, "%V");
    let file_command = command_value(&exe, "%1");
    let keys = [
        (
            r"Software\Classes\Directory\Background\shell\WTerminal",
            directory_command.as_str(),
        ),
        (
            r"Software\Classes\Directory\shell\WTerminal",
            directory_command.as_str(),
        ),
        (r"Software\Classes\*\shell\WTerminal", file_command.as_str()),
    ];
    if enabled {
        for (path, command) in keys {
            let (key, _) = hkcu
                .create_subkey(path)
                .map_err(|error| error.to_string())?;
            key.set_value("", &"Abrir con WTerminal")
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
            .create_subkey(r"Software\Classes\wterminal")
            .map_err(|error| error.to_string())?;
        protocol
            .set_value("", &"URL:WTerminal Protocol")
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
            .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\App Paths\wterminal.exe")
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
        for (path, _) in keys {
            let _ = hkcu.delete_subkey_all(path);
        }
        let _ = hkcu.delete_subkey_all(r"Software\Classes\wterminal");
        let _ = hkcu.delete_subkey_all(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\wterminal.exe",
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

/// Argumento que marca una copia ya relanzada como administrador: evita
/// volver a pedir el UAC en bucle si algo falla.
pub const ELEVATED_RELAUNCH_ARG: &str = "--elevated-relaunch";

/// Lo que decide «Iniciar siempre como administrador» al arrancar.
#[derive(Debug, Clone, Copy, Default)]
pub struct StartElevation {
    /// Esta copia ya es el relanzamiento (lleva `--elevated-relaunch`).
    pub relaunched: bool,
    /// E2E o smoke del build (`LTERMINAL_E2E_TESTING` o
    /// `LTERMINAL_E2E_DISABLE_ADMIN`): nunca piden el UAC.
    pub automated: bool,
    pub start_as_admin: bool,
    pub elevated: bool,
}

impl StartElevation {
    /// Relanzar solo si el usuario lo pidió, no es ya administrador y no es
    /// un relanzamiento ni una prueba automática.
    pub fn should_relaunch(self) -> bool {
        self.start_as_admin && !self.elevated && !self.relaunched && !self.automated
    }
}

/// Argumentos para la copia elevada: los mismos con los que se abrió esta,
/// más la marca de relanzamiento.
pub fn elevated_relaunch_arguments(current: &[String]) -> Vec<String> {
    current
        .iter()
        .filter(|argument| argument.as_str() != ELEVATED_RELAUNCH_ARG)
        .cloned()
        .chain(std::iter::once(ELEVATED_RELAUNCH_ARG.to_string()))
        .collect()
}

/// Abre otra copia de WTerminal como administrador (UAC). Si se lanzó, quien
/// llama cierra esta copia; con el aviso cancelado vuelve un error y todo
/// sigue como estaba.
#[cfg(windows)]
pub fn relaunch_elevated() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = std::env::current_dir().unwrap_or_else(|_| crate::paths::home_dir());
    let current: Vec<String> = std::env::args().skip(1).collect();
    super::run_elevated(
        &executable,
        &elevated_relaunch_arguments(&current),
        &directory,
    )
}

/// Argumentos para la copia sin elevar: los mismos con los que se abrió esta,
/// sin la marca del relanzamiento elevado.
pub fn unelevated_relaunch_arguments(current: &[String]) -> Vec<String> {
    current
        .iter()
        .filter(|argument| argument.as_str() != ELEVATED_RELAUNCH_ARG)
        .cloned()
        .collect()
}

/// Por qué no se puede volver a una copia sin elevar, o `None` si se puede:
/// solo si esta es administrador y nada la volvería a elevar al abrirse.
pub fn unelevated_restart_blocker(
    elevated: bool,
    start_as_admin: bool,
    run_as_admin_flag: bool,
) -> Option<&'static str> {
    if !elevated {
        Some("WTerminal ya se ejecuta sin permisos de administrador.")
    } else if start_as_admin {
        Some("Elige antes «Sin permisos de administrador»: con «Iniciar siempre como administrador» la copia nueva volvería a elevarse.")
    } else if run_as_admin_flag {
        Some("Elige antes «Sin permisos de administrador»: con la marca de WTerminal.exe Windows volvería a elevarlo.")
    } else {
        None
    }
}

/// Abre otra copia de WTerminal sin elevar (con el token del Explorador). Si
/// se lanzó, quien llama cierra esta copia.
#[cfg(windows)]
pub fn relaunch_unelevated() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = std::env::current_dir().unwrap_or_else(|_| crate::paths::home_dir());
    let current: Vec<String> = std::env::args().skip(1).collect();
    super::run_unelevated(
        &executable,
        &unelevated_relaunch_arguments(&current),
        &directory,
    )
}

/// `windows:runAsAdminFlag`: el escudo opcional del ejecutable (Ajustes →
/// Permisos de administrador).
#[tauri::command(async)]
pub fn windows_run_as_admin_set(enabled: bool) -> Result<WindowsIntegrationStatus, String> {
    #[cfg(windows)]
    {
        set_run_as_admin_flag(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Solo disponible en Windows".into())
    }
}

/// `app:restartAsAdmin`: «Reiniciar como administrador» de Ajustes.
#[tauri::command(async)]
pub fn app_restart_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        relaunch_elevated()?;
        log_info!("WTerminal se reinicia como administrador");
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Solo disponible en Windows".into())
    }
}

/// `app:restartUnelevated`: «Reiniciar sin permisos de administrador» de
/// Ajustes. Un proceso elevado no puede soltar sus permisos: se abre otra
/// copia sin elevar y esta se cierra.
#[tauri::command(async)]
pub fn app_restart_unelevated(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Some(reason) = unelevated_restart_blocker(
            super::is_process_elevated(),
            crate::preferences::current().start_as_admin,
            run_as_admin_flag_set(),
        ) {
            return Err(reason.to_string());
        }
        relaunch_unelevated()?;
        log_info!("WTerminal se reinicia sin permisos de administrador");
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Solo disponible en Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_marca_runasadmin_se_pone_y_quita_sin_tocar_las_demas() {
        assert_eq!(
            layers_with_run_as_admin("", true).as_deref(),
            Some("~ RUNASADMIN")
        );
        assert_eq!(layers_with_run_as_admin("~ RUNASADMIN", false), None);
        assert_eq!(
            layers_with_run_as_admin("~ WIN8RTM HIGHDPIAWARE", true).as_deref(),
            Some("~ WIN8RTM HIGHDPIAWARE RUNASADMIN")
        );
        assert_eq!(
            layers_with_run_as_admin("~ WIN8RTM runasadmin HIGHDPIAWARE", false).as_deref(),
            Some("~ WIN8RTM HIGHDPIAWARE")
        );
        // Ponerla dos veces no la duplica.
        assert_eq!(
            layers_with_run_as_admin("~ RUNASADMIN", true).as_deref(),
            Some("~ RUNASADMIN")
        );
    }

    #[test]
    fn solo_se_relanza_si_se_pidio_y_no_es_admin_ni_relanzamiento_ni_prueba() {
        let pedido = StartElevation {
            start_as_admin: true,
            ..StartElevation::default()
        };
        assert!(pedido.should_relaunch());
        assert!(!StartElevation::default().should_relaunch());
        for evitado in [
            StartElevation {
                elevated: true,
                ..pedido
            },
            StartElevation {
                relaunched: true,
                ..pedido
            },
            StartElevation {
                automated: true,
                ..pedido
            },
        ] {
            assert!(!evitado.should_relaunch(), "{evitado:?}");
        }
    }

    #[test]
    fn la_copia_elevada_recibe_los_mismos_argumentos_y_una_sola_marca() {
        let current = vec!["--open-path".to_string(), r"C:\x y".to_string()];
        assert_eq!(
            elevated_relaunch_arguments(&current),
            vec!["--open-path", r"C:\x y", ELEVATED_RELAUNCH_ARG]
        );
        let again = elevated_relaunch_arguments(&elevated_relaunch_arguments(&current));
        assert_eq!(
            again
                .iter()
                .filter(|arg| *arg == ELEVATED_RELAUNCH_ARG)
                .count(),
            1
        );
    }

    #[test]
    fn la_copia_sin_elevar_pierde_la_marca_y_conserva_lo_demas() {
        let current = vec![
            "--open-path".to_string(),
            r"C:\x y".to_string(),
            ELEVATED_RELAUNCH_ARG.to_string(),
        ];
        assert_eq!(
            unelevated_relaunch_arguments(&current),
            vec!["--open-path", r"C:\x y"]
        );
        assert!(unelevated_relaunch_arguments(&[]).is_empty());
    }

    #[test]
    fn solo_se_vuelve_sin_elevar_si_nada_lo_volveria_a_elevar() {
        assert_eq!(unelevated_restart_blocker(true, false, false), None);
        assert!(unelevated_restart_blocker(false, false, false)
            .is_some_and(|reason| reason.contains("ya se ejecuta sin")));
        assert!(unelevated_restart_blocker(true, true, false)
            .is_some_and(|reason| reason.contains("Iniciar siempre")));
        assert!(unelevated_restart_blocker(true, false, true)
            .is_some_and(|reason| reason.contains("marca")));
    }

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
