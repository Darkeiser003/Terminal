//! Detecta, a partir de lo que la shell activa escribe en la terminal, cuándo
//! el usuario tecleó un comando de una herramienta conocida que no está
//! instalada, para poder sugerir instalarla ahí mismo (reutilizando el catálogo
//! de acciones de instalación) en vez de solo mostrar el error nativo de
//! "comando no encontrado" de cada shell.
//!
//! Port de `electron/main/commandNotFound.js`.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

/// Cada patrón captura el nombre del comando que falló. El texto exacto del
/// mensaje varía por shell y por idioma del sistema; se cubren español e
/// inglés, que son los más comunes.
///
/// Las comillas se aceptan simples o dobles a propósito: cmd.exe entrecomilla
/// el nombre con `"` (comprobado en un Windows 10 en español), mientras que
/// PowerShell usa `'`. La versión Electron solo contemplaba `'` en los dos, con
/// lo que en cmd nunca llegaba a detectar nada.
static PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        // cmd.exe
        r#"["']([^"']+)["'] no se reconoce como un comando interno o externo"#,
        r#"["']([^"']+)["'] is not recognized as an internal or external command"#,
        // PowerShell (Windows/Core)
        r#"El término ["']([^"']+)["'] no se reconoce como nombre de un cmdlet"#,
        r#"The term ["']([^"']+)["'] is not recognized as the name of a cmdlet"#,
        // bash / sh / WSL / Git Bash
        r"(?:bash|sh): ([^\s:]+): (?:command not found|no se encontró la orden)",
        // zsh
        r"zsh: command not found: (\S+)",
        // fish
        r"fish: Unknown command:? (\S+)",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("los patrones de comando no encontrado son válidos"))
    .collect()
});

/// Solo interesa la primera "palabra" del comando (docker, git, node...): si el
/// usuario escribió "docker ps" y falló, la shell solo reporta "docker".
fn extract_tool_name(raw_command: &str) -> String {
    raw_command
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase()
        .trim_end_matches(".exe")
        .to_string()
}

/// El nombre de la herramienta que falta, o `None` si el fragmento de salida no
/// contiene ninguno de los patrones conocidos de "no encontrado".
pub fn detect_missing_command(output: &str) -> Option<String> {
    for pattern in PATTERNS.iter() {
        if let Some(captures) = pattern.captures(output) {
            let name = extract_tool_name(captures.get(1)?.as_str());
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

struct KnownTool {
    name: &'static str,
    label: &'static str,
    windows: Option<&'static str>,
    macos: Option<&'static str>,
    linux: Option<&'static str>,
}

/// Catálogo de herramientas reconocibles -> id de acción de instalación según
/// el SO. `None` significa que se reconoce la herramienta pero no hay
/// instalación automática disponible.
#[rustfmt::skip]
static KNOWN_TOOLS: &[KnownTool] = &[
    KnownTool { name: "docker",  label: "Docker",            windows: Some("winget-docker"),    macos: Some("brew-docker"), linux: Some("pkg-docker") },
    KnownTool { name: "git",     label: "Git",               windows: Some("winget-git"),       macos: Some("brew-git"),    linux: Some("pkg-git") },
    KnownTool { name: "git-lfs", label: "Git LFS",           windows: Some("winget-git-lfs"),   macos: None,                linux: Some("pkg-git-lfs") },
    KnownTool { name: "gh",      label: "GitHub CLI",        windows: Some("winget-gh"),        macos: None,                linux: Some("pkg-gh") },
    KnownTool { name: "rg",      label: "ripgrep",           windows: Some("winget-ripgrep"),   macos: None,                linux: Some("pkg-ripgrep") },
    KnownTool { name: "fd",      label: "fd",                windows: Some("winget-fd"),        macos: None,                linux: None },
    KnownTool { name: "fzf",     label: "fzf",               windows: Some("winget-fzf"),       macos: None,                linux: Some("pkg-fzf") },
    KnownTool { name: "bat",     label: "bat",               windows: Some("winget-bat"),       macos: None,                linux: None },
    KnownTool { name: "eza",     label: "eza",               windows: Some("winget-eza"),       macos: None,                linux: Some("pkg-eza") },
    KnownTool { name: "just",    label: "just",              windows: Some("winget-just"),      macos: None,                linux: Some("pkg-just") },
    KnownTool { name: "node",    label: "Node.js",           windows: Some("winget-node"),      macos: Some("brew-node"),   linux: Some("pkg-node") },
    KnownTool { name: "npm",     label: "Node.js (npm)",     windows: Some("winget-node"),      macos: Some("brew-node"),   linux: Some("pkg-node") },
    KnownTool { name: "python",  label: "Python",            windows: Some("winget-python"),    macos: Some("brew-python"), linux: Some("pkg-python") },
    KnownTool { name: "python3", label: "Python",            windows: Some("winget-python"),    macos: Some("brew-python"), linux: Some("pkg-python") },
    KnownTool { name: "adb",     label: "ADB (Android Platform Tools)", windows: Some("adb-install"), macos: Some("brew-adb"), linux: Some("pkg-adb") },
    KnownTool { name: "ssh",     label: "SSH (OpenSSH)",     windows: Some("winget-ssh"),       macos: Some("brew-ssh"),    linux: Some("pkg-ssh") },
    KnownTool { name: "wsl",     label: "WSL",               windows: Some("wsl-install-base"), macos: None,                linux: None },
    KnownTool { name: "bash",    label: "Bash / Git Bash",   windows: Some("winget-git"),       macos: Some("brew-bash"),   linux: Some("pkg-bash") },
    KnownTool { name: "zsh",     label: "zsh",               windows: None,                     macos: Some("brew-zsh"),    linux: Some("pkg-zsh") },
    KnownTool { name: "fish",    label: "fish",              windows: None,                     macos: Some("brew-fish"),   linux: Some("pkg-fish") },
    KnownTool { name: "pwsh",    label: "PowerShell 7",      windows: Some("winget-pwsh"),      macos: None,                linux: Some("pkg-pwsh") },
    // En Linux/macOS, `wine` es lo que da un cmd.exe utilizable: si alguien lo
    // teclea sin tenerlo, la sugerencia lleva justo a esa instalación.
    KnownTool { name: "wine",    label: "Wine (cmd.exe)",    windows: None,                     macos: None,                linux: Some("pkg-wine") },
    KnownTool { name: "wt",      label: "Windows Terminal",  windows: Some("winget-wt"),        macos: None,                linux: None },
    KnownTool { name: "podman",  label: "Podman",            windows: Some("winget-podman"),    macos: None,                linux: Some("pkg-podman") },
    KnownTool { name: "minikube", label: "minikube",         windows: Some("winget-minikube"),  macos: None,                linux: None },
    KnownTool { name: "kind",    label: "kind",              windows: Some("winget-kind"),      macos: None,                linux: None },
    KnownTool { name: "kustomize", label: "Kustomize",       windows: Some("winget-kustomize"), macos: None,                linux: None },
    KnownTool { name: "terraform", label: "Terraform",       windows: Some("winget-terraform"), macos: None,                linux: None },
    KnownTool { name: "tofu",    label: "OpenTofu",          windows: Some("winget-opentofu"),  macos: None,                linux: None },
    KnownTool { name: "aws",     label: "AWS CLI",           windows: Some("winget-aws-cli"),   macos: None,                linux: None },
    KnownTool { name: "az",      label: "Azure CLI",         windows: Some("winget-azure-cli"), macos: None,                linux: None },
];

/// Las herramientas que se pueden instalar dentro de una distro WSL con su
/// propio gestor de paquetes, en vez de en el Windows anfitrión.
const WSL_INSTALLABLE: [&str; 13] = [
    "git", "git-lfs", "gh", "ripgrep", "fzf", "eza", "just", "podman", "node", "python", "bash",
    "fish", "zsh",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSuggestion {
    pub tool: String,
    pub label: String,
    /// Id de la acción del panel de dependencias. `None` = se reconoce la
    /// herramienta pero no hay nada que ejecutar por ella en este sistema.
    pub action_id: Option<String>,
}

/// Contexto de la pestaña donde falló el comando: decide si la instalación
/// tiene que ocurrir en el host o dentro de una distro WSL.
#[derive(Debug, Default, Clone)]
pub struct SuggestionContext {
    pub is_wsl: bool,
    pub distro: Option<String>,
}

/// Convierte un nombre de distro en un fragmento de id seguro:
/// `Ubuntu-22.04` -> `ubuntu-22-04`.
fn distro_slug(distro: &str) -> String {
    let lowered: String = distro
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // Colapsa los guiones consecutivos que deja el paso anterior.
    let mut slug = String::with_capacity(lowered.len());
    let mut previous_dash = false;
    for c in lowered.chars() {
        if c == '-' {
            if !previous_dash {
                slug.push('-');
            }
            previous_dash = true;
        } else {
            slug.push(c);
            previous_dash = false;
        }
    }
    slug.trim_matches('-').to_string()
}

/// Resuelve el nombre de herramienta detectado a una sugerencia concreta para
/// el SO actual, o `None` si no es una herramienta reconocida.
pub fn resolve_tool_suggestion(
    tool_name: &str,
    platform: &str,
    context: &SuggestionContext,
) -> Option<ToolSuggestion> {
    let known = KNOWN_TOOLS.iter().find(|entry| entry.name == tool_name)?;

    if platform == "windows" || platform == "win32" {
        if let (true, Some(distro)) = (context.is_wsl, context.distro.as_deref()) {
            // Dentro de WSL el paquete lo instala la distro, no winget.
            let wsl_tool = match tool_name {
                "npm" => "node",
                "python3" => "python",
                "rg" => "ripgrep",
                other => other,
            };
            if WSL_INSTALLABLE.contains(&wsl_tool) {
                return Some(ToolSuggestion {
                    tool: tool_name.to_string(),
                    label: format!("{} en WSL: {distro}", known.label),
                    action_id: Some(format!("wsl-{}-{wsl_tool}", distro_slug(distro))),
                });
            }
        }
    }

    let action_id = match platform {
        "windows" | "win32" => known.windows,
        "macos" | "darwin" => known.macos,
        _ => known.linux,
    };
    Some(ToolSuggestion {
        tool: tool_name.to_string(),
        label: known.label.to_string(),
        action_id: action_id.map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn se_reconoce_el_error_de_cmd_en_los_dos_idiomas() {
        assert_eq!(
            detect_missing_command("'docker' no se reconoce como un comando interno o externo,"),
            Some("docker".to_string())
        );
        assert_eq!(
            detect_missing_command("'git' is not recognized as an internal or external command"),
            Some("git".to_string())
        );
    }

    #[test]
    fn cmd_entrecomilla_con_dobles_y_tambien_se_reconoce() {
        // Texto literal de un Windows 10 en español.
        let salida = "\"docker\" no se reconoce como un comando interno o externo,\r\n\
                      programa o archivo por lotes ejecutable.\r\n";
        assert_eq!(detect_missing_command(salida), Some("docker".to_string()));
    }

    #[test]
    fn se_reconoce_el_error_de_powershell() {
        assert_eq!(
            detect_missing_command("El término 'node' no se reconoce como nombre de un cmdlet"),
            Some("node".to_string())
        );
        assert_eq!(
            detect_missing_command("The term 'adb' is not recognized as the name of a cmdlet"),
            Some("adb".to_string())
        );
    }

    #[test]
    fn se_reconocen_los_errores_de_las_shells_unix() {
        assert_eq!(
            detect_missing_command("bash: python3: command not found"),
            Some("python3".to_string())
        );
        assert_eq!(
            detect_missing_command("bash: git: no se encontró la orden"),
            Some("git".to_string())
        );
        assert_eq!(
            detect_missing_command("zsh: command not found: fish"),
            Some("fish".to_string())
        );
        assert_eq!(
            detect_missing_command("fish: Unknown command: wine"),
            Some("wine".to_string())
        );
    }

    #[test]
    fn una_salida_normal_no_dispara_nada() {
        assert_eq!(detect_missing_command("C:\\Users\\Ana>dir"), None);
        assert_eq!(detect_missing_command(""), None);
    }

    #[test]
    fn se_queda_con_la_primera_palabra_y_sin_extension() {
        assert_eq!(extract_tool_name("  Docker.EXE  ps -a "), "docker");
        assert_eq!(extract_tool_name("git"), "git");
    }

    #[test]
    fn una_herramienta_desconocida_no_da_sugerencia() {
        let context = SuggestionContext::default();
        assert_eq!(resolve_tool_suggestion("cobol", "windows", &context), None);
    }

    #[test]
    fn cada_plataforma_propone_su_propia_accion() {
        let context = SuggestionContext::default();
        let en = |platform| {
            resolve_tool_suggestion("docker", platform, &context)
                .unwrap()
                .action_id
        };
        assert_eq!(en("windows").as_deref(), Some("winget-docker"));
        assert_eq!(en("macos").as_deref(), Some("brew-docker"));
        assert_eq!(en("linux").as_deref(), Some("pkg-docker"));
    }

    #[test]
    fn una_herramienta_sin_instalacion_se_reconoce_pero_no_propone_nada() {
        let context = SuggestionContext::default();
        let suggestion = resolve_tool_suggestion("wsl", "linux", &context).unwrap();
        assert_eq!(suggestion.label, "WSL");
        assert_eq!(suggestion.action_id, None);
    }

    #[test]
    fn dentro_de_wsl_la_instalacion_va_a_la_distro() {
        let context = SuggestionContext {
            is_wsl: true,
            distro: Some("Ubuntu-22.04".into()),
        };
        let suggestion = resolve_tool_suggestion("npm", "windows", &context).unwrap();
        assert_eq!(
            suggestion.action_id.as_deref(),
            Some("wsl-ubuntu-22-04-node")
        );
        assert_eq!(suggestion.label, "Node.js (npm) en WSL: Ubuntu-22.04");
    }

    #[test]
    fn en_wsl_lo_que_no_instala_la_distro_cae_al_host() {
        let context = SuggestionContext {
            is_wsl: true,
            distro: Some("Ubuntu".into()),
        };
        let suggestion = resolve_tool_suggestion("docker", "windows", &context).unwrap();
        assert_eq!(suggestion.action_id.as_deref(), Some("winget-docker"));
    }

    #[test]
    fn el_nombre_de_la_distro_se_reduce_a_un_id_seguro() {
        assert_eq!(distro_slug("Ubuntu-22.04"), "ubuntu-22-04");
        assert_eq!(distro_slug("openSUSE Leap 15.5"), "opensuse-leap-15-5");
        assert_eq!(distro_slug("--raro--"), "raro");
    }
}
