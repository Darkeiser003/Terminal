//! Chat lateral con los agentes de IA (12-11, idea de Romen): preguntar a una
//! IA del equipo desde una barra al lado de la terminal, sin entrar en su CLI.
//!
//! Cada pregunta abre la CLI del agente UNA vez en su modo no interactivo
//! (`claude -p`, `codex exec -`, `ollama run <modelo>`…):
//!
//! - **La pregunta va por la entrada estándar,** nunca como argumento. Así
//!   ninguna shell ni ningún `.cmd` la interpreta, aunque lleve `&`, `|`,
//!   `%` o saltos de línea.
//! - **La respuesta llega por la salida estándar,** a trozos, con los eventos
//!   `agent-chat-data` y `agent-chat-done`; mientras tanto, `agent-chat-status`
//!   avisa de cada reintento por saturación y del modelo, si la CLI lo dice.
//! - **Lo que nunca hace:** ejecutar nada en la terminal. El panel solo ofrece
//!   «Insertar en la terminal» (sin Intro) o «Copiar».
//! - **El log** apunta el agente y el largo de la pregunta, no su texto.
//!
//! Las IA que solo trabajan en su pantalla interactiva (Amp…) o que editan
//! archivos sin preguntar (aider) no se ofrecen.
//!
//! 13-11 (Romen: «esto es muy cutre, desarróllalo más»):
//!
//! - **Modelo e intensidad** por agente, con la opción que entiende cada CLI
//!   (`--model`/`--effort` en Claude Code, `-m` y
//!   `-c model_reasoning_effort=…` en Codex, `-m` en las demás). Lo elegido
//!   se valida: solo letras, números y `. _ : / @ -`, porque las CLI de npm en
//!   Windows pasan por un `.cmd`.
//! - **Adjuntos de texto** (`agent_chat_read_attachment`): el archivo que el
//!   usuario elige se lee aquí, con tope, y su texto va dentro de la pregunta.
//! - **Gemini CLI** salió y volvió el mismo día: su `UNSUPPORTED_CLIENT` era
//!   de la cuenta, y con `GEMINI_API_KEY` contesta.
//!
//! 14-11 (Romen, con el menú de Claude: «claude tiene ultracode… los permisos
//! tmb»):
//!
//! - **Modos de permisos** por agente ([`Mode`]): Manual, Plan, Aceptar
//!   ediciones, Auto y Omitir permisos, con la opción de cada CLI. Lo que
//!   edita pide `agentChatCanEdit`; omitir permisos, además
//!   `agentChatAllowBypass`. El de fábrica siempre solo lee.
//! - **Ultracode** (`--effort ultracode`, Claude Code), con 30 minutos de
//!   plazo, y **modo rápido** ([`Fast`]: Claude Code y Codex).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use crate::stream::Utf8Decoder;

/// Cómo se pasa la intensidad (el esfuerzo de razonamiento) a una CLI.
#[derive(Clone, Copy)]
enum EffortStyle {
    /// Una opción con el nivel detrás: `--effort high`.
    Flag(&'static str),
    /// Codex: `-c model_reasoning_effort=high` (configuración por orden).
    CodexConfig,
}

#[derive(Clone, Copy)]
struct Effort {
    style: EffortStyle,
    levels: &'static [&'static str],
}

/// Un modo de permisos (14-11, Romen con el menú de Claude: «los permisos
/// tmb»): `plan`, `manual`, `acceptEdits`, `auto` o `bypass`, con las
/// opciones que lo piden en esa CLI.
#[derive(Clone, Copy)]
struct Mode {
    id: &'static str,
    args: &'static [&'static str],
}

const fn mode(id: &'static str, args: &'static [&'static str]) -> Mode {
    Mode { id, args }
}

/// Los modos que cambian archivos: solo con `agentChatCanEdit`. «Omitir
/// permisos» pide además `agentChatAllowBypass`.
pub fn mode_edits(id: &str) -> bool {
    matches!(id, "acceptEdits" | "auto" | "bypass")
}

/// Cómo se pide el modo rápido (14-11: el del mismo menú de Claude).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fast {
    /// Claude Code: `--settings` con `{"fastMode": true}`, en un archivo
    /// para no pasar comillas por ningún `.cmd` ([`claude_fast_settings`]).
    ClaudeSettings,
    /// Codex: `-c service_tier=fast` (su «Fast», `service_tiers` del
    /// catálogo).
    CodexTier,
}

/// Lo elegido en el panel para una pregunta.
#[derive(Clone, Copy, Default)]
pub struct Choice<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub mode: Option<&'a str>,
    pub fast: bool,
}

/// Lo que dejan los ajustes: editar (`agentChatCanEdit`) y omitir permisos
/// (`agentChatAllowBypass`).
#[derive(Clone, Copy, Default)]
pub struct Allowed {
    pub edit: bool,
    pub bypass: bool,
}

impl Allowed {
    fn current() -> Self {
        let preferences = crate::preferences::current();
        Self {
            edit: preferences.agent_chat_can_edit,
            bypass: preferences.agent_chat_allow_bypass,
        }
    }
}

/// Cómo se pregunta una vez a cada CLI. Los argumentos son fijos: lo que
/// escribe el usuario va por la entrada estándar. `head` va antes de las
/// opciones de modelo e intensidad y `tail` detrás (en Codex, el `-` que
/// dice «la pregunta llega por la entrada» tiene que ir al final).
struct OneShot {
    ai: &'static str,
    head: &'static [&'static str],
    /// Tras `head`: los modos de permisos que admite, en el orden del panel.
    /// El primero es el de fábrica y nunca cambia archivos. Vacío en los que
    /// solo contestan texto.
    modes: &'static [Mode],
    tail: &'static [&'static str],
    /// `None`: la pregunta va por la entrada estándar. `Some(opción)`: la CLI
    /// solo la acepta como argumento; entonces se lanza su script de node
    /// directamente, nunca su `.cmd`, para que cmd no interprete nada de lo
    /// escrito ([`direct_launcher`]).
    prompt_flag: Option<&'static str>,
    /// La opción que elige el modelo, si la CLI la tiene.
    model_flag: Option<&'static str>,
    /// Alias que se sugieren en el desplegable; se puede escribir otro.
    models: &'static [&'static str],
    effort: Option<Effort>,
    fast: Option<Fast>,
}

/// Lo que cabe como argumento en una orden de Windows (32 767 caracteres en
/// total), con margen para la ruta y las opciones.
const MAX_ARG_PROMPT_CHARS: usize = 30_000;

/// Las intensidades que conoce Codex (`model_reasoning_effort`), de su
/// catálogo del 14-11: cada modelo admite una parte.
const CODEX_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];

const ONE_SHOT: &[OneShot] = &[
    OneShot {
        // GitHub Copilot CLI (13-11, Romen: «es muy mítica»). Exige
        // `--allow-all-tools` en este modo, pero «las reglas de denegar mandan
        // siempre, incluso sobre --allow-all-tools» (`copilot help
        // permissions`): sin la shell nunca, y sin escribir salvo con
        // `agentChatCanEdit`.
        ai: "copilot",
        head: &["--allow-all-tools", "--silent"],
        modes: &[
            mode("manual", &["--deny-tool", "shell", "--deny-tool", "write"]),
            mode("acceptEdits", &["--deny-tool", "shell"]),
            mode("bypass", &[]),
        ],
        tail: &[],
        prompt_flag: Some("-p"),
        model_flag: Some("--model"),
        models: &["auto"],
        effort: Some(Effort {
            style: EffortStyle::Flag("--reasoning-effort"),
            levels: &["low", "medium", "high"],
        }),
        fast: None,
    },
    OneShot {
        ai: "claude",
        head: &["-p"],
        // Con `-p` lo que pide permiso se le niega: de fábrica no edita.
        modes: &[
            mode("manual", &[]),
            mode("plan", &["--permission-mode", "plan"]),
            mode("acceptEdits", &["--permission-mode", "acceptEdits"]),
            mode("auto", &["--permission-mode", "auto"]),
            mode("bypass", &["--dangerously-skip-permissions"]),
        ],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("--model"),
        // Los alias que da `claude --help` («the latest model»).
        models: &["fable", "opus", "sonnet"],
        // `ultracode` (14-11): «Ultracode is on from --effort ultracode»;
        // reparte el trabajo en varios agentes y tiene más plazo.
        effort: Some(Effort {
            style: EffortStyle::Flag("--effort"),
            levels: &["low", "medium", "high", "xhigh", "max", "ultracode"],
        }),
        fast: Some(Fast::ClaudeSettings),
    },
    OneShot {
        ai: "qwen",
        head: &[],
        // `plan`: analiza y contesta, sin tocar archivos ni ejecutar nada.
        modes: &[
            mode("plan", &["--approval-mode", "plan"]),
            mode("acceptEdits", &["--approval-mode", "auto-edit"]),
            mode("auto", &["--approval-mode", "auto"]),
            mode("bypass", &["--approval-mode", "yolo"]),
        ],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("-m"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        // Vuelve el 13-11: con la pregunta por la entrada estándar funciona
        // (es el mismo código que Qwen). Su `UNSUPPORTED_CLIENT` era de la
        // cuenta: con `GEMINI_API_KEY` sí contesta, y el chat la ofrece.
        // `--skip-trust` (14-11, captura de Romen): en una carpeta que no
        // conoce, Gemini pasa a «default» y sin pantalla se niega («not
        // running in a trusted directory»). Confía en la carpeta de la
        // pestaña solo para esa pregunta, como hace Claude Code con `-p`.
        ai: "gemini",
        head: &["--skip-trust"],
        modes: &[
            mode("plan", &["--approval-mode", "plan"]),
            mode("acceptEdits", &["--approval-mode", "auto_edit"]),
            mode("bypass", &["--approval-mode", "yolo"]),
        ],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("-m"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        // `crush run`: «el prompt puede ir en argumentos o por la entrada
        // estándar». Sin `--yolo` no acepta permisos por su cuenta, y `run`
        // no tiene `--yolo` (14-11): no se le ofrecen modos.
        ai: "crush",
        head: &["run", "--quiet"],
        modes: &[],
        tail: &[],
        prompt_flag: None,
        // «-m --model: Model to use» (`crush run --help`, 14-11).
        model_flag: Some("-m"),
        models: &[],
        effort: Some(Effort {
            style: EffortStyle::Flag("--reasoning-effort"),
            levels: &["low", "medium", "high"],
        }),
        fast: None,
    },
    OneShot {
        ai: "codex",
        // Fuera de un repositorio git se negaba («Not inside a trusted
        // directory», 13-11).
        head: &["exec", "--skip-git-repo-check", "--color", "never"],
        // `--approve-for-me`: «Route approval requests through automatic
        // review using the workspace-write sandbox» (`codex exec --help`).
        modes: &[
            mode("manual", &["-s", "read-only"]),
            mode("acceptEdits", &["-s", "workspace-write"]),
            mode("auto", &["--approve-for-me"]),
            mode("bypass", &["--dangerously-bypass-approvals-and-sandbox"]),
        ],
        tail: &["-"],
        prompt_flag: None,
        model_flag: Some("-m"),
        models: &[],
        // Los niveles que nombra su catálogo (`codex debug models`); cada
        // modelo admite los suyos, y el panel enseña solo esos.
        effort: Some(Effort {
            style: EffortStyle::CodexConfig,
            levels: CODEX_EFFORTS,
        }),
        fast: Some(Fast::CodexTier),
    },
    OneShot {
        ai: "llm",
        head: &[],
        modes: &[],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("-m"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        ai: "sgpt",
        head: &[],
        modes: &[],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("--model"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        ai: "mods",
        head: &[],
        modes: &[],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("-m"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        ai: "aichat",
        head: &[],
        modes: &[],
        tail: &[],
        prompt_flag: None,
        model_flag: Some("-m"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        // Grok CLI (14-11, Romen: «sale como REPL pero no en la barra
        // lateral»). En su modo de una pregunta (`-p`) aprueba él solo todas
        // sus operaciones (`allOperations`: órdenes y cambios de archivos) y
        // no puede quedarse en solo leer (`--max-tool-rounds 0` vale 400):
        // su único modo es «Omitir permisos», con sus dos ajustes. Contesta
        // con un mensaje JSON por línea ([`grok_answer_line`]). La pregunta
        // solo la acepta como argumento: node directo, nunca su `.cmd`.
        ai: "grok",
        head: &[],
        modes: &[mode("bypass", &[])],
        tail: &[],
        prompt_flag: Some("-p"),
        model_flag: Some("-m"),
        models: &["grok-code-fast-1", "grok-4-latest"],
        effort: None,
        fast: None,
    },
    OneShot {
        // Continue CLI (14-11): `cn -p` contesta y sale; `--readonly` es su
        // modo plan (solo herramientas de leer) y `--auto` lo permite todo.
        // `--silent` quita las etiquetas <think>. La pregunta va como
        // argumento: node directo, nunca su `.cmd`.
        ai: "continue",
        head: &["--silent"],
        modes: &[mode("plan", &["--readonly"]), mode("bypass", &["--auto"])],
        tail: &[],
        prompt_flag: Some("-p"),
        model_flag: Some("--model"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        // opencode (14-11): `opencode run <pregunta>`. Su agente `plan` no
        // edita ni ejecuta sin permiso; `--auto` aprueba todo lo que no esté
        // prohibido. La pregunta va sola detrás (`PROMPT_POSITIONAL`).
        ai: "opencode",
        head: &["run"],
        modes: &[
            mode("plan", &["--agent", "plan"]),
            mode("bypass", &["--auto"]),
        ],
        tail: &[],
        prompt_flag: Some(PROMPT_POSITIONAL),
        model_flag: Some("-m"),
        models: &[],
        effort: None,
        fast: None,
    },
    OneShot {
        // Amp (14-11): `amp -x` lee la pregunta por la entrada estándar y
        // escribe solo su última respuesta. Edita archivos sin preguntar y
        // deniega las órdenes que no tenga permitidas: su único modo es
        // «Aceptar ediciones», con `agentChatCanEdit`. No elige modelo
        // (`-m` es su modo de agente, no el modelo).
        ai: "amp",
        head: &["-x"],
        modes: &[mode("acceptEdits", &[])],
        tail: &[],
        prompt_flag: None,
        model_flag: None,
        models: &[],
        effort: None,
        fast: None,
    },
];

/// `prompt_flag` para una CLI que recibe la pregunta sola, detrás de sus
/// opciones y sin opción delante (`opencode run <pregunta>`).
const PROMPT_POSITIONAL: &str = "";

fn spec_for(env_id: &str) -> Option<&'static OneShot> {
    let ai = env_id.strip_prefix("ai:")?;
    ONE_SHOT.iter().find(|spec| spec.ai == ai)
}

/// Un nombre de modelo que se puede pasar como argumento sin que ningún
/// `.cmd` lo interprete: letras, números y `. _ : / @ -`, hasta 80.
pub fn valid_model(model: &str) -> bool {
    let mut chars = model.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && model.chars().count() <= 80
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@-".contains(c))
}

/// El modo de un agente si no se elige ninguno: con `agentChatCanEdit`,
/// «Aceptar ediciones» si lo tiene; si no, el primero, que solo lee.
fn default_mode(spec: &OneShot, can_edit: bool) -> Option<&'static Mode> {
    let modes: &'static [Mode] = spec.modes;
    can_edit
        .then(|| modes.iter().find(|mode| mode.id == "acceptEdits"))
        .flatten()
        .or_else(|| modes.first())
}

/// El archivo de ajustes que pide a Claude Code el modo rápido. Va en un
/// archivo y no como texto en la orden: así ninguna comilla pasa por un
/// `.cmd`. Se escribe antes de cada pregunta ([`write_claude_fast_settings`]).
fn claude_fast_settings() -> PathBuf {
    std::env::temp_dir().join("wterminal-claude-fast.json")
}

fn write_claude_fast_settings() -> Result<(), String> {
    std::fs::write(claude_fast_settings(), "{\"fastMode\": true}\n")
        .map_err(|error| format!("fast-settings: {error}"))
}

/// Los argumentos de una pregunta con lo elegido en el panel (modelo,
/// intensidad, modo de permisos y modo rápido) y lo que dejan los ajustes.
/// `Err` si lo elegido no vale para ese agente o no está permitido (nunca se
/// ignora en silencio).
fn one_shot_args_with(
    env_id: &str,
    env_args: &[String],
    choice: Choice<'_>,
    allowed: Allowed,
) -> Result<Vec<String>, &'static str> {
    let model = choice
        .model
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let effort = choice
        .effort
        .map(str::trim)
        .filter(|effort| !effort.is_empty());
    let chosen_mode = choice.mode.map(str::trim).filter(|mode| !mode.is_empty());
    let ai = env_id.strip_prefix("ai:").ok_or("unsupported-agent")?;
    if ai.starts_with("ollama:") {
        // `ollama run <modelo>`: el modelo ES el agente; sin más opciones.
        if model.is_some() || effort.is_some() || chosen_mode.is_some() || choice.fast {
            return Err("unsupported-option");
        }
        return Ok(env_args.to_vec());
    }
    let spec = spec_for(env_id).ok_or("unsupported-agent")?;
    let mut args: Vec<String> = spec.head.iter().map(|arg| arg.to_string()).collect();
    let mode = match chosen_mode {
        Some(id) => Some(
            spec.modes
                .iter()
                .find(|mode| mode.id == id)
                .ok_or("unsupported-mode")?,
        ),
        None => default_mode(spec, allowed.edit),
    };
    // Lo que edita pide su ajuste, también si es el único modo del agente
    // (Grok): nunca se lanza sin permiso porque no se haya elegido nada.
    if let Some(mode) = mode {
        if mode_edits(mode.id) && !allowed.edit {
            return Err("mode-needs-edit");
        }
        if mode.id == "bypass" && !allowed.bypass {
            return Err("mode-needs-bypass");
        }
        args.extend(mode.args.iter().map(|arg| arg.to_string()));
    }
    if let Some(model) = model {
        let flag = spec.model_flag.ok_or("unsupported-option")?;
        if !valid_model(model) {
            return Err("invalid-model");
        }
        args.push(flag.to_string());
        args.push(model.to_string());
    }
    if let Some(level) = effort {
        let spec_effort = spec.effort.ok_or("unsupported-option")?;
        if !spec_effort.levels.contains(&level) {
            return Err("invalid-effort");
        }
        match spec_effort.style {
            EffortStyle::Flag(flag) => {
                args.push(flag.to_string());
                args.push(level.to_string());
            }
            EffortStyle::CodexConfig => {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort={level}"));
            }
        }
    }
    if choice.fast {
        match spec.fast.ok_or("unsupported-option")? {
            Fast::ClaudeSettings => {
                args.push("--settings".to_string());
                args.push(claude_fast_settings().to_string_lossy().to_string());
            }
            Fast::CodexTier => {
                args.push("-c".to_string());
                args.push("service_tier=fast".to_string());
            }
        }
    }
    args.extend(spec.tail.iter().map(|arg| arg.to_string()));
    Ok(args)
}

/// Una pregunta con el contexto de la terminal y unos adjuntos de texto cabe
/// de sobra (13-11: subió de 100 000 al llegar los adjuntos).
const MAX_PROMPT_CHARS: usize = 400_000;
/// Lo que se lee de un adjunto: más se corta y se avisa.
const MAX_ATTACHMENT_BYTES: usize = 100 * 1024;
/// Un archivo mayor ni se abre: no es texto para una pregunta.
const MAX_ATTACHMENT_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Lo más que se espera una respuesta: pasado esto, se corta.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);
/// Con Ultracode, Claude Code reparte el trabajo en varios agentes: más plazo.
const ULTRACODE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn answer_timeout(effort: Option<&str>) -> Duration {
    if effort.map(str::trim) == Some("ultracode") {
        ULTRACODE_TIMEOUT
    } else {
        ANSWER_TIMEOUT
    }
}
/// Lo que se guarda de la salida de error para explicar un fallo.
const MAX_ERROR_CHARS: usize = 4_000;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(0);
static RUNNING: Lazy<Mutex<HashMap<u64, Arc<Mutex<Child>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// Las que cortó el plazo, para decir «timeout» y no «falló».
static TIMED_OUT: Lazy<Mutex<std::collections::HashSet<u64>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));
/// Las que se cortaron porque el servicio seguía saturado o sin cupo tras
/// varios reintentos, con el código HTTP (503, 429…). Ver [`RetryWatch`].
static GAVE_UP: Lazy<Mutex<HashMap<u64, u16>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Cuántos reintentos por saturación o cupo se esperan antes de cortar.
const MAX_BUSY_RETRIES: u32 = 3;

/// Vigila la salida de error buscando los reintentos silenciosos de Gemini CLI
/// y Qwen Code: «Attempt 2 failed with status 503. Retrying with backoff...».
/// Con el modelo saturado (503) o sin cupo (429) reintentan hasta 10 veces,
/// con esperas de hasta 30 s, sin decir nada por la salida normal: el chat se
/// quedaba 5 minutos callado y acababa en «tardó demasiado» (15-11, Romen:
/// «Gemini no avanza»; Gemini 3 Pro daba 503 por demanda).
///
/// Cada reintento se avisa al panel en cuanto se ve, no solo al rendirse
/// (16-11): «Modelo saturado (error 503). Reintentando… (1 de 3)». Y si la
/// CLI dice qué modelo usa (Codex escribe `model: gpt-5-codex` al empezar),
/// también, para enseñar qué modelo contestó.
#[derive(Default)]
struct RetryWatch {
    line: String,
    busy: u32,
    model_seen: bool,
}

/// Lo que se ve en la salida de error mientras contesta.
#[derive(Debug, PartialEq)]
enum StderrEvent {
    /// Un reintento por saturación o cupo: cuántos van y con qué código.
    Retrying { attempt: u32, status: u16 },
    /// Ya van [`MAX_BUSY_RETRIES`]: hay que cortar.
    GaveUp(u16),
    /// El modelo que dice estar usando.
    Model(String),
}

impl RetryWatch {
    /// Lo visto en las líneas completas de este trozo, en orden.
    fn push(&mut self, text: &str) -> Vec<StderrEvent> {
        self.line.push_str(text);
        let mut events = Vec::new();
        while let Some(end) = self.line.find('\n') {
            let line: String = self.line.drain(..=end).collect();
            if let Some(status) = busy_retry_status(&line) {
                self.busy += 1;
                events.push(if self.busy >= MAX_BUSY_RETRIES {
                    StderrEvent::GaveUp(status)
                } else {
                    StderrEvent::Retrying {
                        attempt: self.busy,
                        status,
                    }
                });
            } else if !self.model_seen {
                if let Some(model) = reported_model(&line) {
                    self.model_seen = true;
                    events.push(StderrEvent::Model(model));
                }
            }
        }
        // Una línea sin fin no crece sin límite (una traza enorme).
        if self.line.len() > 8_192 {
            self.line.clear();
        }
        events
    }
}

/// El modelo de una línea `model: <nombre>` (la cabecera de `codex exec`).
/// Solo la línea entera: un `"model": "…"` dentro de un JSON de error no
/// cuenta, ni un nombre con caracteres que no son de modelo.
fn reported_model(line: &str) -> Option<String> {
    let line = crate::current_dir::strip_ansi(line);
    let value = line.trim().strip_prefix("model:")?.trim();
    valid_model(value).then(|| value.to_string())
}

/// El código de «Attempt N failed with status 503» si es de saturación o de
/// cupo (429, 503, 529).
fn busy_retry_status(line: &str) -> Option<u16> {
    let rest = line.trim_start().strip_prefix("Attempt ")?;
    let rest = &rest[rest.find(" failed with status ")? + " failed with status ".len()..];
    let status: u16 = rest
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()?;
    matches!(status, 429 | 503 | 529).then_some(status)
}

pub fn validate_prompt(prompt: &str) -> Result<&str, &'static str> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("empty");
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("too-long");
    }
    Ok(prompt)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAgent {
    pub id: String,
    pub label: String,
    /// Se le puede preguntar desde el chat.
    pub chat: bool,
    /// Si no: `args-only`, `edits-files`, `needs-permissions` o
    /// `no-one-shot` ([`unavailable_reason`]), `needs-cmd` si su lanzador
    /// solo funciona a través de cmd ([`direct_launcher`]) o `needs-config`
    /// si le falta su configuración ([`needs_config`]).
    pub unavailable: Option<&'static str>,
    /// Si se le puede elegir modelo y cuáles se sugieren.
    pub model_choice: bool,
    pub models: Vec<String>,
    /// Niveles de intensidad que admite (vacío: no tiene).
    pub efforts: Vec<String>,
    /// Modos de permisos que admite, en orden (vacío: solo contesta texto).
    pub modes: Vec<String>,
    /// Tiene modo rápido (Claude Code y Codex).
    pub fast: bool,
}

/// Un adjunto leído (`agent_chat_read_attachment`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub name: String,
    pub bytes: u64,
    pub text: String,
    /// Se leyó solo el principio (`MAX_ATTACHMENT_BYTES`).
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatChunk {
    request_id: u64,
    text: String,
}

/// `agent-chat-status`: lo que se sabe de una respuesta mientras llega
/// (16-11). Va aparte de los trozos de texto para no mezclarse con ellos.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStatus {
    request_id: u64,
    /// Un reintento por saturación o cupo en curso.
    retry: Option<ChatRetry>,
    /// El modelo que dice estar usando la CLI.
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatRetry {
    attempt: u32,
    /// A cuántos se corta ([`MAX_BUSY_RETRIES`]).
    max: u32,
    status: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDone {
    request_id: u64,
    code: Option<i32>,
    /// `timeout`, `cancelled`, `busy:<código>` (saturado o sin cupo tras
    /// varios reintentos) o el final de la salida de error si acabó mal.
    error: Option<String>,
    /// La salida de error, si escribió algo, aunque haya acabado bien.
    detail: Option<String>,
}

/// Por qué una IA instalada no entra en el chat. El panel la enseña
/// desactivada, con este motivo y un botón para abrirla en su pestaña (13-11:
/// Romen veía menos IA en el chat que en el menú de entornos y no sabía por
/// qué).
fn unavailable_reason(env_id: &str) -> &'static str {
    match env_id.strip_prefix("ai:").unwrap_or(env_id) {
        // Solo aceptan la pregunta como argumento: por su `.cmd`, cmd
        // interpretaría `&`, `|` o `%` de lo que se escriba.
        "opencode" | "continue" => "args-only",
        // Lo aprueba todo él solo: entra con «Omitir permisos».
        "grok" => "needs-bypass",
        // Edita sin preguntar: entra con «Dejar editar».
        "amp" => "needs-edit",
        "aider" => "edits-files",
        "copilot" => "needs-permissions",
        _ => "no-one-shot",
    }
}

/// Lo que lanza un `.cmd` de npm, en la línea que pasa los argumentos.
#[derive(Debug, PartialEq)]
struct NpmShim {
    /// Relativo a la carpeta del `.cmd`.
    target: String,
    /// Un script que se lanza con node; si no, el programa mismo.
    node: bool,
}

/// Lo que lanza un `.cmd` de npm: un script de node
/// (`"%_prog%" "%dp0%\node_modules\…\cli.js" %*`) o, en los paquetes que
/// traen su programa ya compilado, ese `.exe` sin node delante
/// (`"%dp0%\node_modules\opencode-ai\bin\opencode.exe" %*`; también Amp y
/// pnpm). Solo algo dentro de su carpeta: nada con `%` ni `..`.
fn npm_shim(contents: &str) -> Option<NpmShim> {
    const MARK: &str = "\"%dp0%\\";
    let line = contents.lines().find(|line| line.contains("%*"))?;
    let at = line.find(MARK)?;
    let rest = &line[at + MARK.len()..];
    let target = rest[..rest.find('"')?].trim_start_matches('\\');
    if target.is_empty() || target.contains('%') || target.contains("..") {
        return None;
    }
    let lower = target.to_ascii_lowercase();
    let node = if [".js", ".mjs", ".cjs"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        true
    } else if lower.ends_with(".exe") && line[..at].trim().is_empty() {
        // El `.exe` es lo primero de la línea: no hay node ni nada delante.
        false
    } else {
        return None;
    };
    Some(NpmShim {
        target: target.to_string(),
        node,
    })
}

/// El archivo que lanza un `.cmd` de npm (script de node o programa),
/// relativo a su carpeta. Ver [`npm_shim`].
fn npm_shim_script(contents: &str) -> Option<String> {
    npm_shim(contents).map(|shim| shim.target)
}

/// Con qué se lanza una CLI que recibe la pregunta como argumento sin pasar
/// por cmd: su `.exe` tal cual o, si es el `.cmd` de npm, node con su script
/// o el `.exe` que trae el paquete (opencode, 15-11: se ofrecía en el chat y
/// luego decía «no se pudo lanzar sin pasar por cmd»). `None` si no se puede
/// (entonces no se ofrece en el chat, solo en su pestaña).
fn direct_launcher(exe: &str) -> Option<(String, Vec<String>)> {
    let path = Path::new(exe);
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if extension == "exe" {
        return Some((exe.to_string(), Vec::new()));
    }
    if extension != "cmd" && extension != "bat" {
        return None;
    }
    let dir = path.parent()?;
    let shim = npm_shim(&std::fs::read_to_string(path).ok()?)?;
    let script = dir.join(&shim.target);
    if !script.is_file() {
        return None;
    }
    if !shim.node {
        return Some((script.to_string_lossy().to_string(), Vec::new()));
    }
    let local = dir.join("node.exe");
    let node = if local.is_file() {
        local
    } else {
        crate::path_env::which("node")?
    };
    Some((
        node.to_string_lossy().to_string(),
        vec![script.to_string_lossy().to_string()],
    ))
}

/// `agentChat:agents`: las IA instaladas; `chat` dice si se les puede
/// preguntar desde el panel y, si no, `unavailable` por qué.
#[tauri::command]
pub fn agent_chat_agents(state: State<'_, Arc<AppState>>) -> Vec<ChatAgent> {
    state
        .environments()
        .into_iter()
        .filter(|env| env.available && env.id.starts_with("ai:"))
        .map(|env| {
            let spec = spec_for(&env.id);
            let one_shot =
                one_shot_args_with(&env.id, &env.args, Choice::default(), Allowed::current())
                    .is_ok();
            // La que solo acepta la pregunta como argumento se lanza sin cmd;
            // si su lanzador no lo permite, preguntarle fallaría siempre: no
            // se ofrece en el chat (15-11, Romen: «¿para qué lo ofreces?»).
            let launchable = spec.and_then(|spec| spec.prompt_flag).is_none()
                || direct_launcher(&env.exe).is_some();
            // Sin su configuración no tiene con qué contestar (Continue).
            let configured = !needs_config(&env.id, &crate::paths::home_dir());
            let chat = one_shot && launchable && configured;
            ChatAgent {
                chat,
                unavailable: (!chat).then(|| {
                    if !one_shot {
                        unavailable_reason(&env.id)
                    } else if !launchable {
                        "needs-cmd"
                    } else {
                        "needs-config"
                    }
                }),
                model_choice: spec.is_some_and(|spec| spec.model_flag.is_some()),
                models: spec
                    .map(|spec| spec.models.iter().map(|model| model.to_string()).collect())
                    .unwrap_or_default(),
                efforts: spec
                    .and_then(|spec| spec.effort)
                    .map(|effort| {
                        effort
                            .levels
                            .iter()
                            .map(|level| level.to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
                modes: spec
                    .map(|spec| spec.modes.iter().map(|mode| mode.id.to_string()).collect())
                    .unwrap_or_default(),
                fast: spec.is_some_and(|spec| spec.fast.is_some()),
                id: env.id,
                label: env.label,
            }
        })
        .collect()
}

/// Lo elegido en el panel para una pregunta (`agentChat:ask`): todo opcional.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AskOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Modo de permisos; vacío, el de fábrica del agente.
    pub mode: Option<String>,
    pub fast: bool,
}

/// La CLI que, sin clave, la pide por consola en vez de fallar: ShellGPT, la
/// primera vez (sin `~/.config/shell_gpt/.sgptrc`), llama a `getpass`, que
/// en Windows lee la consola y no la entrada estándar. `Some(variable)` si se
/// colgaría: ni la variable en el entorno, ni guardada en WTerminal, ni su
/// archivo de configuración.
fn asks_key_on_console(env_id: &str, home: &Path) -> Option<&'static str> {
    const ENV_VAR: &str = "OPENAI_API_KEY";
    if env_id != "ai:sgpt" {
        return None;
    }
    let configured = home
        .join(".config")
        .join("shell_gpt")
        .join(".sgptrc")
        .is_file();
    let has_key = std::env::var_os(ENV_VAR).is_some_and(|value| !value.is_empty())
        || crate::environments::ai_keys::has_key(ENV_VAR);
    sgpt_would_prompt(configured, has_key).then_some(ENV_VAR)
}

fn sgpt_would_prompt(configured: bool, has_key: bool) -> bool {
    !configured && !has_key
}

/// La CLI que sin su configuración no tiene con qué contestar: Continue
/// (`cn`, 1.5) sin `config.yaml` intenta bajarse la de su servicio, que ya no
/// existe («Hub integration has been removed»), y acaba en «The request
/// failed and the interceptors did not return an alternative response»
/// (15-11, captura de Romen). La carpeta es la suya: `CONTINUE_GLOBAL_DIR` o
/// `~/.continue`. `true` si le falta.
fn needs_config(env_id: &str, home: &Path) -> bool {
    if env_id != "ai:continue" {
        return false;
    }
    let dir = std::env::var_os("CONTINUE_GLOBAL_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".continue"));
    !dir.join("config.yaml").is_file()
}

/// `agentChat:ask`: lanza la pregunta y devuelve su id. La respuesta llega
/// con los eventos `agent-chat-data` y `agent-chat-done`.
#[tauri::command(async)]
pub fn agent_chat_ask(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    env_id: String,
    prompt: String,
    tab_id: Option<String>,
    options: Option<AskOptions>,
) -> Result<u64, String> {
    if !crate::preferences::current().agent_chat {
        return Err("disabled".into());
    }
    let prompt = validate_prompt(&prompt)?.to_string();
    // La guía de WTerminal, oculta, delante de la pregunta (`agentChatGuide`,
    // 14-11). Los modelos locales de Ollama no: son pequeños y la pregunta
    // se les perdería entre tanto texto.
    let prompt =
        if crate::preferences::current().agent_chat_guide && !env_id.starts_with("ai:ollama") {
            format!(
                "{}{prompt}",
                crate::environments::agent_guide::chat_preamble()
            )
        } else {
            prompt
        };
    let env = state
        .environment_by_id(&env_id)
        .ok_or_else(|| "unknown-agent".to_string())?;
    let AskOptions {
        model,
        effort,
        mode,
        fast,
    } = options.unwrap_or_default();
    // De fábrica, solo leer; editar la carpeta, con `agentChatCanEdit`, y
    // omitir permisos, además con `agentChatAllowBypass`.
    let args = one_shot_args_with(
        &env.id,
        &env.args,
        Choice {
            model: model.as_deref(),
            effort: effort.as_deref(),
            mode: mode.as_deref(),
            fast,
        },
        Allowed::current(),
    )?;
    if fast && spec_for(&env.id).and_then(|spec| spec.fast) == Some(Fast::ClaudeSettings) {
        write_claude_fast_settings()?;
    }
    // ShellGPT sin clave y sin su configuración la pide por consola, y sin
    // consola esperaría para siempre (14-11, Romen: «se queda colgado»).
    if let Some(env_var) = asks_key_on_console(&env.id, &crate::paths::home_dir()) {
        return Err(format!("needs-key:{env_var}"));
    }
    // Sin su configuración, preguntarle solo daría un error tras medio minuto.
    if needs_config(&env.id, &crate::paths::home_dir()) {
        return Err("needs-config".into());
    }
    let timeout = answer_timeout(effort.as_deref());
    let prompt_flag = spec_for(&env.id).and_then(|spec| spec.prompt_flag);
    let mut command = match prompt_flag {
        None => {
            let mut command = crate::process::hidden_command(&env.exe);
            command.args(&args).stdin(Stdio::piped());
            command
        }
        Some(flag) => {
            // La pregunta como argumento: por node directo, nunca por cmd.
            if prompt.chars().count() > MAX_ARG_PROMPT_CHARS {
                return Err("too-long-for-agent".into());
            }
            let (program, before) =
                direct_launcher(&env.exe).ok_or_else(|| "unsafe-launcher".to_string())?;
            let mut command = crate::process::hidden_command(&program);
            command.args(&before).args(&args);
            if flag != PROMPT_POSITIONAL {
                command.arg(flag);
            }
            command.arg(&prompt).stdin(Stdio::null());
            command
        }
    };
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Sin colores ni barras de progreso: el panel enseña texto.
        .env("NO_COLOR", "1")
        .env("TERM", "dumb");
    for (key, value) in crate::environments::ai_keys::spawn_env(&env.id) {
        command.env(key, value);
    }
    // Y puede manejar WTerminal con `wterminal --ctl` (14-11).
    for (key, value) in crate::app::agent_control::spawn_env(None) {
        command.env(key, value);
    }
    // La carpeta de la pestaña activa: el agente ve el mismo proyecto.
    if let Some(dir) = tab_id
        .and_then(|tab| state.tabs.here_dir(&tab))
        .filter(|dir| Path::new(dir).is_dir())
    {
        command.current_dir(dir);
    }
    let mut child = command.spawn().map_err(|error| format!("spawn: {error}"))?;
    let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed) + 1;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    RUNNING.lock().insert(request_id, Arc::clone(&child));
    log_info!(
        "Pregunta al chat de agentes",
        serde_json::json!({
            "envId": env_id,
            "requestId": request_id,
            "chars": prompt.chars().count(),
            "model": model,
            "effort": effort,
            "mode": mode,
            "fast": fast,
        })
    );

    if let Some(mut stdin) = stdin {
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
            // Cerrarla es lo que le dice a la CLI que la pregunta acabó.
            drop(stdin);
        });
    }
    let errors = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = stderr {
        let errors = Arc::clone(&errors);
        let child = Arc::clone(&child);
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            let mut retries = RetryWatch::default();
            'read: while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buffer[..read]);
                {
                    let mut errors = errors.lock();
                    if errors.chars().count() < MAX_ERROR_CHARS {
                        errors.push_str(&text);
                    }
                }
                for event in retries.push(&text) {
                    let status = match event {
                        // Saturado o sin cupo tras varios reintentos: se corta
                        // ya y se dice por qué, en vez de esperar al plazo.
                        StderrEvent::GaveUp(status) => {
                            if RUNNING.lock().contains_key(&request_id) {
                                GAVE_UP.lock().insert(request_id, status);
                                kill_tree(&child);
                            }
                            break 'read;
                        }
                        StderrEvent::Retrying { attempt, status } => ChatStatus {
                            request_id,
                            retry: Some(ChatRetry {
                                attempt,
                                max: MAX_BUSY_RETRIES,
                                status,
                            }),
                            model: None,
                        },
                        StderrEvent::Model(model) => ChatStatus {
                            request_id,
                            retry: None,
                            model: Some(model),
                        },
                    };
                    let _ = app.emit("agent-chat-status", status);
                }
            }
        });
    }
    // Plazo: una CLI que se queda esperando (una pregunta de inicio de
    // sesión) no puede dejar la petición abierta para siempre.
    {
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < timeout {
                std::thread::sleep(Duration::from_millis(250));
                if !RUNNING.lock().contains_key(&request_id) {
                    return;
                }
            }
            if RUNNING.lock().contains_key(&request_id) {
                TIMED_OUT.lock().insert(request_id);
                kill_tree(&child);
            }
        });
    }
    // La salida se lee aparte: si un proceso que la CLI deja vivo la hereda
    // (Ollama arranca su programa), no se cierra nunca, y la respuesta tiene
    // que darse por acabada cuando sale la CLI ([`wait_for_answer`]).
    let finished = Arc::new(AtomicBool::new(false));
    let stdout_closed = Arc::new(AtomicBool::new(false));
    let last_output = Arc::new(Mutex::new(Instant::now()));
    // El final de lo que escribe: el error de quien lo escribe en su salida
    // normal y no en la de errores (Grok, 14-11).
    let output_tail = Arc::new(Mutex::new(String::new()));
    {
        let app = app.clone();
        let finished = Arc::clone(&finished);
        let stdout_closed = Arc::clone(&stdout_closed);
        let last_output = Arc::clone(&last_output);
        let output_tail = Arc::clone(&output_tail);
        let json_lines = env_id == "ai:grok";
        std::thread::spawn(move || {
            let mut decoder = Utf8Decoder::new();
            let mut pending_line = String::new();
            let emit = |text: String| {
                // Lo que escriba después ese proceso ya no es la respuesta.
                if !text.is_empty() && !finished.load(Ordering::Acquire) {
                    keep_tail(&mut output_tail.lock(), &text);
                    let _ = app.emit("agent-chat-data", ChatChunk { request_id, text });
                }
            };
            if let Some(mut stdout) = stdout {
                let mut buffer = [0u8; 8192];
                while let Ok(read) = stdout.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    *last_output.lock() = Instant::now();
                    let text = decoder.push(&buffer[..read]);
                    if !json_lines {
                        emit(text);
                        continue;
                    }
                    pending_line.push_str(&text);
                    while let Some(end) = pending_line.find('\n') {
                        let line: String = pending_line.drain(..=end).collect();
                        emit(grok_answer_line(&line));
                    }
                }
            }
            if json_lines && !pending_line.trim().is_empty() {
                emit(grok_answer_line(&pending_line));
            }
            stdout_closed.store(true, Ordering::Release);
        });
    }
    std::thread::spawn(move || {
        let code = wait_for_answer(&child, &stdout_closed, &last_output);
        finished.store(true, Ordering::Release);
        let was_running = RUNNING.lock().remove(&request_id).is_some();
        let timed_out = TIMED_OUT.lock().remove(&request_id);
        let gave_up = GAVE_UP.lock().remove(&request_id);
        // Lo que dijo por la salida de error, para «Ver lo que dijo el
        // agente» también cuando se corta o no contesta nada (15-11: Amp
        // acababa bien sin escribir y el panel se quedaba en blanco).
        let detail = Some(errors.lock().trim().to_string()).filter(|text| !text.is_empty());
        let error = if let Some(status) = gave_up {
            Some(format!("busy:{status}"))
        } else if timed_out {
            Some("timeout".to_string())
        } else if !was_running {
            Some("cancelled".to_string())
        } else if code == Some(0) {
            None
        } else {
            let errors = errors.lock().trim().to_string();
            let tail = output_tail.lock().trim().to_string();
            Some(if !errors.is_empty() {
                errors
            } else if !tail.is_empty() {
                tail
            } else {
                "failed".to_string()
            })
        };
        log_info!(
            "Respuesta del chat de agentes",
            serde_json::json!({ "requestId": request_id, "code": code, "ok": error.is_none() })
        );
        let _ = app.emit(
            "agent-chat-done",
            ChatDone {
                request_id,
                code,
                error,
                detail,
            },
        );
    });
    Ok(request_id)
}

/// Guarda el final de la salida (como mucho `MAX_ERROR_CHARS`), sin partir
/// un carácter.
fn keep_tail(tail: &mut String, text: &str) {
    tail.push_str(text);
    let excess = tail.chars().count().saturating_sub(MAX_ERROR_CHARS);
    if excess > 0 {
        let cut = tail
            .char_indices()
            .nth(excess)
            .map_or(tail.len(), |(index, _)| index);
        tail.drain(..cut);
    }
}

/// Una línea de la salida de `grok -p`: un mensaje JSON (`user`,
/// `assistant` con o sin `tool_calls`, `tool`). Se enseña lo que contesta
/// y, de sus herramientas, solo cuáles usó; su eco de la pregunta, no. Una
/// línea que no es JSON va tal cual.
fn grok_answer_line(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(message) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return format!("{trimmed}\n");
    };
    let content = message
        .get("content")
        .and_then(|content| content.as_str())
        .unwrap_or("");
    match message.get("role").and_then(|role| role.as_str()) {
        Some("assistant") => {
            let tools: Vec<&str> = message
                .get("tool_calls")
                .and_then(|calls| calls.as_array())
                .into_iter()
                .flatten()
                .filter_map(|call| call.pointer("/function/name")?.as_str())
                .collect();
            if tools.is_empty() {
                format!("{content}\n")
            } else {
                format!("› {}\n", tools.join(", "))
            }
        }
        _ => String::new(),
    }
}

/// Tras salir la CLI, lo que tarda en llegar el final de su salida: sin nada
/// nuevo en este rato, la respuesta está entera.
const ANSWER_QUIET: Duration = Duration::from_millis(300);
/// Lo más que se espera tras salir, aunque siga llegando algo.
const ANSWER_DRAIN_MAX: Duration = Duration::from_millis(1500);

/// Si una respuesta cuya CLI ya salió está entera.
fn answer_settled(since_exit: Duration, since_output: Duration) -> bool {
    since_exit >= ANSWER_DRAIN_MAX || since_output.min(since_exit) >= ANSWER_QUIET
}

/// Espera a que acabe la respuesta y devuelve el código de salida. Lo normal
/// es que la salida se cierre al salir la CLI. Pero `ollama run`, si su
/// programa no estaba abierto, lo arranca y este hereda la salida y la deja
/// abierta: la respuesta salía entera y el chat seguía en «Pensando…» hasta
/// el plazo (14-11, Romen: «se quedó colgado pensando a partir de que me dio
/// la respuesta»). Ahora basta con que la CLI salga y no llegue nada más
/// ([`answer_settled`]).
fn wait_for_answer(
    child: &Arc<Mutex<Child>>,
    stdout_closed: &AtomicBool,
    last_output: &Mutex<Instant>,
) -> Option<i32> {
    let mut exited: Option<(Instant, Option<i32>)> = None;
    let mut closed_at: Option<Instant> = None;
    loop {
        if exited.is_none() {
            match child.lock().try_wait() {
                Ok(Some(status)) => exited = Some((Instant::now(), status.code())),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        let closed = stdout_closed.load(Ordering::Acquire);
        match exited {
            Some((at, code)) => {
                if closed || answer_settled(at.elapsed(), last_output.lock().elapsed()) {
                    return code;
                }
            }
            None => {
                // Salida cerrada con la CLI aún viva: como antes, hasta 10 s.
                let waited = closed.then(|| closed_at.get_or_insert_with(Instant::now).elapsed());
                if waited.is_some_and(|waited| waited >= Duration::from_secs(10)) {
                    return None;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Lee un adjunto para la pregunta: solo texto, con tope. Lo que no es texto
/// (un NUL en los primeros 8 KB) o es demasiado grande se rechaza con un
/// motivo que el panel traduce. El archivo lo elige el usuario en el diálogo.
pub fn read_attachment(path: &Path) -> Result<ChatAttachment, &'static str> {
    let meta = std::fs::metadata(path).map_err(|_| "not-found")?;
    if !meta.is_file() {
        return Err("not-a-file");
    }
    if meta.len() > MAX_ATTACHMENT_FILE_BYTES {
        return Err("too-big");
    }
    let mut file = std::fs::File::open(path).map_err(|_| "unreadable")?;
    let mut bytes = Vec::with_capacity(MAX_ATTACHMENT_BYTES.min(meta.len() as usize) + 1);
    (&mut file)
        .take(MAX_ATTACHMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return Err("binary");
    }
    let truncated = bytes.len() > MAX_ATTACHMENT_BYTES;
    bytes.truncate(MAX_ATTACHMENT_BYTES);
    // Sin partir un carácter UTF-8 al cortar.
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            let valid = error.utf8_error().valid_up_to();
            let bytes = error.into_bytes();
            if truncated && bytes.len() - valid < 4 {
                String::from_utf8_lossy(&bytes[..valid]).into_owned()
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            }
        }
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(ChatAttachment {
        name,
        bytes: meta.len(),
        text,
        truncated,
    })
}

/// `agentChat:readAttachment`: el texto de un archivo para adjuntarlo.
#[tauri::command]
pub fn agent_chat_read_attachment(path: String) -> Result<ChatAttachment, String> {
    read_attachment(Path::new(&path)).map_err(str::to_string)
}

/// `agentChat:cancel`: corta una pregunta en curso.
#[tauri::command]
pub fn agent_chat_cancel(request_id: u64) -> bool {
    let Some(child) = RUNNING.lock().remove(&request_id) else {
        return false;
    };
    kill_tree(&child);
    true
}

// ---- Los modelos de cada agente (13-11) ----
//
// Romen: «lo de escribir el modelo a mano, y que el de fábrica sea "el de
// siempre"», no. El panel enseña una lista y, como primera opción, el modelo
// que de verdad usa el agente si no se elige ninguno, leído de su propia
// configuración. Si no lo dice en ningún sitio, lo decide el agente (su
// valor de fábrica o tu cuenta) y el panel lo dice así.

/// Lo que el panel ofrece para elegir modelo.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModels {
    /// El que usa el agente si no se elige ninguno, según su configuración.
    pub default_model: Option<String>,
    /// El archivo u orden de donde salió (para enseñarlo).
    pub source: Option<String>,
    /// Los que se pueden elegir, sin repetir y con el de fábrica primero.
    pub models: Vec<String>,
    /// La intensidad que admite cada modelo, si el agente lo dice (Codex, de
    /// su catálogo). Sin entrada, la del agente.
    pub efforts: HashMap<String, Vec<String>>,
    /// Los modelos con modo rápido, si el agente lo dice por modelo (Codex:
    /// los que traen `service_tiers`). `None`: no lo dice.
    pub fast: Option<Vec<String>>,
    /// Se ofrece «Otro…» para escribir uno a mano: solo si la lista puede
    /// estar incompleta (14-11, Romen: «¿por qué muestran Otro… y te pide
    /// escribirlo a mano?»). Ver [`custom_model_allowed`].
    pub custom: bool,
}

/// Si el panel ofrece escribir el modelo a mano. Los agentes cuya lista sale
/// de ellos mismos (Codex, Gemini, Qwen, llm, AIChat) o son alias que
/// apuntan al último modelo (Claude Code) no lo necesitan; Copilot, Crush
/// (`crush models` da todos los de todos los proveedores), mods y ShellGPT no
/// saben listar los suyos. Si la lista sale vacía, sí.
fn custom_model_allowed(ai: &str, listed: usize) -> bool {
    match ai {
        "codex" | "gemini" | "qwen" | "llm" | "aichat" => listed == 0,
        "claude" => false,
        _ => true,
    }
}

/// Un modelo del catálogo de Codex.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexModel {
    slug: String,
    efforts: Vec<String>,
    /// Trae `service_tiers` («Fast»).
    fast: bool,
}

/// Los modelos visibles del catálogo de Codex (`codex debug models`), en su
/// orden (`priority`) y con la intensidad que admite cada uno. Los ocultos
/// (`visibility: hide`) no se ofrecen.
fn codex_catalog(json: &str) -> Vec<CodexModel> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let mut models: Vec<(i64, CodexModel)> = value
        .get("models")
        .and_then(|models| models.as_array())
        .into_iter()
        .flatten()
        .filter(|model| model.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
        .filter_map(|model| {
            let slug = model.get("slug")?.as_str()?.to_string();
            if !valid_model(&slug) {
                return None;
            }
            let levels = model
                .get("supported_reasoning_levels")
                .and_then(|levels| levels.as_array())
                .into_iter()
                .flatten()
                .filter_map(|level| level.get("effort")?.as_str())
                .filter(|level| CODEX_EFFORTS.contains(level))
                .map(str::to_string)
                .collect();
            let priority = model
                .get("priority")
                .and_then(|p| p.as_i64())
                .unwrap_or(i64::MAX);
            let fast = model
                .get("service_tiers")
                .and_then(|tiers| tiers.as_array())
                .is_some_and(|tiers| !tiers.is_empty());
            Some((
                priority,
                CodexModel {
                    slug,
                    efforts: levels,
                    fast,
                },
            ))
        })
        .collect();
    models.sort_by_key(|(priority, _)| *priority);
    models.into_iter().map(|(_, model)| model).collect()
}

/// Los nombres de modelo que trae el paquete instalado de Gemini CLI o de
/// Qwen Code, con un filtro estricto (versión y tipo): así la lista es la de
/// esa versión y no se queda vieja. Ordenados del más nuevo al más viejo.
fn bundle_models(text: &str, ai: &str) -> Vec<String> {
    static GEMINI: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r#""(gemini-(\d+(?:\.\d+)?)-(pro|flash|flash-lite)(-preview)?)""#)
            .unwrap()
    });
    static QWEN: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(
            r#""(qwen(\d+(?:\.\d+)?)-(max|plus|flash|turbo|coder-plus|coder-flash)(-preview)?)""#,
        )
        .unwrap()
    });
    let pattern = if ai == "gemini" { &GEMINI } else { &QWEN };
    let rank = |kind: &str| match kind {
        "pro" | "max" | "coder-plus" => 0,
        "plus" | "flash" | "coder-flash" => 1,
        _ => 2,
    };
    let mut found: Vec<(f64, u8, bool, String)> = Vec::new();
    for capture in pattern.captures_iter(text) {
        let name = capture[1].to_string();
        if found.iter().any(|(_, _, _, known)| *known == name) {
            continue;
        }
        let version = capture[2].parse::<f64>().unwrap_or(0.0);
        found.push((version, rank(&capture[3]), capture.get(4).is_some(), name));
    }
    found.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    found.into_iter().map(|(_, _, _, name)| name).collect()
}

/// La carpeta del paquete de npm de una CLI (la que tiene su `package.json`),
/// a partir de su `.cmd`.
fn package_dir(exe: &str) -> Option<PathBuf> {
    let path = Path::new(exe);
    let script = path
        .parent()?
        .join(npm_shim_script(&std::fs::read_to_string(path).ok()?)?);
    script
        .ancestors()
        .skip(1)
        .find(|dir| dir.join("package.json").is_file())
        .map(Path::to_path_buf)
}

/// Lo que se lee del paquete instalado: hasta 120 MB de `.js`, sin entrar en
/// sus `node_modules`. Se guarda por versión (fecha de su `package.json`).
fn installed_models(exe: &str, ai: &str) -> Vec<String> {
    /// Por carpeta del paquete: la fecha de su `package.json` y sus modelos.
    type ModelCache = HashMap<PathBuf, (std::time::SystemTime, Vec<String>)>;
    static CACHE: Lazy<Mutex<ModelCache>> = Lazy::new(|| Mutex::new(HashMap::new()));
    let Some(dir) = package_dir(exe) else {
        return Vec::new();
    };
    let stamp = std::fs::metadata(dir.join("package.json"))
        .and_then(|meta| meta.modified())
        .unwrap_or(std::time::UNIX_EPOCH);
    if let Some((cached, models)) = CACHE.lock().get(&dir) {
        if *cached == stamp {
            return models.clone();
        }
    }
    let mut pending = vec![(dir.clone(), 0u8)];
    let mut budget: u64 = 120 * 1024 * 1024;
    let mut models: Vec<String> = Vec::new();
    while let Some((folder, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if name != "node_modules" && depth < 3 {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !(name.ends_with(".js") || name.ends_with(".mjs") || name.ends_with(".cjs")) {
                continue;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(u64::MAX);
            if size > budget {
                continue;
            }
            budget -= size;
            if let Ok(text) = std::fs::read_to_string(&path) {
                for model in bundle_models(&text, ai) {
                    if !models.contains(&model) {
                        models.push(model);
                    }
                }
            }
        }
    }
    // El orden por versión, ya con todos los archivos juntos.
    let models = bundle_models(
        &models
            .iter()
            .map(|model| format!("\"{model}\""))
            .collect::<Vec<_>>()
            .join(" "),
        ai,
    );
    CACHE.lock().insert(dir, (stamp, models.clone()));
    models
}

/// Un texto de JSON en la primera de estas rutas (`/model/name`, `/model`).
fn json_model(text: &str, pointers: &[&str]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer)?.as_str().map(str::to_string))
        .filter(|model| valid_model(model))
}

/// `model = "…"` en la raíz de un TOML (Codex).
fn toml_model(text: &str) -> Option<String> {
    let value: toml::Value = toml::from_str(text).ok()?;
    value
        .get("model")?
        .as_str()
        .map(str::to_string)
        .filter(|model| valid_model(model))
}

/// `clave: valor` sin sangría en un YAML sencillo (mods, AIChat).
fn yaml_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        let value = rest.split(" #").next()?.trim().trim_matches(['"', '\'']);
        valid_model(value).then(|| value.to_string())
    })
}

/// `CLAVE=valor` (el `.sgptrc` de ShellGPT).
fn env_file_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let value = line.trim().strip_prefix(key)?.strip_prefix('=')?.trim();
        valid_model(value).then(|| value.to_string())
    })
}

/// Lo que dice `llm models list`: «OpenAI Chat: gpt-4o (aliases: 4o)».
fn llm_models(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let model = line.split_once(": ")?.1;
            let model = model.split(" (").next()?.trim();
            valid_model(model).then(|| model.to_string())
        })
        .collect()
}

/// Un modelo por línea (`aichat --list-models`).
fn line_models(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|model| valid_model(model))
        .map(str::to_string)
        .collect()
}

const MAX_LISTED_MODELS: usize = 80;

/// Junta el de fábrica, los listados y los sugeridos, sin repetir.
fn merge_models(
    default_model: Option<&str>,
    listed: Vec<String>,
    suggested: &[&str],
) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    for model in default_model
        .map(str::to_string)
        .into_iter()
        .chain(listed)
        .chain(suggested.iter().map(|model| model.to_string()))
    {
        if !models.contains(&model) && models.len() < MAX_LISTED_MODELS {
            models.push(model);
        }
    }
    models
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// La salida de una orden del agente que solo lista (no pregunta nada).
fn list_output(exe: &str, args: &[&str]) -> Option<String> {
    list_output_within(exe, args, Duration::from_secs(8))
}

fn list_output_within(exe: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let output = crate::infrastructure::process::run_with_timeout(exe, args, timeout)?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).to_string())
}

/// `agentChat:models`: el modelo de fábrica de un agente y los que se pueden
/// elegir. Lee su configuración y, si sabe listarlos, se los pide; nunca le
/// pregunta nada a la IA.
#[tauri::command(async)]
pub fn agent_chat_models(state: State<'_, Arc<AppState>>, env_id: String) -> ChatModels {
    let Some(spec) = spec_for(&env_id) else {
        return ChatModels::default();
    };
    if spec.model_flag.is_none() {
        return ChatModels::default();
    }
    let exe = state.environment_by_id(&env_id).map(|env| env.exe);
    let home = crate::paths::home_dir();
    let config = dirs::config_dir().unwrap_or_else(|| home.clone());
    let at = |path: PathBuf| (read_text(&path), path.to_string_lossy().to_string());
    let mut efforts: HashMap<String, Vec<String>> = HashMap::new();
    let mut fast: Option<Vec<String>> = None;
    let (default_model, source, listed): (Option<String>, Option<String>, Vec<String>) =
        match spec.ai {
            "claude" => {
                let (text, source) = at(home.join(".claude").join("settings.json"));
                (
                    text.and_then(|text| json_model(&text, &["/model"])),
                    Some(source),
                    Vec::new(),
                )
            }
            "codex" => {
                let (text, source) = at(home.join(".codex").join("config.toml"));
                // Su catálogo: no pregunta nada a la IA (14-11, Romen: «solo
                // Claude muestra la lista de modelos»).
                let catalog = exe
                    .as_deref()
                    .and_then(|exe| {
                        list_output_within(exe, &["debug", "models"], Duration::from_secs(20))
                    })
                    .map(|output| codex_catalog(&output))
                    .unwrap_or_default();
                for model in &catalog {
                    if !model.efforts.is_empty() {
                        efforts.insert(model.slug.clone(), model.efforts.clone());
                    }
                }
                if !catalog.is_empty() {
                    fast = Some(
                        catalog
                            .iter()
                            .filter(|model| model.fast)
                            .map(|model| model.slug.clone())
                            .collect(),
                    );
                }
                (
                    text.and_then(|text| toml_model(&text)),
                    Some(source),
                    catalog.into_iter().map(|model| model.slug).collect(),
                )
            }
            "gemini" | "qwen" => {
                let folder = if spec.ai == "gemini" {
                    ".gemini"
                } else {
                    ".qwen"
                };
                let (text, source) = at(home.join(folder).join("settings.json"));
                let model = text.and_then(|text| json_model(&text, &["/model/name", "/model"]));
                let listed = exe
                    .as_deref()
                    .map(|exe| installed_models(exe, spec.ai))
                    .unwrap_or_default();
                (model, Some(source), listed)
            }
            "copilot" => {
                let (text, source) = at(home.join(".copilot").join("config.json"));
                (
                    text.and_then(|text| json_model(&text, &["/model"])),
                    Some(source),
                    Vec::new(),
                )
            }
            "sgpt" => {
                let (text, source) = at(home.join(".config").join("shell_gpt").join(".sgptrc"));
                (
                    text.and_then(|text| env_file_value(&text, "DEFAULT_MODEL")),
                    Some(source),
                    Vec::new(),
                )
            }
            "mods" => {
                let (text, source) = at(config.join("mods").join("mods.yml"));
                (
                    text.and_then(|text| yaml_value(&text, "default-model")),
                    Some(source),
                    Vec::new(),
                )
            }
            "aichat" => {
                let (text, source) = at(config.join("aichat").join("config.yaml"));
                let listed = exe
                    .as_deref()
                    .and_then(|exe| list_output(exe, &["--list-models"]))
                    .map(|output| line_models(&output))
                    .unwrap_or_default();
                (
                    text.and_then(|text| yaml_value(&text, "model")),
                    Some(source),
                    listed,
                )
            }
            "llm" => {
                let default_model = exe
                    .as_deref()
                    .and_then(|exe| list_output(exe, &["models", "default"]))
                    .map(|output| output.trim().to_string())
                    .filter(|model| valid_model(model));
                let listed = exe
                    .as_deref()
                    .and_then(|exe| list_output(exe, &["models", "list"]))
                    .map(|output| llm_models(&output))
                    .unwrap_or_default();
                (
                    default_model,
                    Some("llm models default".to_string()),
                    listed,
                )
            }
            _ => (None, None, Vec::new()),
        };
    let source = default_model.as_ref().and(source);
    let custom = custom_model_allowed(spec.ai, listed.len());
    ChatModels {
        models: merge_models(default_model.as_deref(), listed, spec.models),
        default_model,
        source,
        efforts,
        fast,
        custom,
    }
}

// ---- Qué hacer cuando un agente falla (13-11) ----
//
// Con los errores reales que vio Romen al probar todos: llm y ShellGPT con
// «ModuleNotFoundError» (pip --user sin PYTHONUSERBASE), mods con «OpenAI
// authentication failed … api-keys», Qwen con «No auth type is selected» y
// AIChat con «Failed to load config … config.yaml». Antes el chat solo
// enseñaba el error; ahora ofrece lo que lo arregla.

/// Lo que el chat puede ofrecer tras un fallo. Puede haber más de una cosa:
/// Claude Code sin sesión dice «Invalid API key · Please run /login».
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureHelp {
    /// Meter (o cambiar) su clave de API: la variable que lee y si ya había
    /// una guardada.
    pub api_key: Option<crate::environments::ai_keys::AiKeyOffer>,
    /// Abrir el agente en su pestaña: `login` (iniciar sesión) o `setup`
    /// (su primera configuración).
    pub open_tab: Option<&'static str>,
    /// Su módulo de Python no carga: lo instaló pip en una carpeta que Python
    /// no ve.
    pub python_module: bool,
}

const LOGIN_HINTS: &[&str] = &[
    "not logged in",
    "please log in",
    "please login",
    "/login",
    " login`",
    "log in to",
    "sign in",
    "auth type",
    "--auth-type",
    "authentication required",
    "not authenticated",
    "no credentials",
    "unauthorized",
    "401",
];

const SETUP_HINTS: &[&str] = &[
    "failed to load config",
    "config.yaml",
    "no config",
    "not configured",
    "run the setup",
    "first run",
    // Crush: «No providers configured - please run 'crush' to set up a
    // provider interactively» (14-11, captura de Romen).
    "no providers configured",
    "set up a provider",
];

/// Qué ofrecer tras un fallo de `env_id` con esta salida. Pura: se prueba con
/// los mensajes reales.
pub fn classify_failure(env_id: &str, output: &str, key_offer_enabled: bool) -> FailureHelp {
    let lower = output.to_lowercase();
    let mut help = FailureHelp {
        python_module: lower.contains("modulenotfounderror: no module named"),
        ..FailureHelp::default()
    };
    if help.python_module {
        return help;
    }
    if key_offer_enabled && crate::environments::ai_keys::supported() {
        if let Some(spec) = crate::environments::ai_keys::spec_for_env(env_id) {
            // Gemini con una cuenta personal de Google contesta
            // `UNSUPPORTED_CLIENT`; con `GEMINI_API_KEY` funciona.
            let asks = crate::environments::ai_keys::output_asks_for_key(spec, output)
                || lower.contains("authentication failed")
                || lower.contains("invalid x-api-key")
                || lower.contains("unsupported_client");
            if asks {
                help.api_key = Some(crate::environments::ai_keys::AiKeyOffer {
                    env_var: spec.env_var.to_string(),
                    stored: crate::environments::ai_keys::has_key(spec.env_var),
                });
            }
        }
    }
    // Ollama no tiene sesión: su error es otro (el servidor, el modelo).
    if !env_id.starts_with("ai:ollama") {
        if LOGIN_HINTS.iter().any(|hint| lower.contains(hint)) {
            help.open_tab = Some("login");
        } else if SETUP_HINTS.iter().any(|hint| lower.contains(hint)) {
            help.open_tab = Some("setup");
        }
    }
    // Una IA que se usa con clave y no tiene inicio de sesión propio: con
    // ofrecer la clave basta.
    if help.api_key.is_some() && help.open_tab == Some("login") && !env_id.starts_with("ai:claude")
    {
        help.open_tab = None;
    }
    help
}

/// `agentChat:failureHelp`: qué ofrecer tras un fallo (ver [`classify_failure`]).
#[tauri::command]
pub fn agent_chat_failure_help(env_id: String, output: String) -> FailureHelp {
    classify_failure(&env_id, &output, crate::preferences::current().ai_key_offer)
}

/// Una CLI de npm es `cmd.exe` → `node`: matar solo cmd dejaría a node
/// contestando sin nadie que lo lea.
fn kill_tree(child: &Arc<Mutex<Child>>) {
    let pid = child.lock().id();
    if cfg!(windows) {
        let _ = crate::process::hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    let _ = child.lock().kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(id: &str, env_args: &[&str]) -> Option<Vec<String>> {
        let env_args: Vec<String> = env_args.iter().map(|arg| arg.to_string()).collect();
        one_shot_args_with(id, &env_args, Choice::default(), Allowed::default()).ok()
    }

    fn with(
        id: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Vec<String>, &'static str> {
        let choice = Choice {
            model,
            effort,
            ..Choice::default()
        };
        one_shot_args_with(id, &[], choice, Allowed::default())
    }

    fn in_mode(id: &str, mode: &str, allowed: Allowed) -> Result<Vec<String>, &'static str> {
        let choice = Choice {
            mode: Some(mode),
            ..Choice::default()
        };
        one_shot_args_with(id, &[], choice, allowed)
    }

    const EDIT: Allowed = Allowed {
        edit: true,
        bypass: false,
    };
    const ALL: Allowed = Allowed {
        edit: true,
        bypass: true,
    };

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn solo_se_ofrecen_las_ia_con_modo_de_una_pregunta() {
        assert_eq!(args("ai:claude", &[]), Some(vec!["-p".to_string()]));
        // Codex fuera de un repositorio git y en solo lectura (13-11).
        assert_eq!(
            args("ai:codex", &[]),
            Some(strings(&[
                "exec",
                "--skip-git-repo-check",
                "--color",
                "never",
                "-s",
                "read-only",
                "-"
            ]))
        );
        assert_eq!(
            args("ai:qwen", &[]),
            Some(strings(&["--approval-mode", "plan"]))
        );
        assert_eq!(
            args("ai:ollama:qwen3:8b", &["run", "qwen3:8b"]),
            Some(vec!["run".to_string(), "qwen3:8b".to_string()])
        );
        // Amp edita sin preguntar: sin el ajuste de editar no entra (14-11).
        assert_eq!(args("ai:amp", &[]), None, "Amp sin «Dejar editar»");
        assert_eq!(args("ai:aider", &[]), None, "aider edita archivos");
        // Gemini vuelve (13-11): con `GEMINI_API_KEY` contesta; en `plan`, y
        // confiando en la carpeta de la pestaña para esa pregunta (14-11).
        assert_eq!(
            args("ai:gemini", &[]),
            Some(strings(&["--skip-trust", "--approval-mode", "plan"]))
        );
        assert_eq!(args("ai:crush", &[]), Some(strings(&["run", "--quiet"])));
        assert_eq!(args("cmd", &[]), None);
    }

    #[test]
    fn la_pregunta_nunca_pasa_por_cmd() {
        for spec in ONE_SHOT {
            assert!(
                spec.head
                    .iter()
                    .chain(spec.tail)
                    .all(|arg| !arg.contains('{')),
                "{}: los argumentos son fijos",
                spec.ai
            );
        }
        // Solo Copilot la recibe como argumento, y entonces se lanza node
        // con el script que nombra su `.cmd` (este es el `.cmd` real).
        let solo_argumento: Vec<_> = ONE_SHOT
            .iter()
            .filter(|spec| spec.prompt_flag.is_some())
            .map(|spec| spec.ai)
            .collect();
        assert_eq!(solo_argumento, ["copilot", "grok", "continue", "opencode"]);
        let copilot_cmd = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@github\\copilot\\npm-loader.js\" %*\r\n";
        assert_eq!(
            npm_shim_script(copilot_cmd).as_deref(),
            Some("node_modules\\@github\\copilot\\npm-loader.js")
        );
        // Nada que salga de su carpeta o que cmd tuviera que expandir.
        for raro in [
            "\"%_prog%\" \"%dp0%\\..\\otro\\x.js\" %*",
            "\"%_prog%\" \"%dp0%\\%OTRA%\\x.js\" %*",
            "\"%_prog%\" \"%dp0%\\x.exe\" %*",
            "sin argumentos",
        ] {
            assert_eq!(npm_shim_script(raro), None, "{raro}");
        }
        // Un `.ps1` u otra cosa no se lanza sin cmd: no se le pregunta.
        assert_eq!(direct_launcher(r"C:\x\copilot.ps1"), None);
        assert_eq!(
            direct_launcher(r"C:\x\copilot.exe"),
            Some((r"C:\x\copilot.exe".to_string(), Vec::new()))
        );
    }

    /// Continue sin `config.yaml` no tiene con qué contestar: no se ofrece en
    /// el chat ni se le pregunta (15-11).
    #[test]
    fn continue_sin_config_no_se_ofrece() {
        if std::env::var_os("CONTINUE_GLOBAL_DIR").is_some() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        assert!(needs_config("ai:continue", home.path()));
        assert!(!needs_config("ai:claude", home.path()), "solo Continue");
        std::fs::create_dir_all(home.path().join(".continue")).unwrap();
        std::fs::write(
            home.path().join(".continue").join("config.yaml"),
            "models: []",
        )
        .unwrap();
        assert!(!needs_config("ai:continue", home.path()));
    }

    /// Gemini CLI con el modelo saturado reintentaba en silencio hasta 10
    /// veces: al tercer 503 o 429 se corta (15-11). La salida real, troceada
    /// como llega.
    #[test]
    fn tres_reintentos_por_saturacion_cortan_la_pregunta() {
        let intento = |n: u32, status: u16| {
            format!("Attempt {n} failed with status {status}. Retrying with backoff... _ApiError: {{\"error\":{{\"message\":\"This model is currently experiencing high demand.\"}}}}\n    at throwErrorIfNotOK (file:///x.js:1:1)\n  status: {status}\n}}\n")
        };
        assert_eq!(busy_retry_status(&intento(1, 503)), Some(503));
        assert_eq!(
            busy_retry_status("Attempt 2 failed with status 429. Retrying"),
            Some(429)
        );
        // Otros fallos no son de saturación: no cuentan.
        assert_eq!(
            busy_retry_status("Attempt 1 failed with status 400. x"),
            None
        );
        assert_eq!(busy_retry_status("Ripgrep is not available."), None);
        let mut watch = RetryWatch::default();
        let primero = intento(1, 503);
        let (a, b) = primero.split_at(20);
        assert_eq!(watch.push(a), vec![], "media línea no cuenta todavía");
        // Cada reintento se avisa en cuanto se ve (16-11), y al tercero se corta.
        assert_eq!(
            watch.push(b),
            vec![StderrEvent::Retrying {
                attempt: 1,
                status: 503
            }]
        );
        assert_eq!(
            watch.push(&intento(2, 503)),
            vec![StderrEvent::Retrying {
                attempt: 2,
                status: 503
            }]
        );
        assert_eq!(watch.push(&intento(3, 503)), vec![StderrEvent::GaveUp(503)]);
    }

    /// Codex dice qué modelo usa en la cabecera de `codex exec`; el panel lo
    /// enseña junto a la respuesta (16-11). Solo una vez y solo esa línea.
    #[test]
    fn el_modelo_que_dice_la_cli_se_avisa_una_vez() {
        let cabecera = "OpenAI Codex v0.120.0 (research preview)\n--------\nworkdir: C:\\proyecto\nmodel: gpt-5.1-codex\nprovider: openai\napproval: never\n--------\n";
        let mut watch = RetryWatch::default();
        assert_eq!(
            watch.push(cabecera),
            vec![StderrEvent::Model("gpt-5.1-codex".into())]
        );
        assert_eq!(watch.push("model: otro\n"), vec![], "solo la primera");
        // Con colores (negrita en «model:») también.
        assert_eq!(
            reported_model("\x1b[1mmodel:\x1b[0m o4-mini\n"),
            Some("o4-mini".into())
        );
        // Un JSON de error o un texto cualquiera no es el modelo.
        assert_eq!(reported_model("  \"model\": \"gemini-2.5-pro\",\n"), None);
        assert_eq!(reported_model("model: no es un modelo\n"), None);
        assert_eq!(reported_model("the model: x\n"), None);
    }

    /// opencode (y Amp, pnpm) trae su programa compilado: su `.cmd` de npm
    /// lanza el `.exe` sin node. Se ofrecía en el chat y luego decía «no se
    /// pudo lanzar sin pasar por cmd» (15-11): se lanza ese `.exe` directo.
    #[test]
    fn el_cmd_de_npm_que_lanza_un_exe_se_salta_cmd() {
        // El `.cmd` real que deja `npm install -g opencode-ai`.
        let opencode_cmd = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*\r\n";
        assert_eq!(
            npm_shim(opencode_cmd),
            Some(NpmShim {
                target: "node_modules\\opencode-ai\\bin\\opencode.exe".into(),
                node: false,
            })
        );
        // Un `.exe` con algo delante, o fuera de su carpeta, no vale.
        for raro in [
            "start \"%dp0%\\x.exe\" %*",
            "\"%dp0%\\..\\x.exe\" %*",
            "\"%dp0%\\x.bat\" %*",
        ] {
            assert_eq!(npm_shim(raro), None, "{raro}");
        }
        let dir = tempfile::tempdir().unwrap();
        let cmd = dir.path().join("opencode.cmd");
        std::fs::write(&cmd, opencode_cmd).unwrap();
        let cmd = cmd.to_string_lossy().to_string();
        // Sin el programa instalado no hay con qué lanzarlo: no se ofrece.
        assert_eq!(direct_launcher(&cmd), None);
        let exe = dir
            .path()
            .join("node_modules\\opencode-ai\\bin\\opencode.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"MZ").unwrap();
        assert_eq!(
            direct_launcher(&cmd),
            Some((exe.to_string_lossy().to_string(), Vec::new()))
        );
    }

    #[test]
    fn una_pregunta_vacia_o_enorme_no_se_manda() {
        assert_eq!(
            validate_prompt("  ¿qué hace `ls -la`?  "),
            Ok("¿qué hace `ls -la`?")
        );
        assert_eq!(validate_prompt("   "), Err("empty"));
        assert_eq!(
            validate_prompt(&"a".repeat(MAX_PROMPT_CHARS + 1)),
            Err("too-long")
        );
    }

    #[test]
    fn todas_las_ia_del_chat_estan_en_el_catalogo() {
        let catalog = include_str!("ai.rs");
        for spec in ONE_SHOT {
            assert!(
                catalog.contains(&format!("AiCliDef {{ id: \"{}\"", spec.ai)),
                "{} no está en el catálogo",
                spec.ai
            );
        }
    }

    #[test]
    fn el_modelo_y_la_intensidad_van_con_la_opcion_de_cada_cli() {
        assert_eq!(
            with("ai:claude", Some("opus"), Some("high")),
            Ok(strings(&["-p", "--model", "opus", "--effort", "high"]))
        );
        // Codex: las opciones antes del `-` que dice «la pregunta llega por
        // la entrada»; la intensidad, por configuración.
        assert_eq!(
            with("ai:codex", Some("gpt-5"), Some("low")),
            Ok(strings(&[
                "exec",
                "--skip-git-repo-check",
                "--color",
                "never",
                "-s",
                "read-only",
                "-m",
                "gpt-5",
                "-c",
                "model_reasoning_effort=low",
                "-"
            ]))
        );
        assert_eq!(
            with("ai:qwen", Some("qwen3-coder-plus"), None),
            Ok(strings(&[
                "--approval-mode",
                "plan",
                "-m",
                "qwen3-coder-plus"
            ]))
        );
        assert_eq!(
            with("ai:sgpt", Some("gpt-4o"), None),
            Ok(strings(&["--model", "gpt-4o"]))
        );
        // Sin elegir nada, como siempre.
        assert_eq!(with("ai:claude", None, None), Ok(strings(&["-p"])));
        assert_eq!(
            with("ai:claude", Some("  "), Some("")),
            Ok(strings(&["-p"]))
        );
    }

    #[test]
    fn editar_la_carpeta_solo_con_el_ajuste_encendido() {
        let editing = |id: &str| one_shot_args_with(id, &[], Choice::default(), EDIT);
        assert_eq!(
            editing("ai:codex"),
            Ok(strings(&[
                "exec",
                "--skip-git-repo-check",
                "--color",
                "never",
                "-s",
                "workspace-write",
                "-"
            ]))
        );
        assert_eq!(
            editing("ai:qwen"),
            Ok(strings(&["--approval-mode", "auto-edit"]))
        );
        assert_eq!(
            editing("ai:claude"),
            Ok(strings(&["-p", "--permission-mode", "acceptEdits"]))
        );
        // Los que solo contestan texto no cambian.
        assert_eq!(editing("ai:llm"), Ok(Vec::new()));
        // Saltarse los permisos del todo solo está en «Omitir permisos», y
        // nunca es el modo de fábrica, con ningún ajuste.
        for spec in ONE_SHOT {
            for arg in spec.head.iter().chain(spec.tail) {
                assert!(
                    !arg.contains("dangerously") && !arg.contains("bypass") && *arg != "yolo",
                    "{}: {arg}",
                    spec.ai
                );
            }
            for mode in spec.modes.iter().filter(|mode| mode.id != "bypass") {
                for arg in mode.args {
                    assert!(
                        !arg.contains("dangerously") && !arg.contains("bypass") && *arg != "yolo",
                        "{} {}: {arg}",
                        spec.ai,
                        mode.id
                    );
                }
            }
            // Grok no tiene otro modo: sin los dos ajustes no se lanza (ver
            // `grok_solo_con_omitir_permisos_y_su_json_se_lee_como_texto`).
            if spec.ai == "grok" || spec.ai == "amp" {
                continue;
            }
            for can_edit in [false, true] {
                let default = default_mode(spec, can_edit).map(|mode| mode.id);
                assert_ne!(default, Some("bypass"), "{}", spec.ai);
                if !can_edit {
                    assert!(
                        !default.is_some_and(mode_edits),
                        "{} edita de fábrica",
                        spec.ai
                    );
                }
            }
            // El primero (el de fábrica) solo lee, salvo Grok, que no tiene
            // otro: entonces sin los dos ajustes no se lanza.
            if let Some(first) = spec.modes.first() {
                if spec.ai == "grok" {
                    assert_eq!(
                        one_shot_args_with("ai:grok", &[], Choice::default(), EDIT),
                        Err("mode-needs-bypass")
                    );
                } else if spec.ai == "amp" {
                    assert_eq!(
                        one_shot_args_with("ai:amp", &[], Choice::default(), Allowed::default()),
                        Err("mode-needs-edit")
                    );
                } else {
                    assert!(!mode_edits(first.id), "{}: {}", spec.ai, first.id);
                }
            }
        }
    }

    /// Los modos del menú de Claude (14-11, Romen: «los permisos tmb»), con
    /// la opción que entiende cada CLI y lo que piden los ajustes.
    #[test]
    fn los_modos_de_permisos_van_con_su_opcion_y_sus_ajustes() {
        assert_eq!(
            in_mode("ai:claude", "plan", Allowed::default()),
            Ok(strings(&["-p", "--permission-mode", "plan"]))
        );
        assert_eq!(
            in_mode("ai:claude", "manual", Allowed::default()),
            Ok(strings(&["-p"]))
        );
        assert_eq!(
            in_mode("ai:claude", "auto", EDIT),
            Ok(strings(&["-p", "--permission-mode", "auto"]))
        );
        assert_eq!(
            in_mode("ai:claude", "bypass", ALL),
            Ok(strings(&["-p", "--dangerously-skip-permissions"]))
        );
        assert_eq!(
            in_mode("ai:codex", "bypass", ALL),
            Ok(strings(&[
                "exec",
                "--skip-git-repo-check",
                "--color",
                "never",
                "--dangerously-bypass-approvals-and-sandbox",
                "-"
            ]))
        );
        assert_eq!(
            in_mode("ai:qwen", "auto", EDIT),
            Ok(strings(&["--approval-mode", "auto"]))
        );
        assert_eq!(
            in_mode("ai:gemini", "bypass", ALL),
            Ok(strings(&["--skip-trust", "--approval-mode", "yolo"]))
        );
        assert_eq!(
            in_mode("ai:copilot", "bypass", ALL),
            Ok(strings(&["--allow-all-tools", "--silent"]))
        );
        // Sin el ajuste, lo que edita se rechaza (no se cambia por otro).
        for id in [
            "ai:claude",
            "ai:codex",
            "ai:qwen",
            "ai:gemini",
            "ai:copilot",
        ] {
            assert_eq!(
                in_mode(id, "acceptEdits", Allowed::default()),
                Err("mode-needs-edit"),
                "{id}"
            );
            assert_eq!(
                in_mode(id, "bypass", EDIT),
                Err("mode-needs-bypass"),
                "{id}"
            );
            assert_eq!(
                in_mode(
                    id,
                    "bypass",
                    Allowed {
                        edit: false,
                        bypass: true
                    }
                ),
                Err("mode-needs-edit"),
                "{id}"
            );
        }
        // Un modo que ese agente no tiene, tampoco.
        assert_eq!(in_mode("ai:gemini", "auto", ALL), Err("unsupported-mode"));
        assert_eq!(in_mode("ai:codex", "plan", ALL), Err("unsupported-mode"));
        assert_eq!(in_mode("ai:llm", "manual", ALL), Err("unsupported-mode"));
        assert_eq!(in_mode("ai:claude", "todo", ALL), Err("unsupported-mode"));
        // El panel ofrece los de cada uno, en orden.
        let ids = |ai: &str| -> Vec<&str> {
            spec_for(ai)
                .unwrap()
                .modes
                .iter()
                .map(|mode| mode.id)
                .collect()
        };
        assert_eq!(
            ids("ai:claude"),
            ["manual", "plan", "acceptEdits", "auto", "bypass"]
        );
        assert_eq!(ids("ai:gemini"), ["plan", "acceptEdits", "bypass"]);
        assert!(ids("ai:crush").is_empty(), "crush run no tiene --yolo");
    }

    /// Ultracode y el modo rápido (14-11, Romen con el menú de Claude).
    #[test]
    fn ultracode_y_el_modo_rapido_van_con_su_opcion() {
        assert_eq!(
            with("ai:claude", None, Some("ultracode")),
            Ok(strings(&["-p", "--effort", "ultracode"]))
        );
        assert_eq!(answer_timeout(Some("ultracode")), ULTRACODE_TIMEOUT);
        assert_eq!(answer_timeout(Some("max")), ANSWER_TIMEOUT);
        assert_eq!(answer_timeout(None), ANSWER_TIMEOUT);
        // Ultracode es de Claude Code; Codex no lo tiene.
        assert_eq!(
            with("ai:codex", None, Some("ultracode")),
            Err("invalid-effort")
        );
        let fast = |id: &str| {
            let choice = Choice {
                fast: true,
                ..Choice::default()
            };
            one_shot_args_with(id, &[], choice, Allowed::default())
        };
        let settings = claude_fast_settings().to_string_lossy().to_string();
        assert_eq!(
            fast("ai:claude"),
            Ok(vec!["-p".to_string(), "--settings".to_string(), settings])
        );
        assert_eq!(
            fast("ai:codex"),
            Ok(strings(&[
                "exec",
                "--skip-git-repo-check",
                "--color",
                "never",
                "-s",
                "read-only",
                "-c",
                "service_tier=fast",
                "-"
            ]))
        );
        assert_eq!(fast("ai:qwen"), Err("unsupported-option"));
        // Sin comillas en la orden: el archivo no tiene espacios raros ni %.
        assert!(!claude_fast_settings()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(['%', '"', ' ']));
    }

    /// El catálogo de Codex (`codex debug models`, 14-11): solo los
    /// visibles, en su orden, con la intensidad que admite cada uno.
    #[test]
    fn el_catalogo_de_codex_da_sus_modelos_visibles_y_su_intensidad() {
        let json = r#"{"models":[
            {"slug":"gpt-6-astra","visibility":"list","priority":2,"supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"}],"service_tiers":[{"id":"priority","name":"Fast"}]},
            {"slug":"gpt-6.1-sol","visibility":"list","priority":1,"supported_reasoning_levels":[{"effort":"medium"},{"effort":"mega"}]},
            {"slug":"gpt-daybreak-blue-latest","visibility":"hide","priority":11,"supported_reasoning_levels":[]},
            {"slug":"raro & calc","visibility":"list","priority":3}
        ]}"#;
        assert_eq!(
            codex_catalog(json),
            vec![
                CodexModel {
                    slug: "gpt-6.1-sol".to_string(),
                    efforts: strings(&["medium"]),
                    fast: false,
                },
                CodexModel {
                    slug: "gpt-6-astra".to_string(),
                    efforts: strings(&["low", "ultra"]),
                    fast: true,
                },
            ]
        );
        assert!(codex_catalog("no es json").is_empty());
    }

    /// Los nombres de modelo del paquete instalado de Gemini y de Qwen, con
    /// un filtro estricto y del más nuevo al más viejo.
    #[test]
    fn los_modelos_de_gemini_y_qwen_salen_de_su_paquete() {
        let bundle = r#"x = "gemini-2.5-pro"; y = "gemini-3-flash-preview"; z = "gemini-3.1-pro-preview-customtools"; "gemini-3-flash-base"; "gemini-3"; "gemini-2.5-flash-lite"; "gemini-3.1-pro-preview"; "gemini-2.5-pro""#;
        assert_eq!(
            bundle_models(bundle, "gemini"),
            strings(&[
                "gemini-3.1-pro-preview",
                "gemini-3-flash-preview",
                "gemini-2.5-pro",
                "gemini-2.5-flash-lite"
            ])
        );
        let qwen = r#""qwen-oauth" "qwen3.8-max" "qwen3.7-plus" "qwen-code" "qwen3.8-flash" "qwen3-coder-plus""#;
        assert_eq!(
            bundle_models(qwen, "qwen"),
            strings(&[
                "qwen3.8-max",
                "qwen3.8-flash",
                "qwen3.7-plus",
                "qwen3-coder-plus"
            ])
        );
    }

    #[test]
    fn el_modelo_de_fabrica_sale_de_la_configuracion_de_cada_agente() {
        assert_eq!(
            json_model(r#"{"model":"opus"}"#, &["/model"]).as_deref(),
            Some("opus")
        );
        // Gemini y Qwen lo guardan dentro de `model.name`.
        assert_eq!(
            json_model(
                r#"{"model":{"name":"gemini-2.5-pro"}}"#,
                &["/model/name", "/model"]
            )
            .as_deref(),
            Some("gemini-2.5-pro")
        );
        assert_eq!(json_model("no es json", &["/model"]), None);
        // Nada que un `.cmd` pudiera interpretar, aunque venga de un archivo.
        assert_eq!(json_model(r#"{"model":"opus & calc"}"#, &["/model"]), None);
        assert_eq!(
            toml_model("model = \"gpt-5-codex\"\nmodel_reasoning_effort = \"high\"\n").as_deref(),
            Some("gpt-5-codex")
        );
        assert_eq!(
            yaml_value(
                "default-model: gpt-4o # el de siempre\napis:\n  openai:\n",
                "default-model"
            )
            .as_deref(),
            Some("gpt-4o")
        );
        assert_eq!(
            yaml_value("model: 'openai:gpt-4o'\n", "model").as_deref(),
            Some("openai:gpt-4o")
        );
        // Una clave con sangría es de otra sección.
        assert_eq!(yaml_value("clients:\n  model: x\n", "model"), None);
        assert_eq!(
            env_file_value(
                "CHAT_CACHE_LENGTH=100\nDEFAULT_MODEL=gpt-4o\n",
                "DEFAULT_MODEL"
            )
            .as_deref(),
            Some("gpt-4o")
        );
        assert_eq!(
            llm_models("OpenAI Chat: gpt-4o (aliases: 4o)\nOpenAI Chat: gpt-4o-mini\n"),
            ["gpt-4o", "gpt-4o-mini"]
        );
        assert_eq!(
            line_models("openai:gpt-4o\n\nollama:qwen3:8b\n"),
            ["openai:gpt-4o", "ollama:qwen3:8b"]
        );
        // El de fábrica primero y sin repetir.
        assert_eq!(
            merge_models(
                Some("opus"),
                vec!["sonnet".into(), "opus".into()],
                &["fable", "opus"]
            ),
            ["opus", "sonnet", "fable"]
        );
    }

    /// Los mensajes reales que vio Romen el 13-11 al probar todos los agentes.
    #[test]
    fn cada_fallo_real_ofrece_lo_que_lo_arregla() {
        let python = "Traceback (most recent call last):\n  File \"<frozen runpy>\", line 198, in _run_module_as_main\n  File \"E:\\WTerminal\\entornos\\herramientas\\python\\Python312\\Scripts\\llm.EXE\\__main__.py\", line 4, in <module>\nModuleNotFoundError: No module named 'llm'";
        let help = classify_failure("ai:llm", python, true);
        assert!(help.python_module);
        assert_eq!((help.api_key.clone(), help.open_tab), (None, None));

        let qwen = "No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.";
        assert_eq!(
            classify_failure("ai:qwen", qwen, true).open_tab,
            Some("login")
        );

        let aichat = "Error: Failed to load config at 'C:\\Users\\Administrador\\AppData\\Roaming\\aichat\\config.yaml'\n\nCaused by:\n    El sistema no puede encontrar la ruta especificada. (os error 3)";
        assert_eq!(
            classify_failure("ai:aichat", aichat, true).open_tab,
            Some("setup")
        );

        let mods = "ERROR  OpenAI authentication failed\n\n  You can grab one at https://platform.openai.com/account/api-keys";
        let help = classify_failure("ai:mods", mods, true);
        assert_eq!(help.open_tab, None, "mods no tiene inicio de sesión propio");
        if crate::environments::ai_keys::supported() {
            assert_eq!(
                help.api_key.map(|offer| offer.env_var),
                Some("OPENAI_API_KEY".to_string())
            );
        }
        // Con «ofrecer la clave» apagado, no se ofrece.
        assert_eq!(classify_failure("ai:mods", mods, false).api_key, None);

        // Claude Code sin sesión: las dos salidas.
        let claude = "Invalid API key · Please run /login";
        let help = classify_failure("ai:claude", claude, true);
        assert_eq!(help.open_tab, Some("login"));
        if crate::environments::ai_keys::supported() {
            assert!(help.api_key.is_some());
        }

        // Un error cualquiera no ofrece nada.
        assert_eq!(
            classify_failure("ai:codex", "stream disconnected", true),
            FailureHelp::default()
        );

        // 14-11, capturas de Romen con la 62. Crush sin proveedor: abrirlo
        // para configurarlo (antes no ofrecía nada).
        let crush = "ERROR\n\n  No providers configured - please run 'crush' to set up a provider interactively.";
        assert_eq!(
            classify_failure("ai:crush", crush, true).open_tab,
            Some("setup")
        );
        // Codex sin sesión: iniciarla en su pestaña.
        let codex = "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
        assert_eq!(
            classify_failure("ai:codex", codex, true).open_tab,
            Some("login")
        );
        // Copilot sin sesión.
        let copilot = "Error: No authentication information found.\n\nCopilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.\n  • Start 'copilot' and run the '/login' command";
        assert_eq!(
            classify_failure("ai:copilot", copilot, true).open_tab,
            Some("login")
        );
    }

    /// ShellGPT sin clave ni configuración pide la clave por consola y se
    /// queda colgado (14-11): no se lanza y se ofrece la clave.
    #[test]
    fn shellgpt_sin_clave_no_se_lanza_para_quedarse_colgado() {
        assert!(sgpt_would_prompt(false, false));
        assert!(
            !sgpt_would_prompt(true, false),
            "con su .sgptrc no pregunta"
        );
        assert!(!sgpt_would_prompt(false, true), "con la clave no pregunta");
        let home = tempfile::tempdir().unwrap();
        // Solo ShellGPT: los demás fallan solos, sin colgarse.
        assert_eq!(asks_key_on_console("ai:llm", home.path()), None);
        let config = home.path().join(".config").join("shell_gpt");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join(".sgptrc"), "DEFAULT_MODEL=gpt-4o\n").unwrap();
        assert_eq!(asks_key_on_console("ai:sgpt", home.path()), None);
        // Sin su archivo, depende de si hay clave en el entorno o guardada.
        std::fs::remove_file(config.join(".sgptrc")).unwrap();
        let has_key = std::env::var_os("OPENAI_API_KEY").is_some_and(|value| !value.is_empty())
            || crate::environments::ai_keys::has_key("OPENAI_API_KEY");
        assert_eq!(
            asks_key_on_console("ai:sgpt", home.path()),
            (!has_key).then_some("OPENAI_API_KEY")
        );
    }

    /// Una respuesta cuya CLI ya salió se da por acabada aunque otro proceso
    /// mantenga abierta la salida (Ollama, 14-11).
    #[test]
    fn la_respuesta_acaba_al_salir_la_cli_aunque_la_salida_siga_abierta() {
        let ms = Duration::from_millis;
        // Recién salida y con salida reciente: se espera a lo que falte.
        assert!(!answer_settled(ms(50), ms(50)));
        assert!(!answer_settled(ms(1000), ms(100)));
        // Sin nada nuevo desde hace un rato: entera.
        assert!(answer_settled(ms(400), ms(400)));
        // La salida llevaba quieta, pero la CLI acaba de salir: un poco más.
        assert!(!answer_settled(ms(100), ms(5000)));
        // Como mucho 1,5 s tras salir, aunque siga llegando algo.
        assert!(answer_settled(ANSWER_DRAIN_MAX, ms(0)));
    }

    /// Con una CLI de verdad que sale y deja un hijo vivo con la salida
    /// heredada: antes esperaba al hijo; ahora acaba enseguida.
    #[cfg(windows)]
    #[test]
    fn una_cli_que_deja_un_hijo_con_la_salida_no_deja_la_respuesta_abierta() {
        let mut command = crate::process::hidden_command("cmd");
        // `start /b` deja un `ping` de unos 5 s con la misma salida, que
        // acaba solo.
        command
            .args(["/d", "/c", "echo respuesta& start /b ping -n 6 127.0.0.1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        let mut child = command.spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let closed = Arc::new(AtomicBool::new(false));
        let last = Arc::new(Mutex::new(Instant::now()));
        {
            let closed = Arc::clone(&closed);
            let last = Arc::clone(&last);
            std::thread::spawn(move || {
                let mut buffer = [0u8; 256];
                while let Ok(read) = stdout.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    *last.lock() = Instant::now();
                }
                closed.store(true, Ordering::Release);
            });
        }
        let started = Instant::now();
        let code = wait_for_answer(&child, &closed, &last);
        assert_eq!(code, Some(0));
        // El `ping` sigue con la salida abierta otros ~5 s: no se le espera.
        assert!(
            !closed.load(Ordering::Acquire),
            "el hijo aún tenía la salida"
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
    }

    /// Grok en el chat (14-11): solo con «Omitir permisos», y su JSON se
    /// lee como texto.
    #[test]
    fn grok_solo_con_omitir_permisos_y_su_json_se_lee_como_texto() {
        assert_eq!(
            one_shot_args_with("ai:grok", &[], Choice::default(), Allowed::default()),
            Err("mode-needs-edit")
        );
        assert_eq!(
            one_shot_args_with("ai:grok", &[], Choice::default(), EDIT),
            Err("mode-needs-bypass")
        );
        assert_eq!(
            one_shot_args_with("ai:grok", &[], Choice::default(), ALL),
            Ok(Vec::new())
        );
        assert_eq!(
            one_shot_args_with(
                "ai:grok",
                &[],
                Choice {
                    model: Some("grok-4-latest"),
                    ..Choice::default()
                },
                ALL
            ),
            Ok(strings(&["-m", "grok-4-latest"]))
        );
        // Su salida real: el eco de la pregunta no, las herramientas en una
        // línea y la respuesta tal cual.
        assert_eq!(grok_answer_line(r#"{"role":"user","content":"hola"}"#), "");
        assert_eq!(
            grok_answer_line(
                r#"{"role":"assistant","content":"","tool_calls":[{"id":"1","type":"function","function":{"name":"view_file","arguments":"{}"}}]}"#
            ),
            "› view_file\n"
        );
        assert_eq!(
            grok_answer_line(r#"{"role":"tool","tool_call_id":"1","content":"..."}"#),
            ""
        );
        assert_eq!(
            grok_answer_line(r#"{"role":"assistant","content":"¡Hola! ¿En qué te ayudo?"}"#),
            "¡Hola! ¿En qué te ayudo?\n"
        );
        assert_eq!(grok_answer_line("aviso suelto"), "aviso suelto\n");
        // Su error va en la salida normal: el final se guarda para explicarlo.
        let mut tail = String::new();
        keep_tail(&mut tail, &"ñ".repeat(MAX_ERROR_CHARS));
        keep_tail(&mut tail, "Error: API key required. Set GROK_API_KEY");
        assert_eq!(tail.chars().count(), MAX_ERROR_CHARS);
        assert!(tail.ends_with("Set GROK_API_KEY"));
    }

    /// Continue, opencode y Amp en el chat (14-11), cada uno con lo que de
    /// verdad admite.
    #[test]
    fn continue_opencode_y_amp_con_sus_modos() {
        assert_eq!(
            one_shot_args_with("ai:continue", &[], Choice::default(), Allowed::default()),
            Ok(strings(&["--silent", "--readonly"]))
        );
        assert_eq!(
            in_mode("ai:continue", "bypass", ALL),
            Ok(strings(&["--silent", "--auto"]))
        );
        assert_eq!(
            one_shot_args_with("ai:opencode", &[], Choice::default(), Allowed::default()),
            Ok(strings(&["run", "--agent", "plan"]))
        );
        assert_eq!(
            in_mode("ai:opencode", "bypass", EDIT),
            Err("mode-needs-bypass")
        );
        assert_eq!(
            one_shot_args_with(
                "ai:opencode",
                &[],
                Choice {
                    model: Some("anthropic/claude-sonnet-4"),
                    ..Choice::default()
                },
                Allowed::default()
            ),
            Ok(strings(&[
                "run",
                "--agent",
                "plan",
                "-m",
                "anthropic/claude-sonnet-4"
            ]))
        );
        assert_eq!(
            spec_for("ai:opencode").unwrap().prompt_flag,
            Some(PROMPT_POSITIONAL)
        );
        // Amp: con «Dejar editar», `-x` y la pregunta por la entrada.
        assert_eq!(
            one_shot_args_with("ai:amp", &[], Choice::default(), EDIT),
            Ok(strings(&["-x"]))
        );
        assert_eq!(spec_for("ai:amp").unwrap().prompt_flag, None);
    }

    /// «Otro…» solo donde la lista puede estar incompleta (14-11).
    #[test]
    fn escribir_el_modelo_a_mano_solo_si_la_lista_no_es_completa() {
        for ai in ["codex", "gemini", "qwen", "llm", "aichat"] {
            assert!(!custom_model_allowed(ai, 5), "{ai} con lista");
            assert!(custom_model_allowed(ai, 0), "{ai} sin lista");
        }
        assert!(!custom_model_allowed("claude", 0), "Claude: sus alias");
        for ai in ["copilot", "crush", "mods", "sgpt"] {
            assert!(custom_model_allowed(ai, 0), "{ai}");
        }
    }

    #[test]
    fn lo_que_no_vale_para_ese_agente_se_rechaza_y_no_se_ignora() {
        assert_eq!(
            with("ai:qwen", None, Some("high")),
            Err("unsupported-option")
        );
        assert_eq!(
            with("ai:claude", None, Some("turbo")),
            Err("invalid-effort")
        );
        // Codex admite de `low` a `ultra` (su catálogo); otra cosa, no.
        assert_eq!(with("ai:codex", None, Some("turbo")), Err("invalid-effort"));
        assert_eq!(
            one_shot_args_with(
                "ai:ollama:qwen3:8b",
                &strings(&["run", "qwen3:8b"]),
                Choice {
                    model: Some("x"),
                    ..Choice::default()
                },
                Allowed::default()
            ),
            Err("unsupported-option")
        );
        // Nada que un `.cmd` pudiera interpretar.
        for bad in [
            "opus & calc",
            "o3\"",
            "%PATH%",
            "a|b",
            "-p",
            "../x y",
            "^x",
            "a".repeat(81).as_str(),
        ] {
            assert_eq!(
                with("ai:claude", Some(bad), None),
                Err("invalid-model"),
                "{bad}"
            );
        }
        for good in [
            "opus",
            "claude-opus-5-5",
            "qwen3:8b",
            "openai/gpt-4o",
            "gpt-4.1@2026",
        ] {
            assert!(valid_model(good), "{good}");
        }
    }

    #[test]
    fn cada_agente_dice_que_se_le_puede_elegir() {
        let claude = spec_for("ai:claude").unwrap();
        assert_eq!(claude.models, &["fable", "opus", "sonnet"]);
        assert_eq!(
            claude.effort.unwrap().levels,
            &["low", "medium", "high", "xhigh", "max", "ultracode"]
        );
        assert!(spec_for("ai:gemini").is_some());
        // Todos dejan elegir modelo (Crush también, desde el 14-11), menos
        // Amp, que no tiene esa opción.
        for spec in ONE_SHOT.iter().filter(|spec| spec.ai != "amp") {
            assert!(spec.model_flag.is_some(), "{} sin modelo", spec.ai);
        }
        // Copilot: sin shell ni escribir de fábrica; con el ajuste, escribe.
        assert_eq!(
            one_shot_args_with("ai:copilot", &[], Choice::default(), Allowed::default()),
            Ok(strings(&[
                "--allow-all-tools",
                "--silent",
                "--deny-tool",
                "shell",
                "--deny-tool",
                "write"
            ]))
        );
        assert_eq!(
            one_shot_args_with("ai:copilot", &[], Choice::default(), EDIT),
            Ok(strings(&[
                "--allow-all-tools",
                "--silent",
                "--deny-tool",
                "shell"
            ]))
        );
        // Las que no entran dicen por qué (el panel lo enseña).
        assert_eq!(unavailable_reason("ai:grok"), "needs-bypass");
        assert_eq!(unavailable_reason("ai:amp"), "needs-edit");
        assert_eq!(unavailable_reason("ai:aider"), "edits-files");
        assert_eq!(unavailable_reason("ai:cursor"), "no-one-shot");
    }

    #[test]
    fn un_adjunto_de_texto_se_lee_y_lo_demas_se_rechaza() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notas.txt");
        std::fs::write(&text, "hola\nadiós\n").unwrap();
        let read = read_attachment(&text).unwrap();
        assert_eq!(read.name, "notas.txt");
        assert_eq!(read.text, "hola\nadiós\n");
        assert!(!read.truncated);

        let binary = dir.path().join("imagen.bin");
        std::fs::write(&binary, [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        assert_eq!(read_attachment(&binary).unwrap_err(), "binary");

        // Uno grande se corta en el tope, sin partir un carácter.
        let big = dir.path().join("grande.txt");
        std::fs::write(&big, "ñ".repeat(MAX_ATTACHMENT_BYTES)).unwrap();
        let read = read_attachment(&big).unwrap();
        assert!(read.truncated);
        assert!(read.text.len() <= MAX_ATTACHMENT_BYTES);
        assert!(read.text.chars().all(|c| c == 'ñ'));

        assert_eq!(read_attachment(dir.path()).unwrap_err(), "not-a-file");
        assert_eq!(
            read_attachment(&dir.path().join("no-existe.txt")).unwrap_err(),
            "not-found"
        );
    }
}
