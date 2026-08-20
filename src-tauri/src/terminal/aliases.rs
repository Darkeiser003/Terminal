//! Inicialización de cada shell: alias "canónicos" heredados del `.hta`
//! original traducidos a la sintaxis nativa de cada familia, más los
//! dinámicos: NSudo (si está presente en esta máquina) y uno por cada script
//! detectado en la carpeta de scripts.
//!
//! Port de `electron/main/aliasProfiles.js`.
//!
//! En todas las shells reales se mantiene el mismo vocabulario (edit, ip, ll,
//! ls, pwd, clear). La sintaxis y el ejecutable subyacente se traducen por
//! familia; así `help`, los comandos de paquetes y los alias canónicos no
//! dependen del sistema que haya detrás.
//!
//! Todo esto NO se teclea en la shell: se escribe en un archivo temporal que la
//! shell carga con una sola línea corta (`call` / dot-source / `source`). Así
//! no se ve la parrafada de alias al abrir la pestaña, no queda un comando
//! gigante en el historial (flecha arriba), y no hay límite práctico de
//! longitud, con lo que todos los scripts detectados llegan a tener alias.

use crate::environments::{ShellKind, Transport};
use crate::i18n::Translator;
use crate::package_aliases::{self, PACKAGE_ALIAS_NAMES};
use crate::shell_paths::unix_path_for;
use crate::stream::CLEAR_MARKER;

/// Cabecera y final del archivo de inicialización por familia de shell.
/// `@echo off` (cmd) es lo que impide que cada línea del archivo se imprima.
struct ScriptFormat {
    ext: &'static str,
    eol: &'static str,
    header: &'static [&'static str],
}

fn script_format(kind: ShellKind) -> Option<ScriptFormat> {
    match kind {
        ShellKind::Cmd => Some(ScriptFormat {
            ext: "cmd",
            eol: "\r\n",
            header: &["@echo off"],
        }),
        ShellKind::Powershell => Some(ScriptFormat {
            ext: "ps1",
            eol: "\r\n",
            header: &[],
        }),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => Some(ScriptFormat {
            ext: "sh",
            eol: "\n",
            header: &[],
        }),
        ShellKind::Fish => Some(ScriptFormat {
            ext: "fish",
            eol: "\n",
            header: &[],
        }),
        // La shell de un dispositivo Android y los REPL no reciben nada.
        ShellKind::Android | ShellKind::Repl => None,
    }
}

/// "clear" y "cls" no están en la tabla de traducción: no son vocabulario sino
/// un comando con tratamiento especial, y no deben recibir los argumentos del
/// usuario (`$*` / `@args`).
#[rustfmt::skip]
pub const WINDOWS_ALIASES: [(&str, &str); 5] = [
    ("edit", "notepad"),
    ("ip",   "ipconfig"),
    ("ll",   "dir"),
    ("ls",   "dir"),
    ("pwd",  "cd"),
];

/// Vocabulario estable que debe existir en todas las shells que aceptan la
/// inicialización de la aplicación. El comando que hay detrás cambia cuando
/// corresponde (por ejemplo `dir` frente a `ls`), pero el nombre y la
/// intención no cambian entre Windows, Linux, Bash, Fish o PowerShell.
pub const CANONICAL_ALIAS_NAMES: [&str; 5] = ["edit", "ip", "ll", "ls", "pwd"];

pub fn unix_aliases(kind: ShellKind) -> Vec<(&'static str, String)> {
    let ip_fallback = if kind == ShellKind::Fish {
        "ip addr 2>/dev/null; or ifconfig"
    } else {
        "ip addr 2>/dev/null || ifconfig"
    };
    vec![
        ("edit", "nano".to_string()),
        ("ip", ip_fallback.to_string()),
        ("ll", "ls -alh".to_string()),
        ("ls", "command ls".to_string()),
        ("pwd", "command pwd".to_string()),
    ]
}

fn powershell_aliases(platform: &str) -> Vec<(&'static str, String)> {
    if platform == "windows" || platform == "win32" {
        return WINDOWS_ALIASES
            .iter()
            .map(|(name, value)| (*name, (*value).to_string()))
            .collect();
    }
    // PowerShell Core en Linux/macOS no entiende la sintaxis POSIX de
    // `unix_aliases`, así que conserva los mismos nombres con comandos
    // nativos de PowerShell. No se usa `||`: así también funciona en hosts
    // con versiones antiguas de PowerShell.
    vec![
        ("edit", "nano".into()),
        (
            "ip",
            "if (Get-Command ip -ErrorAction SilentlyContinue) { ip addr @args } else { ifconfig @args }".into(),
        ),
        ("ll", "Get-ChildItem -Force @args".into()),
        ("ls", "Get-ChildItem @args".into()),
        ("pwd", "Get-Location @args".into()),
    ]
}

/// Comando de limpieza completo por familia de shell:
///   1. marcador: la app vacía pantalla e historial ANTES del repintado,
///   2. borrado nativo (deja limpio también el buffer interno de ConPTY, lo que
///      evita que un repintado posterior resucite lo borrado),
///   3. banner, leído del archivo que la app genera por pestaña.
///
/// El banner lo imprime la SHELL, no la app: así forma parte del buffer de
/// ConPTY y sobrevive a los repintados (si lo pintara la app, el primer
/// redimensionado se lo llevaría por delante).
pub fn clear_command(
    kind: ShellKind,
    banner_path: Option<&str>,
    inside_doskey_macro: bool,
    transport: Transport,
    app_name: &str,
) -> String {
    let title = if app_name.trim().is_empty() {
        "Terminal"
    } else {
        app_name.trim()
    };

    if kind == ShellKind::Cmd {
        let separator = if inside_doskey_macro { "$T" } else { "&" };
        // Dentro de una macro doskey el % hay que duplicarlo: si no, cmd
        // expande %RANDOM% al DEFINIR la macro y el título queda fijo. Un
        // título que no cambia no genera ningún evento, así que la segunda
        // limpieza seguida pasaría desapercibida.
        let random = if inside_doskey_macro {
            "%%RANDOM%%"
        } else {
            "%RANDOM%"
        };
        // El marcador debe llegar antes que el repintado de ConPTY. Cuando
        // llegaba al final, xterm ya había recibido el prompt antiguo y el
        // nuevo, de ahí las dos líneas observadas después de clear/cls.
        //
        // El título vuelve a su valor limpio en cuanto el borrado ya ocurrió.
        // Si el marcador se quedara puesto, ConPTY lo reemite cada vez que un
        // proceso hijo (powershell, winget, wsl...) termina y restaura el
        // título de la consola, y la app interpretaría cada una de esas
        // reemisiones como una limpieza nueva: la salida del comando
        // desaparecía sola y el banner no volvía a pintarse.
        let mut parts = vec![
            format!("@title {title} {CLEAR_MARKER}{random}"),
            "@cls".to_string(),
            format!("@title {title}"),
        ];
        if let Some(banner) = banner_path {
            parts.push(format!("@type \"{banner}\""));
        }
        return parts.join(separator);
    }

    if kind == ShellKind::Powershell {
        let ps_title = title.replace('\'', "''");
        let mut parts = vec![
            format!("$Host.UI.RawUI.WindowTitle = '{ps_title} {CLEAR_MARKER}' + (Get-Random)"),
            "Clear-Host".to_string(),
            format!("$Host.UI.RawUI.WindowTitle = '{ps_title}'"),
        ];
        if let Some(banner) = banner_path {
            parts.push(format!(
                "Write-Host (Get-Content -Raw '{banner}') -NoNewline"
            ));
        }
        return parts.join("; ");
    }

    // bash / zsh / sh / fish / wsl: "command clear" evita que la función se
    // llame a sí misma. El título se escribe a mano porque no todas las shells
    // traen un comando para ello.
    let random = if kind == ShellKind::Fish {
        "(random)"
    } else {
        "\"${RANDOM:-$$}\""
    };
    let safe_title = title.replace('\'', "");
    let mut parts = vec![
        format!("printf '\\033]0;{safe_title} {CLEAR_MARKER}%s\\007' {random}"),
        "command clear".to_string(),
        format!("printf '\\033]0;{safe_title}\\007'"),
    ];
    if let Some(banner) = banner_path {
        parts.push(format!("cat '{}'", unix_path_for(banner, transport)));
    }
    parts.join("; ")
}

/// Redefine clear/cls en la shell. En PowerShell hay que forzar los alias: la
/// resolución de comandos da prioridad a los alias integrados
/// (`clear` -> `Clear-Host`) sobre cualquier función que definamos.
fn clear_alias_lines(
    kind: ShellKind,
    banner_clear_path: Option<&str>,
    transport: Transport,
    app_name: &str,
) -> Vec<String> {
    if kind == ShellKind::Cmd {
        let body = clear_command(kind, banner_clear_path, true, transport, app_name);
        return vec![format!("doskey cls={body}"), format!("doskey clear={body}")];
    }
    let body = clear_command(kind, banner_clear_path, false, transport, app_name);

    if kind == ShellKind::Powershell {
        // -Option AllScope es obligatorio: los alias integrados clear/cls ya lo
        // llevan, y PowerShell rechaza redefinirlos si al hacerlo se les
        // quitaría esa opción ("La opción AllScope no se puede quitar").
        return vec![
            format!("function Clear-TerminalHost {{ {body} }}"),
            "Set-Alias -Name clear -Value Clear-TerminalHost -Option AllScope -Force -Scope Global"
                .to_string(),
            "Set-Alias -Name cls -Value Clear-TerminalHost -Option AllScope -Force -Scope Global"
                .to_string(),
        ];
    }
    // "cls" también en shells unix: en Windows es el nombre que la gente teclea
    // por costumbre, y aquí Git Bash/WSL conviven con cmd en la misma ventana
    // (sin esto, "cls" solo responde "command not found").
    if kind == ShellKind::Fish {
        return vec![
            format!("function clear; {body}; end"),
            "function cls; clear; end".to_string(),
        ];
    }
    vec![
        format!("clear() {{ {body}; }}"),
        "cls() { clear; }".to_string(),
    ]
}

fn quote_windows_double(path: &str) -> String {
    format!("\"{}\"", path.replace('"', "\"\""))
}

/// Escapa una comilla simple dentro de una cadena entrecomillada con comillas
/// simples. fish admite `\'`; el resto de shells POSIX necesitan cerrar,
/// escapar y volver a abrir.
fn escape_single_quotes(value: &str, kind: ShellKind) -> String {
    if kind == ShellKind::Fish {
        value.replace('\'', "\\'")
    } else {
        value.replace('\'', "'\\''")
    }
}

/// Comando NSudo (TrustedInstaller + todos los privilegios), la combinación más
/// alta disponible, tal como la documenta el propio `-?` de NSudoLC.exe.
fn nsudo_alias_line(
    kind: ShellKind,
    nsudo_path: Option<&str>,
    transport: Transport,
) -> Option<String> {
    let nsudo_path = nsudo_path?;
    if kind == ShellKind::Cmd {
        return Some(format!(
            "doskey nsudo={} -U:T -P:E $*",
            quote_windows_double(nsudo_path)
        ));
    }
    if kind == ShellKind::Powershell {
        return Some(format!(
            "function nsudo {{ & {} -U:T -P:E @args }}",
            quote_windows_double(nsudo_path)
        ));
    }
    // bash / zsh / sh / fish / WSL: NSudoLC.exe es un binario de Windows; se
    // llama por su ruta traducida al estilo de cada una (WSL: /mnt/c/...,
    // Git Bash/MSYS: /c/...).
    let translated = unix_path_for(nsudo_path, transport);
    Some(format!(
        "alias nsudo='{} -U:T -P:E'",
        escape_single_quotes(&translated, kind)
    ))
}

/// "sysinfo": imprime el banner del sistema que ya generó la app para esta
/// pestaña. Se evita fastfetch/neofetch: su salida es enorme y no escala cuando
/// hay varias pestañas a la vez (repite logo y ocupa más de lo que la casilla
/// admite). Si no hay banner (temporal no escribible), se cae a un comando
/// nativo mínimo.
fn sysinfo_alias_line(kind: ShellKind, banner_path: Option<&str>, transport: Transport) -> String {
    // Sin archivo de banner (temporal no escribible) se cae al comando nativo
    // del sistema, que es lo que había antes de tener banner propio.
    if kind == ShellKind::Cmd {
        return match banner_path {
            Some(banner) => format!("doskey sysinfo=type \"{banner}\""),
            None => "doskey sysinfo=systeminfo".to_string(),
        };
    }
    if kind == ShellKind::Powershell {
        return match banner_path {
            Some(banner) => format!(
                "function sysinfo {{ Write-Host (Get-Content -Raw '{banner}') -NoNewline }}"
            ),
            None => "function sysinfo { Get-ComputerInfo | Select-Object OsName, OsVersion, \
                     CsProcessors, CsTotalPhysicalMemory, OsUptime }"
                .to_string(),
        };
    }

    let fallback = match banner_path {
        Some(banner) => format!("cat '{}'", unix_path_for(banner, transport)),
        None => "uname -a".to_string(),
    };
    if kind == ShellKind::Fish {
        return format!("function sysinfo; {fallback}; end");
    }
    format!("sysinfo() {{ {fallback}; }}")
}

// ---- Texto de "ayuda" ----
// Va a un archivo, igual que el banner, en vez de dentro del propio alias: así
// puede ocupar varias líneas, llevar color y traducirse sin pelearse con el
// entrecomillado de cinco familias de shell distintas.
//
// Lo importante que explica: que el vocabulario es el MISMO en todas las
// shells. `install` instala aquí llame el sistema a su gestor winget, apt o
// pacman, y quien abre la terminal no tiene que saber cuál le toca.

const HELP_TITLE_COLOR: &str = "\x1b[1;36m";
const HELP_SECTION_COLOR: &str = "\x1b[1;33m";
const HELP_CMD_COLOR: &str = "\x1b[38;5;250m";
const HELP_RESET: &str = "\x1b[0m";

fn help_row(command: &str, description: &str) -> String {
    let width = command.chars().count();
    let padded = if width >= 22 {
        format!("{command} ")
    } else {
        format!("{command}{}", " ".repeat(22 - width))
    };
    format!("    {HELP_CMD_COLOR}{padded}{HELP_RESET}{description}")
}

pub struct HelpOptions<'a> {
    pub app_name: &'a str,
    pub env_label: &'a str,
    /// Solo se conoce en Windows: en Unix el gestor lo resuelve la propia shell
    /// al invocar el alias, así que ahí se dice eso mismo en vez de inventar un
    /// nombre.
    pub manager_label: Option<&'a str>,
    pub has_nsudo: bool,
    pub script_names: &'a [String],
}

/// Secciones de la ayuda que se pueden pedir desde ayuda <seccion>,
/// help <seccion> o :help <seccion>. Los nombres cortos son deliberados:
/// deben poder escribirse igual desde cualquier shell y no dependen del
/// idioma visible de la interfaz.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelpTopic {
    General,
    Packages,
    Session,
    Internal,
    Aliases,
    Library,
    Menus,
    Plugins,
    Support,
    Credits,
}

impl HelpTopic {
    pub const SECTIONS: [Self; 9] = [
        Self::Packages,
        Self::Session,
        Self::Internal,
        Self::Aliases,
        Self::Library,
        Self::Menus,
        Self::Plugins,
        Self::Support,
        Self::Credits,
    ];

    pub const fn file_key(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Packages => "paquetes",
            Self::Session => "sesion",
            Self::Internal => "internos",
            Self::Aliases => "alias",
            Self::Library => "biblioteca",
            Self::Menus => "menus",
            Self::Plugins => "plugins",
            Self::Support => "soporte",
            Self::Credits => "creditos",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Packages => "paquetes",
            Self::Session => "sesion",
            Self::Internal => "comandos internos",
            Self::Aliases => "alias",
            Self::Library => "biblioteca",
            Self::Menus => "menus",
            Self::Plugins => "plugins",
            Self::Support => "soporte",
            Self::Credits => "creditos",
        }
    }

    /// Acepta español e inglés, con y sin tilde, pero no interpreta palabras
    /// arbitrarias. Así un error se puede explicar al usuario en vez de
    /// imprimir una sección que no pidió.
    pub fn from_argument(argument: Option<&str>) -> Option<Self> {
        let value = argument.unwrap_or("").trim().to_ascii_lowercase();
        match value.as_str() {
            "" | "general" | "inicio" | "todo" | "all" | "help" | "ayuda" => Some(Self::General),
            "paquete" | "paquetes" | "package" | "packages" | "pkg" => Some(Self::Packages),
            "sesion" | "session" | "terminal" => Some(Self::Session),
            "interno" | "internos" | "internal" | "internals" | "comando" | "comandos"
            | "commands" => Some(Self::Internal),
            "alias" | "aliases" => Some(Self::Aliases),
            "biblioteca" | "library" | "scripts" => Some(Self::Library),
            "menu" | "menus" | "panel" | "paneles" | "panels" | "interfaz" | "ui" => {
                Some(Self::Menus)
            }
            "plugin" | "plugins" | "complementos" => Some(Self::Plugins),
            "soporte" | "support" | "plataformas" | "platforms" | "shell" | "shells" => {
                Some(Self::Support)
            }
            "credito" | "creditos" | "credits" | "autor" | "autores" => Some(Self::Credits),
            _ => None,
        }
    }
}

pub fn help_topic_path(help_path: &str, topic: HelpTopic) -> String {
    let base = help_path.strip_suffix(".txt").unwrap_or(help_path);
    format!("{base}-{}.txt", topic.file_key())
}

fn sibling_path(help_path: &str, extension: &str) -> String {
    let base = help_path.strip_suffix(".txt").unwrap_or(help_path);
    format!("{base}.{extension}")
}

pub fn build_cmd_help_dispatcher(help_path: &str) -> String {
    let mut lines = vec![
        "@echo off".to_string(),
        "set \"topic=%~1\"".to_string(),
        format!("if \"%topic%\"==\"\" type \"{help_path}\" & exit /b 0"),
    ];
    for name in help_topic_names(HelpTopic::General) {
        lines.push(format!(
            "if /I \"%topic%\"==\"{name}\" type \"{help_path}\" & exit /b 0"
        ));
    }
    for topic in HelpTopic::SECTIONS {
        let path = help_topic_path(help_path, topic);
        for name in help_topic_names(topic) {
            lines.push(format!(
                "if /I \"%topic%\"==\"{name}\" type \"{path}\" & exit /b 0"
            ));
        }
    }
    lines.push("echo Seccion desconocida: %topic%. Usa ayuda para ver las secciones.".to_string());
    lines.push("exit /b 2".to_string());
    lines.join("\r\n") + "\r\n"
}

pub fn help_runner_path(help_path: &str, kind: ShellKind) -> String {
    let extension = match kind {
        ShellKind::Cmd => "cmd",
        ShellKind::Powershell => "ps1",
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh | ShellKind::Fish => "sh",
        ShellKind::Android | ShellKind::Repl => "txt",
    };
    sibling_path(help_path, extension)
}

pub fn build_help_runner(kind: ShellKind, help_path: &str, transport: Transport) -> String {
    match kind {
        ShellKind::Cmd => build_cmd_help_dispatcher(help_path),
        ShellKind::Powershell => {
            let mut lines = vec![
                "param([string]$Topic)".to_string(),
                "$path = $null".to_string(),
                "if ([string]::IsNullOrWhiteSpace($Topic)) {".to_string(),
                format!("    $path = '{}'", help_path.replace('\'', "''")),
                "} else {".to_string(),
                "    $path = switch ($Topic.ToLowerInvariant()) {".to_string(),
            ];
            for name in help_topic_names(HelpTopic::General) {
                lines.push(format!(
                    "        '{name}' {{ '{}'; break }}",
                    help_path.replace('\'', "''")
                ));
            }
            for topic in HelpTopic::SECTIONS {
                let path = help_topic_path(help_path, topic).replace('\'', "''");
                for name in help_topic_names(topic) {
                    lines.push(format!("        '{name}' {{ '{path}'; break }}"));
                }
            }
            lines.extend([
                "        default { $null }".to_string(),
                "    }".to_string(),
                "}".to_string(),
                "if ($null -eq $path) {".to_string(),
                "    Write-Host ('Seccion desconocida: ' + $Topic + '. Usa ayuda para ver las secciones.') -ForegroundColor Yellow".to_string(),
                "    exit 2".to_string(),
                "}".to_string(),
                "Write-Host (Get-Content -Raw -LiteralPath $path) -NoNewline".to_string(),
            ]);
            lines.join("\r\n") + "\r\n"
        }
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh | ShellKind::Fish => {
            let shell_help_path = unix_path_for(help_path, transport);
            let mut lines = vec![
                "#!/bin/sh".to_string(),
                "topic=\"$1\"".to_string(),
                "case \"$topic\" in".to_string(),
                format!(
                    "\"\"|{}) cat \"{}\" ;;",
                    help_topic_names(HelpTopic::General).join("|"),
                    shell_help_path
                ),
            ];
            for topic in HelpTopic::SECTIONS {
                lines.push(format!(
                    "{} ) cat \"{}\" ;;",
                    help_topic_names(topic).join("|"),
                    unix_path_for(&help_topic_path(help_path, topic), transport)
                ));
            }
            lines.extend([
                "*) printf 'Seccion desconocida: %s. Usa ayuda para ver las secciones.\\n' \"$topic\"; exit 2 ;;".to_string(),
                "esac".to_string(),
            ]);
            lines.join("\n") + "\n"
        }
        ShellKind::Android | ShellKind::Repl => String::new(),
    }
}

fn help_topic_names(topic: HelpTopic) -> &'static [&'static str] {
    match topic {
        HelpTopic::Packages => &["paquete", "paquetes", "package", "packages", "pkg"],
        HelpTopic::Session => &["sesion", "session", "terminal"],
        HelpTopic::Internal => &[
            "interno",
            "internos",
            "internal",
            "internals",
            "comando",
            "comandos",
            "commands",
        ],
        HelpTopic::Aliases => &["alias", "aliases"],
        HelpTopic::Library => &["biblioteca", "library", "scripts"],
        HelpTopic::Menus => &[
            "menu", "menus", "panel", "paneles", "panels", "interfaz", "ui",
        ],
        HelpTopic::Plugins => &["plugin", "plugins", "complementos"],
        HelpTopic::Support => &[
            "soporte",
            "support",
            "plataformas",
            "platforms",
            "shell",
            "shells",
        ],
        HelpTopic::Credits => &["credito", "creditos", "credits", "autor", "autores"],
        HelpTopic::General => &["general", "inicio", "todo", "all", "help", "ayuda"],
    }
}

pub fn build_help_text(t: &Translator, options: &HelpOptions<'_>) -> String {
    build_help_topic_text(t, options, HelpTopic::General)
}

pub fn build_help_topic_text(
    t: &Translator,
    options: &HelpOptions<'_>,
    topic: HelpTopic,
) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push(String::new());
    lines.push(format!(
        "{HELP_TITLE_COLOR}{}{HELP_RESET} · {}",
        options.app_name,
        t.tp(
            "help.title",
            &[("shell", options.env_label.to_string())],
            "comandos añadidos a esta sesión ({shell})"
        )
    ));
    if topic != HelpTopic::General {
        lines.push(format!(
            "{HELP_SECTION_COLOR}Sección: {}{HELP_RESET}",
            topic.label()
        ));
    }
    lines.push(String::new());

    if topic == HelpTopic::General || topic == HelpTopic::Packages {
        render_packages(&mut lines, t, options);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Session {
        render_session(&mut lines, t, options);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Internal {
        render_internal(&mut lines);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Aliases {
        render_aliases(&mut lines, options);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Library {
        render_library(&mut lines, options);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Menus {
        render_menus(&mut lines);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Plugins {
        render_plugins(&mut lines);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Support {
        render_support(&mut lines, options);
    }
    if topic == HelpTopic::General || topic == HelpTopic::Credits {
        render_credits(&mut lines);
    }

    lines.push(format!("{HELP_SECTION_COLOR}Uso de esta ayuda{HELP_RESET}"));
    lines.push("    ayuda                         ayuda completa".to_string());
    lines.push("    ayuda <seccion>              solo esa sección".to_string());
    lines.push("    secciones: paquetes, sesion, internos, alias, biblioteca, menus, plugins, soporte, creditos".to_string());

    lines.join("\r\n") + "\r\n"
}

fn section(lines: &mut Vec<String>, title: &str) {
    lines.push(format!("{HELP_SECTION_COLOR}{title}{HELP_RESET}"));
}

fn render_packages(lines: &mut Vec<String>, t: &Translator, options: &HelpOptions<'_>) {
    let packages_note = match options.manager_label {
        Some(manager) => t.tp(
            "help.packagesManager",
            &[("manager", manager.to_string())],
            "mismo vocabulario en todas las shells; aquí lo atiende {manager}",
        ),
        None => t.t(
            "help.packagesAuto",
            "mismo vocabulario en todas las shells; el gestor se elige al ejecutarlo",
        ),
    };
    lines.push(format!(
        "{HELP_SECTION_COLOR}{}{HELP_RESET} — {packages_note}",
        t.t("help.packages", "Paquetes")
    ));
    lines.push(help_row(
        "install <paquete>",
        &t.t("help.install", "Instala uno o varios paquetes."),
    ));
    lines.push(help_row(
        "update [paquete]",
        &t.t(
            "help.update",
            "Actualiza uno; sin argumentos actualiza todo.",
        ),
    ));
    lines.push(help_row(
        "upgrade",
        &t.t("help.upgrade", "Actualiza todo el sistema."),
    ));
    lines.push(help_row(
        "uninstall <paquete>",
        &t.t(
            "help.uninstall",
            "Desinstala. remove es un alias equivalente.",
        ),
    ));
    lines.push(help_row(
        "search <texto>",
        &t.t("help.search", "Busca paquetes sin pedir privilegios."),
    ));
    lines.push(format!(
        "    Gestor detectado: {}",
        options.manager_label.unwrap_or("automático en la shell")
    ));
    lines.push(
        "    Los comandos muestran la operación real y respetan la cancelación con Ctrl+C."
            .to_string(),
    );
    lines.push(
        "    En WSL, contenedores y PowerShell Unix se usa el gestor del entorno, no el del host."
            .to_string(),
    );
    lines.push(String::new());
}

fn render_session(lines: &mut Vec<String>, t: &Translator, options: &HelpOptions<'_>) {
    section(lines, &t.t("help.session", "Sesión"));
    lines.push(help_row(
        "clear / cls",
        &t.t(
            "help.clear",
            "Limpia pantalla, historial y repinta el banner.",
        ),
    ));
    lines.push(help_row(
        "sysinfo",
        &t.t(
            "help.sysinfo",
            "Vuelve a imprimir la información del sistema.",
        ),
    ));
    lines.push(help_row(
        "ayuda [sección]",
        &t.t("help.help", "Ayuda completa o solo una sección."),
    ));
    lines.push(help_row(
        "help [sección]",
        "Alias compatible de ayuda; acepta los mismos argumentos.",
    ));
    if options.has_nsudo {
        lines.push(help_row(
            "nsudo <comando>",
            &t.t(
                "help.nsudo",
                "Ejecuta como TrustedInstaller, con todos los privilegios.",
            ),
        ));
    }
    lines.push(
        "    Los nombres se traducen a la sintaxis de la shell actual; el vocabulario es común."
            .to_string(),
    );
    lines.push(String::new());
}

fn render_internal(lines: &mut Vec<String>) {
    section(lines, "Comandos internos de LTerminal");
    lines.push("    Se reconocen únicamente al empezar la línea con : y no se envían al proceso de la shell.".to_string());
    lines.push(help_row(
        ":help [sección]",
        "Muestra la ayuda completa o una sección concreta.",
    ));
    lines.push(help_row(":config", "Abre Ajustes de la aplicación."));
    lines.push(help_row(
        ":reload",
        "Actualiza el inventario de entornos, shells y herramientas.",
    ));
    lines.push(help_row(
        ":repl <nombre>",
        "Abre una pestaña con el REPL detectado indicado.",
    ));
    lines.push(help_row(
        ":alias",
        "Muestra la sección de alias y su vocabulario estable.",
    ));
    lines.push(
        "    Si una orden no aparece aquí, se deja intacta para que la interprete la shell."
            .to_string(),
    );
    lines.push(String::new());
}

fn render_aliases(lines: &mut Vec<String>, options: &HelpOptions<'_>) {
    section(lines, "Alias y comandos compartidos");
    lines.push("    Estos nombres se conservan entre Linux, Windows, Git Bash, WSL, PowerShell y Fish; cambia solo el comando real.".to_string());
    lines.push(help_row(
        &CANONICAL_ALIAS_NAMES.join(", "),
        "vocabulario canónico disponible en esta shell",
    ));
    lines.push(help_row(
        "edit",
        "Abre el editor configurado o nano como alternativa.",
    ));
    lines.push(help_row(
        "ip",
        "Muestra la configuración de red del entorno.",
    ));
    lines.push(help_row(
        "ll / ls",
        "Lista archivos; ll incluye ocultos y detalles.",
    ));
    lines.push(help_row("pwd", "Muestra la carpeta de trabajo actual."));
    lines.push(help_row(
        "install ...",
        "Alias de paquetes; usa help paquetes.",
    ));
    lines.push(help_row(
        "scripts de Biblioteca",
        "Cada script ejecutable puede aparecer como alias, sin argumentos o con sus argumentos.",
    ));
    lines.push(format!(
        "    Alias de scripts detectados en esta sesión: {}",
        options.script_names.len()
    ));
    if !options.script_names.is_empty() {
        lines.push(format!("    {}", options.script_names.join(", ")));
    }
    lines.push(
        "    clear, cls, sysinfo, ayuda y help son comandos reservados de la aplicación."
            .to_string(),
    );
    lines.push(String::new());
}

fn render_library(lines: &mut Vec<String>, options: &HelpOptions<'_>) {
    section(lines, "Biblioteca");
    lines.push("    Escanea scripts y archivos según los filtros activos, profundidad y carpeta seleccionada.".to_string());
    lines.push("    Favoritos conserva accesos; Ruta actual muestra el contenido del directorio de la pestaña.".to_string());
    lines.push("    Un script se puede ejecutar sin argumentos para abrir su propio menú, o con parámetros extra.".to_string());
    lines.push("    Las acciones rápidas incluyen SSH, red, servicios, Docker, Kubernetes y ADB cuando la herramienta existe.".to_string());
    lines.push(format!(
        "    Esta pestaña tiene {} alias de scripts registrados.",
        options.script_names.len()
    ));
    lines.push(String::new());
}

fn render_menus(lines: &mut Vec<String>) {
    section(lines, "Menús y funciones de la aplicación");
    lines.push(
        "    Proyectos: repositorios locales, GitHub y herramientas del proyecto.".to_string(),
    );
    lines.push("    Biblioteca: filtros de archivos, favoritos, ejecución de scripts y operaciones rápidas.".to_string());
    lines.push("    Entorno y dependencias: shells, intérpretes, lenguajes, frameworks, paquetes, editores y visores.".to_string());
    lines.push("    Ajustes: apariencia, terminal, comportamiento, exportación/importación, plugins e integración del sistema.".to_string());
    lines.push(
        "    Logs: registros con tiempos de arranque, procesos, llamadas, operaciones y errores."
            .to_string(),
    );
    lines.push("    Las secciones respetan la preferencia de apertura y el modo de un menú abierto a la vez.".to_string());
    lines.push(String::new());
}

fn render_plugins(lines: &mut Vec<String>) {
    section(lines, "Plugins");
    lines.push("    Se instalan desde Ajustes -> Plugins -> Instalar plugin.json.".to_string());
    lines.push("    Son declarativos: añaden REPLs y tecnologías detectables, no cargan DLL, JavaScript nativo, Rust ni comandos arbitrarios.".to_string());
    lines.push("    El manifest usa schemaVersion, id, name, version, description y technologies con windowsExe/unixExe.".to_string());
    lines.push("    Se pueden activar, desactivar y retirar; los retirados quedan respaldados y los manifests inválidos se conservan para corregirlos.".to_string());
    lines.push("    La documentación y la plantilla están en docs/plugins.md y examples/plugins/custom-repl/plugin.json.".to_string());
    lines.push(String::new());
}

fn render_support(lines: &mut Vec<String>, options: &HelpOptions<'_>) {
    section(lines, "Soporte y límites");
    lines.push(
        "    Plataformas principales: Linux/LTerminal y Windows/WinSlim Terminal.".to_string(),
    );
    lines.push("    Shells: Bash, Zsh, Fish, PowerShell y CMD; además WSL, Git Bash, contenedores, Android y REPLs detectados.".to_string());
    lines.push("    Gestores: pacman, apt, dnf, zypper, apk, Homebrew, winget, Chocolatey y Scoop según disponibilidad.".to_string());
    lines.push("    Los intérpretes, frameworks y herramientas solo aparecen como instalables si su plataforma y gestor los soportan.".to_string());
    lines.push(format!("    Entorno activo: {}.", options.env_label));
    lines.push(String::new());
}

fn render_credits(lines: &mut Vec<String>) {
    section(lines, "Créditos");
    lines.push("    Desarrollador principal: Darkeiser003".to_string());
    lines.push(
        "    Colaborador: Christianlg97 (colaborador y desarrollador de WinSlim)".to_string(),
    );
    lines.push(
        "    Linux se presenta como LTerminal; Windows se presenta como WinSlim Terminal."
            .to_string(),
    );
    lines.push(String::new());
}

/// Alias "ayuda": imprime el archivo anterior. Sin archivo (temporal no
/// escribible) se cae a una línea suelta, que es mejor que nada.
fn help_alias_line(
    kind: ShellKind,
    help_path: Option<&str>,
    has_nsudo: bool,
    script_names: &[String],
    transport: Transport,
) -> String {
    let Some(help_path) = help_path else {
        let fixed = format!(
            "edit, ip, ll, ls, pwd, clear, sysinfo, ayuda, {}{}",
            PACKAGE_ALIAS_NAMES.join(", "),
            if has_nsudo { ", nsudo" } else { "" }
        );
        let scripts = if script_names.is_empty() {
            "(ninguno detectado)".to_string()
        } else {
            script_names.join(", ")
        };
        let message = format!("Alias fijos: {fixed} -- Scripts detectados: {scripts}");
        return match kind {
            ShellKind::Cmd => format!("doskey ayuda=echo {message}"),
            ShellKind::Powershell => format!(
                "function ayuda {{ Write-Host {} -ForegroundColor Cyan }}",
                quote_windows_double(&message)
            ),
            ShellKind::Fish => format!(
                "function ayuda; echo '{}'; end",
                escape_single_quotes(&message, kind)
            ),
            _ => format!(
                "ayuda() {{ echo '{}'; }}",
                escape_single_quotes(&message, kind)
            ),
        };
    };

    let runner = help_runner_path(help_path, kind);
    let runner_for_shell = match kind {
        ShellKind::Cmd | ShellKind::Powershell => runner.clone(),
        _ => unix_path_for(&runner, transport),
    };

    match kind {
        ShellKind::Cmd => format!("doskey ayuda=call \"{runner_for_shell}\" $*"),
        ShellKind::Powershell => format!(
            "function ayuda {{ & '{}' @args }}",
            runner_for_shell.replace('\'', "''")
        ),
        ShellKind::Fish => format!("function ayuda; sh '{}' $argv; end", runner_for_shell),
        _ => format!("ayuda() {{ sh '{}' \"$@\"; }}", runner_for_shell),
    }
}

/// `help` es un alias de compatibilidad. La ayuda canónica se llama `ayuda`,
/// pero reservar ambos nombres sin implementar el segundo hacía que el usuario
/// recibiera «comando no encontrado» después de verlo en :help.
fn help_compat_line(kind: ShellKind, help_path: Option<&str>) -> String {
    match kind {
        ShellKind::Cmd => help_path
            .map(|path| format!("doskey help=call \"{}\" $*", help_runner_path(path, kind)))
            .unwrap_or_else(|| "doskey help=ayuda $*".to_string()),
        ShellKind::Powershell => {
            // `help` es un alias integrado de Get-Help. Set-Alias -Force es
            // necesario para que el nombre canónico de LTerminal gane en
            // todas las versiones de Windows PowerShell y PowerShell Core.
            "function Show-LTerminalHelp { ayuda @args }; Set-Alias -Name help -Value Show-LTerminalHelp -Option AllScope -Force -Scope Global".to_string()
        }
        ShellKind::Fish => "function help; ayuda $argv; end".to_string(),
        _ => "help() { ayuda \"$@\"; }".to_string(),
    }
}

/// Un alias por script detectado. El comando de lanzamiento ya viene construido
/// por el lanzador de scripts, que es quien sabe cómo se ejecuta cada
/// extensión.
pub struct ScriptAlias {
    pub alias_name: String,
    /// El comando tal y como lo escribiría el usuario, sin argumentos.
    pub launch_command: String,
}

fn script_alias_line(kind: ShellKind, alias: &ScriptAlias) -> String {
    let name = &alias.alias_name;
    let command = &alias.launch_command;
    match kind {
        ShellKind::Cmd => format!("doskey {name}={command} $*"),
        ShellKind::Powershell => format!("function {name} {{ {command} @args }}"),
        // Una función Fish conserva argumentos (`$argv`) también para comandos
        // compuestos. `alias` genera internamente una función, pero su escape
        // cambia entre versiones y distribuciones; escribirla explícita es
        // estable en Fish 3/4 y Arch/CachyOS.
        ShellKind::Fish => format!(
            "function {name}; eval '{} $argv'; end",
            escape_single_quotes(command, kind)
        ),
        _ => format!("alias {name}='{}'", escape_single_quotes(command, kind)),
    }
}

/// Nombres reservados: un script del usuario nunca puede pisarlos (perdería
/// acceso a funcionalidad básica de la terminal sin saber por qué).
fn is_reserved(name: &str) -> bool {
    const FIXED: [&str; 6] = ["nsudo", "sysinfo", "ayuda", "help", "clear", "cls"];
    FIXED.contains(&name)
        || PACKAGE_ALIAS_NAMES.contains(&name)
        || WINDOWS_ALIASES.iter().any(|(alias, _)| *alias == name)
}

/// ¿Puede esta sesión leer los archivos temporales que genera la app?
///
/// Los contenedores no ven el sistema de archivos del host (y pueden caer a sh
/// aunque se prefiera bash), la shell de un móvil por ADB tampoco, y el cmd.exe
/// de Wine solo ve el prefijo como `Z:\...`, no la ruta POSIX del temporal. En
/// esos tres transportes no se escribe inicialización ninguna: ni alias, ni
/// `sysinfo`, ni banner impreso por la shell.
///
/// Importa fuera de este módulo porque decide QUIÉN pinta el banner: la shell
/// (leyendo el archivo) o la propia aplicación (escribiéndolo en el xterm).
pub fn transport_loads_host_files(transport: Transport) -> bool {
    transport.loads_host_files()
}

pub struct InitOptions<'a> {
    pub nsudo_path: Option<&'a str>,
    pub script_aliases: &'a [ScriptAlias],
    pub banner_path: Option<&'a str>,
    pub banner_clear_path: Option<&'a str>,
    pub help_path: Option<&'a str>,
    pub transport: Transport,
    pub app_name: &'a str,
    pub env_label: &'a str,
    pub manager_label: Option<&'a str>,
    pub platform: &'a str,
    pub windows_manager: Option<&'a str>,
}

pub struct InitScript {
    pub ext: &'static str,
    pub content: String,
    /// El texto de la ayuda se devuelve junto al script: quien llama ya sabe en
    /// qué ruta lo va a escribir (se la pasó como `help_path`), pero solo aquí
    /// se sabe qué scripts han llegado a registrarse de verdad.
    pub help_text: Option<String>,
    pub help_topics: Option<Vec<(String, String)>>,
    pub help_runner: Option<String>,
}

/// Deja el carácter ESC en una variable de la sesión, para que las cabeceras
/// que escribe la app puedan llevar color en cmd.
///
/// `echo` de cmd no interpreta secuencias de escape, y un ESC literal en la
/// línea no vale: el editor de línea de la consola lo trata como "borrar la
/// línea" y se comería el comando. `prompt $E` sí lo produce, y `for /f` lo
/// captura. Se hace una vez por pestaña, aquí, porque en una línea encadenada
/// con `&` la variable se expandiría antes de haberse asignado.
///
/// El script se ejecuta con `call`, así que la variable sobrevive al archivo.
fn escape_capture_line() -> String {
    format!(
        "for /f %%E in ('echo prompt $E^| cmd') do set \"{}=%%E\"",
        crate::console_ui::CMD_ESC_VAR
    )
}

/// El archivo de inicialización de una pestaña, o `None` si la shell no es de
/// ninguna familia conocida.
pub fn build_init_script(
    kind: ShellKind,
    t: &Translator,
    options: &InitOptions<'_>,
) -> Option<InitScript> {
    let format = script_format(kind)?;
    let banner_clear_path = options.banner_clear_path.or(options.banner_path);
    let mut lines: Vec<String> = format.header.iter().map(|line| line.to_string()).collect();

    match kind {
        ShellKind::Cmd => {
            lines.push(escape_capture_line());
            for (name, value) in WINDOWS_ALIASES {
                lines.push(format!("doskey {name}={value} $*"));
            }
        }
        ShellKind::Powershell => {
            for (name, value) in powershell_aliases(options.platform) {
                let body = if value.contains("@args") {
                    value
                } else {
                    format!("{value} @args")
                };
                lines.push(format!("function {name} {{ {body} }}"));
            }
        }
        ShellKind::Fish => {
            for (name, value) in unix_aliases(kind) {
                lines.push(format!("alias {name} '{value}'"));
            }
        }
        _ => {
            for (name, value) in unix_aliases(kind) {
                lines.push(format!("alias {name}='{value}'"));
            }
        }
    }

    lines.extend(clear_alias_lines(
        kind,
        banner_clear_path,
        options.transport,
        options.app_name,
    ));

    // install / update / upgrade / uninstall / remove sobre el gestor de
    // paquetes real de este entorno.
    lines.extend(package_aliases::build_package_alias_lines(
        kind,
        options.platform,
        options.windows_manager,
        options.transport,
    ));

    if let Some(line) = nsudo_alias_line(kind, options.nsudo_path, options.transport) {
        lines.push(line);
    }

    lines.push(sysinfo_alias_line(
        kind,
        options.banner_path,
        options.transport,
    ));

    let mut registered: Vec<String> = Vec::new();
    for alias in options.script_aliases {
        if is_reserved(&alias.alias_name) || alias.launch_command.is_empty() {
            continue;
        }
        lines.push(script_alias_line(kind, alias));
        registered.push(alias.alias_name.clone());
    }

    lines.push(help_alias_line(
        kind,
        options.help_path,
        options.nsudo_path.is_some(),
        &registered,
        options.transport,
    ));
    lines.push(help_compat_line(kind, options.help_path));

    // Pantalla limpia + banner: lo último que hace el archivo, y la señal para
    // la app de que la pestaña ya puede mostrarse.
    lines.push(clear_command(
        kind,
        banner_clear_path,
        false,
        options.transport,
        options.app_name,
    ));

    let help_options = HelpOptions {
        app_name: options.app_name,
        env_label: options.env_label,
        manager_label: options.manager_label,
        has_nsudo: options.nsudo_path.is_some(),
        script_names: &registered,
    };
    Some(InitScript {
        ext: format.ext,
        content: lines.join(format.eol) + format.eol,
        help_text: options
            .help_path
            .map(|_| build_help_topic_text(t, &help_options, HelpTopic::General)),
        help_topics: options.help_path.map(|_| {
            HelpTopic::SECTIONS
                .into_iter()
                .map(|topic| {
                    (
                        topic.file_key().to_string(),
                        build_help_topic_text(t, &help_options, topic),
                    )
                })
                .collect()
        }),
        help_runner: options
            .help_path
            .map(|path| build_help_runner(kind, path, options.transport)),
    })
}

/// La única línea que se teclea de verdad en la shell: cargar el archivo
/// anterior en la sesión actual (no en un proceso hijo, o los alias no
/// existirían al volver).
pub fn build_init_invocation(
    kind: ShellKind,
    init_path: &str,
    transport: Transport,
) -> Option<String> {
    script_format(kind)?;
    match kind {
        ShellKind::Cmd => Some(format!("call \"{init_path}\"")),
        ShellKind::Powershell => Some(format!(". \"{init_path}\"")),
        // fish eliminó "." en la versión 3.0: allí el comando es "source". En
        // bash/zsh/sh/WSL se usa "." porque es POSIX y existe en todas (a
        // diferencia de "source", que no está en algunas sh).
        ShellKind::Fish => Some(format!("source '{}'", unix_path_for(init_path, transport))),
        _ => Some(format!(". '{}'", unix_path_for(init_path, transport))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options<'a>(transport: Transport) -> InitOptions<'a> {
        InitOptions {
            nsudo_path: None,
            script_aliases: &[],
            banner_path: None,
            banner_clear_path: None,
            help_path: None,
            transport,
            app_name: "WinSlim Terminal",
            env_label: "cmd.exe",
            manager_label: None,
            platform: "windows",
            windows_manager: Some("winget"),
        }
    }

    fn build(kind: ShellKind, options: &InitOptions<'_>) -> InitScript {
        build_init_script(kind, &Translator::default(), options).expect("familia conocida")
    }

    // ---- clear ----

    #[test]
    fn el_marcador_va_antes_del_borrado_nativo() {
        let body = clear_command(ShellKind::Cmd, None, false, Transport::Native, "App");
        let marcador = body.find(CLEAR_MARKER).unwrap();
        let cls = body.find("cls").unwrap();
        assert!(
            marcador < cls,
            "el marcador tiene que llegar primero: {body}"
        );
    }

    #[test]
    fn el_titulo_vuelve_a_su_valor_limpio_tras_borrar() {
        let body = clear_command(ShellKind::Cmd, None, false, Transport::Native, "App");
        assert!(body.ends_with("title App"));
    }

    #[test]
    fn dentro_de_una_macro_doskey_el_porcentaje_se_duplica() {
        let dentro = clear_command(ShellKind::Cmd, None, true, Transport::Native, "App");
        let fuera = clear_command(ShellKind::Cmd, None, false, Transport::Native, "App");
        assert!(dentro.contains("%%RANDOM%%"));
        assert!(fuera.contains("%RANDOM%") && !fuera.contains("%%RANDOM%%"));
        // Y el separador cambia: dentro de la macro, & terminaría la macro.
        assert!(dentro.contains("$T"));
        assert!(fuera.contains('&'));
    }

    #[test]
    fn cada_limpieza_lleva_un_sufijo_distinto() {
        for (kind, marca) in [
            (ShellKind::Cmd, "%RANDOM%"),
            (ShellKind::Powershell, "(Get-Random)"),
            (ShellKind::Bash, "${RANDOM:-$$}"),
            (ShellKind::Fish, "(random)"),
        ] {
            let body = clear_command(kind, None, false, Transport::Native, "App");
            assert!(
                body.contains(marca),
                "{kind:?} sin sufijo aleatorio: {body}"
            );
        }
    }

    #[test]
    fn la_comilla_del_nombre_de_la_app_no_rompe_powershell() {
        let body = clear_command(
            ShellKind::Powershell,
            None,
            false,
            Transport::Native,
            "L'App",
        );
        assert!(body.contains("L''App"));
    }

    #[test]
    fn el_banner_de_unix_usa_la_ruta_traducida() {
        let body = clear_command(
            ShellKind::Bash,
            Some("C:\\temp\\banner.txt"),
            false,
            Transport::Wsl,
            "App",
        );
        assert!(body.contains("cat '/mnt/c/temp/banner.txt'"));
    }

    #[test]
    fn el_banner_de_windows_usa_la_ruta_tal_cual() {
        let body = clear_command(
            ShellKind::Cmd,
            Some("C:\\temp\\banner.txt"),
            false,
            Transport::Native,
            "App",
        );
        assert!(body.contains("type \"C:\\temp\\banner.txt\""));
    }

    // ---- Alias ----

    #[test]
    fn powershell_fuerza_los_alias_integrados_de_clear() {
        let script = build(ShellKind::Powershell, &options(Transport::Native));
        assert!(script
            .content
            .contains("-Option AllScope -Force -Scope Global"));
    }

    #[test]
    fn cls_existe_tambien_en_las_shells_unix() {
        let bash = build(ShellKind::Bash, &options(Transport::Native));
        assert!(bash.content.contains("cls() { clear; }"));
        let fish = build(ShellKind::Fish, &options(Transport::Native));
        assert!(fish.content.contains("function cls; clear; end"));
    }

    #[test]
    fn todas_las_shells_reciben_el_mismo_vocabulario_canonico() {
        let cmd = build(ShellKind::Cmd, &options(Transport::Native));
        assert!(cmd.content.contains("doskey ls=dir $*"));
        assert!(cmd.content.contains("doskey pwd=cd $*"));

        let bash = build(ShellKind::Bash, &options(Transport::Native));
        assert!(bash.content.contains("alias ls='command ls'"));
        assert!(bash.content.contains("alias pwd='command pwd'"));
        assert!(bash.content.contains("alias ll='ls -alh'"));

        for name in CANONICAL_ALIAS_NAMES {
            assert!(cmd.content.contains(name), "falta {name} en cmd");
            assert!(bash.content.contains(name), "falta {name} en bash");
        }
    }

    #[test]
    fn powershell_core_en_linux_no_recibe_comandos_de_windows() {
        let mut opts = options(Transport::Native);
        opts.platform = "linux";
        let script = build(ShellKind::Powershell, &opts);
        assert!(script
            .content
            .contains("function ls { Get-ChildItem @args }"));
        assert!(script
            .content
            .contains("function pwd { Get-Location @args }"));
        assert!(!script.content.contains("function ls { dir @args }"));
    }

    #[test]
    fn powershell_sobrescribe_help_integrado() {
        let script = build(ShellKind::Powershell, &options(Transport::Native));
        assert!(script.content.contains("Set-Alias -Name help"));
        assert!(script.content.contains("-Option AllScope -Force"));
    }

    #[test]
    fn fish_usa_su_propia_sintaxis_de_alias() {
        let fish = build(ShellKind::Fish, &options(Transport::Native));
        assert!(fish.content.contains("alias edit 'nano'"));
        assert!(fish.content.contains("alias ls 'command ls'"));
        assert!(fish.content.contains("alias pwd 'command pwd'"));
        assert!(fish.content.contains("; or ifconfig"));
    }

    #[test]
    fn nsudo_solo_aparece_si_esta_en_la_maquina() {
        let mut opts = options(Transport::Native);
        assert!(!build(ShellKind::Cmd, &opts).content.contains("nsudo"));

        opts.nsudo_path = Some("C:\\Tools\\NSudoLC.exe");
        let script = build(ShellKind::Cmd, &opts);
        assert!(script
            .content
            .contains("doskey nsudo=\"C:\\Tools\\NSudoLC.exe\" -U:T -P:E $*"));
    }

    #[test]
    fn nsudo_se_llama_por_su_ruta_traducida_en_unix() {
        let mut opts = options(Transport::Wsl);
        opts.nsudo_path = Some("C:\\Tools\\NSudoLC.exe");
        let script = build(ShellKind::Bash, &opts);
        assert!(script
            .content
            .contains("alias nsudo='/mnt/c/Tools/NSudoLC.exe -U:T -P:E'"));
    }

    #[test]
    fn sin_banner_sysinfo_cae_al_comando_del_sistema() {
        assert!(sysinfo_alias_line(ShellKind::Cmd, None, Transport::Native).contains("systeminfo"));
        assert!(sysinfo_alias_line(ShellKind::Bash, None, Transport::Native).contains("uname -a"));
        assert!(
            sysinfo_alias_line(ShellKind::Powershell, None, Transport::Native)
                .contains("Get-ComputerInfo")
        );
    }

    #[test]
    fn sysinfo_no_usa_fastfetch_ni_neofetch() {
        let line = sysinfo_alias_line(ShellKind::Bash, None, Transport::Native);
        assert!(!line.contains("fastfetch"), "{line}");
        assert!(!line.contains("neofetch"), "{line}");
        assert!(line.contains("uname -a"), "{line}");
    }

    // ---- Scripts ----

    #[test]
    fn un_script_del_usuario_no_puede_pisar_un_nombre_reservado() {
        for reservado in ["clear", "install", "ayuda", "nsudo", "ls"] {
            assert!(
                is_reserved(reservado),
                "{reservado} debería estar reservado"
            );
        }
        assert!(!is_reserved("copiar-logs"));
    }

    #[test]
    fn los_alias_de_script_se_escriben_en_la_sintaxis_de_cada_shell() {
        let aliases = [ScriptAlias {
            alias_name: "backup".into(),
            launch_command: "powershell -NoProfile -File \"C:\\s\\backup.ps1\"".into(),
        }];
        let mut opts = options(Transport::Native);
        opts.script_aliases = &aliases;

        assert!(build(ShellKind::Cmd, &opts)
            .content
            .contains("doskey backup=powershell -NoProfile -File \"C:\\s\\backup.ps1\" $*"));
        assert!(build(ShellKind::Powershell, &opts).content.contains(
            "function backup { powershell -NoProfile -File \"C:\\s\\backup.ps1\" @args }"
        ));
        assert!(build(ShellKind::Bash, &opts)
            .content
            .contains("alias backup='"));
    }

    #[test]
    fn un_script_con_nombre_reservado_no_llega_al_archivo() {
        let aliases = [
            ScriptAlias {
                alias_name: "install".into(),
                launch_command: "cosa".into(),
            },
            ScriptAlias {
                alias_name: "propio".into(),
                launch_command: "cosa".into(),
            },
        ];
        let mut opts = options(Transport::Native);
        opts.script_aliases = &aliases;
        let script = build(ShellKind::Cmd, &opts);
        assert!(!script.content.contains("doskey install=cosa"));
        assert!(script.content.contains("doskey propio=cosa $*"));
    }

    // ---- Archivo e invocación ----

    #[test]
    fn cmd_silencia_la_ejecucion_del_archivo() {
        let script = build(ShellKind::Cmd, &options(Transport::Native));
        assert!(script.content.starts_with("@echo off\r\n"));
        assert_eq!(script.ext, "cmd");
    }

    #[test]
    fn cada_familia_tiene_su_extension_y_su_salto_de_linea() {
        assert_eq!(
            build(ShellKind::Powershell, &options(Transport::Native)).ext,
            "ps1"
        );
        assert_eq!(
            build(ShellKind::Bash, &options(Transport::Native)).ext,
            "sh"
        );
        assert_eq!(
            build(ShellKind::Fish, &options(Transport::Native)).ext,
            "fish"
        );

        assert!(build(ShellKind::Cmd, &options(Transport::Native))
            .content
            .contains("\r\n"));
        assert!(!build(ShellKind::Bash, &options(Transport::Native))
            .content
            .contains('\r'));
    }

    #[test]
    fn una_shell_sin_familia_conocida_no_recibe_inicializacion() {
        assert!(build_init_script(
            ShellKind::Android,
            &Translator::default(),
            &options(Transport::Android)
        )
        .is_none());
        assert!(build_init_script(
            ShellKind::Repl,
            &Translator::default(),
            &options(Transport::Native)
        )
        .is_none());
        assert!(build_init_invocation(ShellKind::Android, "/tmp/x", Transport::Android).is_none());
    }

    #[test]
    fn el_archivo_se_carga_en_la_sesion_actual_no_en_un_hijo() {
        assert_eq!(
            build_init_invocation(ShellKind::Cmd, "C:\\t\\init.cmd", Transport::Native),
            Some("call \"C:\\t\\init.cmd\"".to_string())
        );
        assert_eq!(
            build_init_invocation(ShellKind::Powershell, "C:\\t\\init.ps1", Transport::Native),
            Some(". \"C:\\t\\init.ps1\"".to_string())
        );
        assert_eq!(
            build_init_invocation(ShellKind::Bash, "C:\\t\\init.sh", Transport::Wsl),
            Some(". '/mnt/c/t/init.sh'".to_string())
        );
    }

    #[test]
    fn fish_usa_source_porque_ya_no_tiene_punto() {
        let invocation =
            build_init_invocation(ShellKind::Fish, "C:\\t\\init.fish", Transport::Msys).unwrap();
        assert!(invocation.starts_with("source "));
    }

    #[test]
    fn el_archivo_termina_limpiando_la_pantalla() {
        let script = build(ShellKind::Cmd, &options(Transport::Native));
        let ultima = script.content.trim_end().lines().last().unwrap();
        assert!(ultima.contains(CLEAR_MARKER));
    }

    // ---- Ayuda ----

    #[test]
    fn sin_ruta_de_ayuda_no_se_genera_el_texto() {
        let script = build(ShellKind::Cmd, &options(Transport::Native));
        assert!(script.help_text.is_none());
        // Y el alias cae a una línea suelta en vez de leer un archivo.
        assert!(script.content.contains("doskey ayuda=echo Alias fijos:"));
    }

    #[test]
    fn con_ruta_de_ayuda_el_alias_imprime_el_archivo() {
        let mut opts = options(Transport::Native);
        opts.help_path = Some("C:\\t\\help.txt");
        let script = build(ShellKind::Cmd, &opts);
        assert!(script.help_text.is_some());
        assert!(script
            .content
            .contains("doskey ayuda=call \"C:\\t\\help.cmd\" $*"));
        assert!(script
            .help_topics
            .as_ref()
            .is_some_and(|topics| topics.len() == 9));
        assert!(script
            .help_runner
            .as_ref()
            .is_some_and(|runner| runner.contains("paquetes")));
    }

    #[test]
    fn la_ayuda_admite_secciones_y_no_mezcla_su_contenido() {
        let opciones = HelpOptions {
            app_name: "App",
            env_label: "bash",
            manager_label: None,
            has_nsudo: false,
            script_names: &[],
        };
        let paquetes =
            build_help_topic_text(&Translator::default(), &opciones, HelpTopic::Packages);
        assert!(paquetes.contains("install <paquete>"));
        assert!(!paquetes.contains("Desarrollador principal"));
        assert_eq!(
            HelpTopic::from_argument(Some("help")),
            Some(HelpTopic::General)
        );
        assert_eq!(HelpTopic::from_argument(Some("frameworks")), None);
    }

    #[test]
    fn los_runners_de_ayuda_aceptan_argumentos_en_cada_shell() {
        let cmd = build_help_runner(ShellKind::Cmd, "C:\\t\\help.txt", Transport::Native);
        assert!(cmd.contains("%topic%"));
        let powershell =
            build_help_runner(ShellKind::Powershell, "C:\\t\\help.txt", Transport::Native);
        assert!(powershell.contains("param([string]$Topic)"));
        let unix = build_help_runner(ShellKind::Bash, "/tmp/help.txt", Transport::Native);
        assert!(unix.contains("paquete|paquetes"));
    }

    #[test]
    fn la_ayuda_nombra_el_gestor_concreto_cuando_se_conoce() {
        let t = Translator::default();
        let con_gestor = build_help_text(
            &t,
            &HelpOptions {
                app_name: "App",
                env_label: "cmd.exe",
                manager_label: Some("winget"),
                has_nsudo: false,
                script_names: &[],
            },
        );
        assert!(con_gestor.contains("aquí lo atiende winget"));

        let sin_gestor = build_help_text(
            &t,
            &HelpOptions {
                app_name: "App",
                env_label: "bash",
                manager_label: None,
                has_nsudo: false,
                script_names: &[],
            },
        );
        assert!(sin_gestor.contains("el gestor se elige solo al ejecutarlo"));
    }

    #[test]
    fn la_ayuda_cuenta_los_scripts_registrados() {
        let nombres = vec!["uno".to_string(), "dos".to_string()];
        let texto = build_help_text(
            &Translator::default(),
            &HelpOptions {
                app_name: "App",
                env_label: "cmd.exe",
                manager_label: None,
                has_nsudo: false,
                script_names: &nombres,
            },
        );
        assert!(texto.contains("Alias de scripts detectados en esta sesión: 2"));
        assert!(texto.contains("uno, dos"));
    }

    #[test]
    fn la_ayuda_sin_scripts_dice_donde_elegirlos() {
        let texto = build_help_text(
            &Translator::default(),
            &HelpOptions {
                app_name: "App",
                env_label: "cmd.exe",
                manager_label: None,
                has_nsudo: false,
                script_names: &[],
            },
        );
        assert!(texto.contains("Biblioteca"));
    }

    #[test]
    fn nsudo_solo_se_documenta_si_esta_disponible() {
        let con = build_help_text(
            &Translator::default(),
            &HelpOptions {
                app_name: "App",
                env_label: "cmd.exe",
                manager_label: None,
                has_nsudo: true,
                script_names: &[],
            },
        );
        assert!(con.contains("nsudo <comando>"));

        let sin = build_help_text(
            &Translator::default(),
            &HelpOptions {
                app_name: "App",
                env_label: "cmd.exe",
                manager_label: None,
                has_nsudo: false,
                script_names: &[],
            },
        );
        assert!(!sin.contains("nsudo <comando>"));
    }

    #[test]
    fn la_ayuda_lista_el_vocabulario_de_esta_shell() {
        let t = Translator::default();
        let windows = build_help_text(
            &t,
            &HelpOptions {
                app_name: "A",
                env_label: "cmd",
                manager_label: None,
                has_nsudo: false,
                script_names: &[],
            },
        );
        assert!(windows.contains("edit, ip, ll, ls, pwd"));

        let unix = build_help_text(
            &t,
            &HelpOptions {
                app_name: "A",
                env_label: "bash",
                manager_label: None,
                has_nsudo: false,
                script_names: &[],
            },
        );
        assert!(unix.contains("edit, ip, ll, ls, pwd"));
    }

    #[test]
    fn las_columnas_de_la_ayuda_quedan_alineadas() {
        let corta = help_row("ayuda", "Esta ayuda.");
        let larga = help_row("uninstall <paquete>", "Desinstala.");
        // Las dos descripciones empiezan en la misma columna.
        assert_eq!(
            corta.find("Esta ayuda.").unwrap(),
            larga.find("Desinstala.").unwrap()
        );
    }
}
