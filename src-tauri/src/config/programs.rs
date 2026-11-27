//! Ajustes de los programas de la terminal (22-11, Romen: «se podrían añadir
//! ajustes para las aplicaciones de la terminal y no solo para la terminal…
//! cmd, PowerShell, Git…»).
//!
//! Cada ajuste se lee y se guarda en el sitio del PROPIO programa (la
//! variable `PROMPT` y la clave `Command Processor` de cmd, un bloque marcado
//! en el perfil de PowerShell, `git config --global`), así vale igual dentro y
//! fuera de WTerminal. Solo están los que se notan dentro de WTerminal:
//!
//! - cmd se abre con `/d` (sin AutoRun), así que nada de AutoRun;
//! - PowerShell se abre con `-ExecutionPolicy Bypass`, así que la directiva de
//!   ejecución no se ofrece (solo se notaría fuera);
//! - WTerminal ya pone UTF-8 en cmd (`chcp 65001`).
//!
//! Antes de cambiar un ajuste se guarda su valor anterior en
//! `<datos>/programas/deshacer.json`; «Deshacer» devuelve el último cambio de
//! ese programa.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Qué clase de control pinta Ajustes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingKind {
    Toggle,
    Text,
    Choice,
    Number,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramSetting {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: SettingKind,
    /// El valor guardado ahora. Vacío = el del programa (sin tocar).
    pub value: String,
    /// El valor que usa el programa cuando no hay nada guardado.
    pub default_value: String,
    pub options: Vec<SettingOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramSection {
    pub id: String,
    pub name: String,
    pub available: bool,
    /// Dónde se guarda (archivo, clave del registro u orden).
    pub source: String,
    pub note: Option<String>,
    pub can_undo: bool,
    pub settings: Vec<ProgramSetting>,
}

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

// ---------------------------------------------------------------- cmd ----

const CMD_PROCESSOR_KEY: &str = r"Software\Microsoft\Command Processor";

fn cmd_settings() -> Vec<ProgramSetting> {
    vec![
        setting(
            "prompt",
            "Texto del prompt",
            "Lo que cmd escribe antes de cada orden (la variable PROMPT). $P es la carpeta, $G es «>», $_ un salto de línea, $T la hora. Vacío = el de siempre ($P$G).",
            SettingKind::Choice,
            "",
            vec![
                option("", "El de siempre: C:\\carpeta>"),
                option("$P$_$G", "En dos líneas: la carpeta arriba y «>» debajo"),
                option("$T$H$H$H $P$G", "Con la hora: 19:05 C:\\carpeta>"),
                option("$P$G$S", "Con un espacio tras «>»"),
            ],
        ),
        setting(
            "delayedExpansion",
            "Expansión retardada de variables",
            "Permite !variable! dentro de bucles y bloques (como cmd /V:ON). Apagado de fábrica en Windows.",
            SettingKind::Toggle,
            "false",
            Vec::new(),
        ),
        setting(
            "enableExtensions",
            "Extensiones de órdenes",
            "Las órdenes ampliadas de cmd (if defined, for /f, set /a…). Encendido de fábrica: apagarlo rompe muchos scripts.",
            SettingKind::Toggle,
            "true",
            Vec::new(),
        ),
    ]
}

// --------------------------------------------------------- PowerShell ----

pub const PROFILE_BLOCK_START: &str =
    "# >>> WTerminal: ajustes de PowerShell (no editar a mano) >>>";
pub const PROFILE_BLOCK_END: &str = "# <<< WTerminal <<<";

fn powershell_settings() -> Vec<ProgramSetting> {
    vec![
        setting(
            "editMode",
            "Modo de edición de la línea",
            "Cómo se edita lo que escribes: Windows (Ctrl+C copia, Ctrl+V pega), Emacs (como bash: Ctrl+A, Ctrl+E…) o Vi.",
            SettingKind::Choice,
            "Windows",
            vec![
                option("Windows", "Windows"),
                option("Emacs", "Emacs (como bash)"),
                option("Vi", "Vi"),
            ],
        ),
        setting(
            "historyNoDuplicates",
            "No repetir órdenes en el historial",
            "Al buscar con ↑ o Ctrl+R, una orden repetida sale una sola vez.",
            SettingKind::Toggle,
            "true",
            Vec::new(),
        ),
        setting(
            "maximumHistoryCount",
            "Tamaño del historial",
            "Cuántas órdenes recuerda (de 100 a 32767).",
            SettingKind::Number,
            "4096",
            Vec::new(),
        ),
        setting(
            "bellStyle",
            "Pitido",
            "Qué hace PowerShell cuando algo no se puede (por ejemplo, borrar con la línea vacía).",
            SettingKind::Choice,
            "Audible",
            vec![
                option("None", "Nada"),
                option("Visual", "Un destello"),
                option("Audible", "Un pitido"),
            ],
        ),
        setting(
            "utf8Output",
            "Salida en UTF-8",
            "Que los programas que lanza PowerShell escriban tildes y símbolos bien (Python, Node, git…).",
            SettingKind::Toggle,
            "false",
            Vec::new(),
        ),
    ]
}

/// Valores guardados en el bloque del perfil: `# wt:<id>=<valor>`.
pub fn profile_block_values(profile: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    let Some(start) = profile.find(PROFILE_BLOCK_START) else {
        return values;
    };
    let Some(end) = profile[start..].find(PROFILE_BLOCK_END) else {
        return values;
    };
    for line in profile[start..start + end].lines() {
        if let Some(pair) = line.trim().strip_prefix("# wt:") {
            if let Some((key, value)) = pair.split_once('=') {
                values.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
    }
    values
}

/// La orden de PowerShell de un ajuste (sin valor, ninguna).
fn powershell_line(id: &str, value: &str) -> Option<String> {
    let psrl = |option: &str| {
        format!(
            "if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {{ try {{ Set-PSReadLineOption {option} }} catch {{}} }}"
        )
    };
    match id {
        "editMode" if matches!(value, "Windows" | "Emacs" | "Vi") => Some(psrl(&format!("-EditMode {value}"))),
        "historyNoDuplicates" if matches!(value, "true" | "false") => {
            Some(psrl(&format!("-HistoryNoDuplicates:${value}")))
        }
        "maximumHistoryCount" => value
            .parse::<u32>()
            .ok()
            .filter(|count| (100..=32767).contains(count))
            .map(|count| psrl(&format!("-MaximumHistoryCount {count}"))),
        "bellStyle" if matches!(value, "None" | "Visual" | "Audible") => {
            Some(psrl(&format!("-BellStyle {value}")))
        }
        "utf8Output" if value == "true" => Some(
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8".to_string(),
        ),
        _ => None,
    }
}

/// El perfil con el bloque de WTerminal puesto al día. Lo de fuera del bloque
/// no se toca; sin ningún valor, el bloque desaparece.
pub fn profile_with_block(profile: &str, values: &BTreeMap<String, String>) -> String {
    let newline = if profile.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut outside = profile.to_string();
    if let Some(start) = outside.find(PROFILE_BLOCK_START) {
        if let Some(rel_end) = outside[start..].find(PROFILE_BLOCK_END) {
            let mut end = start + rel_end + PROFILE_BLOCK_END.len();
            // El salto de línea que cerraba el bloque también se va.
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
            powershell_line(id, value).map(|command| format!("# wt:{id}={value}{newline}{command}"))
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
    result.push_str(PROFILE_BLOCK_START);
    result.push_str(newline);
    for line in lines {
        result.push_str(&line);
        result.push_str(newline);
    }
    result.push_str(PROFILE_BLOCK_END);
    result.push_str(newline);
    result
}

/// `profile.ps1` de «todos los hosts» del usuario: Windows PowerShell 5 en
/// `Documentos\WindowsPowerShell`, PowerShell 7 en `Documentos\PowerShell`.
fn powershell_profile_path(pwsh: bool) -> Option<PathBuf> {
    let documents = dirs::document_dir()?;
    Some(
        documents
            .join(if pwsh {
                "PowerShell"
            } else {
                "WindowsPowerShell"
            })
            .join("profile.ps1"),
    )
}

// ---------------------------------------------------------------- Git ----

fn git_settings() -> Vec<ProgramSetting> {
    let toggle = |id: &str, label: &str, description: &str, default_value: &str| {
        setting(
            id,
            label,
            description,
            SettingKind::Toggle,
            default_value,
            Vec::new(),
        )
    };
    vec![
        setting("user.name", "Tu nombre", "El autor de tus commits.", SettingKind::Text, "", Vec::new()),
        setting("user.email", "Tu correo", "El correo de tus commits (el de tu cuenta de GitHub, si quieres que salgan a tu nombre).", SettingKind::Text, "", Vec::new()),
        setting(
            "init.defaultBranch",
            "Rama inicial",
            "La rama de un repositorio nuevo.",
            SettingKind::Choice,
            "master",
            vec![option("main", "main"), option("master", "master"), option("develop", "develop")],
        ),
        setting(
            "core.autocrlf",
            "Finales de línea",
            "true: CRLF en Windows y LF en el repositorio (lo habitual en Windows); input: LF siempre; false: no tocar nada.",
            SettingKind::Choice,
            "true",
            vec![
                option("true", "Convertir (CRLF en Windows, LF en el repositorio)"),
                option("input", "Solo LF al guardar en el repositorio"),
                option("false", "No convertir nada"),
            ],
        ),
        setting(
            "core.editor",
            "Editor",
            "El que abre Git para escribir el mensaje de un commit o un rebase (por ejemplo «code --wait» o «notepad»).",
            SettingKind::Text,
            "",
            Vec::new(),
        ),
        toggle("pull.rebase", "Pull con rebase", "git pull reordena tus commits encima de los nuevos en vez de crear un commit de mezcla.", "false"),
        toggle("push.autoSetupRemote", "Subir ramas nuevas sin más", "git push de una rama nueva crea la del servidor sin pedir --set-upstream.", "false"),
        toggle("fetch.prune", "Limpiar ramas borradas al traer", "git fetch quita las ramas que ya no existen en el servidor.", "false"),
        toggle("core.longpaths", "Rutas largas", "Permite rutas de más de 260 caracteres en Windows (node_modules profundos).", "false"),
        setting(
            "color.ui",
            "Colores",
            "Colores en la salida de git.",
            SettingKind::Choice,
            "auto",
            vec![option("auto", "Automático"), option("always", "Siempre"), option("false", "Nunca")],
        ),
    ]
}

fn valid_git_value(id: &str, value: &str) -> Result<(), String> {
    if value.contains(['\n', '\r']) {
        return Err("El valor no puede tener saltos de línea.".into());
    }
    match id {
        "user.email" if !value.is_empty() && !(value.contains('@') && !value.contains(' ')) => {
            Err("El correo no parece válido.".into())
        }
        "init.defaultBranch"
            if !value.is_empty()
                && !value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.')) =>
        {
            Err("Nombre de rama no válido.".into())
        }
        _ => Ok(()),
    }
}

// ------------------------------------------------------------ comunes ----

fn valid_value(program: &str, id: &str, value: &str) -> Result<(), String> {
    let known = sections_template()
        .into_iter()
        .find(|section| section.id == program)
        .ok_or_else(|| format!("Programa desconocido: {program}"))?
        .settings
        .into_iter()
        .find(|setting| setting.id == id)
        .ok_or_else(|| format!("Ajuste desconocido: {id}"))?;
    if value.is_empty() {
        return Ok(());
    }
    match known.kind {
        SettingKind::Toggle if !matches!(value, "true" | "false") => {
            Err("Debe ser sí o no.".into())
        }
        SettingKind::Choice if !known.options.iter().any(|option| option.value == value) => {
            Err("Esa opción no existe.".into())
        }
        SettingKind::Number
            if matches!(program, "powershell" | "pwsh") && powershell_line(id, value).is_none() =>
        {
            Err("Número fuera de rango (100 a 32767).".into())
        }
        SettingKind::Number if !matches!(program, "powershell" | "pwsh") => {
            let (min, max) =
                super::programs_more::number_range(program, id).unwrap_or((0, u32::MAX));
            match value.parse::<u32>() {
                Ok(number) if (min..=max).contains(&number) => Ok(()),
                _ => Err(format!("Número fuera de rango ({min} a {max}).")),
            }
        }
        SettingKind::Text if program == "git" => valid_git_value(id, value),
        SettingKind::Text if value.contains(['\n', '\r', '"']) => {
            Err("El valor no puede tener saltos de línea ni comillas.".into())
        }
        SettingKind::Text if id.contains("registry") || id.contains("index-url") => {
            if value.starts_with("https://") || value.starts_with("http://") {
                Ok(())
            } else {
                Err("Tiene que ser una dirección http:// o https://.".into())
            }
        }
        SettingKind::Text if value.chars().count() > 200 => Err("Demasiado largo.".into()),
        _ => Ok(()),
    }
}

/// Las secciones sin valores: lo que se puede ajustar de cada programa.
pub fn sections_template() -> Vec<ProgramSection> {
    let section =
        |id: &str, name: &str, source: &str, note: Option<&str>, settings| ProgramSection {
            id: id.to_string(),
            name: name.to_string(),
            available: true,
            source: source.to_string(),
            note: note.map(str::to_string),
            can_undo: false,
            settings,
        };
    vec![
        section(
            "cmd",
            "Símbolo del sistema (cmd)",
            r"Variable PROMPT y HKCU\Software\Microsoft\Command Processor",
            Some("El prompt vale en las pestañas nuevas. WTerminal ya pone UTF-8 en cmd."),
            cmd_settings(),
        ),
        section(
            "powershell",
            "Windows PowerShell 5",
            r"Documentos\WindowsPowerShell\profile.ps1 (bloque «WTerminal»)",
            Some("Vale en las pestañas nuevas. Tu perfil fuera del bloque no se toca."),
            powershell_settings(),
        ),
        section(
            "pwsh",
            "PowerShell 7",
            r"Documentos\PowerShell\profile.ps1 (bloque «WTerminal»)",
            Some("Vale en las pestañas nuevas. Tu perfil fuera del bloque no se toca."),
            powershell_settings(),
        ),
        section(
            "git",
            "Git",
            "git config --global (~/.gitconfig)",
            None,
            git_settings(),
        ),
    ]
    .into_iter()
    .chain(super::programs_more::sections_template())
    .collect()
}

// -------------------------------------------------- deshacer (común) ----

#[derive(Debug, Default, Serialize, Deserialize)]
struct UndoLog {
    /// Por programa, los cambios en orden: (ajuste, valor anterior).
    entries: BTreeMap<String, Vec<(String, String)>>,
}

fn undo_path() -> PathBuf {
    crate::paths::user_data_dir()
        .join("programas")
        .join("deshacer.json")
}

fn read_undo(path: &Path) -> UndoLog {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_undo(path: &Path, log: &UndoLog) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(log).map_err(|error| error.to_string())?;
    std::fs::write(path, text)
        .map_err(|error| format!("No se pudo guardar la copia para deshacer: {error}"))
}

// ------------------------------------------- lectura y escritura (SO) ----

#[cfg(windows)]
mod system {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    fn hidden(program: &str) -> std::process::Command {
        crate::process::hidden_command(program)
    }

    pub fn program_available(id: &str) -> bool {
        match id {
            "cmd" | "powershell" => true,
            "pwsh" => crate::path_env::which("pwsh").is_some(),
            "git" => crate::path_env::which("git").is_some(),
            other => super::super::programs_more::available(other),
        }
    }

    pub fn read(program: &str, id: &str) -> String {
        match program {
            "cmd" => match id {
                "prompt" => RegKey::predef(HKEY_CURRENT_USER)
                    .open_subkey_with_flags("Environment", KEY_READ)
                    .and_then(|key| key.get_value::<String, _>("PROMPT"))
                    .unwrap_or_default(),
                "delayedExpansion" | "enableExtensions" => {
                    let name = if id == "delayedExpansion" {
                        "DelayedExpansion"
                    } else {
                        "EnableExtensions"
                    };
                    RegKey::predef(HKEY_CURRENT_USER)
                        .open_subkey_with_flags(CMD_PROCESSOR_KEY, KEY_READ)
                        .and_then(|key| key.get_value::<u32, _>(name))
                        .map(|value| (value != 0).to_string())
                        .unwrap_or_default()
                }
                _ => String::new(),
            },
            "powershell" | "pwsh" => powershell_profile_path(program == "pwsh")
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|text| profile_block_values(&text).remove(id).unwrap_or_default())
                .unwrap_or_default(),
            "git" => hidden("git")
                .args(["config", "--global", "--get", id])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .unwrap_or_default(),
            other => super::super::programs_more::read(other, id),
        }
    }

    pub fn write(program: &str, id: &str, value: &str) -> Result<(), String> {
        match program {
            "cmd" => match id {
                "prompt" => {
                    let (env, _) = RegKey::predef(HKEY_CURRENT_USER)
                        .create_subkey("Environment")
                        .map_err(|error| error.to_string())?;
                    if value.is_empty() {
                        let _ = env.delete_value("PROMPT");
                        std::env::remove_var("PROMPT");
                    } else {
                        env.set_value("PROMPT", &value)
                            .map_err(|error| error.to_string())?;
                        // Las pestañas heredan el entorno de WTerminal: así lo
                        // ven las nuevas sin reiniciar la app.
                        std::env::set_var("PROMPT", value);
                    }
                    crate::platform::path_integration::notify_environment_changed();
                    Ok(())
                }
                "delayedExpansion" | "enableExtensions" => {
                    let name = if id == "delayedExpansion" {
                        "DelayedExpansion"
                    } else {
                        "EnableExtensions"
                    };
                    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                        .create_subkey(CMD_PROCESSOR_KEY)
                        .map_err(|error| error.to_string())?;
                    if value.is_empty() {
                        let _ = key.delete_value(name);
                        Ok(())
                    } else {
                        key.set_value(name, &u32::from(value == "true"))
                            .map_err(|error| error.to_string())
                    }
                }
                _ => Err(format!("Ajuste desconocido: {id}")),
            },
            "powershell" | "pwsh" => {
                let path = powershell_profile_path(program == "pwsh")
                    .ok_or("No se encontró la carpeta Documentos.")?;
                let current = std::fs::read_to_string(&path).unwrap_or_default();
                let mut values = profile_block_values(&current);
                if value.is_empty() {
                    values.remove(id);
                } else {
                    values.insert(id.to_string(), value.to_string());
                }
                let next = profile_with_block(&current, &values);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                // Con BOM, como el resto de scripts de PowerShell: Windows
                // PowerShell 5 lee sin BOM en ANSI y rompería las tildes.
                let mut bytes = vec![0xEF, 0xBB, 0xBF];
                bytes.extend_from_slice(next.trim_start_matches('\u{feff}').as_bytes());
                std::fs::write(&path, bytes)
                    .map_err(|error| format!("No se pudo guardar {}: {error}", path.display()))
            }
            "git" => {
                let output = if value.is_empty() {
                    hidden("git")
                        .args(["config", "--global", "--unset", id])
                        .output()
                } else {
                    hidden("git")
                        .args(["config", "--global", id, value])
                        .output()
                }
                .map_err(|error| format!("No se pudo ejecutar git: {error}"))?;
                // `--unset` de algo que no estaba sale con 5: no es un fallo.
                if output.status.success() || (value.is_empty() && output.status.code() == Some(5))
                {
                    Ok(())
                } else {
                    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
                }
            }
            other => super::super::programs_more::write(other, id, value),
        }
    }
}

#[cfg(not(windows))]
mod system {
    pub fn program_available(_id: &str) -> bool {
        false
    }
    pub fn read(_program: &str, _id: &str) -> String {
        String::new()
    }
    pub fn write(_program: &str, _id: &str, _value: &str) -> Result<(), String> {
        Err("Solo en Windows por ahora.".into())
    }
}

/// Valores que WTerminal recomienda y pone solo (22-11, Romen: «si Git Bash
/// está instalado o se instala después, que se le aplique ese ajuste por
/// defecto»; «lo mismo para npm… deshabilitar la financiación»; WinGet sin
/// telemetría). Cada uno UNA vez y solo si el usuario no lo tenía puesto: si
/// luego lo cambia, no se vuelve a tocar. Se apaga con
/// `applyProgramDefaults` (casilla en Ajustes › Programas).
pub const RECOMMENDED: &[(&str, &str, &str)] = &[
    ("gitbash", "completionIgnoreCase", "true"),
    ("npm", "fund", "false"),
    ("winget", "telemetry.disable", "true"),
];

fn applied_path() -> PathBuf {
    crate::paths::user_data_dir()
        .join("programas")
        .join("recomendados.json")
}

/// Qué recomendados quedan por aplicar: los que no se miraron aún.
pub fn pending_recommended(
    applied: &std::collections::BTreeSet<String>,
) -> Vec<(&'static str, &'static str, &'static str)> {
    RECOMMENDED
        .iter()
        .copied()
        .filter(|(program, id, _)| !applied.contains(&format!("{program}:{id}")))
        .collect()
}

/// Aplica los recomendados de los programas instalados. Uno que aún no está
/// instalado se queda pendiente y se aplica cuando lo esté.
pub fn apply_recommended() {
    if !crate::preferences::current().apply_program_defaults {
        return;
    }
    let path = applied_path();
    let mut applied: std::collections::BTreeSet<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let mut changed = false;
    for (program, id, value) in pending_recommended(&applied) {
        if !system::program_available(program) {
            continue;
        }
        // Lo que el usuario ya tenía puesto manda.
        if system::read(program, id).is_empty() && system::write(program, id, value).is_ok() {
            crate::log_info!(
                "Valor recomendado aplicado a un programa",
                serde_json::json!({ "program": program, "setting": id, "value": value })
            );
        }
        applied.insert(format!("{program}:{id}"));
        changed = true;
    }
    if changed {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&applied) {
            let _ = std::fs::write(&path, text);
        }
    }
}

/// Una sección con sus valores actuales.
fn read_section(mut section: ProgramSection, undo: &UndoLog) -> ProgramSection {
    section.available = system::program_available(&section.id);
    section.can_undo = undo
        .entries
        .get(&section.id)
        .is_some_and(|items| !items.is_empty());
    if section.available {
        for setting in &mut section.settings {
            setting.value = system::read(&section.id, &setting.id);
        }
    }
    section
}

fn cache_path() -> PathBuf {
    crate::paths::user_data_dir()
        .join("programas")
        .join("cache.json")
}

/// Lo último que se leyó, para pintar la pestaña al momento (22-11, Romen:
/// «cachea las preferencias, como los entornos, para evitar tantos tiempos de
/// carga»). Lo de ahora llega después con `programs_list`.
pub fn cached() -> Vec<ProgramSection> {
    std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cache(sections: &[ProgramSection]) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(sections) {
        let _ = std::fs::write(path, text);
    }
}

/// Tras un cambio: la sección nueva en la caché, sin releer las demás.
fn patch_cache(updated: &[ProgramSection]) {
    let mut sections = cached();
    if sections.is_empty() {
        return;
    }
    for section in &mut sections {
        if let Some(fresh) = updated.iter().find(|item| item.id == section.id) {
            *section = fresh.clone();
        }
    }
    save_cache(&sections);
}

/// Al arrancar, en segundo plano y sin prisa: los recomendados y la caché, así
/// la pestaña Programas abre ya al día.
pub fn warm_up() {
    std::thread::sleep(std::time::Duration::from_secs(45));
    apply_recommended();
    let _ = list();
}

/// Las secciones con sus valores actuales. Cada programa se lee en su hilo:
/// npm y pip tardan uno o dos segundos por ajuste y, uno detrás de otro, la
/// pestaña tardaba en abrir (22-11).
pub fn list() -> Vec<ProgramSection> {
    let undo = read_undo(&undo_path());
    std::thread::scope(|scope| {
        let handles: Vec<_> = sections_template()
            .into_iter()
            .map(|section| {
                let undo = &undo;
                scope.spawn(move || read_section(section, undo))
            })
            .collect();
        let sections: Vec<ProgramSection> = handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect();
        save_cache(&sections);
        sections
    })
}

/// Solo la sección de un programa: tras un cambio no se relee todo (22-11:
/// la casilla quedaba deshabilitada varios segundos mientras se releían npm,
/// pip y los demás).
fn only(program: &str) -> Vec<ProgramSection> {
    let undo = read_undo(&undo_path());
    let sections: Vec<ProgramSection> = sections_template()
        .into_iter()
        .filter(|section| section.id == program)
        .map(|section| read_section(section, &undo))
        .collect();
    patch_cache(&sections);
    sections
}

pub fn set(program: &str, id: &str, value: &str) -> Result<Vec<ProgramSection>, String> {
    let value = value.trim();
    valid_value(program, id, value)?;
    if !system::program_available(program) {
        return Err(format!("{program} no está instalado."));
    }
    let previous = system::read(program, id);
    if previous == value {
        return Ok(only(program));
    }
    let path = undo_path();
    let mut undo = read_undo(&path);
    undo.entries
        .entry(program.to_string())
        .or_default()
        .push((id.to_string(), previous));
    write_undo(&path, &undo)?;
    system::write(program, id, value)?;
    crate::log_info!(
        "Ajuste de programa cambiado",
        serde_json::json!({ "program": program, "setting": id })
    );
    Ok(only(program))
}

pub fn undo(program: &str) -> Result<Vec<ProgramSection>, String> {
    let path = undo_path();
    let mut log = read_undo(&path);
    let Some((id, previous)) = log.entries.get_mut(program).and_then(Vec::pop) else {
        return Err("No hay nada que deshacer.".into());
    };
    system::write(program, &id, &previous)?;
    write_undo(&path, &log)?;
    Ok(only(program))
}

#[tauri::command(async)]
pub fn programs_cached() -> Vec<ProgramSection> {
    cached()
}

#[tauri::command(async)]
pub fn programs_list() -> Vec<ProgramSection> {
    // Un programa instalado después de arrancar recibe aquí sus recomendados.
    apply_recommended();
    list()
}

#[tauri::command(async)]
pub fn programs_set(
    program: String,
    id: String,
    value: String,
) -> Result<Vec<ProgramSection>, String> {
    set(&program, &id, &value)
}

#[tauri::command(async)]
pub fn programs_undo(program: String) -> Result<Vec<ProgramSection>, String> {
    undo(&program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn los_recomendados_se_aplican_una_vez_por_ajuste() {
        let mut applied = std::collections::BTreeSet::new();
        assert_eq!(pending_recommended(&applied).len(), RECOMMENDED.len());
        applied.insert("npm:fund".to_string());
        let pending = pending_recommended(&applied);
        assert!(!pending
            .iter()
            .any(|(program, id, _)| *program == "npm" && *id == "fund"));
        // Todos son valores válidos de su ajuste.
        for (program, id, value) in RECOMMENDED {
            assert!(
                valid_value(program, id, value).is_ok(),
                "{program}:{id}={value}"
            );
        }
    }

    #[test]
    fn el_bloque_del_perfil_no_toca_lo_demas() {
        let profile = "Import-Module posh-git\r\nSet-Alias ll Get-ChildItem\r\n";
        let with = profile_with_block(
            profile,
            &values(&[("editMode", "Emacs"), ("bellStyle", "None")]),
        );
        assert!(with.starts_with("Import-Module posh-git\r\nSet-Alias ll Get-ChildItem\r\n\r\n"));
        assert!(with.contains("Set-PSReadLineOption -EditMode Emacs"));
        assert!(with.contains("Set-PSReadLineOption -BellStyle None"));
        assert_eq!(
            profile_block_values(&with),
            values(&[("bellStyle", "None"), ("editMode", "Emacs")])
        );
        // Cambiar un valor reescribe el bloque, sin duplicarlo.
        let changed = profile_with_block(&with, &values(&[("editMode", "Vi")]));
        assert_eq!(changed.matches(PROFILE_BLOCK_START).count(), 1);
        assert!(changed.contains("-EditMode Vi") && !changed.contains("-BellStyle"));
        // Sin valores, el bloque se va y el perfil queda como estaba.
        let removed = profile_with_block(&changed, &BTreeMap::new());
        assert_eq!(removed.trim_end(), profile.trim_end());
    }

    #[test]
    fn un_perfil_vacio_solo_lleva_el_bloque() {
        let with = profile_with_block("", &values(&[("utf8Output", "true")]));
        assert!(with.starts_with(PROFILE_BLOCK_START));
        assert!(with.contains("[Console]::OutputEncoding = [Text.Encoding]::UTF8"));
    }

    #[test]
    fn los_valores_no_validos_no_llegan_al_perfil() {
        assert!(powershell_line("editMode", "Nano").is_none());
        assert!(powershell_line("maximumHistoryCount", "50").is_none());
        assert!(powershell_line("maximumHistoryCount", "99999").is_none());
        assert!(powershell_line("maximumHistoryCount", "10000").is_some());
        // Nada de inyectar órdenes por un valor.
        assert!(powershell_line("bellStyle", "None; Remove-Item C:\\").is_none());
    }

    #[test]
    fn se_validan_los_valores_antes_de_guardar() {
        assert!(valid_value("cmd", "prompt", "$P$_$G").is_ok());
        assert!(valid_value("cmd", "prompt", "$X$Y").is_err());
        assert!(valid_value("cmd", "delayedExpansion", "quizá").is_err());
        assert!(valid_value("git", "user.email", "romen").is_err());
        assert!(valid_value("git", "user.email", "a@b.c").is_ok());
        assert!(valid_value("git", "init.defaultBranch", "rama mala").is_err());
        assert!(valid_value("git", "core.editor", "code --wait").is_ok());
        assert!(valid_value("git", "user.name", "dos\nlíneas").is_err());
        assert!(valid_value("pwsh", "maximumHistoryCount", "5000").is_ok());
        assert!(valid_value("pwsh", "maximumHistoryCount", "5").is_err());
        assert!(valid_value("inventado", "x", "1").is_err());
        // Vacío = volver al del programa.
        assert!(valid_value("git", "user.email", "").is_ok());
    }

    #[test]
    fn deshacer_guarda_el_valor_anterior_por_programa() {
        let dir = std::env::temp_dir().join(format!("wt-programas-{}", std::process::id()));
        let path = dir.join("deshacer.json");
        let mut log = UndoLog::default();
        log.entries
            .entry("git".into())
            .or_default()
            .push(("user.name".into(), "Antes".into()));
        write_undo(&path, &log).unwrap();
        let read = read_undo(&path);
        assert_eq!(
            read.entries["git"],
            vec![("user.name".to_string(), "Antes".to_string())]
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
