//! Limpieza de lo que WTerminal puede volver a generar (24-11, Romen:
//! «centralizar todo, de forma opcional, pero hacerlo por default […]
//! limpiar cachés y archivos regenerables»).
//!
//! La carpeta propia (`toolchain_store`) ya reúne lo que descargan y crean
//! las herramientas, y «Vaciar cachés» vacía su parte de cachés. Esto suma, en
//! una sola limpieza que se elige por partes:
//!
//! | Parte | Qué borra | Qué pasa después |
//! |---|---|---|
//! | `caches` | Las cachés de la carpeta propia (npm, pip, Go…) | Se vuelven a descargar al hacer falta |
//! | `downloads` | Lo que bajan las acciones del panel (instaladores, zips) | Se vuelve a bajar si se repite la acción |
//! | `detection` | La caché de detección (entornos, discos, hardware, programas) | La próxima detección tarda un poco más |
//! | `logs` | La copia rotada del registro (`main.log.1`) | Nada: el registro actual se queda |
//!
//! Los temporales de sesión ya se borran solos al arrancar
//! (`session_files::prune_orphaned_sessions`). Nada de esto toca programas
//! instalados, ajustes, chats ni proyectos. Con `regenerableAutoClean`
//! (apagado de fábrica) se hace sola al arrancar cada
//! `regenerableAutoCleanDays` días, con las partes que marcan sus ajustes.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::toolchain_store::{self, Category};

/// Una parte de la limpieza.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Regenerable {
    Caches,
    Downloads,
    Detection,
    Logs,
}

impl Regenerable {
    pub const ALL: [Regenerable; 4] = [
        Regenerable::Caches,
        Regenerable::Downloads,
        Regenerable::Detection,
        Regenerable::Logs,
    ];
}

/// Lo que ocupa cada parte (para enseñarlo antes de limpiar).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegenerableSize {
    pub kind: Regenerable,
    pub bytes: u64,
}

/// Archivos de la caché de detección, dentro de la carpeta de datos.
const DETECTION_FILES: &[&str] = &[
    "install-actions-cache.json",
    "install-actions-snapshot.json",
    "disk-cache.json",
    "hardware-cache.json",
    "programas/cache.json",
];

/// Dónde se apunta la última limpieza automática.
const LAST_CLEAN_FILE: &str = "regenerable-last-clean.txt";

/// Las rutas (archivos o carpetas) de una parte.
fn paths_of(kind: Regenerable, user_data: &Path) -> Vec<PathBuf> {
    match kind {
        Regenerable::Caches => toolchain_store::clearable_cache_paths(),
        Regenerable::Downloads => toolchain_store::clearable_category_dir(Category::Downloads)
            .and_then(|dir| fs::read_dir(dir).ok())
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default(),
        Regenerable::Detection => DETECTION_FILES
            .iter()
            .map(|name| user_data.join(name))
            .collect(),
        Regenerable::Logs => crate::logger::log_dir()
            .map(|dir| vec![dir.join("main.log.1")])
            .unwrap_or_default(),
    }
}

fn size_of(path: &Path) -> u64 {
    if path.is_dir() {
        toolchain_store::directory_size(path)
    } else {
        fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
    }
}

fn remove(path: &Path) -> u64 {
    let before = size_of(path);
    let removed = if path.is_dir() {
        fs::remove_dir_all(path).is_ok()
    } else {
        fs::remove_file(path).is_ok()
    };
    if removed {
        before
    } else {
        before.saturating_sub(size_of(path))
    }
}

pub fn sizes() -> Vec<RegenerableSize> {
    let user_data = crate::paths::user_data_dir();
    Regenerable::ALL
        .into_iter()
        .map(|kind| RegenerableSize {
            kind,
            bytes: paths_of(kind, &user_data)
                .iter()
                .map(|path| size_of(path))
                .sum(),
        })
        .collect()
}

/// Limpia las partes pedidas y devuelve los bytes liberados.
pub fn clean(kinds: &[Regenerable]) -> u64 {
    let user_data = crate::paths::user_data_dir();
    let mut freed = 0;
    for kind in kinds {
        let bytes: u64 = paths_of(*kind, &user_data)
            .iter()
            .filter(|path| path.exists())
            .map(|path| remove(path))
            .sum();
        freed += bytes;
    }
    crate::log_info!(
        "Limpieza de archivos regenerables",
        serde_json::json!({ "kinds": kinds, "freed": freed })
    );
    freed
}

/// Las partes que marca la limpieza automática en Ajustes.
fn auto_kinds(preferences: &crate::preferences::Preferences) -> Vec<Regenerable> {
    [
        (Regenerable::Caches, preferences.regenerable_clean_caches),
        (
            Regenerable::Downloads,
            preferences.regenerable_clean_downloads,
        ),
        (
            Regenerable::Detection,
            preferences.regenerable_clean_detection,
        ),
        (Regenerable::Logs, preferences.regenerable_clean_logs),
    ]
    .into_iter()
    .filter_map(|(kind, on)| on.then_some(kind))
    .collect()
}

/// ¿Toca la limpieza automática? `last` y `now` en segundos.
fn due(last: Option<u64>, now: u64, days: i64) -> bool {
    let every = days.max(1) as u64 * 24 * 60 * 60;
    last.map_or(true, |last| now.saturating_sub(last) >= every)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Al arrancar, en segundo plano: con `regenerableAutoClean` (apagado de
/// fábrica), limpia lo marcado si ya pasaron los días.
pub fn auto_clean_if_due() {
    let preferences = crate::preferences::current();
    if !preferences.regenerable_auto_clean {
        return;
    }
    let stamp = crate::paths::user_data_dir().join(LAST_CLEAN_FILE);
    let last = fs::read_to_string(&stamp)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok());
    let now = now_secs();
    if !due(last, now, preferences.regenerable_auto_clean_days) {
        return;
    }
    let kinds = auto_kinds(&preferences);
    if !kinds.is_empty() {
        clean(&kinds);
    }
    let _ = fs::write(&stamp, now.to_string());
}

/// Lo que ocupa cada parte.
#[tauri::command]
pub async fn regenerable_sizes() -> Vec<RegenerableSize> {
    tauri::async_runtime::spawn_blocking(sizes)
        .await
        .unwrap_or_default()
}

/// Limpia las partes elegidas; devuelve los bytes liberados.
#[tauri::command]
pub async fn regenerable_clean(kinds: Vec<Regenerable>) -> u64 {
    tauri::async_runtime::spawn_blocking(move || clean(&kinds))
        .await
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_limpieza_automatica_espera_sus_dias() {
        let day = 24 * 60 * 60;
        assert!(due(None, 100, 30), "nunca se hizo: toca");
        assert!(!due(Some(100), 100 + 29 * day, 30));
        assert!(due(Some(100), 100 + 30 * day, 30));
        assert!(due(Some(100), 100 + day, 0), "0 cuenta como 1 día");
    }

    #[test]
    fn la_deteccion_y_el_registro_son_archivos_concretos() {
        let user_data = PathBuf::from("datos");
        let detection = paths_of(Regenerable::Detection, &user_data);
        assert!(detection.contains(&user_data.join("disk-cache.json")));
        assert!(detection.iter().all(|path| path.starts_with(&user_data)));
        assert!(
            !detection.iter().any(|path| path.ends_with("settings.json")),
            "nunca los ajustes"
        );
    }

    #[test]
    fn borrar_dice_lo_liberado() {
        let dir =
            std::env::temp_dir().join(format!("wterminal-regenerable-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(dir.join("b.json"), vec![0u8; 24]).unwrap();
        assert_eq!(remove(&dir.join("b.json")), 24);
        assert_eq!(remove(&dir.join("sub")), 1000);
        assert!(!dir.join("sub").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
