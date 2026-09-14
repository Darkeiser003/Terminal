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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{package_updates, security};
use crate::install_dir;
use crate::projects::github::{Asset, Release};
use crate::self_update::{self, UpdateStatus, Version};
use crate::state::AppState;

/// Cuánto se espera a que termine de extraerse el paquete. Un `.zip` de la app
/// son decenas de megas: con disco lento y un antivirus mirando, un minuto es
/// poco y diez son de sobra.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(300);
const RELEASE_METADATA_TIMEOUT: Duration = Duration::from_secs(15);
const RELEASE_MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
const RELEASE_SIGNATURE_MAX_BYTES: u64 = 512;
static UPDATE_INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);
static UPDATE_FILES_LOCK: Mutex<()> = Mutex::new(());

fn lock_update_files() -> MutexGuard<'static, ()> {
    UPDATE_FILES_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct UpdateInstallGuard;

impl UpdateInstallGuard {
    fn acquire() -> Option<Self> {
        UPDATE_INSTALL_RUNNING
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for UpdateInstallGuard {
    fn drop(&mut self) {
        UPDATE_INSTALL_RUNNING.store(false, Ordering::Release);
    }
}

fn client() -> &'static crate::github::GithubClient {
    crate::github::shared_client()
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
        can_self_update: crate::github::default_catalog().self_repository.is_some()
            && install_dir::staging().is_some()
            && security::signing_key_configured(),
        install_path: install.map(|path| path.to_string_lossy().to_string()),
        ..Default::default()
    }
}

/// Selecciona el paquete de esta plataforma y autentica el manifiesto que lo
/// describe. La comprobación automática descarga solo los dos archivos pequeños
/// de metadatos; el paquete se baja únicamente cuando la persona pulsa
/// «Actualizar» y vuelve a pasar la verificación SHA-256 antes de instalarse.
fn verified_release_manifest(release: &Release) -> Result<(&Asset, Vec<u8>), String> {
    if release.prerelease || stable_release_core(&release.tag).is_none() {
        return Err("La última publicación es una versión preliminar; no se ofrecerá como actualización estable.".into());
    }
    let names: Vec<&str> = release
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect();
    let name = self_update::asset_for_platform(&names).ok_or_else(|| {
        format!(
            "La release {} no trae ningún paquete para esta plataforma.",
            release.tag
        )
    })?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| "El adjunto elegido ya no está en la release.".to_string())?;
    if !safe_asset_file_name(&asset.name) {
        return Err("El nombre del paquete publicado no es un nombre de archivo seguro.".into());
    }
    if !asset_matches_release_version(&asset.name, &release.tag) {
        return Err("El nombre del paquete no coincide con la versión de la release; no se ofrecerá por seguridad.".into());
    }
    let manifest_asset = release
        .assets
        .iter()
        .find(|asset| asset.name == "SHA256SUMS.txt")
        .ok_or_else(|| {
            "La release no publica SHA256SUMS.txt; por seguridad no se ofrecerá.".to_string()
        })?;
    let signature_asset = release
        .assets
        .iter()
        .find(|asset| asset.name == "SHA256SUMS.txt.sig")
        .ok_or_else(|| {
            "La release no publica la firma de SHA256SUMS.txt; por seguridad no se ofrecerá."
                .to_string()
        })?;

    let manifest = crate::commands_projects::download_asset_bytes_limited(
        &manifest_asset.download_url,
        RELEASE_MANIFEST_MAX_BYTES,
        RELEASE_METADATA_TIMEOUT,
    )
    .map_err(|error| format!("No se pudo descargar el manifiesto de checksums: {error}"))?;
    let signature = crate::commands_projects::download_asset_bytes_limited(
        &signature_asset.download_url,
        RELEASE_SIGNATURE_MAX_BYTES,
        RELEASE_METADATA_TIMEOUT,
    )
    .map_err(|error| format!("No se pudo descargar la firma de la release: {error}"))?;

    security::verify_signature(&manifest, &signature)?;
    security::manifest_checksum(&manifest, &asset.name)?;
    Ok((asset, manifest))
}

/// Los nombres de adjuntos de la API de releases no se deben usar directamente
/// como rutas. Se guardan bajo staging y un separador, nombre reservado o ADS
/// de Windows podría escapar de esa carpeta o apuntar a otro flujo del archivo.
fn safe_asset_file_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 240
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name.chars().any(|ch| {
            ch.is_control() || matches!(ch, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return false;
    }

    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix)
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
    });
    !reserved
}

fn is_newer_release(release_tag: &str, current_version: &str) -> bool {
    match (Version::parse(release_tag), Version::parse(current_version)) {
        (Some(latest), Some(current)) => latest.is_newer_than(&current),
        _ => false,
    }
}

/// Devuelve `MAJOR.MINOR.PATCH` únicamente para tags SemVer estables. El flag
/// `prerelease` de GitHub no basta por sí solo: una release mal etiquetada como
/// estable tampoco debe ofrecer `1.2.3-beta` automáticamente.
fn stable_release_core(tag: &str) -> Option<&str> {
    let trimmed = tag.trim();
    let tag = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let (core, build) = tag.split_once('+').unwrap_or((tag, ""));
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return None;
    }
    if tag.contains('+')
        && (build.is_empty()
            || build.split('.').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            }))
    {
        return None;
    }
    Some(core)
}

/// Evita que un tag nuevo con un adjunto firmado de otra versión provoque una
/// oferta engañosa o una reinstalación/downgrade. Los nombres de nuestros
/// artefactos contienen la versión entre guiones y luego extensión/arquitectura.
fn asset_matches_release_version(asset_name: &str, release_tag: &str) -> bool {
    let Some(core) = stable_release_core(release_tag) else {
        return false;
    };
    if asset_name.to_ascii_lowercase().contains("-dev") {
        return false;
    }
    asset_name.match_indices(core).any(|(start, _)| {
        let before = asset_name.as_bytes().get(start.wrapping_sub(1)).copied();
        let end = start + core.len();
        let after = asset_name.as_bytes().get(end).copied();
        let left_boundary = start == 0 || matches!(before, Some(b'-' | b'_'));
        let right_boundary = after.is_none() || matches!(after, Some(b'.' | b'-' | b'_' | b'+'));
        left_boundary && right_boundary
    })
}

/// Consulta la última release, valida su firma y el SHA esperado para esta
/// plataforma, y solo entonces la ofrece como actualización.
///
/// Un fallo de red no es un error que merezca un aviso: se devuelve el estado
/// local con el motivo dentro, y el frontend simplemente no ofrece nada.
pub fn check(app: &AppHandle) -> UpdateStatus {
    let mut status = local_status(app);
    let Some(repo) = crate::github::default_catalog().self_repository else {
        return status;
    };
    if !security::signing_key_configured() {
        status.error = Some("Esta compilación no incluye una clave pública de actualizaciones; no se ofrecerá una release sin verificar.".into());
        return status;
    }
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

    status.latest_version = Some(release.tag.clone());
    if !is_newer_release(&release.tag, &status.current_version) {
        return status;
    }

    if let Err(error) = verified_release_manifest(&release) {
        log_warn!(
            "La actualización publicada no pasó la verificación previa",
            serde_json::json!({ "tag": &release.tag, "error": &error })
        );
        status.error = Some(error);
        return status;
    }
    status.available = true;
    status
}

/// `update:check`
#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    let fallback_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || check(&app))
        .await
        .unwrap_or_else(|_| local_status(&fallback_app))
}

/// Comprobación automática: las copias de desarrollo no consultan la red ni
/// muestran un aviso que no podrían instalar. El panel de Dependencias puede
/// seguir usando `update_check` para informar de una release manualmente.
#[tauri::command]
pub async fn update_check_on_startup(app: AppHandle) -> UpdateStatus {
    if install_dir::staging().is_none() || !security::signing_key_configured() {
        return local_status(&app);
    }
    update_check(app).await
}

/// Consulta el gestor nativo de paquetes en segundo plano. Solo lista
/// actualizaciones disponibles; el popup lleva al panel de dependencias, donde
/// el comando de actualización queda visible y se ejecuta en una shell normal.
#[tauri::command(async)]
pub fn package_updates_check(
    state: State<'_, Arc<AppState>>,
) -> package_updates::PackageUpdateStatus {
    let Some(manager) = package_updates::host_manager(state.inventory().pkg_manager.as_deref())
    else {
        return package_updates::PackageUpdateStatus::default();
    };
    package_updates::check(manager)
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    stage: &'static str,
    bytes: u64,
    total: Option<u64>,
    percent: Option<u8>,
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
    security::validate_tar_entries(archive)?;
    std::fs::create_dir_all(into).map_err(|error| error.to_string())?;
    let salida = crate::process::run_with_timeout(
        security::archive_tool(),
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

/// La descarga HTTP crea archivos con los permisos normales de datos; un
/// AppImage debe conservar el bit de ejecución para poder abrirse tras el
/// intercambio atómico. Se fija solo después de verificar su SHA firmado.
fn make_appimage_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(path)
            .map_err(|error| format!("No se pudieron leer los permisos del AppImage: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("No se pudo habilitar la ejecución del AppImage: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
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
    let Some(_update_guard) = UpdateInstallGuard::acquire() else {
        return failed("Ya hay una actualización en curso.");
    };
    // La limpieza de restos de un arranque anterior no puede retirar un `.old`
    // o un archivo de staging mientras se descarga, aplica o hace rollback.
    let _files_guard = lock_update_files();
    let Some(staging) = install_dir::staging() else {
        return failed("Esta copia no se puede actualizar sola: es una compilación de desarrollo.");
    };
    let Some(install) = install_dir::current() else {
        return failed("No se pudo determinar dónde está instalada la aplicación.");
    };
    let Some(repo) = crate::github::default_catalog().self_repository else {
        return failed("La actualización automática no está configurada para esta compilación.");
    };

    let release = match client().latest_release(&repo) {
        Ok((Some(release), _)) => release,
        Ok((None, _)) => return failed("El repositorio todavía no ha publicado releases."),
        Err(error) => return failed(error.message),
    };
    if !is_newer_release(&release.tag, &current_version(&app)) {
        return failed("La release publicada no es más nueva que esta instalación.");
    }

    // Se parte de cero: restos de un intento anterior podrían mezclarse con
    // esta descarga y acabar instalando una mitad de cada versión.
    match std::fs::symlink_metadata(&staging) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return failed("La carpeta temporal de actualización no es un directorio seguro.");
        }
        Ok(_) => {
            if let Err(error) = std::fs::remove_dir_all(&staging) {
                return failed(format!(
                    "No se pudo limpiar la actualización anterior: {error}"
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return failed(format!(
                "No se pudo comprobar la carpeta temporal de actualización: {error}"
            ))
        }
    }
    let (asset, manifest) = match verified_release_manifest(&release) {
        Ok(verified) => verified,
        Err(error) => return failed(error),
    };
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
    let progress_app = app.clone();
    if let Err(error) = crate::commands_projects::download_asset_to_with_progress(
        &asset.download_url,
        &descarga,
        move |bytes, total| {
            let percent = total
                .filter(|total| *total > 0)
                .map(|total| ((bytes.saturating_mul(100) / total).min(100)) as u8);
            let _ = progress_app.emit(
                "update-progress",
                UpdateProgress {
                    stage: "download",
                    bytes,
                    total,
                    percent,
                },
            );
        },
    ) {
        return failed(error);
    }
    if let Err(error) = security::verify_checksum(&manifest, &asset.name, &descarga) {
        return failed(error);
    }
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            stage: "extract",
            bytes: 0,
            total: None,
            percent: None,
        },
    );
    let binario = self_update::binary_name();
    // Un AppImage no se extrae: el archivo descargado ES la versión nueva, y se
    // pone en la carpeta de payload con el nombre que tiene instalado.
    let raiz = if descarga
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("appimage"))
    {
        if let Err(error) = std::fs::create_dir_all(&extraido) {
            return failed(format!("No se pudo preparar el AppImage: {error}"));
        }
        let appimage = extraido.join(&binario);
        if let Err(error) = std::fs::rename(&descarga, &appimage) {
            return failed(format!("No se pudo preparar el AppImage: {error}"));
        }
        if let Err(error) = make_appimage_executable(&appimage) {
            return failed(error);
        }
        extraido
    } else {
        if let Err(error) = extract(&descarga, &extraido) {
            return failed(error);
        }
        self_update::payload_root(&extraido)
    };
    if let Err(error) = self_update::validate_payload_tree(&raiz) {
        return failed(error);
    }
    if let Err(error) = self_update::apply(&raiz, &install, &binario) {
        log_error!(
            "No se pudo aplicar la actualización",
            serde_json::json!({ "error": error })
        );
        return failed(error);
    }
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            stage: "complete",
            bytes: 0,
            total: None,
            percent: Some(100),
        },
    );

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

/// Al arrancar, borrar restos de una actualización anterior. La consulta de
/// red se inicia desde la interfaz una vez montada, y su resultado vuelve por
/// la promesa IPC; así no se pierde un evento emitido antes de que exista el
/// listener del frontend.
pub fn on_startup() {
    let _files_guard = lock_update_files();
    if let Some(install) = install_dir::current() {
        let borrados = self_update::cleanup(&install);
        if borrados > 0 {
            log_info!(
                "Restos de la actualización anterior eliminados",
                serde_json::json!({ "archivos": borrados })
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn el_appimage_descargado_recibe_permisos_de_ejecucion_antes_de_instalarse() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("terminal.AppImage");
        std::fs::write(&appimage, b"ELF fixture").unwrap();
        std::fs::set_permissions(&appimage, std::fs::Permissions::from_mode(0o644)).unwrap();

        make_appimage_executable(&appimage).unwrap();

        assert_eq!(
            std::fs::metadata(appimage).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn un_appimage_no_se_extrae_porque_es_un_archivo_suelto() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("LTerminal-1.4.3-x86_64.AppImage");
        std::fs::write(&appimage, "binario").unwrap();
        // No se llama a tar ni se crea nada: devuelve bien sin tocar el disco.
        assert!(extract(&appimage, &dir.path().join("salida")).is_ok());
        assert!(!dir.path().join("salida").exists());
    }

    #[test]
    fn solo_considera_versiones_numericamente_mas_nuevas() {
        assert!(is_newer_release("v1.10.0", "1.9.9"));
        assert!(!is_newer_release("1.4.3", "1.4.3"));
        assert!(!is_newer_release("1.4", "1.4.0"));
        assert!(!is_newer_release("release", "1.4.0"));
    }

    #[test]
    fn solo_ofrece_tags_estables_cuyo_adjunto_nombra_esa_version() {
        assert_eq!(stable_release_core("v1.2.3"), Some("1.2.3"));
        assert_eq!(stable_release_core("1.2.3+build.4"), Some("1.2.3"));
        for invalid in ["1.2", "1.2.3-beta.1", "01.2.3", "1.2.3+", "release-1.2.3"] {
            assert_eq!(
                stable_release_core(invalid),
                None,
                "tag inesperado: {invalid}"
            );
        }
        assert!(asset_matches_release_version(
            "LTerminal-1.2.3-x86_64.AppImage",
            "v1.2.3"
        ));
        assert!(asset_matches_release_version(
            "WinSlimTerminal-Unpacked-1.2.3.zip",
            "1.2.3"
        ));
        assert!(!asset_matches_release_version(
            "WinSlimTerminal-Unpacked-1.2.2.zip",
            "1.2.3"
        ));
        assert!(!asset_matches_release_version(
            "LTerminal-1.2.30-x86_64.AppImage",
            "1.2.3"
        ));
        assert!(!asset_matches_release_version(
            "LTerminal-1.2.3-dev-x86_64.AppImage",
            "1.2.3"
        ));
    }

    #[test]
    fn los_nombres_de_adjuntos_no_pueden_convertirse_en_rutas_o_flujos() {
        for unsafe_name in [
            "../LTerminal-1.2.3.AppImage",
            "folder/LTerminal-1.2.3.AppImage",
            r"folder\LTerminal-1.2.3.AppImage",
            "LTerminal-1.2.3.AppImage:payload",
            "CON.zip",
            "lpt1.txt",
            "LTerminal-1.2.3.AppImage.",
            "LTerminal-1.2.3.AppImage ",
        ] {
            assert!(
                !safe_asset_file_name(unsafe_name),
                "nombre: {unsafe_name:?}"
            );
        }
        assert!(safe_asset_file_name("LTerminal-1.2.3-x86_64.AppImage"));
        assert!(safe_asset_file_name("WinSlimTerminal-Unpacked-1.2.3.zip"));
        assert!(!safe_asset_file_name(&"a".repeat(241)));
    }

    #[test]
    fn impide_dos_aplicaciones_concurrentes_sobre_la_misma_carpeta_temporal() {
        let first = UpdateInstallGuard::acquire().expect("primera actualización");
        assert!(UpdateInstallGuard::acquire().is_none());
        drop(first);
        assert!(UpdateInstallGuard::acquire().is_some());
    }
}
