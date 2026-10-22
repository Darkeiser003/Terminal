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
/// Primera orden dentro de una distro: incluye arrancar la VM de WSL en frío.
pub const FIRST_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
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
    /// Intérpretes presentes que el kernel no puede ejecutar (código 126,
    /// «Exec format error»): por ejemplo, el `node` de Ubuntu 24 en WSL 1.
    /// Siguen en `tools`, pero no se ofrecen como REPL.
    pub unrunnable: Vec<String>,
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
            unrunnable: Vec::new(),
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
            unrunnable: Vec::new(),
        }
    }

    /// Las herramientas que sí se pueden lanzar como REPL.
    pub fn runnable_tools(&self) -> Vec<String> {
        self.tools
            .iter()
            .filter(|tool| !self.unrunnable.contains(tool))
            .cloned()
            .collect()
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

/// Carpetas de usuario donde la sonda busca intérpretes además del PATH:
/// gestores de versiones e instalaciones por usuario. Se añaden al final del
/// PATH de la shell de login para lanzar un REPL o comprobar que se ejecuta,
/// de modo que se usa exactamente el intérprete que se detectó (antes el REPL
/// se lanzaba con `wsl -- <exe>`, sin login, y en Ubuntu sobre WSL 1 acababa
/// en el `/usr/bin/node` del sistema, que no se puede ejecutar, en vez del de
/// `~/.local/bin` que encontró la sonda).
const USER_BIN_DIRS: &[&str] = &[
    "\"$HOME/.cargo/bin\"",
    "\"$HOME/go/bin\"",
    "\"$HOME/.local/bin\"",
    "\"$HOME/.npm-global/bin\"",
    "\"$HOME/.local/share/pnpm\"",
    "\"$HOME/.pub-cache/bin\"",
    "\"$HOME/.asdf/shims\"",
    "\"$HOME/.mise/shims\"",
    "\"$HOME/.local/share/mise/shims\"",
    "\"$HOME/.volta/bin\"",
    "\"$HOME/.bun/bin\"",
    "\"$HOME/.deno/bin\"",
    "\"$HOME/.nvm/versions/node\"/*/bin",
    "\"$HOME/.asdf/installs\"/*/*/bin",
    "\"$HOME/.mise/installs\"/*/*/bin",
];

/// Añade `USER_BIN_DIRS` al PATH de la shell de login (sin repetir ni cambiar
/// el orden del usuario: lo suyo manda).
fn user_path_prelude() -> String {
    format!(
        "for wt_dir in {}; do case \":$PATH:\" in *\":$wt_dir:\"*) ;; *) [ -d \"$wt_dir\" ] && PATH=\"$PATH:$wt_dir\" ;; esac; done; export PATH",
        USER_BIN_DIRS.join(" ")
    )
}

/// Argumentos de `wsl.exe` para abrir un REPL dentro de una distro con el
/// mismo PATH con el que la sonda lo encontró: shell de login y carpetas de
/// usuario. `--exec` pasa los argumentos tal cual (sin otra shell que los
/// interprete) y `exec` deja al intérprete como proceso de la pestaña.
pub fn repl_launch_args(distro: &str, executable: &str, args: &[String]) -> Vec<String> {
    let mut command = vec![
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "sh".to_string(),
        "-lc".to_string(),
        format!("{}; exec \"$0\" \"$@\"", user_path_prelude()),
        executable.to_string(),
    ];
    command.extend(args.iter().cloned());
    command
}

/// Inventario de ejecutables de la distro, uno por línea, más el marcador de
/// cada complemento de la línea de órdenes presente (`shell_assist`).
///
/// - No lanza un `basename` por archivo: con miles de ejecutables eran miles
///   de procesos y la sonda superaba el minuto. `${entry##*/}` y `printf`
///   son de la propia shell.
/// - Se salta el PATH de Windows que WSL añade (`/mnt/c/...`): recorrerlo por
///   el sistema de archivos compartido es lentísimo y sus programas no son
///   herramientas de la distro.
const LISTING_SCRIPT: &str = r#"
emit_dir() {
    [ -d "$1" ] || return 0
    for entry in "$1"/*; do
        [ -x "$entry" ] && printf '%s\n' "${entry##*/}"
    done
}
for directory in \
    /bin /usr/bin /usr/local/bin \
    "$HOME/.cargo/bin" "$HOME/go/bin" "$HOME/.local/bin" "$HOME/.npm-global/bin" \
    "$HOME/.local/share/pnpm" "$HOME/.pub-cache/bin" \
    "$HOME/.asdf/shims" "$HOME/.mise/shims" "$HOME/.local/share/mise/shims" \
    "$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.deno/bin"; do
    emit_dir "$directory"
done
for directory in "$HOME/.nvm/versions/node"/*/bin \
    "$HOME/.asdf/installs"/*/*/bin "$HOME/.mise/installs"/*/*/bin; do
    emit_dir "$directory"
done
old_ifs="$IFS"
IFS=:
for directory in ${PATH:-}; do
    case "$directory" in
        /mnt/[A-Za-z]/*) continue ;;
    esac
    emit_dir "$directory"
done
IFS="$old_ifs"
"#;

/// Sondea una distro: una sonda rápida para el selector y, solo al abrir
/// Dependencias, un inventario de ejecutables de todos los directorios
/// relevantes. No basta con listar `/bin` y `/usr/bin`: rustup, npm global,
/// nvm, asdf/mise y las instalaciones de usuario viven normalmente fuera de
/// esas carpetas.
///
/// Siempre con `--exec`: con `--`, WSL pasa la orden a la login shell de la
/// distro como una cadena, y esa shell expande `$1`, `$HOME`... antes de que
/// el script llegue a `sh`. El inventario salía con error de sintaxis, la
/// distro quedaba «sin comprobar» y el panel no ofrecía nada para ella.
pub fn probe_distro(name: &str, detailed: bool) -> InstalledDistro {
    // `wsl --list` no arranca la máquina virtual de WSL; la primera orden
    // dentro de una distro sí, y en frío tarda varios segundos (más con varias
    // distros a la vez). Con 3 s la sonda caducaba, la distro quedaba «sin
    // comprobar» y luego la pestaña funcionaba igual. Ya en caliente responde
    // en milisegundos; el reintento cubre una VM que arrancó justo al límite.
    let shell_args = ["-d", name, "--exec", "printenv", "SHELL"];
    let Some(shell_path) = run_wsl(&shell_args, FIRST_PROBE_TIMEOUT)
        .or_else(|| run_wsl(&shell_args, RETRY_PROBE_TIMEOUT))
    else {
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
            unrunnable: Vec::new(),
        };
    }

    let language_executables = crate::language_env::unix_language_executables();
    let listing_script = format!(
        "{LISTING_SCRIPT}{}\n{}\n",
        crate::terminal::shell_assist::plugin_probe_script(),
        runnable_probe_script(&language_executables)
    );
    let Some(listing) = run_wsl(
        &["-d", name, "--exec", "sh", "-lc", &listing_script],
        Duration::from_secs(12),
    ) else {
        return InstalledDistro {
            name: name.to_string(),
            shells: vec![shell.clone()],
            shell,
            package_manager: None,
            tools: Vec::new(),
            detailed: false,
            probe_error: true,
            unrunnable: Vec::new(),
        };
    };

    let commands = parse_command_listing(&listing);
    let unrunnable = parse_unrunnable(&listing);
    let catalog_executables = crate::packages::actions::linux_tool_executables();
    let assist_markers = crate::terminal::shell_assist::UNIX_PLUGINS.map(|plugin| plugin.marker);
    let mut seen = HashSet::new();
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
        // Conserva las herramientas generales que usa el panel y añade todos
        // los ejecutables del catálogo de REPL que estén presentes. La lista
        // incluye PATH, rutas de usuario y gestores de versiones, por lo que
        // una instalación de rustup/nvm/asdf no vuelve a aparecer como ausente.
        tools: TOOLS_OF_INTEREST
            .iter()
            .filter(|candidate| commands.contains(**candidate))
            .map(|candidate| candidate.to_string())
            .chain(
                language_executables
                    .into_iter()
                    .filter(|candidate| commands.contains(candidate.as_str())),
            )
            .chain(
                catalog_executables
                    .into_iter()
                    .filter(|candidate| commands.contains(candidate.as_str())),
            )
            // ble.sh y los plugins de zsh no son ejecutables: la sonda imprime
            // un marcador por cada uno que encuentra.
            .chain(
                assist_markers
                    .into_iter()
                    .filter(|marker| commands.contains(marker))
                    .map(str::to_string),
            )
            .filter(|tool| seen.insert(tool.clone()))
            .collect(),
        detailed: true,
        probe_error: false,
        unrunnable,
    }
}

/// Marca de la sonda para un intérprete que el kernel no ejecuta.
const UNRUNNABLE_MARKER: &str = "wterminal-unrunnable:";

fn safe_executable_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
}

/// Comprueba, dentro de la misma llamada del inventario, que cada intérprete
/// de lenguaje presente se puede ejecutar. Solo prueba binarios ELF (es donde
/// aparece «Exec format error»; los lanzadores de Kotlin o Scala son scripts y
/// arrancar sus JVM costaría segundos), todos en paralelo y con `timeout`.
/// Únicamente el código 126 cuenta como roto: un intérprete lento que agota
/// el plazo sí se ejecuta. Se lanza a través de `sh -c 'exec …'` porque
/// `timeout` usa `execvp`, que ante «Exec format error» reintenta el binario
/// como un script y devuelve 2; la shell sí devuelve 126. Resuelve con el
/// mismo PATH que el lanzador del REPL. Sin `timeout` no se prueba nada.
fn runnable_probe_script(executables: &[String]) -> String {
    let names: Vec<&str> = executables
        .iter()
        .map(String::as_str)
        .filter(|name| safe_executable_name(name))
        .collect();
    if names.is_empty() {
        return String::new();
    }
    [
        "if command -v timeout >/dev/null 2>&1; then".to_string(),
        user_path_prelude(),
        format!("for wt_exe in {}; do", names.join(" ")),
        r#"wt_path=$(command -v "$wt_exe" 2>/dev/null) || continue"#.to_string(),
        r#"case "$(head -c 4 "$wt_path" 2>/dev/null)" in ?ELF) ;; *) continue ;; esac"#
            .to_string(),
        format!(
            r#"( timeout 3 sh -c 'exec "$0" --version' "$wt_path" </dev/null >/dev/null 2>&1; [ $? -eq 126 ] && printf '{UNRUNNABLE_MARKER}%s\n' "$wt_exe" ) &"#
        ),
        "done".to_string(),
        "wait".to_string(),
        "fi".to_string(),
    ]
    .join("\n")
}

fn parse_unrunnable(listing: &str) -> Vec<String> {
    let mut found: Vec<String> = listing
        .lines()
        .filter_map(|line| line.trim().strip_prefix(UNRUNNABLE_MARKER))
        .filter(|name| safe_executable_name(name))
        .map(str::to_string)
        .collect();
    found.sort_unstable();
    found.dedup();
    found
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

/// Las distros de la última detección, sin volver a detectar ni arrancar
/// nada, por antigua que sea. Vacío si aún no se ha detectado.
pub fn cached_installed() -> Vec<InstalledDistro> {
    CACHE
        .lock()
        .installed
        .as_ref()
        .map(|entry| entry.installed.clone())
        .unwrap_or_default()
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
    fn un_interprete_que_el_kernel_no_ejecuta_no_se_ofrece_como_repl() {
        // Ubuntu 24 en WSL 1: `/usr/bin/node` existe, pero da «Exec format
        // error» (código 126) y su REPL nunca llegaba a mostrar el prompt.
        let script = runnable_probe_script(&[
            "node".to_string(),
            "python3".to_string(),
            "mal;nombre".to_string(),
        ]);
        assert!(script.contains("for wt_exe in node python3; do"));
        assert!(!script.contains("mal;nombre"));
        assert!(script.contains("?ELF)"));
        assert!(script.contains("timeout 3 sh -c 'exec \"$0\" --version'"));
        assert!(script.contains(&user_path_prelude()));
        assert!(script.contains("[ $? -eq 126 ]"));
        assert!(script.contains("printf 'wterminal-unrunnable:%s\\n'"));
        assert!(script.trim_end().ends_with("fi"));
        assert!(runnable_probe_script(&[]).is_empty());

        let listing = "bash\nnode\npython3\nwterminal-unrunnable:node\nwterminal-unrunnable:../x\n";
        assert_eq!(parse_unrunnable(listing), vec!["node".to_string()]);
        let distro = InstalledDistro {
            tools: vec!["node".to_string(), "python3".to_string()],
            unrunnable: parse_unrunnable(listing),
            ..InstalledDistro::unprobed("Ubuntu")
        };
        assert_eq!(distro.runnable_tools(), vec!["python3".to_string()]);
    }

    /// Ejecuta de verdad el fragmento de sonda en `sh` (Linux) con un falso
    /// ELF que el kernel rechaza y un intérprete que sí funciona.
    #[cfg(unix)]
    #[test]
    fn la_sonda_detecta_en_sh_un_binario_que_no_se_puede_ejecutar() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("wt-roto");
        std::fs::write(&broken, b"\x7fELF basura que el kernel no carga").unwrap();
        std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o755)).unwrap();
        let script = format!(
            "PATH={}:$PATH\n{}",
            dir.path().display(),
            runnable_probe_script(&["wt-roto".to_string(), "sh".to_string()])
        );
        let output = std::process::Command::new("sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert_eq!(parse_unrunnable(&text), vec!["wt-roto".to_string()]);
    }

    #[test]
    fn el_repl_se_lanza_con_el_mismo_path_con_el_que_se_detecto() {
        let args = repl_launch_args("Ubuntu", "node", &["-i".to_string()]);
        assert_eq!(&args[..5], ["-d", "Ubuntu", "--exec", "sh", "-lc"]);
        assert!(args[5].starts_with(&user_path_prelude()));
        assert!(args[5].ends_with("; exec \"$0\" \"$@\""));
        assert_eq!(&args[6..], ["node", "-i"]);
        // Cada carpeta de usuario que se añade al PATH es una de las que
        // recorre la sonda: lo que se detecta es lo que se lanza.
        for directory in USER_BIN_DIRS {
            assert!(LISTING_SCRIPT.contains(directory), "{directory}");
        }
    }

    /// El lanzador de verdad en `sh` (Linux): encuentra un intérprete que
    /// solo está en una carpeta de usuario y le pasa los argumentos intactos.
    #[cfg(unix)]
    #[test]
    fn el_lanzador_del_repl_encuentra_el_interprete_de_la_carpeta_de_usuario() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("wt-repl-falso");
        std::fs::write(&tool, "#!/bin/sh\nprintf '%s|' \"$@\"\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let args = repl_launch_args("X", "wt-repl-falso", &["a b".to_string(), "c".to_string()]);
        let output = std::process::Command::new("sh")
            .args(["-c", &args[5], &args[6], &args[7], &args[8]])
            .env("HOME", home.path())
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "a b|c|");
    }

    #[test]
    fn el_inventario_no_lanza_un_proceso_por_archivo_ni_recorre_el_path_de_windows() {
        assert!(!LISTING_SCRIPT.contains("basename"));
        assert!(LISTING_SCRIPT.contains("${entry##*/}"));
        assert!(LISTING_SCRIPT.contains("/mnt/[A-Za-z]/*) continue"));
        let listing = "bash\nwterminal-blesh\nwterminal-zsh-autosuggestions\n";
        let commands = parse_command_listing(listing);
        assert!(commands.contains("wterminal-blesh"));
        assert!(commands.contains("wterminal-zsh-autosuggestions"));
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
