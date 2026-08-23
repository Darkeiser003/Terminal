//! Extrae el directorio actual a partir del último prompt visible.
//!
//! Port de `electron/main/currentDir.js`.
//!
//! No existe una API portable para consultar el cwd de un proceso hijo (en
//! especial con ConPTY), así que se reconocen los prompts por defecto de las
//! shells que la aplicación crea. Si el usuario personaliza el prompt se
//! conserva el último cwd válido y la UI ofrece acciones sobre la ruta detectada.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::environments::{Environment, Transport};

/// Cuánta salida reciente se mira. El prompt siempre está al final; ir más
/// atrás solo encarece la búsqueda.
const SCAN_WINDOW: usize = 12_000;

pub fn is_windows_host_path(value: &str) -> bool {
    if value.starts_with("\\\\") {
        return true;
    }
    let mut chars = value.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), Some('\\' | '/')) if letter.is_ascii_alphabetic()
    )
}

/// Une dos tramos respetando la convención de la raíz: barras invertidas si es
/// una ruta de Windows, normales en cualquier otro caso.
pub fn join_host_path(root: &str, child: &str) -> String {
    if is_windows_host_path(root) {
        let child = child.replace('/', "\\");
        format!("{}\\{}", root.trim_end_matches('\\'), child)
    } else {
        let child = child.replace('\\', "/");
        format!("{}/{}", root.trim_end_matches('/'), child)
    }
}

static OSC_SEQUENCE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap());
static CSI_SEQUENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());

pub fn strip_ansi(value: &str) -> String {
    let without_osc = OSC_SEQUENCE.replace_all(value, "");
    let without_csi = CSI_SEQUENCE.replace_all(&without_osc, "");
    without_csi.replace('\r', "")
}

/// `/mnt/c/proyecto` -> `C:\proyecto`.
pub fn wsl_path_to_windows(value: &str) -> Option<String> {
    let rest = value.strip_prefix("/mnt/")?;
    let mut chars = rest.chars();
    let letter = chars.next().filter(|c| c.is_ascii_alphabetic())?;
    let tail = match chars.next() {
        None => "",
        Some('/') => &rest[2..],
        Some(_) => return None,
    };
    Some(format!(
        "{}:\\{}",
        letter.to_ascii_uppercase(),
        tail.replace('/', "\\")
    ))
}

/// `/c/proyecto` (Git Bash) -> `C:\proyecto`.
pub fn msys_path_to_windows(value: &str) -> Option<String> {
    let rest = value.strip_prefix('/')?;
    let mut chars = rest.chars();
    let letter = chars.next().filter(|c| c.is_ascii_alphabetic())?;
    let tail = match chars.next() {
        None => "",
        Some('/') => &rest[2..],
        Some(_) => return None,
    };
    Some(format!(
        "{}:\\{}",
        letter.to_ascii_uppercase(),
        tail.replace('/', "\\")
    ))
}

/// Wine monta la raíz del sistema anfitrión en `Z:` y su propio prefijo (con el
/// registro y el `C:\windows` falsos) en `C:`. Solo `Z:` corresponde a rutas
/// reales del host: cualquier otra unidad no existe fuera de Wine y no sirve
/// como cwd.
pub fn wine_path_to_posix(value: &str) -> Option<String> {
    let mut chars = value.chars();
    let letter = chars.next()?;
    if !letter.eq_ignore_ascii_case(&'Z') || chars.next() != Some(':') || chars.next() != Some('\\')
    {
        return None;
    }
    let rest = &value[3..];
    Some(format!(
        "/{}",
        rest.replace('\\', "/").trim_end_matches('/')
    ))
}

/// Traduce la ruta que imprime el prompt a una ruta del sistema anfitrión.
pub fn map_remote_path(raw_path: &str, env: &Environment) -> Option<String> {
    let value = raw_path.trim();
    if value.is_empty() {
        return None;
    }
    // Los entornos nativos creados por plugins o por configuraciones antiguas
    // pueden no traer `host_home`. En Linux Bash suele imprimir `~/carpeta` y,
    // sin esta resolución, el panel recibe una ruta literal relativa que no
    // existe y conserva silenciosamente el home inicial de la pestaña.
    let prompt_home = env.host_home.clone().or_else(|| {
        matches!(env.transport, Transport::Native | Transport::Msys)
            .then(|| crate::paths::home_cwd().to_string_lossy().to_string())
    });
    if value == "~" {
        return prompt_home;
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = prompt_home.as_deref() {
            return Some(join_host_path(home, rest));
        }
    }

    match env.transport {
        Transport::Wsl => {
            if let Some(mounted) = wsl_path_to_windows(value) {
                return Some(mounted);
            }
            // Los archivos internos de una distro también son visibles desde
            // Windows mediante el recurso oficial \\wsl$\<distro>. Esto permite
            // que «Aquí» escanee /home, /opt, etc., no solo /mnt/c.
            match (env.distro.as_deref(), value.starts_with('/')) {
                (Some(distro), true) => Some(format!(
                    "\\\\wsl$\\{distro}\\{}",
                    value[1..].replace('/', "\\")
                )),
                _ => None,
            }
        }
        Transport::Msys => msys_path_to_windows(value),
        Transport::Docker => {
            let (host_root, container_root) =
                (env.host_root.as_deref()?, env.container_root.as_deref()?);
            let root = container_root.trim_end_matches('/');
            if value == root {
                return Some(host_root.to_string());
            }
            value
                .strip_prefix(&format!("{root}/"))
                .map(|rest| join_host_path(host_root, rest))
        }
        _ => Some(value.to_string()),
    }
}

// PowerShell: `PS C:\ruta>` / cmd.exe: `C:\ruta>`
static WINDOWS_PROMPT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)(?:^|\n)(?:PS\s+)?([A-Za-z]:\\[^\n<>|?*]*?)>\s*$").unwrap());

// Git Bash por defecto: "MINGW64 /c/ruta" y el símbolo $ en la línea
// siguiente. También cubre MSYS y MINGW32.
static MSYS_PROMPT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)(?:MSYS|MINGW(?:32|64))\s+([^\n]+)\n[$#]\s*$").unwrap());

// bash/zsh/fish/sh: usuario@host:/ruta$ o root@contenedor:/ruta#.
static POSIX_PROMPT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)(?:^|\n)[^\n:]+:([^\n$#]+)[$#]\s*$").unwrap());

// Prompt frecuente en fish/Starship y configuraciones minimalistas:
// `[usuario@equipo ~/proyecto]$`. No lleva `:` y por eso no entraba en el
// patrón POSIX tradicional; al no registrar el `cd`, cambiar de shell volvía
// a la última ruta conocida (normalmente el home).
static BRACKET_POSIX_PROMPT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)(?:^|\n)\[[^\n\]]+\s((?:~|/)[^\n\]]*)\]\s*[$#]?\s*$").unwrap());

fn last_capture(text: &str, regex: &Regex) -> Option<String> {
    regex
        .captures_iter(text)
        .last()
        .and_then(|captures| captures.get(1))
        .map(|group| group.as_str().to_string())
}

/// Normaliza una ruta de Windows: colapsa separadores repetidos y resuelve los
/// `.` y `..` que quepa resolver sin tocar el disco, como hacía
/// `path.win32.normalize`.
fn normalize_windows(value: &str) -> String {
    let value = value.replace('/', "\\");
    let (prefix, rest) = match value.find(":\\") {
        Some(index) => value.split_at(index + 2),
        None => ("", value.as_str()),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("\\");
    if prefix.is_empty() {
        joined
    } else {
        format!("{prefix}{joined}")
    }
}

/// El directorio actual, o `fallback` si el prompt no se reconoce.
pub fn detect_current_directory(
    output: &str,
    env: &Environment,
    fallback: Option<&str>,
) -> Option<String> {
    let stripped = strip_ansi(output);
    let start = stripped.len().saturating_sub(SCAN_WINDOW);
    // El recorte va a un límite de carácter: partir un UTF-8 por la mitad
    // haría entrar en pánico al indexar.
    let text = &stripped[floor_char_boundary(&stripped, start)..];

    if let Some(found) = last_capture(text, &WINDOWS_PROMPT) {
        if env.transport == Transport::Wine {
            return wine_path_to_posix(&found).or_else(|| fallback.map(str::to_string));
        }
        return Some(normalize_windows(&found));
    }

    if let Some(found) = last_capture(text, &MSYS_PROMPT) {
        return map_remote_path(&found, env);
    }

    if let Some(found) = last_capture(text, &BRACKET_POSIX_PROMPT) {
        return map_remote_path(&found, env);
    }

    if let Some(found) = last_capture(text, &POSIX_PROMPT) {
        return map_remote_path(&found, env);
    }

    fallback.map(str::to_string)
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environments::ShellKind;

    fn env(transport: Transport) -> Environment {
        Environment {
            transport,
            exe: "/bin/sh".into(),
            ..Environment::new("x", "x", ShellKind::Bash, "/bin/sh", &[])
        }
    }

    #[test]
    fn se_reconoce_el_prompt_de_cmd() {
        let out = "Microsoft Windows\r\n\r\nC:\\Users\\Ana>";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Native), None),
            Some("C:\\Users\\Ana".to_string())
        );
    }

    #[test]
    fn se_reconoce_el_prompt_de_powershell() {
        let out = "PS C:\\proyectos\\app>";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Native), None),
            Some("C:\\proyectos\\app".to_string())
        );
    }

    #[test]
    fn manda_el_ultimo_prompt_no_el_primero() {
        let out = "C:\\uno>cd ..\\dos\r\n\r\nC:\\dos>";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Native), None),
            Some("C:\\dos".to_string())
        );
    }

    #[test]
    fn los_colores_del_prompt_no_estorban() {
        let out = "\x1b[32mPS\x1b[0m \x1b[36mC:\\color\x1b[0m>";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Native), None),
            Some("C:\\color".to_string())
        );
    }

    #[test]
    fn un_prompt_irreconocible_conserva_el_ultimo_valido() {
        let out = "❯ ";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Native), Some("C:\\antes")),
            Some("C:\\antes".to_string())
        );
    }

    #[test]
    fn git_bash_traduce_su_ruta_a_windows() {
        let out = "usuario@PC MINGW64 /c/proyectos/app\n$ ";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Msys), None),
            Some("C:\\proyectos\\app".to_string())
        );
    }

    #[test]
    fn reconoce_el_prompt_con_corchetes_de_fish_o_starship() {
        let mut native = env(Transport::Native);
        native.host_home = Some("/home/ana".into());
        assert_eq!(
            detect_current_directory("[ana@pc ~/proyectos/app]$ ", &native, None),
            Some("/home/ana/proyectos/app".to_string())
        );
    }

    #[test]
    fn el_prompt_linux_resuelve_la_virgulilla_sin_metadatos_extra() {
        let native = env(Transport::Native);
        let home = crate::paths::home_cwd();
        assert_eq!(
            detect_current_directory("ana@pc:~/proyectos/app$ ", &native, None),
            Some(home.join("proyectos/app").to_string_lossy().to_string())
        );
    }

    #[test]
    fn wsl_traduce_mnt_a_una_unidad_de_windows() {
        let out = "ana@pc:/mnt/c/proyectos$ ";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Wsl), None),
            Some("C:\\proyectos".to_string())
        );
    }

    #[test]
    fn wsl_usa_el_recurso_de_red_para_sus_rutas_internas() {
        let mut wsl = env(Transport::Wsl);
        wsl.distro = Some("Ubuntu".into());
        let out = "ana@pc:/home/ana$ ";
        assert_eq!(
            detect_current_directory(out, &wsl, None),
            Some("\\\\wsl$\\Ubuntu\\home\\ana".to_string())
        );
    }

    #[test]
    fn sin_distro_una_ruta_interna_de_wsl_no_se_traduce() {
        let out = "ana@pc:/home/ana$ ";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Wsl), None),
            None
        );
    }

    #[test]
    fn la_virgulilla_se_resuelve_con_el_home_del_host() {
        let mut wsl = env(Transport::Wsl);
        wsl.host_home = Some("C:\\Users\\Ana".into());
        assert_eq!(
            map_remote_path("~", &wsl),
            Some("C:\\Users\\Ana".to_string())
        );
        assert_eq!(
            map_remote_path("~/proyectos", &wsl),
            Some("C:\\Users\\Ana\\proyectos".to_string())
        );
    }

    #[test]
    fn docker_traduce_solo_lo_que_cuelga_de_la_carpeta_montada() {
        let mut docker = env(Transport::Docker);
        docker.host_root = Some("C:\\Users\\Ana".into());
        docker.container_root = Some("/workspace".into());
        assert_eq!(
            map_remote_path("/workspace", &docker),
            Some("C:\\Users\\Ana".to_string())
        );
        assert_eq!(
            map_remote_path("/workspace/app", &docker),
            Some("C:\\Users\\Ana\\app".to_string())
        );
        assert_eq!(map_remote_path("/etc", &docker), None);
    }

    #[test]
    fn en_wine_solo_la_unidad_z_es_una_ruta_real() {
        assert_eq!(
            wine_path_to_posix("Z:\\home\\ana"),
            Some("/home/ana".to_string())
        );
        assert_eq!(wine_path_to_posix("C:\\windows"), None);
    }

    #[test]
    fn un_prompt_de_wine_fuera_de_z_conserva_el_anterior() {
        let out = "C:\\windows>";
        assert_eq!(
            detect_current_directory(out, &env(Transport::Wine), Some("/home/ana")),
            Some("/home/ana".to_string())
        );
    }

    #[test]
    fn las_rutas_con_puntos_se_normalizan() {
        assert_eq!(
            normalize_windows("C:\\uno\\..\\dos\\.\\tres"),
            "C:\\dos\\tres"
        );
        assert_eq!(normalize_windows("C:\\\\uno\\\\dos"), "C:\\uno\\dos");
    }

    #[test]
    fn una_salida_larga_con_multibyte_no_entra_en_panico() {
        let relleno = "ñ".repeat(20_000);
        let out = format!("{relleno}\nC:\\final>");
        assert_eq!(
            detect_current_directory(&out, &env(Transport::Native), None),
            Some("C:\\final".to_string())
        );
    }

    #[test]
    fn la_raiz_de_una_unidad_se_reconoce() {
        assert_eq!(wsl_path_to_windows("/mnt/d"), Some("D:\\".to_string()));
        assert_eq!(msys_path_to_windows("/d"), Some("D:\\".to_string()));
        assert_eq!(msys_path_to_windows("/usr/bin"), None);
    }
}
