//! Listado y manipulación de archivos/carpetas para el explorador lateral.
//!
//! Port de `electron/main/fileExplorer.js`.
//!
//! Reglas que este módulo garantiza, y de las que depende quien lo llama:
//!   - un nombre nuevo es SOLO un nombre: sin separadores, sin `..`, sin
//!     unidades ni caracteres de control, y el resultado debe quedar dentro de
//!     la carpeta mostrada (se comprueba resolviendo la ruta, no confiando en
//!     la cadena),
//!   - nunca se sobrescribe algo existente,
//!   - el listado no sigue enlaces simbólicos al decidir qué es carpeta, para
//!     que un enlace no lleve el árbol fuera de donde el usuario cree estar.

use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_ENTRIES: usize = 2000;
const MAX_NAME_LENGTH: usize = 255;

/// Nombres reservados de Windows: crear "CON.txt" o "aux" produce errores muy
/// confusos, así que se rechazan en todas las plataformas para que la carpeta
/// signifique lo mismo en cualquier sistema.
#[rustfmt::skip]
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn is_windows_style_path(value: &str) -> bool {
    if value.starts_with("\\\\") {
        return true;
    }
    let mut chars = value.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), Some('\\' | '/')) if letter.is_ascii_alphabetic()
    )
}

/// El backend corre en Windows aunque la pestaña sea de WSL: las rutas
/// traducidas al host siguen siendo rutas de Windows, así que el separador
/// correcto depende de la ruta, no del proceso.
fn separator_for(value: &str) -> char {
    if is_windows_style_path(value) {
        '\\'
    } else {
        '/'
    }
}

pub fn is_safe_entry_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_NAME_LENGTH {
        return false;
    }
    if trimmed == "." || trimmed == ".." {
        return false;
    }
    // Caracteres de control (0x00-0x1f y 0x7f): invisibles en la interfaz y
    // capaces de romper el nombre real en disco.
    if trimmed
        .chars()
        .any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
    {
        return false;
    }
    // Separadores de ruta: un nombre nuevo es solo un nombre, nunca una ruta.
    if trimmed.contains('\\') || trimmed.contains('/') {
        return false;
    }
    // Reservados de Windows, con o sin extensión (CON, con.txt).
    let stem = trimmed.split('.').next().unwrap_or("").to_lowercase();
    if WINDOWS_RESERVED_NAMES.contains(&stem.as_str()) {
        return false;
    }
    // Caracteres que Windows no admite en un nombre de archivo.
    !trimmed.contains(['<', '>', ':', '"', '|', '?', '*'])
}

const INVALID_NAME: &str =
    "Nombre no válido. No puede contener rutas, \"..\", ni los caracteres < > : \" | ? *";

/// Une carpeta + nombre comprobando que el resultado sigue siendo un hijo
/// DIRECTO de la carpeta. Devuelve `None` si no lo es.
pub fn resolve_child_path(directory: &str, name: &str) -> Option<PathBuf> {
    if directory.is_empty() || !is_safe_entry_name(name) {
        return None;
    }
    let separator = separator_for(directory);
    let parent = directory.trim_end_matches(separator);
    Some(PathBuf::from(format!("{parent}{separator}{}", name.trim())))
}

pub fn parent_directory(directory: &str) -> Option<String> {
    if directory.is_empty() {
        return None;
    }
    let separator = separator_for(directory);
    let trimmed = directory.trim_end_matches(separator);
    let index = trimmed.rfind(separator)?;
    // La raíz de una unidad (`C:\`) o de un sistema de archivos (`/`) no tiene
    // padre: ahí el explorador ya está arriba del todo.
    let parent = if index == 0 {
        separator.to_string()
    } else {
        trimmed[..index].to_string()
    };
    let normalized = |value: &str| {
        if is_windows_style_path(value) {
            value.to_lowercase()
        } else {
            value.to_string()
        }
    };
    if normalized(&parent) == normalized(trimmed) || parent.is_empty() {
        None
    } else {
        Some(parent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// Es un enlace simbólico. Se muestra como lo que apunta, pero etiquetado:
    /// así el usuario sabe que al entrar puede acabar en otra parte del disco.
    pub link: bool,
    pub hidden: bool,
    pub size: u64,
    /// Milisegundos desde la época, como los daba `mtimeMs`.
    pub modified: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub ok: bool,
    pub dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Se alcanzó el tope de entradas: la carpeta tiene más de las que caben.
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Listing {
    fn failed(dir: &str, error: impl Into<String>) -> Listing {
        Listing {
            ok: false,
            dir: dir.to_string(),
            // El padre se rellena TAMBIÉN cuando la carpeta no se puede leer, y
            // es justo el caso en el que hace falta: sin él, el botón de subir
            // se queda deshabilitado y quien entre en una carpeta sin permisos
            // —las uniones heredadas del perfil, como «Configuración local»— se
            // queda encerrado ahí sin manera evidente de salir.
            //
            // Calcularlo no toca el disco: `parent_directory` recorta la ruta,
            // así que funciona igual en una carpeta ilegible o desaparecida.
            parent: parent_directory(dir),
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

fn describe_io_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "El archivo o la carpeta ya no existe.".into(),
        std::io::ErrorKind::PermissionDenied => "No hay permisos para hacer esto aquí.".into(),
        std::io::ErrorKind::AlreadyExists => {
            "Ya existe un archivo o carpeta con ese nombre.".into()
        }
        _ => error.to_string(),
    }
}

fn modified_millis(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Lista una carpeta: primero directorios, después archivos, y ambos por
/// nombre. No falla si la carpeta desaparece o no es legible: devuelve el error
/// para que la interfaz lo muestre en su sitio.
pub fn list_directory(directory: &str) -> Listing {
    if directory.is_empty() {
        return Listing::failed("", "No hay una carpeta que mostrar.");
    }
    let path = Path::new(directory);
    match std::fs::metadata(path) {
        Ok(meta) if !meta.is_dir() => {
            return Listing::failed(directory, "La ruta actual no es una carpeta.")
        }
        Err(error) => {
            let message = match error.kind() {
                std::io::ErrorKind::NotFound => "La carpeta ya no existe.".to_string(),
                std::io::ErrorKind::PermissionDenied => {
                    "No hay permisos para leer esta carpeta.".to_string()
                }
                _ => error.to_string(),
            };
            return Listing::failed(directory, message);
        }
        Ok(_) => {}
    }

    let read = match std::fs::read_dir(path) {
        Ok(read) => read,
        Err(error) => return Listing::failed(directory, describe_io_error(&error)),
    };

    let separator = separator_for(directory);
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in read.filter_map(Result::ok) {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let full = format!("{}{separator}{name}", directory.trim_end_matches(separator));
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let link = file_type.is_symlink();
        let kind = if link {
            // Al seguir el enlace se ve si lleva a una carpeta; si está roto,
            // se muestra como archivo.
            match std::fs::metadata(item.path()) {
                Ok(meta) if meta.is_dir() => EntryKind::Directory,
                _ => EntryKind::File,
            }
        } else if file_type.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        // `symlink_metadata` describe el enlace, no su destino: es lo que
        // interesa para el tamaño y la fecha de la entrada listada.
        let (size, modified) = match std::fs::symlink_metadata(item.path()) {
            Ok(meta) => (meta.len(), modified_millis(&meta)),
            // Entrada desaparecida entre leer la carpeta y consultarla.
            Err(_) => (0, 0),
        };
        entries.push(Entry {
            hidden: name.starts_with('.'),
            name,
            path: full,
            kind,
            link,
            size,
            modified,
        });
    }

    entries.sort_by(|a, b| match (&a.kind, &b.kind) {
        (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Listing {
        ok: true,
        dir: directory.to_string(),
        parent: parent_directory(directory),
        entries,
        truncated,
        error: None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Al pegar, el nombre cambió para no pisar nada.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub renamed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl FsResult {
    fn ok(path: PathBuf) -> FsResult {
        FsResult {
            ok: true,
            path: Some(path.to_string_lossy().to_string()),
            name: None,
            renamed: false,
            error: None,
        }
    }

    fn failed(error: impl Into<String>) -> FsResult {
        FsResult {
            ok: false,
            path: None,
            name: None,
            renamed: false,
            error: Some(error.into()),
        }
    }
}

pub fn create_entry(directory: &str, name: &str, kind: EntryKind) -> FsResult {
    let Some(target) = resolve_child_path(directory, name) else {
        return FsResult::failed(INVALID_NAME);
    };
    if target.exists() {
        return FsResult::failed("Ya existe un archivo o carpeta con ese nombre.");
    }
    let created = match kind {
        EntryKind::Directory => std::fs::create_dir(&target),
        // `create_new` falla si el archivo aparece entre la comprobación
        // anterior y esta llamada, en vez de truncar lo que hubiera.
        EntryKind::File => std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map(|_| ()),
    };
    match created {
        Ok(()) => FsResult::ok(target),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            FsResult::failed("No hay permisos para escribir en esta carpeta.")
        }
        Err(error) => FsResult::failed(describe_io_error(&error)),
    }
}

fn same_directory(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let separator = separator_for(value);
        let trimmed = value.trim_end_matches(separator).to_string();
        if is_windows_style_path(value) {
            trimmed.replace('/', "\\").to_lowercase()
        } else {
            trimmed
        }
    };
    normalize(a) == normalize(b)
}

fn dirname_of(path: &str) -> String {
    let separator = separator_for(path);
    let trimmed = path.trim_end_matches(separator);
    match trimmed.rfind(separator) {
        Some(0) => separator.to_string(),
        Some(index) => trimmed[..index].to_string(),
        None => String::new(),
    }
}

fn basename_of(path: &str) -> String {
    let separator = separator_for(path);
    let trimmed = path.trim_end_matches(separator);
    match trimmed.rfind(separator) {
        Some(index) => trimmed[index + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

/// Renombra dentro de la MISMA carpeta: origen y destino se resuelven como
/// hijos directos de `directory`, así que un nombre nuevo no puede mover nada a
/// otro sitio ni salirse por `..`.
pub fn rename_entry(directory: &str, current_path: &str, new_name: &str) -> FsResult {
    let Some(target) = resolve_child_path(directory, new_name) else {
        return FsResult::failed(INVALID_NAME);
    };
    if current_path.is_empty() || !same_directory(&dirname_of(current_path), directory) {
        return FsResult::failed("Ese elemento no pertenece a la carpeta abierta.");
    }
    let target_str = target.to_string_lossy().to_string();
    if same_directory(current_path, &target_str) {
        return FsResult::ok(target);
    }
    // En Windows y macOS el sistema de archivos no distingue mayúsculas: un
    // `exists` diría que "notas.md" ya existe al renombrar a "Notas.md", que es
    // justo un renombrado legítimo. Por eso se compara en minúsculas antes de
    // dar el nombre por ocupado.
    let same_name_other_case = current_path.to_lowercase() == target_str.to_lowercase();
    if !same_name_other_case && target.exists() {
        return FsResult::failed("Ya existe un archivo o carpeta con ese nombre.");
    }
    match std::fs::rename(current_path, &target) {
        Ok(()) => FsResult::ok(target),
        Err(error) => FsResult::failed(describe_io_error(&error)),
    }
}

/// Nombre libre dentro de `directory` a partir de uno que ya está ocupado:
/// `notas.md` -> `notas (copia).md` -> `notas (copia 2).md`. Se para a las 100
/// pruebas para no quedarse dando vueltas si algo va mal en el sistema.
pub fn available_copy_name(directory: &str, name: &str) -> Option<String> {
    // Un nombre como `.gitignore` es todo extensión: renombrarlo a
    // " (copia).gitignore" quedaría raro, así que ahí se trata como base.
    let (base, ext) = match name.rfind('.') {
        Some(0) | None => (name, ""),
        Some(index) => (&name[..index], &name[index..]),
    };
    for index in 1..=100 {
        let candidate = if index == 1 {
            format!("{base} (copia){ext}")
        } else {
            format!("{base} (copia {index}){ext}")
        };
        if !is_safe_entry_name(&candidate) {
            return None;
        }
        let target = resolve_child_path(directory, &candidate)?;
        if !target.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Copiar una carpeta dentro de sí misma (o de una descendiente) es un bucle
/// infinito garantizado; mover a esos mismos sitios deja el árbol huérfano.
pub fn is_inside(parent: &str, child: &str) -> bool {
    let separator = separator_for(parent);
    let normalize = |value: &str| {
        let trimmed = value.trim_end_matches(separator).to_string();
        if is_windows_style_path(parent) {
            trimmed.replace('/', "\\").to_lowercase()
        } else {
            trimmed
        }
    };
    let from = normalize(parent);
    let to = normalize(child);
    to == from || to.starts_with(&format!("{from}{separator}"))
}

/// Copia recursiva. `std::fs` no trae una, y `cpSync` con `errorOnExist` es lo
/// que espera el original: nunca se pisa nada que ya esté.
fn copy_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(source)?;
    if meta.is_dir() {
        std::fs::create_dir(target)?;
        for entry in std::fs::read_dir(source)?.filter_map(Result::ok) {
            copy_recursive(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if target.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "el destino ya existe",
        ));
    }
    std::fs::copy(source, target)?;
    Ok(())
}

/// Pega en `directory` lo que hay en `source_path`. `move_it` decide si es
/// cortar (renombrar) o copiar; al copiar sobre un nombre ocupado se busca uno
/// libre en vez de sobrescribir, que nunca es lo que se espera de un pegado.
pub fn paste_entry(source_path: &str, directory: &str, move_it: bool) -> FsResult {
    if source_path.is_empty() || directory.is_empty() {
        return FsResult::failed("No hay nada que pegar.");
    }
    let Ok(source_meta) = std::fs::symlink_metadata(source_path) else {
        return FsResult::failed("El origen ya no existe: se habrá movido o borrado.");
    };

    let name = basename_of(source_path);
    if !is_safe_entry_name(&name) {
        return FsResult::failed("El nombre del origen no se puede usar aquí.");
    }
    if source_meta.is_dir() && is_inside(source_path, directory) {
        return FsResult::failed("No se puede pegar una carpeta dentro de sí misma.");
    }

    let Some(direct) = resolve_child_path(directory, &name) else {
        return FsResult::failed("El nombre del origen no se puede usar aquí.");
    };
    let mut final_name = name.clone();
    if direct.exists() {
        let direct_str = direct.to_string_lossy().to_string();
        if same_directory(&direct_str, source_path) {
            // Pegar en la misma carpeta de la que se cortó no es un error: no
            // hay nada que hacer.
            if move_it {
                return FsResult {
                    name: Some(name),
                    ..FsResult::ok(direct)
                };
            }
        } else if move_it {
            return FsResult::failed("Ya existe un archivo o carpeta con ese nombre.");
        }
        if !move_it {
            let Some(free) = available_copy_name(directory, &name) else {
                return FsResult::failed("Ya existe un archivo o carpeta con ese nombre.");
            };
            final_name = free;
        }
    }

    let Some(target) = resolve_child_path(directory, &final_name) else {
        return FsResult::failed("El nombre del origen no se puede usar aquí.");
    };

    let outcome = if move_it {
        std::fs::rename(source_path, &target).or_else(|error| {
            // Entre discos distintos (o de un montaje a otro) `rename` no
            // funciona: hay que copiar y borrar el origen a mano.
            if error.raw_os_error() != Some(EXDEV) {
                return Err(error);
            }
            copy_recursive(Path::new(source_path), &target)?;
            if source_meta.is_dir() {
                std::fs::remove_dir_all(source_path)
            } else {
                std::fs::remove_file(source_path)
            }
        })
    } else {
        copy_recursive(Path::new(source_path), &target)
    };

    match outcome {
        Ok(()) => FsResult {
            renamed: final_name != name,
            name: Some(final_name),
            ..FsResult::ok(target)
        },
        Err(error) => FsResult::failed(describe_io_error(&error)),
    }
}

/// `EXDEV`: origen y destino están en sistemas de archivos distintos. El número
/// es el mismo en Linux, macOS y el CRT de Windows.
const EXDEV: i32 = 18;

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_str(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    // ---- Validación de nombres ----

    #[test]
    fn un_nombre_no_puede_ser_una_ruta() {
        assert!(!is_safe_entry_name("sub/archivo.txt"));
        assert!(!is_safe_entry_name("sub\\archivo.txt"));
        assert!(!is_safe_entry_name(".."));
        assert!(!is_safe_entry_name("."));
    }

    #[test]
    fn se_rechazan_los_caracteres_que_windows_no_admite() {
        for malo in ["a<b", "a>b", "a:b", "a\"b", "a|b", "a?b", "a*b"] {
            assert!(!is_safe_entry_name(malo), "{malo} debería rechazarse");
        }
    }

    #[test]
    fn los_nombres_reservados_de_windows_se_rechazan_en_todas_partes() {
        assert!(!is_safe_entry_name("CON"));
        assert!(!is_safe_entry_name("con.txt"));
        assert!(!is_safe_entry_name("lpt1.log"));
        assert!(is_safe_entry_name("console.txt"));
    }

    #[test]
    fn un_nombre_con_caracteres_de_control_se_rechaza() {
        assert!(!is_safe_entry_name("archivo\u{7}.txt"));
        assert!(!is_safe_entry_name("archivo\u{7f}"));
    }

    #[test]
    fn un_nombre_vacio_o_demasiado_largo_se_rechaza() {
        assert!(!is_safe_entry_name(""));
        assert!(!is_safe_entry_name("   "));
        assert!(!is_safe_entry_name(&"a".repeat(256)));
        assert!(is_safe_entry_name(&"a".repeat(255)));
    }

    // ---- Rutas ----

    #[test]
    fn un_hijo_se_resuelve_dentro_de_su_carpeta() {
        let target = resolve_child_path("/home/ana", "notas.md").unwrap();
        assert_eq!(target, PathBuf::from("/home/ana/notas.md"));
        assert_eq!(
            resolve_child_path("C:\\Users\\Ana", "notas.md").unwrap(),
            PathBuf::from("C:\\Users\\Ana\\notas.md")
        );
    }

    #[test]
    fn un_nombre_con_salto_de_carpeta_no_resuelve() {
        assert_eq!(resolve_child_path("/home/ana", "../otro"), None);
        assert_eq!(resolve_child_path("/home/ana", "sub/x"), None);
    }

    #[test]
    fn la_carpeta_padre_se_calcula_segun_el_estilo_de_ruta() {
        assert_eq!(parent_directory("/home/ana/x"), Some("/home/ana".into()));
        assert_eq!(
            parent_directory("C:\\Users\\Ana\\x"),
            Some("C:\\Users\\Ana".into())
        );
    }

    #[test]
    fn la_raiz_no_tiene_padre() {
        assert_eq!(parent_directory("/"), None);
        assert_eq!(parent_directory(""), None);
    }

    /// Sin padre en el listado fallido, el botón de subir se deshabilita y no
    /// se puede salir de una carpeta ilegible: hay que poder volver atrás
    /// precisamente cuando el listado NO ha funcionado.
    #[test]
    fn un_listado_fallido_conserva_la_carpeta_padre() {
        let sin_permisos = list_directory("C:\\Users\\Ana\\Configuración local");
        assert!(!sin_permisos.ok);
        assert_eq!(sin_permisos.parent, Some("C:\\Users\\Ana".into()));

        let desaparecida = list_directory("/home/ana/no-existe");
        assert!(!desaparecida.ok);
        assert_eq!(desaparecida.parent, Some("/home/ana".into()));
    }

    /// Y en la raíz sigue sin haberlo, que es lo correcto: no hay dónde subir.
    #[test]
    fn un_listado_fallido_en_la_raiz_no_inventa_padre() {
        assert_eq!(list_directory("").parent, None);
    }

    #[test]
    fn se_detecta_cuando_una_carpeta_esta_dentro_de_otra() {
        assert!(is_inside("/home/ana", "/home/ana/sub"));
        assert!(is_inside("/home/ana", "/home/ana"));
        assert!(!is_inside("/home/ana", "/home/anabel"));
        assert!(!is_inside("/home/ana", "/home"));
    }

    // ---- Listado ----

    #[test]
    fn se_listan_primero_las_carpetas_y_luego_los_archivos() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("z.txt"), "").unwrap();
        std::fs::write(dir.path().join("a.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("zeta")).unwrap();
        std::fs::create_dir(dir.path().join("alfa")).unwrap();

        let listing = list_directory(&dir_str(&dir));
        assert!(listing.ok);
        let nombres: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(nombres, vec!["alfa", "zeta", "a.txt", "z.txt"]);
    }

    #[test]
    fn una_carpeta_que_no_existe_devuelve_el_error_en_vez_de_fallar() {
        let listing = list_directory("/carpeta/que/no/existe/lterminal");
        assert!(!listing.ok);
        assert_eq!(listing.error.as_deref(), Some("La carpeta ya no existe."));
        assert!(listing.entries.is_empty());
    }

    #[test]
    fn un_archivo_no_es_una_carpeta() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.txt");
        std::fs::write(&file, "").unwrap();
        let listing = list_directory(&file.to_string_lossy());
        assert!(!listing.ok);
        assert_eq!(
            listing.error.as_deref(),
            Some("La ruta actual no es una carpeta.")
        );
    }

    #[test]
    fn los_archivos_ocultos_se_marcan_pero_se_listan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".oculto"), "").unwrap();
        let listing = list_directory(&dir_str(&dir));
        assert_eq!(listing.entries.len(), 1);
        assert!(listing.entries[0].hidden);
    }

    #[test]
    fn el_tamano_y_la_fecha_llegan_al_frontend() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.txt"), "12345").unwrap();
        let listing = list_directory(&dir_str(&dir));
        assert_eq!(listing.entries[0].size, 5);
        assert!(listing.entries[0].modified > 0);
    }

    // ---- Crear ----

    #[test]
    fn se_crea_un_archivo_y_una_carpeta() {
        let dir = tempfile::tempdir().unwrap();
        assert!(create_entry(&dir_str(&dir), "nuevo.txt", EntryKind::File).ok);
        assert!(create_entry(&dir_str(&dir), "nueva", EntryKind::Directory).ok);
        assert!(dir.path().join("nuevo.txt").is_file());
        assert!(dir.path().join("nueva").is_dir());
    }

    #[test]
    fn crear_nunca_pisa_lo_que_ya_esta() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.txt"), "contenido").unwrap();
        let result = create_entry(&dir_str(&dir), "x.txt", EntryKind::File);
        assert!(!result.ok);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x.txt")).unwrap(),
            "contenido"
        );
    }

    #[test]
    fn crear_con_un_nombre_invalido_no_toca_el_disco() {
        let dir = tempfile::tempdir().unwrap();
        let result = create_entry(&dir_str(&dir), "../fuera.txt", EntryKind::File);
        assert!(!result.ok);
        assert!(result.error.unwrap().starts_with("Nombre no válido"));
    }

    // ---- Renombrar ----

    #[test]
    fn se_renombra_dentro_de_la_misma_carpeta() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("viejo.txt");
        std::fs::write(&file, "x").unwrap();
        let result = rename_entry(&dir_str(&dir), &file.to_string_lossy(), "nuevo.txt");
        assert!(result.ok, "{result:?}");
        assert!(dir.path().join("nuevo.txt").is_file());
        assert!(!file.exists());
    }

    #[test]
    fn no_se_puede_renombrar_algo_de_otra_carpeta() {
        let dir = tempfile::tempdir().unwrap();
        let otra = tempfile::tempdir().unwrap();
        let file = otra.path().join("x.txt");
        std::fs::write(&file, "").unwrap();
        let result = rename_entry(&dir_str(&dir), &file.to_string_lossy(), "y.txt");
        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some("Ese elemento no pertenece a la carpeta abierta.")
        );
    }

    #[test]
    fn renombrar_no_pisa_otro_archivo() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let result = rename_entry(
            &dir_str(&dir),
            &dir.path().join("a.txt").to_string_lossy(),
            "b.txt",
        );
        assert!(!result.ok);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b.txt")).unwrap(),
            "b"
        );
    }

    #[test]
    fn cambiar_solo_las_mayusculas_es_un_renombrado_valido() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notas.md");
        std::fs::write(&file, "x").unwrap();
        let result = rename_entry(&dir_str(&dir), &file.to_string_lossy(), "Notas.md");
        assert!(result.ok, "{result:?}");
    }

    // ---- Copiar y mover ----

    #[test]
    fn se_copia_un_archivo_a_otra_carpeta() {
        let origen = tempfile::tempdir().unwrap();
        let destino = tempfile::tempdir().unwrap();
        let file = origen.path().join("x.txt");
        std::fs::write(&file, "hola").unwrap();

        let result = paste_entry(&file.to_string_lossy(), &dir_str(&destino), false);
        assert!(result.ok, "{result:?}");
        assert_eq!(
            std::fs::read_to_string(destino.path().join("x.txt")).unwrap(),
            "hola"
        );
        // Copiar deja el origen donde estaba.
        assert!(file.exists());
    }

    #[test]
    fn se_mueve_un_archivo_y_desaparece_del_origen() {
        let origen = tempfile::tempdir().unwrap();
        let destino = tempfile::tempdir().unwrap();
        let file = origen.path().join("x.txt");
        std::fs::write(&file, "hola").unwrap();

        let result = paste_entry(&file.to_string_lossy(), &dir_str(&destino), true);
        assert!(result.ok, "{result:?}");
        assert!(!file.exists());
        assert!(destino.path().join("x.txt").exists());
    }

    #[test]
    fn copiar_sobre_un_nombre_ocupado_busca_uno_libre() {
        let origen = tempfile::tempdir().unwrap();
        let destino = tempfile::tempdir().unwrap();
        std::fs::write(origen.path().join("notas.md"), "nuevo").unwrap();
        std::fs::write(destino.path().join("notas.md"), "viejo").unwrap();

        let result = paste_entry(
            &origen.path().join("notas.md").to_string_lossy(),
            &dir_str(&destino),
            false,
        );
        assert!(result.ok);
        assert!(result.renamed);
        assert_eq!(result.name.as_deref(), Some("notas (copia).md"));
        // Y el que ya estaba no se ha tocado.
        assert_eq!(
            std::fs::read_to_string(destino.path().join("notas.md")).unwrap(),
            "viejo"
        );
    }

    #[test]
    fn mover_sobre_un_nombre_ocupado_se_rechaza() {
        let origen = tempfile::tempdir().unwrap();
        let destino = tempfile::tempdir().unwrap();
        std::fs::write(origen.path().join("x.txt"), "nuevo").unwrap();
        std::fs::write(destino.path().join("x.txt"), "viejo").unwrap();

        let result = paste_entry(
            &origen.path().join("x.txt").to_string_lossy(),
            &dir_str(&destino),
            true,
        );
        assert!(!result.ok);
        assert_eq!(
            std::fs::read_to_string(destino.path().join("x.txt")).unwrap(),
            "viejo"
        );
    }

    #[test]
    fn no_se_pega_una_carpeta_dentro_de_si_misma() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let result = paste_entry(
            &sub.to_string_lossy(),
            &sub.join("dentro").to_string_lossy(),
            false,
        );
        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some("No se puede pegar una carpeta dentro de sí misma.")
        );
    }

    #[test]
    fn se_copia_una_carpeta_entera() {
        let origen = tempfile::tempdir().unwrap();
        let destino = tempfile::tempdir().unwrap();
        let sub = origen.path().join("proyecto");
        std::fs::create_dir_all(sub.join("src")).unwrap();
        std::fs::write(sub.join("src").join("main.rs"), "fn main() {}").unwrap();

        let result = paste_entry(&sub.to_string_lossy(), &dir_str(&destino), false);
        assert!(result.ok, "{result:?}");
        assert!(destino
            .path()
            .join("proyecto")
            .join("src")
            .join("main.rs")
            .is_file());
    }

    #[test]
    fn pegar_algo_que_ya_no_existe_lo_dice() {
        let destino = tempfile::tempdir().unwrap();
        let result = paste_entry("/no/existe/x.txt", &dir_str(&destino), false);
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("ya no existe"));
    }

    // ---- Nombres de copia ----

    #[test]
    fn el_nombre_de_copia_conserva_la_extension() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notas.md"), "").unwrap();
        assert_eq!(
            available_copy_name(&dir_str(&dir), "notas.md").as_deref(),
            Some("notas (copia).md")
        );

        std::fs::write(dir.path().join("notas (copia).md"), "").unwrap();
        assert_eq!(
            available_copy_name(&dir_str(&dir), "notas.md").as_deref(),
            Some("notas (copia 2).md")
        );
    }

    #[test]
    fn un_archivo_oculto_no_pierde_su_nombre_al_copiarse() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            available_copy_name(&dir_str(&dir), ".gitignore").as_deref(),
            Some(".gitignore (copia)")
        );
    }
}
