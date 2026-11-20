//! Claves de API de las IA de terminal que se usan con una (Grok, Codex…).
//!
//! El 11-11 Grok CLI acababa nada más abrirse con «API key required. Set
//! GROK_API_KEY…» y «Proceso finalizado (código 1)»: el usuario no tenía nada
//! que hacer desde la pestaña. Ahora la pestaña lo reconoce
//! ([`output_asks_for_key`]) y ofrece meter la clave. La clave:
//!
//! - se guarda cifrada con DPAPI (solo la descifra este usuario de Windows) en
//!   `ai-keys.json`, junto a los ajustes;
//! - se pasa como variable de entorno al abrir las pestañas de esa IA
//!   ([`spawn_env`]), salvo que el usuario ya tenga esa variable puesta: la
//!   suya manda;
//! - nunca se escribe en claro, ni en los logs, ni vuelve al frontend.

use std::path::PathBuf;

use base64::Engine as _;
use serde_json::{Map, Value};

/// Una IA que se usa con una clave de API y la variable donde la busca.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiKeySpec {
    /// El id del catálogo (`ai:<id>`).
    pub ai: &'static str,
    /// La variable de entorno que lee la CLI.
    pub env_var: &'static str,
}

/// Las IA del catálogo que leen su clave de una variable de entorno. Las que
/// inician sesión en el navegador (Copilot, Amp…) o se configuran con su
/// propio asistente (AIChat, Crush, Continue) no están: para esas, la pestaña
/// no ofrece nada.
pub const SPECS: &[AiKeySpec] = &[
    AiKeySpec {
        ai: "grok",
        env_var: "GROK_API_KEY",
    },
    AiKeySpec {
        ai: "codex",
        env_var: "OPENAI_API_KEY",
    },
    AiKeySpec {
        ai: "mods",
        env_var: "OPENAI_API_KEY",
    },
    AiKeySpec {
        ai: "sgpt",
        env_var: "OPENAI_API_KEY",
    },
    AiKeySpec {
        ai: "llm",
        env_var: "OPENAI_API_KEY",
    },
    AiKeySpec {
        ai: "aider",
        env_var: "OPENAI_API_KEY",
    },
    AiKeySpec {
        ai: "gemini",
        env_var: "GEMINI_API_KEY",
    },
    AiKeySpec {
        ai: "claude",
        env_var: "ANTHROPIC_API_KEY",
    },
];

/// Lo más largo que se acepta como clave: las de los proveedores rondan los
/// 40-200 caracteres.
const MAX_KEY_CHARS: usize = 4096;

pub fn spec_for_env(env_id: &str) -> Option<&'static AiKeySpec> {
    let ai = env_id.strip_prefix("ai:")?;
    SPECS.iter().find(|spec| spec.ai == ai)
}

/// Lo último que dijo una IA que acabó pide su clave: nombra su variable o
/// habla de una «API key».
pub fn output_asks_for_key(spec: &AiKeySpec, output: &str) -> bool {
    if output.contains(spec.env_var) {
        return true;
    }
    let lower = output.to_ascii_lowercase();
    ["api key", "api_key", "apikey", "api-key"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Una clave válida: sin espacios ni caracteres de control (se pasa tal cual
/// como variable de entorno) y de un largo razonable.
pub fn validate_key(key: &str) -> Result<&str, &'static str> {
    let key = key.trim();
    if key.is_empty() {
        return Err("empty");
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err("too-long");
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid-characters");
    }
    Ok(key)
}

fn store_path() -> PathBuf {
    crate::paths::user_data_dir().join("ai-keys.json")
}

fn read_store() -> Map<String, Value> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn write_store(map: &Map<String, Value>) -> anyhow::Result<()> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&Value::Object(map.clone()))?,
    )?;
    std::fs::rename(&temporary, &path)?;
    Ok(())
}

/// Si hay una clave guardada para esa variable (sin descifrarla).
pub fn has_key(env_var: &str) -> bool {
    read_store().contains_key(env_var)
}

fn stored_key(env_var: &str) -> Option<String> {
    let encoded = read_store().get(env_var)?.as_str()?.to_string();
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let plain = unseal(env_var, &sealed).ok()?;
    String::from_utf8(plain).ok()
}

/// Guarda (o cambia) la clave de esa variable, cifrada.
pub fn save_key(env_var: &str, key: &str) -> anyhow::Result<()> {
    let key = validate_key(key).map_err(|reason| anyhow::anyhow!("clave no válida: {reason}"))?;
    let sealed = seal(env_var, key.as_bytes())?;
    let mut map = read_store();
    map.insert(
        env_var.to_string(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(sealed)),
    );
    write_store(&map)
}

/// Borra la clave guardada de esa variable. `true` si había una.
pub fn clear_key(env_var: &str) -> anyhow::Result<bool> {
    let mut map = read_store();
    let removed = map.remove(env_var).is_some();
    if removed {
        write_store(&map)?;
        forget(env_var);
    }
    Ok(removed)
}

// ---- Dónde vive la clave cifrada ----
//
// Windows: DPAPI. Lo cifrado va en `ai-keys.json`; solo lo descifra este
// usuario de Windows.
//
// Linux (17-11, Romen: «poner al día en Linux las mejoras de Windows»): el
// llavero del escritorio (Secret Service: GNOME Keyring, KWallet…) con
// `secret-tool`, de libsecret. La clave va al llavero; en `ai-keys.json` solo
// queda una marca de que está allí ([`secret_service::MARKER`]). Sin
// `secret-tool` no se ofrece guardarla, como antes.

#[cfg(windows)]
fn seal(_env_var: &str, data: &[u8]) -> anyhow::Result<Vec<u8>> {
    protect(data)
}

#[cfg(windows)]
fn unseal(_env_var: &str, sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
    unprotect(sealed)
}

#[cfg(windows)]
fn forget(_env_var: &str) {}

#[cfg(not(windows))]
fn seal(env_var: &str, data: &[u8]) -> anyhow::Result<Vec<u8>> {
    secret_service::store(env_var, data)?;
    Ok(secret_service::MARKER.as_bytes().to_vec())
}

#[cfg(not(windows))]
fn unseal(env_var: &str, sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
    if sealed != secret_service::MARKER.as_bytes() {
        anyhow::bail!("la clave guardada no es del llavero");
    }
    secret_service::lookup(env_var)
}

#[cfg(not(windows))]
fn forget(env_var: &str) {
    secret_service::clear(env_var);
}

/// El llavero del escritorio de Linux con `secret-tool`. Se compila en todas
/// las plataformas para que las pruebas y clippy de Windows lo revisen; solo
/// se usa fuera de Windows.
#[cfg_attr(windows, allow(dead_code))]
mod secret_service {
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Lo que queda en `ai-keys.json` en vez de la clave.
    pub const MARKER: &str = "secret-service";
    /// El atributo que agrupa las claves de la app en el llavero.
    const APPLICATION: &str = "lterminal-ai-key";

    /// Los atributos que identifican la clave de esa variable.
    pub fn attributes(env_var: &str) -> [&str; 4] {
        ["application", APPLICATION, "env-var", env_var]
    }

    pub fn store_args(env_var: &str) -> Vec<String> {
        let mut args = vec!["store".to_string(), format!("--label=WTerminal: {env_var}")];
        args.extend(attributes(env_var).iter().map(|part| part.to_string()));
        args
    }

    pub fn lookup_args(env_var: &str) -> Vec<String> {
        std::iter::once("lookup")
            .chain(attributes(env_var))
            .map(str::to_string)
            .collect()
    }

    pub fn clear_args(env_var: &str) -> Vec<String> {
        std::iter::once("clear")
            .chain(attributes(env_var))
            .map(str::to_string)
            .collect()
    }

    pub fn available() -> bool {
        crate::path_env::which("secret-tool").is_some()
    }

    /// `secret-tool store` lee la clave de su entrada, nunca de la línea de
    /// órdenes: así no sale en la lista de procesos.
    pub fn store(env_var: &str, secret: &[u8]) -> anyhow::Result<()> {
        let mut child = Command::new("secret-tool")
            .args(store_args(env_var))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("secret-tool sin entrada"))?
            .write_all(secret)?;
        let output = child.wait_with_output()?;
        if !output.status.success() {
            anyhow::bail!(
                "secret-tool store: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    pub fn lookup(env_var: &str) -> anyhow::Result<Vec<u8>> {
        let output = Command::new("secret-tool")
            .args(lookup_args(env_var))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;
        if !output.status.success() || output.stdout.is_empty() {
            anyhow::bail!("el llavero no tiene la clave de {env_var}");
        }
        Ok(output.stdout)
    }

    pub fn clear(env_var: &str) {
        let _ = Command::new("secret-tool")
            .args(clear_args(env_var))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Las variables que hay que añadir al abrir la pestaña de esa IA (o al
/// preguntarle desde el chat): su clave guardada, si la hay y el usuario no
/// tiene ya esa variable puesta, y lo que esa IA necesite para usarla
/// ([`use_stored_key_env`]).
pub fn spawn_env(env_id: &str) -> Vec<(String, String)> {
    let Some(spec) = spec_for_env(env_id) else {
        return Vec::new();
    };
    if std::env::var_os(spec.env_var).is_some() {
        return Vec::new();
    }
    let Some(key) = stored_key(spec.env_var) else {
        return Vec::new();
    };
    let mut vars = vec![(spec.env_var.to_string(), key)];
    vars.extend(use_stored_key_env(spec.ai));
    vars
}

/// Gemini CLI se autentica como diga su `settings.json`, no por la clave:
/// quien entró alguna vez con Google tiene `oauth-personal` y la clave se
/// ignoraba; seguía con su cuenta gratuita y su `UNSUPPORTED_CLIENT` (14-11,
/// Romen: «Gemini no acepta mi clave y sigue diciendo que el cliente no está
/// soportado»). Con una clave guardada en WTerminal se le pide usarla solo en
/// esa ejecución (`GEMINI_CLI_AUTH_OVERRIDE`), sin tocar su archivo. Con la
/// clave solo en el entorno de Windows no se fuerza: ahí puede preferir su
/// cuenta.
fn use_stored_key_env(ai: &str) -> Option<(String, String)> {
    (ai == "gemini").then(|| {
        (
            "GEMINI_CLI_AUTH_OVERRIDE".to_string(),
            "gemini-api-key".to_string(),
        )
    })
}

#[cfg(windows)]
fn protect(data: &[u8]) -> anyhow::Result<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len())?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` apunta a `data`, que vive durante la llamada; `output`
    // lo rellena DPAPI con memoria suya que se copia y se libera abajo.
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
    }
    Ok(take_blob(output))
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> anyhow::Result<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len())?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: igual que en `protect`.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
    }
    Ok(take_blob(output))
}

/// Copia lo que devolvió DPAPI y libera su memoria.
#[cfg(windows)]
fn take_blob(blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    if blob.pbData.is_null() {
        return Vec::new();
    }
    // SAFETY: DPAPI devuelve `cbData` bytes válidos en `pbData`, reservados
    // con LocalAlloc: se copian y se liberan una sola vez.
    unsafe {
        let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(blob.pbData.cast())));
        bytes
    }
}

/// Si en este equipo se pueden guardar claves: siempre en Windows (DPAPI); en
/// Linux, si está `secret-tool` (el llavero del escritorio).
pub fn supported() -> bool {
    cfg!(windows) || (cfg!(target_os = "linux") && secret_service::available())
}

/// Lo que la pestaña necesita para ofrecer la clave. Nunca lleva la clave.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyOffer {
    pub env_var: String,
    /// Ya había una guardada: la IA la rechazó y conviene cambiarla.
    pub stored: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeySaveResult {
    pub ok: bool,
    /// `empty`, `too-long`, `invalid-characters`, `unknown-ai`,
    /// `unsupported` o `store`.
    pub error: Option<String>,
}

impl AiKeySaveResult {
    fn failed(reason: &str) -> Self {
        AiKeySaveResult {
            ok: false,
            error: Some(reason.to_string()),
        }
    }
}

/// Las últimas líneas de una salida larga: el aviso de la CLI va al final.
fn tail(output: &str, max_chars: usize) -> &str {
    let count = output.chars().count();
    if count <= max_chars {
        return output;
    }
    let skip = output
        .char_indices()
        .nth(count - max_chars)
        .map_or(0, |(index, _)| index);
    &output[skip..]
}

/// `ai:keyOffer`
///
/// La pestaña de una IA acabó con un código distinto de 0: si lo último que
/// dijo pide su clave y esta IA se usa con una, se ofrece meterla.
#[tauri::command]
pub fn ai_key_offer(env_id: String, output: String) -> Option<AiKeyOffer> {
    if !supported() || !crate::preferences::current().ai_key_offer {
        return None;
    }
    let spec = spec_for_env(&env_id)?;
    output_asks_for_key(spec, tail(&output, 4000)).then(|| AiKeyOffer {
        env_var: spec.env_var.to_string(),
        stored: has_key(spec.env_var),
    })
}

/// `ai:keySave`
///
/// Guarda la clave cifrada. Ni la clave ni su largo van al log.
#[tauri::command(async)]
pub fn ai_key_save(env_id: String, key: String) -> AiKeySaveResult {
    if !supported() {
        return AiKeySaveResult::failed("unsupported");
    }
    let Some(spec) = spec_for_env(&env_id) else {
        return AiKeySaveResult::failed("unknown-ai");
    };
    if let Err(reason) = validate_key(&key) {
        return AiKeySaveResult::failed(reason);
    }
    match save_key(spec.env_var, &key) {
        Ok(()) => {
            log_info!(
                "Clave de IA guardada (cifrada)",
                serde_json::json!({ "envId": env_id, "envVar": spec.env_var })
            );
            AiKeySaveResult {
                ok: true,
                error: None,
            }
        }
        Err(error) => {
            log_warn!(
                "No se pudo guardar la clave de IA",
                serde_json::json!({ "envId": env_id, "error": error.to_string() })
            );
            AiKeySaveResult::failed("store")
        }
    }
}

/// Una variable con clave guardada y las IA que la usan. Nunca la clave.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStored {
    pub env_var: String,
    /// Los entornos (`ai:<id>`) que la reciben al abrirse.
    pub env_ids: Vec<String>,
}

/// Las variables de la tabla que tienen una clave guardada.
pub fn stored_keys() -> Vec<AiKeyStored> {
    let store = read_store();
    let mut result: Vec<AiKeyStored> = Vec::new();
    for spec in SPECS {
        if !store.contains_key(spec.env_var) {
            continue;
        }
        let env_id = format!("ai:{}", spec.ai);
        match result.iter_mut().find(|item| item.env_var == spec.env_var) {
            Some(item) => item.env_ids.push(env_id),
            None => result.push(AiKeyStored {
                env_var: spec.env_var.to_string(),
                env_ids: vec![env_id],
            }),
        }
    }
    result
}

/// `ai:keyList`: para Ajustes, qué claves hay guardadas (sin descifrarlas).
#[tauri::command]
pub fn ai_key_list() -> Vec<AiKeyStored> {
    stored_keys()
}

/// `ai:keyClear`
#[tauri::command(async)]
pub fn ai_key_clear(env_id: String) -> bool {
    let Some(spec) = spec_for_env(&env_id) else {
        return false;
    };
    match clear_key(spec.env_var) {
        Ok(removed) => {
            if removed {
                log_info!(
                    "Clave de IA borrada",
                    serde_json::json!({ "envId": env_id, "envVar": spec.env_var })
                );
            }
            removed
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_sin_clave_se_reconoce_por_su_mensaje() {
        let spec = spec_for_env("ai:grok").expect("grok está en la tabla");
        assert_eq!(spec.env_var, "GROK_API_KEY");
        let output = "✗ Error: API key required. Set GROK_API_KEY environment variable, use --api-key flag, or set \"apiKey\" field in ~/.grok/user-settings.json";
        assert!(output_asks_for_key(spec, output));
        assert!(!output_asks_for_key(spec, "Proceso finalizado (código 1)"));
    }

    /// Gemini con la clave guardada en WTerminal la usa aunque su
    /// `settings.json` diga «entrar con Google» (14-11); las demás, tal cual.
    #[test]
    fn gemini_usa_la_clave_guardada_aunque_su_ajuste_diga_google() {
        assert_eq!(
            use_stored_key_env("gemini"),
            Some((
                "GEMINI_CLI_AUTH_OVERRIDE".to_string(),
                "gemini-api-key".to_string()
            ))
        );
        for ai in ["grok", "codex", "mods", "llm", "claude"] {
            assert_eq!(use_stored_key_env(ai), None, "{ai}");
        }
    }

    #[test]
    fn solo_las_ia_con_variable_de_clave_ofrecen_meterla() {
        assert!(spec_for_env("ai:codex").is_some());
        assert!(
            spec_for_env("ai:copilot").is_none(),
            "Copilot inicia sesión en el navegador"
        );
        assert!(spec_for_env("cmd").is_none());
        assert!(spec_for_env("lang:python").is_none());
    }

    #[test]
    fn todas_las_ia_de_la_tabla_estan_en_el_catalogo() {
        let catalog = include_str!("ai.rs");
        for spec in SPECS {
            assert!(
                catalog.contains(&format!("AiCliDef {{ id: \"{}\"", spec.ai)),
                "{} no está en el catálogo de ai.rs",
                spec.ai
            );
        }
    }

    #[test]
    fn el_aviso_se_busca_al_final_de_una_salida_larga() {
        let long = format!("{}GROK_API_KEY", "ñ".repeat(10_000));
        assert_eq!(tail(&long, 12), "GROK_API_KEY");
        assert_eq!(tail("corto", 4000), "corto");
    }

    #[test]
    fn una_clave_con_espacios_o_vacia_no_vale() {
        assert_eq!(validate_key("  xai-abc123  "), Ok("xai-abc123"));
        assert!(validate_key("").is_err());
        assert!(validate_key("con espacio").is_err());
        assert!(validate_key("linea\nnueva").is_err());
        assert!(validate_key(&"a".repeat(MAX_KEY_CHARS + 1)).is_err());
    }

    /// Linux (17-11): la clave va al llavero con atributos fijos y por la
    /// entrada de `secret-tool`, nunca en sus argumentos.
    #[test]
    fn el_llavero_de_linux_identifica_la_clave_por_su_variable() {
        let store = secret_service::store_args("GROK_API_KEY");
        assert_eq!(store[0], "store");
        assert_eq!(store[1], "--label=WTerminal: GROK_API_KEY");
        assert_eq!(
            &store[2..],
            ["application", "lterminal-ai-key", "env-var", "GROK_API_KEY"]
        );
        assert!(!store.iter().any(|arg| arg.contains("xai-")));
        assert_eq!(
            secret_service::lookup_args("OPENAI_API_KEY"),
            [
                "lookup",
                "application",
                "lterminal-ai-key",
                "env-var",
                "OPENAI_API_KEY"
            ]
        );
        assert_eq!(
            secret_service::clear_args("OPENAI_API_KEY")[0],
            "clear",
            "borrar la clave en Ajustes la quita también del llavero"
        );
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_cifra_y_descifra_para_este_usuario() {
        let sealed = protect(b"xai-prueba-123").expect("DPAPI cifra");
        assert!(
            !sealed.windows(14).any(|window| window == b"xai-prueba-123"),
            "no queda en claro"
        );
        assert_eq!(
            unprotect(&sealed).expect("DPAPI descifra"),
            b"xai-prueba-123"
        );
    }
}
