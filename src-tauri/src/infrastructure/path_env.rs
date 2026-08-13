//! Mantiene el PATH del PROCESO de la app sincronizado con el PATH real del
//! sistema, y centraliza la búsqueda de ejecutables (`which`).
//!
//! Port de `electron/main/pathEnv.js`.
//!
//! El problema que resuelve: un instalador lanzado desde la propia terminal
//! (winget, el script de ADB, apt...) escribe la carpeta nueva en el PATH
//! persistente del usuario (en Windows, el registro), pero eso NO afecta a los
//! procesos ya en marcha. La app heredó su PATH al arrancar y cada pestaña se
//! spawnea con ese entorno, así que sin esto haría falta cerrar y volver a
//! abrir la app entera para que una herramienta recién instalada funcionara en
//! una pestaña nueva — y para que la app dejara de ofrecer "Instalar" algo que
//! ya está instalado.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::platform::traits::PathPlatform;
use crate::process;

const WHICH_CACHE_MS: Duration = Duration::from_millis(5000);

struct CacheEntry {
    at: Instant,
    value: Option<PathBuf>,
}

static WHICH_CACHE: Lazy<Mutex<HashMap<String, CacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn clear_which_cache() {
    WHICH_CACHE.lock().clear();
}

pub fn path_separator() -> char {
    crate::platform::host().path_separator()
}

/// Divide un PATH en entradas útiles, sin vacíos ni espacios sobrantes.
pub fn split_path(value: &str) -> Vec<String> {
    value
        .split(path_separator())
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// Clave de comparación entre entradas de PATH: Windows no distingue
/// mayúsculas y la barra final es irrelevante (`C:\Foo\` == `c:\foo`).
pub fn path_key(entry: &str) -> String {
    crate::platform::host().normalize_path_key(entry)
}

fn current_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Busca un ejecutable en el PATH actual del proceso. Devuelve la ruta
/// completa o `None`. El resultado se cachea unos segundos: la detección de
/// entornos pregunta por decenas de comandos seguidos.
pub fn which(cmd: &str) -> Option<PathBuf> {
    let path_value = current_path();
    let cache_key = format!("{path_value}\0{cmd}");
    {
        let cache = WHICH_CACHE.lock();
        if let Some(entry) = cache.get(&cache_key) {
            if entry.at.elapsed() < WHICH_CACHE_MS {
                return entry.value.clone();
            }
        }
    }

    let value = crate::platform::host().find_executable(cmd, &path_value);

    WHICH_CACHE.lock().insert(
        cache_key,
        CacheEntry {
            at: Instant::now(),
            value: value.clone(),
        },
    );
    value
}

/// `true` si el comando existe. Caso especial: en Windows, `python`/`python3`
/// casi siempre "existen" en el PATH vía el alias de ejecución de la Microsoft
/// Store aunque no haya ningún Python real instalado (el alias solo abre la
/// Store al ejecutarse). Por eso, solo para esos dos, se comprueba que
/// `--version` responda de verdad.
pub fn is_tool_installed(cmd: &str) -> bool {
    if cmd == "python" || cmd == "python3" {
        return process::output_text(cmd, &["--version"], Duration::from_secs(2))
            .map(|out| out.contains("Python 3."))
            .unwrap_or(false);
    }
    which(cmd).is_some()
}

/// Añade una carpeta al PATH del proceso si no estaba ya. Devuelve `true` si de
/// verdad se añadió.
pub fn add_to_process_path(dir: &str) -> bool {
    if dir.is_empty() {
        return false;
    }
    let current = current_path();
    let known: Vec<String> = split_path(&current).iter().map(|e| path_key(e)).collect();
    if known.contains(&path_key(dir)) {
        return false;
    }
    let separator = path_separator();
    let trimmed = current.trim_end_matches(separator);
    std::env::set_var("PATH", format!("{trimmed}{separator}{dir}"));
    clear_which_cache();
    true
}

#[derive(Debug, Default)]
pub struct PathRefresh {
    pub changed: bool,
    pub added: Vec<String>,
}

/// Vuelve a leer el PATH persistente (máquina + usuario) y añade al PATH del
/// proceso las carpetas que aún no estuvieran. Nunca quita nada: las entradas
/// que la app heredó al arrancar pueden venir de su lanzador y no estar en el
/// registro.
///
/// Fuera de Windows no hace nada: en Linux/macOS el PATH viene de los archivos
/// de perfil de la shell, no de un almacén consultable, y cada pestaña ya lo
/// recalcula al arrancar su shell interactiva.
pub fn refresh_system_path() -> PathRefresh {
    let mut known: Vec<String> = split_path(&current_path())
        .iter()
        .map(|entry| path_key(entry))
        .collect();
    let mut added = Vec::new();

    for dir in crate::platform::host().persistent_path_entries() {
        let normalized = path_key(&dir);
        if normalized.is_empty() || known.contains(&normalized) {
            continue;
        }
        known.push(normalized);
        added.push(dir);
    }

    for dir in &added {
        let current = current_path();
        let separator = path_separator();
        std::env::set_var(
            "PATH",
            format!("{}{separator}{dir}", current.trim_end_matches(separator)),
        );
    }
    if !added.is_empty() {
        clear_which_cache();
    }

    PathRefresh {
        changed: !added.is_empty(),
        added,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_clave_de_comparacion_ignora_la_barra_final() {
        assert_eq!(path_key("C:\\Foo\\"), path_key("C:\\Foo"));
        assert_eq!(path_key("  \"/usr/bin/\"  "), "/usr/bin");
    }

    #[cfg(windows)]
    #[test]
    fn en_windows_la_clave_de_comparacion_ignora_mayusculas() {
        assert_eq!(path_key("C:\\Foo"), path_key("c:\\foo"));
    }

    #[test]
    fn split_path_descarta_entradas_vacias() {
        let separator = path_separator();
        let raw = format!("/uno{separator}{separator}  {separator}/dos");
        assert_eq!(
            split_path(&raw),
            vec!["/uno".to_string(), "/dos".to_string()]
        );
    }

    #[test]
    fn anadir_una_carpeta_ya_conocida_no_cambia_el_path() {
        let separator = path_separator();
        let original = current_path();
        let dir = if cfg!(windows) {
            "C:\\LTerminalPrueba"
        } else {
            "/opt/lterminal-prueba"
        };

        assert!(add_to_process_path(dir));
        assert!(current_path().ends_with(&format!("{separator}{dir}")));
        // La segunda vez ya está: no se duplica.
        assert!(!add_to_process_path(dir));

        std::env::set_var("PATH", original);
        clear_which_cache();
    }
}
