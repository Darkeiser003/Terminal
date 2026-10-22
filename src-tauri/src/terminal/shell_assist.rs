//! Sugerencias y colores en la línea de órdenes, al estilo de fish o de los
//! plugins de zsh que hacen esto en Konsole.
//!
//! La terminal no reimplementa la edición de línea: cada shell ya tiene su
//! herramienta, que conoce su sintaxis, su historial y su completado, y pintar
//! encima de ella desde xterm chocaría con lo que la shell redibuja. Aquí solo
//! se añaden a la inicialización de la pestaña las líneas que cargan esa
//! herramienta si está instalada:
//!
//! - **cmd**: Clink (sugerencias del historial en gris, colores de órdenes y
//!   argumentos, completado). Las pestañas de cmd arrancan con `/d`, que
//!   desactiva el AutoRun con el que Clink se carga solo, así que se inyecta
//!   aquí.
//! - **PowerShell**: PSReadLine ya colorea; las predicciones del historial se
//!   activan si su versión las admite y nadie las ha configurado.
//! - **bash**: ble.sh si está en su ruta de instalación habitual.
//! - **zsh**: zsh-autosuggestions y zsh-syntax-highlighting desde las rutas
//!   de las distribuciones, de Homebrew o de `~/.zsh`.
//! - **fish** lo trae de serie.
//!
//! Los complementos de bash y zsh se describen una sola vez
//! ([`UNIX_PLUGINS`]): de esa tabla salen la línea de inicialización, la
//! detección del catálogo en Linux y macOS (`packages::commands`) y el
//! marcador que imprime la sonda de cada distro WSL (`environments::wsl`). Así
//! la ruta que se instala, la que se detecta y la que se carga no pueden
//! divergir.
//!
//! Con la preferencia general desactivada, o la de esa shell, no se añade nada
//! y la shell conserva su configuración. En E2E se desactiva por defecto para
//! que las pruebas de eco no dependan de lo que haya instalado en la máquina.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::environments::{ShellKind, Transport};
use crate::platform::traits::HostPlatform;

/// Un complemento de bash o zsh que WTerminal carga si está instalado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnixPlugin {
    /// Nombre visible (y texto con el que se filtra el panel de dependencias).
    pub label: &'static str,
    pub shell: ShellKind,
    /// Lo que imprime la sonda de WSL si está instalado, y el «ejecutable»
    /// con el que el catálogo lo detecta. Tiene que pasar el filtro de nombres
    /// del inventario de WSL (`[A-Za-z0-9._+-]`).
    pub marker: &'static str,
    /// Dónde se busca, en orden. `~/` es la carpeta personal.
    pub paths: &'static [&'static str],
    /// Expresión de la propia shell que es cierta si ya está cargado (por el
    /// `.bashrc`/`.zshrc` del usuario): entonces no se carga dos veces.
    pub loaded: &'static str,
}

/// ble.sh no está en los repositorios de las distribuciones: el catálogo lo
/// instala para el usuario, sin sudo, en esta ruta (`--install ~/.local/share`).
pub const BLESH: UnixPlugin = UnixPlugin {
    label: "ble.sh",
    shell: ShellKind::Bash,
    marker: "wterminal-blesh",
    paths: &["~/.local/share/blesh/ble.sh"],
    loaded: "-n ${BLE_VERSION-}",
};

pub const ZSH_AUTOSUGGESTIONS: UnixPlugin = UnixPlugin {
    label: "zsh-autosuggestions",
    shell: ShellKind::Zsh,
    marker: "wterminal-zsh-autosuggestions",
    paths: &[
        // Debian, Ubuntu, Fedora y openSUSE.
        "/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
        // Arch y Alpine.
        "/usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh",
        // Homebrew (Apple Silicon e Intel).
        "/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
        "/usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
        // Clonado a mano, como indica su README.
        "~/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh",
    ],
    loaded: "${+functions[_zsh_autosuggest_start]}",
};

pub const ZSH_SYNTAX_HIGHLIGHTING: UnixPlugin = UnixPlugin {
    label: "zsh-syntax-highlighting",
    shell: ShellKind::Zsh,
    marker: "wterminal-zsh-syntax-highlighting",
    paths: &[
        "/usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        "/usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        "/opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        "/usr/local/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        "~/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
    ],
    loaded: "${+functions[_zsh_highlight]}",
};

/// El resaltado va el último: su documentación pide cargarlo después de
/// cualquier otro complemento que toque la línea.
pub const UNIX_PLUGINS: [UnixPlugin; 3] = [BLESH, ZSH_AUTOSUGGESTIONS, ZSH_SYNTAX_HIGHLIGHTING];

pub fn plugin_by_marker(marker: &str) -> Option<&'static UnixPlugin> {
    UNIX_PLUGINS.iter().find(|plugin| plugin.marker == marker)
}

/// Si el complemento está instalado en ESTE sistema (Linux, macOS o la
/// carpeta personal de Windows para Git Bash/MSYS2).
pub fn plugin_installed_locally(plugin: &UnixPlugin) -> bool {
    plugin_installed_under(plugin, &crate::paths::home_dir())
}

fn plugin_installed_under(plugin: &UnixPlugin, home: &Path) -> bool {
    plugin
        .paths
        .iter()
        .any(|path| match path.strip_prefix("~/") {
            Some(relative) => home.join(relative).is_file(),
            None => Path::new(path).is_file(),
        })
}

/// Fragmento POSIX para la sonda detallada de WSL: imprime el marcador de
/// cada complemento presente en la distro. Sin comillas dobles ni
/// dependencias: lo ejecuta `sh` (dash, ash o bash).
pub fn plugin_probe_script() -> String {
    UNIX_PLUGINS
        .iter()
        .map(|plugin| {
            let paths: Vec<String> = plugin
                .paths
                .iter()
                .map(|path| match path.strip_prefix("~/") {
                    Some(relative) => format!("\"$HOME\"/{relative}"),
                    None => (*path).to_string(),
                })
                .collect();
            format!(
                "for wt_f in {}; do if [ -r \"$wt_f\" ]; then echo {}; break; fi; done",
                paths.join(" "),
                plugin.marker
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Un color `#rrggbb` ya validado por las preferencias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(u8, u8, u8);

impl Rgb {
    fn parse(hex: &str) -> Option<Rgb> {
        let digits = hex.strip_prefix('#')?;
        if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&digits[range], 16).ok();
        Some(Rgb(channel(0..2)?, channel(2..4)?, channel(4..6)?))
    }

    /// Parámetros SGR de color de texto en 24 bits.
    fn sgr(self) -> String {
        format!("38;2;{};{};{}", self.0, self.1, self.2)
    }

    fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }
}

/// Aspecto de las sugerencias y del coloreado, igual para todas las shells.
/// Cada campo vacío deja el valor de fábrica de la herramienta de esa shell;
/// [`lines_for_styled`] y [`clink_default_settings`] lo traducen a Clink,
/// PSReadLine, ble.sh y los plugins de zsh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistStyle {
    /// Color del texto sugerido (el «fantasma» tras el cursor).
    pub suggestion: Option<Rgb>,
    pub suggestion_italic: bool,
    /// Colorear órdenes y argumentos mientras se escribe.
    pub syntax: bool,
    pub command: Option<Rgb>,
    pub argument: Option<Rgb>,
    /// Orden que no existe.
    pub error: Option<Rgb>,
    /// PowerShell: predicciones en lista bajo la línea en vez de en línea.
    pub list_view: bool,
}

impl AssistStyle {
    /// Lo que hace cada herramienta sin que WTerminal toque nada.
    pub const fn tool_defaults() -> AssistStyle {
        AssistStyle {
            suggestion: None,
            suggestion_italic: false,
            syntax: true,
            command: None,
            argument: None,
            error: None,
            list_view: false,
        }
    }

    pub fn from_preferences(preferences: &crate::preferences::Preferences) -> AssistStyle {
        AssistStyle {
            suggestion: Rgb::parse(&preferences.shell_assist_suggestion_color),
            suggestion_italic: preferences.shell_assist_suggestion_italic,
            syntax: preferences.shell_assist_syntax,
            command: Rgb::parse(&preferences.shell_assist_command_color),
            argument: Rgb::parse(&preferences.shell_assist_argument_color),
            error: Rgb::parse(&preferences.shell_assist_error_color),
            list_view: preferences.shell_assist_list_view,
        }
    }

    /// Estilo de la sugerencia en sintaxis de zsh y ble.sh (`fg=#…,italic`).
    fn unix_suggestion_face(&self) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(color) = self.suggestion {
            parts.push(format!("fg={}", color.hex()));
        }
        if self.suggestion_italic {
            parts.push("italic".to_string());
        }
        (!parts.is_empty()).then(|| parts.join(","))
    }
}

/// Las líneas que cargan el asistente de la línea de órdenes de esta shell.
pub fn init_lines(kind: ShellKind, transport: Transport) -> Vec<String> {
    if !enabled(kind) {
        return Vec::new();
    }
    let style = AssistStyle::from_preferences(&crate::preferences::current());
    let clink = if kind == ShellKind::Cmd && transport == Transport::Native {
        clink_script()
    } else {
        None
    };
    let profile = clink.as_ref().and_then(|_| {
        ensure_clink_profile_with(&clink_profile_dir(), &clink_default_settings(&style))
    });
    let blesh = e2e_blesh_path();
    lines_for_styled(
        kind,
        transport,
        clink.as_deref(),
        profile.as_deref(),
        blesh.as_deref(),
        &style,
    )
}

/// Valores de fábrica de Clink en las pestañas de cmd de WTerminal: las
/// sugerencias del historial en gris tras el cursor (Clink las trae en una
/// lista con F2 de serie) y los colores de órdenes y argumentos que recomienda
/// el propio Clink. Lo que se configure con `clink set` en este perfil manda.
/// La pista alineada a la derecha se apaga: con la rejilla de 1024 columnas de
/// ConPTY quedaría fuera de la vista y ensancharía el scroll horizontal.
pub const CLINK_DEFAULT_SETTINGS: &str = "\
# WTerminal: valores de fábrica de Clink en sus pestañas de cmd.
# Lo que configures con «clink set» en este perfil tiene prioridad.
autosuggest.enable                = True
autosuggest.inline                = True
autosuggest.hint                  = False
color.arginfo                     = sgr 38;5;172
color.argmatcher                  = sgr 1;38;5;40
color.cmd                         = bold
color.cmdredir                    = sgr 38;5;172
color.cmdsep                      = sgr 38;5;135
color.doskey                      = sgr 1;38;5;75
color.executable                  = sgr 1;38;5;33
color.flag                        = sgr 38;5;117
color.input                       = sgr 38;5;214
color.unrecognized                = sgr 38;5;203
history.max_lines                 = 25000
match.substring                   = True
";

/// Los valores de fábrica de Clink con el aspecto elegido en Ajustes. Sin
/// cambios en Ajustes da exactamente [`CLINK_DEFAULT_SETTINGS`].
pub fn clink_default_settings(style: &AssistStyle) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in CLINK_DEFAULT_SETTINGS.lines() {
        let name = line.split_whitespace().next().unwrap_or_default();
        let replaced = match name {
            "color.cmd" | "color.executable" | "color.doskey" if !style.syntax => {
                Some(String::new())
            }
            "color.cmd" | "color.executable" | "color.doskey" => {
                style.command.map(|color| format!("sgr 1;{}", color.sgr()))
            }
            "color.flag" | "color.arginfo" | "color.argmatcher" if !style.syntax => {
                Some(String::new())
            }
            "color.flag" => style.argument.map(|color| format!("sgr {}", color.sgr())),
            "color.unrecognized" if !style.syntax => Some(String::new()),
            "color.unrecognized" => style.error.map(|color| format!("sgr {}", color.sgr())),
            "color.cmdredir" | "color.cmdsep" | "color.input" if !style.syntax => {
                Some(String::new())
            }
            _ => None,
        };
        match replaced {
            // Un color vacío en Clink es «sin color»: el texto queda como el
            // resto de la línea.
            Some(value) => lines.push(format!("{name:<34}= {value}").trim_end().to_string()),
            None => lines.push(line.to_string()),
        }
    }
    let suggestion = match (style.suggestion, style.suggestion_italic) {
        (Some(color), true) => Some(format!("sgr 3;{}", color.sgr())),
        (Some(color), false) => Some(format!("sgr {}", color.sgr())),
        // Clink pinta la sugerencia en «bright black» (90) de serie.
        (None, true) => Some("sgr 3;90".to_string()),
        (None, false) => None,
    };
    if let Some(value) = suggestion {
        lines.push(format!("{:<34}= {value}", "color.suggestion"));
    }
    lines.join("\n") + "\n"
}

/// Perfil de Clink propio de WTerminal: `%LOCALAPPDATA%\WTerminal\clink`
/// (en E2E, dentro del perfil aislado). Así sus valores de fábrica no cambian
/// el Clink que se use fuera de WTerminal. Si el usuario fija `CLINK_PROFILE`,
/// Clink usa ese y este se ignora.
pub fn clink_profile_dir() -> PathBuf {
    if e2e_testing() {
        if let Some(dir) = std::env::var_os("LTERMINAL_E2E_APP_DATA_DIR").map(PathBuf::from) {
            if dir.is_absolute() {
                return dir.join("clink");
            }
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| crate::paths::home_dir().join(".local").join("share"))
        .join(crate::identity::current().name)
        .join("clink")
}

/// Deja el perfil listo con su `default_settings` y lo devuelve; `None` si no
/// se pudo escribir (Clink usará entonces su perfil de siempre).
pub fn ensure_clink_profile(dir: &Path) -> Option<PathBuf> {
    ensure_clink_profile_with(dir, CLINK_DEFAULT_SETTINGS)
}

/// Igual, con unos valores de fábrica concretos (los de Ajustes).
pub fn ensure_clink_profile_with(dir: &Path, settings: &str) -> Option<PathBuf> {
    std::fs::create_dir_all(dir).ok()?;
    let defaults = dir.join("default_settings");
    if std::fs::read_to_string(&defaults).ok().as_deref() != Some(settings) {
        std::fs::write(&defaults, settings).ok()?;
    }
    Some(dir.to_path_buf())
}

fn e2e_testing() -> bool {
    std::env::var("LTERMINAL_E2E_TESTING").as_deref() == Ok("1")
}

/// Solo E2E: un ble.sh instalado en el `/tmp` de la distro de pruebas, para
/// verificar la carga sin tocar la carpeta personal del usuario. La ruta se
/// escribe en la línea de bash, así que solo se aceptan rutas absolutas con
/// caracteres inofensivos.
fn e2e_blesh_path() -> Option<String> {
    if !e2e_testing() {
        return None;
    }
    let path = std::env::var("LTERMINAL_E2E_BLESH_PATH").ok()?;
    safe_absolute_unix_path(&path).then_some(path)
}

fn safe_absolute_unix_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains("..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._+-".contains(c))
}

/// La preferencia general y la de esta shell.
fn enabled(kind: ShellKind) -> bool {
    if e2e_testing() && std::env::var("LTERMINAL_E2E_DISABLE_SHELL_ASSIST").as_deref() == Ok("1") {
        return false;
    }
    shell_enabled(&crate::preferences::current(), kind)
}

fn shell_enabled(preferences: &crate::preferences::Preferences, kind: ShellKind) -> bool {
    preferences.shell_assist
        && match kind {
            ShellKind::Cmd => preferences.shell_assist_cmd,
            ShellKind::Powershell => preferences.shell_assist_powershell,
            ShellKind::Bash => preferences.shell_assist_bash,
            ShellKind::Zsh => preferences.shell_assist_zsh,
            _ => true,
        }
}

#[cfg(test)]
fn lines_for(
    kind: ShellKind,
    transport: Transport,
    clink: Option<&Path>,
    clink_profile: Option<&Path>,
    blesh_override: Option<&str>,
) -> Vec<String> {
    lines_for_styled(
        kind,
        transport,
        clink,
        clink_profile,
        blesh_override,
        &AssistStyle::tool_defaults(),
    )
}

/// PowerShell: lo que hay que pasarle a PSReadLine para el aspecto elegido.
/// `$([char]27)` en vez de `` `e ``, que Windows PowerShell 5.1 no conoce.
fn psreadline_style_lines(style: &AssistStyle) -> Vec<String> {
    let esc = "$([char]27)";
    let mut colors: Vec<String> = Vec::new();
    let suggestion = match (style.suggestion, style.suggestion_italic) {
        (Some(color), italic) => Some(format!("{}{}", color.sgr(), if italic { ";3" } else { "" })),
        (None, true) => Some("97;2;3".to_string()),
        (None, false) => None,
    };
    if let Some(sgr) = suggestion {
        colors.push(format!("InlinePrediction = \"{esc}[{sgr}m\""));
        colors.push(format!("ListPrediction = \"{esc}[{sgr}m\""));
    }
    if style.syntax {
        if let Some(color) = style.command {
            colors.push(format!("Command = \"{esc}[{}m\"", color.sgr()));
        }
        if let Some(color) = style.argument {
            colors.push(format!("Parameter = \"{esc}[{}m\"", color.sgr()));
        }
        if let Some(color) = style.error {
            colors.push(format!("Error = \"{esc}[{}m\"", color.sgr()));
        }
    } else {
        // Sin coloreado: cada clase de token con el color normal del texto.
        for token in [
            "Command",
            "Parameter",
            "Operator",
            "Variable",
            "String",
            "Number",
            "Member",
            "Type",
            "Keyword",
            "Comment",
        ] {
            colors.push(format!("{token} = \"{esc}[39m\""));
        }
    }
    let mut lines = Vec::new();
    if !colors.is_empty() {
        // Una clave por llamada: PSReadLine 2.0 (el de Windows PowerShell 5.1)
        // no conoce `InlinePrediction` ni `ListPrediction`, y una clave
        // desconocida haría fallar la llamada entera.
        let tables: Vec<String> = colors
            .iter()
            .map(|entry| format!("@{{ {entry} }}"))
            .collect();
        lines.push(format!(
            "if (Get-Module PSReadLine) {{ foreach ($wtColor in @({})) {{ try {{ Set-PSReadLineOption -Colors $wtColor }} catch {{}} }} }}",
            tables.join(", ")
        ));
    }
    if style.list_view {
        lines.push("try { $wtPsrl = Get-Module PSReadLine; if ($wtPsrl -and $wtPsrl.Version -ge [version]'2.2.0' -and (Get-PSReadLineOption).PredictionSource -ne 'None') { Set-PSReadLineOption -PredictionViewStyle ListView } } catch {}".to_string());
    }
    lines
}

/// ble.sh: caras que corresponden al aspecto elegido, tras cargarlo.
fn blesh_style_commands(style: &AssistStyle) -> Vec<String> {
    let mut commands = Vec::new();
    if let Some(face) = style.unix_suggestion_face() {
        commands.push(format!("ble-face auto_complete='{face}'"));
    }
    if !style.syntax {
        commands
            .push("bleopt highlight_syntax= highlight_filename= highlight_variable=".to_string());
        return commands;
    }
    if let Some(color) = style.command {
        for face in [
            "command_builtin",
            "command_alias",
            "command_function",
            "command_file",
            "command_keyword",
        ] {
            commands.push(format!("ble-face {face}='fg={}'", color.hex()));
        }
    }
    if let Some(color) = style.argument {
        commands.push(format!("ble-face argument_option='fg={}'", color.hex()));
    }
    if let Some(color) = style.error {
        commands.push(format!("ble-face syntax_error='fg={}'", color.hex()));
    }
    commands
}

/// zsh-syntax-highlighting: estilos tras cargarlo.
fn zsh_highlight_styles(style: &AssistStyle) -> Vec<String> {
    let mut styles = Vec::new();
    if let Some(color) = style.command {
        for key in [
            "command",
            "builtin",
            "alias",
            "function",
            "precommand",
            "arg0",
        ] {
            styles.push(format!("ZSH_HIGHLIGHT_STYLES[{key}]='fg={}'", color.hex()));
        }
    }
    if let Some(color) = style.argument {
        for key in ["single-hyphen-option", "double-hyphen-option"] {
            styles.push(format!("ZSH_HIGHLIGHT_STYLES[{key}]='fg={}'", color.hex()));
        }
    }
    if let Some(color) = style.error {
        styles.push(format!(
            "ZSH_HIGHLIGHT_STYLES[unknown-token]='fg={}'",
            color.hex()
        ));
    }
    styles
}

fn lines_for_styled(
    kind: ShellKind,
    transport: Transport,
    clink: Option<&Path>,
    clink_profile: Option<&Path>,
    blesh_override: Option<&str>,
    style: &AssistStyle,
) -> Vec<String> {
    match kind {
        // `call` es obligatorio: llamar a otro .bat sin él no vuelve y el
        // resto de la inicialización (y su marcador) no se ejecutaría.
        ShellKind::Cmd if transport == Transport::Native => clink
            .map(|script| {
                let profile = clink_profile
                    .map(|dir| format!(" --profile \"{}\"", dir.display()))
                    .unwrap_or_default();
                vec![format!(
                    "call \"{}\" inject --quiet{profile}",
                    script.display()
                )]
            })
            .unwrap_or_default(),
        ShellKind::Powershell => {
            let mut lines = vec![
                "try { $wtPsrl = Get-Module PSReadLine; if ($wtPsrl -and $wtPsrl.Version -ge [version]'2.1.0' -and (Get-PSReadLineOption).PredictionSource -eq 'None') { Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView } } catch {}".to_string(),
            ];
            lines.extend(psreadline_style_lines(style));
            lines
        }
        ShellKind::Bash => {
            let path = blesh_override.unwrap_or(BLESH.paths[0]);
            let faces: String = blesh_style_commands(style)
                .iter()
                .map(|command| format!("; {command}"))
                .collect();
            vec![format!(
                "if [[ $- == *i* && ! {} && -r {path} ]]; then source {path}{faces}; fi",
                BLESH.loaded
            )]
        }
        ShellKind::Zsh => {
            let mut lines = Vec::new();
            // La variable se lee al sugerir, así que vale también si el plugin
            // ya lo había cargado el .zshrc del usuario.
            if let Some(face) = style.unix_suggestion_face() {
                lines.push(format!("ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='{face}'"));
            }
            // Sin coloreado no se carga zsh-syntax-highlighting.
            let plugins: &[UnixPlugin] = if style.syntax {
                &[ZSH_AUTOSUGGESTIONS, ZSH_SYNTAX_HIGHLIGHTING]
            } else {
                &[ZSH_AUTOSUGGESTIONS]
            };
            lines.extend(plugins.iter().map(|plugin| {
                format!(
                    "if (( ! {} )); then for wt_f in {}; do if [[ -r $wt_f ]]; then source $wt_f; break; fi; done; unset wt_f; fi",
                    plugin.loaded,
                    plugin.paths.join(" ")
                )
            }));
            let styles = zsh_highlight_styles(style);
            if style.syntax && !styles.is_empty() {
                lines.push(format!(
                    "if (( ${{+ZSH_HIGHLIGHT_STYLES}} )); then {}; fi",
                    styles.join("; ")
                ));
            }
            lines
        }
        _ => Vec::new(),
    }
}

/// `clink.bat` si Clink está instalado: en el PATH o en sus carpetas de
/// instalación habituales (el instalador no siempre lo añade al PATH).
pub fn clink_script() -> Option<PathBuf> {
    if let Some(path) = crate::path_env::which("clink") {
        return Some(path);
    }
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    clink_candidates(
        env("ProgramFiles(x86)"),
        env("ProgramFiles"),
        env("LOCALAPPDATA"),
    )
    .into_iter()
    .find(|path| path.is_file())
}

fn clink_candidates(
    program_files_x86: Option<PathBuf>,
    program_files: Option<PathBuf>,
    local_app_data: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in [program_files_x86, program_files].into_iter().flatten() {
        candidates.push(root.join("clink").join("clink.bat"));
    }
    if let Some(local) = local_app_data {
        candidates.push(local.join("clink").join("clink.bat"));
        candidates.push(local.join("Programs").join("clink").join("clink.bat"));
    }
    candidates
}

// ---- Estado para Ajustes ----

/// Lo que Ajustes enseña bajo cada interruptor: qué herramienta usa esa shell
/// y si está instalada, aquí o en cada distro WSL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAssistStatus {
    pub shells: Vec<ShellAssistShell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAssistShell {
    /// `cmd`, `powershell`, `bash` o `zsh`: también el sufijo de su
    /// preferencia (`shellAssistBash`...).
    pub shell: &'static str,
    pub components: Vec<ShellAssistComponent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAssistComponent {
    pub label: String,
    /// La distro WSL en la que se comprobó; `None` es este sistema.
    pub distro: Option<String>,
    /// `None` cuando no se sabe: una distro sin inventario detallado (se
    /// obtiene al abrir Entorno y dependencias o con «Comprobar»).
    pub installed: Option<bool>,
    /// Lo que se escribe en el buscador de Entorno y dependencias para llegar
    /// a su instalación.
    pub search: String,
}

/// El estado de cada shell. Con `refresh`, en Windows se hace el inventario
/// detallado de WSL (segundos); sin él solo se usa lo que ya esté en caché,
/// sin arrancar ninguna distro.
#[tauri::command]
pub async fn shell_assist_status(refresh: Option<bool>) -> ShellAssistStatus {
    let refresh = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || collect_status(refresh))
        .await
        .unwrap_or(ShellAssistStatus { shells: Vec::new() })
}

fn collect_status(refresh: bool) -> ShellAssistStatus {
    if !crate::platform::host().is_windows() {
        return ShellAssistStatus {
            shells: [ShellKind::Bash, ShellKind::Zsh]
                .into_iter()
                .map(|kind| ShellAssistShell {
                    shell: shell_key(kind),
                    components: plugins_for(kind)
                        .map(|plugin| ShellAssistComponent {
                            label: plugin.label.to_string(),
                            distro: None,
                            installed: Some(plugin_installed_locally(plugin)),
                            search: plugin.label.to_string(),
                        })
                        .collect(),
                })
                .collect(),
        };
    }

    let distros = if refresh {
        crate::wsl_env::get_wsl_context(crate::wsl_env::ContextOptions {
            online: false,
            details: true,
            probe: true,
        })
        .installed
    } else {
        crate::wsl_env::cached_installed()
    };
    let wsl_components = |kind: ShellKind| -> Vec<ShellAssistComponent> {
        distros
            .iter()
            // zsh solo cuenta en las distros que lo tienen; sin inventario
            // detallado no se sabe, y se enseña igualmente como desconocido.
            .filter(|distro| {
                kind != ShellKind::Zsh
                    || !distro.detailed
                    || distro.shells.iter().any(|s| s == "zsh")
            })
            .flat_map(|distro| {
                plugins_for(kind).map(move |plugin| ShellAssistComponent {
                    label: plugin.label.to_string(),
                    distro: Some(distro.name.clone()),
                    installed: (distro.detailed && !distro.probe_error)
                        .then(|| distro.tools.iter().any(|tool| tool == plugin.marker)),
                    search: plugin.label.to_string(),
                })
            })
            .collect()
    };

    ShellAssistStatus {
        shells: vec![
            ShellAssistShell {
                shell: "cmd",
                components: vec![ShellAssistComponent {
                    label: "Clink".into(),
                    distro: None,
                    installed: Some(clink_script().is_some()),
                    search: "Clink".into(),
                }],
            },
            ShellAssistShell {
                shell: "powershell",
                components: vec![
                    ShellAssistComponent {
                        label: "PSReadLine ≥ 2.1 (Windows PowerShell)".into(),
                        distro: None,
                        installed: Some(
                            windows_powershell_psreadline()
                                .is_some_and(|version| version >= (2, 1)),
                        ),
                        search: "PSReadLine".into(),
                    },
                    ShellAssistComponent {
                        // PowerShell 7 ya trae PSReadLine con predicciones.
                        label: "PowerShell 7".into(),
                        distro: None,
                        installed: Some(crate::path_env::is_tool_installed("pwsh")),
                        search: "PowerShell 7".into(),
                    },
                ],
            },
            ShellAssistShell {
                shell: "bash",
                components: wsl_components(ShellKind::Bash),
            },
            ShellAssistShell {
                shell: "zsh",
                components: wsl_components(ShellKind::Zsh),
            },
        ],
    }
}

fn shell_key(kind: ShellKind) -> &'static str {
    match kind {
        ShellKind::Cmd => "cmd",
        ShellKind::Powershell => "powershell",
        ShellKind::Bash => "bash",
        _ => "zsh",
    }
}

fn plugins_for(kind: ShellKind) -> impl Iterator<Item = &'static UnixPlugin> {
    UNIX_PLUGINS
        .iter()
        .filter(move |plugin| plugin.shell == kind)
}

/// La versión más alta de PSReadLine que cargará Windows PowerShell 5.1,
/// leída de sus carpetas de módulos sin lanzar PowerShell.
fn windows_powershell_psreadline() -> Option<(u32, u32)> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(documents) = dirs::document_dir() {
        roots.push(documents.join("WindowsPowerShell").join("Modules"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        roots.push(program_files.join("WindowsPowerShell").join("Modules"));
    }
    if let Some(system_root) = std::env::var_os("SystemRoot").map(PathBuf::from) {
        roots.push(
            system_root
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("Modules"),
        );
    }
    roots
        .iter()
        .flat_map(|root| module_versions(&root.join("PSReadLine")))
        .max()
}

/// Las versiones de un módulo: una carpeta por versión (`2.4.5`) o, en el que
/// trae Windows, el manifiesto suelto con `ModuleVersion = '2.0.0'`.
fn module_versions(dir: &Path) -> Vec<(u32, u32)> {
    let mut versions: Vec<(u32, u32)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| parse_major_minor(&entry.file_name().to_string_lossy()))
        .collect();
    if let Ok(manifest) = std::fs::read_to_string(dir.join("PSReadLine.psd1")) {
        if let Some(version) = manifest
            .lines()
            .find(|line| line.trim_start().starts_with("ModuleVersion"))
            .and_then(|line| line.split('\'').nth(1))
            .and_then(parse_major_minor)
        {
            versions.push(version);
        }
    }
    versions
}

fn parse_major_minor(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_inyecta_clink_con_call_solo_si_esta_instalado() {
        let clink = PathBuf::from("C:\\Program Files (x86)\\clink\\clink.bat");
        assert_eq!(
            lines_for(ShellKind::Cmd, Transport::Native, Some(&clink), None, None),
            vec!["call \"C:\\Program Files (x86)\\clink\\clink.bat\" inject --quiet"]
        );
        assert!(lines_for(ShellKind::Cmd, Transport::Native, None, None, None).is_empty());
        // cmd dentro de Wine o de otro transporte no carga el Clink del host.
        assert!(lines_for(ShellKind::Cmd, Transport::Wine, Some(&clink), None, None).is_empty());
    }

    #[test]
    fn powershell_solo_activa_las_predicciones_si_nadie_las_configuro() {
        let lines = lines_for(ShellKind::Powershell, Transport::Native, None, None, None);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("try {") && lines[0].ends_with("catch {}"));
        assert!(
            lines[0].contains("[version]'2.1.0'")
                && lines[0].contains("PredictionSource -eq 'None'")
        );
    }

    #[test]
    fn bash_y_zsh_comprueban_en_la_propia_shell_que_el_plugin_exista() {
        let bash = lines_for(ShellKind::Bash, Transport::Wsl, None, None, None).join("\n");
        assert_eq!(
            bash,
            "if [[ $- == *i* && ! -n ${BLE_VERSION-} && -r ~/.local/share/blesh/ble.sh ]]; then source ~/.local/share/blesh/ble.sh; fi"
        );
        let zsh = lines_for(ShellKind::Zsh, Transport::Native, None, None, None);
        assert_eq!(zsh.len(), 2);
        assert!(
            zsh[0].contains("zsh-autosuggestions") && zsh[1].contains("zsh-syntax-highlighting")
        );
        assert!(zsh[0].contains("(( ! ${+functions[_zsh_autosuggest_start]} ))"));
        assert!(zsh[1].contains("/opt/homebrew/share/zsh-syntax-highlighting/"));
        assert!(lines_for(ShellKind::Fish, Transport::Native, None, None, None).is_empty());
        assert!(lines_for(ShellKind::Repl, Transport::Native, None, None, None).is_empty());
    }

    #[test]
    fn la_ruta_de_ble_sh_de_e2e_sustituye_a_la_de_usuario_solo_si_es_inofensiva() {
        let bash = lines_for(
            ShellKind::Bash,
            Transport::Wsl,
            None,
            None,
            Some("/tmp/wterminal-e2e-blesh/blesh/ble.sh"),
        );
        assert!(bash[0].contains("-r /tmp/wterminal-e2e-blesh/blesh/ble.sh ]]"));
        assert!(safe_absolute_unix_path(
            "/tmp/wterminal-e2e-blesh/blesh/ble.sh"
        ));
        assert!(!safe_absolute_unix_path("tmp/ble.sh"));
        assert!(!safe_absolute_unix_path("/tmp/x; rm -rf ~"));
        assert!(!safe_absolute_unix_path("/tmp/$(id)/ble.sh"));
        assert!(!safe_absolute_unix_path("/tmp/../etc/ble.sh"));
    }

    #[test]
    fn cada_shell_se_puede_desactivar_por_separado() {
        let mut preferences = crate::preferences::Preferences::default();
        assert!(preferences.shell_assist && preferences.shell_assist_bash);
        preferences.shell_assist_bash = false;
        assert!(!shell_enabled(&preferences, ShellKind::Bash));
        assert!(shell_enabled(&preferences, ShellKind::Zsh));
        assert!(shell_enabled(&preferences, ShellKind::Cmd));
        // El interruptor general manda sobre los de cada shell.
        preferences.shell_assist = false;
        assert!(!shell_enabled(&preferences, ShellKind::Zsh));
    }

    #[test]
    fn la_sonda_de_wsl_imprime_un_marcador_por_complemento_presente() {
        let script = plugin_probe_script();
        assert_eq!(script.lines().count(), UNIX_PLUGINS.len());
        assert!(script.contains("for wt_f in \"$HOME\"/.local/share/blesh/ble.sh; do"));
        assert!(script.contains("echo wterminal-zsh-autosuggestions; break"));
        assert!(!script.contains('~'));
        // Los marcadores pasan el filtro de nombres del inventario de WSL.
        for plugin in UNIX_PLUGINS {
            assert!(plugin
                .marker
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c)));
            assert_eq!(plugin_by_marker(plugin.marker), Some(&plugin));
        }
        assert_eq!(plugin_by_marker("git"), None);
    }

    #[test]
    fn un_complemento_se_detecta_en_la_carpeta_personal() {
        let home = tempfile::tempdir().unwrap();
        assert!(!plugin_installed_under(&BLESH, home.path()));
        let blesh = home.path().join(".local/share/blesh");
        std::fs::create_dir_all(&blesh).unwrap();
        std::fs::write(blesh.join("ble.sh"), "").unwrap();
        assert!(plugin_installed_under(&BLESH, home.path()));
    }

    #[test]
    fn las_versiones_de_psreadline_se_leen_de_carpetas_y_del_manifiesto() {
        let dir = tempfile::tempdir().unwrap();
        let module = dir.path().join("PSReadLine");
        std::fs::create_dir_all(module.join("2.4.5")).unwrap();
        std::fs::create_dir_all(module.join("no-es-version")).unwrap();
        std::fs::write(
            module.join("PSReadLine.psd1"),
            "@{\n    ModuleVersion = '2.0.0'\n}\n",
        )
        .unwrap();
        let mut versions = module_versions(&module);
        versions.sort();
        assert_eq!(versions, vec![(2, 0), (2, 4)]);
        assert_eq!(parse_major_minor("2.1.0-beta"), Some((2, 1)));
        assert_eq!(parse_major_minor("beta"), None);
        assert_eq!(parse_major_minor("2.1"), Some((2, 1)));
    }

    #[test]
    fn cmd_usa_el_perfil_de_clink_de_wterminal_con_sugerencias_en_linea() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("clink");
        assert_eq!(
            ensure_clink_profile(&profile).as_deref(),
            Some(profile.as_path())
        );
        let defaults = std::fs::read_to_string(profile.join("default_settings")).unwrap();
        assert!(defaults.contains("autosuggest.inline                = True"));
        assert!(defaults.contains("autosuggest.hint                  = False"));
        // Se puede volver a llamar: no reescribe si ya coincide.
        assert!(ensure_clink_profile(&profile).is_some());
        let clink = PathBuf::from("C:\\clink\\clink.bat");
        assert_eq!(
            lines_for(
                ShellKind::Cmd,
                Transport::Native,
                Some(&clink),
                Some(&profile),
                None
            ),
            vec![format!(
                "call \"C:\\clink\\clink.bat\" inject --quiet --profile \"{}\"",
                profile.display()
            )]
        );
    }

    fn estilo() -> AssistStyle {
        AssistStyle {
            suggestion: Rgb::parse("#808080"),
            suggestion_italic: true,
            syntax: true,
            command: Rgb::parse("#00ff00"),
            argument: Rgb::parse("#0080ff"),
            error: Rgb::parse("#ff0000"),
            list_view: true,
        }
    }

    #[test]
    fn sin_cambios_en_ajustes_cada_herramienta_queda_como_venia() {
        let defaults = AssistStyle::tool_defaults();
        assert_eq!(clink_default_settings(&defaults), CLINK_DEFAULT_SETTINGS);
        // Lo único que WTerminal cambia de fábrica: las predicciones de
        // PowerShell en lista. Sin PSReadLine 2.2 o sin predicciones activas
        // la línea no hace nada (va protegida y dentro de `try`).
        let factory = AssistStyle::from_preferences(&crate::preferences::Preferences::default());
        assert_eq!(
            factory,
            AssistStyle {
                list_view: true,
                ..defaults
            }
        );
        let lines = psreadline_style_lines(&factory);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("-PredictionViewStyle ListView"));
        assert!(lines[0].contains("[version]'2.2.0'") && lines[0].starts_with("try {"));
        assert!(psreadline_style_lines(&defaults).is_empty());
        assert!(blesh_style_commands(&defaults).is_empty());
        assert!(zsh_highlight_styles(&defaults).is_empty());
    }

    #[test]
    fn el_aspecto_elegido_se_traduce_a_cada_herramienta() {
        let style = estilo();
        let clink = clink_default_settings(&style);
        assert!(
            clink.contains("color.suggestion                  = sgr 3;38;2;128;128;128"),
            "{clink}"
        );
        assert!(clink.contains("color.executable                  = sgr 1;38;2;0;255;0"));
        assert!(clink.contains("color.flag                        = sgr 38;2;0;128;255"));
        assert!(clink.contains("color.unrecognized                = sgr 38;2;255;0;0"));
        assert!(clink.contains("autosuggest.inline                = True"));

        let ps = lines_for_styled(
            ShellKind::Powershell,
            Transport::Native,
            None,
            None,
            None,
            &style,
        );
        assert_eq!(ps.len(), 3);
        assert!(
            ps[1].contains("InlinePrediction = \"$([char]27)[38;2;128;128;128;3m\""),
            "{}",
            ps[1]
        );
        assert!(ps[1].contains("Command = \"$([char]27)[38;2;0;255;0m\""));
        assert!(ps[2].contains("PredictionViewStyle ListView"));

        let bash =
            lines_for_styled(ShellKind::Bash, Transport::Wsl, None, None, None, &style).join("");
        assert!(
            bash.contains(
                "source ~/.local/share/blesh/ble.sh; ble-face auto_complete='fg=#808080,italic'"
            ),
            "{bash}"
        );
        assert!(bash.contains("ble-face command_file='fg=#00ff00'") && bash.ends_with("; fi"));

        let zsh = lines_for_styled(ShellKind::Zsh, Transport::Native, None, None, None, &style);
        assert_eq!(
            zsh[0],
            "ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=#808080,italic'"
        );
        assert!(zsh[3].contains("ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=#ff0000'"));
    }

    #[test]
    fn sin_coloreado_se_apaga_en_cada_herramienta() {
        let style = AssistStyle {
            syntax: false,
            ..estilo()
        };
        let clink = clink_default_settings(&style);
        assert!(
            clink
                .lines()
                .any(|line| line == "color.executable                  ="),
            "{clink}"
        );
        assert!(!clink.contains("38;5;"));
        let ps = lines_for_styled(
            ShellKind::Powershell,
            Transport::Native,
            None,
            None,
            None,
            &style,
        );
        assert!(ps[1].contains("Keyword = \"$([char]27)[39m\""));
        let bash =
            lines_for_styled(ShellKind::Bash, Transport::Native, None, None, None, &style).join("");
        assert!(bash.contains("bleopt highlight_syntax="));
        let zsh = lines_for_styled(ShellKind::Zsh, Transport::Native, None, None, None, &style)
            .join("\n");
        assert!(!zsh.contains("zsh-syntax-highlighting") && zsh.contains("zsh-autosuggestions"));
    }

    #[test]
    fn clink_se_busca_en_sus_carpetas_de_instalacion() {
        let candidates = clink_candidates(
            Some(PathBuf::from("C:/PF86")),
            Some(PathBuf::from("C:/PF")),
            Some(PathBuf::from("C:/Local")),
        );
        assert_eq!(candidates[0], PathBuf::from("C:/PF86/clink/clink.bat"));
        assert_eq!(
            candidates[3],
            PathBuf::from("C:/Local/Programs/clink/clink.bat")
        );
        assert!(clink_candidates(None, None, None).is_empty());
    }
}
