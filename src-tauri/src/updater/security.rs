//! Verificación de releases antes de tocar la instalación.
//!
//! La release publica un manifiesto `SHA256SUMS.txt` y una firma Ed25519
//! detached del manifiesto (`SHA256SUMS.txt.sig`). La firma autentica qué hash
//! es el oficial; el hash autentica los bytes del paquete descargado.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use ring::digest::{Context, SHA256};
use ring::signature::{UnparsedPublicKey, ED25519};

const SIGNATURE_MAX_BYTES: usize = 512;
const MANIFEST_MAX_BYTES: usize = 1024 * 1024;
const PUBLIC_KEY_BYTES: usize = 32;
const HASH_BYTES: usize = 32;
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ARCHIVE_ENTRIES: usize = 10_000;

/// `tar.exe` de Windows es bsdtar y lee los ZIP de distribución. En Linux, el
/// binario `tar` suele ser GNU tar y no abre ZIP; si hay bsdtar disponible se
/// prefiere para poder auditar el mismo formato sin cambiar la release.
pub(crate) fn archive_tool() -> &'static str {
    #[cfg(windows)]
    {
        "tar"
    }
    #[cfg(not(windows))]
    {
        if crate::path_env::which("bsdtar").is_some() {
            "bsdtar"
        } else {
            "tar"
        }
    }
}

/// La clave pública se inyecta al compilar la distribución oficial. Nunca se
/// lee de preferencias ni de una respuesta de red: permitir eso convertiría
/// la clave de confianza en configuración mutable.
const UPDATE_PUBLIC_KEY_HEX: Option<&str> = option_env!("LTERMINAL_UPDATE_PUBLIC_KEY");

pub fn signing_key_configured() -> bool {
    public_key().is_ok()
}

fn public_key() -> Result<[u8; PUBLIC_KEY_BYTES], String> {
    let value = UPDATE_PUBLIC_KEY_HEX.ok_or_else(|| {
        "Esta compilación no trae una clave pública de actualizaciones.".to_string()
    })?;
    let value = value.trim();
    if value.len() != PUBLIC_KEY_BYTES * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("La clave pública de actualizaciones no es hexadecimal Ed25519 válida.".into());
    }
    let mut bytes = [0u8; PUBLIC_KEY_BYTES];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (hex(pair[0])? << 4) | hex(pair[1])?;
    }
    Ok(bytes)
}

fn hex(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("La clave pública contiene un carácter hexadecimal inválido.".into()),
    }
}

pub fn verify_signature(manifest: &[u8], encoded_signature: &[u8]) -> Result<(), String> {
    let key = public_key()?;
    verify_signature_with_key(manifest, encoded_signature, &key)
}

fn verify_signature_with_key(
    manifest: &[u8],
    encoded_signature: &[u8],
    key: &[u8; PUBLIC_KEY_BYTES],
) -> Result<(), String> {
    if manifest.is_empty() {
        return Err("El manifiesto de checksums está vacío.".into());
    }
    if manifest.len() > MANIFEST_MAX_BYTES {
        return Err("El manifiesto de checksums supera el tamaño máximo admitido.".into());
    }
    if encoded_signature.len() > SIGNATURE_MAX_BYTES {
        return Err("La firma de la release supera el tamaño máximo admitido.".into());
    }
    let signature_text = std::str::from_utf8(encoded_signature)
        .map_err(|_| "La firma de la release no está codificada en UTF-8.".to_string())?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(signature_text.split_whitespace().collect::<String>())
        .map_err(|_| "La firma de la release no es Base64 válida.".to_string())?;
    if signature.len() != ED25519_SIGNATURE_BYTES {
        return Err("La firma de la release no tiene tamaño Ed25519.".into());
    }
    UnparsedPublicKey::new(&ED25519, key)
        .verify(manifest, &signature)
        .map_err(|_| "La firma Ed25519 del manifiesto no es válida.".to_string())
}

const ED25519_SIGNATURE_BYTES: usize = 64;

/// Comprueba que el manifiesto firmado contiene exactamente un hash válido
/// para el archivo que se va a instalar y que sus bytes coinciden.
pub fn verify_checksum(
    manifest: &[u8],
    artifact_name: &str,
    artifact: &Path,
) -> Result<String, String> {
    let expected = manifest_checksum(manifest, artifact_name)?;

    let mut file = std::fs::File::open(artifact)
        .map_err(|error| format!("No se pudo abrir el paquete para comprobar su hash: {error}"))?;
    let mut context = Context::new(&SHA256);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer).map_err(|error| {
            format!("No se pudo leer el paquete para comprobar su hash: {error}")
        })?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    let actual = to_hex(context.finish().as_ref());
    if actual != expected {
        return Err(format!(
            "El SHA-256 de {artifact_name} no coincide con el manifiesto firmado."
        ));
    }
    Ok(actual)
}

/// Lee y valida el hash que una firma Ed25519 autentica para un adjunto.
/// Separarlo de `verify_checksum` permite comprobar la autenticidad del
/// manifiesto durante la búsqueda de actualizaciones, antes de descargar el
/// paquete potencialmente grande. La descarga se vuelve a verificar después.
pub fn manifest_checksum(manifest: &[u8], artifact_name: &str) -> Result<String, String> {
    if manifest.is_empty() {
        return Err("El manifiesto de checksums está vacío.".into());
    }
    if manifest.len() > MANIFEST_MAX_BYTES {
        return Err("El manifiesto de checksums supera el tamaño máximo admitido.".into());
    }
    let text = std::str::from_utf8(manifest)
        .map_err(|_| "El manifiesto de checksums no está codificado en UTF-8.".to_string())?;
    let mut expected = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let hash = fields.next().unwrap_or_default().trim_start_matches('*');
        let name = fields.next().unwrap_or_default();
        if fields.next().is_some()
            || hash.len() != HASH_BYTES * 2
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || name.is_empty()
        {
            return Err("El manifiesto de checksums contiene una entrada inválida.".into());
        }
        if name == artifact_name && expected.replace(hash.to_ascii_lowercase()).is_some() {
            return Err("El manifiesto contiene más de un hash para el paquete.".into());
        }
    }
    let expected = expected
        .ok_or_else(|| format!("El manifiesto firmado no contiene el hash de {artifact_name}."))?;
    Ok(expected)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

/// Inspecciona los nombres de un tar/zip antes de extraerlo. La extracción se
/// hace en staging aislado y el árbol resultante se vuelve a comprobar en
/// `self_update`, de modo que ni `../`, rutas absolutas ni enlaces simbólicos
/// pueden entrar en la instalación.
pub fn validate_tar_entries(archive: &Path) -> Result<usize, String> {
    let archive_text = archive.to_string_lossy().to_string();
    let tool = archive_tool();
    let output = crate::process::run_with_timeout(tool, &["-tf", &archive_text], VERIFY_TIMEOUT)
        .ok_or("No se pudo ejecutar tar para validar el contenido comprimido.")?;
    if !output.status.success() {
        return Err(format!(
            "No se pudo leer el contenido del archivo comprimido: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let listing = std::str::from_utf8(&output.stdout)
        .map_err(|_| "El listado del archivo comprimido no es UTF-8 válido.".to_string())?;
    let mut count = 0;
    for entry in listing.lines() {
        let entry = entry.trim_end_matches('/');
        if entry.is_empty() {
            continue;
        }
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err("El archivo comprimido contiene demasiadas entradas.".into());
        }
        validate_member_name(entry)?;
    }
    if count == 0 {
        return Err("El archivo comprimido no contiene entradas.".into());
    }
    let verbose = crate::process::run_with_timeout(tool, &["-tvf", &archive_text], VERIFY_TIMEOUT)
        .ok_or("No se pudo comprobar el tipo de las entradas comprimidas.")?;
    if !verbose.status.success() {
        return Err(format!(
            "No se pudo comprobar el tipo de las entradas comprimidas: {}",
            String::from_utf8_lossy(&verbose.stderr).trim()
        ));
    }
    let verbose = std::str::from_utf8(&verbose.stdout)
        .map_err(|_| "El listado detallado del archivo no es UTF-8 válido.".to_string())?;
    validate_archive_entry_types(verbose, count)?;
    Ok(count)
}

fn validate_archive_entry_types(listing: &str, expected_count: usize) -> Result<(), String> {
    let mut count = 0;
    for line in listing.lines().filter(|line| !line.is_empty()) {
        count += 1;
        if !matches!(line.as_bytes().first().copied(), Some(b'-' | b'd')) {
            return Err("El archivo contiene enlaces o tipos de entrada no permitidos.".into());
        }
    }
    if count != expected_count {
        return Err("No se pudo asociar cada ruta con su tipo de entrada comprimida.".into());
    }
    Ok(())
}

fn validate_member_name(name: &str) -> Result<(), String> {
    use std::path::Component;
    if name.is_empty()
        || name.len() > 512
        || name.contains(['\\', '\0'])
        || name.chars().any(char::is_control)
    {
        return Err("El archivo comprimido contiene un nombre de entrada inválido.".into());
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
        || name.split('/').any(|part| {
            if part.is_empty()
                || part.contains([':', '<', '>', '"', '|', '?', '*'])
                || part.ends_with([' ', '.'])
            {
                return true;
            }
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .trim_end_matches([' ', '.'])
                .to_ascii_uppercase();
            matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            ) || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|suffix| {
                    suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
                })
            })
        })
    {
        return Err(format!(
            "El archivo comprimido contiene una ruta peligrosa: {name}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rechaza_rutas_de_archivo_comprimido_que_salen_de_la_raiz() {
        assert!(validate_member_name("../fuera").is_err());
        assert!(validate_member_name("/etc/passwd").is_err());
        assert!(validate_member_name("C:/Windows/system32").is_err());
        assert!(validate_member_name("carpeta\\archivo").is_err());
        assert!(validate_member_name("payload/binario").is_ok());
    }

    #[test]
    fn rechaza_variantes_de_traversal_y_nombres_excesivos() {
        for name in [
            "./archivo",
            "payload/../fuera",
            "payload\\..\\fuera",
            "C:archivo",
            "payload/archivo\0oculto",
            "payload//archivo",
            "payload/archivo:flujo",
            "payload/CON.txt",
            "payload/lpt1.bin",
            "payload/trailing.",
            "payload/trailing ",
            "payload/bad?.txt",
        ] {
            assert!(validate_member_name(name).is_err(), "entrada: {name:?}");
        }
        assert!(validate_member_name(&"a".repeat(513)).is_err());
        assert!(validate_member_name("payload/archivo seguro.txt").is_ok());
    }

    #[test]
    fn rechaza_enlaces_y_archivos_especiales_antes_de_extraer() {
        assert!(
            validate_archive_entry_types("-rw-r--r-- archivo\ndrwxr-xr-x carpeta\n", 2).is_ok()
        );
        assert!(validate_archive_entry_types("lrwxr-xr-x enlace -> /etc/passwd\n", 1).is_err());
        assert!(validate_archive_entry_types("hrw-r--r-- hardlink link to destino\n", 1).is_err());
        assert!(validate_archive_entry_types("-rw-r--r-- archivo\n", 1).is_ok());
        assert!(validate_archive_entry_types("-rw-r--r-- archivo\n", 2).is_err());
    }

    #[test]
    fn verifica_el_hash_exacto_del_archivo_y_rechaza_duplicados() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = dir.path().join("paquete.bin");
        std::fs::write(&artifact, b"contenido de prueba").unwrap();
        let hash = to_hex(ring::digest::digest(&SHA256, b"contenido de prueba").as_ref());
        let manifest = format!("{hash}  paquete.bin\n");
        assert_eq!(
            verify_checksum(manifest.as_bytes(), "paquete.bin", &artifact).unwrap(),
            hash
        );
        let duplicate = format!("{hash}  paquete.bin\n{hash}  paquete.bin\n");
        assert!(verify_checksum(duplicate.as_bytes(), "paquete.bin", &artifact).is_err());
        assert!(manifest_checksum(duplicate.as_bytes(), "paquete.bin").is_err());
    }

    #[test]
    fn puede_validar_el_hash_firmado_sin_descargar_el_paquete() {
        let manifest = format!("{}  terminal.AppImage\n", "a".repeat(64));
        assert_eq!(
            manifest_checksum(manifest.as_bytes(), "terminal.AppImage").unwrap(),
            "a".repeat(64)
        );
        assert!(manifest_checksum(manifest.as_bytes(), "otro.AppImage").is_err());
        assert!(
            manifest_checksum(&vec![b'a'; MANIFEST_MAX_BYTES + 1], "terminal.AppImage").is_err()
        );
    }

    #[test]
    fn verifica_firma_ed25519_real_y_rechaza_cambios_en_manifiesto() {
        use ring::signature::{Ed25519KeyPair, KeyPair};

        let seed = [7u8; 32];
        let pair = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        let key: [u8; PUBLIC_KEY_BYTES] = pair.public_key().as_ref().try_into().unwrap();
        let manifest =
            b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  app.zip\n";
        let signature =
            base64::engine::general_purpose::STANDARD.encode(pair.sign(manifest).as_ref());
        assert!(verify_signature_with_key(manifest, signature.as_bytes(), &key).is_ok());

        let mut altered = manifest.to_vec();
        altered[0] = b'f';
        assert!(verify_signature_with_key(&altered, signature.as_bytes(), &key).is_err());
        assert!(verify_signature_with_key(manifest, b"not base64", &key).is_err());
    }
}
