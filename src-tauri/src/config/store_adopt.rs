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
    Copying,
    /// Copiado y en uso; el original sigue en su sitio hasta confirmar.
    Done,
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

fn read_journal() -> Journal {
    if cfg!(test) {
        return Journal::default();
    }
    std::fs::read_to_string(journal_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_journal(journal: &Journal) -> Result<(), String> {
    if cfg!(test) {
        return Ok(());
    }
    let text = serde_json::to_string_pretty(journal).map_err(|error| error.to_string())?;
    let path = journal_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, text).map_err(|error| error.to_string())
}

static JOURNAL_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn update_journal(change: impl FnOnce(&mut Journal)) -> Result<(), String> {
    let _guard = JOURNAL_LOCK.lock();
    let mut journal = read_journal();
    change(&mut journal);
    write_journal(&journal)
}

/// Ids traídos con variable o perfil (copiados y en uso): la carpeta propia
/// los reubica aunque existieran en su sitio de siempre.
pub fn adopted_variable_ids() -> Vec<String> {
    read_journal()
        .entries
        .into_iter()
        .filter(|entry| {
            matches!(entry.method, Method::Variable | Method::Profile)
                && matches!(entry.state, State::Done | State::Confirmed)
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
pub fn candidates() -> Vec<AdoptItem> {
    let preferences = crate::preferences::current();
    toolchain_store::sync_layout(&preferences);
    let journal = read_journal();
    let progress = PROGRESS.lock().clone();
    let mut items = Vec::new();
    let Some(root) = toolchain_store::effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    ) else {
        return items;
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
                || program.location.starts_with(&root)
                || program.location.starts_with(&programs_dir)
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
    items
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
    let items = candidates();
    let mut chosen = Vec::new();
    for id in &ids {
        let Some(item) = items.iter().find(|item| &item.id == id) else {
            return Err(format!(
                "«{id}» ya no se puede traer: vuelve a abrir la lista."
            ));
        };
        if item.state != State::Available && item.state != State::Failed {
            return Err(format!("«{}» no se puede traer ahora.", item.label));
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
    let destination_created = !destination.exists();
    let id = item.id.clone();
    let copied = copy_tree(&source, &destination, &mut |bytes| {
        set_progress(&id, |progress| progress.copied += bytes);
    });
    if let Err(error) = copied.and_then(|_| verify_copy(&source, &destination)) {
        if destination_created {
            let _ = remove_path(&destination);
        }
        return Err(error);
    }
    update_journal(|journal| {
        journal.entries.retain(|entry| entry.id != item.id);
        journal.entries.push(JournalEntry {
            id: item.id.clone(),
            label: item.label.clone(),
            method: item.method,
            source,
            destination,
            destination_created,
            backup: None,
            needs_admin: false,
            state: State::Done,
            at: now(),
        });
    })
}

/// Copia `source` en `destination` sin pisar lo que ya hubiera (mezcla) y
/// sin seguir enlaces ni uniones. `on_bytes` recibe lo copiado.
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
            std::fs::copy(source, destination)
                .map_err(|error| format!("{}: {error}", source.display()))?;
            on_bytes(meta.len());
        }
        return Ok(());
    }
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
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
                // Un enlace dentro de una caché o una toolchain apunta fuera
                // de ella: no se copia lo que hay al otro lado.
                continue;
            }
            if meta.is_dir() {
                pending.push((path, target));
            } else if !target.exists() {
                std::fs::copy(&path, &target)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                on_bytes(meta.len());
            }
        }
    }
    Ok(())
}

/// Cada archivo del original está en la copia con su mismo tamaño (o uno
/// que ya estaba allí, en las categorías que mezclan).
pub fn verify_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let meta = source
        .symlink_metadata()
        .map_err(|error| format!("{}: {error}", source.display()))?;
    if meta.is_file() {
        return if destination.is_file() {
            Ok(())
        } else {
            Err(format!("Falta {} en la copia.", destination.display()))
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
                continue;
            }
            if meta.is_dir() {
                pending.push((path, target));
            } else if !target.is_file() {
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
    let dir = std::env::temp_dir();
    let stamp = format!("{}-{}", std::process::id(), now());
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
    let body = format!(
        "$src = {src}; $dst = {dst}; $old = {old}\r\n\
         $busy = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and $_.Path.StartsWith($src + '\\', [StringComparison]::OrdinalIgnoreCase) }})\r\n\
         if ($busy.Count -gt 0) {{ throw ('Está abierto (' + (($busy | Select-Object -ExpandProperty ProcessName -Unique) -join ', ') + '): ciérralo y vuelve a intentarlo.') }}\r\n\
         robocopy $src $dst /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null\r\n\
         if ($LASTEXITCODE -ge 8) {{ throw ('robocopy terminó con el código ' + $LASTEXITCODE) }}\r\n\
         $a = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force -ErrorAction SilentlyContinue).Count\r\n\
         $b = @(Get-ChildItem -LiteralPath $dst -Recurse -File -Force -ErrorAction SilentlyContinue).Count\r\n\
         if ($b -lt $a) {{ Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue; throw ('La copia tiene ' + $b + ' archivos de ' + $a) }}\r\n\
         Rename-Item -LiteralPath $src -NewName (Split-Path $old -Leaf)\r\n\
         try {{ New-Item -ItemType Junction -Path $src -Target $dst | Out-Null }} catch {{ Rename-Item -LiteralPath $old -NewName (Split-Path $src -Leaf); throw }}",
        src = ps_quote(&source.to_string_lossy()),
        dst = ps_quote(&destination.to_string_lossy()),
        old = ps_quote(&backup.to_string_lossy()),
    );
    run_program_script(&body, item.needs_admin)?;
    update_journal(|journal| {
        journal.entries.retain(|entry| entry.id != item.id);
        journal.entries.push(JournalEntry {
            id: item.id.clone(),
            label: item.label.clone(),
            method: Method::Junction,
            source,
            destination,
            destination_created: true,
            backup: Some(backup),
            needs_admin: item.needs_admin,
            state: State::Done,
            at: now(),
        });
    })
}

// ---- Confirmar y deshacer ----

fn journal_entry(id: &str) -> Result<JournalEntry, String> {
    read_journal()
        .entries
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("«{id}» no está en el diario."))
}

/// Borra el original de algo ya traído. Desde aquí no hay vuelta atrás.
pub fn confirm(id: &str) -> Result<(), String> {
    let entry = journal_entry(id)?;
    if entry.state != State::Done {
        return Err(format!("«{}» no está pendiente de confirmar.", entry.label));
    }
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
                    "Remove-Item -LiteralPath {} -Recurse -Force",
                    ps_quote(&backup.to_string_lossy())
                ),
                entry.needs_admin,
            )?;
        }
    }
    update_journal(|journal| {
        if let Some(found) = journal
            .entries
            .iter_mut()
            .find(|found| found.id == entry.id)
        {
            found.state = State::Confirmed;
            found.at = now();
        }
    })
}

/// Vuelve a dejarlo como estaba: la variable deja de apuntar a la copia (o se
/// quita la unión y el original recupera su nombre) y se borra la copia si su
/// carpeta no existía antes. Solo antes de confirmar.
pub fn undo(id: &str) -> Result<(), String> {
    let entry = journal_entry(id)?;
    if entry.state != State::Done {
        return Err(format!(
            "«{}» ya se confirmó: el original se borró y no se puede deshacer.",
            entry.label
        ));
    }
    match entry.method {
        Method::Variable | Method::Profile => {
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

/// Lo instalado del catálogo: las acciones sin verbo propio («Instalar») con
/// sonda y que la sonda da por instaladas.
pub fn installed_catalog_ids(actions: &[crate::install_actions::InstallAction]) -> Vec<String> {
    let mut ids: Vec<String> = actions
        .iter()
        .filter(|action| {
            action.verb.is_none() && action.check_cmd.is_some() && action.installed == Some(true)
        })
        .map(|action| action.id.clone())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

pub fn export_text(actions: &[crate::install_actions::InstallAction]) -> Result<String, String> {
    let preferences = crate::preferences::current();
    let export = StoreExport {
        format: EXPORT_FORMAT.to_string(),
        enabled: preferences.toolchain_store_enabled,
        root: preferences.toolchain_store_dir.clone(),
        categories: category_flags(&preferences),
        category_dirs: preferences.toolchain_store_category_dirs.clone(),
        disabled: preferences.toolchain_store_disabled.clone(),
        installed: installed_catalog_ids(actions),
    };
    serde_json::to_string_pretty(&export).map_err(|error| error.to_string())
}

/// Lee una lista exportada: devuelve el cambio de preferencias que hay que
/// guardar (JSON con las mismas claves que Ajustes) y qué falta instalar.
pub fn import_plan(
    text: &str,
    actions: &[crate::install_actions::InstallAction],
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
pub async fn store_adopt_candidates() -> Vec<AdoptItem> {
    tauri::async_runtime::spawn_blocking(candidates)
        .await
        .unwrap_or_default()
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

/// Escribe la lista en `path` (elegido con el diálogo de guardar).
#[tauri::command]
pub fn store_export(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    path: String,
) -> Result<(), String> {
    let actions = state.install_actions().unwrap_or_default();
    let text = export_text(&actions)?;
    std::fs::write(&path, text).map_err(|error| format!("{path}: {error}"))
}

/// Lee una lista exportada, guarda sus ajustes de la carpeta propia y dice
/// qué acciones del catálogo faltan aquí para instalarlas desde la vista.
#[tauri::command]
pub fn store_import(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    path: String,
) -> StoreImportResult {
    let failed = |error: String| StoreImportResult {
        ok: false,
        error: Some(error),
        missing: Vec::new(),
        unknown: Vec::new(),
    };
    let Some(actions) = state.install_actions() else {
        return failed(
            "Abre «Entorno y dependencias» una vez para cargar el catálogo y vuelve a importar."
                .to_string(),
        );
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => return failed(format!("{path}: {error}")),
    };
    let (patch, result) = match import_plan(&text, &actions) {
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
        verify_copy(&source, &destination).unwrap();
        std::fs::remove_file(destination.join("sub").join("b.txt")).unwrap();
        let error = verify_copy(&source, &destination).unwrap_err();
        assert!(error.contains("faltan 1"), "{error}");
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
        verify_copy(&source, &destination).unwrap();
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
    fn exportar_lleva_solo_las_instalaciones_que_estan_hechas() {
        let actions = vec![
            accion("winget-git", Some(true), None),
            accion("winget-go", Some(false), None),
            accion("winget-git-update", Some(true), Some("Actualizar")),
        ];
        assert_eq!(
            installed_catalog_ids(&actions),
            vec!["winget-git".to_string()]
        );
    }

    #[test]
    fn importar_dice_que_falta_y_que_no_conoce_este_catalogo() {
        let actions = vec![
            accion("winget-git", Some(true), None),
            accion("winget-go", Some(false), None),
        ];
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
        let (patch, result) = import_plan(&text, &actions).unwrap();
        assert_eq!(patch["toolchainStoreTools"], serde_json::json!(false));
        assert_eq!(patch["toolchainStorePrograms"], serde_json::json!(true));
        assert_eq!(patch["toolchainStoreDisabled"], serde_json::json!("npm"));
        assert!(patch.get("inventada").is_none());
        assert_eq!(result.missing.len(), 1);
        assert_eq!(result.missing[0].id, "winget-go");
        assert_eq!(result.unknown, vec!["pkg-solo-linux".to_string()]);
        assert!(import_plan("{\"format\":\"otro\"}", &actions).is_err());
    }
}
