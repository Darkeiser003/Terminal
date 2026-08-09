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
//! `clear` posterior. Es el mismo motivo por el que el banner del sistema lo
//! imprime la shell y no la app.
//!
//! ## Colores en cmd.exe
//!
//! `echo` de cmd no interpreta secuencias de escape y no se le puede colar un
//! ESC literal en la línea: el editor de línea de la consola lo trata como
//! "borrar la línea" y se comería el comando entero. La vía que sí funciona es
//! capturar el ESC una vez con `prompt $E` y guardarlo en una variable, que es
//! lo que hace el script de inicialización de cada pestaña (ver
//! `alias_profiles::escape_capture_line`). Aquí solo se usa esa variable.

use crate::environments::ShellKind;
use crate::i18n::Translator;

/// Nombre de la variable de entorno donde las pestañas de cmd guardan el
/// carácter ESC. La define el script de inicialización.
pub const CMD_ESC_VAR: &str = "WSTERM_ESC";

/// Ancho de las reglas. 60 columnas caben en cualquier terminal que alguien use
/// de verdad, y dejan sitio de sobra para la etiqueta del verbo.
const RULE_WIDTH: usize = 60;

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
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
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
    let texto = line.text.replace('%', "%%");
    format!(
        "printf '\\033[{}m%s\\033[0m\\n' {}",
        line.tone.sgr(),
        sh_quote(&texto)
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
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>");
    format!(
        "echo %{CMD_ESC_VAR}%[{}m{texto}%{CMD_ESC_VAR}%[0m",
        line.tone.sgr()
    )
}

/// Envuelve el comando con su cabecera y su cierre, en la sintaxis de esta
/// shell. `pause` es el mensaje de "pulsa Enter"; sin él el comando termina y
/// devuelve el prompt directamente.
///
/// El cierre distingue entre bien y mal usando el código de salida REAL del
/// comando, no un mensaje fijo: decir "completado" después de que winget haya
/// fallado sería peor que no decir nada.
pub fn decorate(
    command: &str,
    notice: &Notice,
    kind: ShellKind,
    pause: bool,
    t: &Translator,
) -> String {
    let pause_text = pause.then(|| t.t("console.pause", "Pulsa Enter para volver a la terminal"));
    let header = header_lines(notice);
    let ok = footer_lines(notice, true, pause_text.as_deref(), t);
    let fail = footer_lines(notice, false, pause_text.as_deref(), t);

    match kind {
        ShellKind::Cmd => {
            let mut parts: Vec<String> = vec!["echo.".to_string()];
            parts.extend(header.iter().map(cmd_echo));
            parts.push("echo.".to_string());
            parts.push(command.to_string());
            parts.push("echo.".to_string());
            // `%ERRORLEVEL%` se expandiría al ANALIZAR la línea, o sea antes de
            // que el comando corra. `if errorlevel` sí se evalúa en su momento.
            let bien = ok.iter().map(cmd_echo).collect::<Vec<_>>().join("& ");
            let mal = fail.iter().map(cmd_echo).collect::<Vec<_>>().join("& ");
            parts.push(format!("if errorlevel 1 ({mal}) else ({bien})"));
            if pause {
                parts.push("pause >nul".to_string());
            }
            // Sin espacio antes del `&`: `echo X & echo Y` hace que echo
            // imprima "X " con el espacio pegado al final de la línea.
            parts.join("& ")
        }
        ShellKind::Powershell => {
            let mut parts: Vec<String> = vec!["Write-Host ''".to_string()];
            parts.extend(header.iter().map(powershell_echo));
            parts.push("Write-Host ''".to_string());
            parts.push(format!("$global:LASTEXITCODE = 0; {command}"));
            parts.push("$wstermOk = $?  -and ($LASTEXITCODE -eq 0)".to_string());
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
            if let Some(pause) = &pause_text {
                parts.push(format!(
                    "Read-Host '{}' | Out-Null",
                    pause.replace('\'', "''")
                ));
            }
            parts.join("; ")
        }
        ShellKind::Fish => {
            let mut parts: Vec<String> = vec!["echo".to_string()];
            parts.extend(header.iter().map(fish_echo));
            parts.push("echo".to_string());
            parts.push(command.to_string());
            parts.push("set __wsterm_rc $status".to_string());
            parts.push("echo".to_string());
            let bien = ok.iter().map(fish_echo).collect::<Vec<_>>().join("; ");
            let mal = fail.iter().map(fish_echo).collect::<Vec<_>>().join("; ");
            parts.push(format!(
                "if test $__wsterm_rc -eq 0; {bien}; else; {mal}; end"
            ));
            if let Some(pause) = &pause_text {
                parts.push(format!(
                    "read -P {} __wsterm_pause",
                    sh_quote(&format!("{pause} "))
                ));
            }
            parts.join("; ")
        }
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => {
            let mut parts: Vec<String> = vec!["printf '\\n'".to_string()];
            parts.extend(header.iter().map(posix_echo));
            parts.push("printf '\\n'".to_string());
            parts.push(command.to_string());
            parts.push("__wsterm_rc=$?".to_string());
            parts.push("printf '\\n'".to_string());
            let bien = ok.iter().map(posix_echo).collect::<Vec<_>>().join("; ");
            let mal = fail.iter().map(posix_echo).collect::<Vec<_>>().join("; ");
            parts.push(format!(
                "if [ $__wsterm_rc -eq 0 ]; then {bien}; else {mal}; fi"
            ));
            if let Some(pause) = &pause_text {
                parts.push(format!(
                    "printf {}; read __wsterm_pause",
                    sh_quote(&format!("{pause} "))
                ));
            }
            parts.join("; ")
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
        assert!(salida.contains("if errorlevel 1 ("));
        assert!(!salida.contains("%ERRORLEVEL%"));
    }

    #[test]
    fn cmd_encadena_sin_espacio_delante_del_ampersand() {
        // `echo X & echo Y` imprime "X " con el espacio pegado: echo se lleva
        // todo lo que hay hasta el separador, espacio incluido.
        let salida = decorate("x", &aviso(), ShellKind::Cmd, false, &t());
        assert!(!salida.contains("%[0m & "), "queda un espacio antes del &");
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
    }

    #[test]
    fn el_texto_del_cierre_se_traduce() {
        let ingles = decorate("x", &aviso(), ShellKind::Bash, true, &Translator::new("en"));
        assert!(!ingles.contains("Pulsa Enter"));
    }
}
