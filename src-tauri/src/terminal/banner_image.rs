//! Imagen propia del banner.
//!
//! El backend solo reserva un margen a la izquierda del banner
//! (`system_info::banner_image_padding`); la imagen la pinta el frontend como
//! una decoración de xterm anclada a la línea del título, así ConPTY nunca la
//! ve y su cursor sigue donde xterm lo espera. Aquí se lee la imagen que elige
//! el usuario y se entrega como `data:`: solo formatos reconocibles por su
//! firma y de un tamaño razonable.

use base64::Engine;
use std::path::Path;

/// Más que suficiente para un logo; evita mandar al WebView un archivo enorme
/// elegido por error.
pub const MAX_BANNER_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Tipo MIME por la firma del archivo. La extensión solo cuenta para SVG, que
/// es texto, y aun así debe contener una etiqueta `<svg`.
pub fn image_mime(bytes: &[u8], extension: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if extension.eq_ignore_ascii_case("svg") {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
        if head.contains("<svg") {
            return Some("image/svg+xml");
        }
    }
    None
}

/// Lee la imagen y la devuelve como URL `data:`.
pub fn read_data_url(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("La ruta de la imagen debe ser absoluta.".into());
    }
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("No se puede leer la imagen: {error}"))?;
    if !metadata.is_file() {
        return Err("La ruta no es un archivo.".into());
    }
    if metadata.len() > MAX_BANNER_IMAGE_BYTES {
        return Err(format!(
            "La imagen ocupa {} MB; el máximo es {} MB.",
            metadata.len().div_ceil(1024 * 1024),
            MAX_BANNER_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("No se puede leer la imagen: {error}"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let mime = image_mime(&bytes, extension)
        .ok_or_else(|| "No es una imagen PNG, JPEG, GIF, WebP, BMP, ICO ni SVG.".to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// `banner:imageRead`: la imagen propia del banner como `data:`.
#[tauri::command(async)]
pub fn banner_image_read(path: String) -> Result<String, String> {
    read_data_url(Path::new(path.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_imagen_se_reconoce_por_su_firma_y_no_por_la_extension() {
        assert_eq!(
            image_mime(b"\x89PNG\r\n\x1a\n....", "jpg"),
            Some("image/png")
        );
        assert_eq!(
            image_mime(&[0xFF, 0xD8, 0xFF, 0xE0], "png"),
            Some("image/jpeg")
        );
        assert_eq!(image_mime(b"GIF89a....", ""), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 ", ""), Some("image/webp"));
        assert_eq!(image_mime(b"BM......", ""), Some("image/bmp"));
        assert_eq!(image_mime(&[0, 0, 1, 0, 1, 0], ""), Some("image/x-icon"));
        assert_eq!(
            image_mime(b"<?xml version='1.0'?><SVG xmlns='x'/>", "svg"),
            Some("image/svg+xml")
        );
        // Un SVG solo por la extensión, o un texto cualquiera, no pasa.
        assert_eq!(image_mime(b"<html></html>", "svg"), None);
        assert_eq!(image_mime(b"<svg></svg>", "txt"), None);
        assert_eq!(image_mime(b"MZ\x90\0", "png"), None);
    }

    #[test]
    fn se_entrega_como_data_url_y_se_rechaza_lo_que_no_es_imagen() {
        let dir =
            std::env::temp_dir().join(format!("wterminal-banner-image-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("logo.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nresto").unwrap();
        let url = read_data_url(&png).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let text = dir.join("nota.png");
        std::fs::write(&text, b"no soy una imagen").unwrap();
        assert!(read_data_url(&text).is_err());
        assert!(read_data_url(Path::new("relativa.png")).is_err());
        assert!(read_data_url(&dir).is_err());
        assert!(read_data_url(&dir.join("no-existe.png")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
