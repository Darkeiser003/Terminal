//! `wterminal --ctl <orden>`: las IA que lanza WTerminal lo manejan (14-11,
//! Romen: «que le mande esa ayuda y permita que gestione la terminal lo
//! máximo posible»).
//!
//! - **Quién puede:** solo los procesos que WTerminal lanza para una IA (sus
//!   pestañas y las preguntas del chat) reciben `WTERMINAL_CTL` (la dirección,
//!   en 127.0.0.1) y `WTERMINAL_CTL_TOKEN` (una llave aleatoria de cada
//!   arranque). Sin la llave, nada se atiende. Con `agentControl` apagado, ni
//!   se publica ni se atiende.
//! - **Qué pueden pedir** ([`classify`]): una orden interna (`:panes 2`,
//!   `:shell pwsh`, `:theme …`), buscar en el catálogo (`acciones <texto>`) o
//!   lanzar una acción de Entorno y dependencias (`accion <id>`).
//! - **Qué pide permiso:** las acciones (instalar, actualizar, desinstalar) y
//!   `:set`: el usuario lo ve en un aviso con «Permitir», «Permitir en esta
//!   sesión» y «Denegar».
//! - **Qué nunca:** cambiar los permisos del chat, la guía, este mismo control
//!   ni la seguridad ([`BLOCKED_SETTINGS`]).
//! - **Dónde:** el frontend escribe la orden en una pestaña de shell con el
//!   prompt vacío, como si la tecleara el usuario (`submitLine`), así que se ve
//!   lo que hizo; nunca en la pestaña de la propia IA.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// El argumento de la orden (`wterminal --ctl :panes 2`).
pub const CTL_ARG: &str = "--ctl";
/// Variables que reciben los procesos de las IA.
pub const ENV_ADDR: &str = "WTERMINAL_CTL";
pub const ENV_TOKEN: &str = "WTERMINAL_CTL_TOKEN";
/// La pestaña de la propia IA: ahí nunca se escribe.
pub const ENV_TAB: &str = "WTERMINAL_TAB_ID";
/// Cabecera del protocolo: una línea `WTCTL1 <llave> <pestaña o ->` y otra
/// con la orden; la respuesta, una línea con el código y el texto.
const HEADER: &str = "WTCTL1";
/// Lo que se espera a que el usuario conteste un permiso.
const REPLY_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_COMMAND_CHARS: usize = 2_000;

/// Ajustes que una IA nunca puede cambiar con `--ctl :set`: los permisos del
/// chat, la guía, este control y la seguridad.
pub const BLOCKED_SETTINGS: &[&str] = &[
    "agentChat",
    "agentChatCanEdit",
    "agentChatAllowBypass",
    "agentChatGuide",
    "agentTabGuide",
    "agentControl",
    "aiKeyOffer",
    "startAsAdmin",
    "terminalAdminByDefault",
    "terminalLinksConfirm",
    "offerGsudo",
];

struct Server {
    addr: String,
    token: String,
}

static SERVER: OnceCell<Server> = OnceCell::new();
static NEXT: AtomicU64 = AtomicU64::new(0);
/// Las órdenes que esperan la respuesta de la ventana: id → por dónde llega
/// (`true` si se hizo, y el texto para la IA).
type Pending = HashMap<u64, mpsc::Sender<(bool, String)>>;
static PENDING: Lazy<Mutex<Pending>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Lo que pide la IA.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Una orden interna (`:…`); `confirm`: pide permiso (`:set`).
    Internal { command: String, confirm: bool },
    /// Buscar acciones del catálogo por texto (se contesta aquí mismo).
    Search(String),
    /// Lanzar una acción del catálogo (siempre pide permiso).
    Action(String),
}

/// Qué es lo pedido, o por qué se rechaza. Pura: se prueba sin servidor.
pub fn classify(command: &str) -> Result<Request, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(
            "Falta la orden. Ejemplos: :panes 2 · :shell pwsh · acciones python · accion <id>"
                .into(),
        );
    }
    if command.chars().count() > MAX_COMMAND_CHARS || command.contains(['\n', '\r']) {
        return Err("La orden tiene que ser una sola línea corta.".into());
    }
    if let Some(rest) = command.strip_prefix(':') {
        let mut words = rest.split_whitespace();
        let verb = words.next().unwrap_or("").to_lowercase();
        if matches!(verb.as_str(), "set" | "ajuste" | "pref") {
            let key = words.next().unwrap_or("");
            let wanted = key.replace('-', "").to_lowercase();
            if BLOCKED_SETTINGS
                .iter()
                .any(|blocked| blocked.to_lowercase() == wanted)
            {
                return Err(format!(
                    "«{key}» no se puede cambiar desde una IA: son los permisos del chat, este control o la seguridad. Díselo al usuario."
                ));
            }
            // Ver un ajuste o la lista no cambia nada; ponerlo, sí.
            let changes = words.next().is_some() && key != "list" && key != "lista";
            return Ok(Request::Internal {
                command: command.to_string(),
                confirm: changes,
            });
        }
        return Ok(Request::Internal {
            command: command.to_string(),
            confirm: false,
        });
    }
    let mut words = command.splitn(2, char::is_whitespace);
    let verb = words.next().unwrap_or("").to_lowercase();
    let rest = words.next().unwrap_or("").trim().to_string();
    match verb.as_str() {
        "acciones" | "actions" | "buscar" => Ok(Request::Search(rest)),
        "accion" | "acción" | "action" => {
            if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
                return Err("Falta el id de la acción (sale con: acciones <texto>).".into());
            }
            Ok(Request::Action(rest))
        }
        _ => Err(format!(
            "No sé hacer «{command}». Usa una orden interna (:panes 2, :shell pwsh, :panel deps, :set list) o acciones <texto> / accion <id>. La guía: wterminal --agent-guide internos"
        )),
    }
}

/// Lo que va al frontend para que lo haga (y pida permiso si toca).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlEvent {
    id: u64,
    /// La pestaña de la IA que lo pide (ahí no se escribe), si se sabe.
    agent_tab: Option<String>,
    /// `internal` o `action`.
    kind: &'static str,
    /// La orden interna o el id de la acción.
    value: String,
    confirm: bool,
}

/// Arranca el servidor (una vez). Con `agentControl` apagado no se arranca.
pub fn start(app: AppHandle) {
    if !crate::preferences::current().agent_control || SERVER.get().is_some() {
        return;
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            log_warn!(
                "No se pudo abrir el control de las IA",
                serde_json::json!({ "error": error.to_string() })
            );
            return;
        }
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    let token = random_token();
    if SERVER
        .set(Server {
            addr: addr.to_string(),
            token,
        })
        .is_err()
    {
        return;
    }
    log_info!(
        "Control de las IA abierto",
        serde_json::json!({ "addr": addr.to_string() })
    );
    std::thread::Builder::new()
        .name("agent-control".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                std::thread::spawn(move || handle(stream, app));
            }
        })
        .ok();
}

/// Las variables para un proceso de IA que lanza WTerminal (`tab`: su
/// pestaña, si tiene). Vacío con el control apagado o sin servidor.
pub fn spawn_env(tab: Option<&str>) -> Vec<(String, String)> {
    let Some(server) = SERVER.get() else {
        return Vec::new();
    };
    if !crate::preferences::current().agent_control {
        return Vec::new();
    }
    let mut vars = vec![
        (ENV_ADDR.to_string(), server.addr.clone()),
        (ENV_TOKEN.to_string(), server.token.clone()),
    ];
    if let Some(tab) = tab {
        vars.push((ENV_TAB.to_string(), tab.to_string()));
    }
    vars
}

/// `agentControl:reply`: lo que contestó el frontend (hecho, o el motivo).
#[tauri::command]
pub fn agent_control_reply(id: u64, ok: bool, text: String) {
    if let Some(sender) = PENDING.lock().remove(&id) {
        let _ = sender.send((ok, text));
    }
}

fn handle(stream: TcpStream, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.take(8_192));
    let mut header = String::new();
    let mut command = String::new();
    if reader.read_line(&mut header).is_err() || reader.read_line(&mut command).is_err() {
        return;
    }
    let mut stream = reader.into_inner().into_inner();
    let (ok, text) = answer(&app, header.trim(), command.trim());
    let _ = stream.write_all(format!("{}\n{text}\n", if ok { 0 } else { 1 }).as_bytes());
}

fn answer(app: &AppHandle, header: &str, command: &str) -> (bool, String) {
    let Some(server) = SERVER.get() else {
        return (false, "El control está apagado.".into());
    };
    let mut parts = header.split_whitespace();
    if parts.next() != Some(HEADER) || !same_token(parts.next().unwrap_or(""), &server.token) {
        log_warn!("Control de las IA: llave incorrecta");
        return (false, "Llave incorrecta.".into());
    }
    if !crate::preferences::current().agent_control {
        return (
            false,
            "El usuario apagó el control de las IA (agentControl).".into(),
        );
    }
    let agent_tab = parts.next().filter(|tab| *tab != "-").map(str::to_string);
    let request = match classify(command) {
        Ok(request) => request,
        Err(reason) => return (false, reason),
    };
    log_info!(
        "Control de las IA",
        serde_json::json!({ "command": command, "agentTab": agent_tab })
    );
    let (kind, value, confirm) = match request {
        Request::Search(query) => return (true, search_actions(app, &query)),
        Request::Internal { command, confirm } => ("internal", command, confirm),
        Request::Action(id) => ("action", id, true),
    };
    let id = NEXT.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = mpsc::channel();
    PENDING.lock().insert(id, sender);
    let event = ControlEvent {
        id,
        agent_tab,
        kind,
        value,
        confirm,
    };
    if app.emit("agent-control", event).is_err() {
        PENDING.lock().remove(&id);
        return (false, "WTerminal no pudo recibir la orden.".into());
    }
    match receiver.recv_timeout(REPLY_TIMEOUT) {
        Ok(reply) => reply,
        Err(_) => {
            PENDING.lock().remove(&id);
            (
                false,
                "Sin respuesta del usuario a tiempo: no se hizo.".into(),
            )
        }
    }
}

/// Las acciones del catálogo que casan con el texto: id y nombre, hasta 25.
fn search_actions(app: &AppHandle, query: &str) -> String {
    let state = app.state::<std::sync::Arc<crate::state::AppState>>();
    let found = crate::packages::commands::search_actions(&state, query, 25);
    if found.is_empty() {
        return format!("Nada en el catálogo con «{query}».");
    }
    let mut text = String::from("id\tnombre (lánzala con: accion <id>)\n");
    for (id, label) in found {
        text.push_str(&format!("{id}\t{label}\n"));
    }
    text
}

fn same_token(given: &str, expected: &str) -> bool {
    // Sin atajos: el mismo tiempo acierte o no.
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// 24 bytes del generador del sistema, en hexadecimal.
fn random_token() -> String {
    let mut bytes = [0u8; 24];
    if !system_random(&mut bytes) {
        // Sin generador del sistema: reloj, proceso y contador, mejor que nada.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
            ^ (u128::from(std::process::id()) << 64)
            ^ u128::from(NEXT.fetch_add(1, Ordering::Relaxed));
        bytes[..16].copy_from_slice(&seed.to_le_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(windows)]
fn system_random(bytes: &mut [u8]) -> bool {
    use windows::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };
    // SAFETY: búfer válido y sin algoritmo propio (el preferido del sistema).
    unsafe { BCryptGenRandom(None, bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.is_ok()
}

#[cfg(not(windows))]
fn system_random(bytes: &mut [u8]) -> bool {
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .is_ok()
}

/// `wterminal --ctl <orden…>`: la manda al WTerminal que lanzó a esta IA y
/// escribe la respuesta. Devuelve el código de salida.
pub fn run_cli(args: &[String]) -> i32 {
    let command = args.join(" ");
    let (Ok(addr), Ok(token)) = (std::env::var(ENV_ADDR), std::env::var(ENV_TOKEN)) else {
        eprintln!(
            "wterminal --ctl solo funciona dentro de una IA que haya lanzado WTerminal (con agentControl encendido)."
        );
        return 2;
    };
    let tab = std::env::var(ENV_TAB).unwrap_or_else(|_| "-".to_string());
    let reply = (|| -> std::io::Result<String> {
        let mut stream = TcpStream::connect(addr.as_str())?;
        stream.set_read_timeout(Some(REPLY_TIMEOUT + Duration::from_secs(10)))?;
        stream.write_all(format!("{HEADER} {token} {tab}\n{command}\n").as_bytes())?;
        let mut reply = String::new();
        stream.read_to_string(&mut reply)?;
        Ok(reply)
    })();
    match reply {
        Ok(reply) => {
            let (code, text) = reply.split_once('\n').unwrap_or(("1", reply.as_str()));
            let mut out = std::io::stdout();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
            code.trim().parse().unwrap_or(1)
        }
        Err(error) => {
            eprintln!("No se pudo hablar con WTerminal: {error}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_orden_se_clasifica_y_lo_peligroso_pide_permiso_o_se_niega() {
        assert_eq!(
            classify(":panes 2"),
            Ok(Request::Internal {
                command: ":panes 2".into(),
                confirm: false
            })
        );
        // Mirar ajustes no cambia nada; ponerlos pide permiso.
        assert!(matches!(
            classify(":set list"),
            Ok(Request::Internal { confirm: false, .. })
        ));
        assert!(matches!(
            classify(":set terminalFontSize"),
            Ok(Request::Internal { confirm: false, .. })
        ));
        assert!(matches!(
            classify(":set terminalFontSize 15"),
            Ok(Request::Internal { confirm: true, .. })
        ));
        // Los permisos del chat, este control y la seguridad, nunca.
        for blocked in [
            ":set agentChatAllowBypass on",
            ":set agent-chat-can-edit on",
            ":ajuste agentControl off",
            ":set startAsAdmin on",
            ":set agentchatguide off",
        ] {
            assert!(classify(blocked).is_err(), "{blocked}");
        }
        assert_eq!(
            classify("acciones python"),
            Ok(Request::Search("python".into()))
        );
        assert_eq!(
            classify("accion winget-gsudo"),
            Ok(Request::Action("winget-gsudo".into()))
        );
        assert!(classify("accion rm -rf").is_err());
        assert!(
            classify("del C:\\").is_err(),
            "nada que no sea de WTerminal"
        );
        assert!(classify(":panes 2\n:panes 3").is_err());
        assert!(classify("").is_err());
    }

    #[test]
    fn la_llave_se_compara_entera() {
        assert!(same_token("abc123", "abc123"));
        assert!(!same_token("abc124", "abc123"));
        assert!(!same_token("abc12", "abc123"));
        assert!(!same_token("", "abc123"));
        let token = random_token();
        assert_eq!(token.len(), 48);
        assert_ne!(token, random_token(), "una llave distinta cada vez");
    }
}
