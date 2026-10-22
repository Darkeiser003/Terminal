//! Permite invocar WTerminal como `wterminal` desde shells del usuario.
//!
//! Windows registra solo el PATH de HKCU y avisa a las aplicaciones del
//! cambio. Linux crea un lanzador gestionado en `~/.local/bin` y añade esa
//! carpeta a los perfiles de shell más comunes. No necesita permisos root.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathIntegrationStatus {
    pub supported: bool,
    pub enabled: bool,
    pub command: String,
    pub location: Option<String>,
    pub note: String,
}

fn should_auto_enable(preference: Option<bool>, enabled: bool) -> bool {
    preference != Some(false) && !enabled
}

fn e2e_skips_path_auto() -> bool {
    std::env::var("LTERMINAL_E2E_DISABLE_PATH_AUTO").as_deref() == Ok("1")
}

/// Misma carpeta en un PATH de Windows: sin comillas, sin barra final, con
/// cualquier barra y sin distinguir mayúsculas.
fn same_windows_dir(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .trim()
            .trim_matches('"')
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

/// PATH de usuario con las carpetas `bin` de las herramientas centralizadas.
/// Quita las que WTerminal añadió antes y ya no tocan, añade al final las que
/// faltan (al final: no tapan nada que el usuario ya tuviera) y devuelve
/// también cuáles son suyas: una carpeta que ya estaba en el PATH no se apunta
/// como añadida, así que nunca se quita al desactivarlo.
pub fn path_with_tool_bins(
    path: &str,
    previously_added: &[String],
    desired: &[String],
) -> (String, Vec<String>) {
    let mut entries: Vec<String> = path
        .split(';')
        .filter(|entry| !entry.trim().is_empty())
        .filter(|entry| {
            let ours = previously_added
                .iter()
                .any(|added| same_windows_dir(entry, added));
            let wanted = desired.iter().any(|dir| same_windows_dir(entry, dir));
            !ours || wanted
        })
        .map(str::to_string)
        .collect();
    let mut added = Vec::new();
    for dir in desired {
        let present = entries.iter().any(|entry| same_windows_dir(entry, dir));
        let was_ours = previously_added
            .iter()
            .any(|previous| same_windows_dir(previous, dir));
        if !present {
            entries.push(dir.clone());
            added.push(dir.clone());
        } else if was_ours {
            added.push(dir.clone());
        }
    }
    (entries.join(";"), added)
}

/// Pone en el PATH del usuario las carpetas `bin` de «Herramientas y lenguajes
/// nuevos» mientras la integración con el PATH esté activa, y las quita si se
/// apaga la categoría o la integración: lo que se instala desde WTerminal se ve
/// en cualquier terminal. Nunca en pruebas (`LTERMINAL_E2E_DISABLE_PATH_AUTO`).
pub fn sync_tool_bins() -> Result<(), String> {
    // Los tests de unidad que guardan ajustes tampoco tocan el PATH real.
    if cfg!(test) || e2e_skips_path_auto() {
        return Ok(());
    }
    host::sync_tool_bins(&crate::config::toolchain_store::published_bin_dirs())
}

#[cfg(windows)]
mod host {
    use super::PathIntegrationStatus;
    use std::path::{Path, PathBuf};
    use winreg::{enums::*, RegKey, RegValue};

    const ENVIRONMENT: &str = r"Environment";
    const STATE: &str = r"Software\WTerminal\PathIntegration";

    fn exe_directory() -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        exe.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "No se pudo resolver la carpeta de WTerminal".into())
    }

    fn equal_path(left: &str, right: &str) -> bool {
        let normalize = |value: &str| {
            value
                .trim()
                .trim_matches('"')
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        };
        normalize(left) == normalize(right)
    }

    fn read_path() -> (String, Option<RegType>) {
        let key = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(environment) = key.open_subkey_with_flags(ENVIRONMENT, KEY_READ) else {
            return (String::new(), None);
        };
        let Ok(value) = environment.get_raw_value("Path") else {
            return (String::new(), None);
        };
        let path = environment.get_value("Path").unwrap_or_default();
        (path, Some(value.vtype))
    }

    fn write_path(path: &str, value_type: Option<RegType>) -> Result<(), String> {
        let key = RegKey::predef(HKEY_CURRENT_USER);
        let (environment, _) = key
            .create_subkey(ENVIRONMENT)
            .map_err(|error| format!("No se pudo abrir el PATH del usuario: {error}"))?;
        if path.is_empty() {
            let _ = environment.delete_value("Path");
        } else {
            let kind = value_type
                .filter(|kind| *kind == REG_SZ || *kind == REG_EXPAND_SZ)
                .unwrap_or(REG_EXPAND_SZ);
            let mut bytes: Vec<u8> = path.encode_utf16().flat_map(u16::to_le_bytes).collect();
            bytes.extend_from_slice(&[0, 0]);
            environment
                .set_raw_value(
                    "Path",
                    &RegValue {
                        vtype: kind,
                        bytes: bytes.into(),
                    },
                )
                .map_err(|error| format!("No se pudo guardar el PATH del usuario: {error}"))?;
        }
        broadcast_environment_change();
        Ok(())
    }

    fn registered_path() -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(STATE, KEY_READ)
            .ok()?
            .get_value("RegisteredPath")
            .ok()
    }

    fn registered_entry_was_added() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(STATE, KEY_READ)
            .ok()
            .and_then(|state| state.get_value::<u32, _>("AddedEntry").ok())
            .is_some_and(|value| value != 0)
    }

    fn auto_add_preference() -> Option<bool> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(STATE, KEY_READ)
            .ok()?
            .get_value::<u32, _>("AutoAdd")
            .ok()
            .map(|value| value != 0)
    }

    fn save_auto_add_preference(enabled: bool) -> Result<(), String> {
        if super::e2e_skips_path_auto() {
            return Ok(());
        }
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let (state, _) = root
            .create_subkey(STATE)
            .map_err(|error| format!("No se pudo guardar la preferencia del PATH: {error}"))?;
        state
            .set_value("AutoAdd", &u32::from(enabled))
            .map_err(|error| error.to_string())
    }

    fn save_registered_path(path: Option<(&str, bool)>) -> Result<(), String> {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        if let Some((path, added_entry)) = path {
            let (state, _) = root
                .create_subkey(STATE)
                .map_err(|error| format!("No se pudo guardar el estado del PATH: {error}"))?;
            state
                .set_value("RegisteredPath", &path)
                .and_then(|()| state.set_value("AddedEntry", &u32::from(added_entry)))
                .map_err(|error| error.to_string())?;
        } else if let Ok(state) = root.open_subkey_with_flags(STATE, KEY_WRITE) {
            let _ = state.delete_value("RegisteredPath");
            let _ = state.delete_value("AddedEntry");
        }
        Ok(())
    }

    fn broadcast_environment_change() {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::null_mut;
        const HWND_BROADCAST: isize = 0xffff;
        const WM_SETTINGCHANGE: u32 = 0x001a;
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        #[link(name = "user32")]
        unsafe extern "system" {
            fn SendMessageTimeoutW(
                hwnd: isize,
                msg: u32,
                wparam: usize,
                lparam: *const u16,
                flags: u32,
                timeout: u32,
                result: *mut usize,
            ) -> isize;
        }
        let setting: Vec<u16> = OsStr::new("Environment")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                setting.as_ptr(),
                SMTO_ABORTIFHUNG,
                5000,
                null_mut(),
            );
        }
    }

    pub fn status() -> Result<PathIntegrationStatus, String> {
        let (path, _) = read_path();
        let registered = registered_path();
        let enabled = registered
            .as_deref()
            .is_some_and(|entry| path.split(';').any(|part| equal_path(part, entry)));
        Ok(PathIntegrationStatus {
            supported: true,
            enabled,
            command: "wterminal".into(),
            location: registered.or_else(|| exe_directory().ok().map(|path| path.display().to_string())),
            note: "WTerminal se añade automáticamente al PATH del usuario al iniciar por primera vez. Puedes desactivarlo aquí; las consolas abiertas deben reiniciarse para recibir cambios.".into(),
        })
    }

    pub fn set_enabled(enabled: bool) -> Result<PathIntegrationStatus, String> {
        let (path, kind) = read_path();
        if enabled {
            let directory = exe_directory()?;
            let directory = directory.to_string_lossy().into_owned();
            let previous = registered_path();
            let previous_was_added = registered_entry_was_added();
            let already_present = path.split(';').any(|entry| equal_path(entry, &directory));
            let added_entry = !already_present
                || (previous_was_added
                    && previous
                        .as_deref()
                        .is_some_and(|old| equal_path(old, &directory)));
            let filtered = path
                .split(';')
                .filter(|entry| !entry.is_empty())
                .filter(|entry| {
                    !previous_was_added
                        || previous
                            .as_deref()
                            .map_or(true, |old| !equal_path(entry, old))
                })
                .filter(|entry| !equal_path(entry, &directory))
                .map(str::to_string)
                .collect::<Vec<_>>();
            let mut entries = vec![directory.clone()];
            entries.extend(filtered);
            write_path(&entries.join(";"), kind)?;
            save_registered_path(Some((&directory, added_entry)))?;
            let process_path = std::env::var("PATH").unwrap_or_default();
            if !process_path
                .split(';')
                .any(|entry| equal_path(entry, &directory))
            {
                std::env::set_var("PATH", format!("{directory};{process_path}"));
            }
        } else {
            let previous = registered_path();
            if let Some(directory) = previous.as_deref().filter(|_| registered_entry_was_added()) {
                let process_path = std::env::var("PATH").unwrap_or_default();
                let (stored_path, kind) = read_path();
                let filtered_stored = stored_path
                    .split(';')
                    .filter(|entry| !equal_path(entry, directory))
                    .collect::<Vec<_>>()
                    .join(";");
                write_path(&filtered_stored, kind)?;
                let filtered_process = process_path
                    .split(';')
                    .filter(|entry| !equal_path(entry, directory))
                    .collect::<Vec<_>>()
                    .join(";");
                std::env::set_var("PATH", filtered_process);
            }
            save_registered_path(None)?;
        }
        save_auto_add_preference(enabled)?;
        // Las carpetas bin de las herramientas van y vienen con la integración.
        if let Err(error) = super::sync_tool_bins() {
            log_warn!(
                "No se pudieron actualizar las carpetas de herramientas en el PATH",
                serde_json::json!({ "error": error })
            );
        }
        status()
    }

    pub fn ensure_default_enabled() -> Result<(), String> {
        if !super::should_auto_enable(auto_add_preference(), status()?.enabled) {
            return Ok(());
        }
        set_enabled(true).map(|_| ())
    }

    const TOOL_BINS: &str = "ToolBinDirs";

    /// Carpetas de herramientas que WTerminal añadió al PATH del usuario.
    fn added_tool_bins() -> Vec<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(STATE, KEY_READ)
            .ok()
            .and_then(|state| state.get_value::<String, _>(TOOL_BINS).ok())
            .map(|value| {
                value
                    .split(';')
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn save_added_tool_bins(dirs: &[String]) -> Result<(), String> {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        if dirs.is_empty() {
            if let Ok(state) = root.open_subkey_with_flags(STATE, KEY_WRITE) {
                let _ = state.delete_value(TOOL_BINS);
            }
            return Ok(());
        }
        let (state, _) = root
            .create_subkey(STATE)
            .map_err(|error| format!("No se pudo guardar el estado del PATH: {error}"))?;
        state
            .set_value(TOOL_BINS, &dirs.join(";"))
            .map_err(|error| error.to_string())
    }

    pub fn sync_tool_bins(desired: &[PathBuf]) -> Result<(), String> {
        let desired: Vec<String> = if status()?.enabled {
            desired
                .iter()
                .map(|dir| dir.to_string_lossy().into_owned())
                .collect()
        } else {
            Vec::new()
        };
        let previous = added_tool_bins();
        let (path, kind) = read_path();
        let (next, added) = super::path_with_tool_bins(&path, &previous, &desired);
        if next != path {
            write_path(&next, kind)?;
            log_info!(
                "Carpetas de herramientas de WTerminal en el PATH del usuario",
                serde_json::json!({ "dirs": added })
            );
        }
        save_added_tool_bins(&added)
    }

    #[cfg(test)]
    pub(super) fn same_path(left: &str, right: &str) -> bool {
        equal_path(left, right)
    }
}

#[cfg(target_os = "linux")]
mod host {
    use super::PathIntegrationStatus;
    use std::path::{Path, PathBuf};

    const START: &str = "# >>> WTerminal managed PATH >>>";
    const END: &str = "# <<< WTerminal managed PATH <<<";
    const ADDED_SEPARATOR: &str = "# WTerminal added a line break before this block";
    const LAUNCHER_MARKER: &str = "# WTerminal managed launcher v1";

    fn auto_add_preference_path() -> Result<PathBuf, String> {
        Ok(crate::paths::user_data_dir().join("path-integration-auto"))
    }

    fn auto_add_preference() -> Result<Option<bool>, String> {
        match std::fs::read_to_string(auto_add_preference_path()?) {
            Ok(value) if value.trim() == "enabled" => Ok(Some(true)),
            Ok(value) if value.trim() == "disabled" => Ok(Some(false)),
            Ok(_) => Err("La preferencia automática del PATH no es válida".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save_auto_add_preference(enabled: bool) -> Result<(), String> {
        if super::e2e_skips_path_auto() {
            return Ok(());
        }
        let path = auto_add_preference_path()?;
        let value = if enabled { "enabled\n" } else { "disabled\n" };
        write_atomic(&path, value)
    }

    fn home() -> Result<PathBuf, String> {
        dirs::home_dir().ok_or_else(|| "No se pudo resolver la carpeta personal".into())
    }

    fn launcher_path() -> Result<PathBuf, String> {
        Ok(home()?.join(".local/bin/wterminal"))
    }

    fn app_executable() -> Result<PathBuf, String> {
        if let Some(path) = crate::install_dir::appimage_path() {
            return Ok(path);
        }
        std::env::current_exe().map_err(|error| error.to_string())
    }

    fn shell_files(root: &Path) -> Vec<(PathBuf, bool)> {
        vec![
            (root.join(".profile"), false),
            (root.join(".bashrc"), false),
            (root.join(".zprofile"), false),
            (root.join(".zshenv"), false),
            (root.join(".config/fish/config.fish"), true),
        ]
    }

    fn managed_block(fish: bool, added_separator: bool) -> String {
        let separator = if added_separator {
            format!("{ADDED_SEPARATOR}\n")
        } else {
            String::new()
        };
        if fish {
            format!("{START}\n{separator}fish_add_path -- \"$HOME/.local/bin\"\n{END}")
        } else {
            format!("{START}\n{separator}case \":$PATH:\" in *\":$HOME/.local/bin:\"*) ;; *) export PATH=\"$HOME/.local/bin:$PATH\" ;; esac\n{END}")
        }
    }

    fn update_block(contents: &str, fish: bool, enabled: bool) -> Result<String, String> {
        let start = contents.find(START);
        let end = contents.find(END);
        let mut result = match (start, end) {
            (Some(start), Some(end)) if end >= start => {
                let after = end + END.len();
                let block_added_separator = contents[start..end].contains(ADDED_SEPARATOR);
                let mut prefix = &contents[..start];
                if block_added_separator {
                    prefix = prefix.strip_suffix('\n').unwrap_or(prefix);
                }
                let suffix = contents[after..].strip_prefix('\n').unwrap_or(&contents[after..]);
                let mut text = String::new();
                text.push_str(prefix);
                text.push_str(suffix);
                text
            }
            (None, None) => contents.to_string(),
            _ => return Err("El bloque de PATH gestionado en un perfil de shell está dañado; no se ha modificado".into()),
        };
        if enabled {
            let added_separator = !result.is_empty() && !result.ends_with('\n');
            if added_separator {
                result.push('\n');
            }
            result.push_str(&managed_block(fish, added_separator));
            result.push('\n');
        }
        Ok(result)
    }

    fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
        let existing_permissions = std::fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temp = path.with_extension(format!("wterminal-{}.tmp", std::process::id()));
        std::fs::write(&temp, contents).map_err(|error| error.to_string())?;
        if let Some(permissions) = existing_permissions {
            if let Err(error) = std::fs::set_permissions(&temp, permissions) {
                let _ = std::fs::remove_file(&temp);
                return Err(error.to_string());
            }
        }
        std::fs::rename(&temp, path).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            error.to_string()
        })
    }

    fn update_shell_files(enabled: bool) -> Result<(), String> {
        let root = home()?;
        for (path, fish) in shell_files(&root) {
            let effective_path = match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    path.canonicalize().map_err(|error| {
                        format!("No se pudo resolver el perfil {}: {error}", path.display())
                    })?
                }
                _ => path.clone(),
            };
            let contents = match std::fs::read_to_string(&effective_path) {
                Ok(contents) => contents,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => {
                    return Err(format!(
                        "No se pudo leer {}: {error}",
                        effective_path.display()
                    ))
                }
            };
            let updated = update_block(&contents, fish, enabled)?;
            if updated != contents {
                write_atomic(&effective_path, &updated)?;
            }
        }
        Ok(())
    }

    fn has_managed_launcher(path: &Path) -> bool {
        std::fs::read_to_string(path)
            .is_ok_and(|contents| contents.starts_with(&format!("#!/bin/sh\n{LAUNCHER_MARKER}\n")))
    }

    fn shell_quote(path: &str) -> String {
        format!("'{}'", path.replace('\'', "'\\''"))
    }

    fn update_process_path(bin: &Path, enabled: bool) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut entries: Vec<PathBuf> = std::env::split_paths(&path).collect();
        let equal = |entry: &PathBuf| {
            entry.canonicalize().unwrap_or_else(|_| entry.clone())
                == bin.canonicalize().unwrap_or_else(|_| bin.to_path_buf())
        };
        if enabled && !entries.iter().any(&equal) {
            entries.insert(0, bin.to_path_buf());
        } else if !enabled {
            entries.retain(|entry| !equal(entry));
        }
        if let Ok(value) = std::env::join_paths(entries) {
            std::env::set_var("PATH", value);
        }
    }

    pub fn status() -> Result<PathIntegrationStatus, String> {
        let path = launcher_path()?;
        let enabled = has_managed_launcher(&path);
        Ok(PathIntegrationStatus {
            supported: true,
            enabled,
            command: "wterminal".into(),
            location: Some(path.display().to_string()),
            note: "WTerminal crea automáticamente el comando wterminal al iniciar por primera vez y añade ~/.local/bin a Bash, Zsh y Fish. Puedes desactivarlo aquí.".into(),
        })
    }

    pub fn set_enabled(enabled: bool) -> Result<PathIntegrationStatus, String> {
        let path = launcher_path()?;
        let bin = path.parent().ok_or("Ruta de lanzador no válida")?;
        if enabled {
            let existing_is_symlink = std::fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.file_type().is_symlink());
            if path.exists() && (existing_is_symlink || !has_managed_launcher(&path)) {
                return Err(format!(
                    "Ya existe {} y no pertenece a WTerminal; no se ha sobrescrito",
                    path.display()
                ));
            }
            std::fs::create_dir_all(bin).map_err(|error| error.to_string())?;
            let target = app_executable()?.to_string_lossy().into_owned();
            let launcher = format!(
                "#!/bin/sh\n{LAUNCHER_MARKER}\nexec {} \"$@\"\n",
                shell_quote(&target)
            );
            write_atomic(&path, &launcher)?;
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|error| error.to_string())?;
            update_shell_files(true)?;
        } else {
            if path.exists() {
                if !has_managed_launcher(&path) {
                    return Err(format!(
                        "{} no pertenece a WTerminal; no se ha eliminado",
                        path.display()
                    ));
                }
                std::fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            update_shell_files(false)?;
        }
        update_process_path(bin, enabled);
        save_auto_add_preference(enabled)?;
        status()
    }

    pub fn ensure_default_enabled() -> Result<(), String> {
        if !super::should_auto_enable(auto_add_preference()?, status()?.enabled) {
            return Ok(());
        }
        set_enabled(true).map(|_| ())
    }

    /// En Linux las carpetas de herramientas van, por ahora, solo delante en
    /// el PATH de WTerminal: el bloque gestionado de los perfiles de shell solo
    /// añade `~/.local/bin`.
    pub fn sync_tool_bins(_desired: &[PathBuf]) -> Result<(), String> {
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn update_block_for_test(
        contents: &str,
        fish: bool,
        enabled: bool,
    ) -> Result<String, String> {
        update_block(contents, fish, enabled)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod host {
    use super::PathIntegrationStatus;

    pub fn status() -> Result<PathIntegrationStatus, String> {
        Ok(PathIntegrationStatus {
            supported: false,
            enabled: false,
            command: "wterminal".into(),
            location: None,
            note: "Añadir WTerminal al PATH solo está disponible en Windows y Linux.".into(),
        })
    }

    pub fn set_enabled(_enabled: bool) -> Result<PathIntegrationStatus, String> {
        Err("Añadir WTerminal al PATH solo está disponible en Windows y Linux.".into())
    }

    pub fn ensure_default_enabled() -> Result<(), String> {
        Ok(())
    }

    pub fn sync_tool_bins(_desired: &[std::path::PathBuf]) -> Result<(), String> {
        Ok(())
    }
}

pub use host::{set_enabled, status};

/// Registra WTerminal en el PATH la primera vez. La desactivación explícita en
/// Ajustes se conserva entre inicios; la integración de otras aplicaciones
/// sigue siendo responsabilidad de cada herramienta que las instala.
pub fn ensure_default_enabled() -> Result<(), String> {
    if e2e_skips_path_auto() {
        return Ok(());
    }
    host::ensure_default_enabled()
}

#[tauri::command]
pub fn path_integration_status() -> Result<PathIntegrationStatus, String> {
    status()
}

#[tauri::command(async)]
pub fn path_integration_set(enabled: bool) -> Result<PathIntegrationStatus, String> {
    set_enabled(enabled)
}

#[cfg(test)]
mod tests {
    #[test]
    fn habilita_automaticamente_salvo_que_el_usuario_lo_haya_deshabilitado() {
        assert!(super::should_auto_enable(None, false));
        assert!(super::should_auto_enable(Some(true), false));
        assert!(!super::should_auto_enable(Some(false), false));
        assert!(!super::should_auto_enable(None, true));
    }

    #[test]
    fn las_carpetas_de_herramientas_entran_al_final_y_solo_salen_las_propias() {
        let npm = r"C:\e\herramientas\npm".to_string();
        let cargo = r"C:\e\herramientas\cargo\bin".to_string();
        // Primera vez: van al final, detrás de lo que ya había.
        let (path, added) = super::path_with_tool_bins(
            r"C:\WTerminal;C:\Windows",
            &[],
            &[npm.clone(), cargo.clone()],
        );
        assert_eq!(path, format!(r"C:\WTerminal;C:\Windows;{npm};{cargo}"));
        assert_eq!(added, vec![npm.clone(), cargo.clone()]);
        // Otra vez igual: no se duplican y siguen siendo suyas.
        let (again, still) =
            super::path_with_tool_bins(&path, &added, &[npm.clone(), cargo.clone()]);
        assert_eq!(again, path);
        assert_eq!(still, added);
        // Al apagar la categoría o la integración, salen solo las suyas.
        let (cleared, none) = super::path_with_tool_bins(&path, &added, &[]);
        assert_eq!(cleared, r"C:\WTerminal;C:\Windows");
        assert!(none.is_empty());
        // Una que el usuario ya tenía (otra grafía) no se apunta ni se quita.
        let user = r"c:/E/Herramientas/npm/";
        let (with_user, ours) =
            super::path_with_tool_bins(&format!(r"C:\Windows;{user}"), &[], &[npm.clone()]);
        assert_eq!(with_user, format!(r"C:\Windows;{user}"));
        assert!(ours.is_empty());
        let (kept, _) = super::path_with_tool_bins(&with_user, &ours, &[]);
        assert_eq!(kept, with_user);
        // Las entradas vacías del PATH no sobreviven a la reescritura.
        let (tidy, _) = super::path_with_tool_bins(r"C:\Windows;;", &[], &[]);
        assert_eq!(tidy, r"C:\Windows");
    }

    #[cfg(windows)]
    #[test]
    fn compara_rutas_de_windows_sin_caso_ni_separadores_finales() {
        assert!(super::host::same_path(
            r"C:/Apps/WTerminal/",
            r"c:\apps\wterminal"
        ));
        assert!(!super::host::same_path(
            r"C:\Apps\WTerminal",
            r"C:\Apps\Other"
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn modifica_solo_el_bloque_propio_y_es_idempotente() {
        let original = "export EDITOR=nano\n";
        let added = super::host::update_block_for_test(original, false, true).unwrap();
        assert!(added.contains("export EDITOR=nano"));
        assert_eq!(
            super::host::update_block_for_test(&added, false, true).unwrap(),
            added
        );
        assert_eq!(
            super::host::update_block_for_test(&added, false, false).unwrap(),
            original
        );
        let no_final_newline = "export EDITOR=vim";
        let added = super::host::update_block_for_test(no_final_newline, false, true).unwrap();
        assert_eq!(
            super::host::update_block_for_test(&added, false, false).unwrap(),
            no_final_newline
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn usa_la_sintaxis_de_fish_y_rechaza_bloques_incompletos() {
        let fish = super::host::update_block_for_test("set -gx EDITOR nano\n", true, true).unwrap();
        assert!(fish.contains("fish_add_path -- \"$HOME/.local/bin\""));
        assert!(super::host::update_block_for_test(
            "# >>> WTerminal managed PATH >>>\n",
            false,
            false
        )
        .is_err());
    }
}
