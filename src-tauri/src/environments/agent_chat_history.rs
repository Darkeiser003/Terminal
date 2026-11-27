//! Historial de los chats con IA (23-11, Romen: «los chats de IA no tienen
//! historial […] si cierro la pestaña, aunque sea un segundo, se borra»).
//!
//! Cada conversación es un archivo `agent-chats/<id>.json` en la carpeta de
//! datos de la app; `agent-chats/session.json` dice qué chats estaban
//! abiertos y cuál se veía. El contenido lo arma la interfaz
//! (`src/lib/agent-chat-history.ts`): aquí solo se valida lo justo (el id,
//! que hace de nombre de archivo, y el tamaño) y se escribe sin dejar un
//! archivo a medias si la app se cierra en mitad de la escritura. Nada sale
//! del equipo.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::config::paths;

/// Un chat guardado no pasa de esto (las respuestas largas y los adjuntos
/// caben de sobra; un archivo mayor es un error de la interfaz).
pub const MAX_CHAT_BYTES: usize = 4 * 1024 * 1024;
/// Se guardan como mucho estos chats: al pasar, se borran los más antiguos
/// que no estén abiertos.
pub const MAX_CHATS: usize = 300;
const SESSION_FILE: &str = "session.json";
/// Los chats fijados arriba del historial (24-11). Va aparte del chat: así
/// fijar o desfijar (también desde `:chat unpin help`) no choca con el
/// guardado de un chat abierto.
const PINS_FILE: &str = "pins.json";
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Lo que enseña la lista del historial sin cargar cada conversación.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub messages: usize,
    /// Es el chat de ayuda: ahí van las preguntas del aviso de ayuda con IA
    /// cuando falla una orden (24-11).
    pub help: bool,
    /// Fijado arriba del historial (`pins.json`).
    pub pinned: bool,
}

fn history_dir() -> PathBuf {
    paths::user_data_dir().join("agent-chats")
}

/// El id hace de nombre de archivo: solo letras, números y guiones, sin
/// rutas ni nombres reservados.
pub fn valid_chat_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != "session"
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn chat_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Escribe en un temporal y lo renombra: un cierre a mitad deja el archivo
/// anterior entero.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn summary_of(chat: &Value) -> Option<ChatSummary> {
    let id = chat.get("id")?.as_str()?;
    if !valid_chat_id(id) {
        return None;
    }
    Some(ChatSummary {
        id: id.to_string(),
        title: text(chat, "title"),
        agent: text(chat, "agentLabel"),
        created_at: number(chat, "createdAt"),
        updated_at: number(chat, "updatedAt"),
        messages: chat
            .get("messages")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        help: chat.get("help").and_then(Value::as_bool).unwrap_or(false),
        pinned: false,
    })
}

/// Los ids de los chats abiertos según `session.json`.
fn open_ids(dir: &Path) -> Vec<String> {
    fs::read(dir.join(SESSION_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|session| {
            session.get("open").and_then(Value::as_array).map(|open| {
                open.iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

pub fn list_in(dir: &Path) -> Vec<ChatSummary> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut chats: Vec<ChatSummary> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.ends_with(".json") && name != SESSION_FILE && name != PINS_FILE
        })
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter_map(|chat| summary_of(&chat))
        .collect();
    let pins = pinned_ids(dir);
    for chat in &mut chats {
        chat.pinned = pins.contains(&chat.id);
    }
    chats.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
    chats
}

/// Los ids fijados (`pins.json`), sin los que no son ids válidos.
pub fn pinned_ids(dir: &Path) -> Vec<String> {
    fs::read(dir.join(PINS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| valid_chat_id(id))
        .collect()
}

/// Fija o desfija un chat. Un id puede fijarse antes de tener archivo (el
/// chat de ayuda recién creado aún no tiene mensajes).
pub fn set_pinned_in(dir: &Path, id: &str, pinned: bool) -> bool {
    if !valid_chat_id(id) {
        return false;
    }
    let mut pins = pinned_ids(dir);
    let had = pins.iter().any(|pin| pin == id);
    if pinned == had {
        return true;
    }
    if pinned {
        pins.push(id.to_string());
    } else {
        pins.retain(|pin| pin != id);
    }
    // Los ids de chats que ya no existen se van con cada cambio.
    let existing = |pin: &String| pin == id || chat_path(dir, pin).is_file();
    pins.retain(existing);
    serde_json::to_vec(&pins)
        .ok()
        .is_some_and(|bytes| write_atomic(&dir.join(PINS_FILE), &bytes).is_ok())
}

/// El chat de ayuda más reciente, para `:chat pin help` y `:chat unpin help`.
pub fn latest_help_in(dir: &Path) -> Option<String> {
    list_in(dir)
        .into_iter()
        .find(|chat| chat.help)
        .map(|chat| chat.id)
}

/// Borra los chats sin usarse en `days` días, salvo los abiertos y los
/// fijados (`agentChatCleanup`, apagado de fábrica). Devuelve cuántos.
pub fn cleanup_older_in(dir: &Path, days: i64, now_ms: f64) -> usize {
    if days <= 0 {
        return 0;
    }
    let limit = now_ms - days as f64 * DAY_MS;
    let open = open_ids(dir);
    let pins = pinned_ids(dir);
    list_in(dir)
        .iter()
        .filter(|chat| chat.updated_at > 0.0 && chat.updated_at < limit)
        .filter(|chat| !open.contains(&chat.id) && !pins.contains(&chat.id))
        .filter(|chat| fs::remove_file(chat_path(dir, &chat.id)).is_ok())
        .count()
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

pub fn save_in(dir: &Path, chat: &Value) -> Result<(), &'static str> {
    let id = chat
        .get("id")
        .and_then(Value::as_str)
        .ok_or("invalid-chat")?;
    if !valid_chat_id(id) {
        return Err("invalid-chat");
    }
    let bytes = serde_json::to_vec(chat).map_err(|_| "invalid-chat")?;
    if bytes.len() > MAX_CHAT_BYTES {
        return Err("too-big");
    }
    write_atomic(&chat_path(dir, id), &bytes).map_err(|_| "write-failed")?;
    prune_in(dir, MAX_CHATS);
    Ok(())
}

/// Deja como mucho `keep` chats: borra los más antiguos que no estén abiertos.
pub fn prune_in(dir: &Path, keep: usize) -> usize {
    let chats = list_in(dir);
    if chats.len() <= keep {
        return 0;
    }
    let open = open_ids(dir);
    let pins = pinned_ids(dir);
    let mut removed = 0;
    for chat in chats.iter().skip(keep) {
        if open.contains(&chat.id) || pins.contains(&chat.id) {
            continue;
        }
        if fs::remove_file(chat_path(dir, &chat.id)).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn load_in(dir: &Path, id: &str) -> Option<Value> {
    if !valid_chat_id(id) {
        return None;
    }
    let bytes = fs::read(chat_path(dir, id)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn delete_in(dir: &Path, id: &str) -> bool {
    let removed = valid_chat_id(id) && fs::remove_file(chat_path(dir, id)).is_ok();
    if removed {
        set_pinned_in(dir, id, false);
    }
    removed
}

/// Borra todos los chats guardados (y la sesión). Devuelve cuántos.
pub fn clear_in(dir: &Path) -> usize {
    let removed = list_in(dir)
        .iter()
        .filter(|chat| fs::remove_file(chat_path(dir, &chat.id)).is_ok())
        .count();
    let _ = fs::remove_file(dir.join(SESSION_FILE));
    let _ = fs::remove_file(dir.join(PINS_FILE));
    removed
}

// ---- La sesión propia del agente (24-11) ----

/// Dónde guarda Claude Code sus sesiones: `<CLAUDE_CONFIG_DIR o ~/.claude>/projects/<carpeta>/<id>.jsonl`.
fn claude_projects_dir(home: &Path) -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
        .join("projects")
}

/// Dónde guarda Codex las suyas: `<CODEX_HOME o ~/.codex>/sessions/AAAA/MM/DD/rollout-…-<id>.jsonl`.
fn codex_sessions_dir(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
        .join("sessions")
}

/// Un UUID en texto: lo único que se busca como nombre de sesión.
fn uuid_like(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Los archivos de esa sesión (como mucho 4 niveles por debajo de `root`):
/// `<id>.jsonl` y `rollout-…-<id>.jsonl`, y la carpeta `<id>` de Claude Code
/// con lo de sus subagentes.
fn session_files(root: &Path, id: &str, depth: usize, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if name == format!("{id}.jsonl")
            || (name.starts_with("rollout-") && name.ends_with(&format!("-{id}.jsonl")))
            || (is_dir && name == id)
        {
            found.push(path);
        } else if is_dir && depth > 0 {
            session_files(&path, id, depth - 1, found);
        }
    }
}

/// Borra la sesión propia de Claude Code o Codex (`agentChatForgetNative`,
/// apagado de fábrica: es suya). Devuelve cuántos archivos o carpetas quitó.
pub fn forget_native_in(home: &Path, agent_id: &str, session: &str) -> usize {
    let session = session.to_ascii_lowercase();
    if !uuid_like(&session) {
        return 0;
    }
    let root = match agent_id {
        "ai:claude" => claude_projects_dir(home),
        "ai:codex" => codex_sessions_dir(home),
        _ => return 0,
    };
    let mut found = Vec::new();
    session_files(&root, &session, 4, &mut found);
    found
        .iter()
        .filter(|path| {
            if path.is_dir() {
                fs::remove_dir_all(path).is_ok()
            } else {
                fs::remove_file(path).is_ok()
            }
        })
        .count()
}

#[tauri::command]
pub fn agent_chat_history_list() -> Vec<ChatSummary> {
    let dir = history_dir();
    let preferences = crate::preferences::current();
    if preferences.agent_chat_cleanup {
        cleanup_older_in(&dir, preferences.agent_chat_cleanup_days, now_ms());
    }
    list_in(&dir)
}

/// Fija o desfija un chat; `help` es el chat de ayuda más reciente.
#[tauri::command]
pub fn agent_chat_history_pin(id: String, pinned: bool) -> bool {
    let dir = history_dir();
    let id = if id == "help" {
        match latest_help_in(&dir) {
            Some(id) => id,
            None => return false,
        }
    } else {
        id
    };
    set_pinned_in(&dir, &id, pinned)
}

/// Guarda un chat exportado a Markdown donde eligió el usuario (24-11). Solo
/// archivos .md y como mucho el tamaño de un chat.
#[tauri::command]
pub fn agent_chat_export(path: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let markdown = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    if !markdown || !path.is_absolute() {
        return Err("invalid-path".into());
    }
    if text.len() > MAX_CHAT_BYTES {
        return Err("too-big".into());
    }
    fs::write(&path, text).map_err(|error| error.to_string())
}

/// Borra la sesión propia del agente de un chat que se borra.
#[tauri::command]
pub fn agent_chat_native_forget(agent_id: String, session: String) -> usize {
    forget_native_in(&paths::home_dir(), &agent_id, &session)
}

#[tauri::command]
pub fn agent_chat_history_load(id: String) -> Option<Value> {
    load_in(&history_dir(), &id)
}

#[tauri::command]
pub fn agent_chat_history_save(chat: Value) -> Result<(), String> {
    save_in(&history_dir(), &chat).map_err(str::to_string)
}

#[tauri::command]
pub fn agent_chat_history_delete(id: String) -> bool {
    delete_in(&history_dir(), &id)
}

#[tauri::command]
pub fn agent_chat_history_clear() -> usize {
    clear_in(&history_dir())
}

#[tauri::command]
pub fn agent_chat_session_load() -> Option<Value> {
    let bytes = fs::read(history_dir().join(SESSION_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub fn agent_chat_session_save(session: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(&session).map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("too-big".into());
    }
    write_atomic(&history_dir().join(SESSION_FILE), &bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wterminal-chat-history-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chat(id: &str, updated: f64) -> Value {
        json!({ "id": id, "title": format!("Chat {id}"), "agentLabel": "Codex CLI", "createdAt": 1.0, "updatedAt": updated, "messages": [{ "role": "user", "text": "hola" }] })
    }

    #[test]
    fn el_id_no_puede_salir_de_la_carpeta() {
        assert!(valid_chat_id("c-20261123-abc"));
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            "session",
            "con.json",
            &"x".repeat(65),
        ] {
            assert!(!valid_chat_id(bad), "{bad}");
        }
    }

    #[test]
    fn guarda_lista_carga_y_borra_del_mas_nuevo_al_mas_viejo() {
        let dir = temp_dir("roundtrip");
        save_in(&dir, &chat("uno", 10.0)).unwrap();
        save_in(&dir, &chat("dos", 20.0)).unwrap();
        let list = list_in(&dir);
        assert_eq!(
            list.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["dos", "uno"]
        );
        assert_eq!(list[0].messages, 1);
        assert_eq!(list[0].agent, "Codex CLI");
        assert_eq!(load_in(&dir, "uno").unwrap()["title"], "Chat uno");
        assert!(delete_in(&dir, "uno"));
        assert!(load_in(&dir, "uno").is_none());
        assert_eq!(clear_in(&dir), 1);
        assert!(list_in(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rechaza_ids_malos_y_chats_enormes() {
        let dir = temp_dir("reject");
        assert_eq!(save_in(&dir, &chat("../fuera", 1.0)), Err("invalid-chat"));
        let big = json!({ "id": "grande", "messages": ["x".repeat(MAX_CHAT_BYTES)] });
        assert_eq!(save_in(&dir, &big), Err("too-big"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fijar_marca_el_chat_y_lo_protege_al_podar() {
        let dir = temp_dir("pins");
        for (index, id) in ["a", "b", "c"].iter().enumerate() {
            save_in(&dir, &chat(id, index as f64)).unwrap();
        }
        assert!(set_pinned_in(&dir, "a", true));
        assert!(
            set_pinned_in(&dir, "nuevo", true),
            "se puede fijar antes de tener archivo"
        );
        assert!(!set_pinned_in(&dir, "../x", true));
        let list = list_in(&dir);
        assert!(list.iter().find(|c| c.id == "a").unwrap().pinned);
        assert!(!list.iter().find(|c| c.id == "b").unwrap().pinned);
        assert_eq!(
            prune_in(&dir, 1),
            1,
            "a se queda por fijado, c por ser el más nuevo"
        );
        assert!(load_in(&dir, "a").is_some() && load_in(&dir, "b").is_none());
        assert!(set_pinned_in(&dir, "a", false));
        assert_eq!(
            pinned_ids(&dir),
            Vec::<String>::new(),
            "desfijar quita también los que no existen"
        );
        assert!(delete_in(&dir, "c"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_chat_de_ayuda_mas_reciente() {
        let dir = temp_dir("help");
        save_in(&dir, &chat("a", 1.0)).unwrap();
        let mut help = chat("h1", 2.0);
        help["help"] = json!(true);
        save_in(&dir, &help).unwrap();
        help["id"] = json!("h2");
        help["updatedAt"] = json!(3.0);
        save_in(&dir, &help).unwrap();
        assert_eq!(latest_help_in(&dir).as_deref(), Some("h2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn borra_los_viejos_menos_abiertos_y_fijados() {
        let dir = temp_dir("cleanup");
        let day = DAY_MS;
        for (id, age) in [
            ("viejo", 100.0),
            ("abierto", 100.0),
            ("fijado", 100.0),
            ("nuevo", 1.0),
        ] {
            save_in(&dir, &chat(id, 1_000.0 * day - age * day)).unwrap();
        }
        fs::write(dir.join(SESSION_FILE), br#"{"open":["abierto"]}"#).unwrap();
        set_pinned_in(&dir, "fijado", true);
        assert_eq!(cleanup_older_in(&dir, 0, 1_000.0 * day), 0, "0 días: nunca");
        assert_eq!(cleanup_older_in(&dir, 90, 1_000.0 * day), 1);
        let left: Vec<String> = list_in(&dir).into_iter().map(|c| c.id).collect();
        assert!(!left.contains(&"viejo".to_string()) && left.len() == 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn borrar_la_sesion_propia_solo_toca_la_suya() {
        let home = temp_dir("native");
        let id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
        let claude = home.join(".claude").join("projects").join("C--proyecto");
        fs::create_dir_all(claude.join(id)).unwrap();
        fs::write(claude.join(format!("{id}.jsonl")), "x").unwrap();
        fs::write(claude.join("otra.jsonl"), "x").unwrap();
        let codex = home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("11")
            .join("24");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            codex.join(format!("rollout-2026-11-24T08-00-00-{id}.jsonl")),
            "x",
        )
        .unwrap();
        if std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
            assert_eq!(forget_native_in(&home, "ai:claude", id), 2);
            assert!(claude.join("otra.jsonl").is_file());
        }
        if std::env::var_os("CODEX_HOME").is_none() {
            assert_eq!(forget_native_in(&home, "ai:codex", &id.to_uppercase()), 1);
        }
        assert_eq!(
            forget_native_in(&home, "ai:claude", "../../x"),
            0,
            "solo un UUID"
        );
        assert_eq!(forget_native_in(&home, "ai:qwen", id), 0);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn al_pasar_del_limite_borra_los_mas_viejos_menos_los_abiertos() {
        let dir = temp_dir("prune");
        for (index, id) in ["a", "b", "c", "d"].iter().enumerate() {
            fs::write(
                chat_path(&dir, id),
                serde_json::to_vec(&chat(id, index as f64)).unwrap(),
            )
            .unwrap();
        }
        fs::write(dir.join(SESSION_FILE), br#"{"open":["a"]}"#).unwrap();
        assert_eq!(prune_in(&dir, 2), 1);
        let left: Vec<String> = list_in(&dir).into_iter().map(|c| c.id).collect();
        assert_eq!(left, ["d", "c", "a"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
