//! «Abrir con LTerminal» en el gestor de archivos de Linux (17-11, Romen:
//! «poner al día en Linux las funciones de Windows, o sus equivalentes»).
//!
//! En Windows, Ajustes registra «Abrir con WTerminal» en el menú del
//! Explorador (`windows_integration`). En Linux el equivalente es una entrada
//! de escritorio del usuario con `MimeType=inode/directory`: Nautilus, Dolphin,
//! Thunar o Nemo la ofrecen en «Abrir con» de cada carpeta. Se escribe en
//! `~/.local/share/applications`, nunca en el sistema, y se borra al apagarla.
//!
//! Se compila en todas las plataformas (las pruebas de Windows revisan el
//! texto de la entrada), pero solo se ofrece en Linux.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// El nombre del archivo, propio para no pisar el `.desktop` de la AppImage.
const FILE_NAME: &str = "lterminal-open-here.desktop";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationStatus {
    /// Se puede ofrecer (Linux).
    pub supported: bool,
    /// La entrada existe.
    pub registered: bool,
    /// Dónde va la entrada.
    pub path: String,
}

fn entry_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| crate::paths::home_dir().join(".local").join("share"))
        .join("applications")
        .join(FILE_NAME)
}

/// El ejecutable que hay que lanzar: en una AppImage, la propia AppImage
/// (`APPIMAGE`), no el binario de su montaje temporal, que desaparece al
/// cerrarse.
fn launcher() -> Result<PathBuf, String> {
    if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        if appimage.is_absolute() {
            return Ok(appimage);
        }
    }
    std::env::current_exe().map_err(|error| error.to_string())
}

/// El texto de la entrada. La ruta va entre comillas, como pide la
/// especificación de las entradas de escritorio; una ruta con comillas,
/// `$`, `` ` `` o `\` se rechaza en vez de escaparla a medias.
pub fn entry_text(exe: &Path, name: &str, label: &str) -> Result<String, String> {
    let exe = exe.to_string_lossy();
    if exe
        .chars()
        .any(|ch| matches!(ch, '"' | '$' | '`' | '\\' | '\n' | '\r'))
    {
        return Err(format!(
            "La ruta de {name} tiene caracteres que no caben en una entrada de escritorio: {exe}"
        ));
    }
    // En `Exec`, `%` abre un código (`%f`, `%u`…): uno literal va doble.
    let exe = exe.replace('%', "%%");
    Ok(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={label}\n\
         Exec=\"{exe}\" --open-path %f\n\
         Icon=lterminal\n\
         MimeType=inode/directory;\n\
         NoDisplay=true\n\
         Terminal=false\n\
         X-LTerminal-OpenHere=true\n"
    ))
}

pub fn status() -> DesktopIntegrationStatus {
    let path = entry_path();
    DesktopIntegrationStatus {
        supported: cfg!(target_os = "linux"),
        registered: path.is_file(),
        path: path.to_string_lossy().into_owned(),
    }
}

pub fn set_enabled(enabled: bool) -> Result<DesktopIntegrationStatus, String> {
    if !cfg!(target_os = "linux") {
        return Err("«Abrir con LTerminal» en el gestor de archivos es de Linux.".into());
    }
    let path = entry_path();
    if enabled {
        let identity = crate::identity::current();
        let text = entry_text(
            &launcher()?,
            identity.name,
            &format!("Abrir con {}", identity.name),
        )?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&path, text).map_err(|error| error.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    // Para que el gestor de archivos la vea sin cerrar sesión; si no está la
    // herramienta, la verá al volver a leer la carpeta.
    if let Some(parent) = path.parent() {
        let _ = std::process::Command::new("update-desktop-database")
            .arg(parent)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(status())
}

#[tauri::command]
pub fn desktop_integration_status() -> DesktopIntegrationStatus {
    status()
}

#[tauri::command(async)]
pub fn desktop_integration_set(enabled: bool) -> Result<DesktopIntegrationStatus, String> {
    set_enabled(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_entrada_abre_la_carpeta_con_la_appimage() {
        let text = entry_text(
            Path::new("/home/ana/Apps/LTerminal 1.0.AppImage"),
            "LTerminal",
            "Abrir con LTerminal",
        )
        .unwrap();
        assert!(text.starts_with("[Desktop Entry]\n"));
        assert!(text.contains("Name=Abrir con LTerminal\n"));
        assert!(text.contains("Exec=\"/home/ana/Apps/LTerminal 1.0.AppImage\" --open-path %f\n"));
        assert!(text.contains("MimeType=inode/directory;\n"));
        assert!(
            text.contains("NoDisplay=true\n"),
            "no sale como otra app en el menú"
        );
    }

    #[test]
    fn un_porcentaje_de_la_ruta_va_doble_para_no_parecer_un_codigo() {
        let text = entry_text(
            Path::new("/home/ana/100%/LTerminal.AppImage"),
            "LTerminal",
            "Abrir",
        )
        .unwrap();
        assert!(text.contains("Exec=\"/home/ana/100%%/LTerminal.AppImage\" --open-path %f\n"));
    }

    #[test]
    fn una_ruta_que_no_cabe_entre_comillas_se_rechaza() {
        for bad in [
            "/home/a\"b/lterminal",
            "/home/$USER/lterminal",
            "/tmp/a`b`",
            "/tmp/a\\b",
        ] {
            assert!(
                entry_text(Path::new(bad), "LTerminal", "Abrir").is_err(),
                "{bad}"
            );
        }
    }
}
