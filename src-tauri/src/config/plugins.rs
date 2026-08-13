//! Extensiones declarativas instaladas por el usuario.
//!
//! Los plugins no cargan DLL ni ejecutan código dentro del proceso. Un
//! `plugin.json` puede aportar tecnologías/REPL; LTerminal valida todos sus
//! campos y sigue aplicando la detección de PATH habitual. Esto mantiene una
//! frontera de seguridad clara y permite deshabilitar o eliminar un plugin sin
//! dejar binarios enganchados a la aplicación.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_PLUGINS: usize = 64;
const MAX_MANIFEST_BYTES: u64 = 262_144;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTechnology {
    pub id: String,
    pub label: String,
    pub category: String,
    pub windows_exe: String,
    pub unix_exe: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    technologies: Vec<PluginTechnology>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub technology_count: usize,
    pub error: Option<String>,
}

fn plugins_dir() -> PathBuf {
    crate::paths::user_data_dir().join("plugins")
}

fn state_path() -> PathBuf {
    crate::paths::user_data_dir().join("plugins-state.json")
}

fn valid_id(value: &str) -> bool {
    let len = value.len();
    (2..=64).contains(&len)
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn load_state() -> HashMap<String, bool> {
    std::fs::read(state_path())
        .ok()
        .filter(|bytes| bytes.len() <= MAX_MANIFEST_BYTES as usize)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(state: &HashMap<String, bool>) -> Result<(), String> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("manifest ausente o demasiado grande".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1 || !valid_id(&manifest.id) {
        return Err("schemaVersion o id no válido".into());
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 100 || manifest.version.len() > 40 {
        return Err("nombre o versión no válidos".into());
    }
    if manifest.technologies.len() > 100 {
        return Err("demasiadas tecnologías en un plugin".into());
    }
    let mut ids = HashSet::new();
    for technology in &manifest.technologies {
        if !valid_id(&technology.id)
            || technology.label.trim().is_empty()
            || technology.label.len() > 100
            || technology.windows_exe.len() > 260
            || technology.unix_exe.len() > 260
            || technology.args.len() > 32
            || technology.args.iter().any(|arg| arg.len() > 512)
            || !ids.insert(technology.id.as_str())
        {
            return Err(format!("tecnología no válida: {}", technology.id));
        }
    }
    Ok(manifest)
}

fn manifests() -> Vec<(PathBuf, Result<Manifest, String>)> {
    let Ok(entries) = std::fs::read_dir(plugins_dir()) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path().join("plugin.json"))
        })
        .take(MAX_PLUGINS)
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let manifest = read_manifest(&path);
            (path, manifest)
        })
        .collect()
}

pub fn enabled_technologies() -> Vec<PluginTechnology> {
    let state = load_state();
    manifests()
        .into_iter()
        .filter_map(|(_, manifest)| manifest.ok())
        .filter(|manifest| state.get(&manifest.id).copied().unwrap_or(true))
        .flat_map(|manifest| manifest.technologies)
        .collect()
}

#[tauri::command]
pub fn plugins_list() -> Vec<PluginInfo> {
    let state = load_state();
    manifests()
        .into_iter()
        .map(|(path, result)| match result {
            Ok(manifest) => PluginInfo {
                enabled: state.get(&manifest.id).copied().unwrap_or(true),
                technology_count: manifest.technologies.len(),
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
                error: None,
            },
            Err(error) => PluginInfo {
                id: path
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|name| name.to_str())
                    .unwrap_or("invalid")
                    .to_string(),
                name: "Plugin inválido".into(),
                version: String::new(),
                description: String::new(),
                enabled: false,
                technology_count: 0,
                error: Some(error),
            },
        })
        .collect()
}

#[tauri::command(async)]
pub fn plugins_set_enabled(id: String, enabled: bool) -> Result<Vec<PluginInfo>, String> {
    if !valid_id(&id)
        || !manifests()
            .iter()
            .any(|(_, item)| item.as_ref().is_ok_and(|manifest| manifest.id == id))
    {
        return Err("Plugin desconocido".into());
    }
    let mut state = load_state();
    state.insert(id, enabled);
    save_state(&state)?;
    Ok(plugins_list())
}

#[tauri::command(async)]
pub fn plugins_install(manifest_path: String) -> Result<Vec<PluginInfo>, String> {
    let source = PathBuf::from(manifest_path);
    if source.file_name().and_then(|name| name.to_str()) != Some("plugin.json") {
        return Err("Selecciona un archivo llamado plugin.json".into());
    }
    let manifest = read_manifest(&source)?;
    let destination = plugins_dir().join(&manifest.id);
    if destination.exists() {
        return Err("Ya existe un plugin con ese identificador".into());
    }
    std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::copy(&source, destination.join("plugin.json")) {
        let _ = std::fs::remove_dir(&destination);
        return Err(error.to_string());
    }
    Ok(plugins_list())
}

#[tauri::command(async)]
pub fn plugins_remove(id: String) -> Result<Vec<PluginInfo>, String> {
    if !valid_id(&id) {
        return Err("Identificador de plugin no válido".into());
    }
    let source = plugins_dir().join(&id);
    if !source.join("plugin.json").is_file() {
        return Err("Plugin desconocido".into());
    }
    let backups = crate::paths::user_data_dir().join("plugin-backups");
    std::fs::create_dir_all(&backups).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    std::fs::rename(&source, backups.join(format!("{id}-{stamp}")))
        .map_err(|error| error.to_string())?;
    let mut state = load_state();
    state.remove(&id);
    save_state(&state)?;
    Ok(plugins_list())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_ids_de_plugin_son_portables_y_acotados() {
        assert!(valid_id("mi-plugin-2"));
        assert!(!valid_id("Mi Plugin"));
        assert!(!valid_id("-plugin"));
    }
}
