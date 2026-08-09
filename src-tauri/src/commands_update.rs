//! Los comandos de la actualización de la propia aplicación.
//!
//! Módulo nuevo. La lógica delicada (comparar versiones, elegir el adjunto,
//! intercambiar los archivos) está en `self_update`; aquí está lo que hace
//! falta para atenderla desde el frontend y para consultar GitHub.
//!
//! Todo pasa por el repositorio que declara el catálogo de distribución
//! (`selfRepository`). La app no descarga de una URL que le llegue de fuera:
//! consulta la release de SU repositorio y elige el adjunto que corresponde a
//! esta plataforma, con las mismas comprobaciones de host que el panel de
//! Proyectos.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::install_dir;
use crate::self_update::{self, UpdateStatus, Version};
use crate::state::AppState;

/// Cuánto se espera a que termine de extraerse el paquete. Un `.zip` de la app
/// son decenas de megas: con disco lento y un antivirus mirando, un minuto es
/// poco y diez son de sobra.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(300);

fn client() -> crate::github::GithubClient {
    crate::github::GithubClient::new(crate::identity::current().user_agent)
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// El estado sin consultar la red: qué versión corre y si esta copia puede
/// actualizarse sola.
fn local_status(app: &AppHandle) -> UpdateStatus {
    let install = install_dir::current();
    UpdateStatus {
        current_version: current_version(app),
        can_self_update: install_dir::staging().is_some(),
        install_path: install.map(|path| path.to_string_lossy().to_string()),
        ..Default::default()
    }
}

/// Consulta la última release publicada y la compara con la que corre.
///
/// Un fallo de red no es un error que merezca un aviso: se devuelve el estado
/// local con el motivo dentro, y el frontend simplemente no ofrece nada.
pub fn check(app: &AppHandle) -> UpdateStatus {
    let mut status = local_status(app);
    let Some(repo) = crate::github::default_catalog().self_repository else {
        status.error = Some("El catálogo no declara el repositorio de la aplicación.".to_string());
        return status;
    };
    let release = match client().latest_release(&repo) {
        Ok((Some(release), _)) => release,
        Ok((None, _)) => {
            status.error = Some("El repositorio todavía no ha publicado releases.".to_string());
            return status;
        }
        Err(error) => {
            status.error = Some(error.message);
            return status;
        }
    };

    let actual = Version::parse(&status.current_version);
    let publicada = Version::parse(&release.tag);
    status.available = match (&publicada, &actual) {
        (Some(nueva), Some(vieja)) => nueva.is_newer_than(vieja),
        // Sin poder comparar no se ofrece nada: proponer una actualización que
        // quizá sea la misma versión es peor que no proponer ninguna.
        _ => false,
    };
    status.latest_version = Some(release.tag);
    status
}

/// `update:check`
#[tauri::command(async)]
pub fn update_check(app: AppHandle) -> UpdateStatus {
    check(&app)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// La versión que ha quedado instalada, para poder decirlo antes de morir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

fn failed(error: impl Into<String>) -> UpdateResult {
    UpdateResult {
        ok: false,
        error: Some(error.into()),
        ..Default::default()
    }
}

/// Extrae el paquete descargado. En Linux el AppImage es un archivo suelto y no
/// hay nada que extraer.
///
/// Se usa el `tar` del sistema (bsdtar en Windows desde la build 17063, que
/// abre `.zip`) en vez de una biblioteca dentro de la app: es el mismo criterio
/// que para desempaquetar releases de otros proyectos, y evita arrastrar una
/// dependencia de compresión solo para esto. Va oculto, sin ventana: esto no es
/// una acción del usuario en la terminal, es fontanería de la actualización.
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    if archive
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("appimage"))
    {
        return Ok(());
    }
    std::fs::create_dir_all(into).map_err(|error| error.to_string())?;
    let salida = crate::process::run_with_timeout(
        "tar",
        &[
            "-xf",
            &archive.to_string_lossy(),
            "-C",
            &into.to_string_lossy(),
        ],
        EXTRACT_TIMEOUT,
    )
    .ok_or("No se pudo ejecutar tar para extraer la actualización.")?;
    if !salida.status.success() {
        return Err(format!(
            "La extracción falló: {}",
            String::from_utf8_lossy(&salida.stderr).trim()
        ));
    }
    Ok(())
}

/// `update:install`
///
/// Descarga la release, la deja junto a la instalación, la aplica y reinicia.
/// Es una sola operación a propósito: partirla en pasos dejaría a la app en
/// estados intermedios que el usuario tendría que entender.
///
/// El reinicio es inevitable — el proceso en marcha tiene los archivos viejos
/// abiertos y hasta que muera no hay versión nueva corriendo — pero lo hace la
/// app, no el usuario.
#[tauri::command(async)]
pub fn update_install(app: AppHandle, state: State<'_, Arc<AppState>>) -> UpdateResult {
    let Some(staging) = install_dir::staging() else {
        return failed("Esta copia no se puede actualizar sola: es una compilación de desarrollo.");
    };
    let Some(install) = install_dir::current() else {
        return failed("No se pudo determinar dónde está instalada la aplicación.");
    };
    let Some(repo) = crate::github::default_catalog().self_repository else {
        return failed("El catálogo no declara el repositorio de la aplicación.");
    };

    let release = match client().latest_release(&repo) {
        Ok((Some(release), _)) => release,
        Ok((None, _)) => return failed("El repositorio todavía no ha publicado releases."),
        Err(error) => return failed(error.message),
    };
    let nombres: Vec<&str> = release
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect();
    let Some(elegido) = self_update::asset_for_platform(&nombres) else {
        return failed(format!(
            "La release {} no trae ningún paquete para esta plataforma.",
            release.tag
        ));
    };
    let Some(asset) = release.assets.iter().find(|a| a.name == elegido) else {
        return failed("El adjunto elegido ya no está en la release.");
    };

    // Se parte de cero: restos de un intento anterior podrían mezclarse con
    // esta descarga y acabar instalando una mitad de cada versión.
    let _ = std::fs::remove_dir_all(&staging);
    let descarga = staging.join(&asset.name);
    // Lo extraído va en su propia carpeta y no junto al archivo descargado: si
    // compartieran sitio, el `.zip` contaría como un archivo más de la versión
    // nueva y acabaría copiado junto al ejecutable.
    let extraido = staging.join("payload");

    log_info!(
        "Descargando la actualización de la aplicación",
        serde_json::json!({
            "repo": repo, "tag": release.tag, "asset": asset.name,
            "destino": staging.to_string_lossy(),
        })
    );
    if let Err(error) = crate::commands_projects::download_asset_to(&asset.download_url, &descarga)
    {
        return failed(error);
    }
    let binario = self_update::binary_name();
    // Un AppImage no se extrae: el archivo descargado ES la versión nueva, y se
    // pone en la carpeta de payload con el nombre que tiene instalado.
    let raiz = if descarga
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("appimage"))
    {
        if let Err(error) = std::fs::create_dir_all(&extraido)
            .and_then(|()| std::fs::rename(&descarga, extraido.join(&binario)))
        {
            return failed(format!("No se pudo preparar el AppImage: {error}"));
        }
        extraido
    } else {
        if let Err(error) = extract(&descarga, &extraido) {
            return failed(error);
        }
        self_update::payload_root(&extraido)
    };
    if let Err(error) = self_update::apply(&raiz, &install, &binario) {
        log_error!(
            "No se pudo aplicar la actualización",
            serde_json::json!({ "error": error })
        );
        return failed(error);
    }

    log_info!(
        "Actualización aplicada; reiniciando",
        serde_json::json!({ "version": release.tag })
    );
    // Las shells abiertas se cierran ordenadamente antes de morir: si no,
    // quedarían procesos huérfanos escribiendo en un pty que ya no lee nadie.
    state.tabs.shutdown();
    crate::session_files::cleanup();
    app.restart();
}

/// Al arrancar: borrar lo que dejó una actualización anterior y, en segundo
/// plano, mirar si hay una nueva.
///
/// La consulta va en su propio hilo porque habla con GitHub: en una red lenta
/// bloquearía el arranque de la ventana, y avisar de una versión nueva no es
/// tan urgente como abrir la terminal.
pub fn on_startup(app: &AppHandle) {
    if let Some(install) = install_dir::current() {
        let borrados = self_update::cleanup(&install);
        if borrados > 0 {
            log_info!(
                "Restos de la actualización anterior eliminados",
                serde_json::json!({ "archivos": borrados })
            );
        }
    }
    if install_dir::staging().is_none() {
        // Build de desarrollo: no tiene sentido ofrecer actualizarla.
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("update-check".into())
        .spawn(move || {
            let status = check(&app);
            if status.available {
                log_info!(
                    "Hay una versión más reciente publicada",
                    serde_json::json!({
                        "actual": status.current_version,
                        "publicada": status.latest_version,
                    })
                );
                let _ = app.emit("update-available", status);
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_appimage_no_se_extrae_porque_es_un_archivo_suelto() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("LTerminal-1.4.3-x86_64.AppImage");
        std::fs::write(&appimage, "binario").unwrap();
        // No se llama a tar ni se crea nada: devuelve bien sin tocar el disco.
        assert!(extract(&appimage, &dir.path().join("salida")).is_ok());
        assert!(!dir.path().join("salida").exists());
    }
}
