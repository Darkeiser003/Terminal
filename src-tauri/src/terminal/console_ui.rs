//! Cómo se ve en la terminal lo que la aplicación ejecuta por ti.
//!
//! Módulo nuevo: la versión Electron no tenía equivalente. Allí, pulsar un
//! botón de un panel escribía el comando pelado en la terminal y ya. Entre la
//! salida del comando anterior, el prompt y la salida del nuevo no había nada
//! que dijera qué se estaba ejecutando ni si había ido bien: el usuario tenía
//! que deducirlo de la salida cruda de winget, apt o git.
//!
//! Aquí cada comando que escribe la app va envuelto en una cabecera y un cierre:
//!
//! ```text
//!   ┌─ INSTALAR ────────────────────────────────
//!   │ Node.js LTS
//!   │ winget install --id OpenJS.NodeJS.LTS -e
//!   └────────────────────────────────────────────
//!
//!   …salida real del comando…
//!
//!   ✔ Node.js LTS · instalación completada
//!     Pulsa Enter para volver a la terminal
//! ```
//!
//! Todo se emite con los medios de CADA shell, no con los de la app: la
//! decoración forma parte del buffer de la terminal igual que el resto de la
//! salida, así que sobrevive al scroll, a los repintados de ConPTY y a un
//! `clear` posterior. El banner del sistema también forma parte del mismo
//! buffer, aunque se emite una sola vez durante el arranque de la sesión.
//!
//! ## Colores en cmd.exe
//!
//! `echo` de cmd no interpreta secuencias de escape y no se le puede colar un
//! ESC literal en la línea: el editor de línea de la consola lo trata como
//! "borrar la línea" y se comería el comando entero. La vía que sí funciona es
//! capturar el ESC una vez con `prompt $E` y guardarlo en una variable, que es
//! lo que hace el script de inicialización de cada pestaña (ver
//! `alias_profiles::escape_capture_line`). Aquí solo se usa esa variable.

use crate::environments::{ShellKind, Transport};
use crate::i18n::Translator;

/// Nombre de la variable de entorno donde las pestañas de cmd guardan el
/// carácter ESC. La define el script de inicialización.
pub const CMD_ESC_VAR: &str = "WSTERM_ESC";

/// Variable de entorno de cada pestaña con la carpeta de sesión, donde se
/// escriben la cabecera y el cierre de las acciones de cmd.
pub const CMD_FRAME_DIR_VAR: &str = "WSTERM_UI";

/// Donde el cierre de cmd guarda el código de la orden mientras pinta el pie.
const CMD_RC_VAR: &str = "WSTERM_RC";

/// La variable global de PowerShell con el código de la última acción
/// enmarcada. El prompt con marcas la lee una vez y la vacía.
pub const PS_ACTION_CODE_VAR: &str = "wtActionCode";

/// Numera los archivos de las acciones de esta ejecución (`ui-N-ini.cmd`,
/// `ui-N.ps1`, `ui-N.sh`, `ui-N.fish`).
static CMD_FRAME_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Ancho de las reglas. 60 columnas caben en cualquier terminal que alguien use
/// de verdad, y dejan sitio de sobra para la etiqueta del verbo.
const RULE_WIDTH: usize = 60;
/// Longitud máxima de una orden de decoración que se entrega a `cmd.exe`.
/// Además del texto visible, la línea contiene dos variables ANSI y el prompt
/// de la shell; mantenerla corta evita que el propio eco de cmd parta la
/// cabecera antes de que xterm pueda pintarla.
/// El cierre lleva además `if errorlevel 1`/`if not errorlevel 1`; necesita
/// dejar espacio para ese prefijo y para el prompt que cmd pinta delante.
///
/// Qué se está haciendo. El verbo va en la cabecera, en mayúsculas y con color;
/// el asunto es lo que el usuario reconoce ("Node.js LTS", "deploy.ps1").
pub struct Notice {
    pub verb: String,
    pub subject: String,
    /// El comando que se va a ejecutar, tal cual. Se enseña siempre: es la
    /// promesa de que la app no ejecuta nada a tus espaldas.
    pub command_preview: String,
    /// Aviso a tener en cuenta antes de que corra (lo que en el panel es el
    /// `hint` de la acción).
    pub note: Option<String>,
    /// Qué decir cuando termina bien. Sin esto se usa un texto genérico.
    pub done: Option<String>,
}

impl Notice {
    pub fn new(verb: impl Into<String>, subject: impl Into<String>, command: &str) -> Notice {
        Notice {
            verb: verb.into(),
            subject: subject.into(),
            command_preview: command.to_string(),
            note: None,
            done: None,
        }
    }

    pub fn note(mut self, note: Option<String>) -> Notice {
        self.note = note.filter(|text| !text.is_empty());
        self
    }

    pub fn done(mut self, done: impl Into<String>) -> Notice {
        self.done = Some(done.into());
        self
    }
}

/// Los colores que se usan, con el papel que cumple cada uno en vez del nombre
/// del color: así se cambia la paleta en un sitio.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    /// La caja y el verbo.
    Frame,
    /// El asunto: lo que el usuario está buscando con la mirada.
    Subject,
    /// El comando y los avisos: presentes, pero sin robar atención.
    Muted,
    Ok,
    Fail,
}

impl Tone {
    /// Código SGR. Se separan de los nombres de PowerShell porque no hay
    /// correspondencia exacta y PowerShell no admite un código arbitrario.
    fn sgr(self) -> &'static str {
        match self {
            Tone::Frame => "36",
            Tone::Subject => "1;97",
            Tone::Muted => "90",
            Tone::Ok => "32",
            Tone::Fail => "31",
        }
    }

    fn powershell(self) -> &'static str {
        match self {
            Tone::Frame => "Cyan",
            Tone::Subject => "White",
            Tone::Muted => "DarkGray",
            Tone::Ok => "Green",
            Tone::Fail => "Red",
        }
    }

    fn fish(self) -> &'static str {
        match self {
            Tone::Frame => "cyan",
            Tone::Subject => "white --bold",
            Tone::Muted => "brblack",
            Tone::Ok => "green",
            Tone::Fail => "red",
        }
    }
}

/// Una línea de la decoración: su texto ya compuesto y con qué papel se pinta.
struct Line {
    tone: Tone,
    text: String,
}

fn line(tone: Tone, text: impl Into<String>) -> Line {
    Line {
        tone,
        text: text.into(),
    }
}

/// Recorta a lo que cabe en la caja, con puntos suspensivos. Un comando de
/// PowerShell de instalación de ADB ocupa quince líneas: enseñarlo entero en la
/// cabecera taparía justo lo que la cabecera intenta destacar.
fn ellipsize(text: &str, max: usize) -> String {
    let flat = flatten_text(text);
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// Normaliza saltos de línea y controles sin recortar el contenido. CMD ya
/// envuelve visualmente las líneas que no caben en la rejilla; fabricar
/// fragmentos aquí convertiría una única cabecera en varias órdenes `echo` y
/// haría que el texto pareciera perdido.
fn flatten_text(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// La regla superior lleva el verbo incrustado: `┌─ INSTALAR ─────…`
fn top_rule(verb: &str) -> String {
    let etiqueta = format!("─ {} ", verb.to_uppercase());
    let usado = etiqueta.chars().count() + 1;
    format!(
        "┌{etiqueta}{}",
        "─".repeat(RULE_WIDTH.saturating_sub(usado))
    )
}

fn bottom_rule() -> String {
    format!("└{}", "─".repeat(RULE_WIDTH.saturating_sub(1)))
}

fn header_lines(notice: &Notice) -> Vec<Line> {
    let interior = RULE_WIDTH.saturating_sub(4);
    let mut lines = vec![
        line(Tone::Frame, top_rule(&notice.verb)),
        line(
            Tone::Subject,
            format!("│ {}", ellipsize(&notice.subject, interior)),
        ),
        line(
            Tone::Muted,
            format!("│ {}", ellipsize(&notice.command_preview, interior)),
        ),
    ];
    if let Some(note) = &notice.note {
        lines.push(line(
            Tone::Muted,
            format!("│ {}", ellipsize(note, interior)),
        ));
    }
    lines.push(line(Tone::Frame, bottom_rule()));
    lines
}

/// En `cmd.exe` cada orden se entrega en su propia línea, pero nunca se parte
/// el texto visible en órdenes artificiales. El propio xterm/ConPTY se ocupa
/// del wrap y conserva la línea completa en el scrollback y en el scroll
/// horizontal; dividir a 24 o 12 columnas hacía que el usuario viera varias
/// cabeceras incompletas y perdiera la relación entre el comando y su estado.
///
/// El asunto y la orden van enteros (en cmd la línea tecleada se borra y la
/// cabecera es el único sitio donde se lee la orden). `ruled` pone las reglas
/// de las demás shells (`┌─ VER ────…` y `└────…`): en los archivos
/// `ui-N-ini.cmd` no se teclea nada y caben (16-11). En la forma tecleada, la
/// de reserva sin carpeta de sesión, el marco sigue corto para no alargar la
/// línea que repite cmd.
fn cmd_header_lines(notice: &Notice, ruled: bool) -> Vec<Line> {
    let top = if ruled {
        top_rule(&flatten_text(&notice.verb))
    } else {
        format!("┌─ {}", flatten_text(&notice.verb).to_uppercase())
    };
    let mut lines = vec![line(Tone::Frame, top)];
    lines.push(line(
        Tone::Subject,
        format!("│ {}", flatten_text(&notice.subject)),
    ));
    lines.push(line(
        Tone::Muted,
        format!("│ {}", flatten_text(&notice.command_preview)),
    ));
    if let Some(note) = &notice.note {
        lines.push(line(Tone::Muted, format!("│ {}", flatten_text(note))));
    }
    lines.push(line(
        Tone::Frame,
        if ruled {
            bottom_rule()
        } else {
            "└".to_string()
        },
    ));
    lines
}

fn footer_lines(notice: &Notice, ok: bool, pause: Option<&str>, t: &Translator) -> Vec<Line> {
    let (tone, marca, texto) = if ok {
        (
            Tone::Ok,
            "✔",
            notice.done.clone().unwrap_or_else(|| {
                t.tp(
                    "console.done",
                    &[("subject", notice.subject.clone())],
                    "{subject} · completado",
                )
            }),
        )
    } else {
        (
            Tone::Fail,
            "✘",
            t.tp(
                "console.failed",
                &[("subject", notice.subject.clone())],
                "{subject} · terminó con error. La salida de arriba dice por qué.",
            ),
        )
    };
    let mut lines = vec![line(tone, format!("{marca} {texto}"))];
    if let Some(pause) = pause {
        lines.push(line(Tone::Muted, format!("  {pause}")));
    }
    lines
}

// ---- Emisores por familia de shell ----

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `printf` en vez de `echo`: `echo -e` no es portable (el `sh` de Debian es
/// dash y no lo admite) y `printf` interpreta `\033` en todas partes.
fn posix_echo(line: &Line) -> String {
    // El texto va como argumento de `%s`, no en el formato: un `%` suyo sale
    // tal cual (doblarlo enseñaba «100%%», 16-11).
    format!(
        "printf '\\033[{}m%s\\033[0m\\n' {}",
        line.tone.sgr(),
        sh_quote(&line.text)
    )
}

fn fish_echo(line: &Line) -> String {
    format!(
        "set_color {}; echo {}; set_color normal",
        line.tone.fish(),
        sh_quote(&line.text)
    )
}

fn powershell_echo(line: &Line) -> String {
    // Comilla simple: dentro no se interpola nada, y `$` o `` ` `` de un
    // comando ajeno no se expanden al pintarlo.
    format!(
        "Write-Host '{}' -ForegroundColor {}",
        line.text.replace('\'', "''"),
        line.tone.powershell()
    )
}

fn cmd_echo(line: &Line) -> String {
    // `echo.` (con punto) imprime una línea vacía; sin él, `echo` a secas
    // enseñaría el estado de ECHO. El texto se protege de los metacaracteres
    // que cmd interpretaría en medio de una línea encadenada con `&`.
    let texto = line
        .text
        .replace('^', "^^")
        // Una previsualización recortada puede conservar la comilla de
        // apertura de una ruta y perder la de cierre. En una línea enlazada
        // con `&`, cmd consideraría entonces todos los separadores siguientes
        // parte de esa comilla y se limitaría a imprimir el comando real. El
        // caret muestra la comilla sin dejar que participe en el análisis.
        .replace('"', "^\"")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        // Toda la decoración y el comando viajan en una sola línea. Si el
        // cierre contiene `if (...)`, cmd analiza también los paréntesis de
        // los textos impresos como sintaxis del bloque. Por ejemplo, el `)`
        // de "Editor de código (VS Code)" cerraba el `if` antes de tiempo.
        .replace('(', "^(")
        .replace(')', "^)");
    format!(
        "echo %{CMD_ESC_VAR}%[{}m{texto}%{CMD_ESC_VAR}%[0m",
        line.tone.sgr()
    )
}

/// Una línea de la decoración para un `.cmd`: aquí sí cabe un ESC literal (el
/// editor de línea de la consola no interviene al leer un archivo) y el `@`
/// evita que cmd repita la orden. `%` se dobla porque dentro de un archivo
/// por lotes un `%` suelto desaparece.
fn cmd_file_echo(line: &Line) -> String {
    let texto = line
        .text
        .replace('%', "%%")
        .replace('^', "^^")
        .replace('"', "^\"")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('(', "^(")
        .replace(')', "^)");
    format!("@echo \x1b[{}m{texto}\x1b[0m", line.tone.sgr())
}

/// Los dos archivos que rodean una acción en cmd: la cabecera (`ini`) y el
/// cierre (`fin`). No llevan `echo off`: al terminar un `call` desde el
/// prompt, cmd no siempre restaura el eco, y cada línea ya empieza por `@`.
/// Lo que instala una acción (WinGet, Chocolatey, npm…) suele añadir su
/// carpeta al PATH del registro, pero la shell de la pestaña conserva el PATH
/// con el que arrancó: `claude` recién instalado «no se reconocía». Al cerrar
/// cada acción se añaden a la sesión las carpetas nuevas del PATH de máquina y
/// de usuario, sin quitar ni reordenar nada (las de WTerminal siguen delante).
const PATH_REFRESH_PS: &str = "$wtPath = $env:Path.TrimEnd(';'); foreach ($wtEntry in ([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')).Split(';')) { if ($wtEntry -and ($wtPath.Split(';') -notcontains $wtEntry)) { $wtPath += ';' + $wtEntry } }";

/// La misma actualización para cmd: PowerShell calcula el PATH nuevo y `set`
/// lo aplica en la sesión. La ruta va sin comillas a propósito: en `for /f`
/// una orden que empieza por comillas pierde las suyas (y `%SystemRoot%` no
/// lleva espacios). `percent` es `%` en la línea tecleada y `%%` en un .cmd.
fn cmd_path_refresh(percent: &str) -> String {
    format!(
        r#"for /f "usebackq delims=" {percent}W in (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "{PATH_REFRESH_PS}; $wtPath"`) do @set "PATH={percent}W""#
    )
}

/// Borra la línea que cmd acaba de repetir: subir, vaciar la fila y subir otra
/// vez, porque `echo` baja una al terminar. La orden real sigue a la vista en
/// la cabecera, sin los dos `call` de la decoración.
const CMD_ERASE_TYPED_LINE: &str = "@echo \x1b[1A\x1b[2K\x1b[1A";
/// Hasta dónde se puede borrar: una fila de cmd mide 1024 columnas y el prompt
/// puede llegar a 260 (`MAX_PATH`). Una línea más larga ocuparía varias filas.
const CMD_ERASE_TYPED_LINE_MAX: usize = 1024 - 260 - 4;

fn cmd_frame_scripts(
    notice: &Notice,
    pause: Option<&str>,
    t: &Translator,
    erase_typed_line: bool,
) -> (String, String) {
    let mut ini = Vec::new();
    if erase_typed_line {
        ini.push(CMD_ERASE_TYPED_LINE.to_string());
    }
    ini.push("@echo.".to_string());
    ini.extend(cmd_header_lines(notice, true).iter().map(cmd_file_echo));
    ini.push("@echo.".to_string());
    let mut fin = vec![
        // El código que dejó la orden, antes que nada (`call` no lo cambia).
        // Después de guardarlo da igual que `set` lo ponga a 0 en un `.cmd`.
        format!("@set \"{CMD_RC_VAR}=%errorlevel%\""),
        "@echo.".to_string(),
        // Distinto de 0 y no `if errorlevel 1`: winget falla con códigos
        // negativos (-1978335212…) y esos pasaban por buenos (13-11).
        format!("@if not \"%{CMD_RC_VAR}%\"==\"0\" goto wsterm_fail"),
    ];
    fin.extend(
        footer_lines(notice, true, pause, t)
            .iter()
            .map(cmd_file_echo),
    );
    fin.push("@goto wsterm_end".to_string());
    fin.push(":wsterm_fail".to_string());
    fin.extend(
        footer_lines(notice, false, pause, t)
            .iter()
            .map(cmd_file_echo),
    );
    fin.push(":wsterm_end".to_string());
    fin.push(format!("@{}", cmd_path_refresh("%%")));
    // El prompt de cmd no puede decir cómo acabó la orden: lo dice aquí la
    // marca `D` con el código real, y la pestaña la pinta en rojo y ofrece el
    // consejero si falló. `set /p` la escribe sin salto de línea.
    fin.push(format!("@<nul set /p \"=\x1b]133;D;%{CMD_RC_VAR}%\x07\""));
    if pause.is_some() {
        fin.push("@pause >nul".to_string());
    }
    // La sesión se queda con el código de la orden (`echo %errorlevel%` lo
    // dice) y sin la variable: `%…%` se expande antes de vaciarla.
    fin.push(format!("@set \"{CMD_RC_VAR}=\" & exit /b %{CMD_RC_VAR}%"));
    (ini.join("\r\n") + "\r\n", fin.join("\r\n") + "\r\n")
}

/// La única línea que se teclea en cmd: la orden real, tal cual, entre la
/// cabecera y el cierre. `&&`, `||` y `|` atan más fuerte que `&`, así que una
/// orden compuesta sigue siendo un solo bloque entre las dos llamadas.
fn cmd_one_line(command: &str, seq: u64) -> String {
    format!(
        "call \"%{CMD_FRAME_DIR_VAR}%\\ui-{seq}-ini.cmd\" & {command} & call \"%{CMD_FRAME_DIR_VAR}%\\ui-{seq}-fin.cmd\""
    )
}

/// Escribe la cabecera y el cierre en `dir` y devuelve la línea que los usa.
/// `None` si no se pudieron escribir: entonces se vuelve al formato de varias
/// líneas, que no necesita archivos.
fn cmd_framed(
    command: &str,
    notice: &Notice,
    pause: Option<&str>,
    t: &Translator,
    dir: &std::path::Path,
) -> Option<String> {
    let seq = CMD_FRAME_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let line = cmd_one_line(command, seq);
    let erase_typed_line = line.chars().count() <= CMD_ERASE_TYPED_LINE_MAX;
    let (ini, fin) = cmd_frame_scripts(notice, pause, t, erase_typed_line);
    std::fs::write(dir.join(format!("ui-{seq}-ini.cmd")), ini).ok()?;
    std::fs::write(dir.join(format!("ui-{seq}-fin.cmd")), fin).ok()?;
    Some(line)
}

/// Lo mismo que [`CMD_ERASE_TYPED_LINE`] para PowerShell: tras el Intro el
/// cursor está al principio de la fila siguiente; se sube a la tecleada y se
/// vacía, y el `Write-Host ''` que abre la cabecera la deja en blanco, igual
/// que en cmd. `[char]27` y no `` `e ``: Windows PowerShell 5.1 no lo conoce.
const PS_ERASE_TYPED_LINE: &str = "Write-Host -NoNewline \"$([char]27)[1A$([char]27)[2K\"";

/// Las sentencias de una acción en PowerShell, en orden: cabecera, la orden,
/// el veredicto con `$?` y `$LASTEXITCODE`, el PATH nuevo, el cierre y la
/// pausa. Se encadenan con `;` en una línea o van una por línea en un archivo.
fn powershell_statements(
    command: &str,
    notice: &Notice,
    pause: Option<&str>,
    t: &Translator,
) -> Vec<String> {
    let ok = footer_lines(notice, true, pause, t);
    let fail = footer_lines(notice, false, pause, t);
    let mut parts: Vec<String> = vec!["Write-Host ''".to_string()];
    parts.extend(header_lines(notice).iter().map(powershell_echo));
    parts.push("Write-Host ''".to_string());
    parts.push(format!("$global:LASTEXITCODE = 0; {command}"));
    parts.push("$wstermOk = $?  -and ($LASTEXITCODE -eq 0)".to_string());
    // El pie y la pausa dejan `$?` en verdadero: el prompt (marca `D`)
    // toma de aquí cómo acabó la orden de verdad.
    parts.push(format!(
        "$global:{PS_ACTION_CODE_VAR} = if ($wstermOk) {{ 0 }} elseif ($LASTEXITCODE) {{ $LASTEXITCODE }} else {{ 1 }}"
    ));
    parts.push(format!("{PATH_REFRESH_PS}; $env:Path = $wtPath"));
    parts.push("Write-Host ''".to_string());
    let bien = ok
        .iter()
        .map(powershell_echo)
        .collect::<Vec<_>>()
        .join("; ");
    let mal = fail
        .iter()
        .map(powershell_echo)
        .collect::<Vec<_>>()
        .join("; ");
    parts.push(format!("if ($wstermOk) {{ {bien} }} else {{ {mal} }}"));
    // El pie ya dice «Pulsa Enter…»: se espera en silencio, como el
    // `pause >nul` de cmd (con texto salía dos veces, 16-11).
    if pause.is_some() {
        parts.push("$null = Read-Host".to_string());
    }
    parts
}

/// La forma corta de PowerShell, como la de cmd (14-11): toda la acción va en
/// `ui-N.ps1` de la carpeta de sesión y solo se teclea `. 'ruta\ui-N.ps1'`.
///
/// Encadenada en una línea medía unos mil caracteres, y PSReadLine la repinta
/// entera a cada tecla: «Escribir de una vez» se rendía (cientos de entregas,
/// más de 2 s) y la orden se veía escribir letra a letra, también la de un
/// `.ps1` de la Biblioteca, que siempre va a una pestaña de PowerShell.
/// `.` la ejecuta en la sesión, como si se hubiera tecleado: lo que cambie
/// (variables, carpeta, `$LASTEXITCODE`) se queda. Las pestañas de PowerShell
/// arrancan con `-ExecutionPolicy Bypass`, que es lo que deja cargar el
/// inicializador de la misma carpeta. La ruta va entera y no con
/// `$env:WSTERM_UI`: una pestaña elevada con NSudo puede no heredar la
/// variable. UTF-8 con BOM: sin él Windows PowerShell lo leería en ANSI.
fn ps_framed(
    command: &str,
    notice: &Notice,
    pause: Option<&str>,
    t: &Translator,
    dir: &std::path::Path,
    transport: Transport,
) -> Option<String> {
    let seq = CMD_FRAME_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = dir.join(format!("ui-{seq}.ps1"));
    let shown = path_in_shell(&path, ShellKind::Powershell, transport);
    let line = format!(". '{}'", shown.replace('\'', "''"));
    let mut statements = Vec::new();
    // Como en cmd: si la línea pudiera ocupar más de una fila, no se borra.
    if line.chars().count() <= CMD_ERASE_TYPED_LINE_MAX {
        statements.push(PS_ERASE_TYPED_LINE.to_string());
    }
    statements.extend(powershell_statements(command, notice, pause, t));
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice((statements.join("\r\n") + "\r\n").as_bytes());
    std::fs::write(&path, bytes).ok()?;
    Some(line)
}

/// Lo mismo que [`PS_ERASE_TYPED_LINE`] para bash, zsh, sh y fish: subir a la
/// fila tecleada y vaciarla. El `printf '\n'` que abre la cabecera la deja en
/// blanco. fish también tiene `printf` como orden interna y entiende `\033`.
const SH_ERASE_TYPED_LINE: &str = r"printf '\033[1A\033[2K'";

/// La familia de shells POSIX (bash, zsh, sh): cabecera, la orden, el
/// veredicto con `$?`, el cierre y la pausa. Se encadenan con `;` en una línea
/// o van una por línea en un archivo.
fn posix_statements(
    command: &str,
    notice: &Notice,
    pause: Option<&str>,
    t: &Translator,
) -> Vec<String> {
    let ok = footer_lines(notice, true, pause, t);
    let fail = footer_lines(notice, false, pause, t);
    let mut parts: Vec<String> = vec!["printf '\\n'".to_string()];
    parts.extend(header_lines(notice).iter().map(posix_echo));
    parts.push("printf '\\n'".to_string());
    parts.push(command.to_string());
    parts.push("__wsterm_rc=$?".to_string());
    parts.push("printf '\\n'".to_string());
    let bien = ok.iter().map(posix_echo).collect::<Vec<_>>().join("; ");
    let mal = fail.iter().map(posix_echo).collect::<Vec<_>>().join("; ");
    parts.push(format!(
        "if [ $__wsterm_rc -eq 0 ]; then {bien}; else {mal}; fi"
    ));
    // El pie ya dice «Pulsa Enter…»: se espera en silencio, como en cmd.
    if pause.is_some() {
        parts.push("read __wsterm_pause".to_string());
    }
    // El prompt lee `$?`: que sea el de la orden, no el del pie. Cargada con
    // `.`, el archivo devuelve también el de su última línea.
    parts.push("(exit $__wsterm_rc)".to_string());
    parts
}

fn fish_statements(
    command: &str,
    notice: &Notice,
    pause: Option<&str>,
    t: &Translator,
) -> Vec<String> {
    // En fish el aviso de la pausa lo pinta su `read -P`: el pie no lo
    // repite (salía dos veces, 16-11).
    let ok = footer_lines(notice, true, None, t);
    let fail = footer_lines(notice, false, None, t);
    let mut parts: Vec<String> = vec!["echo".to_string()];
    parts.extend(header_lines(notice).iter().map(fish_echo));
    parts.push("echo".to_string());
    parts.push(command.to_string());
    parts.push("set __wsterm_rc $status".to_string());
    parts.push("echo".to_string());
    let bien = ok.iter().map(fish_echo).collect::<Vec<_>>().join("; ");
    let mal = fail.iter().map(fish_echo).collect::<Vec<_>>().join("; ");
    parts.push(format!(
        "if test $__wsterm_rc -eq 0; {bien}; else; {mal}; end"
    ));
    if let Some(pause) = pause {
        parts.push(format!(
            "read -P {} __wsterm_pause",
            sh_quote(&format!("{pause} "))
        ));
    }
    parts
}

/// La ruta del archivo de la acción tal como la ve la shell: la de Windows en
/// cmd y PowerShell, `/mnt/c/…` dentro de WSL y `/c/…` en Git Bash. Es la
/// misma traducción con la que esa shell ya cargó su inicializador.
fn path_in_shell(path: &std::path::Path, kind: ShellKind, transport: Transport) -> String {
    let raw = path.to_string_lossy();
    match (kind, transport) {
        (_, Transport::Wsl) => crate::shell_paths::to_wsl_path(&raw),
        (ShellKind::Cmd | ShellKind::Powershell, _) => raw.into_owned(),
        _ => crate::shell_paths::unix_path_for(&raw, transport),
    }
}

/// La forma corta de bash, zsh, sh y fish (16-11), como la de PowerShell: toda
/// la acción va en `ui-N.sh` (o `.fish`) y solo se teclea `. '<ruta>'`
/// (`source` en fish). Encadenada medía cientos de caracteres y la shell la
/// repetía entera; ahora la orden se lee en la cabecera, como en las demás.
/// `.` la ejecuta en la sesión: un `cd` o una variable de la orden se quedan.
/// Fin de línea LF y sin BOM, o bash leería `\r` al final de cada orden.
fn sh_framed(
    command: &str,
    notice: &Notice,
    kind: ShellKind,
    transport: Transport,
    pause: Option<&str>,
    t: &Translator,
    dir: &std::path::Path,
) -> Option<String> {
    let fish = kind == ShellKind::Fish;
    let seq = CMD_FRAME_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = dir.join(format!("ui-{seq}.{}", if fish { "fish" } else { "sh" }));
    let shown = sh_quote(&path_in_shell(&path, kind, transport));
    let line = if fish {
        format!("source {shown}")
    } else {
        format!(". {shown}")
    };
    let mut statements = Vec::new();
    if line.chars().count() <= CMD_ERASE_TYPED_LINE_MAX {
        statements.push(SH_ERASE_TYPED_LINE.to_string());
    }
    if fish {
        statements.extend(fish_statements(command, notice, pause, t));
    } else {
        statements.extend(posix_statements(command, notice, pause, t));
    }
    std::fs::write(&path, statements.join("\n") + "\n").ok()?;
    Some(line)
}

/// Envuelve el comando con su cabecera y su cierre, en la sintaxis de esta
/// shell. `pause` es el mensaje de "pulsa Enter"; sin él el comando termina y
/// devuelve el prompt directamente.
///
/// El cierre distingue entre bien y mal usando el código de salida REAL del
/// comando, no un mensaje fijo: decir "completado" después de que winget haya
/// fallado sería peor que no decir nada.
///
/// `transport` dice si la shell ve la carpeta de sesión del equipo: en Docker,
/// ADB o Wine no la ve y la acción se teclea entera, encadenada en una línea.
pub fn decorate(
    command: &str,
    notice: &Notice,
    kind: ShellKind,
    transport: Transport,
    pause: bool,
    t: &Translator,
) -> String {
    // Las pruebas de unidad no escriben en la carpeta de sesión real.
    let frame_dir = if cfg!(test) || !uses_session_files(kind, transport) {
        None
    } else {
        crate::session_files::dir()
    };
    decorate_via(
        command,
        notice,
        kind,
        transport,
        pause,
        t,
        frame_dir.as_deref(),
    )
}

/// Si la acción puede ir en un archivo de la carpeta de sesión: la shell tiene
/// que ver esa carpeta (no en Docker, ADB ni Wine) y entender el marco (un
/// REPL no).
fn uses_session_files(kind: ShellKind, transport: Transport) -> bool {
    transport.loads_host_files() && !matches!(kind, ShellKind::Repl | ShellKind::Android)
}

/// [`decorate_via`] en una shell del propio equipo.
#[cfg(test)]
fn decorate_in(
    command: &str,
    notice: &Notice,
    kind: ShellKind,
    pause: bool,
    t: &Translator,
    frame_dir: Option<&std::path::Path>,
) -> String {
    decorate_via(
        command,
        notice,
        kind,
        Transport::Native,
        pause,
        t,
        frame_dir,
    )
}

fn decorate_via(
    command: &str,
    notice: &Notice,
    kind: ShellKind,
    transport: Transport,
    pause: bool,
    t: &Translator,
    frame_dir: Option<&std::path::Path>,
) -> String {
    let pause_text = pause.then(|| t.t("console.pause", "Pulsa Enter para volver a la terminal"));
    if let Some(dir) = frame_dir {
        let pause = pause_text.as_deref();
        let framed = match kind {
            ShellKind::Cmd => cmd_framed(command, notice, pause, t, dir),
            ShellKind::Powershell => ps_framed(command, notice, pause, t, dir, transport),
            ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh | ShellKind::Fish => {
                sh_framed(command, notice, kind, transport, pause, t, dir)
            }
            ShellKind::Repl | ShellKind::Android => None,
        };
        if let Some(line) = framed {
            return line;
        }
    }

    // Sin carpeta de sesión (o si no se pudo escribir): todo encadenado en una
    // línea, la forma de antes del 14-11.
    match kind {
        ShellKind::Cmd => {
            let ok = footer_lines(notice, true, pause_text.as_deref(), t);
            let fail = footer_lines(notice, false, pause_text.as_deref(), t);
            let mut parts: Vec<String> = vec!["echo.".to_string()];
            parts.extend(cmd_header_lines(notice, false).iter().map(cmd_echo));
            parts.push("echo.".to_string());
            parts.push(command.to_string());
            parts.push("echo.".to_string());
            // `%ERRORLEVEL%` se expandiría al ANALIZAR la línea, o sea antes de
            // que el comando corra. `if errorlevel` sí se evalúa en su momento.
            // Un bloque `if (...) else (...)` vuelve a juntar todos los
            // mensajes en una sola línea física. Emitir una condición por
            // línea conserva ERRORLEVEL y mantiene corto el eco de cmd.
            parts.extend(
                fail.iter()
                    .map(|item| format!("if errorlevel 1 {}", cmd_echo(item))),
            );
            parts.extend(
                ok.iter()
                    .map(|item| format!("if not errorlevel 1 {}", cmd_echo(item))),
            );
            parts.push(cmd_path_refresh("%"));
            if pause {
                parts.push("pause >nul".to_string());
            }
            // Cada bloque se entrega como una línea propia. No se trocean los
            // mensajes: cmd/ConPTY y xterm pueden envolverlos visualmente,
            // pero el scrollback conserva cada cabecera y cada estado como una
            // línea completa.
            parts.join("\r")
        }
        ShellKind::Powershell => {
            powershell_statements(command, notice, pause_text.as_deref(), t).join("; ")
        }
        ShellKind::Fish => fish_statements(command, notice, pause_text.as_deref(), t).join("; "),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => {
            posix_statements(command, notice, pause_text.as_deref(), t).join("; ")
        }
        // Un REPL o la shell de un móvil no entienden nada de esto: el comando
        // se escribe pelado, como hasta ahora.
        ShellKind::Repl | ShellKind::Android => command.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aviso() -> Notice {
        Notice::new(
            "Instalar",
            "Node.js LTS",
            "winget install --id OpenJS.NodeJS.LTS -e",
        )
    }

    fn t() -> Translator {
        Translator::default()
    }

    /// Las pruebas de siempre decoran para una shell del propio equipo.
    fn decorate(
        command: &str,
        notice: &Notice,
        kind: ShellKind,
        pause: bool,
        t: &Translator,
    ) -> String {
        super::decorate(command, notice, kind, Transport::Native, pause, t)
    }

    #[test]
    fn la_cabecera_dice_el_verbo_el_asunto_y_el_comando_que_se_va_a_ejecutar() {
        let salida = decorate("winget install x", &aviso(), ShellKind::Bash, false, &t());
        assert!(salida.contains("INSTALAR"));
        assert!(salida.contains("Node.js LTS"));
        assert!(salida.contains("winget install --id OpenJS.NodeJS.LTS -e"));
    }

    #[test]
    fn el_comando_real_se_escribe_intacto_entre_la_cabecera_y_el_cierre() {
        // Decorar no puede cambiar lo que se ejecuta: es justo lo que el
        // usuario ha leído en la cabecera antes de aceptarlo.
        let comando = "sudo apt install -y git && echo hecho";
        for kind in [
            ShellKind::Cmd,
            ShellKind::Powershell,
            ShellKind::Bash,
            ShellKind::Zsh,
            ShellKind::Sh,
            ShellKind::Fish,
        ] {
            let salida = decorate(comando, &aviso(), kind, true, &t());
            assert!(salida.contains(comando), "{kind:?} altero el comando");
        }
    }

    #[test]
    fn un_repl_no_recibe_decoracion_porque_no_entenderia_nada_de_ella() {
        for kind in [ShellKind::Repl, ShellKind::Android] {
            assert_eq!(decorate("ver", &aviso(), kind, true, &t()), "ver");
        }
    }

    #[test]
    fn el_cierre_depende_del_codigo_de_salida_real_y_no_da_por_bueno_lo_que_fallo() {
        let bash = decorate("x", &aviso(), ShellKind::Bash, false, &t());
        assert!(bash.contains("__wsterm_rc=$?"));
        assert!(bash.contains("if [ $__wsterm_rc -eq 0 ]"));
        // Los dos cierres tienen que estar presentes: el de bien y el de mal.
        assert!(bash.contains("✔"));
        assert!(bash.contains("✘"));
    }

    #[test]
    fn cmd_pregunta_por_errorlevel_en_vez_de_expandirlo_al_analizar_la_linea() {
        // `%ERRORLEVEL%` en una línea encadenada con `&` se sustituye ANTES de
        // que el comando corra, así que siempre daría el código anterior.
        let salida = decorate("x", &aviso(), ShellKind::Cmd, false, &t());
        assert!(salida.contains("if errorlevel 1 echo "));
        assert!(salida.contains("if not errorlevel 1 echo "));
        assert!(!salida.contains("%ERRORLEVEL%"));
    }

    #[test]
    fn cmd_separa_los_bloques_para_no_recortar_lineas_largas() {
        // Una línea por bloque deja que cmd y ConPTY envuelvan la entrada; el
        // errorlevel se conserva hasta la condición de cierre.
        let salida = decorate("x", &aviso(), ShellKind::Cmd, false, &t());
        assert!(salida.contains("\r"));
        assert!(!salida.contains("%[0m & "), "cmd volvió a una línea única");
    }

    #[test]
    fn cmd_usa_un_marco_compacto_que_no_se_desborda() {
        let salida = decorate(
            "powershell -NoProfile -Command \"winget upgrade --all --include-unknown\"",
            &aviso(),
            ShellKind::Cmd,
            false,
            &t(),
        );
        assert!(salida.contains("┌─ INSTALAR"));
        assert!(salida.contains("\r"));
        assert!(!salida.contains("┌─ INSTALAR ─"));
        assert!(salida.contains("\r"));
    }

    #[test]
    fn cmd_conserva_cada_cabecera_completa_en_una_orden() {
        let notice = Notice::new(
            "Desinstalar del sistema completo",
            "Una herramienta con un nombre suficientemente largo para envolver",
            "powershell -NoProfile -Command \"winget uninstall --id ejemplo\"",
        );
        let lines = cmd_header_lines(&notice, false);
        assert_eq!(lines.len(), 4);
        assert!(lines.iter().any(|item| item.text.contains(&notice.subject)));
        assert!(lines
            .iter()
            .any(|item| item.text.contains(&notice.command_preview)));
        let salida = decorate("echo x", &notice, ShellKind::Cmd, false, &t());
        assert!(!salida.contains("if errorlevel 1 ("));
        assert!(!salida.contains(" else ("));
        assert!(salida.contains("terminó con error"));
        assert!(salida.contains("completado"));
    }

    #[test]
    fn cmd_escapa_parentesis_de_los_textos_que_comparte_con_el_bloque_if() {
        let aviso = Notice::new(
            "Instalar",
            "Editor de código (VS Code)",
            "winget install --id Microsoft.VisualStudioCode -e",
        );
        let salida = decorate("winget install x", &aviso, ShellKind::Cmd, true, &t());

        assert!(salida.contains("^("));
        assert!(salida.contains("^)"));
        assert!(!salida.contains("Editor de código (VS Code)"));
    }

    #[test]
    fn cmd_pinta_con_el_escape_que_dejo_el_script_de_inicializacion() {
        let salida = decorate("x", &aviso(), ShellKind::Cmd, false, &t());
        assert!(salida.contains(&format!("%{CMD_ESC_VAR}%[36m")));
        // Y nunca un ESC literal: el editor de línea de la consola lo tratería
        // como "borrar la línea" y se comería el comando.
        assert!(!salida.contains('\x1b'));
    }

    #[test]
    fn las_shells_unix_usan_printf_porque_echo_menos_e_no_es_portable() {
        // El `sh` de Debian es dash: `echo -e` imprimiría "-e" literal.
        let salida = decorate("x", &aviso(), ShellKind::Sh, false, &t());
        assert!(salida.contains("printf '\\033[36m%s\\033[0m\\n'"));
        assert!(!salida.contains("echo -e"));
    }

    #[test]
    fn un_texto_con_comilla_simple_no_rompe_el_entrecomillado_de_ninguna_shell() {
        let notice = Notice::new("Abrir", "El script de Álex's", "cat 'x'");
        for kind in [ShellKind::Bash, ShellKind::Fish, ShellKind::Powershell] {
            let salida = decorate("cat 'x'", &notice, kind, false, &t());
            // En POSIX y fish la comilla se cierra y se escapa; en PowerShell
            // se duplica. Lo que no puede pasar es que quede suelta.
            assert!(
                salida.contains("'\\''") || salida.contains("Álex''s"),
                "{kind:?} no escapo la comilla"
            );
        }
    }

    #[test]
    fn cmd_neutraliza_los_metacaracteres_que_partirian_la_linea_encadenada() {
        let notice = Notice::new("Ver", "a & b | c > d", "echo x");
        let salida = decorate("echo x", &notice, ShellKind::Cmd, false, &t());
        assert!(salida.contains("a ^& b ^| c ^> d"));
    }

    #[test]
    fn cmd_conserva_comillas_y_rutas_largas_en_la_cabecera() {
        let comando = concat!(
            "git clone -- \"https://github.com/owner/project.git\" ",
            "\"C:\\Users\\Usuario\\Documents\\Una carpeta de proyectos muy larga\\project\""
        );
        let notice = Notice::new("Clonar", "owner/project", comando);
        let salida = decorate(comando, &notice, ShellKind::Cmd, false, &t());
        assert!(salida.contains(comando), "el comando real se recortó");
        assert!(salida.contains("owner/project"), "se perdió el asunto");
        assert!(salida.contains("^\""), "la comilla no se escapó en el eco");
    }

    #[test]
    fn un_comando_larguisimo_se_recorta_en_la_cabecera_pero_se_ejecuta_entero() {
        let largo = "Get-Process adb | Stop-Process -Force; ".repeat(20);
        let notice = Notice::new("Instalar", "ADB", &largo);
        let salida = decorate(&largo, &notice, ShellKind::Powershell, false, &t());
        assert!(salida.contains('…'), "la cabecera no se recorto");
        assert!(salida.contains(&largo), "el comando no se ejecuta entero");
    }

    #[test]
    fn los_saltos_de_linea_de_un_script_no_parten_la_cabecera_en_varias_lineas() {
        // El script de instalación de ADB es una sola línea, pero un hint o un
        // comando venido de otro sitio puede traer saltos.
        let notice = Notice::new("Instalar", "ADB", "linea1\nlinea2\r\nlinea3");
        let salida = decorate("x", &notice, ShellKind::Bash, false, &t());
        assert!(!salida.contains("linea1\nlinea2"));
        assert!(salida.contains("linea1 linea2 linea3"));
    }

    #[test]
    fn la_pausa_solo_aparece_cuando_se_pide() {
        let con = decorate("x", &aviso(), ShellKind::Bash, true, &t());
        let sin = decorate("x", &aviso(), ShellKind::Bash, false, &t());
        assert!(con.contains("read __wsterm_pause"));
        // Lo último deja en $? el código de la orden, para la marca D del prompt.
        assert!(
            con.ends_with("; (exit $__wsterm_rc)") && sin.ends_with("; (exit $__wsterm_rc)"),
            "{con}"
        );
        assert!(!sin.contains("read __wsterm_pause"));
        assert!(con.contains("Pulsa Enter"));
        assert!(!sin.contains("Pulsa Enter"));
    }

    #[test]
    fn el_aviso_de_la_accion_sale_en_la_cabecera_cuando_lo_hay() {
        let notice = aviso().note(Some("Requiere reiniciar Windows.".to_string()));
        let salida = decorate("x", &notice, ShellKind::Bash, false, &t());
        assert!(salida.contains("Requiere reiniciar Windows."));
        // Y una nota vacía no deja una línea en blanco dentro de la caja.
        let sin = aviso().note(Some(String::new()));
        assert!(sin.note.is_none());
    }

    #[test]
    fn la_caja_cierra_a_la_misma_anchura_por_arriba_y_por_abajo() {
        for verbo in ["Instalar", "Ver", "Desinstalar del sistema completo"] {
            let arriba = top_rule(verbo);
            let abajo = bottom_rule();
            // Con un verbo más largo que la regla, la de arriba se pasa: lo que
            // no puede es quedarse corta y dejar la caja escalonada.
            assert!(
                arriba.chars().count() >= abajo.chars().count()
                    || verbo.chars().count() + 5 > RULE_WIDTH,
                "'{verbo}' deja la caja escalonada"
            );
        }
        assert_eq!(top_rule("Instalar").chars().count(), RULE_WIDTH);
        assert_eq!(bottom_rule().chars().count(), RULE_WIDTH);
    }

    #[test]
    fn powershell_mira_el_codigo_de_salida_ademas_del_exito_del_cmdlet() {
        // `$?` es falso cuando falla un cmdlet, pero un .exe que devuelve 1
        // deja `$?` en verdadero: hacen falta los dos.
        let salida = decorate(
            "winget install x",
            &aviso(),
            ShellKind::Powershell,
            false,
            &t(),
        );
        assert!(salida.contains("$? "));
        assert!(salida.contains("$LASTEXITCODE -eq 0"));
        // El prompt (marca D) toma de aquí el código: el pie lo taparía.
        assert!(
            salida.contains("$global:wtActionCode = if ($wstermOk) { 0 }"),
            "{salida}"
        );
    }

    #[test]
    fn cmd_teclea_una_sola_linea_con_la_orden_real_entre_cabecera_y_cierre() {
        let dir = tempfile::tempdir().unwrap();
        let notice = Notice::new("Instalar", "Editor (VS Code) 100%", "winget install x");
        let linea = decorate_in(
            "winget install x",
            &notice,
            ShellKind::Cmd,
            true,
            &t(),
            Some(dir.path()),
        );
        assert!(!linea.contains('\r') && !linea.contains('\n'), "{linea}");
        assert!(linea.starts_with("call \"%WSTERM_UI%\\ui-"), "{linea}");
        assert!(
            linea.contains(" & winget install x & call \"%WSTERM_UI%\\ui-"),
            "{linea}"
        );
        let seq: String = linea["call \"%WSTERM_UI%\\ui-".len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let ini = std::fs::read_to_string(dir.path().join(format!("ui-{seq}-ini.cmd"))).unwrap();
        let fin = std::fs::read_to_string(dir.path().join(format!("ui-{seq}-fin.cmd"))).unwrap();
        // Sin `echo off` (cmd no restaura el eco del prompt tras un `call`),
        // con ESC literal y los metacaracteres neutralizados.
        assert!(!ini.to_ascii_lowercase().contains("echo off"));
        assert!(ini.contains("\x1b[36m┌─ INSTALAR"));
        // Con las reglas de las demás shells, a la misma anchura arriba y abajo.
        assert!(
            ini.contains(&format!("\x1b[36m{}\x1b[0m", top_rule("Instalar"))),
            "{ini}"
        );
        assert!(
            ini.contains(&format!("\x1b[36m{}\x1b[0m", bottom_rule())),
            "{ini}"
        );
        assert!(ini.contains("Editor ^(VS Code^) 100%%"));
        assert!(ini.lines().all(|line| line.starts_with('@')), "{ini}");
        // La línea tecleada se borra antes de la cabecera…
        assert!(ini.starts_with(CMD_ERASE_TYPED_LINE), "{ini}");
        // …salvo si por su longitud podría ocupar más de una fila.
        let larga = "x".repeat(CMD_ERASE_TYPED_LINE_MAX);
        let linea_larga = decorate_in(
            &larga,
            &aviso(),
            ShellKind::Cmd,
            false,
            &t(),
            Some(dir.path()),
        );
        let seq_larga: String = linea_larga["call \"%WSTERM_UI%\\ui-".len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let ini_larga =
            std::fs::read_to_string(dir.path().join(format!("ui-{seq_larga}-ini.cmd"))).unwrap();
        assert!(!ini_larga.contains(CMD_ERASE_TYPED_LINE), "{ini_larga}");
        assert!(fin.contains("@if not \"%WSTERM_RC%\"==\"0\" goto wsterm_fail"));
        assert!(fin.contains("\x1b]133;D;%WSTERM_RC%\x07"));
        assert!(fin.trim_end().ends_with("exit /b %WSTERM_RC%"), "{fin}");
        assert!(fin.contains("@pause >nul"));
        assert!(fin.contains("✔") && fin.contains("✘"));
        // Si no se pueden escribir los archivos se vuelve al formato antiguo.
        let sin_dir = decorate_in("x", &aviso(), ShellKind::Cmd, false, &t(), None);
        assert!(sin_dir.contains('\r'));
        let roto = decorate_in(
            "x",
            &aviso(),
            ShellKind::Cmd,
            false,
            &t(),
            Some(&dir.path().join("no-existe")),
        );
        assert!(roto.contains('\r'));
    }

    #[test]
    fn powershell_teclea_solo_la_carga_de_un_archivo_con_toda_la_accion() {
        let dir = tempfile::tempdir().unwrap();
        let notice = Notice::new("Instalar", "Editor (VS Code) 100%", "winget install x");
        let linea = decorate_in(
            "winget install x",
            &notice,
            ShellKind::Powershell,
            true,
            &t(),
            Some(dir.path()),
        );
        // Una línea corta: `. '<carpeta>\ui-N.ps1'`, sin la orden ni el marco.
        assert!(!linea.contains('\r') && !linea.contains('\n'), "{linea}");
        assert!(
            linea.starts_with(". '") && linea.ends_with(".ps1'"),
            "{linea}"
        );
        assert!(
            !linea.contains("Write-Host") && !linea.contains("winget"),
            "{linea}"
        );
        let ruta = linea[3..linea.len() - 1].replace("''", "'");
        let bytes = std::fs::read(&ruta).unwrap();
        // UTF-8 con BOM, o Windows PowerShell leería las tildes en ANSI.
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let archivo = String::from_utf8(bytes[3..].to_vec()).unwrap();
        let lineas: Vec<&str> = archivo.lines().collect();
        // Primero se borra la línea tecleada; después, lo de siempre.
        assert_eq!(lineas[0], PS_ERASE_TYPED_LINE);
        assert!(archivo.contains("┌─ INSTALAR"), "{archivo}");
        assert!(
            lineas.contains(&"$global:LASTEXITCODE = 0; winget install x"),
            "{archivo}"
        );
        assert!(archivo.contains("$wstermOk = $?  -and ($LASTEXITCODE -eq 0)"));
        assert!(archivo.contains("$global:wtActionCode = if ($wstermOk) { 0 }"));
        // La pausa espera en silencio: el pie ya dice «Pulsa Enter…».
        assert!(lineas.contains(&"$null = Read-Host"), "{archivo}");
        assert_eq!(archivo.matches("Pulsa Enter").count(), 2, "{archivo}");
        // Sin carpeta, o si no se puede escribir, todo en una línea como antes.
        let sin_dir = decorate_in("x", &aviso(), ShellKind::Powershell, false, &t(), None);
        assert!(sin_dir.starts_with("Write-Host ''; "), "{sin_dir}");
        let roto = decorate_in(
            "x",
            &aviso(),
            ShellKind::Powershell,
            false,
            &t(),
            Some(&dir.path().join("no-existe")),
        );
        assert!(roto.contains("$global:LASTEXITCODE = 0; x"), "{roto}");
    }

    /// El archivo se ejecuta en la sesión, como si se hubiera tecleado: lo que
    /// deja la orden (una variable, `$LASTEXITCODE`) sigue ahí después, y el
    /// código que lee el prompt es el de la orden, no el del cierre.
    #[cfg(windows)]
    #[test]
    fn powershell_ejecuta_el_archivo_en_la_sesion_con_el_codigo_real() {
        let dir = tempfile::tempdir().unwrap();
        let run = |command: &str| {
            let linea = decorate_in(
                command,
                &aviso(),
                ShellKind::Powershell,
                false,
                &t(),
                Some(dir.path()),
            );
            let salida = std::process::Command::new("powershell.exe")
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                ])
                .arg(format!(
                    "{linea}; Write-Output \"CODE=$wtActionCode LAST=$LASTEXITCODE VAR=$wtPrueba\""
                ))
                .output()
                .unwrap();
            String::from_utf8_lossy(&salida.stdout).to_string()
        };
        let bien = run("$wtPrueba = 'queda'; Write-Output orden-real");
        assert!(
            bien.contains("orden-real") && bien.contains("INSTALAR"),
            "{bien}"
        );
        assert!(bien.contains("CODE=0 LAST=0 VAR=queda"), "{bien}");
        let mal = run("cmd /c exit 3");
        assert!(mal.contains("CODE=3 LAST=3"), "{mal}");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_ejecuta_la_linea_y_el_cierre_sigue_el_codigo_de_salida_real() {
        let dir = tempfile::tempdir().unwrap();
        let run = |command: &str| {
            let linea = decorate_in(
                command,
                &aviso(),
                ShellKind::Cmd,
                false,
                &t(),
                Some(dir.path()),
            );
            let salida = std::process::Command::new("cmd.exe")
                .args(["/d", "/c"])
                .raw_arg(&linea)
                .env(CMD_FRAME_DIR_VAR, dir.path())
                .output()
                .unwrap();
            String::from_utf8_lossy(&salida.stdout).to_string()
        };
        use std::os::windows::process::CommandExt;
        let bien = run("echo orden-real");
        assert!(
            bien.contains("orden-real") && bien.contains("INSTALAR"),
            "{bien}"
        );
        assert!(bien.contains("[32m") && !bien.contains("[31m"), "{bien}");
        let mal = run("cmd /c exit 3");
        assert!(mal.contains("[31m") && !mal.contains("[32m"), "{mal}");
        // La marca de fin lleva el código real (el prompt de cmd no puede).
        assert!(mal.contains("\x1b]133;D;3\x07"), "{mal:?}");
        assert!(bien.contains("\x1b]133;D;0\x07"), "{bien:?}");
        // winget falla con códigos negativos: también son un fallo.
        let negativo = run("cmd /c exit -1978335212");
        assert!(
            negativo.contains("[31m") && !negativo.contains("[32m"),
            "{negativo}"
        );
        assert!(negativo.contains("]133;D;-1978335212"), "{negativo:?}");
        // `&&` ata más que `&`: la segunda parte no corre y el cierre ve el fallo.
        let compuesta = run("cmd /c exit 1 && echo no-debe-salir");
        assert!(
            !compuesta.contains("no-debe-salir") && compuesta.contains("[31m"),
            "{compuesta}"
        );
        // Tras el cierre, la sesión conserva el código de la orden y no la
        // variable de trabajo.
        let linea = decorate_in(
            "cmd /c exit 5",
            &aviso(),
            ShellKind::Cmd,
            false,
            &t(),
            Some(dir.path()),
        );
        let salida = std::process::Command::new("cmd.exe")
            .args(["/d", "/v:on", "/s", "/c"])
            .raw_arg(format!(
                "\"{linea} & echo RC=!ERRORLEVEL! VAR=[!WSTERM_RC!]\""
            ))
            .env(CMD_FRAME_DIR_VAR, dir.path())
            .output()
            .unwrap();
        let salida = String::from_utf8_lossy(&salida.stdout);
        // Una variable sin definir sale vacía o tal cual según la versión de
        // cmd; lo que no puede es seguir valiendo 5.
        assert!(
            salida.contains("RC=5 ") && !salida.contains("VAR=[5]"),
            "{salida}"
        );
    }

    /// Lo que instala una acción se ve en la misma pestaña al terminar: la
    /// sesión recoge las carpetas del PATH del registro que no tenía. Se
    /// arranca con un PATH recortado (sin `System32\wbem`, que está en el de
    /// máquina) y se comprueba que vuelve tras la acción, sin perder lo suyo.
    #[cfg(windows)]
    #[test]
    fn tras_una_accion_la_shell_ve_lo_que_se_anadio_al_path() {
        use std::os::windows::process::CommandExt;
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let wbem = format!(r"{windows}\System32\Wbem");
        let corto = format!(r"C:\wterminal-propio;{windows}\System32");
        let dir = tempfile::tempdir().unwrap();
        let cmd = decorate_in(
            "echo instalado",
            &aviso(),
            ShellKind::Cmd,
            false,
            &t(),
            Some(dir.path()),
        );
        let salida = std::process::Command::new("cmd.exe")
            .args(["/d", "/v:on", "/c"])
            .raw_arg(format!("{cmd} & echo PATH=!PATH!"))
            .env(CMD_FRAME_DIR_VAR, dir.path())
            .env("PATH", &corto)
            .output()
            .unwrap();
        let texto = String::from_utf8_lossy(&salida.stdout).to_lowercase();
        // La marca `D` del cierre va sin salto de línea (en la terminal no
        // ocupa nada), así que aquí queda delante de `PATH=` en la misma línea.
        let path = texto
            .lines()
            .find_map(|line| line.find("path=").map(|start| &line[start..]))
            .unwrap_or("");
        assert!(path.contains(&wbem.to_lowercase()), "cmd: {texto}");
        assert!(
            path.starts_with(r"path=c:\wterminal-propio;"),
            "cmd conserva lo suyo delante: {path}"
        );

        let ps = decorate_in(
            "Write-Output instalado",
            &aviso(),
            ShellKind::Powershell,
            false,
            &t(),
            None,
        );
        let salida = std::process::Command::new(format!(
            r"{windows}\System32\WindowsPowerShell\v1.0\powershell.exe"
        ))
        .args(["-NoProfile", "-Command"])
        .arg(format!("{ps}; Write-Output ('PATH=' + $env:Path)"))
        .env("PATH", &corto)
        .output()
        .unwrap();
        let texto = String::from_utf8_lossy(&salida.stdout).to_lowercase();
        let path = texto
            .lines()
            .find(|line| line.starts_with("path="))
            .unwrap_or("");
        assert!(path.contains(&wbem.to_lowercase()), "powershell: {texto}");
        assert!(
            path.starts_with(r"path=c:\wterminal-propio;"),
            "powershell conserva lo suyo delante: {path}"
        );
    }

    #[test]
    fn el_texto_del_cierre_se_traduce() {
        let ingles = decorate("x", &aviso(), ShellKind::Bash, true, &Translator::new("en"));
        assert!(!ingles.contains("Pulsa Enter"));
    }

    /// bash, zsh, sh y fish teclean solo la carga del archivo (16-11), con la
    /// ruta como la ve esa shell: `/mnt/c/…` en WSL y `/c/…` en Git Bash.
    #[test]
    fn bash_zsh_y_fish_teclean_solo_la_carga_de_un_archivo_con_toda_la_accion() {
        let dir = tempfile::tempdir().unwrap();
        let notice = Notice::new("Instalar", "Editor (VS Code) 100%", "sudo apt install x");
        for (kind, transport, verb, ext) in [
            (ShellKind::Bash, Transport::Wsl, ". ", "sh"),
            (ShellKind::Zsh, Transport::Wsl, ". ", "sh"),
            (ShellKind::Sh, Transport::Msys, ". ", "sh"),
            (ShellKind::Fish, Transport::Wsl, "source ", "fish"),
        ] {
            let linea = decorate_via(
                "sudo apt install x",
                &notice,
                kind,
                transport,
                true,
                &t(),
                Some(dir.path()),
            );
            assert!(!linea.contains('\r') && !linea.contains('\n'), "{linea}");
            assert!(
                !linea.contains("apt") && !linea.contains("printf"),
                "{linea}"
            );
            let seq: String = linea
                .rsplit("ui-")
                .next()
                .unwrap()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            let path = dir.path().join(format!("ui-{seq}.{ext}"));
            let shown = match transport {
                Transport::Wsl => crate::shell_paths::to_wsl_path(&path.to_string_lossy()),
                _ => crate::shell_paths::unix_path_for(&path.to_string_lossy(), transport),
            };
            assert_eq!(linea, format!("{verb}{}", sh_quote(&shown)), "{kind:?}");
            if cfg!(windows) {
                assert!(
                    shown.starts_with(if transport == Transport::Wsl {
                        "/mnt/"
                    } else {
                        "/"
                    }) && !shown.contains('\\'),
                    "{shown}"
                );
            }
            let archivo = std::fs::read_to_string(&path).unwrap();
            // LF y sin BOM: bash leería el `\r` como parte de cada orden.
            assert!(!archivo.contains('\r') && !archivo.starts_with('\u{feff}'));
            let lineas: Vec<&str> = archivo.lines().collect();
            assert_eq!(lineas[0], SH_ERASE_TYPED_LINE, "{kind:?}");
            assert!(lineas.contains(&"sudo apt install x"), "{archivo}");
            assert!(archivo.contains("INSTALAR") && archivo.contains("✔") && archivo.contains("✘"));
            assert!(archivo.contains("__wsterm_pause"), "{archivo}");
            // El `%` va como argumento de `printf`: no se dobla.
            assert!(
                archivo.contains("100%") && !archivo.contains("100%%"),
                "{archivo}"
            );
            // «Pulsa Enter…» sin repetir: en el pie de cada desenlace (bien y
            // mal) con una espera muda, o solo en el `read -P` de fish.
            let avisos = if kind == ShellKind::Fish { 1 } else { 2 };
            assert_eq!(archivo.matches("Pulsa Enter").count(), avisos, "{archivo}");
            if kind == ShellKind::Fish {
                assert!(archivo.contains("set __wsterm_rc $status"), "{archivo}");
            } else {
                // El prompt lee el código de la orden, no el del cierre.
                assert_eq!(lineas.last(), Some(&"(exit $__wsterm_rc)"), "{archivo}");
            }
        }
        // Sin carpeta, como antes: todo encadenado en una línea.
        let sin_dir = decorate_via(
            "x",
            &aviso(),
            ShellKind::Bash,
            Transport::Wsl,
            false,
            &t(),
            None,
        );
        assert!(sin_dir.starts_with("printf '\\n'; "), "{sin_dir}");
    }

    /// La ruta del archivo de PowerShell también se traduce: un `pwsh` dentro de
    /// WSL no entiende `C:\…`.
    #[test]
    fn powershell_dentro_de_wsl_carga_el_archivo_con_la_ruta_de_linux() {
        let dir = tempfile::tempdir().unwrap();
        let linea = decorate_via(
            "Get-Date",
            &aviso(),
            ShellKind::Powershell,
            Transport::Wsl,
            false,
            &t(),
            Some(dir.path()),
        );
        assert!(!linea.contains('\\'), "{linea}");
        if cfg!(windows) {
            assert!(linea.starts_with(". '/mnt/"), "{linea}");
        }
    }

    /// El archivo se carga en la sesión: lo que deja la orden se queda, y `$?`
    /// al volver es el de la orden. Con `sh` en Linux y macOS, y con el bash de
    /// Git en Windows si está instalado (lo está en los equipos de CI).
    #[test]
    fn bash_ejecuta_el_archivo_en_la_sesion_con_el_codigo_real() {
        let (shell, transport) = if cfg!(windows) {
            let git = std::path::PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
            if !git.exists() {
                eprintln!("sin Git Bash: no se ejecuta");
                return;
            }
            (git, Transport::Msys)
        } else {
            (std::path::PathBuf::from("sh"), Transport::Native)
        };
        let dir = tempfile::tempdir().unwrap();
        let run = |command: &str| {
            let linea = decorate_via(
                command,
                &aviso(),
                ShellKind::Bash,
                transport,
                false,
                &t(),
                Some(dir.path()),
            );
            let salida = std::process::Command::new(&shell)
                .arg("-c")
                .arg(format!("{linea}; echo \"CODE=$? VAR=$wtPrueba\""))
                .output()
                .unwrap();
            String::from_utf8_lossy(&salida.stdout).to_string()
        };
        let bien = run("wtPrueba=queda; echo orden-real");
        assert!(
            bien.contains("orden-real") && bien.contains("INSTALAR") && bien.contains("✔"),
            "{bien}"
        );
        assert!(bien.contains("CODE=0 VAR=queda"), "{bien}");
        let mal = run("(exit 3)");
        assert!(mal.contains("CODE=3") && mal.contains("✘"), "{mal}");
    }

    #[test]
    fn solo_las_shells_que_ven_la_carpeta_de_sesion_usan_archivo() {
        for transport in [Transport::Native, Transport::Msys, Transport::Wsl] {
            assert!(uses_session_files(ShellKind::Bash, transport));
        }
        for transport in [Transport::Docker, Transport::Android, Transport::Wine] {
            assert!(!uses_session_files(ShellKind::Bash, transport));
            assert!(!uses_session_files(ShellKind::Cmd, transport));
        }
        assert!(!uses_session_files(ShellKind::Repl, Transport::Native));
        assert!(!uses_session_files(ShellKind::Android, Transport::Native));
    }
}
