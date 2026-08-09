//! Búsqueda de scripts en una carpeta.
//!
//! Port de la parte de `electron/main/scriptLauncher.js` que recorre el disco:
//! `readShebang`, `walkScripts`, `listScripts` y `listAllScripts`.
//!
//! Dos ámbitos con reglas distintas:
//!   - **Biblioteca**: una carpeta que el usuario eligió a propósito. Se
//!     recorre entera hasta la profundidad pedida y no se descarta nada.
//!   - **Aquí**: el directorio de trabajo de la pestaña, que puede ser
//!     cualquier proyecto. Ahí se esquivan los árboles de dependencias, se
//!     exige que un script de runtime parezca ejecutable de verdad, y el
//!     recorrido tiene topes de tiempo, de carpetas y de resultados.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::types::{
    interpreter_for_ext, resource_type_for_ext, script_type_for_ext, FileCategory, ScriptType,
};

pub const MAX_HERE_SCRIPTS: usize = 500;
pub const DEFAULT_HERE_DEPTH: u32 = 3;
pub const MIN_HERE_DEPTH: u32 = 0;
pub const MAX_HERE_DEPTH: u32 = 10;
const MAX_HERE_DIRECTORIES: usize = 5000;
const MAX_HERE_SCAN: Duration = Duration::from_millis(3000);

/// Árboles que contienen código/dependencias, no scripts del proyecto. Esta
/// exclusión solo se aplica al ámbito «Aquí»; la Biblioteca sigue siendo una
/// carpeta elegida explícitamente por el usuario.
#[rustfmt::skip]
const HERE_IGNORED_DIRS: &[&str] = &[
    "node_modules", "bower_components", "vendor",
    ".git", ".hg", ".svn", ".yarn", ".pnpm-store",
    ".next", ".nuxt", ".svelte-kit", ".cache", ".parcel-cache",
    "coverage", "dist", "out", "build", "target",
    ".venv", "venv", "__pycache__", "site-packages",
];

/// Tipos que en un proyecto cualquiera son casi siempre código fuente, no algo
/// que se quiera lanzar. Para ofrecerlos en «Aquí» tienen que dar alguna señal
/// de que son ejecutables.
const RUNTIME_SCRIPT_TYPES: &[ScriptType] = &[
    ScriptType::Node,
    ScriptType::Python,
    ScriptType::Ruby,
    ScriptType::Php,
    ScriptType::Perl,
    ScriptType::Lua,
    ScriptType::Rscript,
    ScriptType::Groovy,
];

/// Carpetas cuyo nombre ya dice que lo que hay dentro son herramientas.
#[rustfmt::skip]
const RUNTIME_SCRIPT_DIRS: &[&str] = &[
    "script", "scripts", "bin", "tool", "tools", "tooling",
    "task", "tasks", "command", "commands", "cli", "hooks",
];

/// Fuentes fijas de "comandos importados" además de la carpeta de scripts del
/// usuario: las utilidades VBS del propio sistema WinSlim, si existen en esta
/// máquina (son específicas del SO personalizado del autor, opcionales para
/// cualquier otro usuario de la app).
#[rustfmt::skip]
pub const WINSLIM_VBS_SOURCES: &[(&str, &str)] = &[
    (r"C:\WSCore\Components\Hooks\WinSlimToolbox", "WinSlim Toolbox"),
    (r"C:\WSCore\Components\Hooks\EXEfinder", "EXEfinder"),
];

pub const NSUDO_PATH: &str = r"C:\WSCore\Components\Hooks\NSudo\NSudoLC.exe";

pub fn nsudo_available() -> bool {
    cfg!(windows) && Path::new(NSUDO_PATH).is_file()
}

/// Scripts VBS conocidos como sensibles: no se excluyen (el usuario decidió
/// importarlos), pero se marcan con una advertencia visible antes de usarlos.
#[rustfmt::skip]
const SENSITIVE_SCRIPT_HINTS: &[(&str, &str)] = &[
    ("winslim_defender_off.vbs", "⚠️ Desactiva Windows Defender de forma silenciosa."),
    ("winslim_disk_formatter.vbs", "⚠️ Herramienta de formateo de disco. Revisa qué unidad afecta antes de usarla."),
    ("winslim_takeownership.vbs", "⚠️ Cambia el propietario/permisos de archivos o carpetas."),
    ("winslim_unlocker.vbs", "⚠️ Fuerza el desbloqueo/borrado de archivos en uso."),
    ("winslim_lock_file.vbs", "Bloquea archivos para que no puedan borrarse ni modificarse."),
    ("winslim_ram_cleaner.vbs", "Libera RAM de forma agresiva; puede cerrar procesos en segundo plano."),
    ("winslim_ultra_cachecleaner.vbs", "Borra cachés del sistema de forma agresiva."),
    ("winslim_disk_formatter", "⚠️ Herramienta de formateo de disco."),
];

fn sensitive_hint(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    SENSITIVE_SCRIPT_HINTS
        .iter()
        .find(|(candidate, _)| *candidate == lower)
        .map(|(_, hint)| *hint)
}

pub fn normalize_here_depth(value: Option<i64>, fallback: u32) -> u32 {
    match value {
        None => fallback,
        Some(value) => (value.max(MIN_HERE_DEPTH as i64) as u32).min(MAX_HERE_DEPTH),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub name: String,
    pub ext: String,
    #[serde(rename = "type")]
    pub kind: ScriptType,
    pub category: FileCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpreter: Option<String>,
    pub runnable: bool,
    pub openable: bool,
    pub instruction: &'static str,
    pub path: String,
    /// Subcarpeta relativa a la raíz escaneada: es lo que permite agrupar el
    /// panel por carpetas en vez de volcar una lista plana enorme.
    pub rel_dir: String,
    /// De dónde viene: la carpeta del usuario o una fuente importada.
    pub source: String,
    /// Aviso para los scripts sensibles conocidos.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    /// Se alcanzó el tope de carpetas visitadas.
    Directories,
    /// Se agotó el plazo de escaneo.
    Time,
    /// Se alcanzó el tope de resultados.
    Results,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub depth: u32,
    pub visited_directories: usize,
    /// Carpetas que no se pudieron leer (permisos, unidad desconectada).
    pub skipped_directories: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scripts: Vec<ScriptEntry>,
    pub info: ScanInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Library,
    Here,
}

struct Walk<'a> {
    scope: Scope,
    categories: &'a [FileCategory],
    max_results: usize,
    max_directories: usize,
    deadline: Option<Instant>,
    visited: usize,
    skipped: usize,
    stop: Option<StopReason>,
    declared_bins: HashSet<String>,
    root: PathBuf,
    source: String,
}

/// Lee el shebang de un archivo para saber con qué se ejecuta. Solo se miran
/// los primeros 256 bytes: la primera línea siempre cabe.
fn read_shebang(full_path: &Path) -> Option<(ScriptType, &'static str)> {
    let mut file = std::fs::File::open(full_path).ok()?;
    let mut buffer = [0u8; 256];
    let read = file.read(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer[..read]);
    let first_line = text.lines().next()?;
    if !first_line.starts_with("#!") {
        return None;
    }
    let lower = first_line.to_lowercase();

    // El orden importa: "bash" contiene "sh", así que las variantes largas van
    // antes que las cortas.
    // `versioned` marca los intérpretes que admiten un número de versión
    // pegado al nombre: `python3` es python, pero `sh2` no sería sh.
    #[rustfmt::skip]
    const CANDIDATES: &[(&str, ScriptType, &str, bool)] = &[
        ("pwsh", ScriptType::Powershell, "powershell", false),
        ("powershell", ScriptType::Powershell, "powershell", false),
        ("fish", ScriptType::Fish, "fish", false),
        ("zsh", ScriptType::Shell, "zsh", false),
        ("ksh", ScriptType::Shell, "ksh", false),
        ("bash", ScriptType::Shell, "bash", false),
        ("sh", ScriptType::Shell, "sh", false),
        ("python", ScriptType::Python, "python", true),
        ("node", ScriptType::Node, "node", false),
        ("ruby", ScriptType::Ruby, "ruby", false),
        ("php", ScriptType::Php, "php", false),
        ("perl", ScriptType::Perl, "perl", false),
        ("lua", ScriptType::Lua, "lua", false),
        ("rscript", ScriptType::Rscript, "Rscript", false),
        ("groovy", ScriptType::Groovy, "groovy", false),
    ];

    for (needle, kind, interpreter, versioned) in CANDIDATES {
        if contains_word(&lower, needle, *versioned) {
            return Some((*kind, interpreter));
        }
    }
    None
}

/// `\bpalabra(?:\s|$)` del original: la palabra tiene que empezar en un límite
/// y terminar en espacio o final de línea, para que `/usr/bin/bash` cuente y
/// `bashful` no.
///
/// Con `versioned`, se admite además un número pegado detrás
/// (`\bpython(?:2|3)?(?:\s|$)`), que es como se escribe casi siempre el shebang
/// de Python.
fn contains_word(haystack: &str, needle: &str, versioned: bool) -> bool {
    let mut from = 0;
    while let Some(found) = haystack[from..].find(needle) {
        let start = from + found;
        let mut end = start + needle.len();
        let before_ok = start == 0
            || !haystack[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_');
        if versioned {
            while haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
            {
                end += 1;
            }
        }
        // Sin `is_none_or`, que exige una versión de Rust más alta que la
        // declarada como mínima en Cargo.toml.
        let after_ok = match haystack[end..].chars().next() {
            None => true,
            Some(c) => c.is_whitespace(),
        };
        if before_ok && after_ok {
            return true;
        }
        from = start + needle.len();
    }
    false
}

/// Los binarios que un `package.json` declara: en «Aquí», un `.js` listado en
/// `bin` es una herramienta aunque no tenga shebang ni bit de ejecución.
fn declared_bin_paths(root: &Path) -> HashSet<String> {
    let mut result = HashSet::new();
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
        return result;
    };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&text) else {
        return result;
    };
    let values: Vec<String> = match package.get("bin") {
        Some(serde_json::Value::String(single)) => vec![single.clone()],
        Some(serde_json::Value::Object(map)) => map
            .values()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    for value in values {
        result.insert(normalized_key(&root.join(value)));
    }
    result
}

fn normalized_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

fn is_ignored_here_directory(name: &str) -> bool {
    let lower = name.to_lowercase();
    HERE_IGNORED_DIRS.contains(&lower.as_str())
        || lower.starts_with("dist-")
        || lower.starts_with("build-")
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(_path: &Path) -> bool {
    // Windows no tiene bit de ejecución: lo que decide es la extensión, que ya
    // se ha mirado antes de llegar aquí.
    false
}

/// En «Aquí», un script de runtime solo se ofrece si parece pensado para
/// lanzarse: trae shebang, tiene el bit de ejecución, está declarado en
/// `package.json` o vive en una carpeta de herramientas.
fn has_runtime_script_intent(
    full: &Path,
    root: &Path,
    kind: ScriptType,
    has_shebang: bool,
    declared_bins: &HashSet<String>,
) -> bool {
    if !RUNTIME_SCRIPT_TYPES.contains(&kind) || has_shebang || is_executable_file(full) {
        return true;
    }
    if declared_bins.contains(&normalized_key(full)) {
        return true;
    }
    let Some(parent) = full.parent() else {
        return false;
    };
    relative_segments(root, parent)
        .iter()
        .any(|segment| RUNTIME_SCRIPT_DIRS.contains(&segment.as_str()))
}

fn relative_segments(root: &Path, dir: &Path) -> Vec<String> {
    dir.strip_prefix(root)
        .unwrap_or(dir)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        // Un archivo que empieza por punto (.gitignore) no tiene extensión.
        Some(0) | None => String::new(),
        Some(index) => name[index..].to_lowercase(),
    }
}

struct Descriptor {
    kind: ScriptType,
    interpreter: Option<String>,
    has_shebang: bool,
}

fn describe(full: &Path, name: &str, ext: &str, categories: &[FileCategory]) -> Option<Descriptor> {
    let declared = script_type_for_ext(ext);
    // Los archivos con extensión no reconocida son código/datos, no
    // candidatos. Solo los que no tienen extensión pueden depender
    // exclusivamente de un shebang.
    let shebang = if declared.is_some() || ext.is_empty() {
        read_shebang(full)
    } else {
        None
    };

    if let Some(kind) = declared.or(shebang.map(|(kind, _)| kind)) {
        return Some(Descriptor {
            kind,
            interpreter: shebang
                .map(|(_, bin)| bin.to_string())
                .or_else(|| interpreter_for_ext(ext).map(str::to_string)),
            has_shebang: shebang.is_some(),
        });
    }
    if let Some(kind) = resource_type_for_ext(ext) {
        return Some(Descriptor {
            kind,
            interpreter: (kind == ScriptType::Java).then(|| "java".to_string()),
            has_shebang: false,
        });
    }
    // Un archivo sin extensión y con el bit de ejecución es un programa, pero
    // solo se ofrece si el panel tiene marcada esa categoría: en una carpeta
    // Unix cualquiera habría cientos.
    if ext.is_empty() && categories.contains(&FileCategory::Program) && is_executable_file(full) {
        let _ = name;
        return Some(Descriptor {
            kind: ScriptType::Program,
            interpreter: None,
            has_shebang: false,
        });
    }
    None
}

fn walk(
    dir: &Path,
    depth: u32,
    max_depth: u32,
    results: &mut Vec<ScriptEntry>,
    walk: &mut Walk<'_>,
) {
    if depth > max_depth || results.len() >= walk.max_results || walk.stop.is_some() {
        return;
    }
    if walk.scope == Scope::Here {
        if walk.visited >= walk.max_directories {
            walk.stop = Some(StopReason::Directories);
            return;
        }
        if walk
            .deadline
            .is_some_and(|deadline| Instant::now() > deadline)
        {
            walk.stop = Some(StopReason::Time);
            return;
        }
        walk.visited += 1;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        if walk.scope == Scope::Here {
            walk.skipped += 1;
        }
        return;
    };

    let mut children: Vec<PathBuf> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        if results.len() >= walk.max_results {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // No se siguen enlaces simbólicos ni junctions: evita bucles infinitos.
        if file_type.is_symlink() {
            continue;
        }
        let full = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if file_type.is_dir() {
            if walk.scope == Scope::Here && is_ignored_here_directory(&name) {
                continue;
            }
            children.push(full);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let ext = extension_of(&name);
        let Some(descriptor) = describe(&full, &name, &ext, walk.categories) else {
            continue;
        };
        let category = descriptor.kind.category();
        if !walk.categories.contains(&category) {
            continue;
        }
        if walk.scope == Scope::Here
            && !has_runtime_script_intent(
                &full,
                &walk.root,
                descriptor.kind,
                descriptor.has_shebang,
                &walk.declared_bins,
            )
        {
            continue;
        }

        let rel_dir = dir
            .strip_prefix(&walk.root)
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");
        results.push(ScriptEntry {
            hint: sensitive_hint(&name),
            name,
            ext,
            kind: descriptor.kind,
            category,
            interpreter: descriptor.interpreter,
            runnable: descriptor.kind.runnable(),
            openable: descriptor.kind.openable(),
            instruction: descriptor.kind.instruction(),
            path: full.to_string_lossy().to_string(),
            rel_dir,
            source: walk.source.clone(),
        });
    }

    for child in children {
        walk_recurse(&child, depth + 1, max_depth, results, walk);
    }
}

fn walk_recurse(
    dir: &Path,
    depth: u32,
    max_depth: u32,
    results: &mut Vec<ScriptEntry>,
    state: &mut Walk<'_>,
) {
    walk(dir, depth, max_depth, results, state);
}

pub struct ScanOptions<'a> {
    pub scope: Scope,
    pub categories: &'a [FileCategory],
    pub max_depth: u32,
    pub source: String,
}

/// Lista los scripts reconocibles de una carpeta.
pub fn list_scripts(dir: &Path, options: &ScanOptions<'_>) -> ScanResult {
    let here = options.scope == Scope::Here;
    let mut state = Walk {
        scope: options.scope,
        categories: options.categories,
        max_results: if here { MAX_HERE_SCRIPTS } else { usize::MAX },
        max_directories: if here {
            MAX_HERE_DIRECTORIES
        } else {
            usize::MAX
        },
        deadline: here.then(|| Instant::now() + MAX_HERE_SCAN),
        visited: 0,
        skipped: 0,
        stop: None,
        declared_bins: if here {
            declared_bin_paths(dir)
        } else {
            HashSet::new()
        },
        root: dir.to_path_buf(),
        source: options.source.clone(),
    };

    let mut results = Vec::new();
    walk(dir, 0, options.max_depth, &mut results, &mut state);
    results.sort_by_key(|script| script.name.to_lowercase());

    let stop_reason = state.stop.or_else(|| {
        (results.len() >= state.max_results && state.max_results != usize::MAX)
            .then_some(StopReason::Results)
    });
    ScanResult {
        scripts: results,
        info: ScanInfo {
            depth: options.max_depth,
            visited_directories: state.visited,
            skipped_directories: state.skipped,
            stop_reason,
        },
    }
}

/// Describe UN archivo suelto, sin escanear su carpeta.
///
/// Es lo que necesitan los scripts anclados: se guardan por ruta, y al abrir el
/// panel hay que reconstruir su entrada sin recorrer la biblioteca entera.
/// `None` si el archivo ya no está o no es algo que la app sepa lanzar.
///
/// `rel_dir` sale del nombre de su carpeta y no de una raíz escaneada, que aquí
/// no existe: es lo que permite seguir agrupando los anclados por carpeta.
pub fn describe_path(path: &Path) -> Option<ScriptEntry> {
    if !path.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    let ext = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    // Todas las categorías: un anclado no debe desaparecer porque el filtro
    // activo del panel no incluya su tipo.
    let categories = crate::scripts::types::all_categories();
    let descriptor = describe(path, &name, &ext, &categories)?;
    let source = source_for(path);
    Some(ScriptEntry {
        hint: sensitive_hint(&name),
        name,
        ext,
        kind: descriptor.kind,
        category: descriptor.kind.category(),
        interpreter: descriptor.interpreter,
        runnable: descriptor.kind.runnable(),
        openable: descriptor.kind.openable(),
        instruction: descriptor.kind.instruction(),
        path: path.to_string_lossy().to_string(),
        rel_dir: path
            .parent()
            .and_then(|dir| dir.file_name())
            .map(|nombre| nombre.to_string_lossy().to_string())
            .unwrap_or_default(),
        source,
    })
}

/// De qué fuente viene un archivo, para etiquetarlo igual que en el escaneo.
fn source_for(path: &Path) -> String {
    let ruta = path.to_string_lossy().to_lowercase().replace('\\', "/");
    for (dir, etiqueta) in WINSLIM_VBS_SOURCES {
        if ruta.starts_with(&dir.to_lowercase().replace('\\', "/")) {
            return (*etiqueta).to_string();
        }
    }
    "Scripts".to_string()
}

/// Junta la carpeta de scripts del usuario con las fuentes VBS de WinSlim (si
/// existen en esta máquina). Cada entrada queda etiquetada con su `source` y,
/// si es una de las sensibles conocidas, con un `hint` de aviso.
pub fn list_all_scripts(user_scripts_dir: &Path, categories: &[FileCategory]) -> Vec<ScriptEntry> {
    let mut all = list_scripts(
        user_scripts_dir,
        &ScanOptions {
            scope: Scope::Library,
            categories,
            max_depth: DEFAULT_HERE_DEPTH,
            source: "scripts".to_string(),
        },
    )
    .scripts;

    if cfg!(windows) {
        for (dir, source) in WINSLIM_VBS_SOURCES {
            let found = list_scripts(
                Path::new(dir),
                &ScanOptions {
                    scope: Scope::Library,
                    categories,
                    // Las utilidades de WinSlim están todas en la raíz de su
                    // carpeta: no hay que bajar.
                    max_depth: 0,
                    source: source.to_string(),
                },
            );
            all.extend(found.scripts);
        }
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        std::fs::File::create(&file)
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
        file
    }

    fn library(dir: &Path) -> Vec<ScriptEntry> {
        list_scripts(
            dir,
            &ScanOptions {
                scope: Scope::Library,
                categories: &super::super::types::default_categories(),
                max_depth: DEFAULT_HERE_DEPTH,
                source: "scripts".into(),
            },
        )
        .scripts
    }

    #[test]
    fn se_reconocen_los_scripts_por_extension() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "uno.ps1", "");
        write(dir.path(), "dos.sh", "");
        write(dir.path(), "notas.txt", "");

        let found = library(dir.path());
        let nombres: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(nombres, vec!["dos.sh", "uno.ps1"]);
        assert_eq!(found[1].kind, ScriptType::Powershell);
        assert_eq!(found[0].interpreter.as_deref(), Some("sh"));
    }

    #[test]
    fn un_archivo_sin_extension_depende_de_su_shebang() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "desplegar", "#!/usr/bin/env bash\necho hola\n");
        write(dir.path(), "datos", "solo texto\n");

        let found = library(dir.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "desplegar");
        assert_eq!(found[0].kind, ScriptType::Shell);
        assert_eq!(found[0].interpreter.as_deref(), Some("bash"));
    }

    #[test]
    fn el_shebang_manda_sobre_el_interprete_por_defecto_de_la_extension() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "raro.sh", "#!/usr/bin/zsh\n");
        let found = library(dir.path());
        assert_eq!(found[0].interpreter.as_deref(), Some("zsh"));
    }

    #[test]
    fn una_palabra_del_shebang_no_coincide_a_medias() {
        assert!(contains_word("#!/bin/bash", "bash", false));
        assert!(!contains_word("#!/bin/bashful", "bash", false));
        assert!(!contains_word("#!/bin/shell", "sh", false));
    }

    #[test]
    fn el_shebang_de_python_admite_su_numero_de_version() {
        assert!(contains_word("#!/usr/bin/env python3 -u", "python", true));
        assert!(contains_word("#!/usr/bin/python", "python", true));
        // Sin permiso de versión, el número lo invalida.
        assert!(!contains_word("#!/usr/bin/python3", "python", false));
        // Y el permiso no llega hasta convertir cualquier sufijo en válido.
        assert!(!contains_word("#!/usr/bin/pythonista", "python", true));
    }

    #[test]
    fn se_baja_por_las_subcarpetas_hasta_la_profundidad_pedida() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a"), "hondo.sh", "");
        write(
            &dir.path().join("a").join("b").join("c").join("d"),
            "muy-hondo.sh",
            "",
        );

        let found = library(dir.path());
        let nombres: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(nombres, vec!["hondo.sh"]);
        assert_eq!(found[0].rel_dir, "a");
    }

    #[test]
    fn los_recursos_solo_salen_si_se_piden() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "foto.png", "");
        write(dir.path(), "guion.sh", "");

        assert_eq!(library(dir.path()).len(), 1);

        let con_imagenes = list_scripts(
            dir.path(),
            &ScanOptions {
                scope: Scope::Library,
                categories: &[FileCategory::Shell, FileCategory::Image],
                max_depth: 1,
                source: "scripts".into(),
            },
        );
        assert_eq!(con_imagenes.scripts.len(), 2);
        let foto = con_imagenes
            .scripts
            .iter()
            .find(|s| s.name == "foto.png")
            .unwrap();
        assert!(foto.openable);
        assert!(!foto.runnable);
    }

    #[test]
    fn aqui_esquiva_los_arboles_de_dependencias() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("node_modules").join("x"), "malo.sh", "");
        write(&dir.path().join("target"), "tambien-malo.sh", "");
        write(dir.path(), "bueno.sh", "");

        let found = list_scripts(
            dir.path(),
            &ScanOptions {
                scope: Scope::Here,
                categories: &super::super::types::default_categories(),
                max_depth: 5,
                source: "here".into(),
            },
        );
        let nombres: Vec<&str> = found.scripts.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(nombres, vec!["bueno.sh"]);
    }

    #[test]
    fn en_aqui_un_js_suelto_no_se_ofrece_pero_uno_de_scripts_si() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "indice.js", "module.exports = {}\n");
        write(&dir.path().join("scripts"), "build.js", "console.log(1)\n");

        let found = list_scripts(
            dir.path(),
            &ScanOptions {
                scope: Scope::Here,
                categories: &super::super::types::default_categories(),
                max_depth: 3,
                source: "here".into(),
            },
        );
        let nombres: Vec<&str> = found.scripts.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(nombres, vec!["build.js"]);
    }

    #[test]
    fn en_aqui_un_js_con_shebang_si_se_ofrece() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "cli.js", "#!/usr/bin/env node\n");
        let found = list_scripts(
            dir.path(),
            &ScanOptions {
                scope: Scope::Here,
                categories: &super::super::types::default_categories(),
                max_depth: 1,
                source: "here".into(),
            },
        );
        assert_eq!(found.scripts.len(), 1);
    }

    #[test]
    fn en_aqui_manda_lo_declarado_en_package_json() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "package.json",
            r#"{"bin":{"mitool":"herramienta.js"}}"#,
        );
        write(dir.path(), "herramienta.js", "console.log(1)\n");
        write(dir.path(), "otro.js", "console.log(2)\n");

        let found = list_scripts(
            dir.path(),
            &ScanOptions {
                scope: Scope::Here,
                categories: &super::super::types::default_categories(),
                max_depth: 1,
                source: "here".into(),
            },
        );
        let nombres: Vec<&str> = found.scripts.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(nombres, vec!["herramienta.js"]);
    }

    #[test]
    fn la_biblioteca_no_aplica_las_exclusiones_de_aqui() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("dist"), "empaquetar.sh", "");
        write(dir.path(), "suelto.js", "");

        let nombres: Vec<String> = library(dir.path()).iter().map(|s| s.name.clone()).collect();
        assert!(nombres.contains(&"empaquetar.sh".to_string()));
        assert!(nombres.contains(&"suelto.js".to_string()));
    }

    #[test]
    fn la_profundidad_de_aqui_se_recorta_al_rango_valido() {
        assert_eq!(normalize_here_depth(None, 3), 3);
        assert_eq!(normalize_here_depth(Some(-2), 3), MIN_HERE_DEPTH);
        assert_eq!(normalize_here_depth(Some(99), 3), MAX_HERE_DEPTH);
        assert_eq!(normalize_here_depth(Some(4), 3), 4);
    }

    #[test]
    fn una_carpeta_que_no_existe_no_da_error() {
        let found = library(Path::new("/carpeta/que/no/existe/lterminal"));
        assert!(found.is_empty());
    }

    #[test]
    fn el_escaneo_informa_de_lo_que_ha_recorrido() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a"), "x.sh", "");
        let result = list_scripts(
            dir.path(),
            &ScanOptions {
                scope: Scope::Here,
                categories: &super::super::types::default_categories(),
                max_depth: 2,
                source: "here".into(),
            },
        );
        assert_eq!(result.info.depth, 2);
        assert!(result.info.visited_directories >= 2);
        assert_eq!(result.info.stop_reason, None);
    }

    #[test]
    fn un_script_sensible_conocido_llega_con_su_aviso() {
        assert!(sensitive_hint("WinSlim_Defender_Off.vbs")
            .unwrap()
            .contains("Defender"));
        assert_eq!(sensitive_hint("cualquiera.vbs"), None);
    }

    #[test]
    fn los_archivos_ocultos_no_se_toman_por_extension() {
        assert_eq!(extension_of(".gitignore"), "");
        assert_eq!(extension_of("script.SH"), ".sh");
        assert_eq!(extension_of("sin_punto"), "");
    }
}
