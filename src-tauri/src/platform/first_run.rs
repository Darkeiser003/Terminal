//! Lo que conecta el instalador modular con la app (diseño del 23-10, punto 7).
//!
//! - **Primer arranque** ([`apply`]): la página de componentes del instalador
//!   deja `first-run.json` junto al ejecutable (`hooks.nsh`) con lo elegido:
//!   WTerminal en el PATH y el menú del Explorador con el protocolo
//!   `wterminal://`. Cada usuario lo aplica una vez, en su primer arranque; lo
//!   aplicado se apunta en sus datos (la carpeta del programa es de solo
//!   lectura para él). Sin el archivo (instalación silenciosa, portable o
//!   actualización) queda lo de fábrica: el PATH se añade solo y el menú no.
//!   Desinstalar borra el archivo (`hooks.nsh`) y lo apuntado
//!   ([`forget_applied`]).
//! - **Desinstalar** ([`uninstall_report`]): el desinstalador pregunta cuánto
//!   ocupan los datos de la app y la carpeta propia, y si esta es de WTerminal
//!   (la de fábrica o una con su marca y nada más), para ofrecer borrarla con
//!   su tamaño. Nunca la raíz entera: solo las subcarpetas de lo que se
//!   recupera solo o desde WTerminal ([`store_plan`]).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::toolchain_store::{Category, STORE_MARKER};

/// Argumento con el que el desinstalador pide el informe (`installer.nsi`).
pub const UNINSTALL_REPORT_ARG: &str = "--wterminal-uninstall-report";

/// Nombre del archivo que deja la página de componentes.
pub const FIRST_RUN_FILE: &str = "first-run.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct FirstRun {
    pub version: u32,
    pub path: bool,
    pub explorer: bool,
}

pub fn parse_first_run(text: &str) -> Option<FirstRun> {
    let parsed: FirstRun = serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()?;
    (parsed.version == 1).then_some(parsed)
}

/// Qué hay que cambiar de lo elegido: `Some(valor)` se aplica y `None` se deja
/// como está.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstRunPlan {
    pub path: Option<bool>,
    pub explorer: Option<bool>,
}

/// La primera vez (`reapply = false`) basta con lo que no es de fábrica:
/// quitar del PATH (la app se añade sola si no se le dice lo contrario) y
/// activar el menú del Explorador (apagado de fábrica). Si ya se había
/// aplicado otro `first-run.json` (reinstalación con otras casillas), se
/// aplica en los dos sentidos: marcar el PATH tiene que volver a añadirlo
/// aunque la vez anterior se guardara «desactivado», y desmarcar el Explorador
/// tiene que quitar los menús.
pub fn plan(choice: FirstRun, reapply: bool) -> FirstRunPlan {
    if reapply {
        FirstRunPlan {
            path: Some(choice.path),
            explorer: Some(choice.explorer),
        }
    } else {
        FirstRunPlan {
            path: (!choice.path).then_some(false),
            explorer: choice.explorer.then_some(true),
        }
    }
}

fn applied_marker() -> PathBuf {
    crate::paths::user_data_dir().join("first-run-applied.txt")
}

/// Desinstalar olvida lo aplicado (`platform::uninstall_cleanup`): la limpieza
/// quita el PATH y los menús, y una reinstalación con las mismas casillas
/// escribe un `first-run.json` idéntico, que con la marca vieja ya no se
/// aplicaba.
pub fn forget_applied() -> std::io::Result<()> {
    match std::fs::remove_file(applied_marker()) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Huella del archivo: si se reinstala con otras elecciones, se aplican otra
/// vez.
fn fingerprint(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Aplica `first-run.json` una vez por usuario. Se llama al arrancar, antes de
/// `path_integration::ensure_default_enabled`, para que «sin PATH» se respete.
pub fn apply() {
    if cfg!(test) {
        return;
    }
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(dir.join(FIRST_RUN_FILE)) else {
        return;
    };
    let print = fingerprint(&text);
    let marker = applied_marker();
    let previous = std::fs::read_to_string(&marker).ok();
    if previous.as_deref().map(str::trim) == Some(print.as_str()) {
        return;
    }
    let Some(choice) = parse_first_run(&text) else {
        log_warn!(
            "first-run.json no se entiende; se deja lo de fábrica",
            serde_json::json!({})
        );
        return;
    };
    let plan = plan(choice, previous.is_some());
    if let Some(enabled) = plan.path {
        if let Err(error) = super::path_integration::set_enabled(enabled) {
            log_warn!(
                "No se pudo aplicar WTerminal en el PATH (primer arranque)",
                serde_json::json!({ "enabled": enabled, "error": error })
            );
        }
    }
    if let Some(enabled) = plan.explorer {
        if let Err(error) = super::windows_integration::set_enabled(enabled) {
            log_warn!(
                "No se pudo aplicar el menú del Explorador (primer arranque)",
                serde_json::json!({ "enabled": enabled, "error": error })
            );
        }
    }
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, print);
    log_info!(
        "Primer arranque: componentes del instalador aplicados",
        serde_json::json!({
            "path": choice.path,
            "explorer": choice.explorer,
            "reapply": previous.is_some()
        })
    );
}

// ---- Informe para el desinstalador ----

/// La subcarpeta de cada categoría dentro de la raíz: la de `Category::dir`
/// en `toolchain_store` (la prueba lo comprueba). «Borrar la carpeta propia»
/// solo borra estas, una a una y con los mismos nombres fijos en `hooks.nsh`
/// (`WT_DELETE_STORE_DIR`), nunca la raíz entera: lo demás se queda.
pub const STORE_SUBDIRS: [(Category, &str); 10] = [
    (Category::Caches, "cache"),
    (Category::Downloads, "descargas"),
    (Category::AiModels, "ia"),
    (Category::Tools, "herramientas"),
    (Category::ReplHistory, "historial"),
    (Category::Toolchains, "toolchains"),
    (Category::Programs, "programas"),
    (Category::Projects, "proyectos"),
    (Category::Config, "configuracion"),
    (Category::Plugins, "plugins"),
];

/// La carpeta propia de fábrica dentro de `%LOCALAPPDATA%\WTerminal`
/// (`toolchain_store::default_root`). «Borrar los datos» nunca la toca
/// (`hooks.nsh`), aunque la carpeta propia esté ahora en otro sitio: puede
/// seguir guardando toolchains, programas o proyectos.
const DEFAULT_STORE_DIR: &str = "entornos";

/// Cuántos nombres de lo que se queda caben en la casilla.
const KEPT_NAMES: usize = 6;

/// Se conserva siempre que tenga algo: lo que la app marca como «No la borres»
/// (toolchains, programas de WinGet y proyectos de GitHub) y la configuración
/// de los REPL (perfiles de IPython y Jupyter), que no se recupera sola.
fn always_kept(category: Category) -> bool {
    matches!(
        category,
        Category::Toolchains | Category::Programs | Category::Projects | Category::Config
    )
}

/// Lo traído con «Traer lo ya instalado» ya no tiene otra copia: su categoría
/// se conserva si tiene algo (modelos de Ollama, herramientas de `npm -g` o
/// `cargo install`, historial…). Las cachés (Cachés y Plugins) no: se vuelven
/// a generar solas.
fn adoption_keeps(category: Category) -> bool {
    !matches!(category, Category::Caches | Category::Plugins)
}

/// La ruta real, sin `..`, enlaces ni el prefijo `\\?\` de `canonicalize`; la
/// de partida si no existe.
fn real_path(path: &Path) -> PathBuf {
    let Ok(real) = std::fs::canonicalize(path) else {
        return path.to_path_buf();
    };
    let text = real.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        real
    }
}

/// La ruta para comparar: real, sin separador final y, en Windows, sin
/// distinguir mayúsculas.
fn comparable(path: &Path) -> String {
    let text = real_path(path).to_string_lossy().into_owned();
    if cfg!(windows) {
        let text = text.replace('/', "\\");
        text.trim_end_matches('\\').to_lowercase()
    } else {
        text.trim_end_matches('/').to_string()
    }
}

/// `path` es `dir` o está dentro de ella.
fn within(path: &Path, dir: &Path) -> bool {
    let (path, dir) = (comparable(path), comparable(dir));
    path == dir || path.starts_with(&format!("{dir}{}", std::path::MAIN_SEPARATOR))
}

fn same_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

/// Hay algo que perder: un archivo o un enlace en algún sitio. Las carpetas
/// vacías que WTerminal crea de antemano (`refresh_environment`) no cuentan, y
/// lo que no se puede leer cuenta como algo.
fn holds_data(dir: &Path) -> bool {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return true;
        };
        for entry in entries {
            let Ok(path) = entry.map(|entry| entry.path()) else {
                return true;
            };
            match path.symlink_metadata() {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => pending.push(path),
                _ => return true,
            }
        }
    }
    false
}

/// Lo que hace «Borrar la carpeta propia» con lo que hay en la raíz.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StorePlan {
    /// Subcarpetas de [`STORE_SUBDIRS`] que se borran enteras.
    pub delete: Vec<&'static str>,
    /// Subcarpetas de [`STORE_SUBDIRS`] que se quedan porque tienen algo que
    /// conservar (o porque no son una carpeta de verdad: un archivo o un
    /// enlace con ese nombre no lo creó WTerminal).
    pub kept: Vec<&'static str>,
    /// Lo que hay en la raíz y no es de WTerminal: nunca se toca.
    pub foreign: Vec<String>,
    /// Lo que ocupa lo que se borra.
    pub bytes: u64,
    /// La medida se cortó en [`MEASURE_BUDGET`]: `bytes` es lo contado hasta
    /// entonces, un mínimo.
    pub partial: bool,
}

/// Decide qué subcarpetas se borran. `adopted`: categorías con algo traído
/// con «Traer lo ya instalado». `protected`: carpetas que no se pueden llevar
/// por delante aunque caigan dentro de una subcarpeta que se borra (la de cada
/// categoría que se conserva, que puede ser otra, y la de Proyectos de
/// Ajustes). Las carpetas propias de cada categoría fuera de la raíz
/// (`toolchainStoreCategoryDirs`) nunca se borran: las eligió el usuario, no
/// llevan marca y pueden ser una carpeta de siempre (`~\.cache`).
pub fn store_plan(root: &Path, adopted: &[Category], protected: &[PathBuf]) -> StorePlan {
    let mut plan = StorePlan::default();
    for (category, name) in STORE_SUBDIRS {
        let dir = root.join(name);
        let Ok(meta) = dir.symlink_metadata() else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            plan.kept.push(name);
            continue;
        }
        let guarded = always_kept(category)
            || (adopted.contains(&category) && adoption_keeps(category))
            || protected.iter().any(|path| within(path, &dir));
        if guarded && holds_data(&dir) {
            plan.kept.push(name);
        } else {
            plan.delete.push(name);
        }
    }
    plan.foreign = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !known_entry(name))
        .collect();
    plan.foreign.sort();
    plan
}

/// Mide lo que se borra (`plan.bytes`). Aparte de [`store_plan`] y solo si se
/// ofrece la casilla: en una carpeta propia grande (185 GB en la VM, con
/// imágenes de Docker y discos de WSL) medir tardaba minutos, y el
/// desinstalador no enseñaba nada mientras tanto.
pub fn measure_plan(root: &Path, plan: &mut StorePlan) {
    measure_plan_until(root, plan, Instant::now() + MEASURE_BUDGET);
}

/// Lo más que se mide antes de enseñar el desinstalador. Sin tope, una carpeta
/// propia de 185 GB (imágenes de Docker, discos de WSL, modelos) tardaba 7 min
/// en frío sin que se viera nada; pasado el tope la casilla dice «≥ lo
/// contado» (`StorePlan::partial`).
const MEASURE_BUDGET: Duration = Duration::from_secs(15);

fn measure_plan_until(root: &Path, plan: &mut StorePlan, deadline: Instant) {
    let mut total = 0;
    let mut complete = true;
    for name in &plan.delete {
        let (bytes, done) = directory_size_until(&root.join(name), deadline);
        total += bytes;
        if !done {
            complete = false;
            break;
        }
    }
    plan.bytes = total;
    plan.partial = !complete;
}

/// Como `toolchain_store::directory_size`, pero se para en `deadline`:
/// devuelve lo contado y si terminó.
fn directory_size_until(path: &Path, deadline: Instant) -> (u64, bool) {
    let mut total = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if Instant::now() >= deadline {
            return (total, false);
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    (total, true)
}

/// Lo que WTerminal deja en la raíz: la marca y las subcarpetas.
fn known_entry(name: &str) -> bool {
    same_name(name, STORE_MARKER) || STORE_SUBDIRS.iter().any(|(_, dir)| same_name(name, dir))
}

/// Una carpeta propia que nunca se ofrece borrar, aunque lleve la marca: una
/// raíz de disco, la carpeta personal o una carpeta del perfil que usa todo
/// el mundo (AppData, Documentos, Escritorio, Descargas), o cualquiera que las
/// contenga (`C:\Users`).
fn forbidden_root(root: &Path, profile: &[PathBuf]) -> bool {
    real_path(root).parent().is_none() || profile.iter().any(|dir| within(dir, root))
}

fn profile_dirs() -> Vec<PathBuf> {
    [
        dirs::home_dir(),
        dirs::data_local_dir(),
        dirs::config_dir(),
        dirs::document_dir(),
        dirs::desktop_dir(),
        dirs::download_dir(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// La carpeta propia es de WTerminal: la de fábrica, o una con la marca y nada
/// que no sea de WTerminal. La marca se escribía en cualquier raíz elegida en
/// Ajustes, también en una carpeta que ya tenía otras cosas (`D:\Desarrollo`),
/// así que sola no basta. Nunca una de [`forbidden_root`].
fn store_is_ours(root: &Path, factory: &Path, profile: &[PathBuf], plan: &StorePlan) -> bool {
    if forbidden_root(root, profile) {
        return false;
    }
    comparable(root) == comparable(factory)
        || (root.join(STORE_MARKER).is_file() && plan.foreign.is_empty())
}

/// La subcarpeta de `%LOCALAPPDATA%\WTerminal` (`local`) que «Borrar los datos»
/// tiene que respetar porque es la carpeta propia o la contiene: su primer
/// componente bajo `local`. `*` si la carpeta propia es la propia `local`
/// (entonces no se toca nada de ella) y vacío si está fuera.
pub fn data_keep(local: &Path, root: &Path) -> String {
    let (local_real, root_real) = (real_path(local), real_path(root));
    let (local_text, root_text) = (comparable(&local_real), comparable(&root_real));
    if root_text == local_text {
        return "*".to_string();
    }
    if !root_text.starts_with(&format!("{local_text}{}", std::path::MAIN_SEPARATOR)) {
        return String::new();
    }
    root_real
        .components()
        .nth(local_real.components().count())
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Lo que borra «Borrar los datos»: `%APPDATA%\wterminal` entero y
/// `%LOCALAPPDATA%\WTerminal` menos la carpeta propia de fábrica y `keep`
/// (lo mismo que salta el bucle de `hooks.nsh`).
fn data_bytes(config: Option<&Path>, local: Option<&Path>, keep: &str) -> u64 {
    let mut total = config.map_or(0, crate::toolchain_store::directory_size);
    let Some(local) = local.filter(|_| keep != "*") else {
        return total;
    };
    for entry in std::fs::read_dir(local).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if same_name(&name, DEFAULT_STORE_DIR) || (!keep.is_empty() && same_name(&name, keep)) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        total += if meta.is_dir() {
            crate::toolchain_store::directory_size(&path)
        } else {
            meta.len()
        };
    }
    total
}

fn size_label(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

/// Lo que el informe dice de la carpeta propia.
#[derive(Debug, Clone)]
pub struct StoreReport<'a> {
    pub path: &'a Path,
    /// Se ofrece borrar: es de WTerminal y hay algo que borrar (o no queda
    /// nada, y entonces se van la marca y la carpeta vacía).
    pub deletable: bool,
    pub plan: StorePlan,
}

/// Lo que se queda, para la casilla: las subcarpetas conservadas y lo ajeno,
/// los primeros [`KEPT_NAMES`].
fn kept_text(plan: &StorePlan) -> String {
    let names: Vec<String> = plan
        .kept
        .iter()
        .map(|name| name.to_string())
        .chain(plan.foreign.iter().cloned())
        .collect();
    if names.len() > KEPT_NAMES {
        format!("{}, …", names[..KEPT_NAMES].join(", "))
    } else {
        names.join(", ")
    }
}

/// El contenido del INI:
/// - `[data]`: lo que ocupan ajustes, registros y datos locales sin la carpeta
///   propia, y en `keep` la subcarpeta de `%LOCALAPPDATA%\WTerminal` que
///   «Borrar los datos» respeta ([`data_keep`]).
/// - `[store]`: la carpeta propia, lo que se borra de ella (`bytes`, `label`)
///   y lo que se queda (`kept`). `deletable=1` solo si es de WTerminal
///   ([`store_is_ours`]).
/// - `[delete]`: `<subcarpeta>=1` para cada una que se borra; el desinstalador
///   lo lee en la sección Uninstall.
pub fn report_text(data_bytes: u64, data_keep: &str, store: Option<&StoreReport<'_>>) -> String {
    let mut lines = vec![
        "[data]".to_string(),
        format!("bytes={data_bytes}"),
        format!("label={}", size_label(data_bytes)),
        format!("keep={data_keep}"),
        String::new(),
        "[store]".to_string(),
    ];
    match store {
        Some(store) => {
            lines.push(format!("path={}", store.path.display()));
            lines.push(format!("bytes={}", store.plan.bytes));
            // Si la medida se cortó, lo contado es un mínimo: «≥ 120.3 GB».
            // Sin palabras, para que valga en cualquier idioma del instalador.
            let label = size_label(store.plan.bytes);
            if store.plan.partial {
                lines.push(format!("label=≥ {label}"));
            } else {
                lines.push(format!("label={label}"));
            }
            lines.push(format!("partial={}", u8::from(store.plan.partial)));
            lines.push(format!("deletable={}", u8::from(store.deletable)));
            lines.push(format!("kept={}", kept_text(&store.plan)));
            lines.push(String::new());
            lines.push("[delete]".to_string());
            for (_, name) in STORE_SUBDIRS {
                let delete = store.deletable && store.plan.delete.contains(&name);
                lines.push(format!("{name}={}", u8::from(delete)));
            }
        }
        None => lines.push("deletable=0".to_string()),
    }
    lines.join("\r\n") + "\r\n"
}

/// Categorías con algo traído con «Traer lo ya instalado». El perfil de Clink
/// (`clink-profile`) no tiene categoría: es de WTerminal y «Borrar los datos»
/// también se lleva el de siempre.
fn adopted_categories() -> Vec<Category> {
    crate::store_adopt::adopted_variable_ids()
        .iter()
        .filter_map(|id| crate::toolchain_store::entry_category(id.as_str()))
        .collect()
}

/// Ver `protected` en [`store_plan`].
fn protected_dirs(root: &Path) -> Vec<PathBuf> {
    let mut protected: Vec<PathBuf> = STORE_SUBDIRS
        .iter()
        .filter(|(category, _)| always_kept(*category))
        .map(|(category, _)| crate::toolchain_store::category_base(root, *category))
        .collect();
    let projects = PathBuf::from(crate::github::projects_folder());
    if projects.is_absolute() {
        protected.push(projects);
    }
    protected
}

/// Escribe el informe en `path` en UTF-16 con BOM (lo que lee bien
/// `ReadINIStr` con rutas que no son ASCII) y devuelve el código de salida.
pub fn uninstall_report(path: &Path) -> i32 {
    let preferences = crate::preferences::current();
    crate::toolchain_store::sync_layout(&preferences);
    let default_root = crate::toolchain_store::default_root();
    let root = crate::toolchain_store::effective_root(true, &preferences.toolchain_store_dir)
        .unwrap_or_else(|| default_root.clone());
    let local = dirs::data_local_dir().map(|dir| dir.join("WTerminal"));
    let keep = local
        .as_deref()
        .map(|local| data_keep(local, &root))
        .unwrap_or_default();
    let store = root.is_dir().then(|| {
        let mut plan = store_plan(&root, &adopted_categories(), &protected_dirs(&root));
        let nothing_stays = plan.kept.is_empty() && plan.foreign.is_empty();
        let deletable = store_is_ours(&root, &default_root, &profile_dirs(), &plan)
            && (!plan.delete.is_empty() || nothing_stays);
        if deletable {
            measure_plan(&root, &mut plan);
        }
        StoreReport {
            path: root.as_path(),
            deletable,
            plan,
        }
    });
    let config = dirs::config_dir().map(|dir| dir.join("wterminal"));
    let data = data_bytes(config.as_deref(), local.as_deref(), &keep);
    let text = report_text(data, &keep, store.as_ref());
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    match std::fs::write(path, bytes) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{}: {error}", path.display());
            1
        }
    }
}

/// `--wterminal-uninstall-report <ruta>`: la ruta que sigue al argumento.
pub fn uninstall_report_argument() -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(argument) = args.next() {
        if argument == UNINSTALL_REPORT_ARG {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_archivo_del_instalador_se_lee_y_dice_que_cambiar() {
        let choice =
            parse_first_run("\u{feff}{\"version\":1,\"path\":false,\"explorer\":true}\r\n")
                .unwrap();
        assert_eq!(
            plan(choice, false),
            FirstRunPlan {
                path: Some(false),
                explorer: Some(true)
            }
        );
        let defaults = parse_first_run("{\"version\":1,\"path\":true,\"explorer\":false}").unwrap();
        assert_eq!(
            plan(defaults, false),
            FirstRunPlan {
                path: None,
                explorer: None
            }
        );
        assert!(parse_first_run("{\"version\":2,\"path\":true,\"explorer\":true}").is_none());
        assert!(parse_first_run("basura").is_none());
    }

    #[test]
    fn con_otra_huella_anterior_se_aplica_en_los_dos_sentidos() {
        // La primera vez se desmarcó el PATH (AutoAdd=0) y se marcó el
        // Explorador; ahora se reinstala al revés.
        let again = parse_first_run("{\"version\":1,\"path\":true,\"explorer\":false}").unwrap();
        assert_eq!(
            plan(again, true),
            FirstRunPlan {
                path: Some(true),
                explorer: Some(false)
            }
        );
        let first = parse_first_run("{\"version\":1,\"path\":false,\"explorer\":true}").unwrap();
        assert_eq!(
            plan(first, true),
            FirstRunPlan {
                path: Some(false),
                explorer: Some(true)
            }
        );
    }

    #[test]
    fn la_huella_cambia_si_cambian_las_elecciones() {
        assert_ne!(
            fingerprint("{\"version\":1,\"path\":true,\"explorer\":false}"),
            fingerprint("{\"version\":1,\"path\":true,\"explorer\":true}")
        );
    }

    #[test]
    fn las_subcarpetas_son_las_de_cada_categoria() {
        let source = include_str!("../config/toolchain_store.rs");
        assert_eq!(STORE_SUBDIRS.len(), Category::ALL.len());
        for category in Category::ALL {
            let (_, name) = STORE_SUBDIRS
                .iter()
                .find(|(known, _)| *known == category)
                .unwrap_or_else(|| panic!("{category:?} sin subcarpeta"));
            assert!(
                source.contains(&format!("Category::{category:?} => \"{name}\",")),
                "{category:?} ya no usa «{name}» en Category::dir"
            );
        }
        let factory = crate::toolchain_store::default_root();
        assert!(factory.ends_with(DEFAULT_STORE_DIR));
    }

    #[test]
    fn el_informe_solo_ofrece_borrar_una_carpeta_propia_de_wterminal() {
        let plan = StorePlan {
            delete: vec!["cache", "ia"],
            kept: vec!["toolchains", "proyectos"],
            foreign: Vec::new(),
            bytes: 3 * 1024 * 1024 * 1024,
            partial: false,
        };
        let ours = report_text(
            5 * 1024 * 1024,
            "entornos",
            Some(&StoreReport {
                path: Path::new(r"E:\WTerminal\entornos"),
                deletable: true,
                plan: plan.clone(),
            }),
        );
        let data = "[data]\r\nbytes=5242880\r\nlabel=5.0 MB\r\nkeep=entornos\r\n";
        assert!(ours.starts_with(data));
        assert!(ours.contains(r"path=E:\WTerminal\entornos"));
        assert!(ours.contains("label=3.0 GB"));
        assert!(ours.contains("partial=0"));
        assert!(ours.contains("deletable=1"));
        assert!(ours.contains("kept=toolchains, proyectos"));
        let delete = "[delete]\r\ncache=1\r\ndescargas=0\r\nia=1\r\n";
        assert!(ours.contains(delete));
        assert!(ours.contains("proyectos=0"));
        let foreign = report_text(
            0,
            "",
            Some(&StoreReport {
                path: Path::new(r"D:\"),
                deletable: false,
                plan,
            }),
        );
        assert!(foreign.contains("deletable=0"));
        assert!(foreign.contains("keep=\r\n"));
        assert!(foreign.contains("cache=0") && foreign.contains("ia=0"));
        let none = report_text(0, "", None);
        assert!(none.contains("[store]\r\ndeletable=0"));
        let many = StorePlan {
            foreign: (1..=8).map(|n| format!("cosa{n}")).collect(),
            ..StorePlan::default()
        };
        assert_eq!(
            kept_text(&many),
            "cosa1, cosa2, cosa3, cosa4, cosa5, cosa6, …"
        );
    }

    #[test]
    fn solo_se_borra_lo_que_se_recupera_y_nunca_lo_que_hay_que_conservar() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("entornos");
        let write = |relative: &str| {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"12345").unwrap();
        };
        write("cache/npm/a");
        write("descargas/panel/b");
        write("ia/ollama/models/c");
        write("herramientas/npm/d");
        write("proyectos/ana/repo/.git/HEAD");
        write("configuracion/ipython/profile_default/e");
        write("plugins/clink/f");
        // Las carpetas vacías que crea WTerminal de antemano no se conservan.
        std::fs::create_dir_all(root.join("toolchains/rustup")).unwrap();
        std::fs::create_dir_all(root.join("historial")).unwrap();
        std::fs::write(root.join(STORE_MARKER), b"marca").unwrap();

        let mut plan = store_plan(&root, &[], &[]);
        let deleted = "cache descargas ia herramientas historial toolchains plugins";
        assert_eq!(plan.delete.join(" "), deleted);
        assert_eq!(plan.kept, vec!["proyectos", "configuracion"]);
        assert!(plan.foreign.is_empty());
        // Sin medir hasta que se pide: el desinstalador no espera a medir
        // una carpeta que no va a ofrecer borrar.
        assert_eq!(plan.bytes, 0);
        measure_plan(&root, &mut plan);
        assert_eq!(plan.bytes, 25);
        assert!(!plan.partial);
        // Con el tope agotado (185 GB tardaban 7 min) la medida se corta y lo
        // contado es un mínimo: la casilla dice «≥ …».
        measure_plan_until(&root, &mut plan, Instant::now());
        assert!(plan.partial);
        let cut = report_text(
            0,
            "",
            Some(&StoreReport {
                path: &root,
                deletable: true,
                plan: StorePlan {
                    bytes: 3 * 1024 * 1024 * 1024,
                    ..plan.clone()
                },
            }),
        );
        assert!(cut.contains("label=≥ 3.0 GB") && cut.contains("partial=1"));
        measure_plan(&root, &mut plan);

        // Lo traído de antes se conserva, menos las cachés.
        let adopted = store_plan(
            &root,
            &[Category::AiModels, Category::Caches, Category::Plugins],
            &[],
        );
        assert_eq!(adopted.kept, vec!["ia", "proyectos", "configuracion"]);
        assert!(adopted.delete.contains(&"cache"));
        assert!(adopted.delete.contains(&"plugins"));

        // Una carpeta que se conserva (la de Proyectos de Ajustes) dentro de
        // una que se borra la salva entera.
        let protected = store_plan(&root, &[], &[root.join("herramientas").join("npm")]);
        assert!(protected.kept.contains(&"herramientas"));
        assert!(!protected.delete.contains(&"herramientas"));
        // Al revés no: que la carpeta propia caiga dentro de Proyectos no
        // conserva sus cachés.
        let inside = store_plan(&root, &[], &[dir.path().to_path_buf()]);
        assert!(inside.delete.contains(&"cache"));
    }

    #[test]
    fn la_marca_no_basta_en_una_carpeta_con_otras_cosas_ni_en_una_raiz() {
        let dir = tempfile::tempdir().unwrap();
        let factory = dir.path().join("fabrica");
        let chosen = dir.path().join("elegida");
        std::fs::create_dir_all(chosen.join("cache")).unwrap();
        let profile = vec![dir.path().join("perfil").join("ana")];

        // Sin marca, no.
        let plan = store_plan(&chosen, &[], &[]);
        assert!(!store_is_ours(&chosen, &factory, &profile, &plan));
        // Con marca y solo lo de WTerminal, sí.
        std::fs::write(chosen.join(STORE_MARKER), b"marca").unwrap();
        let plan = store_plan(&chosen, &[], &[]);
        assert!(store_is_ours(&chosen, &factory, &profile, &plan));
        // Con marca y otras cosas (D:\Desarrollo con sus proyectos), no.
        std::fs::create_dir_all(chosen.join("mi-proyecto")).unwrap();
        let plan = store_plan(&chosen, &[], &[]);
        assert_eq!(plan.foreign, vec!["mi-proyecto".to_string()]);
        assert!(!store_is_ours(&chosen, &factory, &profile, &plan));
        // La de fábrica sí, aunque tenga otras cosas: lo ajeno se queda.
        assert!(store_is_ours(&chosen, &chosen, &profile, &plan));

        // Nunca la carpeta personal ni sus antecesoras, aunque lleven la marca.
        let home = dir.path().join("perfil");
        std::fs::create_dir_all(profile[0].join("cache")).unwrap();
        std::fs::write(home.join(STORE_MARKER), b"marca").unwrap();
        std::fs::write(profile[0].join(STORE_MARKER), b"marca").unwrap();
        for root in [&home, &profile[0]] {
            let plan = StorePlan::default();
            let ours = store_is_ours(root, root, &profile, &plan);
            assert!(!ours, "{}", root.display());
        }
        // Ni una raíz de disco.
        let disk = Path::new(if cfg!(windows) { "C:\\" } else { "/" });
        assert!(forbidden_root(disk, &[]));
        assert!(!store_is_ours(disk, disk, &[], &StorePlan::default()));
        assert!(!forbidden_root(&chosen, &profile));
    }

    #[test]
    fn borrar_los_datos_respeta_la_carpeta_propia_que_cuelga_de_ellos() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("WTerminal");
        let tools = local.join("herramientas");
        for sub in ["entornos", "herramientas/dentro", "clink"] {
            std::fs::create_dir_all(local.join(sub)).unwrap();
        }
        let elsewhere = dir.path().join("otra");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert_eq!(data_keep(&local, &local.join("entornos")), "entornos");
        assert_eq!(data_keep(&local, &tools), "herramientas");
        assert_eq!(data_keep(&local, &tools.join("dentro")), "herramientas");
        assert_eq!(data_keep(&local, &local), "*");
        assert_eq!(data_keep(&local, &elsewhere), "");

        std::fs::write(local.join("entornos").join("a"), vec![0u8; 100]).unwrap();
        std::fs::write(tools.join("dentro").join("b"), vec![0u8; 10]).unwrap();
        std::fs::write(local.join("clink").join("c"), vec![0u8; 1]).unwrap();
        std::fs::write(local.join("registro.txt"), vec![0u8; 2]).unwrap();
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("ajustes.json"), vec![0u8; 1000]).unwrap();
        let (config, local) = (Some(config.as_path()), Some(local.as_path()));
        assert_eq!(data_bytes(config, local, "herramientas"), 1003);
        assert_eq!(data_bytes(config, local, ""), 1013);
        assert_eq!(data_bytes(config, local, "*"), 1000);
    }
}
