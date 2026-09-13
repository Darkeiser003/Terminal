//! Logger simple a archivo, sin dependencias externas de logging.
//! Escribe en `<userData>/logs/main.log` con rotación por tamaño.
//!
//! Port de `electron/main/logger.js`. Se conserva el formato de línea exacto
//! para que los logs de la versión Electron y los de esta se puedan leer con
//! las mismas herramientas.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::paths;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024; // 2 MB por archivo antes de rotar

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }

    fn parse(value: &str) -> Option<Level> {
        match value {
            "error" => Some(Level::Error),
            "warn" => Some(Level::Warn),
            "info" => Some(Level::Info),
            "debug" => Some(Level::Debug),
            _ => None,
        }
    }
}

static CURRENT_LEVEL: Lazy<Level> = Lazy::new(|| {
    std::env::var("LTERMINAL_LOG_LEVEL")
        .or_else(|_| std::env::var("WINSLIM_LOG_LEVEL"))
        .ok()
        .and_then(|value| Level::parse(value.trim()))
        .unwrap_or(Level::Info)
});

/// Id corto que identifica esta ejecución de la app dentro del archivo de log
/// (que es acumulativo entre arranques): sirve para distinguir de un vistazo
/// dónde empieza y termina cada sesión.
pub static SESSION_ID: Lazy<String> = Lazy::new(|| {
    let millis = chrono::Utc::now().timestamp_millis().unsigned_abs();
    let base36 = to_base36(millis);
    base36[base36.len().saturating_sub(6)..].to_string()
});

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 es ascii")
}

// La ruta y el handle se resuelven una vez. Abrir y cerrar main.log en cada
// línea hacía que el antivirus participara varias veces en el arranque.
#[derive(Default)]
struct LogState {
    path: Option<PathBuf>,
    handle: Option<File>,
    len: u64,
}

static LOG_STATE: Lazy<Mutex<LogState>> = Lazy::new(|| Mutex::new(LogState::default()));

fn resolve_log_file(state: &mut LogState) -> Option<PathBuf> {
    if let Some(existing) = &state.path {
        return Some(existing.clone());
    }
    // Los builds y los E2E pueden fijar una ruta por ejecución para no leer un
    // log acumulado de otra instalación. En uso normal no existe esta
    // variable y se mantiene la ruta estable de usuario.
    let file = std::env::var_os("LTERMINAL_LOG_FILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths::user_data_dir().join("logs").join("main.log"));
    let dir = file.parent()?;
    fs::create_dir_all(dir).ok()?;
    state.path = Some(file.clone());
    Some(file)
}

pub fn log_dir() -> Option<PathBuf> {
    let mut state = LOG_STATE.lock();
    resolve_log_file(&mut state).and_then(|file| file.parent().map(PathBuf::from))
}

fn open_log(state: &mut LogState, file: &PathBuf) -> Option<()> {
    if state.handle.is_some() {
        return Some(());
    }
    state.len = fs::metadata(file).map(|meta| meta.len()).unwrap_or(0);
    state.handle = OpenOptions::new().create(true).append(true).open(file).ok();
    state.handle.as_ref().map(|_| ())
}

fn rotate_if_needed(state: &mut LogState, file: &PathBuf) {
    if state.len > MAX_LOG_BYTES {
        // Hay que soltar el handle antes del rename, especialmente en Windows.
        state.handle = None;
        let rotated = file.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(file, &rotated);
        state.len = 0;
    }
}

fn append(line: &str) {
    let mut state = LOG_STATE.lock();
    let Some(file) = resolve_log_file(&mut state) else {
        return;
    };
    if open_log(&mut state, &file).is_none() {
        return;
    }
    rotate_if_needed(&mut state, &file);
    if open_log(&mut state, &file).is_none() {
        return;
    }
    // Si el disco falla, el logging no debe tumbar la app; se ignora.
    if let Some(handle) = &mut state.handle {
        if handle.write_all(line.as_bytes()).is_ok() {
            state.len = state.len.saturating_add(line.len() as u64);
        }
    }
}

fn timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

pub fn write(level: Level, message: &str, meta: Option<serde_json::Value>) {
    if level > *CURRENT_LEVEL {
        return;
    }
    let meta_str = meta
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| value.to_string()))
        .unwrap_or_default();
    let line = format!(
        "[{}] [{}] [{}] {}{}\n",
        timestamp(),
        *SESSION_ID,
        level.label(),
        message,
        if meta_str.is_empty() {
            String::new()
        } else {
            format!(" {meta_str}")
        }
    );
    append(&line);

    if cfg!(debug_assertions) {
        let trimmed = line.trim_end();
        if level == Level::Error || level == Level::Warn {
            eprintln!("{trimmed}");
        } else {
            println!("{trimmed}");
        }
    }
}

/// Banner visual (varias líneas separadas por "====") para los eventos que más
/// importa poder ubicar de un vistazo al ojear el archivo: arranque y cierre de
/// la app, sobre todo. No es un nivel de log distinto, es "info" con formato
/// especial.
pub fn banner(title: &str, meta: Option<serde_json::Value>) {
    let bar = "=".repeat(std::cmp::max(20, title.chars().count() + 8));
    let meta_str = meta
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| value.to_string()))
        .unwrap_or_default();
    let suffix = if meta_str.is_empty() {
        String::new()
    } else {
        format!(" {meta_str}")
    };
    append(&format!(
        "\n{bar}\n[{}] [{}] {title}{suffix}\n{bar}\n",
        timestamp(),
        *SESSION_ID
    ));
    if cfg!(debug_assertions) {
        println!("\n{bar}\n{title}{suffix}\n{bar}");
    }
}

// Atajos de uso: `log_info!("mensaje")` o
// `log_info!("mensaje", serde_json::json!({ "clave": 1 }))`. El segundo
// argumento es el equivalente al objeto `meta` de la versión Electron.

#[macro_export]
macro_rules! log_error {
    ($msg:expr) => {
        $crate::logger::write($crate::logger::Level::Error, $msg, None)
    };
    ($msg:expr, $meta:expr) => {
        $crate::logger::write($crate::logger::Level::Error, $msg, Some($meta))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($msg:expr) => {
        $crate::logger::write($crate::logger::Level::Warn, $msg, None)
    };
    ($msg:expr, $meta:expr) => {
        $crate::logger::write($crate::logger::Level::Warn, $msg, Some($meta))
    };
}

#[macro_export]
macro_rules! log_info {
    ($msg:expr) => {
        $crate::logger::write($crate::logger::Level::Info, $msg, None)
    };
    ($msg:expr, $meta:expr) => {
        $crate::logger::write($crate::logger::Level::Info, $msg, Some($meta))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($msg:expr) => {
        $crate::logger::write($crate::logger::Level::Debug, $msg, None)
    };
    ($msg:expr, $meta:expr) => {
        $crate::logger::write($crate::logger::Level::Debug, $msg, Some($meta))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_id_de_sesion_son_seis_caracteres_base36() {
        assert_eq!(SESSION_ID.len(), 6);
        assert!(SESSION_ID.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn base36_coincide_con_number_tostring_36() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        assert_eq!(to_base36(1_700_000_000_000), "loyw3v28");
    }

    #[test]
    fn los_niveles_se_ordenan_de_error_a_debug() {
        assert!(Level::Error < Level::Debug);
        assert_eq!(Level::parse("warn"), Some(Level::Warn));
        assert_eq!(Level::parse("verbose"), None);
    }
}
