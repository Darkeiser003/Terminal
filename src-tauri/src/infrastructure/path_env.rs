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

// Una auditoría completa puede consultar cientos de acciones durante más de
// cinco segundos. Mantener las búsquedas del PATH durante un minuto evita que
// el mismo ejecutable vuelva a inspeccionarse cuando la pasada cruza ese
// umbral; las operaciones que cambian el PATH llaman a `clear_which_cache`.
const WHICH_CACHE_MS: Duration = Duration::from_secs(60);

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

/// El PATH con el que WTerminal busca y lanza programas: el del proceso con
/// las carpetas de las herramientas centralizadas delante (ver
/// `config::toolchain_store`).
fn current_path() -> String {
    process::path_with_extra(&std::env::var("PATH").unwrap_or_default())
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

    let value = crate::platform::host()
        .find_executable(cmd, &path_value)
        .or_else(|| known_install_location(cmd));

    WHICH_CACHE.lock().insert(
        cache_key,
        CacheEntry {
            at: Instant::now(),
            value: value.clone(),
        },
    );
    value
}

/// Herramientas que suelen instalarse FUERA del PATH. La CLI de Claude Code
/// que trae la app de escritorio de Claude vive en
/// `%APPDATA%\Claude\claude-code\<versión>\<hash>\claude.exe` (cambia con
/// cada actualización y nunca entra en el PATH), y el instalador nativo deja
/// `~/.local/bin/claude(.exe)` sin tocar el PATH de los procesos ya abiertos.
fn known_install_location(cmd: &str) -> Option<PathBuf> {
    let windows = cfg!(windows);
    // Solo E2E: una carpeta con `home/` y `roaming/` simulados, para probar la
    // detección sin abrir el Claude Code real del equipo de pruebas.
    if let Some(root) = e2e_known_locations_root() {
        return known_install_location_in(
            cmd,
            windows,
            &root.join("home"),
            Some(&root.join("roaming")),
        );
    }
    let home = crate::paths::home_dir();
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    known_install_location_in(cmd, windows, &home, roaming.as_deref())
}

fn e2e_known_locations_root() -> Option<PathBuf> {
    if std::env::var("LTERMINAL_E2E_TESTING").as_deref() != Ok("1") {
        return None;
    }
    std::env::var_os("LTERMINAL_E2E_KNOWN_LOCATIONS_ROOT")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn known_install_location_in(
    cmd: &str,
    windows: bool,
    home: &std::path::Path,
    roaming: Option<&std::path::Path>,
) -> Option<PathBuf> {
    if cmd != "claude" {
        return None;
    }
    let mut candidates = Vec::new();
    if windows {
        candidates.push(home.join(".local").join("bin").join("claude.exe"));
        if let Some(roaming) = roaming {
            candidates.push(roaming.join("npm").join("claude.cmd"));
            candidates.extend(desktop_bundled_claude(
                &roaming.join("Claude").join("claude-code"),
            ));
        }
    } else {
        candidates.push(home.join(".local").join("bin").join("claude"));
        candidates.push(home.join(".claude").join("local").join("claude"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// `claude.exe` de la versión más reciente que trae la app de escritorio
/// (`<raíz>\<x.y.z>\<hash>\claude.exe`), comparando las versiones por número.
fn desktop_bundled_claude(root: &std::path::Path) -> Option<PathBuf> {
    let version_key = |name: &str| -> Option<Vec<u64>> {
        name.split('.').map(|part| part.parse().ok()).collect()
    };
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let key = version_key(&entry.file_name().to_string_lossy())?;
            Some((key, entry.path()))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().find_map(|(_, dir)| {
        let builds: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("claude.exe"))
            .filter(|exe| exe.is_file())
            .map(|exe| {
                let modified = std::fs::metadata(&exe)
                    .and_then(|meta| meta.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                (modified, exe)
            })
            .collect();
        builds
            .into_iter()
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, exe)| exe)
    })
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
    match which(cmd) {
        Some(path) => !launcher_interpreter_missing(&path),
        None => false,
    }
}

/// Intérprete que invoca un lanzador `.bat`/`.cmd` sencillo, como los que
/// deja RubyGems (`@ruby.exe "%~dpn0" %*`). `None` si el script hace algo más
/// que llamar directamente a un `.exe`: entonces no se puede saber sin
/// ejecutarlo y el lanzador se da por bueno.
fn simple_launcher_interpreter(content: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim().trim_start_matches('@').trim();
        let lower = line.to_ascii_lowercase();
        if line.is_empty()
            || lower == "echo off"
            || lower.starts_with("rem ")
            || line.starts_with("::")
        {
            continue;
        }
        let token = match line.strip_prefix('"') {
            Some(rest) => rest.split('"').next()?,
            None => line.split_whitespace().next()?,
        };
        return token
            .to_ascii_lowercase()
            .ends_with(".exe")
            .then(|| token.to_string());
    }
    None
}

/// `true` si `launcher` es un `.bat`/`.cmd` sencillo cuyo intérprete ya no
/// existe. Al desinstalar Ruby quedaban en `WindowsApps` los lanzadores de
/// RubyGems (`irb.bat`, `rails.bat`…): el PATH los seguía encontrando, la app
/// ofrecía el REPL de Ruby y la pestaña se quedaba en blanco al abrirlo.
fn launcher_interpreter_missing(launcher: &std::path::Path) -> bool {
    let is_script = launcher
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("cmd"));
    if !is_script {
        return false;
    }
    // Solo los lanzadores diminutos: un script grande hace su propia lógica.
    if std::fs::metadata(launcher).map_or(true, |meta| meta.len() > 4096) {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(launcher) else {
        return false;
    };
    let Some(interpreter) = simple_launcher_interpreter(&content) else {
        return false;
    };
    let directory = launcher
        .parent()
        .map(|dir| format!("{}\\", dir.display()))
        .unwrap_or_default();
    let expanded = interpreter
        .replace("%~dp0", &directory)
        .replace("%~DP0", &directory);
    if expanded.contains('%') {
        // Otras variables solo se resuelven al ejecutar el script.
        return false;
    }
    if expanded.contains('\\') || expanded.contains('/') {
        return !std::path::Path::new(&expanded).exists();
    }
    which(&expanded).is_none()
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
    fn reconoce_el_interprete_de_un_lanzador_sencillo() {
        // Lanzador de RubyGems.
        assert_eq!(
            simple_launcher_interpreter("@ECHO OFF\r\n@ruby.exe \"%~dpn0\" %*\r\n").as_deref(),
            Some("ruby.exe")
        );
        // Ruta entre comillas, relativa al propio script.
        assert_eq!(
            simple_launcher_interpreter(
                "@echo off\n:: comentario\n\"%~dp0bin\\node.exe\" app.js %*\n"
            )
            .as_deref(),
            Some("%~dp0bin\\node.exe")
        );
        // Un shim con lógica propia (como los de npm) no se interpreta.
        assert_eq!(
            simple_launcher_interpreter("@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\n")
                .as_deref(),
            None
        );
        assert_eq!(simple_launcher_interpreter("@ECHO OFF\n").as_deref(), None);
    }

    #[test]
    fn un_lanzador_cuyo_interprete_falta_no_cuenta_como_instalado() {
        let dir = std::env::temp_dir().join(format!("wterminal-launcher-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let broken = dir.join("irb.bat");
        std::fs::write(
            &broken,
            "@ECHO OFF\r\n@interprete-que-no-existe-en-ningun-sistema.exe \"%~dpn0\" %*\r\n",
        )
        .unwrap();
        assert!(launcher_interpreter_missing(&broken));

        let interpreter = dir.join("real.exe");
        std::fs::write(&interpreter, b"MZ").unwrap();
        let working = dir.join("ok.cmd");
        std::fs::write(&working, "@\"%~dp0real.exe\" %*\r\n").unwrap();
        assert!(!launcher_interpreter_missing(&working));

        // Un ejecutable real o un script con lógica propia nunca se descartan.
        assert!(!launcher_interpreter_missing(&interpreter));
        let complex = dir.join("npm-like.cmd");
        std::fs::write(
            &complex,
            "@ECHO off\r\nGOTO start\r\n:start\r\nSET _prog=node\r\n",
        )
        .unwrap();
        assert!(!launcher_interpreter_missing(&complex));
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    #[test]
    fn claude_code_se_encuentra_fuera_del_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let roaming = dir.path().join("roaming");
        let bundled = roaming.join("Claude").join("claude-code");
        // Sin nada instalado no aparece.
        assert_eq!(
            known_install_location_in("claude", true, &home, Some(&roaming)),
            None
        );
        // La app de escritorio: gana la versión mayor comparada por número
        // (2.1.295 > 2.1.30), no por orden alfabético.
        for (version, hash) in [
            ("2.1.30", "aaaa"),
            ("2.1.295", "d2e29494ec83"),
            ("notas", "x"),
        ] {
            let exe = bundled.join(version).join(hash).join("claude.exe");
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(&exe, "").unwrap();
        }
        assert_eq!(
            known_install_location_in("claude", true, &home, Some(&roaming)),
            Some(
                bundled
                    .join("2.1.295")
                    .join("d2e29494ec83")
                    .join("claude.exe")
            )
        );
        // npm y el instalador nativo tienen preferencia sobre la copia de la app.
        let npm = roaming.join("npm").join("claude.cmd");
        std::fs::create_dir_all(npm.parent().unwrap()).unwrap();
        std::fs::write(&npm, "").unwrap();
        assert_eq!(
            known_install_location_in("claude", true, &home, Some(&roaming)),
            Some(npm)
        );
        let native = home.join(".local").join("bin").join("claude.exe");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "").unwrap();
        assert_eq!(
            known_install_location_in("claude", true, &home, Some(&roaming)),
            Some(native)
        );
        // Otras herramientas no se buscan fuera del PATH.
        assert_eq!(
            known_install_location_in("gemini", true, &home, Some(&roaming)),
            None
        );
        // Linux/macOS: instalador nativo o la instalación local antigua.
        let local = home.join(".claude").join("local").join("claude");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, "").unwrap();
        assert_eq!(
            known_install_location_in("claude", false, &home, None),
            Some(local)
        );
    }
}
