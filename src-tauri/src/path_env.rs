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
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

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
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
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
    let mut value = entry.trim().trim_matches('"').to_string();
    if cfg!(windows) {
        value = value.to_lowercase();
    }
    value.trim_end_matches(['\\', '/']).to_string()
}

fn current_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Busca un ejecutable recorriendo el PATH a mano. Es la vía en Linux y macOS,
/// donde no hay un `where` que preguntar.
pub fn find_unix_executable(cmd: &str, path_value: &str, separator: char) -> Option<PathBuf> {
    if cmd.is_empty() || cmd.contains(['\0', '\r', '\n']) {
        return None;
    }
    let candidates: Vec<PathBuf> = if cmd.contains('/') {
        vec![std::fs::canonicalize(cmd).unwrap_or_else(|_| PathBuf::from(cmd))]
    } else {
        path_value
            .split(separator)
            .filter(|dir| !dir.is_empty())
            .map(|dir| Path::new(dir).join(cmd))
            .collect()
    };
    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(candidate: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(candidate)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(candidate: &Path) -> bool {
    candidate.is_file()
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

    let value = if cfg!(windows) {
        which_windows(cmd)
    } else {
        find_unix_executable(cmd, &path_value, path_separator())
    };

    WHICH_CACHE.lock().insert(
        cache_key,
        CacheEntry {
            at: Instant::now(),
            value: value.clone(),
        },
    );
    value
}

fn which_windows(cmd: &str) -> Option<PathBuf> {
    let out = process::output_text("where", &[cmd], Duration::from_millis(1500))?;
    out.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
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

const REGISTRY_PATH_KEYS: [&str; 2] = [
    r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    r"HKCU\Environment",
];

/// Lee el valor "Path" de una clave del registro. `reg query` no traduce los
/// nombres de valor ni los tipos, así que el parseo vale en cualquier idioma de
/// Windows.
fn query_registry_path(key: &str) -> Option<String> {
    let out = process::output_text(
        "reg",
        &["query", key, "/v", "Path"],
        Duration::from_millis(1500),
    )?;
    parse_registry_path(&out)
}

fn parse_registry_path(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        let mut parts = trimmed.splitn(3, char::is_whitespace);
        let name = parts.next()?;
        if !name.eq_ignore_ascii_case("Path") {
            continue;
        }
        let rest = trimmed[name.len()..].trim_start();
        let mut kind_split = rest.splitn(2, char::is_whitespace);
        let kind = kind_split.next().unwrap_or("");
        if !kind.eq_ignore_ascii_case("REG_SZ") && !kind.eq_ignore_ascii_case("REG_EXPAND_SZ") {
            continue;
        }
        let value = kind_split.next().unwrap_or("").trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// El PATH de máquina suele guardarse como REG_EXPAND_SZ con referencias sin
/// expandir (`%SystemRoot%\system32`). Se resuelven contra el entorno actual;
/// lo que no se reconozca se deja tal cual (mejor una entrada inservible que
/// perder el resto del PATH).
fn expand_env_vars(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match lookup_env_ignore_case(name) {
                    Some(resolved) => out.push_str(&resolved),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn lookup_env_ignore_case(name: &str) -> Option<String> {
    std::env::vars()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
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
    if !cfg!(windows) {
        return PathRefresh::default();
    }

    let mut known: Vec<String> = split_path(&current_path())
        .iter()
        .map(|entry| path_key(entry))
        .collect();
    let mut added = Vec::new();

    for key in REGISTRY_PATH_KEYS {
        let Some(raw) = query_registry_path(key) else {
            continue;
        };
        for dir in split_path(&expand_env_vars(&raw)) {
            let normalized = path_key(&dir);
            if normalized.is_empty() || known.contains(&normalized) {
                continue;
            }
            known.push(normalized);
            added.push(dir);
        }
    }

    for dir in &added {
        let current = current_path();
        std::env::set_var("PATH", format!("{};{dir}", current.trim_end_matches(';')));
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
    fn se_rechaza_un_comando_con_caracteres_de_control() {
        assert!(find_unix_executable("ba\nsh", "/usr/bin", ':').is_none());
        assert!(find_unix_executable("", "/usr/bin", ':').is_none());
    }

    #[test]
    fn la_busqueda_unix_encuentra_un_archivo_ejecutable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("miherramienta");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // El separador se pasa explícitamente para poder ejercitar la búsqueda
        // también en Windows, donde una ruta como C:\Temp\... contiene el ':'
        // y quedaría partida por la letra de unidad.
        let found = find_unix_executable(
            "miherramienta",
            dir.path().to_str().unwrap(),
            path_separator(),
        );
        assert_eq!(found, Some(file));
    }

    #[test]
    fn se_parsea_la_salida_de_reg_query() {
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Tools;%USERPROFILE%\\bin\r\n\r\n";
        assert_eq!(
            parse_registry_path(out).as_deref(),
            Some("C:\\Tools;%USERPROFILE%\\bin")
        );
    }

    #[test]
    fn una_salida_de_reg_sin_path_no_devuelve_nada() {
        assert_eq!(
            parse_registry_path("HKEY_CURRENT_USER\\Environment\r\n"),
            None
        );
        assert_eq!(parse_registry_path("    Otro    REG_SZ    x\r\n"), None);
    }

    #[test]
    fn las_variables_desconocidas_se_dejan_tal_cual() {
        std::env::set_var("LTERMINAL_TEST_ROOT", "/opt/x");
        assert_eq!(
            expand_env_vars("%LTERMINAL_TEST_ROOT%\\bin;%NO_EXISTE_SEGURO%\\y"),
            "/opt/x\\bin;%NO_EXISTE_SEGURO%\\y"
        );
        std::env::remove_var("LTERMINAL_TEST_ROOT");
    }

    #[test]
    fn un_porcentaje_suelto_no_rompe_la_expansion() {
        assert_eq!(expand_env_vars("C:\\100%"), "C:\\100%");
        assert_eq!(expand_env_vars("sin variables"), "sin variables");
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
