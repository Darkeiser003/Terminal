//! El portable de un solo archivo: lo que el ejecutable lleva dentro.
//!
//! `WTerminal-<versión>-Portable.exe` es el mismo `wterminal.exe` de la
//! carpeta unpacked con sus archivos de apoyo (`conpty.dll`,
//! `OpenConsole.exe`, el instalador de WebView2 y los avisos de terceros)
//! añadidos al final del archivo, fuera de la imagen PE. Windows no carga esa
//! cola al arrancar el proceso: solo se lee la parte que hace falta y cuando
//! hace falta. Así el portable se abre con un doble clic, sin el diálogo de un
//! autoextraíble ni una carpeta descomprimida en `%TEMP%`.
//!
//! Formato (lo escribe `scripts/create-single-file-portable.mjs`):
//!
//! ```text
//! [imagen PE][archivo 1]…[archivo N][índice JSON][cola de 32 bytes]
//! ```
//!
//! La cola son tres `u64` little-endian (inicio de los archivos, posición y
//! longitud del índice) seguidos de la marca `WTPORT01`. Si el ejecutable se
//! firma después con Authenticode, la firma queda detrás: la búsqueda empieza
//! donde la cabecera PE declara la tabla de certificados.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use ring::digest::{Context, SHA256};
use serde::Deserialize;

/// Marca final de la cola. Va al final para que el último byte nunca sea cero
/// y el relleno que añade una firma posterior no se confunda con la cola.
pub const MAGIC: &[u8; 8] = b"WTPORT01";
const TRAILER_LEN: u64 = 32;
const FORMAT: u32 = 1;
const MAX_INDEX_BYTES: u64 = 64 * 1024;
const MAX_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Lo que necesita la terminal para usar su propio ConPTY.
pub const CONPTY_FILES: [&str; 2] = ["conpty.dll", "OpenConsole.exe"];
/// Instalador de WebView2 que se ejecuta solo si falta el runtime.
pub const WEBVIEW2_INSTALLER: &str = "MicrosoftEdgeWebView2Setup.exe";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Entry {
    pub name: String,
    pub offset: u64,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
struct Index {
    format: u32,
    files: Vec<Entry>,
}

/// Los archivos embebidos en un ejecutable concreto.
#[derive(Debug, Clone)]
pub struct Payload {
    pub path: PathBuf,
    pub payload_start: u64,
    pub entries: Vec<Entry>,
}

/// El contenido embebido del ejecutable que está corriendo, o `None` si es el
/// `wterminal.exe` normal de la carpeta unpacked o del instalador.
pub fn current() -> Option<&'static Payload> {
    static CURRENT: OnceLock<Option<Payload>> = OnceLock::new();
    CURRENT
        .get_or_init(|| {
            let exe = std::env::current_exe().ok()?;
            match Payload::read(&exe) {
                Ok(payload) => payload,
                Err(error) => {
                    crate::log_error!(
                        "El contenido embebido del portable está dañado",
                        serde_json::json!({ "exe": exe.to_string_lossy(), "error": error })
                    );
                    None
                }
            }
        })
        .as_ref()
}

/// `true` si esta copia es el portable de un solo archivo.
pub fn is_single_file() -> bool {
    current().is_some()
}

/// Dónde se dejan los archivos que el portable necesita en disco:
/// `%LOCALAPPDATA%\WTerminal\runtime` (datos locales, no itinerantes). En E2E
/// vive dentro del perfil aislado de la prueba.
pub fn runtime_cache_root() -> PathBuf {
    if std::env::var("LTERMINAL_E2E_TESTING").ok().as_deref() == Some("1") {
        if let Some(dir) = std::env::var_os("LTERMINAL_E2E_APP_DATA_DIR").map(PathBuf::from) {
            if dir.is_absolute() {
                return dir.join("runtime");
            }
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| crate::paths::home_dir().join(".local").join("share"))
        .join(crate::identity::current().name)
        .join("runtime")
}

impl Payload {
    /// Lee el índice de `path`. `Ok(None)` si el archivo no lleva contenido
    /// embebido; `Err` si lo lleva pero el índice no es coherente.
    pub fn read(path: &Path) -> Result<Option<Payload>, String> {
        let mut file = File::open(path)
            .map_err(|error| format!("No se pudo abrir {}: {error}", path.display()))?;
        let length = file
            .metadata()
            .map_err(|error| format!("No se pudo inspeccionar {}: {error}", path.display()))?
            .len();
        let end = payload_end(&mut file, length)?;
        if end < TRAILER_LEN {
            return Ok(None);
        }
        let mut trailer = [0u8; TRAILER_LEN as usize];
        file.seek(SeekFrom::Start(end - TRAILER_LEN))
            .and_then(|_| file.read_exact(&mut trailer))
            .map_err(|error| format!("No se pudo leer la cola del portable: {error}"))?;
        if &trailer[24..32] != MAGIC {
            return Ok(None);
        }
        let number = |range: std::ops::Range<usize>| {
            u64::from_le_bytes(trailer[range].try_into().expect("8 bytes"))
        };
        let payload_start = number(0..8);
        let index_offset = number(8..16);
        let index_len = number(16..24);
        let trailer_start = end - TRAILER_LEN;
        if index_len == 0
            || index_len > MAX_INDEX_BYTES
            || index_offset.checked_add(index_len) != Some(trailer_start)
            || payload_start > index_offset
        {
            return Err("La cola del portable apunta fuera de su contenido.".into());
        }
        let mut raw = vec![0u8; index_len as usize];
        file.seek(SeekFrom::Start(index_offset))
            .and_then(|_| file.read_exact(&mut raw))
            .map_err(|error| format!("No se pudo leer el índice del portable: {error}"))?;
        let index: Index = serde_json::from_slice(&raw)
            .map_err(|error| format!("El índice del portable no es válido: {error}"))?;
        if index.format != FORMAT {
            return Err(format!(
                "Formato de portable desconocido: {} (se esperaba {FORMAT}).",
                index.format
            ));
        }
        let mut names = std::collections::HashSet::new();
        for entry in &index.files {
            if !safe_entry_name(&entry.name) || !names.insert(entry.name.to_ascii_lowercase()) {
                return Err(format!(
                    "El portable declara un nombre no válido: {}",
                    entry.name
                ));
            }
            let inside = entry.offset >= payload_start
                && entry.size <= MAX_ENTRY_BYTES
                && entry
                    .offset
                    .checked_add(entry.size)
                    .is_some_and(|stop| stop <= index_offset);
            if !inside || !is_sha256_hex(&entry.sha256) {
                return Err(format!(
                    "El portable declara {} fuera de su contenido.",
                    entry.name
                ));
            }
        }
        Ok(Some(Payload {
            path: path.to_path_buf(),
            payload_start,
            entries: index.files,
        }))
    }

    pub fn entry(&self, name: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|entry| entry.name.eq_ignore_ascii_case(name))
    }

    /// Escribe `name` en `destination` comprobando su SHA-256 por el camino.
    /// Se escribe a un temporal junto al destino y se renombra al final: otra
    /// instancia que arranque a la vez nunca ve un archivo a medias.
    pub fn extract(&self, name: &str, destination: &Path) -> Result<(), String> {
        let entry = self
            .entry(name)
            .ok_or_else(|| format!("El portable no contiene {name}."))?;
        let parent = destination
            .parent()
            .ok_or_else(|| format!("Destino sin carpeta: {}", destination.display()))?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("No se pudo crear {}: {error}", parent.display()))?;
        let temporary = parent.join(format!(
            ".{}.{}.{}.tmp",
            entry.name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        let result = self.copy_entry(entry, &temporary).and_then(|()| {
            std::fs::rename(&temporary, destination)
                .map_err(|error| format!("No se pudo colocar {}: {error}", destination.display()))
        });
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn copy_entry(&self, entry: &Entry, temporary: &Path) -> Result<(), String> {
        let mut source = File::open(&self.path)
            .map_err(|error| format!("No se pudo abrir {}: {error}", self.path.display()))?;
        source
            .seek(SeekFrom::Start(entry.offset))
            .map_err(|error| format!("No se pudo leer {}: {error}", entry.name))?;
        let mut source = source.take(entry.size);
        let mut output = File::create(temporary)
            .map_err(|error| format!("No se pudo crear {}: {error}", temporary.display()))?;
        let mut context = Context::new(&SHA256);
        let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
        let mut copied = 0u64;
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("No se pudo leer {}: {error}", entry.name))?;
            if read == 0 {
                break;
            }
            context.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("No se pudo escribir {}: {error}", entry.name))?;
            copied += read as u64;
        }
        output
            .sync_all()
            .map_err(|error| format!("No se pudo guardar {}: {error}", entry.name))?;
        if copied != entry.size || to_hex(context.finish().as_ref()) != entry.sha256 {
            return Err(format!(
                "{} no coincide con su SHA-256: el portable está dañado.",
                entry.name
            ));
        }
        Ok(())
    }

    /// `true` si `path` ya tiene exactamente el contenido de `name`.
    pub fn matches(&self, name: &str, path: &Path) -> bool {
        let Some(entry) = self.entry(name) else {
            return false;
        };
        match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() && metadata.len() == entry.size => {}
            _ => return false,
        }
        sha256_file(path).is_ok_and(|hash| hash == entry.sha256)
    }

    /// Deja `names` en una carpeta de `cache_root` propia de este contenido y
    /// la devuelve. Los archivos que ya estén y coincidan no se reescriben: un
    /// `conpty.dll` cargado por otra instancia no se puede reemplazar.
    pub fn materialize(&self, names: &[&str], cache_root: &Path) -> Result<PathBuf, String> {
        let mut fingerprint = Context::new(&SHA256);
        for name in names {
            let entry = self
                .entry(name)
                .ok_or_else(|| format!("El portable no contiene {name}."))?;
            fingerprint.update(entry.name.as_bytes());
            fingerprint.update(b":");
            fingerprint.update(entry.sha256.as_bytes());
            fingerprint.update(b"\n");
        }
        let folder = cache_root.join(&to_hex(fingerprint.finish().as_ref())[..16]);
        for name in names {
            let target = folder.join(name);
            if self.matches(name, &target) {
                continue;
            }
            if let Err(error) = self.extract(name, &target) {
                // Otra instancia puede haberlo colocado mientras tanto.
                if !self.matches(name, &target) {
                    return Err(error);
                }
            }
        }
        Ok(folder)
    }
}

/// Borra las carpetas de versiones anteriores dentro de `cache_root`. Solo
/// toca nombres con la forma que genera `materialize`. Cada carpeta empieza
/// por su `conpty.dll`: si otra instancia antigua sigue viva la tiene cargada,
/// Windows no deja borrarla y la carpeta entera se queda para la próxima vez
/// (borrar antes `OpenConsole.exe` dejaría a esa instancia sin pestañas nuevas).
pub fn prune_runtime_cache(cache_root: &Path, keep: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(cache_root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let generated = name.len() == 16 && name.bytes().all(|byte| byte.is_ascii_hexdigit());
        let is_dir = entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink());
        if !generated || !is_dir || path == keep {
            continue;
        }
        let dll = path.join(CONPTY_FILES[0]);
        if dll.exists() && std::fs::remove_file(&dll).is_err() {
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Comprueba que `path` es un portable de un solo archivo completo: lo usa el
/// actualizador antes de reemplazar el ejecutable en marcha.
pub fn verify_executable(path: &Path) -> Result<(), String> {
    let mut magic = [0u8; 2];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(|error| format!("No se pudo leer el portable descargado: {error}"))?;
    if magic != *b"MZ" {
        return Err("La actualización no es un ejecutable de Windows.".into());
    }
    let payload = Payload::read(path)?
        .ok_or_else(|| "La actualización no es un portable de un solo archivo.".to_string())?;
    for name in CONPTY_FILES {
        let entry = payload
            .entry(name)
            .ok_or_else(|| format!("La actualización portable no contiene {name}."))?;
        let mut file = File::open(path)
            .map_err(|error| format!("No se pudo leer el portable descargado: {error}"))?;
        file.seek(SeekFrom::Start(entry.offset))
            .map_err(|error| format!("No se pudo leer {name}: {error}"))?;
        if to_hex(&sha256_reader(file.take(entry.size))?) != entry.sha256 {
            return Err(format!(
                "{name} no coincide con su SHA-256 en la actualización."
            ));
        }
    }
    Ok(())
}

/// Dónde acaban los datos del archivo: antes de la tabla de certificados si
/// el PE está firmado, si no al final. Se descartan hasta 7 bytes de relleno.
fn payload_end(file: &mut File, length: u64) -> Result<u64, String> {
    let mut end = length;
    if let Some((offset, size)) = certificate_table(file, length) {
        if size > 0 && offset < length && offset.saturating_add(size) <= length {
            end = offset;
        }
    }
    let padding = end.min(7);
    let mut tail = vec![0u8; padding as usize];
    file.seek(SeekFrom::Start(end - padding))
        .and_then(|_| file.read_exact(&mut tail))
        .map_err(|error| format!("No se pudo leer el final del ejecutable: {error}"))?;
    let zeros = tail.iter().rev().take_while(|byte| **byte == 0).count() as u64;
    Ok(end - zeros)
}

/// Posición y tamaño de la tabla de certificados de Authenticode (entrada 4
/// del directorio de datos), si el archivo es un PE que la declara.
fn certificate_table(file: &mut File, length: u64) -> Option<(u64, u64)> {
    let mut read_at = |offset: u64, buffer: &mut [u8]| -> Option<()> {
        if offset.checked_add(buffer.len() as u64)? > length {
            return None;
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        file.read_exact(buffer).ok()
    };
    let mut dos = [0u8; 64];
    read_at(0, &mut dos)?;
    if &dos[..2] != b"MZ" {
        return None;
    }
    let pe = u64::from(u32::from_le_bytes(dos[60..64].try_into().ok()?));
    let mut header = [0u8; 26];
    read_at(pe, &mut header)?;
    if &header[..4] != b"PE\0\0" {
        return None;
    }
    let optional = pe + 24;
    let magic = u16::from_le_bytes(header[24..26].try_into().ok()?);
    let (count_at, directories_at) = match magic {
        0x20b => (optional + 108, optional + 112),
        0x10b => (optional + 92, optional + 96),
        _ => return None,
    };
    let mut count = [0u8; 4];
    read_at(count_at, &mut count)?;
    if u32::from_le_bytes(count) <= 4 {
        return None;
    }
    let mut security = [0u8; 8];
    read_at(directories_at + 4 * 8, &mut security)?;
    Some((
        u64::from(u32::from_le_bytes(security[..4].try_into().ok()?)),
        u64::from(u32::from_le_bytes(security[4..].try_into().ok()?)),
    ))
}

fn safe_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_reader(mut reader: impl Read) -> Result<Vec<u8>, String> {
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("No se pudo leer: {error}"))?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    Ok(context.finish().as_ref().to_vec())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("No se pudo leer: {error}"))?;
    sha256_reader(file).map(|hash| to_hex(&hash))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Construye un portable igual que `create-single-file-portable.mjs`.
    fn build(base: &[u8], files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = base.to_vec();
        let payload_start = output.len() as u64;
        let mut entries = Vec::new();
        for (name, content) in files {
            entries.push(serde_json::json!({
                "name": name,
                "offset": output.len() as u64,
                "size": content.len() as u64,
                "sha256": to_hex(ring::digest::digest(&SHA256, content).as_ref()),
            }));
            output.extend_from_slice(content);
        }
        let index =
            serde_json::to_vec(&serde_json::json!({ "format": 1, "files": entries })).unwrap();
        let index_offset = output.len() as u64;
        output.extend_from_slice(&index);
        output.extend_from_slice(&payload_start.to_le_bytes());
        output.extend_from_slice(&index_offset.to_le_bytes());
        output.extend_from_slice(&(index.len() as u64).to_le_bytes());
        output.extend_from_slice(MAGIC);
        output
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn un_ejecutable_sin_contenido_embebido_no_es_el_portable() {
        let dir = tempfile::tempdir().unwrap();
        let plain = write(dir.path(), "wterminal.exe", b"MZ ejecutable normal");
        assert!(Payload::read(&plain).unwrap().is_none());
        let tiny = write(dir.path(), "vacio.exe", b"");
        assert!(Payload::read(&tiny).unwrap().is_none());
    }

    #[test]
    fn lee_el_indice_y_extrae_cada_archivo_verificado() {
        let dir = tempfile::tempdir().unwrap();
        let exe = write(
            dir.path(),
            "WTerminal-1.0.0-Portable.exe",
            &build(
                b"MZ imagen",
                &[("conpty.dll", b"dll"), ("OpenConsole.exe", b"host")],
            ),
        );
        let payload = Payload::read(&exe).unwrap().unwrap();
        assert_eq!(payload.payload_start, 9);
        assert_eq!(payload.entries.len(), 2);
        let target = dir.path().join("salida").join("OpenConsole.exe");
        payload.extract("openconsole.exe", &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"host");
        assert!(payload.matches("OpenConsole.exe", &target));
        assert!(!payload.matches("conpty.dll", &target));
        // No queda ningún temporal junto al destino.
        assert_eq!(
            std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn la_firma_authenticode_posterior_no_oculta_el_contenido() {
        // PE64 mínimo cuya entrada 4 del directorio apunta a la tabla de
        // certificados añadida detrás de la cola, con relleno de alineación.
        let mut pe = vec![0u8; 0x200];
        pe[..2].copy_from_slice(b"MZ");
        pe[60..64].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        let optional = 0x80 + 24;
        pe[optional..optional + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        pe[optional + 108..optional + 112].copy_from_slice(&16u32.to_le_bytes());
        let mut signed = build(&pe, &[("conpty.dll", b"dll")]);
        signed.extend_from_slice(&[0, 0, 0, 0, 0]);
        let certificate_offset = signed.len() as u32;
        signed.extend_from_slice(&[7u8; 48]);
        let security = optional + 112 + 4 * 8;
        signed[security..security + 4].copy_from_slice(&certificate_offset.to_le_bytes());
        signed[security + 4..security + 8].copy_from_slice(&48u32.to_le_bytes());
        let dir = tempfile::tempdir().unwrap();
        let exe = write(dir.path(), "firmado.exe", &signed);
        let payload = Payload::read(&exe).unwrap().unwrap();
        assert_eq!(payload.entry("conpty.dll").unwrap().size, 3);
    }

    #[test]
    fn un_archivo_alterado_no_se_extrae() {
        let mut bytes = build(b"MZ", &[("conpty.dll", b"original")]);
        bytes[2] = b'X';
        let dir = tempfile::tempdir().unwrap();
        let exe = write(dir.path(), "alterado.exe", &bytes);
        let payload = Payload::read(&exe).unwrap().unwrap();
        let target = dir.path().join("cache").join("conpty.dll");
        assert!(payload
            .extract("conpty.dll", &target)
            .unwrap_err()
            .contains("SHA-256"));
        assert!(!target.exists());
        assert_eq!(
            std::fs::read_dir(dir.path().join("cache")).unwrap().count(),
            0
        );
    }

    #[test]
    fn un_indice_que_apunta_fuera_se_rechaza() {
        let mut bytes = build(b"MZ", &[("conpty.dll", b"dll")]);
        // El índice declara un tamaño mayor que el contenido real.
        let text = String::from_utf8_lossy(&bytes).replace("\"size\":3", "\"size\":9");
        bytes = text.into_bytes();
        let dir = tempfile::tempdir().unwrap();
        let exe = write(dir.path(), "roto.exe", &bytes);
        assert!(Payload::read(&exe).is_err());
    }

    #[test]
    fn los_nombres_del_indice_no_pueden_salir_de_la_carpeta() {
        for name in ["../conpty.dll", "a\\b.dll", ".oculto", "", "c:x"] {
            assert!(!safe_entry_name(name), "{name}");
        }
        assert!(safe_entry_name("MicrosoftEdgeWebView2Setup.exe"));
        let dir = tempfile::tempdir().unwrap();
        let exe = write(dir.path(), "malo.exe", &build(b"MZ", &[("../x.dll", b"x")]));
        assert!(Payload::read(&exe).is_err());
    }

    #[test]
    fn la_cache_se_reutiliza_y_las_versiones_viejas_se_borran() {
        let dir = tempfile::tempdir().unwrap();
        let exe = write(
            dir.path(),
            "portable.exe",
            &build(
                b"MZ",
                &[("conpty.dll", b"dll"), ("OpenConsole.exe", b"host")],
            ),
        );
        let payload = Payload::read(&exe).unwrap().unwrap();
        let cache = dir.path().join("runtime");
        let folder = payload.materialize(&CONPTY_FILES, &cache).unwrap();
        assert_eq!(std::fs::read(folder.join("conpty.dll")).unwrap(), b"dll");
        let written = std::fs::metadata(folder.join("conpty.dll"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(payload.materialize(&CONPTY_FILES, &cache).unwrap(), folder);
        assert_eq!(
            std::fs::metadata(folder.join("conpty.dll"))
                .unwrap()
                .modified()
                .unwrap(),
            written,
            "un archivo que ya coincide no se reescribe"
        );
        // Un archivo dañado en la caché se repone.
        std::fs::write(folder.join("OpenConsole.exe"), b"otro").unwrap();
        payload.materialize(&CONPTY_FILES, &cache).unwrap();
        assert_eq!(
            std::fs::read(folder.join("OpenConsole.exe")).unwrap(),
            b"host"
        );

        let old = cache.join("0123456789abcdef");
        std::fs::create_dir_all(&old).unwrap();
        let foreign = cache.join("notas");
        std::fs::create_dir_all(&foreign).unwrap();
        assert_eq!(prune_runtime_cache(&cache, &folder), 1);
        assert!(!old.exists() && foreign.exists() && folder.exists());
    }

    #[cfg(windows)]
    #[test]
    fn una_version_antigua_en_uso_no_se_desmonta_a_medias() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("runtime");
        let keep = cache.join("ffffffffffffffff");
        let old = cache.join("0123456789abcdef");
        std::fs::create_dir_all(&keep).unwrap();
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("conpty.dll"), b"dll").unwrap();
        std::fs::write(old.join("OpenConsole.exe"), b"host").unwrap();
        // Una instancia viva tiene la DLL cargada: abrirla sin compartir el
        // borrado reproduce el bloqueo del cargador de Windows.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1)
            .open(old.join("conpty.dll"))
            .unwrap();
        assert_eq!(prune_runtime_cache(&cache, &keep), 0);
        assert!(
            old.join("OpenConsole.exe").exists(),
            "el host de la instancia viva sigue ahí"
        );
        drop(lock);
        assert_eq!(prune_runtime_cache(&cache, &keep), 1);
        assert!(!old.exists() && keep.exists());
    }

    #[test]
    fn el_actualizador_exige_un_portable_completo() {
        let dir = tempfile::tempdir().unwrap();
        let ok = write(
            dir.path(),
            "nuevo.exe",
            &build(
                b"MZ",
                &[("conpty.dll", b"dll"), ("OpenConsole.exe", b"host")],
            ),
        );
        verify_executable(&ok).unwrap();
        let incompleto = write(
            dir.path(),
            "incompleto.exe",
            &build(b"MZ", &[("conpty.dll", b"dll")]),
        );
        assert!(verify_executable(&incompleto)
            .unwrap_err()
            .contains("OpenConsole.exe"));
        let carpeta = write(dir.path(), "wterminal.exe", b"MZ normal");
        assert!(verify_executable(&carpeta).is_err());
        let zip = write(
            dir.path(),
            "x.exe",
            &build(
                b"PK",
                &[("conpty.dll", b"dll"), ("OpenConsole.exe", b"host")],
            ),
        );
        assert!(verify_executable(&zip).is_err());
    }
}
