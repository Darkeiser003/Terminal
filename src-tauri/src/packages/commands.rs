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

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

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

#[derive(Clone, Copy, PartialEq, Eq)]
enum DetectionDepth {
    /// Solo información ya disponible y comprobaciones del PATH. No entra en
    /// WSL ni ejecuta gestores de paquetes o cmdlets.
    Fast,
    /// Inventario exacto: puede arrancar WSL y ejecutar sondas con timeout.
    Full,
}

/// Contexto del sistema que necesita el catálogo para no ofrecer nada
/// imposible. La primera pintura no vuelve a entrar en WSL: la detección de
/// arranque puede tener su caché bloqueada mientras sondea una distro y
/// `install_list` debe poder responder durante ese trabajo.
fn install_context(pkg_manager: Option<String>, depth: DetectionDepth) -> InstallContext {
    let platform = crate::platform::host().platform_id().to_string();
    InstallContext {
        wsl: (platform == "windows" && depth == DetectionDepth::Full)
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
fn filter_available_actions_with_depth(
    actions: Vec<InstallAction>,
    depth: DetectionDepth,
) -> Vec<InstallAction> {
    // Varias acciones preguntan por el mismo comando: se resuelve una vez.
    let mut checked: HashMap<String, bool> = HashMap::new();
    let mut ecosystem_inventory: HashMap<String, Option<String>> = HashMap::new();
    let mut installed = |cmd: &str| -> bool {
        *checked.entry(cmd.to_string()).or_insert_with(|| {
            // La lista inicial tiene que ser inmediata. Estas capacidades solo
            // se conocen ejecutando procesos con timeouts de varios segundos;
            // se consideran ausentes provisionalmente y `install_refresh`
            // sustituye la lista por el resultado exacto en segundo plano.
            if depth == DetectionDepth::Fast
                && (cmd.starts_with("module:")
                    || cmd.starts_with("ecosystem:")
                    || cmd.starts_with("powershell:")
                    || cmd.starts_with("flatpak:")
                    || cmd == "elixir:public_key")
            {
                return false;
            }
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
            } else if depth == DetectionDepth::Fast {
                // `is_tool_installed` valida los alias falsos de Python
                // ejecutando `--version`. La primera pintura solo consulta el
                // PATH; el refresco confirmará después si el binario responde.
                crate::path_env::which(cmd).is_some()
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

fn filter_available_actions(actions: Vec<InstallAction>) -> Vec<InstallAction> {
    filter_available_actions_with_depth(actions, DetectionDepth::Full)
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
    if let Some(actions) = state.install_actions() {
        return InstallList { actions };
    }
    build_list(&state, state.inventory(), DetectionDepth::Fast)
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
    build_list(&state, inventory, DetectionDepth::Full)
}

fn build_list(
    state: &AppState,
    inventory: crate::environments::Inventory,
    depth: DetectionDepth,
) -> InstallList {
    let started = std::time::Instant::now();
    let depth_name = match depth {
        DetectionDepth::Fast => "fast",
        DetectionDepth::Full => "full",
    };
    let t = Translator::new(&crate::i18n::active_language());
    let context = install_context(inventory.pkg_manager.clone(), depth);
    let actions = filter_available_actions_with_depth(
        install_actions::get_install_actions(&context, &t),
        depth,
    );

    // El catálogo se genera en español y se traduce aquí, en la frontera con el
    // frontend: las acciones conservan su id, su comando y su orden, que es lo
    // que el resto del sistema usa para identificarlas.
    let actions: Vec<InstallAction> = actions
        .into_iter()
        // Con el daemon en marcha, arrancarlo ya no es una acción útil.
        .filter(|action| !(inventory.docker_daemon_ready && action.id.starts_with("docker-start-")))
        .map(|action| action.translated(&t.language))
        .collect();

    log_info!(
        "Catalogo de acciones preparado",
        serde_json::json!({
            "depth": depth_name,
            "actions": actions.len(),
            "durationMs": started.elapsed().as_millis() as u64,
        })
    );
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
        // Ya estamos en PowerShell. Capturamos errores terminantes para que un
        // `throw` de una acción no cierre la sesión interactiva ni impida que
        // `console_ui::decorate` pinte el resultado de la operación.
        ShellKind::Powershell => format!("try {{ {ps_command} }} catch {{ Write-Error $_ }}"),
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
        let context = install_context(state.inventory().pkg_manager, DetectionDepth::Full);
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
    fn la_lista_rapida_no_ejecuta_sondas_de_capacidades() {
        let actions = filter_available_actions_with_depth(
            vec![
                accion(
                    "instalar-capacidad",
                    Some("ecosystem:npm|programa-que-no-existe|paquete"),
                    None,
                ),
                accion(
                    "actualizar-capacidad",
                    None,
                    Some("powershell:throw 'esta sonda no debe ejecutarse'"),
                ),
            ],
            DetectionDepth::Fast,
        );
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "instalar-capacidad");
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
    fn en_powershell_el_script_se_ejecuta_en_la_sesion_sin_perder_sus_variables() {
        let script = "$dest = 'x'; Write-Host $dest";
        let wrapped = wrap_powershell_command(script, ShellKind::Powershell, Transport::Native);
        assert!(wrapped.starts_with("try { "));
        assert!(wrapped.contains(script));
        assert!(wrapped.ends_with(" } catch { Write-Error $_ }"));
    }

    #[test]
    fn en_powershell_un_throw_deja_viva_la_terminal_interactiva() {
        let wrapped = wrap_powershell_command(
            "throw 'fallo de prueba'",
            ShellKind::Powershell,
            Transport::Native,
        );
        assert!(wrapped.contains("catch { Write-Error $_ }"));
        assert!(!wrapped.contains("exit"));
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
}
