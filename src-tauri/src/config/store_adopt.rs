//! «Traer lo ya instalado» a la carpeta propia (`config::toolchain_store`).
//!
//! La carpeta propia nunca mueve nada por su cuenta: lo que ya estaba
//! instalado sigue en su sitio de siempre. Aquí el usuario lo trae a propósito,
//! elemento a elemento, con una vista previa del espacio y una vuelta atrás:
//!
//! 1. **Copia**, sin tocar el original. Las cachés y las herramientas se
//!    mezclan con lo que ya hubiera en la carpeta propia; lo demás exige que el
//!    destino esté vacío.
//! 2. **Cambio**: la entrada queda «traída» en el diario y la carpeta propia
//!    la reubica aunque ya existiera en su sitio de siempre (variable de
//!    entorno), o, para los programas, el original se renombra a
//!    `<carpeta>.wterminal-antes` y en su sitio queda una unión hacia la copia.
//! 3. **Confirmar** borra el original. Hasta entonces, **Deshacer** vuelve a
//!    dejarlo todo como estaba.
//!
//! Los programas instalados con MSI no se traen con una unión: sus
//! actualizaciones fallan si la carpeta es una unión (mongosh, error 1603 al
//! poner permisos; 01-11). Para ellos la salida es desinstalar e instalar de
//! nuevo desde Dependencias, que ya los pone en `programas\<id>`.
//!
//! Con la integración con el PATH activa, las variables de lo traído se
//! publican también en el usuario (`toolchain_store::published_variables`):
//! así lo traído se sigue viendo fuera de WTerminal tras borrar el original.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::toolchain_store::{self, Category};

/// Cómo se trae cada cosa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// Copia y variable de entorno (cachés, herramientas, toolchains…).
    Variable,
    /// Copia, original renombrado y una unión en su sitio (programas).
    Junction,
    /// Perfil propio de WTerminal (Clink): copia y cambio de carpeta.
    Profile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Available,
    Blocked,
    /// Copiando. En el diario: la copia empezó y, si no hay una en marcha,
    /// se cortó (se cerró WTerminal o se apagó el equipo): se puede volver a
    /// traer desde el principio.
    Copying,
    /// Copiado y en uso; el original sigue en su sitio hasta confirmar.
    Done,
    /// «Confirmar» empezó a borrar el original y no terminó (un archivo en
    /// uso): el original puede estar a medias y la copia es la única
    /// completa. No se puede deshacer, solo volver a confirmar.
    Confirming,
    /// Original borrado.
    Confirmed,
    Failed,
}

/// Un elemento de la vista previa.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptItem {
    pub id: String,
    pub label: String,
    pub category: Category,
    pub source: String,
    pub destination: String,
    pub bytes: u64,
    pub method: Method,
    pub state: State,
    pub copied_bytes: u64,
    pub needs_admin: bool,
    pub reason: Option<String>,
}

/// Lo que queda apuntado de cada elemento traído.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub label: String,
    pub method: Method,
    pub source: PathBuf,
    pub destination: PathBuf,
    /// La carpeta de destino no existía: deshacer la puede borrar entera.
    pub destination_created: bool,
    /// Programas: dónde quedó el original hasta confirmar.
    pub backup: Option<PathBuf>,
    pub needs_admin: bool,
    pub state: State,
    /// Segundos desde 1970.
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    entries: Vec<JournalEntry>,
}

fn journal_path() -> PathBuf {
    crate::paths::user_data_dir().join("store-journal.json")
}

/// La versión anterior del diario, para recuperarlo a mano si el actual se
/// estropea.
fn journal_backup_path() -> PathBuf {
    crate::paths::user_data_dir().join("store-journal.json.bak")
}

/// `Ok(None)` si el archivo no existe. Un archivo que no se puede leer o
/// interpretar es un error, nunca un diario vacío: escribir encima borraría
/// el registro de todo lo traído.
fn parse_journal(path: &Path) -> Result<Option<Journal>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map(Some)
            .map_err(|error| format!("{}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn read_journal() -> Result<Journal, String> {
    if cfg!(test) {
        return Ok(Journal::default());
    }
    match parse_journal(&journal_path()) {
        Ok(journal) => Ok(journal.unwrap_or_default()),
        Err(error) => Err(format!(
            "No se pudo leer el diario de «Traer lo ya instalado» ({error}). No se cambia nada hasta que se arregle: la versión anterior está en {}.",
            journal_backup_path().display()
        )),
    }
}

/// Escribe en un temporal y lo pone encima con un renombrado: un cuelgue a
/// mitad deja el diario anterior entero, nunca uno a medias. Antes guarda el
/// anterior en `.bak`.
fn write_journal(journal: &Journal) -> Result<(), String> {
    use std::io::Write;
    if cfg!(test) {
        return Ok(());
    }
    let text = serde_json::to_string_pretty(journal).map_err(|error| error.to_string())?;
    let path = journal_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("json.tmp");
    let written = std::fs::File::create(&temporary).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("{}: {error}", temporary.display()));
    }
    if path.is_file() {
        let _ = std::fs::copy(&path, journal_backup_path());
    }
    std::fs::rename(&temporary, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("{}: {error}", path.display())
    })
}

static JOURNAL_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Cambia el diario. Si no se puede leer, no escribe nada.
fn update_journal(change: impl FnOnce(&mut Journal)) -> Result<(), String> {
    let _guard = JOURNAL_LOCK.lock();
    let mut journal = read_journal()?;
    change(&mut journal);
    write_journal(&journal)
}

/// Cambia el estado de una entrada del diario.
fn set_journal_state(id: &str, state: State) -> Result<(), String> {
    update_journal(|journal| {
        if let Some(found) = journal.entries.iter_mut().find(|found| found.id == id) {
            found.state = state;
            found.at = now();
        }
    })
}

/// Ids traídos con variable o perfil (copiados y en uso): la carpeta propia
/// los reubica aunque existieran en su sitio de siempre. Con el diario
/// estropeado se usa su versión anterior: dejar de reubicar lo ya confirmado
/// (con el original borrado) lo haría desaparecer.
pub fn adopted_variable_ids() -> Vec<String> {
    let journal = read_journal().unwrap_or_else(|_| {
        parse_journal(&journal_backup_path())
            .ok()
            .flatten()
            .unwrap_or_default()
    });
    journal
        .entries
        .into_iter()
        .filter(|entry| {
            matches!(entry.method, Method::Variable | Method::Profile)
                && matches!(
                    entry.state,
                    State::Done | State::Confirming | State::Confirmed
                )
        })
        .map(|entry| entry.id)
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

// ---- Progreso de las copias en marcha ----

#[derive(Debug, Clone, Default)]
struct Progress {
    copied: u64,
    copying: bool,
    error: Option<String>,
}

static PROGRESS: Lazy<Mutex<HashMap<String, Progress>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn set_progress(id: &str, change: impl FnOnce(&mut Progress)) {
    let mut progress = PROGRESS.lock();
    change(progress.entry(id.to_string()).or_default());
}

// ---- Tamaños, con caché de 10 minutos como `external_sizes` ----

const SIZE_CACHE_TTL: Duration = Duration::from_secs(600);
static SIZES: Lazy<Mutex<HashMap<PathBuf, (Instant, u64)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn measured_size(path: &Path) -> u64 {
    if let Some((at, bytes)) = SIZES.lock().get(path) {
        if at.elapsed() < SIZE_CACHE_TTL {
            return *bytes;
        }
    }
    let bytes = match path.symlink_metadata() {
        Ok(meta) if meta.is_file() => meta.len(),
        Ok(_) => toolchain_store::directory_size(path),
        Err(_) => 0,
    };
    SIZES
        .lock()
        .insert(path.to_path_buf(), (Instant::now(), bytes));
    bytes
}

fn has_content(path: &Path) -> bool {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_file() => meta.len() > 0,
        Ok(meta) if meta.file_type().is_symlink() => false,
        Ok(_) => std::fs::read_dir(path)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn is_link(path: &Path) -> bool {
    path.symlink_metadata()
        .map(|meta| meta.file_type().is_symlink() || is_junction(&meta))
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_junction(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_junction(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Categorías en las que se mezcla con lo que ya haya en la carpeta propia:
/// lo que se puede volver a descargar o generar, y las herramientas (cada una
/// en su propia subcarpeta).
fn merges(category: Category) -> bool {
    matches!(
        category,
        Category::Caches | Category::AiModels | Category::Plugins | Category::Tools
    )
}

// ---- La vista previa ----

/// Lo que se puede traer ahora mismo, con su espacio y su estado. Mide
/// carpetas grandes (decenas de segundos la primera vez): se llama fuera del
/// hilo de la interfaz.
pub fn candidates() -> Result<Vec<AdoptItem>, String> {
    let preferences = crate::preferences::current();
    toolchain_store::sync_layout(&preferences);
    reconcile_programs();
    let journal = read_journal()?;
    let progress = PROGRESS.lock().clone();
    let mut items = Vec::new();
    let Some(root) = toolchain_store::effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    ) else {
        return Ok(items);
    };
    let categories = toolchain_store::Categories::from_preferences(&preferences);

    for entry in toolchain_store::adoptable_entries(&root) {
        if !categories.includes(entry.category) || toolchain_store::entry_disabled(&entry.id) {
            continue;
        }
        let mut item = AdoptItem {
            id: entry.id.clone(),
            label: entry.label.clone(),
            category: entry.category,
            source: entry.source.to_string_lossy().into_owned(),
            destination: entry.destination.to_string_lossy().into_owned(),
            bytes: 0,
            method: Method::Variable,
            state: State::Available,
            copied_bytes: 0,
            needs_admin: false,
            reason: None,
        };
        if let Some(done) = journal.entries.iter().find(|done| done.id == entry.id) {
            items.push(from_journal(done, &progress));
            continue;
        }
        if !has_content(&entry.source) || is_link(&entry.source) {
            continue;
        }
        item.bytes = measured_size(&entry.source);
        if entry.user_defined {
            item.state = State::Blocked;
            item.reason = Some(format!(
                "Ya defines {} en tu usuario: manda tu carpeta. Quita la variable si quieres usar la carpeta propia.",
                entry.variable
            ));
        } else if let Some(conflict) = entry.conflict {
            // El origen y el destino (o la carpeta propia) son la misma
            // carpeta o una está dentro de la otra: la copia se metería en
            // sí misma y confirmar borraría la única copia.
            item.state = State::Blocked;
            item.reason = Some(conflict.reason().to_string());
        } else if has_content(&entry.destination) && !merges(entry.category) {
            item.state = State::Blocked;
            item.reason = Some(
                "La carpeta propia ya tiene algo en ese sitio: instalaste otra copia desde WTerminal. Desinstala una de las dos antes de traerla."
                    .to_string(),
            );
        }
        apply_progress(&mut item, &progress);
        items.push(item);
    }

    if let Some((source, destination)) = clink_profile_paths(&root) {
        if let Some(done) = journal
            .entries
            .iter()
            .find(|done| done.id == toolchain_store::CLINK_PROFILE_ENTRY)
        {
            items.push(from_journal(done, &progress));
        } else if categories.plugins
            && has_content(&source)
            && !has_content(&destination)
            && !toolchain_store::entry_disabled(toolchain_store::CLINK_PROFILE_ENTRY)
        {
            let mut item = AdoptItem {
                id: toolchain_store::CLINK_PROFILE_ENTRY.to_string(),
                label: "Clink (perfil de WTerminal: historial y ajustes de cmd)".to_string(),
                category: Category::Plugins,
                source: source.to_string_lossy().into_owned(),
                destination: destination.to_string_lossy().into_owned(),
                bytes: measured_size(&source),
                method: Method::Profile,
                state: State::Available,
                copied_bytes: 0,
                needs_admin: false,
                reason: None,
            };
            apply_progress(&mut item, &progress);
            items.push(item);
        }
    }

    if categories.programs {
        let programs_dir = toolchain_store::category_base(&root, Category::Programs);
        for program in installed_programs() {
            let id = program_id(&program.location);
            if let Some(done) = journal.entries.iter().find(|done| done.id == id) {
                items.push(from_journal(done, &progress));
                continue;
            }
            if is_link(&program.location)
                || !program.location.is_dir()
                || toolchain_store::paths_overlap(&program.location, &root)
                || toolchain_store::paths_overlap(&program.location, &programs_dir)
            {
                continue;
            }
            let leaf = program
                .location
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| id.clone());
            let destination = programs_dir.join(&leaf);
            let mut item = AdoptItem {
                id: id.clone(),
                label: program.name.clone(),
                category: Category::Programs,
                source: program.location.to_string_lossy().into_owned(),
                destination: destination.to_string_lossy().into_owned(),
                bytes: measured_size(&program.location),
                method: Method::Junction,
                state: State::Available,
                copied_bytes: 0,
                needs_admin: program.needs_admin,
                reason: None,
            };
            if program.msi {
                item.state = State::Blocked;
                item.reason = Some(
                    "Instalado con MSI: sus actualizaciones fallan si su carpeta es una unión (mongosh, error 1603). Desinstálalo e instálalo de nuevo desde «Entorno y dependencias»: irá a la carpeta propia."
                        .to_string(),
                );
            } else if program.needs_admin {
                // La copia quedaría en una carpeta en la que el usuario puede
                // escribir (y renombrar o cambiar la carpeta que la contiene),
                // y C:\Program Files\X resolvería a ella por la unión: un
                // servicio o una tarea elevada cargaría EXE y DLL que puede
                // cambiar cualquier proceso sin elevar. Copiar las ACL no lo
                // evita, porque se puede cambiar una carpeta de más arriba.
                item.state = State::Blocked;
                item.reason = Some(
                    "Está en Program Files: su copia quedaría en una carpeta en la que se puede escribir sin permisos de administrador, y lo que se ejecute como administrador (un servicio, una tarea) cargaría sus archivos desde ahí. Desinstálalo e instálalo de nuevo desde «Entorno y dependencias»."
                        .to_string(),
                );
            } else if destination.exists() {
                item.state = State::Blocked;
                item.reason = Some(format!(
                    "Ya hay una carpeta «{leaf}» en la carpeta de programas."
                ));
            }
            apply_progress(&mut item, &progress);
            items.push(item);
        }
    }
    Ok(items)
}

/// Copias que el diario da por empezadas y que no siguen en marcha: se
/// cortaron (se cerró WTerminal o se apagó el equipo a mitad).
fn interrupted(entry: &JournalEntry, progress: &HashMap<String, Progress>) -> bool {
    entry.state == State::Copying && !progress.get(&entry.id).is_some_and(|live| live.copying)
}

/// Pone el diario de los programas de acuerdo con el disco. El script de un
/// programa sigue aunque se cierre WTerminal (el PowerShell elevado no muere
/// con él), y Confirmar también puede terminar fuera:
/// - Copia apuntada y unión en su sitio con el original guardado: el script
///   terminó, queda traído.
/// - Traído o confirmando, y sin el original guardado: el original ya se
///   borró (o lo borró el usuario a mano), queda confirmado.
fn reconcile_programs() {
    let Ok(journal) = read_journal() else {
        return;
    };
    let progress = PROGRESS.lock().clone();
    let mut changes = Vec::new();
    for entry in journal
        .entries
        .iter()
        .filter(|entry| entry.method == Method::Junction)
    {
        let Some(backup) = &entry.backup else {
            continue;
        };
        let junction = is_link(&entry.source);
        let kept = backup.exists();
        if interrupted(entry, &progress) && junction && kept {
            changes.push((entry.id.clone(), State::Done));
        } else if matches!(entry.state, State::Done | State::Confirming) && junction && !kept {
            changes.push((entry.id.clone(), State::Confirmed));
        }
    }
    for (id, state) in changes {
        let _ = set_journal_state(&id, state);
    }
}

fn from_journal(entry: &JournalEntry, progress: &HashMap<String, Progress>) -> AdoptItem {
    let mut item = AdoptItem {
        id: entry.id.clone(),
        label: entry.label.clone(),
        category: match entry.method {
            Method::Junction => Category::Programs,
            Method::Profile => Category::Plugins,
            Method::Variable => {
                toolchain_store::entry_category(&entry.id).unwrap_or(Category::Caches)
            }
        },
        source: entry.source.to_string_lossy().into_owned(),
        destination: entry.destination.to_string_lossy().into_owned(),
        bytes: measured_size(&entry.destination),
        method: entry.method,
        state: entry.state,
        copied_bytes: 0,
        needs_admin: entry.needs_admin,
        reason: None,
    };
    if interrupted(entry, progress) {
        if entry.method == Method::Junction && is_link(&entry.source) {
            // Unión en su sitio sin el original guardado: no la dejó un
            // script completo. No se toca nada sin que lo mire el usuario.
            item.state = State::Blocked;
            item.reason = Some(format!(
                "La copia se cortó a medias y {} es una unión sin el original guardado al lado. Revísalo a mano antes de seguir.",
                entry.source.display()
            ));
        } else {
            item.state = State::Failed;
            item.bytes = measured_size(&entry.source);
            item.reason = Some(
                "La copia se cortó (se cerró WTerminal o se apagó el equipo). El original no se tocó: vuelve a traerlo y se copia de nuevo desde el principio."
                    .to_string(),
            );
        }
        return item;
    }
    if entry.state == State::Confirming {
        item.reason = Some(
            "No se pudo borrar todo el original (algo lo estaba usando): lo que queda de él puede estar incompleto y la copia es la buena. Cierra lo que lo use y vuelve a confirmar."
                .to_string(),
        );
    }
    apply_progress(&mut item, progress);
    item
}

fn apply_progress(item: &mut AdoptItem, progress: &HashMap<String, Progress>) {
    let Some(progress) = progress.get(&item.id) else {
        return;
    };
    if progress.copying {
        item.state = State::Copying;
        item.copied_bytes = progress.copied;
    } else if let Some(error) = &progress.error {
        if item.state == State::Available {
            item.state = State::Failed;
        }
        item.reason = Some(error.clone());
    }
}

fn clink_profile_paths(root: &Path) -> Option<(PathBuf, PathBuf)> {
    if !cfg!(windows) {
        return None;
    }
    Some((
        crate::terminal::shell_assist::clink_default_profile_dir(),
        toolchain_store::category_base(root, Category::Plugins).join("clink"),
    ))
}

/// Id estable de un programa: su carpeta, sin mayúsculas, resumida.
fn program_id(location: &Path) -> String {
    let text = location.to_string_lossy().to_lowercase().replace('/', "\\");
    // FNV-1a de 64 bits: corto y estable entre versiones.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.trim_end_matches('\\').bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("program-{hash:016x}")
}

struct Program {
    name: String,
    location: PathBuf,
    msi: bool,
    needs_admin: bool,
}

/// Programas de «Aplicaciones instaladas» con su carpeta en Program Files o
/// en `%LOCALAPPDATA%\Programs`. Nunca los de Windows ni los de ProgramData.
#[cfg(windows)]
fn installed_programs() -> Vec<Program> {
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;
    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    let user_programs =
        std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("Programs"));
    let mut seen = std::collections::HashSet::new();
    let mut programs = Vec::new();
    for (hive, flags) in [
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY),
        (HKEY_CURRENT_USER, KEY_READ),
    ] {
        let Ok(uninstall) = RegKey::predef(hive).open_subkey_with_flags(UNINSTALL, flags) else {
            continue;
        };
        for name in uninstall.enum_keys().flatten() {
            let Ok(key) = uninstall.open_subkey_with_flags(&name, flags) else {
                continue;
            };
            let display: String = key.get_value("DisplayName").unwrap_or_default();
            let location: String = key.get_value("InstallLocation").unwrap_or_default();
            let location = location.trim().trim_matches('"').trim_end_matches('\\');
            if display.trim().is_empty() || location.is_empty() {
                continue;
            }
            let location = PathBuf::from(location);
            // Solo la carpeta propia del programa, nunca la raíz de Program
            // Files ni nada más profundo que un nivel por debajo.
            let in_program_files = program_files.iter().any(|base| {
                location
                    .parent()
                    .is_some_and(|parent| same_path(parent, base))
            });
            let in_user_programs = user_programs.as_ref().is_some_and(|base| {
                location
                    .parent()
                    .is_some_and(|parent| same_path(parent, base))
            });
            if !in_program_files && !in_user_programs {
                continue;
            }
            if !seen.insert(location.to_string_lossy().to_lowercase()) {
                continue;
            }
            let msi: u32 = key.get_value("WindowsInstaller").unwrap_or(0);
            programs.push(Program {
                name: display.trim().to_string(),
                location,
                msi: msi == 1,
                needs_admin: in_program_files,
            });
        }
    }
    programs.sort_by_key(|program| program.name.to_lowercase());
    programs
}

#[cfg(not(windows))]
fn installed_programs() -> Vec<Program> {
    Vec::new()
}

#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    normalize(left) == normalize(right)
}

// ---- Traer ----

/// Trae los elementos pedidos, uno detrás de otro, en segundo plano. El
/// progreso se lee con [`candidates`].
pub fn adopt(ids: Vec<String>) -> Result<(), String> {
    let items = candidates()?;
    let mut chosen: Vec<AdoptItem> = Vec::new();
    for id in &ids {
        let Some(item) = items.iter().find(|item| &item.id == id) else {
            return Err(format!(
                "«{id}» ya no se puede traer: vuelve a abrir la lista."
            ));
        };
        if item.state != State::Available && item.state != State::Failed {
            return Err(format!("«{}» no se puede traer ahora.", item.label));
        }
        // Dos elementos con el mismo destino (VS Code para el usuario y para
        // el sistema) se mezclarían en una sola copia.
        if let Some(other) = chosen.iter().find(|other| {
            toolchain_store::paths_overlap(
                Path::new(&other.destination),
                Path::new(&item.destination),
            )
        }) {
            return Err(format!(
                "«{}» y «{}» irían a la misma carpeta: trae solo uno.",
                other.label, item.label
            ));
        }
        chosen.push(item.clone());
    }
    for item in &chosen {
        set_progress(&item.id, |progress| {
            progress.copying = true;
            progress.copied = 0;
            progress.error = None;
        });
    }
    std::thread::spawn(move || {
        for item in chosen {
            let result = match item.method {
                Method::Variable | Method::Profile => adopt_by_copy(&item),
                Method::Junction => adopt_program(&item),
            };
            set_progress(&item.id, |progress| {
                progress.copying = false;
                progress.error = result.err();
            });
        }
        let preferences = crate::preferences::current();
        toolchain_store::sync_layout(&preferences);
        toolchain_store::refresh_environment();
        let _ = crate::platform::path_integration::sync_tool_bins();
    });
    Ok(())
}

fn adopt_by_copy(item: &AdoptItem) -> Result<(), String> {
    let source = PathBuf::from(&item.source);
    let destination = PathBuf::from(&item.destination);
    if toolchain_store::paths_overlap(&source, &destination) {
        return Err(format!(
            "{} y {} son la misma carpeta o una está dentro de la otra.",
            source.display(),
            destination.display()
        ));
    }
    // Una copia que se cortó se repite desde el principio: lo que dejó a
    // medias se borra si la carpeta la creó ella.
    let previous = read_journal()?
        .entries
        .into_iter()
        .find(|entry| entry.id == item.id && entry.state == State::Copying);
    // Vacía cuenta como creada: `refresh_environment` crea vacías las
    // carpetas de las entradas activas.
    let destination_created = previous.as_ref().map_or_else(
        || !has_content(&destination),
        |entry| entry.destination_created,
    );
    if previous.is_some() && destination_created {
        remove_path(&destination).map_err(|error| format!("{}: {error}", destination.display()))?;
    }
    // Se apunta antes de copiar: si se corta, la siguiente lista lo sabe.
    update_journal(|journal| {
        journal.entries.retain(|entry| entry.id != item.id);
        journal.entries.push(JournalEntry {
            id: item.id.clone(),
            label: item.label.clone(),
            method: item.method,
            source: source.clone(),
            destination: destination.clone(),
            destination_created,
            backup: None,
            needs_admin: false,
            state: State::Copying,
            at: now(),
        });
    })?;
    let id = item.id.clone();
    let copied = copy_tree(&source, &destination, &mut |bytes| {
        set_progress(&id, |progress| progress.copied += bytes);
    });
    let strict = !merges(item.category);
    if let Err(error) = copied.and_then(|_| verify_copy(&source, &destination, strict)) {
        if destination_created {
            let _ = remove_path(&destination);
        }
        let _ = update_journal(|journal| journal.entries.retain(|entry| entry.id != item.id));
        return Err(error);
    }
    set_journal_state(&item.id, State::Done)
}

/// El nombre con el que se copia un archivo hasta que está entero: una copia
/// cortada nunca deja un archivo a medias con su nombre de verdad.
fn partial_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".wterminal-parcial");
    target.with_file_name(name)
}

fn copy_file(
    from: &Path,
    to: &Path,
    bytes: u64,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let partial = partial_path(to);
    if let Err(error) = std::fs::copy(from, &partial) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("{}: {error}", from.display()));
    }
    if let Err(error) = std::fs::rename(&partial, to) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("{}: {error}", to.display()));
    }
    on_bytes(bytes);
    Ok(())
}

/// Quita el prefijo `\\?\` que pone Windows al leer una unión.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix(r"\??\"))
    {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Vuelve a crear en la copia un enlace o una unión del original (`npm link`,
/// `rustup toolchain link`), con el mismo destino. Si apuntaba dentro del
/// original, apunta al mismo sitio dentro de la copia. Si ya había algo en
/// la copia (mezcla), se deja.
fn copy_link(link: &Path, target: &Path, source: &Path, destination: &Path) -> Result<(), String> {
    if target.symlink_metadata().is_ok() {
        return Ok(());
    }
    let pointed = plain_path(
        std::fs::read_link(link).map_err(|error| format!("{}: {error}", link.display()))?,
    );
    let pointed = match pointed.strip_prefix(source) {
        Ok(rest) if pointed.is_absolute() => destination.join(rest),
        _ => pointed,
    };
    create_link(link, &pointed, target)
        .map_err(|error| format!("No se pudo crear el enlace {}: {error}", target.display()))
}

#[cfg(windows)]
fn create_link(link: &Path, pointed: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::fs::FileTypeExt;
    // Una unión cuenta como enlace de carpeta (`is_symlink_dir`).
    let directory = link
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink_dir())
        .unwrap_or(false);
    if !directory {
        return std::os::windows::fs::symlink_file(pointed, target)
            .map_err(|error| error.to_string());
    }
    // Una unión no pide permisos de administrador ni el modo de
    // desarrollador, al contrario que un enlace simbólico de carpeta. Lleva
    // siempre ruta absoluta.
    let absolute = if pointed.is_absolute() {
        pointed.to_path_buf()
    } else {
        target
            .parent()
            .map(|parent| parent.join(pointed))
            .unwrap_or_else(|| pointed.to_path_buf())
    };
    let status = crate::process::hidden_command("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!(
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
                ps_quote(&target.to_string_lossy()),
                ps_quote(&absolute.to_string_lossy())
            ),
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() && target.symlink_metadata().is_ok() {
        Ok(())
    } else {
        Err("New-Item -ItemType Junction falló".to_string())
    }
}

#[cfg(not(windows))]
fn create_link(_link: &Path, pointed: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(pointed, target).map_err(|error| error.to_string())
}

/// Copia `source` en `destination` sin pisar lo que ya hubiera (mezcla). Los
/// enlaces y las uniones no se siguen: se vuelven a crear ([`copy_link`]).
/// Cada archivo se copia con otro nombre y se renombra al terminar
/// ([`partial_path`]). `on_bytes` recibe lo copiado.
pub fn copy_tree(
    source: &Path,
    destination: &Path,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let meta = source
        .symlink_metadata()
        .map_err(|error| format!("{}: {error}", source.display()))?;
    if meta.is_file() {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        if !destination.exists() {
            copy_file(source, destination, meta.len(), on_bytes)?;
        }
        return Ok(());
    }
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    // Los enlaces van al final: una unión no se puede crear hacia una
    // carpeta que aún no existe, y la que apunta dentro del original puede
    // salir antes que su carpeta.
    let mut links = Vec::new();
    while let Some((from, to)) = pending.pop() {
        std::fs::create_dir_all(&to).map_err(|error| format!("{}: {error}", to.display()))?;
        let entries =
            std::fs::read_dir(&from).map_err(|error| format!("{}: {error}", from.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("{}: {error}", from.display()))?;
            let path = entry.path();
            let target = to.join(entry.file_name());
            let Ok(meta) = path.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() || is_junction(&meta) {
                links.push((path, target));
            } else if meta.is_dir() {
                pending.push((path, target));
            } else if !target.exists() {
                copy_file(&path, &target, meta.len(), on_bytes)?;
            }
        }
    }
    for (link, target) in links {
        copy_link(&link, &target, source, destination)?;
    }
    Ok(())
}

/// Cada archivo y cada enlace del original están en la copia. Con `strict`
/// (las categorías que no mezclan) cada archivo tiene además su mismo
/// tamaño; al mezclar, un archivo que ya estaba en la carpeta propia vale
/// aunque sea de otra versión. Lo copiado ahora nunca queda a medias con su
/// nombre ([`partial_path`]).
pub fn verify_copy(source: &Path, destination: &Path, strict: bool) -> Result<(), String> {
    let meta = source
        .symlink_metadata()
        .map_err(|error| format!("{}: {error}", source.display()))?;
    let matches = |meta: &std::fs::Metadata, target: &Path| match target.symlink_metadata() {
        Ok(copy) => copy.is_file() && (!strict || copy.len() == meta.len()),
        Err(_) => false,
    };
    if meta.is_file() {
        return if matches(&meta, destination) {
            Ok(())
        } else {
            Err(format!(
                "Falta {} en la copia, o no tiene el mismo tamaño.",
                destination.display()
            ))
        };
    }
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    let mut missing = 0usize;
    let mut first_missing = None;
    while let Some((from, to)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&from) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let target = to.join(entry.file_name());
            let Ok(meta) = path.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() || is_junction(&meta) {
                if target.symlink_metadata().is_err() {
                    missing += 1;
                    first_missing.get_or_insert(target);
                }
            } else if meta.is_dir() {
                pending.push((path, target));
            } else if !matches(&meta, &target) {
                missing += 1;
                first_missing.get_or_insert(target);
            }
        }
    }
    match first_missing {
        None => Ok(()),
        Some(first) => Err(format!(
            "La copia no está completa: faltan {missing} archivos (por ejemplo {}).",
            first.display()
        )),
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_file() || meta.file_type().is_symlink() => std::fs::remove_file(path),
        Ok(_) => std::fs::remove_dir_all(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Una cadena entre comillas simples de PowerShell.
fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Ejecuta un script de PowerShell, elevado si hace falta, y devuelve lo
/// que dejó en su archivo de resultado (`ok` o `error: …`).
#[cfg(windows)]
fn run_program_script(body: &str, elevated: bool) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    // Cada llamada con su script y su resultado, aunque dos coincidan en el
    // mismo segundo (dos «Deshacer» seguidos).
    static RUNS: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir();
    let stamp = format!(
        "{}-{}-{}",
        std::process::id(),
        now(),
        RUNS.fetch_add(1, Ordering::Relaxed)
    );
    let script = dir.join(format!("wterminal-store-{stamp}.ps1"));
    let result = dir.join(format!("wterminal-store-{stamp}.txt"));
    let full = format!(
        "$ErrorActionPreference = 'Stop'\r\n$wtResult = {}\r\ntry {{\r\n{body}\r\nSet-Content -LiteralPath $wtResult -Value 'ok' -Encoding UTF8\r\n}} catch {{ Set-Content -LiteralPath $wtResult -Value ('error: ' + $_.Exception.Message) -Encoding UTF8 }}\r\n",
        ps_quote(&result.to_string_lossy())
    );
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(full.as_bytes());
    std::fs::write(&script, bytes).map_err(|error| error.to_string())?;
    let script_arg = script.to_string_lossy().into_owned();
    let status = if elevated {
        let launcher = format!(
            "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',{}",
            ps_quote(&format!("\"{script_arg}\""))
        );
        crate::process::hidden_command("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &launcher,
            ])
            .status()
    } else {
        crate::process::hidden_command("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script_arg,
            ])
            .status()
    };
    let _ = std::fs::remove_file(&script);
    let outcome = std::fs::read_to_string(&result).unwrap_or_default();
    let _ = std::fs::remove_file(&result);
    let outcome = outcome.trim_start_matches('\u{feff}').trim();
    match (status, outcome) {
        (_, "ok") => Ok(()),
        (_, text) if text.starts_with("error: ") => Err(text["error: ".len()..].to_string()),
        (Ok(_), _) => Err(
            "Se canceló la petición de permisos de administrador o el script no terminó."
                .to_string(),
        ),
        (Err(error), _) => Err(error.to_string()),
    }
}

#[cfg(not(windows))]
fn run_program_script(_body: &str, _elevated: bool) -> Result<(), String> {
    Err("Solo en Windows.".to_string())
}

fn backup_path(source: &Path) -> PathBuf {
    let mut name = source.file_name().unwrap_or_default().to_os_string();
    name.push(".wterminal-antes");
    source.with_file_name(name)
}

/// Programas: copia con robocopy, comprueba, renombra el original a
/// `<carpeta>.wterminal-antes` y deja una unión en su sitio. Con un proceso
/// abierto desde esa carpeta no se toca nada.
fn adopt_program(item: &AdoptItem) -> Result<(), String> {
    let source = PathBuf::from(&item.source);
    let destination = PathBuf::from(&item.destination);
    let backup = backup_path(&source);
    if backup.exists() {
        return Err(format!("Ya existe {}: quítalo antes.", backup.display()));
    }
    if is_link(&source) {
        return Err(format!("{} ya es una unión.", source.display()));
    }
    // Una copia que se cortó antes de renombrar el original: lo copiado a
    // medias es de WTerminal (el destino no existía) y se borra.
    let previous = read_journal()?
        .entries
        .into_iter()
        .find(|entry| entry.id == item.id && entry.state == State::Copying);
    if previous.is_some() {
        remove_path(&destination).map_err(|error| format!("{}: {error}", destination.display()))?;
    }
    if destination.exists() {
        return Err(format!(
            "Ya hay una carpeta {}: otro programa va al mismo sitio.",
            destination.display()
        ));
    }
    // Se apunta antes de lanzar el script: sigue aunque se cierre WTerminal,
    // y la siguiente lista lo concilia con el disco (`reconcile_programs`).
    update_journal(|journal| {
        journal.entries.retain(|entry| entry.id != item.id);
        journal.entries.push(JournalEntry {
            id: item.id.clone(),
            label: item.label.clone(),
            method: Method::Junction,
            source: source.clone(),
            destination: destination.clone(),
            destination_created: true,
            backup: Some(backup.clone()),
            needs_admin: item.needs_admin,
            state: State::Copying,
            at: now(),
        });
    })?;
    // Todo lo que va después de robocopy, dentro del try: si algo falla (un
    // código >= 8, una DLL cargada en el Explorador que impide renombrar, la
    // unión), el original recupera su nombre y la copia se borra, para poder
    // volver a intentarlo. /COPY:DATS lleva también las ACL.
    let body = format!(
        "$src = {src}; $dst = {dst}; $old = {old}\r\n\
         if (Test-Path -LiteralPath $dst) {{ throw ('Ya existe ' + $dst + ': otro programa va al mismo sitio.') }}\r\n\
         $busy = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path.StartsWith($src + '\\', [StringComparison]::OrdinalIgnoreCase) }})\r\n\
         if ($busy.Count -gt 0) {{ throw ('Está abierto (' + (($busy | Select-Object -ExpandProperty ProcessName -Unique) -join ', ') + '): ciérralo y vuelve a intentarlo.') }}\r\n\
         $renamed = $false\r\n\
         try {{\r\n\
         robocopy $src $dst /E /COPY:DATS /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null\r\n\
         $code = $LASTEXITCODE\r\n\
         if ($code -ge 8) {{ throw ('robocopy terminó con el código ' + $code) }}\r\n\
         $a = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force -ErrorAction SilentlyContinue).Count\r\n\
         $b = @(Get-ChildItem -LiteralPath $dst -Recurse -File -Force -ErrorAction SilentlyContinue).Count\r\n\
         if ($b -lt $a) {{ throw ('La copia tiene ' + $b + ' archivos de ' + $a) }}\r\n\
         Rename-Item -LiteralPath $src -NewName (Split-Path $old -Leaf)\r\n\
         $renamed = $true\r\n\
         New-Item -ItemType Junction -Path $src -Target $dst | Out-Null\r\n\
         }} catch {{\r\n\
         $failure = $_\r\n\
         if ($renamed) {{\r\n\
         $left = Get-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue\r\n\
         if ($left -and $left.LinkType -eq 'Junction') {{ cmd /c rmdir \"$src\" | Out-Null }}\r\n\
         Rename-Item -LiteralPath $old -NewName (Split-Path $src -Leaf)\r\n\
         }}\r\n\
         Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue\r\n\
         throw $failure\r\n\
         }}",
        src = ps_quote(&source.to_string_lossy()),
        dst = ps_quote(&destination.to_string_lossy()),
        old = ps_quote(&backup.to_string_lossy()),
    );
    if let Err(error) = run_program_script(&body, item.needs_admin) {
        // El script deshizo lo suyo. Si el original no recuperó su nombre,
        // la entrada se queda: la siguiente lista lo enseña para revisarlo.
        if !backup.exists() {
            let _ = update_journal(|journal| journal.entries.retain(|entry| entry.id != item.id));
        }
        return Err(error);
    }
    set_journal_state(&item.id, State::Done)
}

// ---- Confirmar y deshacer ----

fn journal_entry(id: &str) -> Result<JournalEntry, String> {
    read_journal()?
        .entries
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("«{id}» no está en el diario."))
}

/// Borra el original de algo ya traído. Desde aquí no hay vuelta atrás.
pub fn confirm(id: &str) -> Result<(), String> {
    let entry = journal_entry(id)?;
    if !matches!(entry.state, State::Done | State::Confirming) {
        return Err(format!("«{}» no está pendiente de confirmar.", entry.label));
    }
    if entry.method != Method::Junction
        && toolchain_store::paths_overlap(&entry.source, &entry.destination)
    {
        return Err(format!(
            "{} contiene la copia o está dentro de ella: no se borra.",
            entry.source.display()
        ));
    }
    // Antes de borrar nada: si el borrado se queda a medias (un archivo en
    // uso), deshacer ya no se ofrece, porque borraría la copia, que es la
    // única completa.
    set_journal_state(&entry.id, State::Confirming)?;
    match entry.method {
        Method::Variable | Method::Profile => remove_path(&entry.source)
            .map_err(|error| format!("{}: {error}", entry.source.display()))?,
        Method::Junction => {
            let backup = entry
                .backup
                .clone()
                .ok_or("Falta la copia de seguridad del original.")?;
            run_program_script(
                &format!(
                    "$old = {}\r\nif (Test-Path -LiteralPath $old) {{ Remove-Item -LiteralPath $old -Recurse -Force }}",
                    ps_quote(&backup.to_string_lossy())
                ),
                entry.needs_admin,
            )?;
        }
    }
    set_journal_state(&entry.id, State::Confirmed)
}

/// Vuelve a dejarlo como estaba: la variable deja de apuntar a la copia (o se
/// quita la unión y el original recupera su nombre) y se borra la copia si su
/// carpeta no existía antes. Solo antes de confirmar.
pub fn undo(id: &str) -> Result<(), String> {
    let entry = journal_entry(id)?;
    if entry.state != State::Done {
        return Err(format!(
            "«{}» ya se confirmó (o se empezó a confirmar): el original se borró y no se puede deshacer.",
            entry.label
        ));
    }
    match entry.method {
        Method::Variable | Method::Profile => {
            // Sin el original, deshacer borraría la única copia.
            if !has_content(&entry.source) {
                return Err(format!(
                    "El original ya no está en {}: deshacer borraría la única copia. Confírmalo para quedarte con la copia.",
                    entry.source.display()
                ));
            }
            update_journal(|journal| journal.entries.retain(|found| found.id != entry.id))?;
            if entry.destination_created {
                let _ = remove_path(&entry.destination);
            }
        }
        Method::Junction => {
            let backup = entry
                .backup
                .clone()
                .ok_or("Falta la copia de seguridad del original.")?;
            run_program_script(
                &format!(
                    "$src = {src}; $dst = {dst}; $old = {old}\r\n\
                     if (-not (Test-Path -LiteralPath $old)) {{ throw ('Falta ' + $old + ': el original ya no está. No se toca la unión: confírmalo para quedarte con la copia.') }}\r\n\
                     $item = Get-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue\r\n\
                     if ($item -and $item.LinkType -eq 'Junction') {{ cmd /c rmdir \"$src\" | Out-Null }}\r\n\
                     if (Test-Path -LiteralPath $src) {{ throw ('Sigue existiendo ' + $src + ': no es la unión que dejó WTerminal.') }}\r\n\
                     Rename-Item -LiteralPath $old -NewName (Split-Path $src -Leaf)\r\n\
                     Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue",
                    src = ps_quote(&entry.source.to_string_lossy()),
                    dst = ps_quote(&entry.destination.to_string_lossy()),
                    old = ps_quote(&backup.to_string_lossy()),
                ),
                entry.needs_admin,
            )?;
            update_journal(|journal| journal.entries.retain(|found| found.id != entry.id))?;
        }
    }
    PROGRESS.lock().remove(&entry.id);
    let preferences = crate::preferences::current();
    toolchain_store::sync_layout(&preferences);
    toolchain_store::refresh_environment();
    let _ = crate::platform::path_integration::sync_tool_bins();
    Ok(())
}

// ---- Exportar e importar la lista ----

const EXPORT_FORMAT: &str = "wterminal-store-v1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreExport {
    pub format: String,
    pub enabled: bool,
    /// Vacía = la de fábrica del otro equipo.
    pub root: String,
    pub categories: HashMap<String, bool>,
    pub category_dirs: String,
    pub disabled: String,
    /// Acciones «Instalar» del catálogo que aquí están instaladas.
    pub installed: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAction {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreImportResult {
    pub ok: bool,
    pub error: Option<String>,
    pub missing: Vec<MissingAction>,
    pub unknown: Vec<String>,
}

fn category_flags(preferences: &crate::preferences::Preferences) -> HashMap<String, bool> {
    let categories = toolchain_store::Categories::from_preferences(preferences);
    Category::ALL
        .into_iter()
        .filter(|category| *category != Category::Caches)
        .map(|category| (category.id().to_string(), categories.includes(category)))
        .collect()
}

/// Lo instalado del catálogo. La lista completa (`visible`, la que guardó
/// la comprobación de Dependencias) QUITA las instalaciones que su sonda da
/// por hechas: lo instalado son las acciones «Instalar» con sonda del
/// catálogo sin filtrar (`probed`, `commands_install::probed_install_ids`)
/// que no salen en ella.
pub fn installed_catalog_ids(
    visible: &[crate::install_actions::InstallAction],
    probed: &[String],
) -> Vec<String> {
    let shown: std::collections::HashSet<&str> =
        visible.iter().map(|action| action.id.as_str()).collect();
    let mut ids: Vec<String> = probed
        .iter()
        .filter(|id| !shown.contains(id.as_str()))
        .cloned()
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

pub fn export_text(installed: Vec<String>) -> Result<String, String> {
    let preferences = crate::preferences::current();
    let export = StoreExport {
        format: EXPORT_FORMAT.to_string(),
        enabled: preferences.toolchain_store_enabled,
        root: preferences.toolchain_store_dir.clone(),
        categories: category_flags(&preferences),
        category_dirs: preferences.toolchain_store_category_dirs.clone(),
        disabled: preferences.toolchain_store_disabled.clone(),
        installed,
    };
    serde_json::to_string_pretty(&export).map_err(|error| error.to_string())
}

/// Lee una lista exportada: devuelve el cambio de preferencias que hay que
/// guardar (JSON con las mismas claves que Ajustes) y qué falta instalar.
/// `actions` es la lista completa de este equipo y `probed` el catálogo sin
/// filtrar (ver [`installed_catalog_ids`]): una acción que está en el
/// catálogo pero no en la lista ya está instalada aquí.
pub fn import_plan(
    text: &str,
    actions: &[crate::install_actions::InstallAction],
    probed: &[String],
) -> Result<(serde_json::Value, StoreImportResult), String> {
    let export: StoreExport = serde_json::from_str(text)
        .map_err(|error| format!("No es una lista de WTerminal: {error}"))?;
    if export.format != EXPORT_FORMAT {
        return Err(format!("Formato desconocido: {}", export.format));
    }
    let mut patch = serde_json::Map::new();
    patch.insert("toolchainStoreEnabled".into(), export.enabled.into());
    patch.insert("toolchainStoreDir".into(), export.root.clone().into());
    patch.insert(
        "toolchainStoreCategoryDirs".into(),
        export.category_dirs.clone().into(),
    );
    patch.insert(
        "toolchainStoreDisabled".into(),
        export.disabled.clone().into(),
    );
    for (id, enabled) in &export.categories {
        if let Some(key) = category_preference_key(id) {
            patch.insert(key.into(), (*enabled).into());
        }
    }
    let mut missing = Vec::new();
    let mut unknown = Vec::new();
    for id in &export.installed {
        match actions.iter().find(|action| &action.id == id) {
            Some(action) if action.installed != Some(true) => missing.push(MissingAction {
                id: action.id.clone(),
                label: action.label.clone(),
            }),
            Some(_) => {}
            None if probed.iter().any(|known| known == id) => {}
            None => unknown.push(id.clone()),
        }
    }
    Ok((
        serde_json::Value::Object(patch),
        StoreImportResult {
            ok: true,
            error: None,
            missing,
            unknown,
        },
    ))
}

/// Guarda solo las claves del parche, validadas igual que desde Ajustes (lo
/// demás se queda como estaba). `settings::save_settings` recalcula la
/// carpeta propia y el PATH al ver claves `toolchainStore*`.
fn apply_preferences_patch(patch: &serde_json::Value) -> Result<(), String> {
    let serde_json::Value::Object(patch) = patch else {
        return Err("Parche de preferencias no válido.".to_string());
    };
    let mut merged = crate::settings::load_settings();
    for (key, value) in patch {
        merged.insert(key.clone(), value.clone());
    }
    let sanitized = crate::preferences::sanitize_preferences(&serde_json::Value::Object(merged));
    let serde_json::Value::Object(all) =
        serde_json::to_value(&sanitized).map_err(|error| error.to_string())?
    else {
        return Err("Las preferencias no se pudieron serializar.".to_string());
    };
    let only: serde_json::Map<String, serde_json::Value> = all
        .into_iter()
        .filter(|(key, _)| patch.contains_key(key))
        .collect();
    crate::settings::save_settings(&only)
        .map(|_| ())
        .ok_or_else(|| "No se pudieron guardar las preferencias.".to_string())
}

fn category_preference_key(id: &str) -> Option<&'static str> {
    Some(match Category::from_id(id)? {
        Category::Caches => return None,
        Category::Downloads => "toolchainStoreDownloads",
        Category::AiModels => "toolchainStoreAiModels",
        Category::Tools => "toolchainStoreTools",
        Category::ReplHistory => "toolchainStoreReplHistory",
        Category::Toolchains => "toolchainStoreToolchains",
        Category::Programs => "toolchainStorePrograms",
        Category::Projects => "toolchainStoreProjects",
        Category::Config => "toolchainStoreConfig",
        Category::Plugins => "toolchainStorePlugins",
    })
}

// ---- Órdenes de Tauri ----

/// La vista previa de «Traer lo ya instalado».
#[tauri::command]
pub async fn store_adopt_candidates() -> Result<Vec<AdoptItem>, String> {
    tauri::async_runtime::spawn_blocking(candidates)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn store_adopt_run(ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || adopt(ids))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn store_adopt_confirm(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || confirm(&id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn store_adopt_undo(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || undo(&id))
        .await
        .map_err(|error| error.to_string())?
}

/// La lista completa de Dependencias, esperando a la comprobación de fondo si
/// está en marcha. `None` si no hay (sin abrir Dependencias, tras instalar
/// algo, en bajo consumo): sin ella no se sabe qué está instalado.
fn complete_catalog(
    state: &crate::state::AppState,
) -> Option<Vec<crate::install_actions::InstallAction>> {
    state.wait_for_install_prefetch(Duration::from_secs(30))
}

const CATALOG_NEEDED: &str = "Abre «Entorno y dependencias» y espera a que termine la comprobación: sin ella no se sabe qué tienes instalado. Después vuelve a intentarlo.";

/// Escribe la lista en `path` (elegido con el diálogo de guardar).
#[tauri::command]
pub async fn store_export(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let actions = complete_catalog(&state).ok_or_else(|| CATALOG_NEEDED.to_string())?;
        let probed = crate::commands_install::probed_install_ids(state.inventory().pkg_manager);
        let text = export_text(installed_catalog_ids(&actions, &probed))?;
        std::fs::write(&path, text).map_err(|error| format!("{path}: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Lee una lista exportada, guarda sus ajustes de la carpeta propia y dice
/// qué acciones del catálogo faltan aquí para instalarlas desde la vista.
#[tauri::command]
pub async fn store_import(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    path: String,
) -> Result<StoreImportResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || import_from(&state, &path))
        .await
        .map_err(|error| error.to_string())
}

fn import_from(state: &crate::state::AppState, path: &str) -> StoreImportResult {
    let failed = |error: String| StoreImportResult {
        ok: false,
        error: Some(error),
        missing: Vec::new(),
        unknown: Vec::new(),
    };
    let Some(actions) = complete_catalog(state) else {
        return failed(CATALOG_NEEDED.to_string());
    };
    let probed = crate::commands_install::probed_install_ids(state.inventory().pkg_manager);
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => return failed(format!("{path}: {error}")),
    };
    let (patch, result) = match import_plan(&text, &actions, &probed) {
        Ok(plan) => plan,
        Err(error) => return failed(error),
    };
    if let Err(error) = apply_preferences_patch(&patch) {
        return failed(error);
    }
    toolchain_store::refresh_environment();
    let _ = crate::platform::path_integration::sync_tool_bins();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copiar_mezcla_sin_pisar_y_comprueba_cada_archivo() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("origen");
        let destination = dir.path().join("destino");
        std::fs::create_dir_all(source.join("sub")).unwrap();
        std::fs::write(source.join("a.txt"), "aaaa").unwrap();
        std::fs::write(source.join("sub").join("b.txt"), "bb").unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("a.txt"), "ya estaba").unwrap();
        let mut copied = 0;
        copy_tree(&source, &destination, &mut |bytes| copied += bytes).unwrap();
        // `a.txt` ya estaba: no se pisa ni cuenta.
        assert_eq!(copied, 2);
        assert_eq!(
            std::fs::read_to_string(destination.join("a.txt")).unwrap(),
            "ya estaba"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("sub").join("b.txt")).unwrap(),
            "bb"
        );
        verify_copy(&source, &destination, false).unwrap();
        // Sin mezclar, cada archivo tiene que tener su tamaño: `a.txt` no.
        assert!(verify_copy(&source, &destination, true).is_err());
        // Nunca queda un archivo a medias con otro nombre.
        assert!(!partial_path(&destination.join("sub").join("b.txt")).exists());
        std::fs::remove_file(destination.join("sub").join("b.txt")).unwrap();
        let error = verify_copy(&source, &destination, false).unwrap_err();
        assert!(error.contains("faltan 1"), "{error}");
    }

    #[test]
    fn una_copia_cortada_no_pasa_la_comprobacion() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("origen");
        let destination = dir.path().join("destino");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("modelo.bin"), vec![7u8; 4096]).unwrap();
        // Lo que dejaría un cierre a mitad de un std::fs::copy.
        std::fs::write(destination.join("modelo.bin"), vec![7u8; 100]).unwrap();
        let error = verify_copy(&source, &destination, true).unwrap_err();
        assert!(error.contains("faltan 1"), "{error}");
    }

    #[cfg(windows)]
    #[test]
    fn los_enlaces_del_original_se_vuelven_a_crear_en_la_copia() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("origen");
        let destination = dir.path().join("destino");
        std::fs::create_dir_all(source.join("real")).unwrap();
        std::fs::write(source.join("real").join("pkg.txt"), "x").unwrap();
        // Una unión como la de `npm link`, hacia dentro del original.
        create_link_for_test(&source.join("real"), &source.join("enlace"));
        copy_tree(&source, &destination, &mut |_| {}).unwrap();
        let copied = destination.join("enlace");
        assert!(is_link(&copied), "la unión no está en la copia");
        let pointed = plain_path(std::fs::read_link(&copied).unwrap());
        assert!(
            toolchain_store::paths_overlap(&pointed, &destination.join("real")),
            "{}",
            pointed.display()
        );
        verify_copy(&source, &destination, true).unwrap();
        // Una unión que falta en la copia se echa en falta.
        std::process::Command::new("cmd")
            .args(["/c", "rmdir", &copied.to_string_lossy()])
            .status()
            .unwrap();
        assert!(verify_copy(&source, &destination, true).is_err());
    }

    #[cfg(windows)]
    fn create_link_for_test(target: &Path, link: &Path) {
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
                    ps_quote(&link.to_string_lossy()),
                    ps_quote(&target.to_string_lossy())
                ),
            ])
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn un_archivo_suelto_se_copia_como_archivo() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("historial");
        let destination = dir.path().join("propia").join("historial");
        std::fs::write(&source, "ls\npwd\n").unwrap();
        let mut copied = 0;
        copy_tree(&source, &destination, &mut |bytes| copied += bytes).unwrap();
        assert_eq!(copied, 7);
        verify_copy(&source, &destination, true).unwrap();
    }

    #[test]
    fn el_id_de_un_programa_no_depende_de_mayusculas_ni_de_la_barra_final() {
        assert_eq!(
            program_id(Path::new(r"C:\Program Files\Julia")),
            program_id(Path::new(r"c:\program files\julia\"))
        );
        assert_ne!(
            program_id(Path::new(r"C:\Program Files\Julia")),
            program_id(Path::new(r"C:\Program Files\Go"))
        );
    }

    #[test]
    fn el_original_de_un_programa_se_guarda_al_lado_con_otro_nombre() {
        assert_eq!(
            backup_path(Path::new(r"C:\Program Files\Julia")),
            PathBuf::from(r"C:\Program Files\Julia.wterminal-antes")
        );
    }

    #[test]
    fn las_comillas_simples_no_rompen_el_script() {
        assert_eq!(ps_quote(r"C:\D'Artagnan"), r"'C:\D''Artagnan'");
    }

    #[test]
    fn solo_se_mezcla_lo_que_se_puede_regenerar_y_las_herramientas() {
        assert!(merges(Category::Caches));
        assert!(merges(Category::Tools));
        assert!(!merges(Category::Toolchains));
        assert!(!merges(Category::Config));
        assert!(!merges(Category::ReplHistory));
    }

    fn accion(
        id: &str,
        installed: Option<bool>,
        verb: Option<&str>,
    ) -> crate::install_actions::InstallAction {
        let mut action = crate::install_actions::InstallAction::new(id, id, "comando");
        action.check_cmd = Some("x".to_string());
        action.installed = installed;
        action.verb = verb.map(str::to_string);
        action
    }

    #[test]
    fn exportar_lleva_lo_que_la_lista_quito_por_instalado() {
        // Como queda tras `filter_available_actions`: la instalación de Git
        // ya no sale (su sonda la da por hecha) y quedan su actualizar y la
        // instalación de Go, que falta.
        let visible = vec![
            accion("winget-go", Some(false), None),
            accion("winget-git-update", Some(true), Some("Actualizar")),
        ];
        let probed = vec!["winget-git".to_string(), "winget-go".to_string()];
        assert_eq!(
            installed_catalog_ids(&visible, &probed),
            vec!["winget-git".to_string()]
        );
        // Con la lista entera visible (nada instalado), no se exporta nada.
        assert!(installed_catalog_ids(&visible, &["winget-go".to_string()]).is_empty());
    }

    #[test]
    fn importar_dice_que_falta_y_que_no_conoce_este_catalogo() {
        // Git ya está instalado aquí: la lista no lo enseña, pero el
        // catálogo lo conoce.
        let actions = vec![accion("winget-go", Some(false), None)];
        let probed = vec!["winget-git".to_string(), "winget-go".to_string()];
        let text = serde_json::json!({
            "format": EXPORT_FORMAT,
            "enabled": true,
            "root": "E:\\WTerminal\\entornos",
            "categories": { "tools": false, "programs": true, "inventada": true },
            "categoryDirs": "caches=D:\\caches",
            "disabled": "npm",
            "installed": ["winget-git", "winget-go", "pkg-solo-linux"],
        })
        .to_string();
        let (patch, result) = import_plan(&text, &actions, &probed).unwrap();
        assert_eq!(patch["toolchainStoreTools"], serde_json::json!(false));
        assert_eq!(patch["toolchainStorePrograms"], serde_json::json!(true));
        assert_eq!(patch["toolchainStoreDisabled"], serde_json::json!("npm"));
        assert!(patch.get("inventada").is_none());
        assert_eq!(result.missing.len(), 1);
        assert_eq!(result.missing[0].id, "winget-go");
        assert_eq!(result.unknown, vec!["pkg-solo-linux".to_string()]);
        assert!(import_plan("{\"format\":\"otro\"}", &actions, &probed).is_err());
    }
}
