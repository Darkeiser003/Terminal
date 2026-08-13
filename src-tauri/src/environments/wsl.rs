//! Inventario de WSL compartido por el selector de entornos y por el panel de
//! instalación: distros instaladas, catálogo online, shell predeterminada,
//! gestor de paquetes y herramientas ya presentes dentro de cada distro.
//!
//! Port de `electron/main/wslEnv.js`. Allí había dos implementaciones
//! paralelas (una síncrona y otra con promesas) porque el proceso principal
//! necesitaba las dos; aquí basta una: las sondas de cada distro se lanzan en
//! hilos y se esperan juntas, y un único mutex garantiza que dos peticiones
//! simultáneas no reconstruyan el inventario a la vez.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

use crate::platform::traits::HostPlatform;

/// Distros que WSL crea para uso interno de Docker Desktop. No son sistemas en
/// los que tenga sentido abrir una shell.
const INTERNAL_DISTROS: [&str; 2] = ["docker-desktop", "docker-desktop-data"];

pub const KNOWN_SHELLS: [&str; 4] = ["bash", "zsh", "fish", "sh"];

const TOOLS_OF_INTEREST: [&str; 4] = ["node", "npm", "python3", "git"];

const INSTALLED_CACHE: Duration = Duration::from_millis(10_000);
/// Cuánto se recuerda un inventario con sondas fallidas.
///
/// Antes no se recordaba en absoluto: una sonda fallida se consideraba un
/// estado transitorio y se reintentaba siempre. En una máquina donde WSL tarda
/// más que el plazo de la sonda eso NO es transitorio, y el resultado era pagar
/// ~3 s en cada consulta, para siempre: abrir el panel de dependencias costaba
/// el doble porque lo consulta dos veces, con detalle y sin él.
///
/// Recordarlo un rato corto conserva la intención — se reintenta pronto, por si
/// WSL solo estaba frío — sin repetir la espera dentro de la misma operación.
const FAILED_PROBE_CACHE: Duration = Duration::from_secs(30);
const ONLINE_CACHE: Duration = Duration::from_secs(5 * 60);

/// Si `wsl --list --online` no responde, se ofrecen al menos las distros
/// oficiales de siempre en vez de un panel vacío.
#[rustfmt::skip]
static FALLBACK_ONLINE: &[(&str, &str)] = &[
    ("Ubuntu", "Ubuntu"),
    ("Debian", "Debian GNU/Linux"),
    ("kali-linux", "Kali Linux Rolling"),
    ("openSUSE-Tumbleweed", "openSUSE Tumbleweed"),
];

/// `wsl.exe` escribe en UTF-16LE, salvo algunas rutas de error que salen en
/// UTF-8. Se prueba primero UTF-16 y se cae a UTF-8 si el resultado no tiene
/// pinta de texto. Los NUL sobrantes se quitan en los dos casos.
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let utf16: Option<String> = if bytes.len() % 2 == 0 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).ok()
    } else {
        None
    };

    let text = match utf16 {
        Some(text) if text.chars().any(|c| c.is_ascii_alphabetic()) => text,
        _ => String::from_utf8_lossy(bytes).to_string(),
    };
    text.replace('\u{0}', "")
}

fn run_wsl(args: &[&str], timeout: Duration) -> Option<String> {
    let output = crate::platform::run_wsl(args, timeout)?;
    if !output.status.success() {
        return None;
    }
    Some(decode_wsl_output(&output.stdout).trim().to_string())
}

/// La primera llamada a WSL tras arrancar el sistema puede tardar: el servicio
/// se activa en ese momento. Se le da un empujón antes de dar por hecho que no
/// está disponible.
fn warm_wsl(timeout: Duration) -> bool {
    run_wsl(&["--status"], timeout).is_some() || run_wsl(&["--list", "--quiet"], timeout).is_some()
}

pub fn parse_installed_distros(output: &str) -> Vec<String> {
    output
        .lines()
        // El asterisco marca la distro por defecto; no forma parte del nombre.
        .map(|line| line.trim_start().trim_start_matches('*').trim())
        .filter(|name| !name.is_empty())
        .filter(|name| !INTERNAL_DISTROS.contains(&name.to_lowercase().as_str()))
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineDistro {
    pub name: String,
    pub friendly_name: String,
}

/// `wsl --list --online` imprime dos columnas separadas por varios espacios,
/// con una cabecera traducida al idioma del sistema.
pub fn parse_online_distros(output: &str) -> Vec<OnlineDistro> {
    let mut rows = Vec::new();
    for line in output.lines() {
        let columns: Vec<&str> = split_on_double_space(line.trim());
        if columns.len() < 2 {
            continue;
        }
        let name = columns[0].trim();
        if !is_valid_distro_name(name) {
            continue;
        }
        if name.eq_ignore_ascii_case("NAME") || name.eq_ignore_ascii_case("NOMBRE") {
            continue;
        }
        let friendly = columns[1..].join(" ");
        let friendly = friendly.trim();
        rows.push(OnlineDistro {
            name: name.to_string(),
            friendly_name: if friendly.is_empty() {
                name.to_string()
            } else {
                friendly.to_string()
            },
        });
    }
    rows
}

fn split_on_double_space(line: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b' ' && index + 1 < bytes.len() && bytes[index + 1] == b' ' {
            let piece = line[start..index].trim();
            if !piece.is_empty() {
                parts.push(piece);
            }
            while index < bytes.len() && bytes[index] == b' ' {
                index += 1;
            }
            start = index;
            continue;
        }
        index += 1;
    }
    let piece = line[start..].trim();
    if !piece.is_empty() {
        parts.push(piece);
    }
    parts
}

fn is_valid_distro_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledDistro {
    pub name: String,
    /// La login shell del usuario dentro de la distro.
    pub shell: String,
    pub package_manager: Option<String>,
    /// Todas las shells conocidas presentes en la distro.
    pub shells: Vec<String>,
    /// Herramientas de interés ya instaladas dentro de la distro.
    pub tools: Vec<String>,
    /// El inventario completo (`shells`, `package_manager`, `tools`) solo se
    /// pide al abrir Dependencias; en el arranque basta con la login shell.
    pub detailed: bool,
    /// La distro está instalada, pero WSL no respondió durante la sonda.
    pub probe_error: bool,
}

impl InstalledDistro {
    fn unprobed(name: &str) -> InstalledDistro {
        InstalledDistro {
            name: name.to_string(),
            shell: "sh".into(),
            package_manager: None,
            shells: Vec::new(),
            tools: Vec::new(),
            detailed: false,
            probe_error: false,
        }
    }

    fn failed(name: &str) -> InstalledDistro {
        InstalledDistro {
            name: name.to_string(),
            // Las distribuciones oficiales de `wsl --list --online` usan bash
            // por defecto. Se marca como no comprobada para no ocultar que el
            // servicio/distro no respondió durante esta detección.
            shell: "bash".into(),
            package_manager: None,
            shells: Vec::new(),
            tools: Vec::new(),
            detailed: false,
            probe_error: true,
        }
    }
}

/// El orden en el que se busca gestor de paquetes depende de la familia de la
/// distro: en un Fedora con `apt` instalado a mano sigue mandando `dnf`.
fn package_manager_order(distro_name: &str) -> [&'static str; 5] {
    let lower = distro_name.to_lowercase();
    let has = |needle: &str| lower.contains(needle);
    if has("fedora") || has("alma") || has("oracle") || has("rhel") {
        ["dnf", "apt", "pacman", "zypper", "apk"]
    } else if has("arch") {
        ["pacman", "apt", "dnf", "zypper", "apk"]
    } else if has("suse") {
        ["zypper", "apt", "dnf", "pacman", "apk"]
    } else if has("alpine") {
        ["apk", "apt", "dnf", "pacman", "zypper"]
    } else {
        ["apt", "dnf", "pacman", "zypper", "apk"]
    }
}

/// Sondea una distro.
///
/// `wsl.exe ... sh -c <script>` altera algunas comillas al construir la línea
/// de comandos de Windows. Se usan ejecutables directos: una sonda rápida para
/// el selector y, solo al abrir Dependencias, un listado de `/bin` + `/usr/bin`
/// con el que se resuelve todo el inventario de una vez.
pub fn probe_distro(name: &str, detailed: bool) -> InstalledDistro {
    let Some(shell_path) = run_wsl(
        &["-d", name, "--", "printenv", "SHELL"],
        Duration::from_secs(3),
    ) else {
        return InstalledDistro::failed(name);
    };

    let raw_shell = shell_path
        .replace('\\', "/")
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("bash")
        .to_string();
    let shell = if KNOWN_SHELLS.contains(&raw_shell.as_str()) {
        raw_shell
    } else {
        "bash".to_string()
    };

    if !detailed {
        return InstalledDistro {
            name: name.to_string(),
            shells: vec![shell.clone()],
            shell,
            package_manager: None,
            tools: Vec::new(),
            detailed: false,
            probe_error: false,
        };
    }

    let Some(listing) = run_wsl(
        &["-d", name, "--", "ls", "-1", "/bin", "/usr/bin"],
        Duration::from_secs(5),
    ) else {
        return InstalledDistro {
            name: name.to_string(),
            shells: vec![shell.clone()],
            shell,
            package_manager: None,
            tools: Vec::new(),
            detailed: false,
            probe_error: true,
        };
    };

    let commands = parse_command_listing(&listing);
    InstalledDistro {
        name: name.to_string(),
        shells: KNOWN_SHELLS
            .iter()
            .filter(|candidate| commands.contains(**candidate))
            .map(|candidate| candidate.to_string())
            .collect(),
        shell,
        package_manager: package_manager_order(name)
            .iter()
            .find(|candidate| commands.contains(**candidate))
            .map(|found| found.to_string()),
        tools: TOOLS_OF_INTEREST
            .iter()
            .filter(|candidate| commands.contains(**candidate))
            .map(|candidate| candidate.to_string())
            .collect(),
        detailed: true,
        probe_error: false,
    }
}

fn parse_command_listing(listing: &str) -> HashSet<&str> {
    listing
        .lines()
        // `ls -1` puede marcar los ejecutables con un asterisco final.
        .map(|line| line.trim().trim_end_matches('*'))
        .filter(|line| {
            !line.is_empty()
                && line
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
        })
        .collect()
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslContext {
    pub available: bool,
    pub installed: Vec<InstalledDistro>,
    pub online: Vec<OnlineDistro>,
}

/// Qué se quiere del inventario. El arranque pide lo mínimo; el panel de
/// dependencias lo pide todo.
#[derive(Debug, Clone, Copy)]
pub struct ContextOptions {
    /// Consultar el catálogo de distros descargables.
    pub online: bool,
    /// Listar shells, gestor de paquetes y herramientas de cada distro.
    pub details: bool,
    /// Entrar en cada distro. Con `false` solo se listan los nombres.
    pub probe: bool,
}

impl Default for ContextOptions {
    fn default() -> Self {
        ContextOptions {
            online: true,
            details: true,
            probe: true,
        }
    }
}

impl ContextOptions {
    /// Lo que necesita el selector de entornos al arrancar: nombres y login
    /// shell, sin catálogo online ni inventario detallado.
    pub fn quick() -> ContextOptions {
        ContextOptions {
            online: false,
            details: false,
            probe: true,
        }
    }
}

struct InstalledCache {
    at: Instant,
    installed: Vec<InstalledDistro>,
    detailed: bool,
}

struct OnlineCache {
    at: Instant,
    online: Vec<OnlineDistro>,
}

#[derive(Default)]
struct CacheState {
    installed: Option<InstalledCache>,
    online: Option<OnlineCache>,
}

// Un único mutex para todo: además de proteger la caché, serializa las
// reconstrucciones. Si el panel se abre mientras corre la detección rápida, la
// respuesta parcial ya no puede sobrescribir después el inventario detallado.
static CACHE: Lazy<Mutex<CacheState>> = Lazy::new(|| Mutex::new(CacheState::default()));

pub fn reset_cache() {
    *CACHE.lock() = CacheState::default();
}

pub fn get_wsl_context(options: ContextOptions) -> WslContext {
    if !crate::platform::host().is_windows() {
        return WslContext::default();
    }
    let mut cache = CACHE.lock();

    let installed = match reusable_installed(&cache, options) {
        Some(cached) => cached,
        None => {
            let Some(fresh) = rebuild_installed(&cache, options) else {
                return WslContext::default();
            };
            cache.installed = Some(InstalledCache {
                at: Instant::now(),
                detailed: options.details
                    || fresh
                        .iter()
                        .all(|distro| distro.detailed || distro.probe_error),
                installed: fresh.clone(),
            });
            fresh
        }
    };

    let online = if options.online {
        match &cache.online {
            Some(cached) if cached.at.elapsed() < ONLINE_CACHE => cached.online.clone(),
            _ => {
                let fresh = fetch_online();
                cache.online = Some(OnlineCache {
                    at: Instant::now(),
                    online: fresh.clone(),
                });
                fresh
            }
        }
    } else {
        Vec::new()
    };

    WslContext {
        available: true,
        installed,
        online,
    }
}

/// La caché sirve si es reciente, cubre el nivel de detalle que se pide y no
/// guarda ninguna sonda fallida: un fallo es un estado transitorio (WSL suele
/// tardar más en la primera activación en frío), no información útil.
fn reusable_installed(cache: &CacheState, options: ContextOptions) -> Option<Vec<InstalledDistro>> {
    let entry = cache.installed.as_ref()?;
    let has_probe_errors = entry.installed.iter().any(|distro| distro.probe_error);
    let ttl = if has_probe_errors {
        FAILED_PROBE_CACHE
    } else {
        INSTALLED_CACHE
    };
    let fresh_enough = entry.at.elapsed() < ttl;
    let detailed_enough = entry.detailed || !options.details;
    (fresh_enough && detailed_enough).then(|| entry.installed.clone())
}

fn rebuild_installed(cache: &CacheState, options: ContextOptions) -> Option<Vec<InstalledDistro>> {
    let mut listing = run_wsl(&["--list", "--quiet"], Duration::from_secs(5));
    if listing.is_none() && warm_wsl(Duration::from_secs(8)) {
        listing = run_wsl(&["--list", "--quiet"], Duration::from_secs(5));
    }
    let names = parse_installed_distros(&listing?);

    let mut installed: Vec<InstalledDistro> = if options.probe {
        probe_all(&names, options.details)
    } else {
        names
            .iter()
            .map(|name| InstalledDistro::unprobed(name))
            .collect()
    };

    // Si una sola distro falló, se reintenta el inventario, pero no se pierde
    // la información detallada y válida de las demás durante ese reintento
    // rápido. Así pueden seguir apareciendo Fedora · sh/fish, por ejemplo,
    // aunque Ubuntu esté arrancando en frío.
    if !options.details {
        if let Some(previous) = cache
            .installed
            .as_ref()
            .filter(|entry| entry.detailed && entry.at.elapsed() < INSTALLED_CACHE)
        {
            for distro in &mut installed {
                let better = previous.installed.iter().find(|candidate| {
                    candidate.detailed
                        && !candidate.probe_error
                        && candidate.name.eq_ignore_ascii_case(&distro.name)
                });
                if let Some(better) = better {
                    *distro = better.clone();
                }
            }
        }
    }

    Some(installed)
}

/// Cada sonda entra en su distro y puede tardar segundos; en serie, cuatro
/// distros bloquearían el arranque casi medio minuto.
fn probe_all(names: &[String], detailed: bool) -> Vec<InstalledDistro> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = names
            .iter()
            .map(|name| scope.spawn(move || probe_distro(name, detailed)))
            .collect();
        handles
            .into_iter()
            .zip(names)
            .map(|(handle, name)| {
                handle
                    .join()
                    .unwrap_or_else(|_| InstalledDistro::failed(name))
            })
            .collect()
    })
}

fn fetch_online() -> Vec<OnlineDistro> {
    let mut output = run_wsl(&["--list", "--online"], Duration::from_secs(8));
    if output.is_none() && warm_wsl(Duration::from_secs(8)) {
        output = run_wsl(&["--list", "--online"], Duration::from_secs(8));
    }
    let parsed = output
        .map(|text| parse_online_distros(&text))
        .unwrap_or_default();
    if parsed.is_empty() {
        FALLBACK_ONLINE
            .iter()
            .map(|(name, friendly)| OnlineDistro {
                name: name.to_string(),
                friendly_name: friendly.to_string(),
            })
            .collect()
    } else {
        parsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn se_decodifica_la_salida_utf16_de_wsl() {
        assert_eq!(
            decode_wsl_output(&utf16le("Ubuntu\r\nDebian")),
            "Ubuntu\r\nDebian"
        );
    }

    #[test]
    fn una_salida_utf8_tambien_se_entiende() {
        assert_eq!(decode_wsl_output(b"Ubuntu\nDebian"), "Ubuntu\nDebian");
    }

    #[test]
    fn los_nul_sobrantes_desaparecen() {
        assert_eq!(decode_wsl_output(b"U\0b\0u\0"), "Ubu");
    }

    #[test]
    fn el_asterisco_de_la_distro_por_defecto_no_es_parte_del_nombre() {
        assert_eq!(
            parse_installed_distros("* Ubuntu\r\nDebian\r\n"),
            vec!["Ubuntu", "Debian"]
        );
    }

    #[test]
    fn las_distros_internas_de_docker_no_se_ofrecen() {
        assert_eq!(
            parse_installed_distros("Ubuntu\ndocker-desktop\ndocker-desktop-data\n"),
            vec!["Ubuntu"]
        );
    }

    #[test]
    fn una_lista_vacia_no_da_distros() {
        assert!(parse_installed_distros("").is_empty());
        assert!(parse_installed_distros("\r\n  \r\n").is_empty());
    }

    #[test]
    fn se_leen_las_dos_columnas_del_catalogo_online() {
        let out = "NAME                            FRIENDLY NAME\n\
                   Ubuntu                          Ubuntu\n\
                   kali-linux                      Kali Linux Rolling\n";
        assert_eq!(
            parse_online_distros(out),
            vec![
                OnlineDistro {
                    name: "Ubuntu".into(),
                    friendly_name: "Ubuntu".into()
                },
                OnlineDistro {
                    name: "kali-linux".into(),
                    friendly_name: "Kali Linux Rolling".into()
                },
            ]
        );
    }

    #[test]
    fn la_cabecera_traducida_tampoco_cuela_como_distro() {
        let out = "NOMBRE                          NOMBRE DESCRIPTIVO\nUbuntu    Ubuntu\n";
        let parsed = parse_online_distros(out);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "Ubuntu");
    }

    #[test]
    fn una_linea_de_texto_libre_no_se_toma_por_una_distro() {
        let out = "La lista siguiente   muestra las distribuciones\n";
        assert!(parse_online_distros(out).is_empty());
    }

    #[test]
    fn cada_familia_de_distro_busca_su_gestor_primero() {
        assert_eq!(package_manager_order("Fedora-40")[0], "dnf");
        assert_eq!(package_manager_order("Arch")[0], "pacman");
        assert_eq!(package_manager_order("openSUSE-Tumbleweed")[0], "zypper");
        assert_eq!(package_manager_order("Alpine-3.20")[0], "apk");
        assert_eq!(package_manager_order("Ubuntu-22.04")[0], "apt");
    }

    #[test]
    fn del_listado_de_binarios_se_sacan_shells_gestor_y_herramientas() {
        let listing = "bash\nsh\nzsh\napt\napt-get\ngit\nnode\nls*\n[\n";
        let commands = parse_command_listing(listing);
        assert!(commands.contains("bash"));
        assert!(commands.contains("git"));
        // El asterisco de `ls -1` no forma parte del nombre.
        assert!(commands.contains("ls"));
        // Los nombres raros (`[`) se descartan.
        assert!(!commands.contains("["));
    }

    #[test]
    fn una_distro_que_no_responde_se_marca_pero_no_desaparece() {
        let failed = InstalledDistro::failed("Ubuntu");
        assert!(failed.probe_error);
        assert_eq!(failed.shell, "bash");
        assert!(!failed.detailed);
    }

    #[test]
    fn fuera_de_windows_no_hay_contexto_wsl() {
        if cfg!(windows) {
            return;
        }
        let context = get_wsl_context(ContextOptions::default());
        assert!(!context.available);
        assert!(context.installed.is_empty());
    }

    #[test]
    fn el_modo_rapido_no_pide_ni_catalogo_ni_detalles() {
        let quick = ContextOptions::quick();
        assert!(!quick.online);
        assert!(!quick.details);
        assert!(quick.probe);
    }

    #[test]
    fn si_el_catalogo_online_no_responde_se_ofrecen_las_oficiales() {
        // Fuera de Windows `run_wsl` nunca responde, que es la misma rama.
        if cfg!(windows) {
            return;
        }
        let online = fetch_online();
        assert_eq!(online.len(), FALLBACK_ONLINE.len());
        assert_eq!(online[0].name, "Ubuntu");
    }

    #[test]
    fn el_json_conserva_los_nombres_de_la_version_electron() {
        let distro = InstalledDistro::unprobed("Ubuntu");
        let value = serde_json::to_value(&distro).unwrap();
        assert!(value.get("packageManager").is_some());
        assert!(value.get("probeError").is_some());
    }
}
