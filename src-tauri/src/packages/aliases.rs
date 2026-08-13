//! Alias `install`, `update`, `upgrade`, `uninstall`, `remove` y `search`
//! traducidos al gestor de paquetes REAL del entorno de cada pestaña, para que
//! el mismo vocabulario funcione en cmd, PowerShell, Git Bash, WSL, Linux y
//! macOS.
//!
//! Port de `electron/main/packageAliases.js`.
//!
//! Dos estrategias, según lo que se pueda saber:
//!   - Windows: el gestor (winget/choco/scoop) se resuelve en el backend al
//!     crear la pestaña, porque cmd no permite encadenar condicionales dentro
//!     de una macro doskey de forma legible.
//!   - Unix (bash/zsh/sh/fish y todo lo que corre dentro de WSL): la elección
//!     se hace EN LA PROPIA SHELL al invocar el alias. Así una distro WSL que
//!     todavía no se había sondeado, o un contenedor, siguen resolviendo su
//!     gestor correcto sin que la app tenga que adivinarlo.
//!
//! Como el resto de la aplicación, estos alias solo escriben un comando normal:
//! se ve lo que se ejecuta y se puede cancelar con Ctrl+C.

use crate::environments::{ShellKind, Transport};

/// Nombres que estos alias ocupan: la inicialización los reserva para que
/// ningún script del usuario los pise sin querer.
pub const PACKAGE_ALIAS_NAMES: [&str; 6] = [
    "install",
    "update",
    "upgrade",
    "uninstall",
    "remove",
    "search",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Install,
    Update,
    UpgradeAll,
    Uninstall,
    Search,
}

pub struct WindowsManager {
    pub id: &'static str,
    pub label: &'static str,
    install: &'static str,
    update: &'static str,
    upgrade_all: &'static str,
    uninstall: &'static str,
    search: &'static str,
}

/// Cada acción es el comando SIN los paquetes; los argumentos del usuario se
/// añaden detrás (doskey `$*`, PowerShell `@args`, `"$@"` en Unix, `$argv` en
/// fish).
#[rustfmt::skip]
pub static WINDOWS_MANAGERS: &[WindowsManager] = &[
    WindowsManager {
        id: "winget", label: "winget",
        install: "winget install --accept-source-agreements --accept-package-agreements",
        update: "winget upgrade --accept-source-agreements --accept-package-agreements",
        upgrade_all: "winget upgrade --all --include-unknown --accept-source-agreements --accept-package-agreements",
        uninstall: "winget uninstall",
        search: "winget search --accept-source-agreements",
    },
    WindowsManager {
        id: "choco", label: "Chocolatey",
        install: "choco install -y",
        update: "choco upgrade -y",
        upgrade_all: "choco upgrade all -y",
        uninstall: "choco uninstall -y",
        search: "choco search",
    },
    WindowsManager {
        id: "scoop", label: "Scoop",
        install: "scoop install",
        update: "scoop update",
        upgrade_all: "scoop update *",
        uninstall: "scoop uninstall",
        search: "scoop search",
    },
];

pub fn windows_manager_by_id(id: &str) -> Option<&'static WindowsManager> {
    WINDOWS_MANAGERS.iter().find(|manager| manager.id == id)
}

struct UnixManager {
    probe: &'static str,
    /// La operación necesita privilegios. Homebrew se rompe si se ejecuta con
    /// sudo, y dentro de muchos contenedores ya se es root.
    priv_needed: bool,
    install: &'static str,
    update: &'static str,
    upgrade_all: &'static str,
    uninstall: &'static str,
    search: &'static str,
}

impl UnixManager {
    fn command(&self, action: Action) -> &'static str {
        match action {
            Action::Install => self.install,
            Action::Update => self.update,
            Action::UpgradeAll => self.upgrade_all,
            Action::Uninstall => self.uninstall,
            Action::Search => self.search,
        }
    }

    /// `search` es la excepción: consultar el catálogo de paquetes es de solo
    /// lectura y pedir la contraseña de sudo para buscar es absurdo (además de
    /// que apt lo desaconseja expresamente).
    fn needs_privileges(&self, action: Action) -> bool {
        self.priv_needed && action != Action::Search
    }
}

/// Orden de preferencia al detectar dentro de una shell Unix.
#[rustfmt::skip]
static UNIX_MANAGERS: &[UnixManager] = &[
    UnixManager { probe: "apt", priv_needed: true,
        install: "apt install -y", update: "apt install -y --only-upgrade",
        upgrade_all: "apt update && __wsterm_priv apt upgrade -y",
        uninstall: "apt remove -y", search: "apt-cache search" },
    UnixManager { probe: "dnf", priv_needed: true,
        install: "dnf install -y", update: "dnf upgrade -y",
        upgrade_all: "dnf upgrade -y", uninstall: "dnf remove -y", search: "dnf search" },
    UnixManager { probe: "pacman", priv_needed: true,
        install: "pacman -S --noconfirm", update: "pacman -S --noconfirm",
        upgrade_all: "pacman -Syu --noconfirm", uninstall: "pacman -Rs --noconfirm", search: "pacman -Ss" },
    UnixManager { probe: "zypper", priv_needed: true,
        install: "zypper install -y", update: "zypper update -y",
        upgrade_all: "zypper update -y", uninstall: "zypper remove -y", search: "zypper search" },
    UnixManager { probe: "apk", priv_needed: true,
        install: "apk add", update: "apk upgrade",
        upgrade_all: "apk update && __wsterm_priv apk upgrade",
        uninstall: "apk del", search: "apk search" },
    UnixManager { probe: "brew", priv_needed: false,
        install: "brew install", update: "brew upgrade",
        upgrade_all: "brew update && brew upgrade", uninstall: "brew uninstall", search: "brew search" },
];

const NO_MANAGER_MESSAGE: &str =
    "No se detecto un gestor de paquetes compatible (apt, dnf, pacman, zypper, apk o brew).";
const NO_WINDOWS_MANAGER_MESSAGE: &str =
    "No se detecto winget, Chocolatey ni Scoop. Instala App Installer desde Microsoft Store \
     o usa el panel Entorno y dependencias.";

/// Envoltorio de privilegios: si ya se es root se ejecuta directo (contenedores
/// y muchas distros WSL), si hay sudo se usa, y si no hay ninguna de las dos se
/// explica en vez de fallar con un "command not found" opaco.
const POSIX_PRIV: &str = "__wsterm_priv() { if [ \"$(id -u)\" = \"0\" ]; then \"$@\"; \
     elif command -v sudo >/dev/null 2>&1; then sudo \"$@\"; \
     else echo 'Se necesitan privilegios de administrador y sudo no esta disponible.' >&2; return 1; fi; }";

const FISH_PRIV: &str = "function __wsterm_priv; if test (id -u) = 0; $argv; \
     else if command -v sudo >/dev/null 2>&1; sudo $argv; \
     else; echo 'Se necesitan privilegios de administrador y sudo no esta disponible.' >&2; return 1; end; end";

fn posix_branches(action: Action, args: &str) -> String {
    UNIX_MANAGERS
        .iter()
        .map(|manager| {
            let prefix = if manager.needs_privileges(action) {
                "__wsterm_priv "
            } else {
                ""
            };
            format!(
                "if command -v {} >/dev/null 2>&1; then {prefix}{} {args}",
                manager.probe,
                manager.command(action)
            )
        })
        .collect::<Vec<_>>()
        .join("; el")
}

fn posix_function(name: &str, action: Action, args: &str) -> String {
    format!(
        "{name}() {{ {}; else echo '{NO_MANAGER_MESSAGE}' >&2; return 1; fi; }}",
        posix_branches(action, args)
    )
}

/// Cadena if/else de fish sin envolver en función, para poder anidarla dentro
/// de otra (por ejemplo `update` cuando sí recibe paquetes).
fn fish_branches(action: Action, args: &str) -> String {
    let branches = UNIX_MANAGERS
        .iter()
        .map(|manager| {
            let prefix = if manager.needs_privileges(action) {
                "__wsterm_priv "
            } else {
                ""
            };
            // fish no encadena con "&&": su equivalente exacto es "; and".
            let command = manager
                .command(action)
                .replace(" && __wsterm_priv ", "; and __wsterm_priv ")
                .replace(" && ", "; and ");
            format!(
                "if command -v {} >/dev/null 2>&1; {prefix}{command} {args}",
                manager.probe
            )
        })
        .collect::<Vec<_>>()
        .join("; else ");
    format!("{branches}; else; echo '{NO_MANAGER_MESSAGE}' >&2; return 1; end")
}

fn fish_function(name: &str, action: Action, args: &str) -> String {
    format!("function {name}; {}; end", fish_branches(action, args))
}

/// En Unix `install` es además un binario de coreutils (`install -m 755 ...`).
/// Si el primer argumento es una opción se delega en el programa real: nadie
/// pierde una herramienta del sistema por ganar un alias.
const POSIX_INSTALL_GUARD: &str =
    "case \"${1:-}\" in -*) command install \"$@\"; return $?;; esac; ";

fn unix_lines() -> Vec<String> {
    vec![
        POSIX_PRIV.to_string(),
        format!(
            "install() {{ {POSIX_INSTALL_GUARD}{}; else echo '{NO_MANAGER_MESSAGE}' >&2; return 1; fi; }}",
            posix_branches(Action::Install, "\"$@\"")
        ),
        posix_function("uninstall", Action::Uninstall, "\"$@\""),
        "remove() { uninstall \"$@\"; }".to_string(),
        posix_function("upgrade", Action::UpgradeAll, ""),
        // Sin argumentos, "update" actualiza todo el sistema; con ellos, solo
        // los paquetes indicados.
        format!(
            "update() {{ if [ \"$#\" -eq 0 ]; then upgrade; else {}; else echo '{NO_MANAGER_MESSAGE}' >&2; return 1; fi; fi; }}",
            posix_branches(Action::Update, "\"$@\"")
        ),
        posix_function("search", Action::Search, "\"$@\""),
    ]
}

fn fish_lines() -> Vec<String> {
    vec![
        FISH_PRIV.to_string(),
        format!(
            "function install; if string match -q -- '-*' \"$argv[1]\"; command install $argv; return $status; end; {}; end",
            fish_branches(Action::Install, "$argv")
        ),
        fish_function("uninstall", Action::Uninstall, "$argv"),
        "function remove; uninstall $argv; end".to_string(),
        fish_function("upgrade", Action::UpgradeAll, ""),
        format!(
            "function update; if test (count $argv) -eq 0; upgrade; else; {}; end; end",
            fish_branches(Action::Update, "$argv")
        ),
        fish_function("search", Action::Search, "$argv"),
    ]
}

fn windows_lines(kind: ShellKind, manager_id: Option<&str>) -> Vec<String> {
    let manager = manager_id.and_then(windows_manager_by_id);

    if kind == ShellKind::Cmd {
        return match manager {
            None => PACKAGE_ALIAS_NAMES
                .iter()
                .map(|name| format!("doskey {name}=echo {NO_WINDOWS_MANAGER_MESSAGE}"))
                .collect(),
            Some(manager) => vec![
                format!("doskey install={} $*", manager.install),
                format!("doskey update={} $*", manager.update),
                format!("doskey upgrade={} $*", manager.upgrade_all),
                format!("doskey uninstall={} $*", manager.uninstall),
                format!("doskey remove={} $*", manager.uninstall),
                format!("doskey search={} $*", manager.search),
            ],
        };
    }

    match manager {
        None => PACKAGE_ALIAS_NAMES
            .iter()
            .map(|name| {
                format!("function {name} {{ Write-Host '{NO_WINDOWS_MANAGER_MESSAGE}' -ForegroundColor Yellow }}")
            })
            .collect(),
        Some(manager) => vec![
            format!("function install {{ {} @args }}", manager.install),
            // Sin argumentos "update" equivale a actualizar todo, igual que en Unix.
            format!(
                "function update {{ if ($args.Count -eq 0) {{ {} }} else {{ {} @args }} }}",
                manager.upgrade_all, manager.update
            ),
            format!("function upgrade {{ {} @args }}", manager.upgrade_all),
            format!("function uninstall {{ {} @args }}", manager.uninstall),
            "function remove { uninstall @args }".to_string(),
            format!("function search {{ {} @args }}", manager.search),
        ],
    }
}

/// PowerShell fuera de Windows (pwsh en Linux/macOS): el gestor se resuelve en
/// la propia sesión con `Get-Command`, sin depender de la detección del host.
fn powershell_unix_lines() -> Vec<String> {
    fn chain(action: Action, args: &str) -> String {
        let branches = UNIX_MANAGERS
            .iter()
            .map(|manager| {
                let command = if manager.needs_privileges(action) {
                    format!("sudo {}", manager.command(action))
                        .replace(" && __wsterm_priv ", " ; sudo ")
                } else {
                    manager.command(action).to_string()
                };
                format!(
                    "if (Get-Command {} -ErrorAction SilentlyContinue) {{ {command} {args} }}",
                    manager.probe
                )
            })
            .collect::<Vec<_>>()
            .join(" else");
        format!("{branches} else {{ Write-Host '{NO_MANAGER_MESSAGE}' -ForegroundColor Yellow }}")
    }

    vec![
        format!("function install {{ {} }}", chain(Action::Install, "@args")),
        format!(
            "function update {{ if ($args.Count -eq 0) {{ upgrade }} else {{ {} }} }}",
            chain(Action::Update, "@args")
        ),
        format!("function upgrade {{ {} }}", chain(Action::UpgradeAll, "")),
        format!(
            "function uninstall {{ {} }}",
            chain(Action::Uninstall, "@args")
        ),
        "function remove { uninstall @args }".to_string(),
        format!("function search {{ {} }}", chain(Action::Search, "@args")),
    ]
}

/// El gestor de paquetes de Windows que hay instalado, en orden de preferencia.
pub fn detect_windows_manager(is_installed: &dyn Fn(&str) -> bool) -> Option<&'static str> {
    WINDOWS_MANAGERS
        .iter()
        .map(|manager| manager.id)
        .find(|id| is_installed(id))
}

/// Las líneas de alias de paquetes para esta shell.
pub fn build_package_alias_lines(
    kind: ShellKind,
    platform: &str,
    windows_manager: Option<&str>,
    transport: Transport,
) -> Vec<String> {
    // Dentro de WSL manda el gestor de la distro, no el de Windows, aunque el
    // backend corra en Windows.
    let inside_windows =
        (platform == "windows" || platform == "win32") && transport != Transport::Wsl;

    match kind {
        ShellKind::Cmd => windows_lines(ShellKind::Cmd, windows_manager),
        ShellKind::Powershell => {
            if inside_windows {
                windows_lines(ShellKind::Powershell, windows_manager)
            } else {
                powershell_unix_lines()
            }
        }
        ShellKind::Fish => fish_lines(),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => unix_lines(),
        // Un REPL o la shell de un móvil no reciben alias de paquetes.
        ShellKind::Repl | ShellKind::Android => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_usa_doskey_con_el_gestor_detectado() {
        let lines =
            build_package_alias_lines(ShellKind::Cmd, "windows", Some("winget"), Transport::Native);
        assert_eq!(lines.len(), 6);
        assert!(lines[0].starts_with("doskey install=winget install"));
        assert!(lines[0].ends_with(" $*"));
    }

    #[test]
    fn sin_gestor_en_windows_los_alias_explican_el_problema() {
        let lines = build_package_alias_lines(ShellKind::Cmd, "windows", None, Transport::Native);
        assert_eq!(lines.len(), PACKAGE_ALIAS_NAMES.len());
        assert!(lines
            .iter()
            .all(|line| line.contains("No se detecto winget")));
    }

    #[test]
    fn remove_y_uninstall_hacen_lo_mismo() {
        let lines =
            build_package_alias_lines(ShellKind::Cmd, "windows", Some("choco"), Transport::Native);
        let uninstall = lines
            .iter()
            .find(|l| l.starts_with("doskey uninstall="))
            .unwrap();
        let remove = lines
            .iter()
            .find(|l| l.starts_with("doskey remove="))
            .unwrap();
        assert_eq!(
            uninstall.replace("uninstall=", "X="),
            remove.replace("remove=", "X=")
        );
    }

    #[test]
    fn dentro_de_wsl_manda_el_gestor_de_la_distro_no_el_de_windows() {
        // Una shell bash con transporte wsl: aunque el host sea Windows y haya
        // winget, las líneas son las de Unix, que resuelven apt/dnf/... solas.
        let lines =
            build_package_alias_lines(ShellKind::Bash, "windows", Some("winget"), Transport::Wsl);
        assert!(lines.iter().any(|line| line.contains("command -v apt")));
        assert!(!lines.iter().any(|line| line.contains("winget")));
    }

    #[test]
    fn powershell_fuera_de_windows_resuelve_el_gestor_en_la_sesion() {
        let lines =
            build_package_alias_lines(ShellKind::Powershell, "linux", None, Transport::Native);
        assert!(lines[0].contains("Get-Command apt"));
        assert!(lines[0].contains("Get-Command brew"));
    }

    #[test]
    fn brew_nunca_se_ejecuta_con_sudo() {
        let lines = build_package_alias_lines(ShellKind::Bash, "linux", None, Transport::Native);
        let install = lines.iter().find(|l| l.starts_with("install()")).unwrap();
        assert!(install.contains("__wsterm_priv apt install"));
        // La rama de brew va sin envoltorio de privilegios.
        assert!(install.contains("then brew install"));
    }

    #[test]
    fn buscar_no_pide_privilegios_en_ningun_gestor() {
        let lines = build_package_alias_lines(ShellKind::Bash, "linux", None, Transport::Native);
        let search = lines.iter().find(|l| l.starts_with("search()")).unwrap();
        assert!(!search.contains("__wsterm_priv"));
    }

    #[test]
    fn install_cede_el_paso_al_binario_de_coreutils() {
        let lines = build_package_alias_lines(ShellKind::Bash, "linux", None, Transport::Native);
        let install = lines.iter().find(|l| l.starts_with("install()")).unwrap();
        assert!(install.contains("command install \"$@\""));
    }

    #[test]
    fn fish_no_encadena_con_doble_ampersand() {
        let lines = build_package_alias_lines(ShellKind::Fish, "linux", None, Transport::Native);
        let upgrade = lines
            .iter()
            .find(|l| l.starts_with("function upgrade"))
            .unwrap();
        assert!(!upgrade.contains("&&"));
        assert!(upgrade.contains("; and "));
    }

    #[test]
    fn update_sin_argumentos_actualiza_todo_en_las_tres_familias() {
        let unix = build_package_alias_lines(ShellKind::Bash, "linux", None, Transport::Native);
        assert!(unix
            .iter()
            .any(|l| l.starts_with("update()") && l.contains("then upgrade")));

        let fish = build_package_alias_lines(ShellKind::Fish, "linux", None, Transport::Native);
        assert!(
            fish.iter()
                .any(|l| l.starts_with("function update")
                    && l.contains("count $argv) -eq 0; upgrade"))
        );

        let windows = build_package_alias_lines(
            ShellKind::Powershell,
            "windows",
            Some("winget"),
            Transport::Native,
        );
        assert!(windows
            .iter()
            .any(|l| l.starts_with("function update") && l.contains("$args.Count -eq 0")));
    }

    #[test]
    fn un_repl_no_recibe_alias_de_paquetes() {
        assert!(
            build_package_alias_lines(ShellKind::Repl, "linux", None, Transport::Native).is_empty()
        );
        assert!(
            build_package_alias_lines(ShellKind::Android, "linux", None, Transport::Android)
                .is_empty()
        );
    }

    #[test]
    fn el_gestor_de_windows_se_detecta_en_orden_de_preferencia() {
        let todos = |_: &str| true;
        assert_eq!(detect_windows_manager(&todos), Some("winget"));

        let solo_scoop = |id: &str| id == "scoop";
        assert_eq!(detect_windows_manager(&solo_scoop), Some("scoop"));

        let ninguno = |_: &str| false;
        assert_eq!(detect_windows_manager(&ninguno), None);
    }

    #[test]
    fn cada_familia_define_los_seis_nombres() {
        for lines in [
            build_package_alias_lines(ShellKind::Cmd, "windows", Some("winget"), Transport::Native),
            build_package_alias_lines(
                ShellKind::Powershell,
                "windows",
                Some("winget"),
                Transport::Native,
            ),
            build_package_alias_lines(ShellKind::Bash, "linux", None, Transport::Native),
            build_package_alias_lines(ShellKind::Fish, "linux", None, Transport::Native),
        ] {
            for name in PACKAGE_ALIAS_NAMES {
                assert!(
                    lines.iter().any(|line| line.contains(name)),
                    "falta {name} en {lines:?}"
                );
            }
        }
    }
}
