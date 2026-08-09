//! Unifica los datos creados bajo el nombre visible de la app con la ruta
//! estable basada en su slug. Solo migra configuración y la biblioteca de
//! scripts; cachés del motor web y logs antiguos no se duplican.
//!
//! Port de `electron/main/userDataMigration.js`. Sigue haciendo falta después
//! de dejar Electron: la instalación existente de un usuario puede tener sus
//! ajustes en `%APPDATA%\WinSlim Terminal` en vez de en el slug.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{Map, Value};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MigrationReport {
    pub migrated: bool,
    pub settings_merged: bool,
    pub scripts_copied: usize,
}

fn read_object(file: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn modified_at(file: &Path) -> SystemTime {
    std::fs::metadata(file)
        .and_then(|meta| meta.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// El archivo más reciente gana solo en claves coincidentes. Así se conservan,
/// por ejemplo, anclados antiguos y preferencias visuales nuevas.
fn merge_settings(legacy_dir: &Path, canonical_dir: &Path) -> bool {
    let legacy_file = legacy_dir.join("settings.json");
    let canonical_file = canonical_dir.join("settings.json");
    let legacy = read_object(&legacy_file);
    let canonical = read_object(&canonical_file);
    if legacy.is_none() && canonical.is_none() {
        return false;
    }

    let legacy_is_newer = modified_at(&legacy_file) > modified_at(&canonical_file);
    let (base, winner) = if legacy_is_newer {
        (canonical.clone(), legacy)
    } else {
        (legacy, canonical.clone())
    };
    let mut merged = base.unwrap_or_default();
    for (key, value) in winner.unwrap_or_default() {
        merged.insert(key, value);
    }

    let current = canonical.unwrap_or_default();
    if current == merged {
        return false;
    }
    let Ok(text) = serde_json::to_string_pretty(&merged) else {
        return false;
    };
    std::fs::write(&canonical_file, text).is_ok()
}

/// Copia recursiva sin sobrescribir nada más nuevo: la biblioteca de scripts
/// del usuario en la ruta canónica siempre manda sobre la heredada.
fn merge_script_directory(source: &Path, target: &Path) -> usize {
    if !source.exists() {
        return 0;
    }
    if std::fs::create_dir_all(target).is_err() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(source) else {
        return 0;
    };
    let mut copied = 0;
    for entry in entries.filter_map(Result::ok) {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            copied += merge_script_directory(&source_path, &target_path);
        } else if file_type.is_file()
            && (!target_path.exists() || modified_at(&source_path) > modified_at(&target_path))
            && std::fs::copy(&source_path, &target_path).is_ok()
        {
            copied += 1;
        }
    }
    copied
}

fn same_directory(a: &Path, b: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| PathBuf::from(path))
            .to_string_lossy()
            .to_lowercase()
    }
    normalized(a) == normalized(b)
}

pub fn migrate_user_data(legacy_dir: &Path, canonical_dir: &Path) -> MigrationReport {
    if legacy_dir.as_os_str().is_empty()
        || canonical_dir.as_os_str().is_empty()
        || same_directory(legacy_dir, canonical_dir)
    {
        return MigrationReport::default();
    }
    if std::fs::create_dir_all(canonical_dir).is_err() {
        return MigrationReport::default();
    }
    let settings_merged = merge_settings(legacy_dir, canonical_dir);
    let scripts_copied =
        merge_script_directory(&legacy_dir.join("scripts"), &canonical_dir.join("scripts"));
    MigrationReport {
        migrated: settings_merged || scripts_copied > 0,
        settings_merged,
        scripts_copied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_json(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        let mut handle = std::fs::File::create(&file).unwrap();
        handle.write_all(body.as_bytes()).unwrap();
        file
    }

    #[test]
    fn no_migra_cuando_las_dos_rutas_son_la_misma() {
        let dir = tempfile::tempdir().unwrap();
        let report = migrate_user_data(dir.path(), dir.path());
        assert_eq!(report, MigrationReport::default());
    }

    #[test]
    fn conserva_las_claves_que_solo_estan_en_una_de_las_dos() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy");
        let canonical = root.path().join("canonical");
        write_json(&legacy, "settings.json", r#"{"themeId":"ocean"}"#);
        write_json(&canonical, "settings.json", r#"{"autoStartDocker":false}"#);

        let report = migrate_user_data(&legacy, &canonical);
        assert!(report.settings_merged);

        let merged = read_object(&canonical.join("settings.json")).unwrap();
        assert_eq!(merged.get("themeId"), Some(&Value::from("ocean")));
        assert_eq!(merged.get("autoStartDocker"), Some(&Value::from(false)));
    }

    #[test]
    fn no_reescribe_si_el_resultado_es_identico() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy");
        let canonical = root.path().join("canonical");
        write_json(&legacy, "settings.json", r#"{"themeId":"ocean"}"#);
        write_json(&canonical, "settings.json", r#"{"themeId":"ocean"}"#);

        assert!(!migrate_user_data(&legacy, &canonical).settings_merged);
    }

    #[test]
    fn copia_los_scripts_que_faltan_sin_pisar_los_existentes() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy");
        let canonical = root.path().join("canonical");
        write_json(&legacy.join("scripts"), "uno.ps1", "antiguo");
        write_json(&legacy.join("scripts").join("sub"), "dos.sh", "antiguo");
        write_json(&canonical.join("scripts"), "uno.ps1", "nuevo");

        let report = migrate_user_data(&legacy, &canonical);
        assert_eq!(report.scripts_copied, 1);
        assert!(report.migrated);
        assert_eq!(
            std::fs::read_to_string(canonical.join("scripts").join("uno.ps1")).unwrap(),
            "nuevo"
        );
        assert!(canonical
            .join("scripts")
            .join("sub")
            .join("dos.sh")
            .exists());
    }
}
