//! Más programas para la pestaña Programas (22-11, Romen: «todas las
//! posibles… git, sesiones de las IA, herramientas, tools»): Git Bash, npm,
//! pip, WinGet, Python, Node, Claude Code y Codex. Igual que en
//! `programs.rs`, cada valor se guarda donde lo lee el propio programa.
//!
//! WTools/LTools no tienen un archivo de ajustes propio: su integración está
//! en Ajustes › Sistema y sus acciones fijadas en la Biblioteca.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use super::programs::{ProgramSection, ProgramSetting, SettingKind, SettingOption};

fn option(value: &str, label: &str) -> SettingOption {
    SettingOption {
        value: value.to_string(),
        label: label.to_string(),
    }
}

fn setting(
    id: &str,
    label: &str,
    description: &str,
    kind: SettingKind,
    default_value: &str,
    options: Vec<SettingOption>,
) -> ProgramSetting {
    ProgramSetting {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        kind,
        value: String::new(),
        default_value: default_value.to_string(),
        options,
    }
}

fn toggle(id: &str, label: &str, description: &str, default_value: &str) -> ProgramSetting {
    setting(
        id,
        label,
        description,
        SettingKind::Toggle,
        default_value,
        Vec::new(),
    )
}

fn section(
    id: &str,
    name: &str,
    source: &str,
    note: Option<&str>,
    settings: Vec<ProgramSetting>,
) -> ProgramSection {
    ProgramSection {
        id: id.to_string(),
        name: name.to_string(),
        available: true,
        source: source.to_string(),
        note: note.map(str::to_string),
        can_undo: false,
        settings,
    }
}

/// Las secciones nuevas, sin valores.
pub fn sections_template() -> Vec<ProgramSection> {
    vec![
        section(
            "gitbash",
            "Git Bash",
            r"~\.bashrc y ~\.inputrc (bloque «WTerminal»)",
            Some("Vale en las pestañas nuevas de Git Bash. Lo de fuera del bloque no se toca."),
            vec![
                setting("historySize", "Tamaño del historial", "Cuántas órdenes recuerda (HISTSIZE, de 100 a 100000).", SettingKind::Number, "500", Vec::new()),
                toggle("ignoreDups", "No guardar órdenes repetidas ni las que empiezan por espacio", "HISTCONTROL=ignoreboth.", "false"),
                setting(
                    "editingMode",
                    "Modo de edición de la línea",
                    "Emacs (Ctrl+A, Ctrl+E…) o Vi.",
                    SettingKind::Choice,
                    "emacs",
                    vec![option("emacs", "Emacs"), option("vi", "Vi")],
                ),
                setting(
                    "bellStyle",
                    "Pitido",
                    "Qué hace cuando algo no se puede.",
                    SettingKind::Choice,
                    "audible",
                    vec![option("none", "Nada"), option("visible", "Un destello"), option("audible", "Un pitido")],
                ),
                toggle("completionIgnoreCase", "Completar sin distinguir mayúsculas", "Con Tab, «doc» completa «Documents».", "false"),
            ],
        ),
        section(
            "npm",
            "npm",
            "npm config --location=user (~\\.npmrc)",
            None,
            vec![
                toggle("fund", "Mensajes de financiación", "Los «packages are looking for funding» al instalar.", "true"),
                toggle("audit", "Auditoría al instalar", "Revisa vulnerabilidades conocidas en cada npm install (tarda un poco más).", "true"),
                toggle("update-notifier", "Avisar de versiones nuevas de npm", "El aviso de «New major version of npm available».", "true"),
                setting("registry", "Registro de paquetes", "De dónde se descargan los paquetes (un espejo de la empresa, por ejemplo).", SettingKind::Text, "https://registry.npmjs.org/", Vec::new()),
            ],
        ),
        section(
            "pip",
            "pip (Python)",
            "pip config --user (%APPDATA%\\pip\\pip.ini)",
            None,
            vec![
                toggle("global.disable-pip-version-check", "No avisar de versiones nuevas de pip", "Quita el «A new release of pip is available» de cada instalación.", "false"),
                setting("global.timeout", "Tiempo máximo de cada descarga", "En segundos (de 5 a 600).", SettingKind::Number, "15", Vec::new()),
                setting("global.index-url", "Índice de paquetes", "De dónde se descargan (un espejo, por ejemplo).", SettingKind::Text, "https://pypi.org/simple", Vec::new()),
            ],
        ),
        section(
            "winget",
            "WinGet",
            r"%LOCALAPPDATA%\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\settings.json",
            Some("Se hace una copia del archivo antes del primer cambio (settings.json.wterminal-bak)."),
            vec![
                setting(
                    "visual.progressBar",
                    "Barra de progreso",
                    "Cómo se dibuja la barra de las descargas.",
                    SettingKind::Choice,
                    "accent",
                    vec![
                        option("accent", "Color de Windows"),
                        option("rainbow", "Arcoíris"),
                        option("retro", "Clásica"),
                        option("disabled", "Sin barra"),
                    ],
                ),
                toggle("telemetry.disable", "Desactivar la telemetría de WinGet", "No manda datos de uso a Microsoft.", "false"),
                setting(
                    "installBehavior.preferences.scope",
                    "Instalar para",
                    "Si un paquete permite elegir, para quién se instala.",
                    SettingKind::Choice,
                    "",
                    vec![option("user", "Solo este usuario"), option("machine", "Todo el equipo")],
                ),
            ],
        ),
        section(
            "python",
            "Python",
            "Variables de usuario de Windows",
            Some("Vale en las pestañas nuevas (WTerminal también la recoge sin reiniciar)."),
            vec![
                toggle("PYTHONUTF8", "Modo UTF-8", "Python lee y escribe archivos y la consola en UTF-8: sin errores con tildes ni emojis.", "false"),
                toggle("PYTHONDONTWRITEBYTECODE", "No crear __pycache__", "No deja carpetas __pycache__ en los proyectos.", "false"),
            ],
        ),
        section(
            "node",
            "Node.js",
            "Variables de usuario de Windows",
            Some("Vale en las pestañas nuevas."),
            vec![
                setting("NODE_REPL_HISTORY_SIZE", "Historial del REPL", "Cuántas líneas recuerda el REPL de node (de 100 a 100000).", SettingKind::Number, "1000", Vec::new()),
            ],
        ),
        section(
            "claude",
            "Claude Code",
            r"~\.claude\settings.json",
            Some("Lo usan su pestaña y el chat lateral. Lo de fuera de estos ajustes no se toca."),
            vec![
                setting(
                    "model",
                    "Modelo",
                    "El modelo con el que arranca.",
                    SettingKind::Choice,
                    "",
                    vec![option("opus", "Opus"), option("sonnet", "Sonnet"), option("haiku", "Haiku")],
                ),
                setting(
                    "permissions.defaultMode",
                    "Modo de permisos",
                    "Qué puede hacer sin preguntar. «Omitir permisos» no se ofrece aquí: es peligroso de fábrica.",
                    SettingKind::Choice,
                    "default",
                    vec![
                        option("default", "Preguntar"),
                        option("acceptEdits", "Aceptar ediciones"),
                        option("plan", "Solo planear"),
                    ],
                ),
                toggle("includeCoAuthoredBy", "Firmar los commits como coautor", "Añade «Co-Authored-By: Claude» a los commits que hace.", "true"),
                setting("cleanupPeriodDays", "Días que guarda las conversaciones", "De 1 a 365.", SettingKind::Number, "30", Vec::new()),
            ],
        ),
        section(
            "codex",
            "Codex",
            r"~\.codex\config.toml",
            Some("Lo usan su pestaña y el chat lateral. Solo se tocan estas claves."),
            vec![
                setting("model", "Modelo", "El modelo con el que arranca (vacío = el suyo de fábrica).", SettingKind::Text, "", Vec::new()),
                setting(
                    "model_reasoning_effort",
                    "Intensidad",
                    "Cuánto piensa antes de contestar.",
                    SettingKind::Choice,
                    "",
                    vec![option("low", "Baja"), option("medium", "Media"), option("high", "Alta")],
                ),
                setting(
                    "approval_policy",
                    "Cuándo pide permiso",
                    "Antes de ejecutar órdenes.",
                    SettingKind::Choice,
                    "",
                    vec![
                        option("untrusted", "Casi siempre"),
                        option("on-request", "Cuando lo crea necesario"),
                        option("on-failure", "Solo si algo falla"),
                    ],
                ),
                setting(
                    "sandbox_mode",
                    "Qué puede tocar",
                    "Dónde puede escribir. El acceso total no se ofrece aquí.",
                    SettingKind::Choice,
                    "",
                    vec![option("read-only", "Solo leer"), option("workspace-write", "La carpeta del proyecto")],
                ),
            ],
        ),
    ]
}

/// Rango de los ajustes numéricos de estas secciones.
pub fn number_range(program: &str, id: &str) -> Option<(u32, u32)> {
    match (program, id) {
        ("gitbash", "historySize") | ("node", "NODE_REPL_HISTORY_SIZE") => Some((100, 100_000)),
        ("pip", "global.timeout") => Some((5, 600)),
        ("claude", "cleanupPeriodDays") => Some((1, 365)),
        _ => None,
    }
}

// ------------------------------------------- bloques marcados (Git Bash) --

pub const BLOCK_START: &str = "# >>> WTerminal: ajustes (no editar a mano) >>>";
pub const BLOCK_END: &str = "# <<< WTerminal <<<";

/// Valores guardados en un bloque marcado: `# wt:<id>=<valor>`.
pub fn block_values(text: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    let Some(start) = text.find(BLOCK_START) else {
        return values;
    };
    let Some(end) = text[start..].find(BLOCK_END) else {
        return values;
    };
    for line in text[start..start + end].lines() {
        if let Some((key, value)) = line
            .trim()
            .strip_prefix("# wt:")
            .and_then(|pair| pair.split_once('='))
        {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    values
}

/// El texto con el bloque puesto al día; lo de fuera no se toca y, sin
/// valores, el bloque desaparece. `render` da la línea de cada ajuste.
pub fn with_block(
    text: &str,
    values: &BTreeMap<String, String>,
    render: impl Fn(&str, &str) -> Option<String>,
) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut outside = text.to_string();
    if let Some(start) = outside.find(BLOCK_START) {
        if let Some(rel_end) = outside[start..].find(BLOCK_END) {
            let mut end = start + rel_end + BLOCK_END.len();
            if outside[end..].starts_with("\r\n") {
                end += 2;
            } else if outside[end..].starts_with('\n') {
                end += 1;
            }
            outside.replace_range(start..end, "");
        }
    }
    let lines: Vec<String> = values
        .iter()
        .filter_map(|(id, value)| {
            render(id, value).map(|line| format!("# wt:{id}={value}{newline}{line}"))
        })
        .collect();
    if lines.is_empty() {
        return outside;
    }
    let mut result = outside.trim_end_matches(['\r', '\n']).to_string();
    if !result.is_empty() {
        result.push_str(newline);
        result.push_str(newline);
    }
    result.push_str(BLOCK_START);
    result.push_str(newline);
    for line in lines {
        result.push_str(&line);
        result.push_str(newline);
    }
    result.push_str(BLOCK_END);
    result.push_str(newline);
    result
}

/// `~/.bashrc` (la línea) o `~/.inputrc` (el editor de línea).
fn gitbash_file(id: &str) -> &'static str {
    if matches!(id, "historySize" | "ignoreDups") {
        ".bashrc"
    } else {
        ".inputrc"
    }
}

pub fn gitbash_line(id: &str, value: &str) -> Option<String> {
    match id {
        "historySize" => value
            .parse::<u32>()
            .ok()
            .filter(|n| (100..=100_000).contains(n))
            .map(|n| format!("export HISTSIZE={n}")),
        "ignoreDups" if value == "true" => Some("export HISTCONTROL=ignoreboth".into()),
        "editingMode" if matches!(value, "emacs" | "vi") => {
            Some(format!("set editing-mode {value}"))
        }
        "bellStyle" if matches!(value, "none" | "visible" | "audible") => {
            Some(format!("set bell-style {value}"))
        }
        "completionIgnoreCase" if value == "true" => Some("set completion-ignore-case on".into()),
        _ => None,
    }
}

// ------------------------------------------------- JSON por ruta con puntos --

/// Lee `a.b.c` de un JSON (cadena, número o booleano, como texto).
pub fn json_get(root: &Value, path: &str) -> String {
    let mut node = root;
    for part in path.split('.') {
        match node.get(part) {
            Some(next) => node = next,
            None => return String::new(),
        }
    }
    match node {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// Pone o quita `a.b.c`, sin tocar el resto. `typed` decide el tipo JSON.
pub fn json_set(root: &mut Value, path: &str, typed: Option<Value>) {
    if !root.is_object() {
        *root = Value::Object(Map::new());
    }
    let parts: Vec<&str> = path.split('.').collect();
    let mut node = root;
    for part in &parts[..parts.len() - 1] {
        let map = node.as_object_mut().expect("objeto");
        let entry = map
            .entry(part.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        node = entry;
    }
    let map = node.as_object_mut().expect("objeto");
    let last = parts[parts.len() - 1];
    match typed {
        Some(value) => {
            map.insert(last.to_string(), value);
        }
        None => {
            map.remove(last);
        }
    }
}

/// Quita los comentarios de línea `//` fuera de cadenas (el settings.json de
/// WinGet los lleva) para poder leerlo como JSON.
pub fn strip_line_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let mut in_string = false;
        let mut escaped = false;
        let mut cut = line.len();
        let bytes = line.as_bytes();
        for (index, &byte) in bytes.iter().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            match byte {
                b'\\' if in_string => escaped = true,
                b'"' => in_string = !in_string,
                b'/' if !in_string && bytes.get(index + 1) == Some(&b'/') => {
                    cut = index;
                    break;
                }
                _ => {}
            }
        }
        out.push_str(&line[..cut]);
        out.push('\n');
    }
    out
}

// ----------------------------------------------- TOML de primer nivel --

/// Valor de una clave de primer nivel (antes de la primera tabla `[x]`).
pub fn toml_get(text: &str, key: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        if let Some((name, value)) = trimmed.split_once('=') {
            if name.trim() == key {
                return value.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

/// Pone o quita una clave de primer nivel, sin tocar tablas ni comentarios.
pub fn toml_set(text: &str, key: &str, value: Option<&str>) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let first_table = lines
        .iter()
        .position(|line| line.trim().starts_with('['))
        .unwrap_or(lines.len());
    let existing = lines[..first_table].iter().position(|line| {
        line.trim()
            .split_once('=')
            .is_some_and(|(name, _)| name.trim() == key)
    });
    let rendered = value.map(|value| {
        format!(
            "{key} = \"{}\"",
            value.replace('\\', "\\\\").replace('"', "\\\"")
        )
    });
    match (existing, rendered) {
        (Some(index), Some(line)) => lines[index] = line,
        (Some(index), None) => {
            lines.remove(index);
        }
        (None, Some(line)) => lines.insert(0, line),
        (None, None) => {}
    }
    let mut out = lines.join(newline);
    if !out.is_empty() {
        out.push_str(newline);
    }
    out
}

// -------------------------------------------------------- lectura y escritura --

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn winget_settings_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| {
        dir.join("Packages")
            .join("Microsoft.DesktopAppInstaller_8wekyb3d8bbwe")
            .join("LocalState")
            .join("settings.json")
    })
}

fn read_json(path: &PathBuf) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let clean = strip_line_comments(text.trim_start_matches('\u{feff}'));
            if clean.trim().is_empty() {
                Ok(Value::Object(Map::new()))
            } else {
                serde_json::from_str(&clean)
                    .map_err(|error| format!("No se pudo leer {}: {error}", path.display()))
            }
        }
        Err(_) => Ok(Value::Object(Map::new())),
    }
}

fn write_json(path: &PathBuf, value: &Value, backup: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if backup && path.exists() {
        let copy = path.with_extension("json.wterminal-bak");
        if !copy.exists() {
            std::fs::copy(path, &copy)
                .map_err(|error| format!("No se pudo copiar {}: {error}", path.display()))?;
        }
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(path, text + "\n")
        .map_err(|error| format!("No se pudo guardar {}: {error}", path.display()))
}

/// El valor JSON que se guarda: booleanos y números con su tipo.
fn typed_json(kind: SettingKind, value: &str) -> Value {
    match kind {
        SettingKind::Toggle => Value::Bool(value == "true"),
        SettingKind::Number => value
            .parse::<u64>()
            .map(Value::from)
            .unwrap_or(Value::String(value.into())),
        _ => Value::String(value.to_string()),
    }
}

fn kind_of(program: &str, id: &str) -> SettingKind {
    sections_template()
        .into_iter()
        .find(|section| section.id == program)
        .and_then(|section| {
            section
                .settings
                .into_iter()
                .find(|setting| setting.id == id)
        })
        .map(|setting| setting.kind)
        .unwrap_or(SettingKind::Text)
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    crate::process::hidden_command(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = crate::process::hidden_command(program)
        .args(args)
        .output()
        .map_err(|error| format!("No se pudo ejecutar {program}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn npm() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

pub fn available(program: &str) -> bool {
    let which = |name: &str| crate::path_env::which(name).is_some();
    match program {
        "gitbash" => cfg!(windows) && which("git"),
        "npm" => which("npm"),
        "pip" | "python" => which("python"),
        "winget" => cfg!(windows) && which("winget"),
        "node" => which("node"),
        "claude" => which("claude") || home().is_some_and(|dir| dir.join(".claude").exists()),
        "codex" => which("codex") || home().is_some_and(|dir| dir.join(".codex").exists()),
        _ => false,
    }
}

pub fn read(program: &str, id: &str) -> String {
    match program {
        "gitbash" => home()
            .and_then(|dir| std::fs::read_to_string(dir.join(gitbash_file(id))).ok())
            .and_then(|text| block_values(&text).remove(id))
            .unwrap_or_default(),
        "npm" => command_output(npm(), &["config", "get", id, "--location=user"])
            .filter(|value| value != "undefined")
            .unwrap_or_default(),
        "pip" => command_output("python", &["-m", "pip", "config", "--user", "get", id])
            .unwrap_or_default(),
        "winget" => winget_settings_path()
            .and_then(|path| read_json(&path).ok())
            .map(|json| json_get(&json, id))
            .unwrap_or_default(),
        "python" | "node" => user_env_get(id),
        "claude" => home()
            .and_then(|dir| read_json(&dir.join(".claude").join("settings.json")).ok())
            .map(|json| json_get(&json, id))
            .unwrap_or_default(),
        "codex" => home()
            .and_then(|dir| std::fs::read_to_string(dir.join(".codex").join("config.toml")).ok())
            .map(|text| toml_get(&text, id))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

pub fn write(program: &str, id: &str, value: &str) -> Result<(), String> {
    match program {
        "gitbash" => {
            let path = home()
                .ok_or("No se encontró la carpeta del usuario.")?
                .join(gitbash_file(id));
            let current = std::fs::read_to_string(&path).unwrap_or_default();
            let mut values = block_values(&current);
            if value.is_empty() {
                values.remove(id);
            } else {
                values.insert(id.to_string(), value.to_string());
            }
            // Cada archivo solo con sus ajustes.
            let file = gitbash_file(id);
            values.retain(|key, _| gitbash_file(key) == file);
            let next = with_block(&current, &values, gitbash_line);
            std::fs::write(&path, next)
                .map_err(|error| format!("No se pudo guardar {}: {error}", path.display()))
        }
        "npm" => {
            if value.is_empty() {
                run(npm(), &["config", "delete", id, "--location=user"])
            } else {
                run(
                    npm(),
                    &["config", "set", &format!("{id}={value}"), "--location=user"],
                )
            }
        }
        "pip" => {
            if value.is_empty() {
                // Sin la clave, `unset` sale con error: no es un fallo.
                let _ = run("python", &["-m", "pip", "config", "--user", "unset", id]);
                Ok(())
            } else {
                run(
                    "python",
                    &["-m", "pip", "config", "--user", "set", id, value],
                )
            }
        }
        "winget" => {
            let path = winget_settings_path().ok_or("No se encontró la carpeta de WinGet.")?;
            let mut json = read_json(&path)?;
            json_set(
                &mut json,
                id,
                (!value.is_empty()).then(|| typed_json(kind_of(program, id), value)),
            );
            write_json(&path, &json, true)
        }
        "python" | "node" => {
            // PYTHONUTF8 y compañía: «1» encendido, sin variable apagado.
            let stored = match kind_of(program, id) {
                SettingKind::Toggle if value == "true" => "1".to_string(),
                SettingKind::Toggle => String::new(),
                _ => value.to_string(),
            };
            user_env_set(id, &stored)
        }
        "claude" => {
            let path = home()
                .ok_or("No se encontró la carpeta del usuario.")?
                .join(".claude")
                .join("settings.json");
            let mut json = read_json(&path)?;
            json_set(
                &mut json,
                id,
                (!value.is_empty()).then(|| typed_json(kind_of(program, id), value)),
            );
            write_json(&path, &json, true)
        }
        "codex" => {
            let path = home()
                .ok_or("No se encontró la carpeta del usuario.")?
                .join(".codex")
                .join("config.toml");
            let current = std::fs::read_to_string(&path).unwrap_or_default();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let next = toml_set(&current, id, (!value.is_empty()).then_some(value));
            std::fs::write(&path, next)
                .map_err(|error| format!("No se pudo guardar {}: {error}", path.display()))
        }
        _ => Err(format!("Programa desconocido: {program}")),
    }
}

/// Lo leído de una variable de usuario, como lo enseña Ajustes.
fn user_env_get(id: &str) -> String {
    let raw = read_user_env(id);
    match kind_of(
        if id == "NODE_REPL_HISTORY_SIZE" {
            "node"
        } else {
            "python"
        },
        id,
    ) {
        SettingKind::Toggle if raw.is_empty() => String::new(),
        SettingKind::Toggle => (raw == "1").to_string(),
        _ => raw,
    }
}

#[cfg(windows)]
fn read_user_env(id: &str) -> String {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ)
        .and_then(|key| key.get_value::<String, _>(id))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn read_user_env(_id: &str) -> String {
    String::new()
}

#[cfg(windows)]
pub fn user_env_set(id: &str, value: &str) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    let (env, _) = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey("Environment")
        .map_err(|error| error.to_string())?;
    if value.is_empty() {
        let _ = env.delete_value(id);
        std::env::remove_var(id);
    } else {
        env.set_value(id, &value)
            .map_err(|error| error.to_string())?;
        // Las pestañas heredan el entorno de WTerminal.
        std::env::set_var(id, value);
    }
    crate::platform::path_integration::notify_environment_changed();
    Ok(())
}

#[cfg(not(windows))]
pub fn user_env_set(_id: &str, _value: &str) -> Result<(), String> {
    Err("Solo en Windows por ahora.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_bloque_de_git_bash_no_toca_lo_demas() {
        let bashrc = "alias ll='ls -la'\n";
        let mut values = BTreeMap::new();
        values.insert("historySize".to_string(), "5000".to_string());
        values.insert("ignoreDups".to_string(), "true".to_string());
        let with = with_block(bashrc, &values, gitbash_line);
        assert!(with.starts_with("alias ll='ls -la'\n\n"));
        assert!(with.contains("export HISTSIZE=5000\n"));
        assert!(with.contains("export HISTCONTROL=ignoreboth\n"));
        assert_eq!(block_values(&with), values);
        let removed = with_block(&with, &BTreeMap::new(), gitbash_line);
        assert_eq!(removed.trim_end(), bashrc.trim_end());
        // Nada de colar órdenes por un valor.
        assert!(gitbash_line("historySize", "5; rm -rf ~").is_none());
        assert!(gitbash_line("editingMode", "vi\nrm").is_none());
    }

    #[test]
    fn el_json_cambia_solo_su_clave() {
        let mut json: Value =
            serde_json::from_str(r#"{"env":{"A":"1"},"permissions":{"allow":["Bash"]}}"#).unwrap();
        json_set(
            &mut json,
            "permissions.defaultMode",
            Some(Value::String("plan".into())),
        );
        json_set(&mut json, "model", Some(Value::String("opus".into())));
        assert_eq!(json_get(&json, "permissions.defaultMode"), "plan");
        assert_eq!(json["permissions"]["allow"][0], "Bash");
        assert_eq!(json["env"]["A"], "1");
        json_set(&mut json, "model", None);
        assert_eq!(json_get(&json, "model"), "");
    }

    #[test]
    fn el_settings_de_winget_se_lee_con_sus_comentarios() {
        let text = "{\n  // Comentario\n  \"$schema\": \"https://aka.ms/winget-settings.schema.json\",\n  \"visual\": { \"progressBar\": \"rainbow\" } // al final\n}\n";
        let json: Value = serde_json::from_str(&strip_line_comments(text)).unwrap();
        assert_eq!(json_get(&json, "visual.progressBar"), "rainbow");
        assert_eq!(
            json_get(&json, "$schema"),
            "https://aka.ms/winget-settings.schema.json"
        );
    }

    #[test]
    fn el_toml_de_codex_cambia_solo_su_clave() {
        let text = "model = \"gpt-5\"\n# nota\n\n[mcp_servers.x]\ncommand = \"y\"\n";
        assert_eq!(toml_get(text, "model"), "gpt-5");
        let changed = toml_set(text, "approval_policy", Some("on-request"));
        assert!(changed.starts_with("approval_policy = \"on-request\"\n"));
        assert!(changed.contains("[mcp_servers.x]\ncommand = \"y\""));
        let replaced = toml_set(&changed, "model", Some("o4"));
        assert_eq!(toml_get(&replaced, "model"), "o4");
        // Una clave igual dentro de una tabla no cuenta como la de arriba.
        assert_eq!(toml_get("[t]\nmodel = \"x\"\n", "model"), "");
        let removed = toml_set(&replaced, "model", None);
        assert_eq!(toml_get(&removed, "model"), "");
    }
}
