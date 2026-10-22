//! Enlaces de la salida de la terminal (Ctrl+clic en xterm).
//!
//! El frontend detecta las URL con `@xterm/addon-web-links` y los
//! hipervínculos OSC 8 de xterm, pero no abre nada por su cuenta: entrega el
//! texto del enlace a `terminal_open_link` y aquí se vuelve a validar. Solo
//! pasan los esquemas de `ALLOWED_SCHEMES`; todo lo demás (`javascript:`,
//! `ms-settings:`, protocolos de aplicaciones…) se rechaza aunque el texto
//! venga de un OSC 8 escrito por un programa.
//!
//! - `http`/`https` se abren en el navegador predeterminado con el opener de
//!   Tauri, con la URL ya normalizada (dominios internacionales en punycode).
//! - `file:` nunca ejecuta: una carpeta se abre en el gestor de archivos y un
//!   archivo se muestra seleccionado en la suya. Solo rutas locales que
//!   existen; un `file://servidor/…` se rechaza para no convertirlo en una
//!   ruta UNC que obligaría a Windows a conectarse a ese servidor.
//!
//! En E2E (`LTERMINAL_E2E_TESTING=1`) no se abre nada: la petición validada se
//! añade a `LTERMINAL_E2E_OPENED_LINKS` para que la prueba la compruebe sin
//! lanzar el navegador. El log guarda la acción y el host, nunca la URL entera
//! (puede llevar tokens de un enlace de acceso).

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Url};

/// Esquemas que un enlace de la terminal puede abrir.
pub const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "file"];

/// Longitud máxima del texto de un enlace. `addon-web-links` deja de unir
/// líneas envueltas a partir de 2048 caracteres; nada más largo es un enlace
/// que alguien quiera abrir a mano.
pub const MAX_LINK_LENGTH: usize = 2048;

/// Qué se hará con un enlace válido.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// `http`/`https`: el navegador predeterminado.
    Web(Url),
    /// `file:` que apunta a una carpeta: se abre en el gestor de archivos.
    Directory(PathBuf),
    /// `file:` que apunta a un archivo: se muestra seleccionado en su carpeta.
    File(PathBuf),
}

impl LinkTarget {
    /// Nombre estable de la acción para la interfaz, el log y el E2E.
    pub fn action(&self) -> &'static str {
        match self {
            Self::Web(_) => "browser",
            Self::Directory(_) => "directory",
            Self::File(_) => "reveal",
        }
    }

    /// Lo que se abre: la URL normalizada o la ruta local.
    pub fn display(&self) -> String {
        match self {
            Self::Web(url) => url.to_string(),
            Self::Directory(path) | Self::File(path) => path.to_string_lossy().into_owned(),
        }
    }
}

/// Por qué no se abre un enlace. `code` es lo que recibe el frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRejection {
    Empty,
    TooLong,
    /// Caracteres de control, espacios o marcas invisibles (bidi, ancho cero):
    /// el texto mostrado no sería el que se abre.
    HiddenCharacters,
    Malformed,
    Scheme,
    MissingHost,
    /// `usuario:contraseña@`: se abriría la contraseña en el historial del
    /// navegador. Un usuario sin contraseña (remotos de git) sí se admite.
    Credentials,
    /// `file://` con un host que no es este equipo.
    RemoteFile,
    /// `file:` cuya ruta no es local y absoluta en este sistema (por ejemplo
    /// una ruta de WSL vista desde Windows).
    NotLocalPath,
    NotFound,
}

impl LinkRejection {
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooLong => "too-long",
            Self::HiddenCharacters => "hidden-characters",
            Self::Malformed => "malformed",
            Self::Scheme => "scheme",
            Self::MissingHost => "missing-host",
            Self::Credentials => "credentials",
            Self::RemoteFile => "remote-file",
            Self::NotLocalPath => "not-local-path",
            Self::NotFound => "not-found",
        }
    }
}

/// Marcas de formato invisibles que permiten mostrar un texto distinto del
/// que se abre: guion blando, anchos cero, controles bidireccionales y BOM.
fn is_invisible_format(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// Valida el texto de un enlace de la terminal y decide qué abrir.
pub fn validate_link(raw: &str) -> Result<LinkTarget, LinkRejection> {
    let host = sysinfo::System::host_name();
    validate_link_with(raw, host.as_deref())
}

/// `validate_link` con el nombre de este equipo explícito, para los tests.
fn validate_link_with(raw: &str, local_host: Option<&str>) -> Result<LinkTarget, LinkRejection> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(LinkRejection::Empty);
    }
    if text.len() > MAX_LINK_LENGTH {
        return Err(LinkRejection::TooLong);
    }
    // El analizador de URL quita tabuladores y saltos de línea en mitad del
    // texto; hay que rechazarlos antes o `exa\nmple.com` abriría `example.com`.
    if text
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || is_invisible_format(c))
    {
        return Err(LinkRejection::HiddenCharacters);
    }
    let url = Url::parse(text).map_err(|_| LinkRejection::Malformed)?;
    match url.scheme() {
        "http" | "https" => {
            match url.host_str() {
                Some(host) if !host.is_empty() => {}
                _ => return Err(LinkRejection::MissingHost),
            }
            if url.password().is_some() {
                return Err(LinkRejection::Credentials);
            }
            Ok(LinkTarget::Web(url))
        }
        "file" => file_target(&url, local_host),
        _ => Err(LinkRejection::Scheme),
    }
}

fn file_target(url: &Url, local_host: Option<&str>) -> Result<LinkTarget, LinkRejection> {
    let host = url.host_str().unwrap_or_default();
    // `ls --hyperlink` escribe el nombre del equipo como host.
    let local = host.is_empty()
        || host.eq_ignore_ascii_case("localhost")
        || local_host.is_some_and(|name| !name.is_empty() && host.eq_ignore_ascii_case(name));
    if !local {
        return Err(LinkRejection::RemoteFile);
    }
    // Sin host, `to_file_path` nunca produce una ruta UNC.
    let local_url =
        Url::parse(&format!("file://{}", url.path())).map_err(|_| LinkRejection::Malformed)?;
    let path = local_url
        .to_file_path()
        .map_err(|_| LinkRejection::NotLocalPath)?;
    if !path.is_absolute() || is_network_path(&path) {
        return Err(LinkRejection::NotLocalPath);
    }
    let metadata = std::fs::metadata(&path).map_err(|_| LinkRejection::NotFound)?;
    Ok(if metadata.is_dir() {
        LinkTarget::Directory(path)
    } else {
        LinkTarget::File(path)
    })
}

/// Rutas UNC y de dispositivo (`\\servidor\…`, `\\?\…`, `//servidor/…`).
fn is_network_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with(r"\\") || text.starts_with("//")
}

/// Respuesta de `terminal_open_link` para la interfaz.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkOpenResult {
    pub ok: bool,
    /// `browser`, `directory` o `reveal`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<&'static str>,
    /// Código de rechazo (`LinkRejection::code`), `disabled` o `open-failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    /// En E2E la petición se registra en vez de abrirse.
    pub simulated: bool,
}

impl LinkOpenResult {
    fn rejected(code: &'static str) -> Self {
        Self {
            error: Some(code),
            ..Self::default()
        }
    }
}

fn e2e_testing() -> bool {
    std::env::var("LTERMINAL_E2E_TESTING").as_deref() == Ok("1")
}

/// Archivo donde el E2E recibe las aperturas simuladas (una línea JSON cada
/// una). Solo en modo de pruebas y con una ruta absoluta.
fn e2e_record_path() -> Option<PathBuf> {
    record_path_from(
        e2e_testing(),
        std::env::var_os("LTERMINAL_E2E_OPENED_LINKS"),
    )
}

fn record_path_from(testing: bool, value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    if !testing {
        return None;
    }
    let path = PathBuf::from(value?);
    path.is_absolute().then_some(path)
}

fn record_e2e_open(target: &LinkTarget) {
    let Some(path) = e2e_record_path() else {
        return;
    };
    let line = serde_json::json!({
        "url": target.display(),
        "action": target.action(),
    });
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(error) = written {
        log_warn!(
            "No se pudo registrar el enlace simulado del E2E",
            serde_json::json!({ "error": error.to_string() })
        );
    }
}

fn open_target(app: &AppHandle, target: &LinkTarget) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    match target {
        LinkTarget::Web(url) => app
            .opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|error| error.to_string()),
        LinkTarget::Directory(path) => {
            crate::platform::open_directory(app, &path.to_string_lossy())
        }
        LinkTarget::File(path) => app
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|error| error.to_string()),
    }
}

/// Lo que se puede registrar de un enlace sin filtrar su ruta ni su consulta.
fn log_host(target: &LinkTarget) -> String {
    match target {
        LinkTarget::Web(url) => url.host_str().unwrap_or_default().to_string(),
        LinkTarget::Directory(_) | LinkTarget::File(_) => String::new(),
    }
}

/// El esquema de un texto rechazado, si parece tener uno, para el log.
fn scheme_hint(raw: &str) -> String {
    raw.trim()
        .split_once(':')
        .map(|(scheme, _)| scheme)
        .filter(|scheme| {
            scheme.len() <= 32
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// `terminal:openLink`
///
/// Abre un enlace que el usuario pulsó con Ctrl+clic en la salida de la
/// terminal. El frontend ya pidió confirmación si así está configurado; aquí
/// se comprueba que los enlaces siguen activados y se valida el texto.
#[tauri::command(async)]
pub fn terminal_open_link(app: AppHandle, url: String) -> LinkOpenResult {
    if !crate::preferences::current().terminal_links {
        return LinkOpenResult::rejected("disabled");
    }
    let target = match validate_link(&url) {
        Ok(target) => target,
        Err(rejection) => {
            log_warn!(
                "Enlace de la terminal rechazado",
                serde_json::json!({ "motivo": rejection.code(), "esquema": scheme_hint(&url) })
            );
            return LinkOpenResult::rejected(rejection.code());
        }
    };
    let action = target.action();
    if e2e_testing() {
        record_e2e_open(&target);
        log_info!(
            "Enlace de la terminal simulado (E2E)",
            serde_json::json!({ "accion": action, "host": log_host(&target) })
        );
        return LinkOpenResult {
            ok: true,
            action: Some(action),
            error: None,
            simulated: true,
        };
    }
    match open_target(&app, &target) {
        Ok(()) => {
            log_info!(
                "Enlace de la terminal abierto",
                serde_json::json!({ "accion": action, "host": log_host(&target) })
            );
            LinkOpenResult {
                ok: true,
                action: Some(action),
                error: None,
                simulated: false,
            }
        }
        Err(error) => {
            log_warn!(
                "No se pudo abrir el enlace de la terminal",
                serde_json::json!({ "accion": action, "host": log_host(&target), "error": error })
            );
            LinkOpenResult {
                ok: false,
                action: Some(action),
                error: Some("open-failed"),
                simulated: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web(raw: &str) -> String {
        match validate_link_with(raw, Some("MI-PC")) {
            Ok(LinkTarget::Web(url)) => url.to_string(),
            other => panic!("{raw} debía ser una URL web: {other:?}"),
        }
    }

    fn rejected(raw: &str) -> LinkRejection {
        validate_link_with(raw, Some("MI-PC")).expect_err(raw)
    }

    #[test]
    fn solo_se_admiten_http_https_y_file() {
        assert_eq!(ALLOWED_SCHEMES, ["http", "https", "file"]);
        assert_eq!(
            web("https://example.com/a?b=1"),
            "https://example.com/a?b=1"
        );
        assert_eq!(web("http://localhost:8080/"), "http://localhost:8080/");
        for raw in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox",
            "ms-settings:privacy",
            "ftp://example.com/archivo",
            "ssh://host",
            "mailto:alguien@example.com",
            "smb://servidor/recurso",
            "search-ms:query=x",
        ] {
            assert_eq!(rejected(raw), LinkRejection::Scheme, "{raw}");
        }
    }

    #[test]
    fn el_esquema_no_distingue_mayusculas_y_la_url_sale_normalizada() {
        assert_eq!(web("HTTPS://Example.COM/Ruta"), "https://example.com/Ruta");
        // Un dominio internacional se muestra y se abre en punycode: un
        // homógrafo («а» cirílica) no pasa por el dominio real.
        let homograph = web("https://ex\u{0430}mple.com/");
        assert!(
            homograph.starts_with("https://xn--") && homograph.ends_with(".com/"),
            "{homograph}"
        );
    }

    #[test]
    fn el_texto_que_se_ve_es_el_que_se_abre() {
        assert_eq!(
            rejected("https://exa\nmple.com"),
            LinkRejection::HiddenCharacters
        );
        assert_eq!(
            rejected("https://exa\tmple.com"),
            LinkRejection::HiddenCharacters
        );
        assert_eq!(
            rejected("https://example.com/a b"),
            LinkRejection::HiddenCharacters
        );
        assert_eq!(
            rejected("https://example.com/\u{202E}gpj.exe"),
            LinkRejection::HiddenCharacters
        );
        assert_eq!(
            rejected("https://exam\u{200B}ple.com"),
            LinkRejection::HiddenCharacters
        );
        assert_eq!(
            rejected("https://example.com/\u{1b}[31m"),
            LinkRejection::HiddenCharacters
        );
        // Los espacios de los extremos sí se toleran (selecciones holgadas).
        assert_eq!(web("  https://example.com/  "), "https://example.com/");
    }

    #[test]
    fn rechaza_textos_vacios_largos_o_mal_formados() {
        assert_eq!(rejected(""), LinkRejection::Empty);
        assert_eq!(rejected("   "), LinkRejection::Empty);
        let long = format!("https://example.com/{}", "a".repeat(MAX_LINK_LENGTH));
        assert_eq!(rejected(&long), LinkRejection::TooLong);
        assert_eq!(rejected("example.com"), LinkRejection::Malformed);
        assert_eq!(rejected("https://"), LinkRejection::Malformed);
        assert_eq!(rejected("http://[::1"), LinkRejection::Malformed);
    }

    #[test]
    fn las_credenciales_no_viajan_al_navegador() {
        assert_eq!(
            rejected("https://usuario:clave@example.com/"),
            LinkRejection::Credentials
        );
        // Un remoto de git con usuario y sin contraseña sí se abre.
        assert_eq!(
            web("https://org@dev.azure.com/org/repo"),
            "https://org@dev.azure.com/org/repo"
        );
        // El truco «google.com@evil.com» queda a la vista: el host es evil.com.
        match validate_link_with("https://google.com@evil.example/", None) {
            Ok(LinkTarget::Web(url)) => assert_eq!(url.host_str(), Some("evil.example")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn file_abre_carpetas_y_muestra_archivos_sin_ejecutarlos() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("programa.exe");
        std::fs::write(&file, b"MZ").unwrap();
        let dir_url = Url::from_directory_path(dir.path()).unwrap();
        let file_url = Url::from_file_path(&file).unwrap();
        assert_eq!(
            validate_link_with(dir_url.as_str(), None),
            Ok(LinkTarget::Directory(dir.path().to_path_buf()))
        );
        let target = validate_link_with(file_url.as_str(), None).unwrap();
        assert_eq!(target, LinkTarget::File(file.clone()));
        assert_eq!(
            target.action(),
            "reveal",
            "un archivo se muestra, no se ejecuta"
        );
        // `ls --hyperlink` usa el nombre del equipo como host.
        let with_host = file_url.as_str().replacen("file:///", "file://mi-pc/", 1);
        assert_eq!(
            validate_link_with(&with_host, Some("MI-PC")),
            Ok(LinkTarget::File(file.clone()))
        );
        let localhost = file_url
            .as_str()
            .replacen("file:///", "file://localhost/", 1);
        assert_eq!(
            validate_link_with(&localhost, None),
            Ok(LinkTarget::File(file))
        );
        let missing = Url::from_file_path(dir.path().join("no-existe.txt")).unwrap();
        assert_eq!(
            validate_link_with(missing.as_str(), None),
            Err(LinkRejection::NotFound)
        );
    }

    #[test]
    fn file_de_otro_equipo_nunca_se_convierte_en_ruta_unc() {
        assert_eq!(
            rejected("file://servidor/recurso/archivo.txt"),
            LinkRejection::RemoteFile
        );
        assert_eq!(
            rejected("file://10.0.0.5/c$/secreto"),
            LinkRejection::RemoteFile
        );
        assert_eq!(
            rejected("file:////servidor/recurso"),
            LinkRejection::NotLocalPath
        );
        assert!(is_network_path(Path::new(r"\\servidor\recurso")));
        assert!(is_network_path(Path::new(r"\\?\C:\Windows")));
        assert!(!is_network_path(Path::new(r"C:\Windows")));
    }

    #[cfg(windows)]
    #[test]
    fn en_windows_una_ruta_unix_de_file_no_es_local() {
        // La ruta de una distro WSL (`ls --hyperlink` dentro de WSL) no existe
        // en Windows con esa forma.
        assert_eq!(
            rejected("file:///home/usuario/archivo"),
            LinkRejection::NotLocalPath
        );
        assert_eq!(
            rejected("file://MI-PC/home/usuario/archivo"),
            LinkRejection::NotLocalPath
        );
    }

    #[test]
    fn el_log_no_guarda_la_ruta_ni_la_consulta() {
        let target = validate_link_with("https://example.com/reset?token=secreto", None).unwrap();
        assert_eq!(log_host(&target), "example.com");
        assert_eq!(
            scheme_hint("javascript:alert(document.cookie)"),
            "javascript"
        );
        assert_eq!(scheme_hint("texto sin esquema"), "");
        assert_eq!(scheme_hint(&format!("{}:x", "a".repeat(64))), "");
    }

    #[test]
    fn la_respuesta_lleva_solo_codigos_estables() {
        let result = serde_json::to_value(LinkOpenResult::rejected("scheme")).unwrap();
        assert_eq!(
            result,
            serde_json::json!({ "ok": false, "error": "scheme", "simulated": false })
        );
        for rejection in [
            LinkRejection::Empty,
            LinkRejection::TooLong,
            LinkRejection::HiddenCharacters,
            LinkRejection::Malformed,
            LinkRejection::Scheme,
            LinkRejection::MissingHost,
            LinkRejection::Credentials,
            LinkRejection::RemoteFile,
            LinkRejection::NotLocalPath,
            LinkRejection::NotFound,
        ] {
            assert!(rejection
                .code()
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '-'));
        }
    }

    #[test]
    fn el_registro_del_e2e_exige_modo_de_pruebas_y_ruta_absoluta() {
        let absolute = std::env::temp_dir().join("enlaces.jsonl");
        // Fuera del modo de pruebas nunca se escribe ningún registro.
        assert_eq!(
            record_path_from(false, Some(absolute.clone().into_os_string())),
            None
        );
        assert_eq!(record_path_from(true, None), None);
        assert_eq!(record_path_from(true, Some("relativo.jsonl".into())), None);
        assert_eq!(
            record_path_from(true, Some(absolute.clone().into_os_string())),
            Some(absolute)
        );
    }
}
