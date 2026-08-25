//! Los comandos del panel de entorno y dependencias adicionales.
//!
//! Port de los canales `install:*` de `electron/main.js`. El catálogo en sí
//! está en `install_actions`; aquí se decide qué parte de ese catálogo tiene
//! sentido en ESTE sistema, se traduce en la frontera con el frontend y se
//! escribe el comando elegido en la terminal visible.
//!
//! Ninguna acción se ejecuta por detrás: lo que hace `install_run` es escribir
//! el comando en el pty de una pestaña, exactamente igual que si lo hubiera
//! tecleado el usuario, que lo ve entero antes de que pase nada y puede
//! cancelarlo con Ctrl+C.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::environments::{Environment, ShellKind, Transport};
use crate::i18n::Translator;
use crate::install_actions::{self, InstallAction, InstallContext};
use crate::platform::traits::HostPlatform;
use crate::state::AppState;

/// Arch no empaqueta PowerShell: está en el AUR, al que se llega con un
/// asistente externo. Cuál hay instalado decide qué acciones tienen sentido
/// ofrecer (ver `power_shell_actions` en `install_actions`).
fn detect_aur_helper() -> Option<String> {
    if crate::platform::host().is_windows() {
        return None;
    }
    ["paru", "yay"]
        .into_iter()
        .find(|helper| crate::path_env::is_tool_installed(helper))
        .map(str::to_string)
}

/// CrossOver Linux evita añadir su carpeta `bin` al PATH porque contiene sus
/// propias variantes de Wine. Las instalaciones oficiales pueden vivir en
/// `~/cxoffice` o `/opt/cxoffice`, así que la detección debe mirar esos lugares
/// además de los posibles enlaces `crossover`/`cxoffice` del PATH.
fn crossover_is_installed() -> bool {
    if ["crossover", "cxoffice", "cxsetup"]
        .into_iter()
        .any(crate::path_env::is_tool_installed)
    {
        return true;
    }
    let mut candidates = vec![
        Path::new("/opt/cxoffice/bin/crossover").to_path_buf(),
        Path::new("/opt/cxoffice/bin/cxoffice").to_path_buf(),
        Path::new("/opt/cxoffice/bin/cxsetup").to_path_buf(),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let root = Path::new(&home).join("cxoffice").join("bin");
        candidates.extend([
            root.join("crossover"),
            root.join("cxoffice"),
            root.join("cxsetup"),
        ]);
    }
    candidates.into_iter().any(|path| path.is_file())
}

/// Contexto del sistema que necesita el catálogo para no ofrecer nada
/// imposible. Se calcula igual desde `install_list` y desde `install_run`, para
/// que la acción que se ejecuta sea exactamente la que se mostró.
fn install_context(pkg_manager: Option<String>) -> InstallContext {
    let platform = crate::platform::host().platform_id().to_string();
    InstallContext {
        wsl: (platform == "windows")
            .then(|| crate::wsl_env::get_wsl_context(crate::wsl_env::ContextOptions::default())),
        has_snap: platform == "linux" && crate::path_env::is_tool_installed("snap"),
        has_flatpak: platform == "linux" && crate::path_env::is_tool_installed("flatpak"),
        aur_helper: detect_aur_helper(),
        projects_folder: crate::github::projects_folder(),
        pkg_manager,
        platform,
    }
}

/// Deja fuera lo que no tiene sentido en este sistema y rellena `installed`.
///
/// Una acción que sobrevive al filtro ya dice por sí misma en qué estado está
/// su herramienta: si pedía `requires_cmd` es que está instalada, y si pedía
/// `check_cmd` es que no. El panel lo usa para ordenar (lo instalado arriba)
/// sin repetir ni un solo `where`/`which`.
fn filter_available_actions(actions: Vec<InstallAction>) -> Vec<InstallAction> {
    // Varias acciones preguntan por el mismo comando: se resuelve una vez.
    let mut checked: HashMap<String, bool> = HashMap::new();
    let mut ecosystem_inventory: HashMap<String, Option<String>> = HashMap::new();
    let mut installed = |cmd: &str| -> bool {
        *checked.entry(cmd.to_string()).or_insert_with(|| {
            // Algunas dependencias no son ejecutables independientes. Python
            // puede estar instalado y, aun así, no traer pip (por ejemplo en
            // instalaciones mínimas de Debian/Arch o entornos gestionados).
            // El catálogo usa este formato para no ofrecer frameworks que
            // fallarán con "No module named pip".
            if let Some(capability) = cmd.strip_prefix("module:") {
                let Some((program, module)) = capability.split_once(':') else {
                    return false;
                };
                return crate::process::output_text(
                    program,
                    &["-m", module, "--version"],
                    std::time::Duration::from_secs(3),
                )
                .is_some();
            }
            // Los frameworks no son ejecutables uniformes: Django vive en
            // pip, Vite en npm, cargo-watch en Cargo, etc. El catálogo usa
            // una sonda declarativa para comprobar el gestor correcto y no
            // volver a enseñar como "faltante" algo que ya se instaló.
            if let Some(spec) = cmd.strip_prefix("ecosystem:") {
                return ecosystem_capability_installed(spec, &mut ecosystem_inventory);
            }
            // Algunas capacidades de Windows no exponen un ejecutable: Hyper-V,
            // Virtual Machine Platform y Windows Sandbox se consultan con una
            // expresión PowerShell. Mantener la sonda dentro del mismo filtro
            // evita que el panel marque como ausente una característica ya
            // habilitada o la ofrezca como desinstalable sin comprobarla.
            if let Some(script) = cmd.strip_prefix("powershell:") {
                let program = if crate::path_env::is_tool_installed("powershell") {
                    "powershell"
                } else {
                    "pwsh"
                };
                return crate::process::output_text(
                    program,
                    &["-NoProfile", "-NonInteractive", "-Command", script],
                    std::time::Duration::from_secs(5),
                )
                .is_some();
            }
            if cmd == "elixir:public_key" {
                return crate::process::output_text(
                    "elixir",
                    &[
                        "-e",
                        "case Application.ensure_all_started(:public_key) do {:ok, _} -> :ok; _ -> System.halt(1) end",
                    ],
                    std::time::Duration::from_secs(4),
                )
                .is_some();
            }
            // WinSlim incorpora NSudo fuera del PATH. La misma sonda que
            // alimenta Ajustes y los alias debe decidir también si el
            // catálogo ofrece instalarlo; de otro modo las dos pantallas
            // podían contradecirse.
            if let Some(app_id) = cmd.strip_prefix("flatpak:") {
                crate::path_env::is_tool_installed("flatpak")
                    && (crate::process::output_text(
                        "flatpak",
                        &["info", "--user", app_id],
                        std::time::Duration::from_secs(3),
                    )
                    .is_some()
                        || crate::process::output_text(
                            "flatpak",
                            &["info", app_id],
                            std::time::Duration::from_secs(3),
                        )
                        .is_some())
            } else if cmd == "crossover:installed" {
                crossover_is_installed()
            } else if cmd.eq_ignore_ascii_case("NSudoLC") {
                crate::platform::nsudo_path().is_some()
            } else {
                crate::path_env::is_tool_installed(cmd)
            }
        })
    };
    actions
        .into_iter()
        .filter_map(|mut action| {
            if let Some(cmd) = action.check_cmd.clone() {
                if installed(&cmd) {
                    return None;
                }
            }
            if let Some(cmd) = action.requires_cmd.clone() {
                if !installed(&cmd) {
                    return None;
                }
            }
            if action.installed.is_none() {
                action.installed = if action.requires_cmd.is_some() {
                    Some(true)
                } else {
                    action.check_cmd.as_ref().map(|_| false)
                };
            }
            Some(action)
        })
        .collect()
}

/// Comprueba un paquete de ecosistema sin instalar ni modificar nada.
///
/// Formato: `ecosystem:<gestor>|<programa>|<paquetes>`. Los nombres vienen del
/// catálogo estático, no de entrada del usuario, por lo que se pueden pasar
/// como argumentos separados al proceso. Cada gestor tiene su propia fuente de
/// verdad; mirar solo el PATH no sirve para paquetes Python, npm o Composer.
fn ecosystem_capability_installed(
    spec: &str,
    inventory: &mut HashMap<String, Option<String>>,
) -> bool {
    let mut fields = spec.splitn(3, '|');
    let manager = fields.next().unwrap_or_default();
    let program = fields.next().unwrap_or_default();
    let packages = fields.next().unwrap_or_default();
    let timeout = std::time::Duration::from_secs(4);

    let cached = |key: String,
                  program: &str,
                  args: &[&str],
                  inventory: &mut HashMap<String, Option<String>>|
     -> Option<String> {
        inventory
            .entry(key)
            .or_insert_with(|| crate::process::output_text(program, args, timeout))
            .clone()
    };

    match manager {
        "pip" => cached(
            format!("pip|{program}"),
            program,
            &["-m", "pip", "list", "--format=freeze"],
            inventory,
        )
        .is_some_and(|output| {
            packages.split_whitespace().all(|package| {
                let base = package.split('[').next().unwrap_or(package);
                output.lines().any(|line| {
                    line.split(['=', '<', '>', '!'])
                        .next()
                        .unwrap_or_default()
                        .replace('_', "-")
                        .eq_ignore_ascii_case(&base.replace('_', "-"))
                })
            })
        }),
        "npm" => cached(
            format!("npm|{program}"),
            program,
            &["list", "--global", "--depth=0", "--json"],
            inventory,
        )
        .is_some_and(|output| {
            serde_json::from_str::<serde_json::Value>(&output)
                .ok()
                .and_then(|value| value.get("dependencies").cloned())
                .and_then(|value| value.as_object().cloned())
                .is_some_and(|dependencies| {
                    packages
                        .split_whitespace()
                        .all(|package| dependencies.contains_key(package))
                })
        }),
        "cargo" => cached(
            "cargo|cargo".to_string(),
            "cargo",
            &["install", "--list"],
            inventory,
        )
        .is_some_and(|output| {
            output
                .lines()
                .any(|line| line.split_whitespace().next() == Some(packages))
        }),
        "path" => crate::path_env::is_tool_installed(packages),
        "composer" => cached(
            "composer|composer".to_string(),
            "composer",
            &["global", "show", "--no-interaction", "--name-only"],
            inventory,
        )
        .is_some_and(|output| output.lines().any(|line| line.trim() == packages)),
        "gem" => cached(
            "gem|gem".to_string(),
            "gem",
            &["list", "--local"],
            inventory,
        )
        .is_some_and(|output| {
            output
                .lines()
                .any(|line| line.split_whitespace().next() == Some(packages))
        }),
        "dotnet" => cached(
            "dotnet|dotnet".to_string(),
            "dotnet",
            &["tool", "list", "--global"],
            inventory,
        )
        .is_some_and(|output| inventory_has_package(&output, packages)),
        "mix" => {
            let archive = cached(
                "mix-archive|mix".to_string(),
                "mix",
                &["archive"],
                inventory,
            )
            .is_some_and(|output| output.contains(packages));
            archive
                || cached(
                    "mix-escripts|mix".to_string(),
                    "mix",
                    &["escript"],
                    inventory,
                )
                .is_some_and(|output| output.contains(packages))
        }
        "dart" => cached(
            "dart|dart".to_string(),
            "dart",
            &["pub", "global", "list"],
            inventory,
        )
        .is_some_and(|output| output.lines().any(|line| line.starts_with(packages))),
        "luarocks" => cached(
            format!("luarocks|{packages}"),
            "luarocks",
            &["show", packages],
            inventory,
        )
        .is_some(),
        "cabal" => cached(
            format!("cabal|{packages}"),
            "cabal",
            &["list", "--installed", packages],
            inventory,
        )
        .is_some_and(|output| output.contains(packages)),
        _ => false,
    }
}

fn inventory_has_package(output: &str, package: &str) -> bool {
    output.lines().any(|line| {
        line.split_whitespace()
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(package))
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallList {
    pub actions: Vec<InstallAction>,
}

/// `install:list`: la lista con lo que YA está detectado, sin tocar el sistema.
///
/// Se separó del refresco porque abrir el panel volvía a detectarlo todo —
/// arrancar distros WSL en frío, preguntar al daemon de Docker, esperar al
/// servidor de adb— antes de pintar nada. Eso son varios segundos con la
/// ventana congelada, y el 90% de las veces el resultado es idéntico al que ya
/// había. Ahora el panel sale al momento con lo conocido y `install_refresh`
/// llega después con lo que haya cambiado.
#[tauri::command(async)]
pub fn install_list(state: State<'_, Arc<AppState>>) -> InstallList {
    build_list(&state, state.inventory())
}

/// `install:refresh`: vuelve a detectarlo todo y devuelve la lista al día.
///
/// Lo que se instaló desde este mismo panel dejó su carpeta en el PATH
/// persistente, pero no en el que la app heredó al arrancar. Re-sincronizar el
/// PATH y volver a detectar es lo que hace que el botón "Instalar X"
/// desaparezca en cuanto X existe, sin reiniciar la app; y la herramienta nueva
/// puede aportar entornos propios (dispositivos ADB, contenedores, distros).
#[tauri::command(async)]
pub fn install_refresh(app: AppHandle, state: State<'_, Arc<AppState>>) -> InstallList {
    let inventory = state.refresh_environments();
    let _ = app.emit("envs-updated", inventory.clone());
    build_list(&state, inventory)
}

fn build_list(state: &AppState, inventory: crate::environments::Inventory) -> InstallList {
    let t = Translator::new(&crate::i18n::active_language());
    let context = install_context(inventory.pkg_manager.clone());
    let actions = filter_available_actions(install_actions::get_install_actions(&context, &t));

    // El catálogo se genera en español y se traduce aquí, en la frontera con el
    // frontend: las acciones conservan su id, su comando y su orden, que es lo
    // que el resto del sistema usa para identificarlas.
    let actions: Vec<InstallAction> = actions
        .into_iter()
        // Con el daemon en marcha, arrancarlo ya no es una acción útil.
        .filter(|action| !(inventory.docker_daemon_ready && action.id.starts_with("docker-start-")))
        .map(|action| action.translated(&t.language))
        .collect();

    state.remember_install_actions(&actions);
    InstallList { actions }
}

/// Algunas acciones son scripts de PowerShell (cmdlets como
/// `Add-WindowsCapability`, o descargas con `Invoke-WebRequest`). Hay que
/// adaptarlos a la shell activa, y sobre todo evitar que ESA shell expanda las
/// variables (`$dest`, `$env:...`) antes de pasárselas a PowerShell: en
/// PowerShell y en bash, `"$var"` dentro de comillas dobles se interpola, lo que
/// dejaría el script roto. Por eso cada familia usa su propio entrecomillado.
fn wrap_powershell_command(ps_command: &str, kind: ShellKind, transport: Transport) -> String {
    match kind {
        // Ya estamos en PowerShell: se ejecuta tal cual, sin envolver nada.
        ShellKind::Powershell => ps_command.to_string(),
        // cmd.exe no expande "$", así que las comillas dobles son seguras (los
        // scripts del catálogo no llevan comillas dobles dentro).
        ShellKind::Cmd => {
            format!("powershell -NoProfile -ExecutionPolicy Bypass -Command \"{ps_command}\"")
        }
        // Shells unix sobre Windows (Git Bash, WSL, zsh...): comillas simples,
        // que no interpolan. WSL necesita el sufijo .exe para distinguir el
        // binario de Windows de un comando de Linux.
        _ => {
            let exe = if transport == Transport::Wsl {
                "powershell.exe"
            } else {
                "powershell"
            };
            let quoted = if kind == ShellKind::Fish {
                format!(
                    "'{}'",
                    ps_command.replace('\\', "\\\\").replace('\'', "\\'")
                )
            } else {
                format!("'{}'", ps_command.replace('\'', "'\\''"))
            };
            format!("{exe} -NoProfile -ExecutionPolicy Bypass -Command {quoted}")
        }
    }
}

/// Las acciones del panel informan por pantalla (versiones, listados, salida
/// del instalador) y muchas terminan devolviendo el prompt al instante. La
/// pausa da tiempo a leer el resultado antes de volver a la terminal.
///
/// Qué se enseña alrededor del comando lo decide `console_ui`; aquí solo se
/// dice qué se está haciendo y sobre qué.
fn notice_for(action: &InstallAction, command: &str, t: &Translator) -> crate::console_ui::Notice {
    let verb = action
        .verb
        .clone()
        .unwrap_or_else(|| t.t("verb.install", "Instalar"));
    // El asunto es la herramienta, que es lo que el usuario reconoce; dentro de
    // un plegable la etiqueta corta ya no la nombra ("Actualizar a la última
    // versión"), así que ahí manda el subgrupo.
    let subject = action
        .subgroup
        .clone()
        .unwrap_or_else(|| action.label.clone());
    let notice = crate::console_ui::Notice::new(verb, subject, command).note(action.hint.clone());
    match action.done.clone() {
        Some(done) => notice.done(done),
        None => notice,
    }
}

/// Las familias de shell que pueden ejecutar una acción del panel, por orden de
/// preferencia. Un REPL no sirve: el comando iría al intérprete del lenguaje,
/// no al sistema.
const SHELL_KINDS: &[ShellKind] = &[
    ShellKind::Cmd,
    ShellKind::Powershell,
    ShellKind::Bash,
    ShellKind::Zsh,
    ShellKind::Sh,
    ShellKind::Fish,
];

/// La pestaña donde escribir la acción: la actual si es una shell de verdad, y
/// si no, otra que ya lo sea o una nueva.
pub(crate) fn shell_tab(
    app: &AppHandle,
    state: &AppState,
    tab_id: &str,
) -> Option<(String, Environment, bool)> {
    let current = state.tabs.environment_of(tab_id)?;
    if !current.repl {
        return Some((tab_id.to_string(), current, false));
    }
    let list = state.tabs.list();
    for kind in SHELL_KINDS {
        for summary in &list.tabs {
            if let Some(env) = state.tabs.environment_of(&summary.id) {
                if env.kind == *kind && !env.repl && !env.no_auto_select {
                    return Some((summary.id.clone(), env, false));
                }
            }
        }
    }
    let envs = state.environments();
    let shell_env = SHELL_KINDS.iter().find_map(|kind| {
        envs.iter()
            .find(|env| env.kind == *kind && env.available && !env.no_auto_select && !env.repl)
            .cloned()
    })?;
    let created = state.tabs.create_tab(app, &shell_env, None);
    Some((created.id, shell_env, true))
}

/// El orden de un lote es deliberado: primero los lenguajes, después Docker y
/// luego el resto. Así el usuario puede detenerse tras cada familia y no se
/// encuentra una lista plana de más de cien comandos.
fn bulk_group_rank(group: &str) -> usize {
    match group {
        "Lenguajes" => 0,
        "Docker" | "Contenedores y Kubernetes" => 1,
        "Frameworks" => 2,
        "Shells" => 3,
        "Sistema y herramientas" => 4,
        "Virtualización" => 5,
        "Compatibilidad Windows" => 6,
        "WSL" => 6,
        "Android · ADB" => 7,
        "Red y acceso remoto" => 8,
        "Visores de archivos" => 9,
        _ => 100,
    }
}

fn bulk_action_groups(
    actions: Vec<InstallAction>,
    mode: &str,
) -> Vec<(String, Vec<InstallAction>)> {
    let mut by_group: BTreeMap<String, Vec<InstallAction>> = BTreeMap::new();
    for action in actions {
        let include = match mode {
            // Las acciones de instalación son las únicas del catálogo sin
            // verbo. Las de abrir/verificar/actualizar nunca entran aquí.
            // Solo entran faltantes confirmados. `None` significa que el
            // catálogo no sabe comprobar esa acción; incluirla aquí la
            // presentaría como faltante sin evidencia y falsearía el total.
            "install" => action.verb.is_none() && action.installed == Some(false),
            // No se ofrecen desinstaladores de elementos que el catálogo no
            // puede detectar: especialmente importante para los paquetes
            // Windows marcados como no_detect.
            "uninstall" => {
                (action.id.ends_with("-uninstall") || action.id.ends_with("-remove"))
                    && (action.requires_cmd.is_some() || action.installed == Some(true))
            }
            _ => false,
        };
        if include {
            by_group
                .entry(action.group.clone())
                .or_default()
                .push(action);
        }
    }

    let mut groups: Vec<_> = by_group.into_iter().collect();
    groups.sort_by(|(left, _), (right, _)| {
        bulk_group_rank(left)
            .cmp(&bulk_group_rank(right))
            .then_with(|| left.cmp(right))
    });
    for (_, actions) in &mut groups {
        actions.sort_by(|left, right| {
            left.label
                .cmp(&right.label)
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    groups
}

fn shell_quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn shell_quote_cmd(value: &str) -> String {
    value
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('(', "^(")
        .replace(')', "^)")
}

/// Genera una comprobación POSIX para la sonda declarativa del catálogo.
///
/// El lote no puede dar por buena una instalación solo porque el gestor haya
/// terminado con código 0: `pip`, npm, Cargo y compañía pueden terminar bien
/// dejando el ejecutable fuera del PATH o instalando una variante distinta.
/// Estas sondas reutilizan exactamente la misma fuente de verdad que usa la
/// detección del panel, pero se ejecutan después de cada comando del lote.
fn bulk_posix_verification(check: &str) -> Option<String> {
    let quote = shell_quote_posix;
    if let Some(capability) = check.strip_prefix("module:") {
        let (program, module) = capability.split_once(':')?;
        return Some(format!(
            "{} -m {} --version >/dev/null 2>&1",
            quote(program),
            quote(module)
        ));
    }
    if let Some(spec) = check.strip_prefix("ecosystem:") {
        let mut fields = spec.splitn(3, '|');
        let manager = fields.next()?;
        let program = fields.next()?;
        let packages = fields.next()?;
        let package_args = packages
            .split_whitespace()
            .map(|package| quote(package.split('[').next().unwrap_or(package)))
            .collect::<Vec<_>>()
            .join(" ");
        let first = packages.split_whitespace().next()?;
        let first_base = first.split('[').next().unwrap_or(first);
        return Some(match manager {
            "pip" => format!(
                "{} -m pip show {} >/dev/null 2>&1",
                quote(program),
                package_args
            ),
            "npm" => format!(
                "{} list --global --depth=0 {} >/dev/null 2>&1",
                quote(program),
                package_args
            ),
            "cargo" => format!(
                "cargo install --list 2>/dev/null | awk -v p={} '$1 == p {{ found=1 }} END {{ exit !found }}'",
                quote(first_base)
            ),
            "path" => format!("command -v {} >/dev/null 2>&1", quote(first_base)),
            "composer" => format!(
                "composer global show --no-interaction --name-only 2>/dev/null | grep -Fxq -- {}",
                quote(first_base)
            ),
            "gem" => format!(
                "gem list --local --exact {} 2>/dev/null | grep -Eq '^{} \\('",
                quote(first_base),
                first_base.replace('\\', "\\\\").replace('\'', "'\\''")
            ),
            "dotnet" => format!(
                "dotnet tool list --global 2>/dev/null | awk -v p={} 'NR > 2 && tolower($1) == tolower(p) {{ found=1 }} END {{ exit !found }}'",
                quote(first_base)
            ),
            "mix" => format!(
                "(mix archive 2>/dev/null | grep -Fq -- {} || mix escript 2>/dev/null | grep -Fq -- {})",
                quote(first_base),
                quote(first_base)
            ),
            "dart" => format!(
                "dart pub global list 2>/dev/null | awk -v p={} '$1 == p {{ found=1 }} END {{ exit !found }}'",
                quote(first_base)
            ),
            "luarocks" => format!(
                "luarocks show {} >/dev/null 2>&1",
                quote(first_base)
            ),
            "cabal" => format!(
                "cabal list --installed {} 2>/dev/null | grep -Fq -- {}",
                quote(first_base),
                quote(first_base)
            ),
            _ => return None,
        });
    }
    if let Some(script) = check.strip_prefix("powershell:") {
        return Some(format!(
            "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command {}",
            quote(&format!("if (-not ({script})) {{ exit 1 }}"))
        ));
    }
    if check == "elixir:public_key" {
        return Some("elixir -e 'case Application.ensure_all_started(:public_key) do {:ok, _} -> :ok; _ -> System.halt(1) end'".to_string());
    }
    if let Some(app_id) = check.strip_prefix("flatpak:") {
        return Some(format!(
            "(flatpak info --user {} >/dev/null 2>&1 || flatpak info {} >/dev/null 2>&1)",
            quote(app_id),
            quote(app_id)
        ));
    }
    if check == "crossover:installed" {
        return Some("test -x \"$HOME/cxoffice/bin/crossover\" || test -x \"$HOME/cxoffice/bin/cxoffice\" || test -x /opt/cxoffice/bin/crossover || test -x /opt/cxoffice/bin/cxoffice || command -v crossover >/dev/null 2>&1 || command -v cxoffice >/dev/null 2>&1".to_string());
    }
    if check.eq_ignore_ascii_case("NSudoLC") {
        return Some(
            "command -v NSudoLC >/dev/null 2>&1 || test -x \"$HOME/NSudoLC.exe\"".to_string(),
        );
    }
    Some(format!("command -v {} >/dev/null 2>&1", quote(check)))
}

/// Variante PowerShell de la misma sonda. Se usa tanto en PowerShell como en
/// cmd; así Windows no depende de que `grep`, `awk` o una shell Unix estén
/// instalados para validar una acción.
fn bulk_powershell_verification(check: &str) -> Option<String> {
    let quote = shell_quote_powershell;
    if let Some(capability) = check.strip_prefix("module:") {
        let (program, module) = capability.split_once(':')?;
        return Some(format!(
            "& {} -m {} --version *> $null; if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
            quote(program),
            quote(module)
        ));
    }
    if let Some(spec) = check.strip_prefix("ecosystem:") {
        let mut fields = spec.splitn(3, '|');
        let manager = fields.next()?;
        let program = fields.next()?;
        let packages = fields.next()?;
        let first = packages.split_whitespace().next()?;
        let first_base = first.split('[').next().unwrap_or(first);
        return Some(match manager {
            "pip" => format!(
                "& {} -m pip show {} *> $null; if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
                quote(program),
                quote(first_base)
            ),
            "npm" => format!(
                "& {} list --global --depth=0 {} *> $null; if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
                quote(program),
                quote(first_base)
            ),
            "cargo" => format!(
                "$out = & cargo install --list; if (-not ($out -match ('(?im)^\\s*' + [regex]::Escape({}) + '\\s+v'))) {{ exit 1 }}",
                quote(first_base)
            ),
            "path" => format!(
                "Get-Command {} -ErrorAction Stop | Out-Null",
                quote(first_base)
            ),
            "composer" => format!(
                "$out = & composer global show --no-interaction --name-only; if (-not ($out -contains {})) {{ exit 1 }}",
                quote(first_base)
            ),
            "gem" => format!(
                "$out = & gem list --local --exact {}; if ($LASTEXITCODE -ne 0 -or -not ($out -match ('(?im)^' + [regex]::Escape({}) + '\\s+\\('))) {{ exit 1 }}",
                quote(first_base),
                quote(first_base)
            ),
            "dotnet" => format!(
                "$out = & dotnet tool list --global; if (-not (($out | Select-String -SimpleMatch {}))) {{ exit 1 }}",
                quote(first_base)
            ),
            "mix" => format!(
                "$archive = & mix archive 2>$null | Out-String; $escript = & mix escript 2>$null | Out-String; if ($archive -notmatch [regex]::Escape({}) -and $escript -notmatch [regex]::Escape({})) {{ exit 1 }}",
                quote(first_base),
                quote(first_base)
            ),
            "dart" => format!(
                "$out = & dart pub global list; if (-not ($out -match ('(?im)^' + [regex]::Escape({}) + '\\s'))) {{ exit 1 }}",
                quote(first_base)
            ),
            "luarocks" => format!(
                "& luarocks show {} *> $null; if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
                quote(first_base)
            ),
            "cabal" => format!(
                "$out = & cabal list --installed {}; if (-not ($out -match [regex]::Escape({}))) {{ exit 1 }}",
                quote(first_base),
                quote(first_base)
            ),
            _ => return None,
        });
    }
    if let Some(script) = check.strip_prefix("powershell:") {
        return Some(format!("if (-not ({script})) {{ exit 1 }}"));
    }
    if check == "elixir:public_key" {
        return Some("& elixir -e 'case Application.ensure_all_started(:public_key) do {:ok, _} -> :ok; _ -> System.halt(1) end' *> $null; if ($LASTEXITCODE -ne 0) { exit 1 }".to_string());
    }
    if let Some(app_id) = check.strip_prefix("flatpak:") {
        return Some(format!(
            "& flatpak info --user {} *> $null; if ($LASTEXITCODE -ne 0) {{ & flatpak info {} *> $null; if ($LASTEXITCODE -ne 0) {{ exit 1 }} }}",
            quote(app_id),
            quote(app_id)
        ));
    }
    if check == "crossover:installed" {
        return Some("if (-not ((Get-Command crossover -ErrorAction SilentlyContinue) -or (Get-Command cxoffice -ErrorAction SilentlyContinue))) { exit 1 }".to_string());
    }
    if check.eq_ignore_ascii_case("NSudoLC") {
        return Some("Get-Command NSudoLC -ErrorAction Stop | Out-Null".to_string());
    }
    Some(format!(
        "Get-Command {} -ErrorAction Stop | Out-Null",
        quote(check)
    ))
}

fn bulk_verification_command(action: &InstallAction, env: &Environment) -> Option<String> {
    let check = action.check_cmd.as_deref()?;
    match env.kind {
        ShellKind::Powershell => bulk_powershell_verification(check),
        ShellKind::Cmd => bulk_powershell_verification(check)
            .map(|script| wrap_powershell_command(&script, ShellKind::Cmd, env.transport)),
        ShellKind::Fish => bulk_posix_verification(check)
            .map(|command| format!("sh -c {}", shell_quote_posix(&command))),
        _ => bulk_posix_verification(check),
    }
}

fn bulk_group_label(group: &str, t: &Translator) -> String {
    let key = crate::i18n::group_key_for(group).or_else(|| {
        // El catálogo histórico llama a este grupo «Contenedores y
        // Kubernetes», mientras que la clave de interfaz se registró como
        // `group.containers`. Mantener la misma traducción aquí evita que el
        // script global vuelva a mostrar el nombre interno.
        (group == "Contenedores y Kubernetes").then_some("group.containers")
    });
    key.map(|key| t.t(key, group))
        .unwrap_or_else(|| group.to_string())
}

fn bulk_component_header(group: &str, count: usize, t: &Translator) -> String {
    let noun = if count == 1 {
        "componente"
    } else {
        "componentes"
    };
    format!(
        "=== {} ({} {}) ===",
        bulk_group_label(group, t),
        count,
        noun
    )
}

const AUR_BULK_TIMEOUT_SECONDS: u64 = 1200;

/// En un lote no puede quedar una revisión interactiva de PKGBUILD esperando
/// para siempre detrás del latido. Las acciones nuevas ya llevan las banderas
/// no interactivas; los comandos antiguos se completan aquí para que una
/// instalación generada por una versión anterior tampoco abra `less`, pida
/// proveedor o se quede sin límite ante una caída de DNS/red.
fn bulk_aur_command(command: String) -> String {
    for helper in ["paru", "yay"] {
        let prefix = format!("{helper} -S ");
        if let Some(rest) = command.strip_prefix(&prefix) {
            let mut flags = Vec::new();
            if helper == "paru" {
                if !rest.split_whitespace().any(|flag| flag == "--skipreview") {
                    flags.push("--skipreview");
                }
            } else if !rest
                .split_whitespace()
                .any(|flag| flag == "--answeredit=None")
            {
                flags.extend(["--answerdiff=None", "--answeredit=None"]);
            }
            if !rest.split_whitespace().any(|flag| flag == "--noprovides") {
                flags.push("--noprovides");
            }
            if !rest.split_whitespace().any(|flag| flag == "--noconfirm") {
                flags.push("--noconfirm");
            }
            let options = if flags.is_empty() {
                String::new()
            } else {
                format!("{} ", flags.join(" "))
            };
            return format!("timeout {AUR_BULK_TIMEOUT_SECONDS} {helper} -S {options}{rest}");
        }
    }
    command
}

fn bulk_command(action: &InstallAction, env: &Environment) -> String {
    let command = if action.shell.as_deref() == Some("powershell") {
        wrap_powershell_command(&action.command, env.kind, env.transport)
    } else {
        action.command.clone()
    };
    let command = bulk_aur_command(command);

    // Pacman puede pedir una elección de proveedor aunque reciba
    // `--noconfirm` (por ejemplo `tree-sitter` o `unibilium`). El lote no debe
    // quedarse bloqueado en esa pregunta. El primer valor elige el proveedor
    // del repositorio preferido y el segundo confirma la transacción si una
    // variante de pacman vuelve a mostrar esa confirmación.
    if command.contains("pacman -S") {
        return match env.kind {
            ShellKind::Powershell => format!("@('1', 's') | {command}"),
            ShellKind::Cmd => format!("(echo 1&echo s)|{command}"),
            _ => format!("printf '1\\ns\\n' | {command}"),
        };
    }
    command
}

fn bulk_needs_pacman_guard(groups: &[(String, Vec<InstallAction>)]) -> bool {
    groups.iter().any(|(_, actions)| {
        actions
            .iter()
            .any(|action| action.command.contains("pacman "))
    })
}

fn bulk_needs_privilege_guard(groups: &[(String, Vec<InstallAction>)], env: &Environment) -> bool {
    if matches!(env.kind, ShellKind::Powershell | ShellKind::Cmd) {
        return false;
    }

    groups.iter().any(|(_, actions)| {
        actions.iter().any(|action| {
            let command = action.command.as_str();
            command.contains("sudo ") || command.contains("paru ") || command.contains("yay ")
        })
    })
}

/// Genera el guion que lanzará la shell visible. Cada apartado tiene su propia
/// pregunta; no se ejecuta nada en segundo plano ni se acepta todo de una vez
/// por accidente.
fn build_bulk_script(
    groups: &[(String, Vec<InstallAction>)],
    mode: &str,
    env: &Environment,
    t: &Translator,
) -> String {
    let verb = if mode == "uninstall" {
        "Desinstalar"
    } else {
        "Instalar"
    };
    let title = if mode == "uninstall" {
        "Desinstalación guiada de componentes"
    } else {
        "Instalación guiada de componentes faltantes"
    };
    let mut script = String::new();
    let needs_pacman_guard = bulk_needs_pacman_guard(groups);
    let needs_privilege_guard = bulk_needs_privilege_guard(groups, env);

    match env.kind {
        ShellKind::Powershell => {
            script.push_str(&format!("Write-Host \"`n=== {title} ===\"\n"));
            script.push_str("$LTerminalBulkFailures = 0\n");
            script.push_str("$LTerminalBulkSkipped = 0\n");
            if needs_pacman_guard {
                script.push_str("$LTerminalPacmanLock = '/var/lib/pacman/db.lck'\n$LTerminalPacmanWait = 0\nwhile ((Test-Path $LTerminalPacmanLock) -and ($LTerminalPacmanWait -lt 30)) {\n    $LTerminalPacmanProcesses = Get-Process -Name pacman,yay,paru,pamac -ErrorAction SilentlyContinue\n    if ($LTerminalPacmanProcesses) { Start-Sleep -Seconds 2; $LTerminalPacmanWait++ } else { break }\n}\nif (Test-Path $LTerminalPacmanLock) { Write-Host '✘ pacman tiene un bloqueo huérfano en /var/lib/pacman/db.lck. No se borrará automáticamente; comprueba que no haya otro gestor activo y retíralo manualmente antes de repetir.' -ForegroundColor Red; exit 2 }\n");
            }
            script.push_str("Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue; Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue\n");
            script.push_str("if (Get-Command npm -ErrorAction SilentlyContinue) { $LTerminalNpmPrefix = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME '.local' }; $env:NPM_CONFIG_PREFIX = $LTerminalNpmPrefix; $env:Path = \"$LTerminalNpmPrefix;$env:Path\" }\n");
            script.push_str("if (Get-Command go -ErrorAction SilentlyContinue) { $LTerminalGoBin = (go env GOBIN 2>$null).Trim(); if ([string]::IsNullOrWhiteSpace($LTerminalGoBin)) { $LTerminalGoBin = Join-Path ((go env GOPATH 2>$null).Trim()) 'bin' }; if (-not [string]::IsNullOrWhiteSpace($LTerminalGoBin)) { $env:Path = \"$LTerminalGoBin;$env:Path\" } }\n");
            script.push_str("Write-Host 'El catálogo actual se ha detectado ahora; cada categoría pide confirmación.'\n");
            for (index, (group, actions)) in groups.iter().enumerate() {
                let label = bulk_group_label(group, t);
                script.push_str(&format!(
                    "Write-Host \"`n{}\"\n",
                    bulk_component_header(group, actions.len(), t)
                ));
                script.push_str(&format!(
                    "$LTerminalBulkAnswer = Read-Host {}\n",
                    shell_quote_powershell(&format!("¿Procesar {label}? [s/N]"))
                ));
                script.push_str("if ($LTerminalBulkAnswer -match '^[sSyY]') {\n");
                for action in actions {
                    let verification =
                        bulk_verification_command(action, env).unwrap_or_else(|| {
                            "throw 'No hay una sonda de verificación para esta acción.'".to_string()
                        });
                    script.push_str(&format!(
                        "  Write-Host {}\n",
                        shell_quote_powershell(&format!(
                            "    comando: {}",
                            bulk_command(action, env)
                        ))
                    ));
                    script.push_str(&format!(
                        "  Write-Host {}\n  $LTerminalBulkExit = 0\n  $LTerminalActionStartedAt = Get-Date\n  try {{\n    $global:LASTEXITCODE = 0\n    {}\n    if ($LASTEXITCODE -ne 0) {{ $LTerminalBulkExit = $LASTEXITCODE }}\n  }} catch {{ $LTerminalBulkExit = 1; Write-Host (\"    ✘ \" + $_.Exception.Message) -ForegroundColor Red }}\n  $LTerminalActionElapsed = [math]::Round(((Get-Date) - $LTerminalActionStartedAt).TotalSeconds, 1)\n  if ($LTerminalBulkExit -eq 0) {{\n    $LTerminalVerifyExit = 0\n    try {{\n      $global:LASTEXITCODE = 0\n      {}\n      if ($LASTEXITCODE -ne 0) {{ $LTerminalVerifyExit = $LASTEXITCODE }}\n    }} catch {{ $LTerminalVerifyExit = 1; Write-Host (\"    ✘ verificación: \" + $_.Exception.Message) -ForegroundColor Red }}\n    if ($LTerminalVerifyExit -eq 0) {{ Write-Host ('    ✔ completado y verificado (' + $LTerminalActionElapsed + ' s)') -ForegroundColor Green }} else {{ $LTerminalBulkFailures++; Write-Host '    ✘ el comando terminó, pero la herramienta no se detecta; se continuará con el siguiente' -ForegroundColor Red }}\n  }} else {{ $LTerminalBulkFailures++; Write-Host ('    ✘ falló tras ' + $LTerminalActionElapsed + ' s; se continuará con el siguiente') -ForegroundColor Red }}\n",
                        shell_quote_powershell(&format!("  → {}", action.label)),
                        bulk_command(action, env),
                        verification
                    ));
                }
                script.push_str(&format!(
                    "}} else {{ $LTerminalBulkSkipped += {}; Write-Host 'Omitido.' }}\n",
                    actions.len()
                ));
                script.push_str(&format!("# categoría {index}\n"));
            }
            script.push_str("if ($LTerminalBulkFailures -gt 0) { Write-Host (\"`n✘ Acciones con error: \" + $LTerminalBulkFailures) -ForegroundColor Red } elseif ($LTerminalBulkSkipped -gt 0) { Write-Host (\"`n⚠ Acciones omitidas: \" + $LTerminalBulkSkipped) -ForegroundColor Yellow } else { Write-Host '`n✔ Todas las acciones finalizaron correctamente.' -ForegroundColor Green }\n");
        }
        ShellKind::Fish => {
            script.push_str(&format!(
                "echo\necho {}\n",
                shell_quote_posix(&format!("=== {title} ==="))
            ));
            script.push_str("set LTerminalBulkFailures 0\n");
            script.push_str("set LTerminalBulkSkipped 0\n");
            if needs_pacman_guard {
                script.push_str("set LTerminalPacmanWait 0\nwhile test -e /var/lib/pacman/db.lck; and test $LTerminalPacmanWait -lt 30\n    if ps -eo comm= | string match -rq '^(pacman|yay|paru|pamac)$'\n        sleep 2\n        set LTerminalPacmanWait (math $LTerminalPacmanWait + 1)\n    else\n        break\n    end\nend\nif test -e /var/lib/pacman/db.lck\n    echo '✘ pacman tiene un bloqueo huérfano en /var/lib/pacman/db.lck. No se borrará automáticamente; comprueba que no haya otro gestor activo y retíralo manualmente antes de repetir.'\n    exit 2\nend\n");
            }
            if needs_privilege_guard {
                script.push_str("if test (id -u) -ne 0\n    if not type -q sudo\n        echo '✘ Se necesitan permisos de administrador y no se encontró sudo.'\n        exit 3\n    end\n    if sudo -n true >/dev/null 2>&1\n        echo '✔ Permisos de administrador ya disponibles.'\n    else\n        echo 'Se necesitan permisos de administrador; introduce tu contraseña cuando sudo la solicite.'\n        if not sudo -v\n            echo '✘ No se pudieron validar los permisos de administrador; no se iniciará el lote.'\n            exit 3\n        end\n    end\n    fish -c 'while sleep 60\n        sudo -n -v >/dev/null 2>&1; or exit 3\n    end' &\n    set LTerminalSudoKeepalive $last_pid\nend\n");
            }
            script.push_str("set -e PYTHONHOME; set -e PYTHONPATH\n");
            script.push_str("if type -q npm\n    set LTerminalNpmPrefix \"$HOME/.local\"\n    if test -n \"$XDG_DATA_HOME\"; set LTerminalNpmPrefix \"$XDG_DATA_HOME\"; end\n    set -gx NPM_CONFIG_PREFIX $LTerminalNpmPrefix\n    set -gx PATH \"$LTerminalNpmPrefix/bin\" $PATH\nend\n");
            script.push_str("if type -q go\n    set LTerminalGoBin (go env GOBIN 2>/dev/null | string collect)\n    if test -z \"$LTerminalGoBin\"; set LTerminalGoBin (go env GOPATH 2>/dev/null | string collect)/bin; end\n    if test -n \"$LTerminalGoBin\"; set -gx PATH \"$LTerminalGoBin\" $PATH; end\nend\n");
            script.push_str("echo 'El catálogo actual se ha detectado ahora; cada categoría pide confirmación.'\n");
            for (index, (group, actions)) in groups.iter().enumerate() {
                let label = bulk_group_label(group, t);
                script.push_str(&format!(
                    "echo\necho {}\nset LTerminalBulkAnswer ''\nread -P {} LTerminalBulkAnswer\n",
                    shell_quote_posix(&bulk_component_header(group, actions.len(), t)),
                    shell_quote_posix(&format!("¿Procesar {label}? [s/N] "))
                ));
                script.push_str("if string match -q -r '^[sSyY]' -- \"$LTerminalBulkAnswer\"\n");
                for action in actions {
                    let verification = bulk_verification_command(action, env)
                        .unwrap_or_else(|| "false".to_string());
                    script.push_str(&format!(
                        "    echo {}\n",
                        shell_quote_posix(&format!("    comando: {}", bulk_command(action, env)))
                    ));
                    script.push_str(&format!(
                        "    echo {}\n    set LTerminalActionStartedAt (date +%s)\n    env \"LTerminalActionStartedAt=$LTerminalActionStartedAt\" fish -c 'while sleep 15\n        set LTerminalActionNow (date +%s)\n        set LTerminalActionElapsed (math $LTerminalActionNow - $LTerminalActionStartedAt)\n        echo \"    … sigue en curso ($LTerminalActionElapsed s)\"\n    end' &\n    set LTerminalActionHeartbeat $last_pid\n    if {}\n        if {}\n            set LTerminalActionElapsed (math (date +%s) - $LTerminalActionStartedAt)\n            echo \"    ✔ completado y verificado ($LTerminalActionElapsed s)\"\n        else\n            set LTerminalActionElapsed (math (date +%s) - $LTerminalActionStartedAt)\n            set LTerminalBulkFailures (math $LTerminalBulkFailures + 1)\n            echo \"    ✘ el comando terminó, pero la herramienta no se detecta; se continuará con el siguiente\"\n        end\n    else\n        set LTerminalActionElapsed (math (date +%s) - $LTerminalActionStartedAt)\n        set LTerminalBulkFailures (math $LTerminalBulkFailures + 1)\n        echo \"    ✘ falló tras $LTerminalActionElapsed s; se continuará con el siguiente\"\n    end\n    kill $LTerminalActionHeartbeat >/dev/null 2>&1; or true\n    wait $LTerminalActionHeartbeat >/dev/null 2>&1; or true\n",
                        shell_quote_posix(&format!("  → {}", action.label)),
                        bulk_command(action, env),
                        verification
                    ));
                }
                script.push_str(&format!(
                    "else\n    set LTerminalBulkSkipped (math $LTerminalBulkSkipped + {})\n    echo 'Omitido.'\nend\n",
                    actions.len()
                ));
                script.push_str(&format!("# categoría {index}\n"));
            }
            script.push_str("if test $LTerminalBulkFailures -gt 0; echo; echo \"✘ Acciones con error: $LTerminalBulkFailures\"; else if test $LTerminalBulkSkipped -gt 0; echo; echo \"⚠ Acciones omitidas: $LTerminalBulkSkipped\"; else; echo; echo '✔ Todas las acciones finalizaron correctamente.'; end; end\n");
        }
        ShellKind::Cmd => {
            script.push_str(&format!(
                "echo.\necho === {} ===\necho El catalogo actual se ha detectado ahora.\n",
                shell_quote_cmd(title)
            ));
            script.push_str("set LTerminalBulkFailures=0\n");
            script.push_str("set LTerminalBulkSkipped=0\n");
            script.push_str("set PYTHONHOME=\nset PYTHONPATH=\n");
            script.push_str("where npm >nul 2>&1 && (if not \"%APPDATA%\"==\"\" (set \"LTerminalNpmPrefix=%APPDATA%\" & set \"NPM_CONFIG_PREFIX=%APPDATA%\" & set \"PATH=%APPDATA%;%PATH%\") else (set \"LTerminalNpmPrefix=%USERPROFILE%\\.local\" & set \"NPM_CONFIG_PREFIX=%USERPROFILE%\\.local\" & set \"PATH=%USERPROFILE%\\.local;%PATH%\"))\n");
            script.push_str("where go >nul 2>&1 && (for /f \"delims=\" %%G in ('go env GOBIN 2^>nul') do set \"LTerminalGoBin=%%G\" & if not defined LTerminalGoBin set \"LTerminalGoBin=%USERPROFILE%\\go\\bin\" & set \"PATH=%LTerminalGoBin%;%PATH%\")\n");
            for (index, (group, actions)) in groups.iter().enumerate() {
                let label = bulk_group_label(group, t);
                script.push_str(&format!(
                    "echo.\necho {}\nchoice /C SN /N /M \"¿Procesar {}? [S/N] \"\nif errorlevel 2 (echo Omitido.^& set /a LTerminalBulkSkipped+={})\nif not errorlevel 2 (\n",
                    shell_quote_cmd(&bulk_component_header(group, actions.len(), t)),
                    shell_quote_cmd(&label),
                    actions.len()
                ));
                for action in actions {
                    let verification = bulk_verification_command(action, env)
                        .unwrap_or_else(|| "powershell -NoProfile -Command \"exit 1\"".to_string());
                    script.push_str(&format!(
                        "  echo Comando: {}\n",
                        shell_quote_cmd(&bulk_command(action, env))
                    ));
                    script.push_str(&format!(
                        "  echo ^> {}\n  echo Inicio: %time%\n  {}\n  if errorlevel 1 (echo     ^✘ fallo; se continuara con el siguiente^& set /a LTerminalBulkFailures+=1) else (\n    {}\n    if errorlevel 1 (echo     ^✘ el comando termino, pero la herramienta no se detecta; se continuara con el siguiente^& set /a LTerminalBulkFailures+=1) else (echo     ^✔ completado y verificado)\n  )\n  echo Fin: %time%\n",
                        shell_quote_cmd(&action.label),
                        bulk_command(action, env),
                        verification
                    ));
                }
                script.push_str(")\n");
                script.push_str(&format!("rem categoria {index}\n"));
            }
            script.push_str("if not \"%LTerminalBulkFailures%\"==\"0\" (echo. ^& echo Acciones con error: %LTerminalBulkFailures%) else if not \"%LTerminalBulkSkipped%\"==\"0\" (echo. ^& echo Acciones omitidas: %LTerminalBulkSkipped%) else (echo. ^& echo Todas las acciones finalizaron correctamente.)\n");
        }
        _ => {
            // Bash, zsh y sh comparten esta variante POSIX. `read` se usa sin
            // opciones no portables para que también funcione en /bin/sh.
            script.push_str(&format!("printf '\\n%s\\n' {}\nLTerminalBulkFailures=0\nLTerminalBulkSkipped=0\nunset PYTHONHOME PYTHONPATH\nif command -v npm >/dev/null 2>&1; then LTerminalNpmPrefix=\"${{XDG_DATA_HOME:-$HOME/.local}}\"; export NPM_CONFIG_PREFIX=\"$LTerminalNpmPrefix\"; export PATH=\"$LTerminalNpmPrefix/bin:$PATH\"; fi\nif command -v go >/dev/null 2>&1; then LTerminalGoBin=\"$(go env GOBIN 2>/dev/null)\"; if [ -z \"$LTerminalGoBin\" ]; then LTerminalGoBin=\"$(go env GOPATH 2>/dev/null)/bin\"; fi; [ -n \"$LTerminalGoBin\" ] && export PATH=\"$LTerminalGoBin:$PATH\"; fi\nprintf '%s\\n' 'El catálogo actual se ha detectado ahora; cada categoría pide confirmación.'\n", shell_quote_posix(&format!("=== {title} ==="))));
            if needs_pacman_guard {
                let guard = "if [ -e /var/lib/pacman/db.lck ]; then LTerminalPacmanWait=0; while [ -e /var/lib/pacman/db.lck ] && [ \"$LTerminalPacmanWait\" -lt 30 ]; do if ps -eo comm= 2>/dev/null | grep -Eq '^(pacman|yay|paru|pamac)$'; then sleep 2; LTerminalPacmanWait=$((LTerminalPacmanWait + 1)); else break; fi; done; fi\nif [ -e /var/lib/pacman/db.lck ]; then printf '%s\\n' '✘ pacman tiene un bloqueo huérfano en /var/lib/pacman/db.lck. No se borrará automáticamente; comprueba que no haya otro gestor activo y retíralo manualmente antes de repetir.'; exit 2; fi\n";
                script.push_str(guard);
            }
            if needs_privilege_guard {
                script.push_str("if [ \"$(id -u)\" -ne 0 ]; then\n    if ! command -v sudo >/dev/null 2>&1; then printf '%s\\n' '✘ Se necesitan permisos de administrador y no se encontró sudo.'; exit 3; fi\n    if sudo -n true >/dev/null 2>&1; then printf '%s\\n' '✔ Permisos de administrador ya disponibles.'; else printf '%s\\n' 'Se necesitan permisos de administrador; introduce tu contraseña cuando sudo la solicite.'; if ! sudo -v; then printf '%s\\n' '✘ No se pudieron validar los permisos de administrador; no se iniciará el lote.'; exit 3; fi; fi\n    ( while sleep 60; do sudo -n -v >/dev/null 2>&1 || exit 3; done ) &\n    LTerminalSudoKeepalive=$!\nfi\n");
            }
            for (index, (group, actions)) in groups.iter().enumerate() {
                let label = bulk_group_label(group, t);
                script.push_str(&format!(
                    "printf '\\n%s\\n' {}\nprintf '%s' {}\nIFS= read -r LTerminalBulkAnswer\ncase \"$LTerminalBulkAnswer\" in\n  [sSyY]*)\n",
                    shell_quote_posix(&bulk_component_header(group, actions.len(), t)),
                    shell_quote_posix(&format!("¿Procesar {label}? [s/N] "))
                ));
                for action in actions {
                    let verification = bulk_verification_command(action, env)
                        .unwrap_or_else(|| "false".to_string());
                    script.push_str(&format!(
                        "    printf '%s\\n' {}\\n",
                        shell_quote_posix(&format!("    comando: {}", bulk_command(action, env)))
                    ));
                    script.push_str(&format!(
                        "    printf '%s\\n' {}\n    LTerminalActionStartedAt=$(date +%s)\n    ( while sleep 15; do LTerminalActionNow=$(date +%s); LTerminalActionElapsed=$((LTerminalActionNow - LTerminalActionStartedAt)); printf '%s\\n' \"    … sigue en curso ($LTerminalActionElapsed s)\"; done ) &\n    LTerminalActionHeartbeat=$!\n    if {}\n    then\n        if {}\n        then\n            printf '%s\\n' \"    ✔ completado y verificado ($(( $(date +%s) - LTerminalActionStartedAt )) s)\"\n        else\n            LTerminalBulkFailures=$((LTerminalBulkFailures + 1))\n            printf '%s\\n' {}\n        fi\n    else\n        LTerminalBulkFailures=$((LTerminalBulkFailures + 1))\n        printf '%s\\n' \"    ✘ falló; se continuará con el siguiente ($(( $(date +%s) - LTerminalActionStartedAt )) s)\"\n    fi\n    kill \"$LTerminalActionHeartbeat\" 2>/dev/null || true\n    wait \"$LTerminalActionHeartbeat\" 2>/dev/null || true\n",
                        shell_quote_posix(&format!("  → {}", action.label)),
                        bulk_command(action, env),
                        verification,
                        shell_quote_posix("    ✘ el comando terminó, pero la herramienta no se detecta; se continuará con el siguiente")
                    ));
                }
                script.push_str(&format!(
                    "    ;;\n  *) LTerminalBulkSkipped=$((LTerminalBulkSkipped + {})); printf '%s\\n' 'Omitido.' ;;\nesac\n",
                    actions.len()
                ));
                script.push_str(&format!("# categoría {index}\n"));
            }
            script.push_str("if [ \"$LTerminalBulkFailures\" -gt 0 ]; then printf '\\n%s\\n' \"✘ Acciones con error: $LTerminalBulkFailures\"; elif [ \"$LTerminalBulkSkipped\" -gt 0 ]; then printf '\\n%s\\n' \"⚠ Acciones omitidas: $LTerminalBulkSkipped\"; else printf '\\n%s\\n' '✔ Todas las acciones finalizaron correctamente.'; fi\n");
        }
    }

    script.push_str(match env.kind {
        ShellKind::Powershell => "Write-Host '`nProceso terminado.'\n",
        ShellKind::Fish => {
            if needs_privilege_guard {
                "if set -q LTerminalSudoKeepalive; kill $LTerminalSudoKeepalive >/dev/null 2>&1; or true; end\necho; echo 'Proceso terminado.'\n"
            } else {
                "echo; echo 'Proceso terminado.'\n"
            }
        }
        ShellKind::Cmd => "echo.\necho Proceso terminado.\n",
        _ => {
            if needs_privilege_guard {
                "if [ -n \"${LTerminalSudoKeepalive:-}\" ]; then kill \"$LTerminalSudoKeepalive\" 2>/dev/null || true; fi\nprintf '\\n%s\\n' 'Proceso terminado.'\n"
            } else {
                "printf '\\n%s\\n' 'Proceso terminado.'\n"
            }
        }
    });
    // `verb` forma parte del encabezado para que el log permita distinguir
    // claramente una instalación global de una desinstalación global.
    format!("# LTerminal: {verb}\n{script}")
}

/// Extensión del guion generado para que también pueda inspeccionarse o
/// lanzarse manualmente desde la Biblioteca. El contenido ya está escrito en
/// la sintaxis de esta familia de shell; no se vuelve a interpretar dentro de
/// la terminal que pidió la operación.
fn bulk_script_extension(kind: ShellKind) -> &'static str {
    match kind {
        ShellKind::Powershell => "ps1",
        ShellKind::Cmd => "cmd",
        ShellKind::Fish => "fish",
        _ => "sh",
    }
}

/// Guarda el lote fuera del comando de la terminal. Así el botón solo tiene
/// que escribir una orden corta y la shell no recibe cientos de líneas de
/// código pegadas de golpe. La carpeta es temporal por ejecución de LTerminal:
/// no se mezclan guiones obsoletos con los scripts personales del usuario.
fn write_bulk_script(mode: &str, env: &Environment, script: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::session_dir().map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!(
        "lterminal-components-{mode}-{stamp}.{}",
        bulk_script_extension(env.kind)
    ));
    fs::write(&path, script).map_err(|error| {
        format!(
            "No se pudo guardar el script integrado en {}: {error}",
            path.display()
        )
    })?;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).map_err(|error| error.to_string())?;
    }

    Ok(path)
}

fn quote_windows_path(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Construye el único comando que verá la terminal. En WSL/MSYS traduce la
/// ruta del host; en PowerShell y cmd usa sus invocadores nativos. Docker,
/// Wine y Android no comparten el sistema de archivos del host, por lo que el
/// llamador conserva el lote inline como fallback seguro para esos entornos.
fn bulk_script_launcher(path: &Path, env: &Environment) -> Option<String> {
    if !env.transport.loads_host_files() {
        return None;
    }
    let raw_path = path.to_string_lossy();
    // `unix_path_for` convierte las rutas a `/c/...` en un Windows nativo,
    // que es correcto para Git Bash pero no para cmd ni PowerShell. Estas dos
    // shells entienden la ruta Windows original cuando el transporte es local.
    let shell_path = if env.transport == Transport::Native
        && matches!(env.kind, ShellKind::Cmd | ShellKind::Powershell)
    {
        raw_path.to_string()
    } else {
        crate::shell_paths::unix_path_for(&raw_path, env.transport)
    };
    Some(match env.kind {
        ShellKind::Powershell => format!(
            "& {} -NoLogo -NoProfile -ExecutionPolicy Bypass -File {}",
            shell_quote_powershell(&env.exe),
            shell_quote_powershell(&shell_path)
        ),
        ShellKind::Cmd => format!("call {}", quote_windows_path(&shell_path)),
        ShellKind::Fish => format!("fish {}", shell_quote_posix(&shell_path)),
        _ => format!("sh {}", shell_quote_posix(&shell_path)),
    })
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRunResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// La pestaña se acaba de abrir para esta acción: el frontend tiene que
    /// montarle su xterm y activarla.
    pub created: bool,
}

impl InstallRunResult {
    fn failed(error: String) -> InstallRunResult {
        InstallRunResult {
            ok: false,
            error: Some(error),
            ..Default::default()
        }
    }
}

/// `install:run`
#[tauri::command(async)]
pub fn install_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    action_id: String,
) -> InstallRunResult {
    let t = Translator::new(&crate::i18n::active_language());
    if !state.tabs.has_session(&tab_id) {
        return InstallRunResult::failed(t.t("error.tabGone", "La pestaña ya no está disponible."));
    }

    // Lo que el panel enseñó es lo que se ejecuta. Si no hay nada guardado
    // (la app acaba de arrancar y el panel no se ha abierto), se regenera el
    // catálogo con el mismo contexto para que la acción sea la misma.
    let actions = state.install_actions().unwrap_or_else(|| {
        let context = install_context(state.inventory().pkg_manager);
        filter_available_actions(install_actions::get_install_actions(&context, &t))
    });
    let Some(action) = actions.into_iter().find(|action| action.id == action_id) else {
        return InstallRunResult::failed(t.t(
            "error.actionGone",
            "La acción ya no está disponible; refresca el panel.",
        ));
    };

    let Some((target_tab, env, created)) = shell_tab(&app, &state, &tab_id) else {
        return InstallRunResult::failed(t.t(
            "error.noShell",
            "No hay una shell disponible para ejecutar esta acción.",
        ));
    };

    let base_command = if action.shell.as_deref() == Some("powershell") {
        wrap_powershell_command(&action.command, env.kind, env.transport)
    } else {
        action.command.clone()
    };
    // La cabecera enseña el comando del CATÁLOGO, no el envuelto: el
    // `powershell -NoProfile -Command '...'` de alrededor es fontanería para
    // llegar a la shell correcta, y taparía lo que de verdad se va a ejecutar.
    let notice = notice_for(&action, &action.command, &t);
    let command = crate::console_ui::decorate(&base_command, &notice, env.kind, true, &t);

    log_info!(
        "Accion de instalacion ejecutada",
        serde_json::json!({
            "tabId": target_tab, "actionId": action.id, "envId": env.id, "command": command
        })
    );
    // El comando se escribe en la terminal visible: el usuario ve exactamente
    // qué se ejecuta y conserva el control (puede cancelar con Ctrl+C, igual
    // que con cualquier otro comando).
    if !state.tabs.write_command(&target_tab, &command) {
        return InstallRunResult::failed(t.t(
            "error.writeFailed",
            "No se pudo escribir en la terminal activa.",
        ));
    }
    // Esta acción deja la shell esperando un Enter: el próximo comando que
    // escriba un panel tendrá que cerrarlo antes.
    state
        .tabs
        .set_awaiting_pause(&target_tab, command != base_command);

    InstallRunResult {
        ok: true,
        action_id: Some(action.id),
        tab_id: Some(target_tab),
        created,
        error: None,
    }
}

/// `install:bulk`: genera un script a partir del catálogo detectado ahora.
/// `mode` solo acepta `install` o `uninstall`; el botón lanza un archivo
/// temporal visible en la terminal, que pregunta una vez por cada categoría
/// antes de ejecutar comandos.
#[tauri::command(async)]
pub fn install_bulk(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    mode: String,
) -> InstallRunResult {
    let t = Translator::new(&crate::i18n::active_language());
    if !matches!(mode.as_str(), "install" | "uninstall") {
        return InstallRunResult::failed(t.t(
            "error.invalidBulkMode",
            "El modo de componentes no es válido.",
        ));
    }
    if !state.tabs.has_session(&tab_id) {
        return InstallRunResult::failed(t.t("error.tabGone", "La pestaña ya no está disponible."));
    }

    // Reutilizar la instantánea que se enseñó evita que el botón genere un
    // lote distinto del que el usuario acaba de revisar. En un arranque frío
    // se regenera con el mismo filtro que usa install:list.
    let actions = state.install_actions().unwrap_or_else(|| {
        let context = install_context(state.inventory().pkg_manager);
        filter_available_actions(install_actions::get_install_actions(&context, &t))
    });
    let groups = bulk_action_groups(actions, &mode);
    if groups.is_empty() {
        let key = if mode == "uninstall" {
            "deps.noInstalledForBulk"
        } else {
            "deps.noMissingForBulk"
        };
        let fallback = if mode == "uninstall" {
            "No hay componentes instalados detectables para desinstalar."
        } else {
            "No hay componentes faltantes para instalar."
        };
        return InstallRunResult::failed(t.t(key, fallback));
    }

    let Some((target_tab, env, created)) = shell_tab(&app, &state, &tab_id) else {
        return InstallRunResult::failed(t.t(
            "error.noShell",
            "No hay una shell disponible para ejecutar esta acción.",
        ));
    };
    let action_count: usize = groups.iter().map(|(_, actions)| actions.len()).sum();
    let script = build_bulk_script(&groups, &mode, &env, &t);
    let (command, script_path) = if env.transport.loads_host_files() {
        let path = match write_bulk_script(&mode, &env, &script) {
            Ok(path) => path,
            Err(error) => return InstallRunResult::failed(error),
        };
        let Some(command) = bulk_script_launcher(&path, &env) else {
            return InstallRunResult::failed(t.t(
                "error.writeFailed",
                "La shell seleccionada no puede acceder al script integrado.",
            ));
        };
        (command, Some(path))
    } else {
        // Docker, Wine y Android no comparten el sistema de archivos de la
        // aplicación. Mantener aquí el lote visible es más seguro que crear un
        // archivo que esa shell no podría leer.
        (script, None)
    };
    log_info!(
        "Lote de componentes preparado",
        serde_json::json!({
            "tabId": target_tab,
            "envId": env.id,
            "mode": mode,
            "groups": groups.len(),
            "actions": action_count,
            "execution": if script_path.is_some() { "script" } else { "inline" },
            "scriptPath": script_path.as_ref().map(|path| path.to_string_lossy().to_string())
        })
    );
    if !state.tabs.write_command(&target_tab, &command) {
        return InstallRunResult::failed(t.t(
            "error.writeFailed",
            "No se pudo escribir en la terminal activa.",
        ));
    }
    state.tabs.set_awaiting_pause(&target_tab, false);

    InstallRunResult {
        ok: true,
        action_id: None,
        tab_id: Some(target_tab),
        created,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_actions::InstallAction;

    fn accion(id: &str, check: Option<&str>, requires: Option<&str>) -> InstallAction {
        let mut action = InstallAction::new(id, "Etiqueta", "comando");
        action.check_cmd = check.map(str::to_string);
        action.requires_cmd = requires.map(str::to_string);
        action.installed = check.map(|_| false);
        action
    }

    #[test]
    fn una_accion_que_sobrevive_al_filtro_ya_dice_en_que_estado_esta_su_herramienta() {
        // El comando no existe: instalar se queda (y se marca no instalado),
        // actualizar se va.
        let actions = filter_available_actions(vec![
            accion("instalar", Some("no-existe-este-comando-jamas"), None),
            accion("actualizar", None, Some("no-existe-este-comando-jamas")),
        ]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "instalar");
        assert_eq!(actions[0].installed, Some(false));
    }

    #[test]
    fn una_accion_sin_condiciones_no_dice_nada_del_estado_y_siempre_se_ofrece() {
        let actions = filter_available_actions(vec![accion("winget-upgrade", None, None)]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].installed, None);
    }

    #[test]
    fn las_herramientas_dotnet_se_comparan_sin_distinguir_mayusculas() {
        let output = "Package Id      Version      Commands\nNSwag.ConsoleCore 14.7.1      nswag\n";
        assert!(inventory_has_package(output, "nswag.consolecore"));
        assert!(!inventory_has_package(output, "NSwag.ConsoleCore.Extra"));
    }

    #[test]
    fn una_capacidad_de_modulo_se_sondea_y_no_se_confunde_con_el_binario() {
        let actions = filter_available_actions(vec![
            accion(
                "pip-ausente",
                Some("module:python3:modulo_que_no_existe_en_lterminal"),
                None,
            ),
            accion(
                "pip-requerido",
                None,
                Some("module:python3:modulo_que_no_existe_en_lterminal"),
            ),
        ]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "pip-ausente");
        assert_eq!(actions[0].installed, Some(false));
    }

    #[test]
    fn el_estado_que_ya_traia_el_catalogo_no_lo_pisa_el_filtro() {
        // Las distros WSL lo saben por el inventario de la sonda, no por el
        // PATH: ahí no hay comando que comprobar.
        let mut action = accion("wsl-ubuntu-update", None, None);
        action.installed = Some(true);
        let actions = filter_available_actions(vec![action]);
        assert_eq!(actions[0].installed, Some(true));
    }

    #[test]
    fn en_powershell_el_script_se_ejecuta_tal_cual_sin_envolverlo() {
        let script = "$dest = 'x'; Write-Host $dest";
        assert_eq!(
            wrap_powershell_command(script, ShellKind::Powershell, Transport::Native),
            script
        );
    }

    #[test]
    fn desde_cmd_el_script_va_entre_comillas_dobles_porque_cmd_no_expande_dolar() {
        let wrapped = wrap_powershell_command("$env:Path", ShellKind::Cmd, Transport::Native);
        assert_eq!(
            wrapped,
            "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$env:Path\""
        );
    }

    #[test]
    fn desde_una_shell_unix_el_script_va_entre_comillas_simples_para_que_no_se_interpole() {
        // En bash, "$env:Path" dentro de comillas dobles se expandiría antes de
        // llegar a PowerShell y el script llegaría roto.
        let wrapped = wrap_powershell_command("$env:Path", ShellKind::Bash, Transport::Msys);
        assert!(wrapped.starts_with("powershell -NoProfile"));
        assert!(wrapped.ends_with("'$env:Path'"));
    }

    #[test]
    fn desde_wsl_se_invoca_powershell_exe_para_distinguirlo_de_un_comando_de_linux() {
        let wrapped = wrap_powershell_command("ver", ShellKind::Bash, Transport::Wsl);
        assert!(wrapped.starts_with("powershell.exe "));
    }

    #[test]
    fn fish_escapa_las_comillas_con_barra_porque_no_admite_la_forma_de_bash() {
        let wrapped = wrap_powershell_command("Write-Host 'x'", ShellKind::Fish, Transport::Native);
        assert!(wrapped.ends_with("'Write-Host \\'x\\''"));
    }

    #[test]
    fn la_accion_dice_en_la_cabecera_que_hace_y_sobre_que_herramienta() {
        let mut action =
            InstallAction::new("winget-go-update", "Actualizar Go", "winget upgrade Go");
        action.verb = Some("Actualizar".to_string());
        // Dentro de un plegable la etiqueta corta ya no nombra la herramienta:
        // el asunto tiene que salir del subgrupo o la cabecera diria solo
        // "Actualizar a la ultima version" sin decir de que.
        action.subgroup = Some("Go".to_string());
        let notice = notice_for(&action, &action.command, &Translator::default());
        assert_eq!(notice.verb, "Actualizar");
        assert_eq!(notice.subject, "Go");
    }

    #[test]
    fn una_accion_suelta_usa_su_etiqueta_completa_como_asunto() {
        let action = InstallAction::new(
            "winget-upgrade",
            "Actualizar todo con winget",
            "winget upgrade --all",
        );
        let notice = notice_for(&action, &action.command, &Translator::default());
        assert_eq!(notice.subject, "Actualizar todo con winget");
    }

    #[test]
    fn el_aviso_de_la_accion_viaja_a_la_cabecera() {
        let mut action = InstallAction::new("winget-docker", "Docker", "winget install Docker");
        action.hint = Some("Requiere WSL2.".to_string());
        let notice = notice_for(&action, &action.command, &Translator::default());
        assert_eq!(notice.note.as_deref(), Some("Requiere WSL2."));
    }

    #[test]
    fn el_lote_de_instalacion_usa_solo_instaladores_y_orden_lenguajes_docker_despues() {
        let mut language = accion("rust", Some("rustc-no-existe"), None);
        language.group = "Lenguajes".to_string();
        language.label = "Rust".to_string();
        let mut docker = accion("docker", Some("docker-no-existe"), None);
        docker.group = "Contenedores y Kubernetes".to_string();
        docker.label = "Docker".to_string();
        let mut update = accion("rust-update", None, Some("rustc-no-existe"));
        update.group = "Lenguajes".to_string();
        update.verb = Some("Actualizar".to_string());
        let mut already_installed = accion("already-installed", None, None);
        already_installed.group = "Lenguajes".to_string();
        already_installed.installed = Some(true);
        let mut unknown = accion("unknown-state", None, None);
        unknown.group = "Lenguajes".to_string();

        let groups = bulk_action_groups(
            vec![docker, update, language, already_installed, unknown],
            "install",
        );
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "Lenguajes");
        assert_eq!(groups[0].1[0].id, "rust");
        assert_eq!(groups[1].0, "Contenedores y Kubernetes");
    }

    #[test]
    fn el_lote_de_desinstalacion_no_incluye_acciones_no_detectables() {
        let mut installed = accion("python-uninstall", None, Some("python"));
        installed.group = "Lenguajes".to_string();
        let mut unknown = accion("mystery-uninstall", None, None);
        unknown.group = "Lenguajes".to_string();
        let groups = bulk_action_groups(vec![unknown, installed], "uninstall");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 1);
        assert_eq!(groups[0].1[0].id, "python-uninstall");
    }

    fn entorno_de_prueba(kind: ShellKind, transport: Transport) -> Environment {
        Environment {
            id: "test-shell".to_string(),
            label: "Shell de prueba".to_string(),
            kind,
            transport,
            exe: "shell".to_string(),
            args: Vec::new(),
            group: "Shells".to_string(),
            shell: None,
            distro: None,
            note: None,
            initial_host_cwd: None,
            host_home: None,
            host_root: None,
            container_root: None,
            available: true,
            no_auto_select: false,
            repl: false,
            language: None,
        }
    }

    fn grupos_de_prueba() -> Vec<(String, Vec<InstallAction>)> {
        let mut action = InstallAction::new("pkg", "Paquete de prueba", "echo instalado");
        action.group = "Lenguajes".to_string();
        vec![("Lenguajes".to_string(), vec![action])]
    }

    fn grupos_pacman_de_prueba() -> Vec<(String, Vec<InstallAction>)> {
        let mut action = InstallAction::new(
            "pkg-pacman",
            "Paquete con proveedor",
            "sudo pacman -S --noconfirm paquete",
        );
        action.group = "Visores de archivos".to_string();
        vec![("Visores de archivos".to_string(), vec![action])]
    }

    fn grupos_aur_de_prueba() -> Vec<(String, Vec<InstallAction>)> {
        let mut action = InstallAction::new(
            "pkg-aur",
            "Gforth (AUR · paru)",
            "paru -S --needed --noconfirm gforth",
        );
        action.group = "Lenguajes".to_string();
        vec![("Lenguajes".to_string(), vec![action])]
    }

    #[test]
    fn el_lote_posix_pregunta_por_categoria_y_no_acepta_por_defecto() {
        let script = build_bulk_script(
            &grupos_de_prueba(),
            "install",
            &entorno_de_prueba(ShellKind::Bash, Transport::Native),
            &Translator::default(),
        );
        assert!(script.contains("case \"$LTerminalBulkAnswer\""));
        assert!(script.contains("[sSyY]*"));
        assert!(script.contains("echo instalado"));
        assert!(script.contains("Omitido."));
        assert!(script.contains("LTerminalBulkFailures"));
        assert!(script.contains("LTerminalBulkSkipped"));
        assert!(script.contains("Acciones omitidas"));
        assert!(script.contains("falló; se continuará"));
        assert!(script.contains("sigue en curso"));
        assert!(script.contains("LTerminalActionHeartbeat"));
        assert!(script.contains("NPM_CONFIG_PREFIX"));
        assert!(script.contains("(1 componente) ==="));
        assert!(!script.contains("npm config set prefix"));
    }

    #[test]
    fn cada_shell_de_windows_recibe_su_control_de_confirmacion() {
        let powershell = build_bulk_script(
            &grupos_de_prueba(),
            "uninstall",
            &entorno_de_prueba(ShellKind::Powershell, Transport::Native),
            &Translator::default(),
        );
        assert!(powershell.contains("Read-Host"));
        assert!(powershell.contains("-match '^[sSyY]'"));
        assert!(powershell.contains("LTerminalBulkFailures"));
        assert!(powershell.contains("LTerminalBulkSkipped"));
        assert!(powershell.contains("se continuará con el siguiente"));
        assert!(powershell.contains("LTerminalActionElapsed"));

        let cmd = build_bulk_script(
            &grupos_de_prueba(),
            "uninstall",
            &entorno_de_prueba(ShellKind::Cmd, Transport::Native),
            &Translator::default(),
        );
        assert!(cmd.contains("choice /C SN"));
        assert!(cmd.contains("if not errorlevel 2"));
        assert!(cmd.contains("LTerminalBulkFailures"));
        assert!(cmd.contains("LTerminalBulkSkipped"));
        assert!(cmd.contains("fallo; se continuara"));
        assert!(cmd.contains("NPM_CONFIG_PREFIX"));
        assert!(!cmd.contains("npm config set prefix"));
    }

    #[test]
    fn el_lote_de_pacman_responde_a_proveedores_y_confirmaciones() {
        let fish = build_bulk_script(
            &grupos_pacman_de_prueba(),
            "install",
            &entorno_de_prueba(ShellKind::Fish, Transport::Native),
            &Translator::default(),
        );
        assert!(fish.contains("printf '1\\ns\\n' | sudo pacman"));
        assert!(fish.contains("/var/lib/pacman/db.lck"));
        assert!(fish.contains("bloqueo huérfano"));

        let powershell = build_bulk_script(
            &grupos_pacman_de_prueba(),
            "install",
            &entorno_de_prueba(ShellKind::Powershell, Transport::Native),
            &Translator::default(),
        );
        assert!(powershell.contains("@('1', 's') | sudo pacman"));
        assert!(powershell.contains("Test-Path $LTerminalPacmanLock"));
    }

    #[test]
    fn el_lote_aur_no_se_queda_en_revision_interactiva_y_tiene_limite() {
        let fish = build_bulk_script(
            &grupos_aur_de_prueba(),
            "install",
            &entorno_de_prueba(ShellKind::Fish, Transport::Native),
            &Translator::default(),
        );
        assert!(fish.contains(
            "timeout 1200 paru -S --skipreview --noprovides --needed --noconfirm gforth"
        ));
        assert!(fish.contains("sudo -v"));
        assert!(fish.contains("LTerminalSudoKeepalive"));
        assert!(fish.contains("fish -c 'while sleep 60"));
        assert!(fish.contains("fish -c 'while sleep 15"));
        assert!(!fish.contains("begin\n        while sleep 15"));
        assert!(!fish.contains("printf '1\\ns\\n' | paru"));

        let bash = build_bulk_script(
            &grupos_aur_de_prueba(),
            "install",
            &entorno_de_prueba(ShellKind::Bash, Transport::Native),
            &Translator::default(),
        );
        assert!(bash.contains(
            "timeout 1200 paru -S --skipreview --noprovides --needed --noconfirm gforth"
        ));
        assert!(bash.contains("sudo -v"));
        assert!(bash.contains("LTerminalSudoKeepalive"));
    }

    #[test]
    fn fish_usa_read_p_y_la_sintaxis_condicional_de_fish() {
        let script = build_bulk_script(
            &grupos_de_prueba(),
            "install",
            &entorno_de_prueba(ShellKind::Fish, Transport::Native),
            &Translator::default(),
        );
        assert!(script.contains("read -P"));
        assert!(script.contains("string match -q -r"));
        assert!(script.contains("end"));
        assert!(script.contains("LTerminalBulkFailures"));
    }

    #[test]
    fn el_boton_lanza_un_script_corto_en_vez_de_inyectar_todo_el_lote() {
        let path = Path::new("/tmp/LTerminal scripts/componentes.sh");
        let bash =
            bulk_script_launcher(path, &entorno_de_prueba(ShellKind::Bash, Transport::Native))
                .expect("bash nativo debe poder leer el script");
        assert_eq!(bash, "sh '/tmp/LTerminal scripts/componentes.sh'");

        let fish =
            bulk_script_launcher(path, &entorno_de_prueba(ShellKind::Fish, Transport::Native))
                .expect("fish nativo debe poder leer el script");
        assert_eq!(fish, "fish '/tmp/LTerminal scripts/componentes.sh'");
    }

    #[test]
    fn el_lanzador_usa_los_interpretes_nativos_de_windows() {
        let path = Path::new("C:\\Users\\Ana\\AppData\\Local\\Temp\\lote.ps1");
        let mut powershell = entorno_de_prueba(ShellKind::Powershell, Transport::Native);
        powershell.exe = "C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string();
        let command = bulk_script_launcher(path, &powershell).expect("PowerShell debe lanzarse");
        assert!(command.contains("-ExecutionPolicy Bypass -File"));
        assert!(command.contains("C:\\Program Files\\PowerShell\\7\\pwsh.exe"));

        let cmd = bulk_script_launcher(
            &PathBuf::from("C:\\Users\\Ana\\AppData\\Local\\Temp\\lote.cmd"),
            &entorno_de_prueba(ShellKind::Cmd, Transport::Native),
        )
        .expect("cmd debe lanzarse");
        assert_eq!(
            cmd,
            "call \"C:\\Users\\Ana\\AppData\\Local\\Temp\\lote.cmd\""
        );
    }

    #[test]
    fn no_se_crea_un_lanzador_de_archivo_para_transportes_sin_sistema_compartido() {
        let command = bulk_script_launcher(
            Path::new("/tmp/lote.sh"),
            &entorno_de_prueba(ShellKind::Bash, Transport::Docker),
        );
        assert!(command.is_none());
    }
}
