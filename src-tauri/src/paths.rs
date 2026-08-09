//! Dónde vive cada cosa en disco.
//!
//! Electron resolvía esto con `app.getPath()`. Las equivalencias que usa la
//! app son:
//!
//! | Electron          | Windows                  | Linux            |
//! |-------------------|--------------------------|------------------|
//! | `appData`         | `%APPDATA%`              | `~/.config`      |
//! | `userData`        | `appData/<nombre app>`   | idem             |
//! | `temp`            | `%TEMP%`                 | `/tmp`           |
//! | `documents`       | `%USERPROFILE%/Documents`| `~/Documents`    |
//!
//! `dirs::config_dir()` devuelve exactamente lo mismo que `appData` en ambas,
//! así que la ruta canónica (`appData/<slug>`) se calcula igual que antes y
//! los datos de la versión Electron se siguen encontrando donde estaban.

use std::path::PathBuf;

use once_cell::sync::Lazy;

use crate::identity;

/// `appData`: la raíz de configuración del usuario.
pub fn app_data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| home_dir().join(".config"))
}

/// Ruta estable de los datos de la app: `appData/<slug>`. No depende del
/// nombre visible, que cambia por plataforma.
pub static USER_DATA_DIR: Lazy<PathBuf> =
    Lazy::new(|| app_data_dir().join(identity::current().slug));

/// La ruta que usaba la build de Electron antes de la unificación:
/// `appData/<nombre visible>`. Solo se lee, para migrar lo que quedara ahí.
pub static LEGACY_USER_DATA_DIR: Lazy<PathBuf> =
    Lazy::new(|| app_data_dir().join(identity::current().name));

pub fn user_data_dir() -> PathBuf {
    USER_DATA_DIR.clone()
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn documents_dir() -> PathBuf {
    dirs::document_dir().unwrap_or_else(|| home_dir().join("Documents"))
}

pub fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}

/// Biblioteca de scripts por defecto: `<userData>/scripts`.
pub fn default_scripts_dir() -> PathBuf {
    user_data_dir().join("scripts")
}

/// Carpeta de proyectos por defecto: `<documentos>/<WinSlim|LTerminal> Projects`.
pub fn default_projects_dir() -> PathBuf {
    documents_dir().join(identity::current().projects_folder_name)
}

/// Temporales de esta ejecución: `<temp>/<slug>/<pid>`. Van por PID para que
/// dos instancias abiertas a la vez no se pisen los archivos ni se los borren
/// al salir.
pub static SESSION_DIR: Lazy<PathBuf> = Lazy::new(|| {
    temp_dir()
        .join(identity::current().slug)
        .join(std::process::id().to_string())
});

/// Crea la carpeta de sesión la primera vez que hace falta.
pub fn session_dir() -> std::io::Result<PathBuf> {
    let dir = SESSION_DIR.clone();
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// El directorio donde nace una pestaña cuando no hereda ninguno.
pub fn home_cwd() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_ruta_canonica_cuelga_de_app_data() {
        assert!(USER_DATA_DIR.starts_with(app_data_dir()));
        assert_eq!(
            USER_DATA_DIR.file_name().and_then(|n| n.to_str()),
            Some(identity::current().slug)
        );
    }

    #[test]
    fn la_ruta_heredada_usa_el_nombre_visible_no_el_slug() {
        assert_eq!(
            LEGACY_USER_DATA_DIR.file_name().and_then(|n| n.to_str()),
            Some(identity::current().name)
        );
    }

    #[test]
    fn la_carpeta_de_sesion_separa_por_pid() {
        assert_eq!(
            SESSION_DIR.file_name().and_then(|n| n.to_str()),
            Some(std::process::id().to_string().as_str())
        );
    }
}
