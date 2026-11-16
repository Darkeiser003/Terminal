//! La guía de WTerminal para los agentes de IA (14-11, Romen: «una especie de
//! SKILL.md, no para el usuario, sino para que las IA, sin ninguna
//! instrucción del usuario, puedan usar la terminal, las herramientas, los
//! comandos internos, ajustes, pantallas, shells y REPLs»; «que no tenga que
//! usar comandos de Windows sino los míos: Entorno y dependencias, mis
//! funciones de actualizar e instalar, ajustar la terminal, abrir pestañas»;
//! «no visible para el usuario ni un archivo en su PC: solo en el código»).
//!
//! - **Se arma desde el propio código**, para que no se quede vieja: los
//!   principios y la tabla de tareas (aquí), la ayuda interna entera
//!   ([`crate::terminal::aliases::build_help_topic_text`], las mismas
//!   secciones que `ayuda`) y cada ajuste con su explicación
//!   (`default_settings.toml`).
//! - **Llega a los agentes** sin escribir nada en disco: en el chat, un
//!   resumen oculto delante de cada pregunta ([`chat_preamble`], con
//!   `agentChatGuide`); entera, con `wterminal --agent-guide [tema]`, que la
//!   imprime y sale sin abrir ventana ([`guide`]).

use crate::i18n::Translator;
use crate::terminal::aliases::{build_help_topic_text, HelpOptions, HelpTopic};

/// El argumento que imprime la guía y sale (`wterminal --agent-guide [tema]`).
pub const AGENT_GUIDE_ARG: &str = "--agent-guide";

/// Los temas que se pueden pedir sueltos, con lo que llevan.
pub const TOPICS: &[(&str, &str)] = &[
    ("todo", "la guía entera (lo que sale sin tema)"),
    (
        "principios",
        "dónde estás y por qué usar WTerminal antes que el sistema",
    ),
    ("chat", "cómo proponer acciones desde el chat lateral"),
    ("tareas", "cada tarea habitual y cómo se hace en WTerminal"),
    ("limites", "lo que no debes hacer"),
    (
        "control",
        "cómo manejar WTerminal tú mismo (wterminal --ctl)",
    ),
    ("internos", "las órdenes internas (:shell, :panel, :set…)"),
    (
        "paquetes",
        "el vocabulario de paquetes común a todas las shells",
    ),
    (
        "sesion",
        "las órdenes de la sesión (clear, sysinfo, ayuda…)",
    ),
    ("alias", "los alias compartidos entre shells"),
    (
        "biblioteca",
        "la Biblioteca de scripts y las acciones rápidas",
    ),
    ("menus", "los paneles y menús de la aplicación"),
    ("soporte", "plataformas, shells y gestores admitidos"),
    (
        "ajustes",
        "cada ajuste, su valor de fábrica y para qué sirve",
    ),
];

const PRINCIPLES: &str = "\
# WTerminal: guía para agentes de IA

## 1. Dónde estás

Te ha lanzado WTerminal: una terminal de escritorio (WTerminal en Windows,
LTerminal en Linux) con pestañas, vista dividida, varias shells (cmd,
PowerShell, Git Bash, bash de WSL, zsh, fish), los REPL que detecta (Python,
Node, Ruby…), paneles (Entorno y dependencias, Proyectos, Biblioteca,
Explorador, Ajustes) y un chat lateral con agentes. Puedes estar:

- en el chat lateral: te llega una pregunta suelta, ejecutada en la carpeta de
  la pestaña activa; puede traer la última orden de la terminal y su salida. Lo
  que puedes tocar lo decide el modo de permisos que eligió el usuario (de
  fábrica, solo leer);
- en una pestaña de WTerminal, con tu propia pantalla.

## 2. El principio: primero WTerminal

Cuando el usuario quiera instalar, actualizar o quitar algo, cambiar de shell,
abrir un REPL, ajustar la terminal, gestionar pestañas, proyectos o scripts,
propón la función de WTerminal ANTES que una orden del sistema (winget, choco,
scoop, apt, dnf, pacman, `pip install` global, `npm -g`, setx, regedit…). Por
qué:

- **Instala en el sitio correcto.** WTerminal instala en la carpeta propia del
  usuario (`toolchainStoreDir`; de fábrica la suya, a menudo en otro disco) y
  publica las variables que hacen falta (PYTHONUSERBASE, GOPATH, CARGO_HOME…).
  Una orden suelta instala en otro sitio, y la terminal no lo ve o lo ve a
  medias: Python que no encuentra sus módulos, herramientas fuera del PATH.
- **Comprueba antes**: espacio libre, si ya está instalado, la versión, lo que
  falta (ble.sh instala antes lo que le falte a la distro).
- **Se ve y se registra**: la acción corre en una pestaña con su marco, su
  progreso y su código de salida real, y queda en el log.
- **Sabe deshacerlo**: lo que instala, lo actualiza y lo desinstala sin restos.
- **Las órdenes internas** (`:…`) cambian la terminal al momento, con la misma
  validación que Ajustes, sin tocar archivos a mano.

Usa una orden del sistema solo si WTerminal no tiene esa función (dilo) o si el
usuario la pide expresamente.
";

const CHAT: &str = "\
## 3. Cómo actuar desde el chat

- No puedes pulsar botones ni escribir en la terminal: propones y el usuario
  decide.
- Pon cada orden en un bloque de código de UNA línea. El chat ofrece «Insertar
  en la terminal», que la escribe en el prompt de la pestaña activa SIN pulsar
  Intro (solo sobre un prompt vacío). Un bloque de varias líneas solo se copia.
- Las órdenes internas empiezan por `:` y se escriben en una pestaña de
  WTerminal: las procesa la aplicación, no la shell. En tu propio proceso o en
  otra terminal no hacen nada.
- Para un panel o un botón, da el camino exacto y la orden que lo abre:
  «Entorno y dependencias › Intérpretes, compiladores y sus gestores › Python ›
  Instalar» (`:panel deps`).
- Si puedes ejecutar órdenes en tu propio proceso, úsalas para mirar
  (versiones, archivos, `git status`…); lo que cambie el equipo, propónselo al
  usuario con WTerminal.
- Contesta en el idioma del usuario y sin jerga.
";

const TASKS: &str = "\
## 4. Cada tarea, en WTerminal

| Tarea | En WTerminal | Por qué |
|---|---|---|
| Instalar un programa, lenguaje o herramienta | Entorno y dependencias (`:panel deps`): búscala y «Instalar» | carpeta propia, variables publicadas, se puede desinstalar |
| Actualizar lo instalado | Entorno y dependencias › «Aplicación y paquetes ya instalados»: «Actualizar todo con winget» o la acción de cada uno | comprueba el disco antes y enseña el progreso |
| Desinstalar | la acción «Desinstalar» de esa herramienta | sin restos y sin romper el PATH de otras copias |
| Una distro de WSL, sus herramientas, ble.sh | Entorno y dependencias › «Distribuciones Linux integradas con Windows» | instala antes lo que le falte a la distro, con su gestor |
| Una IA de la terminal (Claude Code, Codex, Gemini…) | Entorno y dependencias › «Asistentes en la terminal y modelos que se ejecutan en tu equipo» | la abre en su pestaña con su clave guardada cifrada |
| Cambiar la shell de la pestaña | `:shell list` y `:shell powershell` | solo esa pestaña, sin cerrar las demás |
| Abrir un REPL | `:repl python` (`:shell list` enseña los detectados) | con sus ajustes de ancho y su historial |
| Otra pestaña | el botón «+» o el atajo `shortcutNewTab` (Ctrl+Shift+T de fábrica) | |
| Ver varias terminales | `:panes 2` (1 a 4) | rejilla sin cerrar pestañas |
| Letra, fuente, cursor, historial | `:terminal font-size 14`, `:font list`, `:terminal list` | al momento y guardado |
| Tema o idioma | `:theme list`, `:language list` | |
| Cualquier ajuste | `:set list <texto>` y `:set <ajuste> <valor>` | misma validación que Ajustes |
| Que vea algo instalado por fuera | `:reload` | vuelve a detectar shells y herramientas |
| La carpeta actual en el explorador | `:explorer-here`; el panel Explorador (`:panel explorer`) | |
| Proyectos y GitHub (clonar, abrir, ramas) | Proyectos (`:panel projects`) | |
| Scripts del usuario y acciones rápidas (SSH, red, servicios, Docker, Kubernetes, ADB) | Biblioteca (`:panel scripts`) | |
| Paquetes del sistema con las mismas palabras en cualquier shell | los alias de paquetes (`ayuda paquetes`) | eligen el gestor de cada shell |
| Ajustes de la aplicación | Ajustes (`:panel settings`) | |
| Ayuda dentro de la terminal | `ayuda`, `ayuda <sección>`, `:help` | |
| Una IA pide su clave de API | el campo que ofrece WTerminal (en el chat, bajo el error) | se guarda cifrada para el usuario de Windows |
| «ModuleNotFoundError» en una herramienta de pip | Ajustes: la carpeta propia (`toolchainStoreDir`) y PYTHONUSERBASE | pip instaló donde Python no mira |
";

const CONTROL: &str = "\
## 5b. Manejar WTerminal tú mismo (`wterminal --ctl`)

Si WTerminal te lanzó (su chat o una de sus pestañas) y el usuario tiene
`agentControl` encendido, en vez de proponer puedes HACERLO: ejecuta el
ejecutable de WTerminal con `--ctl` y la orden. Recibes en el entorno
`WTERMINAL_CTL`, `WTERMINAL_CTL_TOKEN` y, en una pestaña, `WTERMINAL_TAB_ID`;
sin ellas no funciona (no las copies ni las enseñes).

| Orden | Qué hace | ¿Pide permiso? |
|---|---|---|
| `--ctl :panes 2`, `--ctl :panel deps`, `--ctl :theme list`, `--ctl :terminal font-size 14` | cualquier orden interna | no |
| `--ctl :shell pwsh`, `--ctl :repl python` | cambia la shell de una pestaña o abre un REPL | no |
| `--ctl :set list`, `--ctl :set <ajuste>` | enseña ajustes | no |
| `--ctl :set <ajuste> <valor>` | cambia un ajuste | sí |
| `--ctl acciones <texto>` | busca en Entorno y dependencias: id y nombre | no (solo lee) |
| `--ctl accion <id>` | lanza esa acción (instalar, actualizar, desinstalar) en una pestaña, a la vista | sí |

- Se hace en una pestaña de shell libre (la activa si lo es), escribiendo la
  orden como si la tecleara el usuario: él lo ve. Nunca en tu propia pestaña.
- Lo que pide permiso sale en un aviso con «Permitir», «Permitir en esta
  sesión» y «Denegar»; tu orden espera la respuesta (hasta 3 minutos). Si se
  deniega, no insistas: díselo al usuario.
- Nunca puedes cambiar los permisos del chat, la guía, este control ni la
  seguridad (`agentChatCanEdit`, `agentChatAllowBypass`, `agentControl`,
  `startAsAdmin`…): se rechaza siempre.
- Para instalar algo: primero `--ctl acciones <nombre>` para ver su id, luego
  `--ctl accion <id>`. No uses winget, apt ni pip a pelo.
- Responde con el código de salida 0 si se hizo y 1 si no, con el motivo.
";

const LIMITS: &str = "\
## 5. Lo que no debes hacer

- No propongas por tu cuenta encender `agentChatCanEdit` ni
  `agentChatAllowBypass`, ni nada que baje la seguridad (`startAsAdmin`,
  `terminalLinksConfirm` apagado…). Solo si el usuario lo pide, explicando el
  riesgo.
- No edites a mano los archivos de configuración de WTerminal, el registro ni
  el PATH: usa `:set`, Ajustes o la integración con el PATH de Ajustes.
- No pidas contraseñas ni claves por el chat: WTerminal tiene su campo cifrado.
- No borres datos del usuario sin que lo pida.
- Si algo de WTerminal no lo sabes, dilo y sugiere `ayuda`, `:set list` o esta
  guía; no lo inventes.
";

/// El resumen que va, oculto, delante de cada pregunta del chat
/// (`agentChatGuide`). Corto: lo paga cada pregunta.
pub fn chat_preamble() -> String {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "wterminal".to_string());
    format!(
        "[Contexto de WTerminal para el agente; el usuario no lo ve]\n\
Estás en el chat lateral de WTerminal, una terminal con pestañas, shells (cmd, PowerShell, bash, WSL…), REPLs y paneles. \
Cuando el usuario quiera instalar, actualizar o quitar algo, cambiar de shell, abrir un REPL, ajustar la terminal o gestionar pestañas, \
proponle primero la función de WTerminal y no una orden del sistema (winget, apt, pip global, npm -g, setx…): instala en su carpeta propia \
con las variables correctas, comprueba antes, enseña el progreso y sabe desinstalar. Las más útiles: `:panel deps` (Entorno y dependencias: \
instalar, actualizar, desinstalar), `:shell <nombre>`, `:repl <nombre>`, `:panes 2`, `:terminal font-size 14`, `:theme <id>`, \
`:set <ajuste> <valor>`, `:reload`, `:help`. Las órdenes que empiezan por «:» las procesa WTerminal en una de sus pestañas. \
Pon cada orden en un bloque de código de una sola línea: el usuario la inserta en su terminal, sin Intro, con un clic. \
No pidas claves ni contraseñas por aquí. Si puedes ejecutar órdenes, la guía completa (cada orden interna, panel, acción y ajuste, \
con su porqué) sale con: \"{exe}\" {AGENT_GUIDE_ARG} (temas: \"{exe}\" {AGENT_GUIDE_ARG} temas).{control}\n---\n",
        control = if crate::preferences::current().agent_control {
            format!(
                " Y puedes hacerlo tú en vez de proponerlo: \"{exe}\" {CTL} :panes 2, {CTL} :shell pwsh, {CTL} acciones python, \
{CTL} accion <id>; lo que cambie el equipo o los ajustes le pide permiso al usuario (guía: {AGENT_GUIDE_ARG} control).",
                CTL = crate::app::agent_control::CTL_ARG
            )
        } else {
            String::new()
        }
    )
}

/// La guía corta para una pestaña de IA, en UNA línea y sin `"`, `'`, `%`,
/// `&`, `|`, `<`, `>`, `^` ni `!`: va como argumento y, si la CLI es un
/// `.cmd` de npm, pasa por cmd.
pub fn tab_preamble() -> String {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "wterminal".to_string());
    let control = if crate::preferences::current().agent_control {
        format!(
            " Puedes manejar WTerminal tú mismo con {exe} --ctl ORDEN (por ejemplo --ctl :panes 2, --ctl :shell pwsh, --ctl acciones python, --ctl accion ID): lo que cambie el equipo o los ajustes le pedirá permiso al usuario en WTerminal."
        )
    } else {
        String::new()
    };
    let text = format!(
        "Contexto de WTerminal, te lo pasa la terminal y no el usuario: estás en una pestaña de WTerminal, una terminal con pestañas, shells, REPLs y paneles. \
Para instalar, actualizar o quitar programas, cambiar de shell, abrir un REPL o una pestaña y ajustar la terminal, usa WTerminal antes que winget, apt, pip global o setx: \
instala en la carpeta propia del usuario con las variables correctas, comprueba antes, enseña el progreso y sabe desinstalar.{control} \
La guía completa, con cada orden interna, panel, acción y ajuste y su porqué, sale con {exe} {AGENT_GUIDE_ARG} (temas: {AGENT_GUIDE_ARG} temas). No pidas claves ni contraseñas."
    );
    text.chars()
        .filter(|c| {
            !matches!(
                c,
                '"' | '\'' | '%' | '&' | '|' | '<' | '>' | '^' | '!' | '\n' | '\r'
            )
        })
        .collect()
}

/// Lo que se añade al abrir la pestaña de una IA para darle la guía, una vez
/// al empezar la sesión (`agentTabGuide`, 14-11): Claude Code y Codex como
/// instrucciones de arranque (no salen en la conversación); Gemini y Qwen solo
/// leen instrucciones de archivos, así que va como su primer mensaje (`-i`:
/// lo manda y sigue en su pantalla).
pub fn tab_args(env_id: &str) -> Vec<String> {
    if !crate::preferences::current().agent_tab_guide {
        return Vec::new();
    }
    tab_args_for(env_id, &tab_preamble())
}

fn tab_args_for(env_id: &str, text: &str) -> Vec<String> {
    match env_id.strip_prefix("ai:") {
        Some("claude") => vec!["--append-system-prompt".to_string(), text.to_string()],
        // Cadena literal de TOML entre comillas simples: sin escapes.
        Some("codex") => vec!["-c".to_string(), format!("developer_instructions='{text}'")],
        Some("gemini") | Some("qwen") => vec![
            "-i".to_string(),
            format!(
                "{text} Ahora contesta solo con la palabra Listo y espera la pregunta del usuario."
            ),
        ],
        _ => Vec::new(),
    }
}

/// La guía entera o un tema. `Err` con la lista si el tema no existe.
pub fn guide(topic: Option<&str>) -> Result<String, String> {
    let topic = topic
        .map(|topic| topic.trim().to_lowercase())
        .filter(|topic| !topic.is_empty());
    let topic = topic.as_deref().unwrap_or("todo");
    let help = |section: HelpTopic| help_section(section);
    let text = match topic {
        "temas" | "topics" => topics_list(),
        "principios" => PRINCIPLES.to_string(),
        "chat" => CHAT.to_string(),
        "tareas" => TASKS.to_string(),
        "limites" | "límites" => LIMITS.to_string(),
        "control" => CONTROL.to_string(),
        "internos" => help(HelpTopic::Internal),
        "paquetes" => help(HelpTopic::Packages),
        "sesion" | "sesión" => help(HelpTopic::Session),
        "alias" => help(HelpTopic::Aliases),
        "biblioteca" => help(HelpTopic::Library),
        "menus" | "menús" => help(HelpTopic::Menus),
        "soporte" => help(HelpTopic::Support),
        "ajustes" => settings_section(),
        "todo" => [
            PRINCIPLES.to_string(),
            CHAT.to_string(),
            TASKS.to_string(),
            LIMITS.to_string(),
            CONTROL.to_string(),
            "## 6. La ayuda interna (lo mismo que `ayuda` en una pestaña)\n".to_string(),
            help(HelpTopic::Internal),
            help(HelpTopic::Packages),
            help(HelpTopic::Session),
            help(HelpTopic::Aliases),
            help(HelpTopic::Library),
            help(HelpTopic::Menus),
            help(HelpTopic::Support),
            settings_section(),
        ]
        .join("\n"),
        other => return Err(format!("Tema desconocido: {other}.\n{}", topics_list())),
    };
    Ok(text)
}

fn topics_list() -> String {
    let mut text = String::from("Temas de la guía (wterminal --agent-guide <tema>):\n");
    for (name, what) in TOPICS {
        text.push_str(&format!("  {name:<12} {what}\n"));
    }
    text
}

/// Una sección de la ayuda interna, sin colores ni la cabecera de la sesión.
fn help_section(topic: HelpTopic) -> String {
    let translator = Translator::new("es");
    let options = HelpOptions {
        app_name: "WTerminal",
        env_label: "la pestaña",
        manager_label: None,
        has_nsudo: false,
        script_names: &[],
    };
    let text = strip_ansi(&build_help_topic_text(&translator, &options, topic));
    // Sin la cabecera («WTerminal · comandos…», «Sección: …») ni el pie
    // («Uso de esta ayuda»): aquí sobran.
    let body: Vec<&str> = text
        .lines()
        .skip_while(|line| !line.trim_start().starts_with('>'))
        .take_while(|line| !line.starts_with("Uso de esta ayuda"))
        .collect();
    format!("{}\n", body.join("\n").trim_end())
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Cada ajuste de `default_settings.toml` con su valor de fábrica y el
/// comentario que lo explica.
fn settings_section() -> String {
    let mut text = String::from(
        "## 7. Ajustes (cámbialos con `:set <ajuste> <valor>` o en Ajustes)\n\n\
Valor de fábrica entre paréntesis. Los atajos (`shortcut…`) vacíos no tienen tecla de fábrica.\n\n",
    );
    let mut comment: Vec<String> = Vec::new();
    for line in crate::preferences::default_settings_text().lines() {
        let line = line.trim();
        if line.is_empty() {
            comment.clear();
            continue;
        }
        if let Some(rest) = line.strip_prefix('#') {
            comment.push(rest.trim().to_string());
            continue;
        }
        if line.starts_with('[') {
            comment.clear();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let explanation = comment.join(" ");
        if explanation.is_empty() {
            text.push_str(&format!("- `{}` ({})\n", key.trim(), value.trim()));
        } else {
            text.push_str(&format!(
                "- `{}` ({}): {explanation}\n",
                key.trim(),
                value.trim()
            ));
        }
        comment.clear();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_guia_entera_lleva_principios_tareas_ordenes_internas_y_ajustes() {
        let text = guide(None).unwrap();
        for needed in [
            "## 2. El principio: primero WTerminal",
            "## 4. Cada tarea, en WTerminal",
            ":panel",
            ":shell",
            ":set",
            "Entorno y dependencias",
            "- `agentChatCanEdit` (false)",
            "- `shortcutNewTab` (\"Ctrl+Shift+T\")",
        ] {
            assert!(text.contains(needed), "falta «{needed}»");
        }
        // Sin colores de la ayuda de la terminal.
        assert!(!text.contains('\x1b'));
    }

    #[test]
    fn cada_tema_sale_suelto_y_uno_desconocido_lista_los_temas() {
        for (name, _) in TOPICS {
            let text = guide(Some(name)).unwrap();
            assert!(!text.trim().is_empty(), "{name} vacío");
        }
        assert!(guide(Some("internos")).unwrap().contains(":set"));
        let error = guide(Some("nada")).unwrap_err();
        assert!(error.contains("principios") && error.contains("ajustes"));
    }

    #[test]
    fn todos_los_ajustes_de_fabrica_salen_con_su_explicacion() {
        let text = settings_section();
        let keys = crate::preferences::default_settings_text()
            .lines()
            .filter(|line| {
                let line = line.trim();
                !line.starts_with('#') && !line.starts_with('[') && line.contains('=')
            })
            .count();
        assert_eq!(text.matches("\n- `").count(), keys, "un ajuste por línea");
        // El comentario de encima va con su ajuste.
        assert!(text.contains("- `clearReprintBanner` (true): `clear`/`cls` vuelve a mostrar"));
    }

    #[test]
    fn la_guia_de_las_pestanas_va_en_una_linea_sin_lo_que_cmd_interpretaria() {
        let text = tab_preamble();
        assert!(!text.contains(['"', '\'', '%', '&', '|', '<', '>', '^', '!', '\n']));
        assert!(text.contains(AGENT_GUIDE_ARG));
        assert_eq!(
            tab_args_for("ai:claude", "x"),
            vec!["--append-system-prompt".to_string(), "x".to_string()]
        );
        assert_eq!(
            tab_args_for("ai:codex", "x"),
            vec!["-c".to_string(), "developer_instructions='x'".to_string()]
        );
        assert_eq!(tab_args_for("ai:gemini", "x")[0], "-i");
        assert!(tab_args_for("ai:qwen", "x")[1].ends_with("espera la pregunta del usuario."));
        // Las demás no tienen por dónde: nada.
        assert!(tab_args_for("ai:llm", "x").is_empty());
        assert!(tab_args_for("cmd", "x").is_empty());
    }

    #[test]
    fn el_resumen_del_chat_es_corto_y_dice_como_pedir_la_guia() {
        let preamble = chat_preamble();
        assert!(preamble.contains(AGENT_GUIDE_ARG) && preamble.contains(":panel deps"));
        assert!(preamble.ends_with("\n---\n"));
        // Lo paga cada pregunta.
        assert!(
            preamble.chars().count() < 2_400,
            "{}",
            preamble.chars().count()
        );
    }
}
