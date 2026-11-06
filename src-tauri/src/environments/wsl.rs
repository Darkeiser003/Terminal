//! Inventario de WSL compartido por el selector de entornos y por el panel de
//! instalación: distros instaladas, catálogo online, shell predeterminada,
//! gestor de paquetes y herramientas ya presentes dentro de cada distro.
//!
//! Port de `electron/main/wslEnv.js`. Allí había dos implementaciones
//! paralelas (una síncrona y otra con promesas) porque el proceso principal
//! necesitaba las dos; aquí basta una: las sondas de cada distro se lanzan en
//! hilos y se esperan juntas, y un único mutex garantiza que dos peticiones
//! simultáneas no reconstruyan el inventario a la vez.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Cuánto vale una detección correcta. Una instalación o un cambio real en
/// una distro tarda más que esto, y así dos refrescos seguidos (el inventario
/// de arranque y abrir Dependencias) no sondean dos veces cada distro.
const INSTALLED_CACHE: Duration = Duration::from_secs(30);
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
/// Medido en una VM de 8 hilos: Ubuntu sola en frío tarda ~10 s; con siete
/// distros arrancando a la vez, entre 11 y 46 s. 15 s dejaba todas «sin
/// comprobar» bajo carga.
pub const FIRST_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Distros sondeadas a la vez una vez arrancada la VM. WSL serializa buena
/// parte del arranque de cada distro: lanzarlas todas juntas no acaba antes y
/// hace que cada una agote su plazo esperando a las demás.
const PROBE_CONCURRENCY: usize = 3;
/// Inventario detallado (recorre PATH y gestores de versiones). Con la VM
/// cargada, las distros con systemd tardaban más de los 12 s de antes.
const DETAILED_LISTING_TIMEOUT: Duration = Duration::from_secs(30);
const ONLINE_CACHE: Duration = Duration::from_secs(5 * 60);
/// Plazo de `wsl --list --quiet`, que no arranca la VM de WSL.
const LISTING_TIMEOUT: Duration = Duration::from_secs(5);

/// La última lista de distros se quedó sin respuesta: `wsl.exe` no contestó
/// en todo el plazo (su VM arrancando o apagándose), no es que falte WSL, que
/// falla en el acto. Quien hizo el inventario vuelve a preguntar más tarde.
static LISTING_UNANSWERED: AtomicBool = AtomicBool::new(false);

pub fn listing_unanswered() -> bool {
    LISTING_UNANSWERED.load(Ordering::Relaxed)
}

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
    /// La login shell respondió, pero el inventario detallado no llegó a
    /// tiempo. La distro está comprobada (el selector no la marca «sin
    /// comprobar»), pero sus herramientas son desconocidas: el panel no
    /// inventa instalaciones pendientes para ella.
    pub listing_error: bool,
    /// La sonda actual falló (`probe_error` o `listing_error`) y `shell`,
    /// `shells`, `package_manager` y `tools` son los de la última detección
    /// detallada buena de esta sesión. Sin ello, un fallo pasajero de una
    /// sola distro (Alpine en la auditoría) borraba sus acciones del catálogo
    /// hasta el siguiente refresco.
    pub previous_inventory: bool,
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
            listing_error: false,
            previous_inventory: false,
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
            listing_error: false,
            previous_inventory: false,
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
            listing_error: false,
            previous_inventory: false,
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
        DETAILED_LISTING_TIMEOUT,
    ) else {
        // La shell ya respondió: la distro funciona aunque el inventario no
        // llegara. Marcarla «sin comprobar» (como antes) la hacía parecer
        // rota en el selector cuando la VM solo iba cargada.
        return InstalledDistro {
            name: name.to_string(),
            shells: vec![shell.clone()],
            shell,
            package_manager: None,
            tools: Vec::new(),
            detailed: false,
            probe_error: false,
            listing_error: true,
            previous_inventory: false,
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
        listing_error: false,
        previous_inventory: false,
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
        // Igual que el inventario, sin el PATH de Windows (`/mnt/c/...`):
        // cada `command -v` que falla recorre esas carpetas por 9P. Con 87
        // entradas costaba 640 ms por intérprete ausente (7 ms sin ellas) y la
        // sonda de una distro con bash superaba el minuto.
        r#"wt_ifs="$IFS"; IFS=:; wt_linux_path=""; for wt_dir in $PATH; do case "$wt_dir" in /mnt/[A-Za-z]/*) ;; *) wt_linux_path="${wt_linux_path:+$wt_linux_path:}$wt_dir" ;; esac; done; IFS="$wt_ifs"; PATH="$wt_linux_path""#
            .to_string(),
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
        // El REPL de Perl es su depurador (`perl -de0`). `perl-base` (Debian
        // recién instalado) trae `perl` pero no `perl5db.pl`: el REPL moría
        // al abrirse y su pestaña se cerraba. Sin depurador, Perl sigue en
        // `tools` pero no se ofrece como REPL.
        if names.contains(&"perl") {
            format!(
                r#"if command -v perl >/dev/null 2>&1 && ! perl -e 'for (@INC) {{ exit 0 if -e "$_/perl5db.pl" }} exit 1' </dev/null >/dev/null 2>&1; then printf '{UNRUNNABLE_MARKER}%s\n' perl; fi"#
            )
        } else {
            String::new()
        },
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
    /// Una detección reciente con alguna distro fallida que se ha pedido
    /// repetir: no se reutiliza tal cual, pero sus distros válidas sí, y solo
    /// se vuelven a sondear las que fallaron.
    retry_failed: bool,
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

/// La última detección detallada buena de cada distro, por nombre en
/// minúsculas. No la vacía `reset_cache`: refrescar no debe dejar sin
/// catálogo a una distro solo porque esta vez no respondió.
static LAST_GOOD: Lazy<Mutex<HashMap<String, InstalledDistro>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Guarda las distros que respondieron con su inventario completo y rellena
/// las que fallaron con su última detección buena (`previous_inventory`).
/// Las marcas de error se conservan: se siguen reintentando pronto y el
/// selector sigue diciendo que no respondieron.
fn apply_last_good(
    distros: &mut [InstalledDistro],
    last_good: &mut HashMap<String, InstalledDistro>,
) {
    for distro in distros.iter_mut() {
        let key = distro.name.to_lowercase();
        if distro.probe_error || distro.listing_error {
            let Some(previous) = last_good.get(&key) else {
                continue;
            };
            distro.shell = previous.shell.clone();
            distro.shells = previous.shells.clone();
            distro.package_manager = previous.package_manager.clone();
            distro.tools = previous.tools.clone();
            distro.unrunnable = previous.unrunnable.clone();
            distro.previous_inventory = true;
        } else if distro.detailed {
            last_good.insert(key, distro.clone());
        }
    }
}

/// Como `reset_cache`, salvo que la última detección sea detallada y de hace
/// menos de `INSTALLED_CACHE`: entonces se reutiliza. Con siete distros la
/// sonda detallada tarda más de un minuto y arranca todas; abrir Dependencias
/// justo después del inventario de arranque la repetía entera y el panel
/// tardaba más de tres minutos en enseñar nada. Si alguna distro falló (en
/// frío es habitual), solo se vuelven a sondear las que fallaron.
pub fn reset_cache_unless_fresh() {
    let mut cache = CACHE.lock();
    let Some(entry) = cache
        .installed
        .as_mut()
        .filter(|entry| entry.detailed && entry.at.elapsed() < INSTALLED_CACHE)
    else {
        *cache = CacheState::default();
        return;
    };
    entry.retry_failed = entry
        .installed
        .iter()
        .any(|distro| distro.probe_error || distro.listing_error);
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
            let started = Instant::now();
            let rebuilt = rebuild_installed(&cache, options);
            LISTING_UNANSWERED.store(
                rebuilt.is_none() && started.elapsed() >= LISTING_TIMEOUT,
                Ordering::Relaxed,
            );
            let Some(mut fresh) = rebuilt else {
                return WslContext::default();
            };
            apply_last_good(&mut fresh, &mut LAST_GOOD.lock());
            cache.installed = Some(InstalledCache {
                at: Instant::now(),
                detailed: options.details
                    || fresh
                        .iter()
                        .all(|distro| distro.detailed || distro.probe_error),
                installed: fresh.clone(),
                retry_failed: false,
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
    let entry = cache
        .installed
        .as_ref()
        .filter(|entry| !entry.retry_failed)?;
    let has_probe_errors = entry
        .installed
        .iter()
        .any(|distro| distro.probe_error || distro.listing_error);
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
    let mut listing = run_wsl(&["--list", "--quiet"], LISTING_TIMEOUT);
    if listing.is_none() && warm_wsl(Duration::from_secs(8)) {
        listing = run_wsl(&["--list", "--quiet"], LISTING_TIMEOUT);
    }
    let names = parse_installed_distros(&listing?);
    Some(rebuild_with_previous(
        &names,
        reusable_distros(cache),
        options,
        probe_all,
    ))
}

/// Las distros de una detección detallada reciente que respondieron bien.
fn reusable_distros(cache: &CacheState) -> Vec<InstalledDistro> {
    cache
        .installed
        .as_ref()
        .filter(|entry| entry.at.elapsed() < INSTALLED_CACHE)
        .map(|entry| {
            entry
                .installed
                .iter()
                .filter(|distro| distro.detailed && !distro.probe_error && !distro.listing_error)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Si una sola distro falló, se repite el inventario, pero no se pierde la
/// información detallada y válida de las demás ni se vuelven a arrancar: solo
/// se sondean las que faltan. Así pueden seguir apareciendo Fedora · sh/fish,
/// por ejemplo, aunque Ubuntu esté arrancando en frío.
fn rebuild_with_previous<P>(
    names: &[String],
    previous: Vec<InstalledDistro>,
    options: ContextOptions,
    probe: P,
) -> Vec<InstalledDistro>
where
    P: FnOnce(&[String], bool) -> Vec<InstalledDistro>,
{
    let reused = |name: &str| {
        previous
            .iter()
            .find(|candidate| candidate.name.eq_ignore_ascii_case(name))
            .cloned()
    };
    let pending: Vec<String> = names
        .iter()
        .filter(|name| reused(name).is_none())
        .cloned()
        .collect();
    let mut probed = if options.probe && !pending.is_empty() {
        probe(&pending, options.details).into_iter()
    } else {
        Vec::new().into_iter()
    };
    names
        .iter()
        .map(|name| {
            reused(name).unwrap_or_else(|| {
                if options.probe {
                    probed
                        .next()
                        .unwrap_or_else(|| InstalledDistro::failed(name))
                } else {
                    InstalledDistro::unprobed(name)
                }
            })
        })
        .collect()
}

/// Cada sonda entra en su distro y puede tardar segundos; en serie, cuatro
/// distros bloquearían el arranque casi medio minuto. Pero todas a la vez
/// tampoco: en frío compiten por arrancar la VM y agotan el plazo.
///
/// La primera distro se sondea sola (paga el arranque de la VM) y el resto
/// después, como mucho `PROBE_CONCURRENCY` a la vez. El plazo de cada sonda
/// empieza a contar cuando le toca, no mientras espera turno.
fn probe_all(names: &[String], detailed: bool) -> Vec<InstalledDistro> {
    probe_all_with(names, PROBE_CONCURRENCY, |name| {
        probe_distro(name, detailed)
    })
}

fn probe_all_with<F>(names: &[String], concurrency: usize, probe: F) -> Vec<InstalledDistro>
where
    F: Fn(&str) -> InstalledDistro + Sync,
{
    let Some((first, rest)) = names.split_first() else {
        return Vec::new();
    };
    let probe_or_failed = |name: &str| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| probe(name)))
            .unwrap_or_else(|_| InstalledDistro::failed(name))
    };
    let mut results = vec![probe_or_failed(first)];

    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<InstalledDistro>>> =
        rest.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..concurrency.max(1).min(rest.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(name) = rest.get(index) else { break };
                *slots[index].lock() = Some(probe_or_failed(name));
            });
        }
    });
    results.extend(slots.into_iter().zip(rest).map(|(slot, name)| {
        slot.into_inner()
            .unwrap_or_else(|| InstalledDistro::failed(name))
    }));
    // Segunda pasada, de una en una, para las que no respondieron: la VM ya
    // está caliente y nadie compite con ellas. En el E2E del portable, Debian
    // (la última de la cola) agotó sus dos plazos con la VM cargada y quedó
    // «sin comprobar» aunque respondía. El inventario que no llegó también
    // cuenta: en la auditoría de la build 34, Debian respondió a la shell pero
    // no a tiempo a la lista de órdenes, y sus 80 acciones faltaron del panel.
    for (distro, name) in results.iter_mut().zip(names) {
        if distro.probe_error || distro.listing_error {
            *distro = probe_or_failed(name);
        }
    }
    results
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

    #[test]
    fn una_distro_que_falla_conserva_su_ultima_deteccion_buena() {
        let good = |name: &str| InstalledDistro {
            shell: "ash".into(),
            shells: vec!["ash".into(), "sh".into()],
            package_manager: Some("apk".into()),
            tools: vec!["python3".into(), "git".into()],
            detailed: true,
            ..InstalledDistro::unprobed(name)
        };
        let mut last_good = HashMap::new();
        let mut first = vec![good("Alpine"), good("Debian")];
        apply_last_good(&mut first, &mut last_good);
        assert!(first.iter().all(|distro| !distro.previous_inventory));
        assert_eq!(last_good.len(), 2);

        // La sonda siguiente falla en Alpine (sin respuesta) y en Debian
        // (inventario sin terminar); Ubuntu falla sin detección previa.
        let mut debian = InstalledDistro::unprobed("Debian");
        debian.listing_error = true;
        let mut second = vec![
            InstalledDistro::failed("alpine"),
            debian,
            InstalledDistro::failed("Ubuntu"),
        ];
        apply_last_good(&mut second, &mut last_good);
        let alpine = &second[0];
        assert!(alpine.probe_error && alpine.previous_inventory);
        assert_eq!(alpine.shell, "ash");
        assert_eq!(alpine.package_manager.as_deref(), Some("apk"));
        assert_eq!(alpine.tools, vec!["python3".to_string(), "git".to_string()]);
        assert!(second[1].listing_error && second[1].previous_inventory);
        assert_eq!(second[1].tools.len(), 2);
        assert!(!second[2].previous_inventory && second[2].tools.is_empty());

        // Una detección rápida (sin inventario) no pisa la buena guardada, y
        // una distro rellenada no se guarda como si hubiera respondido.
        let mut quick = vec![InstalledDistro::unprobed("Alpine")];
        apply_last_good(&mut quick, &mut last_good);
        assert_eq!(last_good["alpine"].tools.len(), 2);
        assert!(!last_good["alpine"].previous_inventory);
    }

    #[test]
    fn probe_all_sondea_la_primera_sola_y_limita_la_concurrencia() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let names: Vec<String> = (0..7).map(|i| format!("distro{i}")).collect();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let first_alone = AtomicUsize::new(usize::MAX);
        let probed = probe_all_with(&names, 3, |name| {
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            if name == "distro0" {
                first_alone.store(now, Ordering::SeqCst);
            }
            std::thread::sleep(Duration::from_millis(20));
            active.fetch_sub(1, Ordering::SeqCst);
            let mut distro = InstalledDistro::unprobed(name);
            distro.shell = "bash".into();
            distro
        });
        assert_eq!(
            probed
                .iter()
                .map(|distro| distro.name.as_str())
                .collect::<Vec<_>>(),
            names.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert_eq!(
            first_alone.load(Ordering::SeqCst),
            1,
            "la primera sonda arranca la VM sola"
        );
        assert!(peak.load(Ordering::SeqCst) <= 3);
        assert!(probed.iter().all(|distro| !distro.probe_error));
        assert!(probe_all_with(&[], 3, InstalledDistro::failed).is_empty());
    }

    #[test]
    fn repetir_la_deteccion_solo_sondea_las_distros_que_fallaron() {
        let names: Vec<String> = ["Ubuntu", "Debian", "Alpine"]
            .iter()
            .map(|n| n.to_string())
            .collect();
        let mut ubuntu = InstalledDistro::unprobed("Ubuntu");
        ubuntu.detailed = true;
        ubuntu.shell = "bash".into();
        let mut alpine = InstalledDistro::unprobed("Alpine");
        alpine.detailed = true;
        let options = ContextOptions {
            online: false,
            details: true,
            probe: true,
        };
        let mut sondeadas = Vec::new();
        let result = rebuild_with_previous(&names, vec![ubuntu, alpine], options, |pending, _| {
            sondeadas = pending.to_vec();
            pending
                .iter()
                .map(|name| {
                    let mut distro = InstalledDistro::unprobed(name);
                    distro.detailed = true;
                    distro
                })
                .collect()
        });
        assert_eq!(sondeadas, vec!["Debian".to_string()]);
        assert_eq!(
            result.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["Ubuntu", "Debian", "Alpine"]
        );
        assert_eq!(result[0].shell, "bash", "conserva lo detectado de Ubuntu");
        assert!(result.iter().all(|d| d.detailed && !d.probe_error));
    }

    #[test]
    fn una_cache_con_fallos_que_se_pide_repetir_no_se_reutiliza_entera() {
        let mut debian = InstalledDistro::failed("Debian");
        debian.detailed = false;
        let mut ubuntu = InstalledDistro::unprobed("Ubuntu");
        ubuntu.detailed = true;
        let mut cache = CacheState {
            installed: Some(InstalledCache {
                at: Instant::now(),
                installed: vec![ubuntu, debian],
                detailed: true,
                retry_failed: true,
            }),
            online: None,
        };
        let options = ContextOptions {
            online: false,
            details: true,
            probe: true,
        };
        assert!(reusable_installed(&cache, options).is_none());
        assert_eq!(
            reusable_distros(&cache)
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            ["Ubuntu"]
        );
        cache.installed.as_mut().unwrap().retry_failed = false;
        assert!(reusable_installed(&cache, options).is_some());
    }

    #[test]
    fn probe_all_resondea_de_una_en_una_las_que_fallaron() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let names: Vec<String> = ["Ubuntu", "Debian"].iter().map(|n| n.to_string()).collect();
        let debian_calls = AtomicUsize::new(0);
        let probed = probe_all_with(&names, 3, |name| {
            if name == "Debian" && debian_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return InstalledDistro::failed(name);
            }
            InstalledDistro::unprobed(name)
        });
        assert!(probed.iter().all(|distro| !distro.probe_error));
        assert_eq!(debian_calls.load(Ordering::SeqCst), 2);
        // El inventario que no llegó también se repite.
        let listing_calls = AtomicUsize::new(0);
        let probed = probe_all_with(&["Debian".to_string()], 3, |name| {
            let mut distro = InstalledDistro::unprobed(name);
            distro.listing_error = listing_calls.fetch_add(1, Ordering::SeqCst) == 0;
            distro
        });
        assert!(!probed[0].listing_error);
        assert_eq!(listing_calls.load(Ordering::SeqCst), 2);
        // Una distro que de verdad no responde se sondea solo dos veces.
        let calls = AtomicUsize::new(0);
        let probed = probe_all_with(&["Rota".to_string()], 3, |name| {
            calls.fetch_add(1, Ordering::SeqCst);
            InstalledDistro::failed(name)
        });
        assert!(probed[0].probe_error);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn probe_all_convierte_un_panico_en_sonda_fallida() {
        let names = vec!["ok".to_string(), "boom".to_string()];
        let probed = probe_all_with(&names, 3, |name| {
            if name == "boom" {
                panic!("sonda rota");
            }
            InstalledDistro::unprobed(name)
        });
        assert!(!probed[0].probe_error);
        assert!(probed[1].probe_error);
    }

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
        // Sin el PATH de Windows: cada búsqueda fallida por /mnt cuesta ~0,6 s.
        assert!(script.contains(r#"case "$wt_dir" in /mnt/[A-Za-z]/*) ;;"#));
        let filter = script.find("wt_linux_path=\"\"").unwrap();
        assert!(filter < script.find("for wt_exe in").unwrap());
        assert!(script.contains("printf 'wterminal-unrunnable:%s\\n'"));
        assert!(script.trim_end().ends_with("fi"));
        assert!(runnable_probe_script(&[]).is_empty());
        // Perl sin su depurador (`perl-base` de Debian): no se ofrece su REPL.
        assert!(
            !script.contains("perl5db.pl"),
            "sin perl en la lista no se comprueba"
        );
        let with_perl = runnable_probe_script(&["perl".to_string()]);
        assert!(with_perl.contains(r#"exit 0 if -e "$_/perl5db.pl""#));
        assert!(with_perl.contains("printf 'wterminal-unrunnable:%s\\n' perl; fi"));
        assert!(with_perl.trim_end().ends_with("fi"));

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
