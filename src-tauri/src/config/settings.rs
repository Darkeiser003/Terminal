//! Configuración persistente de la app, guardada como JSON simple en
//! `<userData>/settings.json`.
//!
//! Port de `electron/main/settings.js`. Mantiene el mismo formato de archivo y
//! la misma estrategia de respaldo, así que una instalación que venga de la
//! versión Electron arranca con su configuración intacta.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::paths;

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSignature {
    len: u64,
    modified: SystemTime,
}

#[derive(Default)]
struct SettingsCache {
    initialized: bool,
    signature: Option<FileSignature>,
    value: Map<String, Value>,
}

static SETTINGS_CACHE: Lazy<Mutex<SettingsCache>> =
    Lazy::new(|| Mutex::new(SettingsCache::default()));

/// Una sola escritura de settings.json a la vez dentro del proceso, y ninguna
/// lectura del disco a medio guardar. Los guardados de Ajustes, del tamaño de
/// la ventana (hilo `viewport-saver`), de los anclados… comparten el temporal
/// `.tmp-<pid>`: a la vez, uno instalaba el JSON a medio escribir del otro
/// (EOF al verificarlo) y el otro ya no encontraba su temporal. Y una lectura
/// entre los dos renombres veía el archivo ausente y devolvía la configuración
/// vacía.
static SETTINGS_IO: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn file_signature(file: &Path) -> Option<FileSignature> {
    let metadata = std::fs::metadata(file).ok()?;
    Some(FileSignature {
        len: metadata.len(),
        modified: metadata.modified().ok()?,
    })
}

pub fn settings_path() -> PathBuf {
    paths::user_data_dir().join("settings.json")
}

fn read_object(file: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Lee la configuración. Un archivo ausente es lo normal en el primer arranque
/// y devuelve un objeto vacío; uno corrupto intenta primero la copia `.bak`.
pub fn load_settings() -> Map<String, Value> {
    let _io = SETTINGS_IO.lock();
    load_settings_unlocked()
}

/// `load_settings` para quien ya tiene `SETTINGS_IO` (el guardado, que fusiona
/// sobre lo último escrito).
fn load_settings_unlocked() -> Map<String, Value> {
    let target = settings_path();
    let signature = file_signature(&target);
    {
        let cache = SETTINGS_CACHE.lock();
        if cache.initialized && cache.signature == signature {
            return cache.value.clone();
        }
    }

    if !target.exists() {
        let value = Map::new();
        *SETTINGS_CACHE.lock() = SettingsCache {
            initialized: true,
            signature: None,
            value: value.clone(),
        };
        return value;
    }
    let value = match read_object(&target) {
        Some(map) => map,
        None => {
            log_warn!("No se pudo leer settings.json; se intentará la copia de respaldo");
            match read_object(&backup_path(&target)) {
                Some(recovered) => {
                    log_info!("Configuración recuperada desde settings.json.bak");
                    recovered
                }
                None => {
                    log_warn!("No hay una copia de configuración recuperable");
                    Map::new()
                }
            }
        }
    };
    *SETTINGS_CACHE.lock() = SettingsCache {
        initialized: true,
        signature,
        value: value.clone(),
    };
    value
}

fn backup_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".bak");
    PathBuf::from(name)
}

fn temp_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(format!(".tmp-{}", std::process::id()));
    PathBuf::from(name)
}

/// Guarda un parche parcial. Los llamantes guardan solo lo que cambian (por
/// ejemplo, la carpeta de scripts); fusionarlo evita borrar otras preferencias
/// como `autoStartDocker` al modificar una opción distinta.
///
/// Devuelve la configuración completa resultante, o `None` si no se pudo
/// escribir.
pub fn save_settings(patch: &Map<String, Value>) -> Option<Map<String, Value>> {
    let next = save_merged(&settings_path(), patch, load_settings_unlocked)?;
    // Cambiar la carpeta propia, desactivarla o cambiar sus categorías
    // afecta a las terminales que se abran desde ahora.
    if patch.keys().any(|key| key.starts_with("toolchainStore")) {
        crate::config::toolchain_store::refresh_environment();
        // Y en el PATH del usuario, si la integración con el PATH está activa.
        if let Err(error) = crate::platform::path_integration::sync_tool_bins() {
            log_warn!(
                "No se pudieron actualizar las carpetas de herramientas en el PATH",
                serde_json::json!({ "error": error })
            );
        }
    }
    Some(next)
}

/// Fusiona `patch` sobre `current()` y lo escribe en `target` con
/// `SETTINGS_IO` tomado de la lectura a la verificación; si falla, deja el
/// destino como estaba.
fn save_merged(
    target: &Path,
    patch: &Map<String, Value>,
    current: impl FnOnce() -> Map<String, Value>,
) -> Option<Map<String, Value>> {
    let _io = SETTINGS_IO.lock();
    let backup = backup_path(target);
    let temp = temp_path(target);

    match write_merged(target, &backup, &temp, current(), patch) {
        Ok(next) => Some(next),
        Err(error) => {
            log_error!(
                "No se pudo guardar settings.json",
                serde_json::json!({ "error": error.to_string() })
            );
            let _ = std::fs::remove_file(&temp);
            // Si el destino quedó apartado pero no se pudo instalar el nuevo,
            // se restaura la configuración anterior en el mejor esfuerzo.
            if !target.exists() && backup.exists() {
                if let Err(restore_error) = std::fs::rename(&backup, target) {
                    log_error!(
                        "No se pudo restaurar settings.json.bak",
                        serde_json::json!({ "error": restore_error.to_string() })
                    );
                }
            }
            None
        }
    }
}

fn write_merged(
    target: &Path,
    backup: &Path,
    temp: &Path,
    mut next: Map<String, Value>,
    patch: &Map<String, Value>,
) -> anyhow::Result<Map<String, Value>> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for (key, value) in patch {
        next.insert(key.clone(), value.clone());
    }
    std::fs::write(temp, serde_json::to_string_pretty(&next)?)?;

    // En Windows renombrar encima de un fichero existente puede fallar. Se
    // aparta primero la versión anterior: si el proceso se interrumpe entre
    // ambos renombres, load_settings todavía puede recuperar .bak.
    let _ = std::fs::remove_file(backup);
    if target.exists() {
        std::fs::rename(target, backup)?;
    }
    std::fs::rename(temp, target)?;

    // Verificación temprana: no se elimina el respaldo hasta comprobar que el
    // JSON final puede volver a abrirse.
    let verified = std::fs::read_to_string(target)?;
    serde_json::from_str::<Value>(&verified)?;
    let _ = std::fs::remove_file(backup);
    if target == settings_path() {
        *SETTINGS_CACHE.lock() = SettingsCache {
            initialized: true,
            signature: file_signature(target),
            value: next.clone(),
        };
    }
    Ok(next)
}

/// Atajo para guardar una sola clave.
pub fn save_key(key: &str, value: Value) -> Option<Map<String, Value>> {
    let mut patch = Map::new();
    patch.insert(key.to_string(), value);
    save_settings(&patch)
}

pub fn string_setting(settings: &Map<String, Value>, key: &str) -> Option<String> {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // write_merged es la parte con lógica propia (fusión, respaldo,
    // verificación) y no depende de userData, así que se prueba directamente
    // sobre un directorio temporal.
    fn merged_in(dir: &Path, patch: Value) -> Map<String, Value> {
        let target = dir.join("settings.json");
        let patch = patch.as_object().expect("el parche es un objeto").clone();
        // save_settings fusiona sobre la ruta real de userData; aquí se fusiona
        // sobre el archivo del temporal con el mismo save_merged.
        save_merged(&target, &patch, || read_object(&target).unwrap_or_default())
            .expect("el guardado termina bien")
    }

    #[test]
    fn guardados_simultaneos_no_se_pisan_ni_pierden_claves() {
        // El E2E de administrador lo destapó: el hilo que guarda el tamaño de
        // la ventana y un guardado de Ajustes a la vez dejaban settings.json
        // vacío (EOF al verificar) y el otro sin temporal (os error 2).
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        std::thread::scope(|scope| {
            for writer in 0..8 {
                let target = &target;
                scope.spawn(move || {
                    for round in 0..10 {
                        let mut patch = Map::new();
                        patch.insert(format!("clave{writer}"), json!(round));
                        save_merged(target, &patch, || read_object(target).unwrap_or_default())
                            .expect("cada guardado simultáneo termina bien");
                    }
                });
            }
        });
        let saved = read_object(&target).expect("settings.json sigue siendo JSON válido");
        for writer in 0..8 {
            assert_eq!(saved.get(&format!("clave{writer}")), Some(&json!(9)));
        }
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name != "settings.json")
            .collect();
        assert!(leftovers.is_empty(), "sobran archivos: {leftovers:?}");
    }

    #[test]
    fn un_parche_no_borra_las_claves_que_no_toca() {
        let dir = tempfile::tempdir().unwrap();
        merged_in(
            dir.path(),
            json!({ "autoStartDocker": false, "themeId": "ocean" }),
        );
        let after = merged_in(dir.path(), json!({ "themeId": "amber" }));
        assert_eq!(after.get("autoStartDocker"), Some(&json!(false)));
        assert_eq!(after.get("themeId"), Some(&json!("amber")));
    }

    #[test]
    fn el_archivo_final_es_json_reabrible() {
        let dir = tempfile::tempdir().unwrap();
        merged_in(dir.path(), json!({ "scriptsHereDepth": 4 }));
        let text = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["scriptsHereDepth"], json!(4));
    }

    #[test]
    fn no_queda_ningun_temporal_ni_respaldo_tras_guardar() {
        let dir = tempfile::tempdir().unwrap();
        merged_in(dir.path(), json!({ "themeId": "forest" }));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name != "settings.json")
            .collect();
        assert!(leftovers.is_empty(), "sobran archivos: {leftovers:?}");
    }

    #[test]
    fn las_rutas_derivadas_cuelgan_del_destino() {
        let target = Path::new("/tmp/x/settings.json");
        assert_eq!(backup_path(target), Path::new("/tmp/x/settings.json.bak"));
        assert!(temp_path(target)
            .to_string_lossy()
            .starts_with("/tmp/x/settings.json.tmp-"));
    }
}
