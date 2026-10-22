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
use crate::install_actions::{self, DetectionStatus, InstallAction, InstallContext};
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
    /// Solo construye la estructura navegable del catálogo. No consulta
    /// comandos ni gestores: el estado se comprueba al abrir cada herramienta.
    Catalog,
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
        wsl: (platform == "windows"
            && depth != DetectionDepth::Fast
            && depth != DetectionDepth::Catalog)
            .then(|| {
                // El catálogo inicial solo construye la navegación. No debe entrar
                // en el mutex global de WSL mientras la precarga completa de fondo
                // sondea una distro fría: ese bloqueo podía dejar el panel sin
                // pintar hasta agotar el timeout del WebDriver. La detección exacta
                // sigue ocurriendo en `install_check`/`install_refresh`.
                crate::wsl_env::get_wsl_context(crate::wsl_env::ContextOptions {
                    online: depth == DetectionDepth::Full,
                    // La pasada completa alimenta acciones de WSL, Docker y
                    // virtualización. Necesita la lista de comandos y el
                    // gestor de cada distro confirmados, no solo sus nombres.
                    details: depth == DetectionDepth::Full,
                    probe: depth == DetectionDepth::Full,
                })
            }),
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
/// Una acción que sobrevive al filtro lleva el estado de su herramienta. Si la
/// sonda no concluye por timeout o error, se conserva como `Unknown` y el panel
/// la deja visible pero bloqueada, sin convertirla en una falsa ausencia.
fn filter_available_actions_with_depth(
    actions: Vec<InstallAction>,
    depth: DetectionDepth,
) -> Vec<InstallAction> {
    if depth == DetectionDepth::Catalog {
        return actions
            .into_iter()
            .map(|mut action| {
                if action.check_cmd.is_some() || action.requires_cmd.is_some() {
                    action.installed = None;
                    action.detection_status = Some(DetectionStatus::Unknown);
                    // La tarjeta de instalación de un ecosistema sigue siendo
                    // válida aunque falte su runtime (por ejemplo, Busted
                    // antes de instalar LuaRocks). El catálogo estructural no
                    // puede confirmar el paquete, pero sí puede confirmar que
                    // no existe el ejecutable requisito con una consulta PATH
                    // barata. Dejar también esa acción en `Unknown` hacía que
                    // todos los frameworks mostraran «Comprobar» y ocultaba
                    // la única operación útil para preparar el sistema.
                    if is_install_action(&action) {
                        if let Some(requirement) = action.requires_cmd.as_deref() {
                            if !requirement.contains(':')
                                && crate::path_env::which(requirement).is_none()
                            {
                                action.installed = Some(false);
                                action.detection_status = None;
                            }
                        }
                    }
                }
                action
            })
            .collect();
    }
    // Varias acciones preguntan por el mismo comando: se resuelve una vez.
    let mut checked: HashMap<String, DetectionState> = HashMap::new();
    // WinGet y los gestores de ecosistemas no comparten estado. Arrancar sus
    // inventarios a la vez evita sumar el timeout de WinGet al de pip/npm/
    // Cargo cuando una fuente está lenta, sin alterar el filtrado posterior.
    // Una comprobación de familia trae pocas acciones; la pasada completa,
    // cientos. Solo la primera puede reutilizar inventarios recientes.
    let targeted = actions.len() <= 16;
    let (mut winget_inventory, mut ecosystem_inventory) = if depth == DetectionDepth::Full {
        std::thread::scope(|scope| {
            let winget = scope.spawn(|| {
                let mut inventory = WingetInventory::default();
                prefetch_winget_inventory(&actions, &mut inventory);
                inventory
            });
            let ecosystem = scope.spawn(|| {
                let mut inventory = HashMap::new();
                prefetch_ecosystem_inventory(&actions, &mut inventory, targeted);
                inventory
            });
            (
                winget.join().unwrap_or_default(),
                ecosystem.join().unwrap_or_default(),
            )
        })
    } else {
        (WingetInventory::default(), HashMap::new())
    };
    let mut installed = |cmd: &str| -> DetectionState {
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
                    || (cmd.starts_with("winget:") && !cmd.ends_with("|__package__"))
                    || cmd.starts_with("windowscapability:")
                    || cmd == "elixir:public_key")
            {
                return DetectionState::Missing;
            }
            // Un modelo local de Ollama está descargado si existe su
            // manifiesto: se comprueba en disco, sin arrancar `ollama list`
            // (necesita el servidor) ni un proceso por modelo.
            // ble.sh y los plugins de zsh no son ejecutables: se detectan por
            // la tabla de rutas de `shell_assist`, la misma con la que la
            // pestaña los carga (y cuyo marcador imprime la sonda de WSL).
            if let Some(plugin) = crate::terminal::shell_assist::plugin_by_marker(cmd) {
                return if crate::terminal::shell_assist::plugin_installed_locally(plugin) {
                    DetectionState::Installed
                } else {
                    DetectionState::Missing
                };
            }
            if let Some(model) = cmd.strip_prefix("ollama-model:") {
                let models = crate::environments::ai::ollama_models_dir();
                return if crate::environments::ai::ollama_model_installed(&models, model) {
                    DetectionState::Installed
                } else {
                    DetectionState::Missing
                };
            }
            // Algunas dependencias no son ejecutables independientes. Python
            // puede estar instalado y, aun así, no traer pip (por ejemplo en
            // instalaciones mínimas de Debian/Arch o entornos gestionados).
            // El catálogo usa este formato para no ofrecer frameworks que
            // fallarán con "No module named pip".
            if let Some(capability) = cmd.strip_prefix("module:") {
                let Some((program, module)) = capability.split_once(':') else {
                    return DetectionState::Missing;
                };
                // `prefetch_ecosystem_inventory` ya comprobó el runtime y
                // lanzó `-m <módulo> --version` en paralelo con los demás
                // inventarios (y la copia reciente lo comparte entre
                // familias). Solo se sondea aquí si no llegó a calcularse.
                match ecosystem_inventory.get(&format!("__program|{program}")) {
                    Some(crate::process::ProbeOutput::NotFound) => return DetectionState::Missing,
                    Some(_) => {}
                    None if !crate::path_env::is_tool_installed(program) => {
                        return DetectionState::Missing;
                    }
                    None => {}
                }
                let probe = ecosystem_inventory
                    .entry(module_inventory_key(program, module))
                    .or_insert_with(|| {
                        crate::process::output_text_probe(
                            program,
                            &["-m", module, "--version"],
                            ECOSYSTEM_PROBE_TIMEOUT,
                        )
                    })
                    .clone();
                return match probe {
                    crate::process::ProbeOutput::Success(_) => DetectionState::Installed,
                    crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
                    crate::process::ProbeOutput::Failed | crate::process::ProbeOutput::NotFound => {
                        DetectionState::Missing
                    }
                };
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
                return match probe_allowing_retry(
                    !targeted,
                    program,
                    &["-NoProfile", "-NonInteractive", "-Command", script],
                    std::time::Duration::from_secs(5),
                ) {
                    crate::process::ProbeOutput::Success(_) => DetectionState::Installed,
                    crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
                    crate::process::ProbeOutput::Failed | crate::process::ProbeOutput::NotFound => {
                        DetectionState::Missing
                    }
                };
            }
            if cmd == "elixir:public_key" {
                return match probe_allowing_retry(
                    !targeted,
                    "elixir",
                    &[
                        "-e",
                        "case Application.ensure_all_started(:public_key) do {:ok, _} -> :ok; _ -> System.halt(1) end",
                    ],
                    std::time::Duration::from_secs(4),
                ) {
                    crate::process::ProbeOutput::Success(_) => DetectionState::Installed,
                    crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
                    crate::process::ProbeOutput::Failed | crate::process::ProbeOutput::NotFound => {
                        DetectionState::Missing
                    }
                };
            }
            // Chocolatey puede dejar paquetes portables bajo `lib\\<paquete>
            // \\tools\\bin` sin crear un shim en `chocolatey\\bin`. En ese
            // caso `choco list` dice que está instalado, pero una sonda solo
            // basada en PATH lo marca como ausente y vuelve a ofrecer
            // «Instalar». Añadimos las carpetas reales al PATH del proceso y
            // comprobamos el ejecutable que el paquete declara.
            if let Some(spec) = cmd.strip_prefix("chocolatey:") {
                return chocolatey_capability_installed(spec);
            }
            // WinGet puede registrar una aplicación correctamente aunque su
            // instalador no haya añadido el ejecutable al PATH heredado por
            // WTerminal (instalaciones por usuario, enlaces de WindowsApps o
            // aplicaciones que solo exponen una GUI). Primero se conserva la
            // detección real del comando y, si falla, se consulta el registro
            // de paquetes de WinGet para no volver a ofrecer «Instalar».
            if let Some(spec) = cmd.strip_prefix("winget:") {
                return winget_capability_installed(spec, &mut winget_inventory);
            }
            if let Some(spec) = cmd.strip_prefix("windowscapability:") {
                let mut fields = spec.splitn(2, '|');
                let capability = fields.next().unwrap_or_default().trim();
                let command = fields.next().unwrap_or_default().trim();
                if capability.is_empty() || command.is_empty() {
                    return DetectionState::Missing;
                }
                if crate::path_env::is_tool_installed(command) {
                    return DetectionState::Installed;
                }
                return match probe_allowing_retry(
                    !targeted,
                    "powershell",
                    &[
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "(Get-WindowsCapability -Online -Name '{}' -ErrorAction SilentlyContinue).State",
                            capability
                        ),
                    ],
                    std::time::Duration::from_secs(5),
                ) {
                    crate::process::ProbeOutput::Success(output) if output.lines().any(|line| {
                        line.trim().eq_ignore_ascii_case("Installed")
                            || line.trim().eq_ignore_ascii_case("InstallPending")
                    }) => DetectionState::Installed,
                    crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
                    crate::process::ProbeOutput::Success(_)
                    | crate::process::ProbeOutput::Failed
                    | crate::process::ProbeOutput::NotFound => DetectionState::Missing,
                };
            }
            // WinSlim incorpora NSudo fuera del PATH. La misma sonda que
            // alimenta Ajustes y los alias debe decidir también si el
            // catálogo ofrece instalarlo; de otro modo las dos pantallas
            // podían contradecirse.
            if let Some(app_id) = cmd.strip_prefix("flatpak:") {
                if !crate::path_env::is_tool_installed("flatpak") {
                    DetectionState::Missing
                } else {
                    match (
                        probe_allowing_retry(
                            !targeted,
                            "flatpak",
                            &["info", "--user", app_id],
                            std::time::Duration::from_secs(3),
                        ),
                        probe_allowing_retry(
                            !targeted,
                            "flatpak",
                            &["info", app_id],
                            std::time::Duration::from_secs(3),
                        ),
                    ) {
                        (crate::process::ProbeOutput::Success(_), _)
                        | (_, crate::process::ProbeOutput::Success(_)) => DetectionState::Installed,
                        (crate::process::ProbeOutput::TimedOut, _)
                        | (_, crate::process::ProbeOutput::TimedOut) => DetectionState::Unknown,
                        _ => DetectionState::Missing,
                    }
                }
            } else if cmd == "crossover:installed" {
                if crossover_is_installed() { DetectionState::Installed } else { DetectionState::Missing }
            } else if cmd.eq_ignore_ascii_case("NSudoLC") {
                if crate::platform::nsudo_path().is_some() { DetectionState::Installed } else { DetectionState::Missing }
            } else if depth == DetectionDepth::Fast {
                // `is_tool_installed` valida los alias falsos de Python
                // ejecutando `--version`. La primera pintura solo consulta el
                // PATH; el refresco confirmará después si el binario responde.
                if crate::path_env::which(cmd).is_some() { DetectionState::Installed } else { DetectionState::Missing }
            } else {
                if crate::path_env::is_tool_installed(cmd) { DetectionState::Installed } else { DetectionState::Missing }
            }
        })
    };
    actions
        .into_iter()
        .filter_map(|mut action| {
            if let Some(cmd) = action.check_cmd.clone() {
                match installed(&cmd) {
                    DetectionState::Installed => return None,
                    DetectionState::Unknown => {
                        // Si el runtime requerido sí está disponible, una
                        // sonda de paquete que agotó su tiempo no debe
                        // bloquear la acción base de instalación. El usuario
                        // puede instalarla y volver a comprobar después; las
                        // acciones de actualización/desinstalación conservan
                        // el estado desconocido hasta confirmarlo.
                        if is_install_action(&action)
                            && action.requires_cmd.as_deref().is_some_and(|requirement| {
                                requirement.contains(':')
                                    || crate::path_env::which(requirement).is_some()
                            })
                        {
                            action.installed = Some(false);
                            action.detection_status = None;
                        } else {
                            action.installed = None;
                            action.detection_status = Some(DetectionStatus::Unknown);
                        }
                    }
                    DetectionState::Missing => {}
                }
            }
            if let Some(cmd) = action.requires_cmd.clone() {
                match installed(&cmd) {
                    DetectionState::Installed => {}
                    DetectionState::Missing => {
                        // Una acción de instalación sigue siendo útil aunque
                        // todavía falte el runtime sobre el que trabaja (por
                        // ejemplo, `luarocks install busted` cuando LuaRocks
                        // aún no está instalado). El catálogo ya muestra en
                        // `hint` qué dependencia hay que preparar primero;
                        // ocultar la acción dejaba toda la familia en
                        // «Comprobar» y no permitía al usuario llegar a ella.
                        // Las acciones de actualizar/desinstalar sí requieren
                        // que exista la capacidad y se mantienen ocultas.
                        if !is_install_action(&action) && !is_diagnostic_action(&action) {
                            return None;
                        }
                        action.installed = Some(false);
                    }
                    DetectionState::Unknown => {
                        action.installed = None;
                        action.detection_status = Some(DetectionStatus::Unknown);
                    }
                }
            }
            if action.installed.is_none() && action.detection_status.is_none() {
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

/// Las acciones sin verbo son las instalaciones base del catálogo. Algunas
/// entradas históricas declaran explícitamente «Instalar» o «Install», por lo
/// que se aceptan ambas formas al decidir si se puede ofrecer una instalación
/// aunque falte su runtime previo.
fn is_install_action(action: &InstallAction) -> bool {
    action.verb.as_deref().is_none()
        || matches!(action.verb.as_deref(), Some("Instalar" | "Install"))
}

/// Acciones de lectura que deben seguir visibles aunque falte el requisito
/// que describen. Por ejemplo, «Comprobar Hyper-V» sirve precisamente para
/// explicar por qué la activación no está disponible; ocultarla dejaba la
/// familia con una única tarjeta de instalación y hacía imposible revisar el
/// estado desde el panel.
fn is_diagnostic_action(action: &InstallAction) -> bool {
    matches!(
        action.verb.as_deref(),
        Some(
            "Comprobar"
                | "Check"
                | "Ver"
                | "Mostrar"
                | "View"
                | "Listar"
                | "List"
                | "Reiniciar"
                | "Restart"
        )
    ) || action.id.ends_with("-check")
        || action.id.ends_with("-version")
        || action.id.ends_with("-list")
        || action.id.ends_with("-devices")
        || action.id.ends_with("-restart")
}

/// Ejecuta una vez por gestor el inventario que comparten sus acciones. Las
/// sondas siguen siendo de solo lectura y tienen el mismo timeout que la ruta
/// secuencial; la concurrencia reduce el tiempo total al gestor más lento.
fn prefetch_ecosystem_inventory(
    actions: &[InstallAction],
    inventory: &mut HashMap<String, crate::process::ProbeOutput>,
    targeted: bool,
) {
    let generation = DETECTION_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    if targeted {
        inventory.extend(reusable_ecosystem_entries(
            &ECOSYSTEM_INVENTORY_CACHE,
            generation,
            std::time::Instant::now(),
        ));
    }
    let mut jobs: HashMap<String, (String, Vec<String>)> = HashMap::new();
    // El mismo intérprete aparece en muchas familias (Python, Node, LuaRocks,
    // etc.). Guardar su disponibilidad una sola vez evita iniciar una sonda
    // de 10 segundos por cada paquete cuando el runtime ni siquiera existe.
    // El marcador también permite que `ecosystem_capability_installed` devuelva
    // Missing sin volver a crear el proceso ausente.
    let mut checked_programs = std::collections::HashSet::<String>::new();
    for spec in actions.iter().filter_map(|action| {
        action
            .check_cmd
            .as_deref()
            .or(action.requires_cmd.as_deref())
            .and_then(|command| command.strip_prefix("ecosystem:"))
    }) {
        let mut fields = spec.splitn(3, '|');
        let manager = fields.next().unwrap_or_default();
        let program = fields.next().unwrap_or_default();
        let package = fields.next().unwrap_or_default();
        if program.is_empty() {
            continue;
        }
        let program_key = format!("__program|{program}");
        if checked_programs.insert(program.to_string()) && !inventory.contains_key(&program_key) {
            let available = crate::path_env::is_tool_installed(program);
            inventory.insert(
                program_key,
                if available {
                    crate::process::ProbeOutput::Success(String::new())
                } else {
                    crate::process::ProbeOutput::NotFound
                },
            );
        }
        if matches!(
            inventory.get(&format!("__program|{program}")),
            Some(crate::process::ProbeOutput::NotFound)
        ) {
            continue;
        }
        let add = |key: String, program: &str, args: &[&str], jobs: &mut HashMap<_, _>| {
            jobs.entry(key).or_insert_with(|| {
                (
                    program.to_string(),
                    args.iter().map(|arg| (*arg).to_string()).collect(),
                )
            });
        };
        match manager {
            "pip" => add(
                format!("pip|{program}"),
                program,
                &["-m", "pip", "list", "--format=freeze"],
                &mut jobs,
            ),
            "npm" => add(
                format!("npm|{program}"),
                program,
                // `npm list --global` recorre todos los metadatos y puede
                // tardar más de diez segundos. La raíz global es suficiente:
                // cada paquete instalado deja allí su carpeta (incluidos los
                // nombres con scope), y la comprobación posterior valida esas
                // rutas sin ejecutar scripts de npm.
                &["root", "-g"],
                &mut jobs,
            ),
            "cargo" => add(
                "cargo|cargo".to_string(),
                "cargo",
                &["install", "--list"],
                &mut jobs,
            ),
            "composer" => add(
                "composer|composer".to_string(),
                "composer",
                &["global", "show", "--no-interaction", "--name-only"],
                &mut jobs,
            ),
            "gem" => add(
                "gem|gem".to_string(),
                "gem",
                &["list", "--local"],
                &mut jobs,
            ),
            "dotnet" => add(
                "dotnet|dotnet".to_string(),
                "dotnet",
                &["tool", "list", "--global"],
                &mut jobs,
            ),
            "mix" => {
                add(
                    "mix-archive|mix".to_string(),
                    "mix",
                    &["archive"],
                    &mut jobs,
                );
                add(
                    "mix-escripts|mix".to_string(),
                    "mix",
                    &["escript"],
                    &mut jobs,
                );
            }
            "dart" => add(
                "dart|dart".to_string(),
                "dart",
                &["pub", "global", "list"],
                &mut jobs,
            ),
            "luarocks" | "cabal" if !package.is_empty() => {
                let key = format!("{manager}|{package}");
                let args: Vec<String> = if manager == "luarocks" {
                    vec!["show".to_string(), package.to_string()]
                } else {
                    vec![
                        "list".to_string(),
                        "--installed".to_string(),
                        package.to_string(),
                    ]
                };
                jobs.entry(key)
                    .or_insert_with(|| (manager.to_string(), args));
            }
            _ => {}
        }
    }

    // `module:<programa>:<módulo>` (por ejemplo pip sobre Python) era una sonda
    // aparte con 3 s de plazo: al arrancar agotaba el tiempo y dejaba sin
    // confirmar las 72 acciones de frameworks de Python. Ahora entra en el
    // mismo inventario paralelo, con su plazo, reintento y copia compartida.
    for capability in actions
        .iter()
        .flat_map(|action| [action.check_cmd.as_deref(), action.requires_cmd.as_deref()])
        .flatten()
        .filter_map(|command| command.strip_prefix("module:"))
    {
        let Some((program, module)) = capability.split_once(':') else {
            continue;
        };
        let program_key = format!("__program|{program}");
        if checked_programs.insert(program.to_string()) && !inventory.contains_key(&program_key) {
            let available = crate::path_env::is_tool_installed(program);
            inventory.insert(
                program_key.clone(),
                if available {
                    crate::process::ProbeOutput::Success(String::new())
                } else {
                    crate::process::ProbeOutput::NotFound
                },
            );
        }
        if matches!(
            inventory.get(&program_key),
            Some(crate::process::ProbeOutput::NotFound)
        ) {
            continue;
        }
        jobs.entry(module_inventory_key(program, module))
            .or_insert_with(|| {
                (
                    program.to_string(),
                    vec![
                        "-m".to_string(),
                        module.to_string(),
                        "--version".to_string(),
                    ],
                )
            });
    }
    // Lo ya confirmado por la copia reciente no se vuelve a consultar.
    jobs.retain(|key, _| {
        !matches!(
            inventory.get(key),
            Some(crate::process::ProbeOutput::Success(_))
        )
    });
    if jobs.is_empty() {
        remember_ecosystem_entries(&ECOSYSTEM_INVENTORY_CACHE, generation, inventory, targeted);
        return;
    }
    let jobs: Vec<(String, String, Vec<String>)> = jobs
        .into_iter()
        .map(|(key, (program, args))| (key, program, args))
        .collect();
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = jobs
            .iter()
            .map(|(key, program, args)| {
                scope.spawn(move || {
                    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                    let started = std::time::Instant::now();
                    let output = crate::process::output_text_probe(
                        program,
                        &args_ref,
                        ECOSYSTEM_PROBE_TIMEOUT,
                    );
                    (key.clone(), output, started.elapsed())
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect::<Vec<_>>()
    });
    let mut summary = std::collections::BTreeMap::new();
    let mut retried = Vec::new();
    for (key, output, elapsed) in results {
        // Al arrancar, la precarga compite con WebView2, las sondas de shells
        // y las JVM: `pip list` (1 s en reposo) llegaba a agotar sus 10 s y
        // dejaba sin confirmar todos los frameworks de Python. En la pasada
        // completa se repite una vez, ya sin esa carga.
        let (output, elapsed) =
            if !targeted && matches!(output, crate::process::ProbeOutput::TimedOut) {
                retried.push(key.clone());
                let (_, program, args) = jobs
                    .iter()
                    .find(|(job_key, _, _)| *job_key == key)
                    .expect("cada resultado procede de un trabajo");
                let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                let started = std::time::Instant::now();
                let output =
                    crate::process::output_text_probe(program, &args_ref, ECOSYSTEM_PROBE_TIMEOUT);
                (output, started.elapsed())
            } else {
                (output, elapsed)
            };
        let kind = match &output {
            crate::process::ProbeOutput::Success(_) => "ok",
            crate::process::ProbeOutput::Failed => "error",
            crate::process::ProbeOutput::NotFound => "ausente",
            crate::process::ProbeOutput::TimedOut => "timeout",
        };
        summary.insert(key.clone(), format!("{kind} {}ms", elapsed.as_millis()));
        inventory.insert(key, output);
    }
    if !targeted {
        log_info!(
            "Inventario de ecosistemas",
            serde_json::json!({ "jobs": summary, "retried": retried })
        );
    }
    remember_ecosystem_entries(&ECOSYSTEM_INVENTORY_CACHE, generation, inventory, targeted);
}

/// Plazo de cada inventario de ecosistema y de las sondas de módulo.
const ECOSYSTEM_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Sonda de solo lectura con un segundo intento, con el doble de plazo, si la
/// primera lo agota. La pasada completa corre en segundo plano y compite con
/// el arranque de la app (WebView2, shells, JVM): un timeout ahí dejaba la
/// familia sin confirmar y el panel tenía que comprobarla después, una a una.
fn probe_allowing_retry(
    retry: bool,
    program: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> crate::process::ProbeOutput {
    let first = crate::process::output_text_probe(program, args, timeout);
    if retry && matches!(first, crate::process::ProbeOutput::TimedOut) {
        return crate::process::output_text_probe(program, args, timeout * 2);
    }
    first
}

/// Clave de inventario para `module:<programa>:<módulo>`.
fn module_inventory_key(program: &str, module: &str) -> String {
    format!("module|{program}|{module}")
}

/// Inventarios de ecosistemas (pip, npm, gem…) reutilizables por las
/// comprobaciones de familia, igual que las listas de WinGet: sin esta copia
/// cada framework de Python relanzaba `pip list` y 70 familias sumaban
/// minutos. Solo se guardan respuestas válidas; un timeout se reintenta.
#[derive(Debug, Clone)]
struct CachedEcosystemInventory {
    at: std::time::Instant,
    generation: u64,
    entries: HashMap<String, crate::process::ProbeOutput>,
}

static ECOSYSTEM_INVENTORY_CACHE: std::sync::Mutex<Option<CachedEcosystemInventory>> =
    std::sync::Mutex::new(None);

fn reusable_ecosystem_entries(
    cache: &std::sync::Mutex<Option<CachedEcosystemInventory>>,
    generation: u64,
    now: std::time::Instant,
) -> HashMap<String, crate::process::ProbeOutput> {
    let cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache
        .as_ref()
        .filter(|cached| {
            cached.generation == generation
                && now.saturating_duration_since(cached.at) < WINGET_LISTS_TTL
        })
        .map(|cached| cached.entries.clone())
        .unwrap_or_default()
}

/// Guarda las respuestas válidas. La pasada completa sustituye la copia; una
/// comprobación de familia solo la amplía mientras siga vigente.
fn remember_ecosystem_entries(
    cache: &std::sync::Mutex<Option<CachedEcosystemInventory>>,
    generation: u64,
    inventory: &HashMap<String, crate::process::ProbeOutput>,
    targeted: bool,
) {
    let valid = inventory.iter().filter(|(key, output)| match output {
        crate::process::ProbeOutput::Success(_) => true,
        // Que el runtime no exista también es una respuesta válida.
        crate::process::ProbeOutput::NotFound => key.starts_with("__program|"),
        // `python -m pip --version` con error: el módulo no está instalado.
        crate::process::ProbeOutput::Failed => key.starts_with("module|"),
        _ => false,
    });
    let mut cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = std::time::Instant::now();
    let extend = targeted
        && cache.as_ref().is_some_and(|cached| {
            cached.generation == generation
                && now.saturating_duration_since(cached.at) < WINGET_LISTS_TTL
        });
    if extend {
        if let Some(cached) = cache.as_mut() {
            cached
                .entries
                .extend(valid.map(|(key, output)| (key.clone(), output.clone())));
        }
        return;
    }
    *cache = Some(CachedEcosystemInventory {
        at: now,
        generation,
        entries: valid
            .map(|(key, output)| (key.clone(), output.clone()))
            .collect(),
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectionState {
    Installed,
    Missing,
    Unknown,
}

/// WinGet tarda mucho más en arrancar que en imprimir una fila. Consultarlo
/// una vez y cruzar sus identificadores contra el catálogo evita cientos de
/// procesos consecutivos al abrir o repetir Dependencias. Si el inventario no
/// está disponible se deja el mapa vacío y `winget_capability_installed`
/// conserva su ruta de consulta individual como respaldo.
#[derive(Debug, Default)]
struct WingetInventory {
    packages: HashMap<String, bool>,
    complete: bool,
    /// Inventario de Chocolatey consultado una sola vez. WinGet puede no
    /// cubrir una instalación hecha desde Chocolatey, pero repetir `choco
    /// list --exact` para cada acción convierte una detección en cientos de
    /// procesos con timeout.
    chocolatey_packages: HashMap<String, bool>,
    chocolatey_checked: bool,
    /// Una comprobación de una familia concreta puede resolver su paquete con
    /// `winget list --id` aunque una de las listas globales haya fallado. Solo
    /// se activa para catálogos pequeños (una herramienta abierta), nunca para
    /// la pasada completa de cientos de acciones.
    targeted_allowed: bool,
    targeted_packages: HashMap<String, DetectionState>,
}

fn prefetch_winget_inventory(actions: &[InstallAction], inventory: &mut WingetInventory) {
    let mut expected = HashMap::<String, ()>::new();
    for command in actions.iter().filter_map(|action| {
        action
            .check_cmd
            .as_deref()
            .or(action.requires_cmd.as_deref())
    }) {
        let Some(spec) = command.strip_prefix("winget:") else {
            continue;
        };
        let Some((package, _)) = spec.split_once('|') else {
            continue;
        };
        let package = package.trim();
        if !package.is_empty() {
            expected.insert(package.to_ascii_lowercase(), ());
        }
    }
    if expected.is_empty() {
        return;
    }
    // Una comprobación de familia (pocas acciones) puede reutilizar las listas
    // de la pasada anterior; la pasada completa siempre consulta de nuevo.
    let targeted = expected.len() <= 8;
    let started = std::time::Instant::now();
    let lists = winget_lists_for(
        targeted,
        &WINGET_LISTS_CACHE,
        DETECTION_GENERATION.load(std::sync::atomic::Ordering::SeqCst),
        std::time::Instant::now,
        |extra, timeout| {
            let mut args = vec![
                "list",
                "--accept-source-agreements",
                "--disable-interactivity",
            ];
            args.extend_from_slice(extra);
            match crate::process::winget_probe(&args, timeout) {
                crate::process::ProbeOutput::Success(output) => Some(output),
                _ => None,
            }
        },
    );
    for output in [&lists.all, &lists.winget, &lists.store]
        .into_iter()
        .flatten()
    {
        merge_winget_inventory(output, &expected, &mut inventory.packages);
    }
    if !targeted {
        log_info!(
            "Inventario de WinGet",
            serde_json::json!({
                "complete": lists.complete(),
                "all": lists.all.is_some(),
                "winget": lists.winget.is_some(),
                "msstore": lists.store.is_some(),
                "durationMs": started.elapsed().as_millis() as u64,
            })
        );
    }
    // Chocolatey no siempre responde a `list` cuando otro proceso mantiene
    // su almacén ocupado. Leer sus carpetas de paquetes es instantáneo y usa
    // la misma fuente local que la sonda individual, sin dejar un proceso
    // hijo retenido durante toda la detección.
    inventory.chocolatey_checked = true;
    inventory.chocolatey_packages = chocolatey_package_inventory(&expected);
    inventory.targeted_allowed = targeted;
    // Solo fijamos «Missing» cuando al menos una lista cubre todos los
    // orígenes. Si únicamente respondió una fuente, las acciones ausentes
    // conservan la ruta de consulta individual y no generan falsos negativos
    // (por ejemplo OpenVPN/GUI instalados desde Store o con alcance de usuario).
    inventory.complete = lists.complete();
}

/// Salidas de `winget list`. `all` (sin `--source`) es la fuente de verdad;
/// las listas por origen son el respaldo para versiones de WinGet que omiten
/// registros en el listado agregado o fallan con un índice bloqueado.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct WingetLists {
    all: Option<String>,
    winget: Option<String>,
    store: Option<String>,
}

impl WingetLists {
    fn complete(&self) -> bool {
        self.all.is_some() || (self.winget.is_some() && self.store.is_some())
    }
}

/// Copia breve de unas listas completas. Al abrir Dependencias, cada familia
/// que quedó sin confirmar se comprueba por separado; sin esta copia cada una
/// relanzaba `winget list` (2–5 s) y decenas de familias sumaban minutos.
#[derive(Debug, Clone)]
struct CachedWingetLists {
    at: std::time::Instant,
    generation: u64,
    lists: WingetLists,
}

static WINGET_LISTS_CACHE: std::sync::Mutex<Option<CachedWingetLists>> =
    std::sync::Mutex::new(None);
/// Cambia al instalar desde el panel o al repetir la detección: las copias de
/// WinGet y de los ecosistemas dejan de servir aunque no hayan caducado.
static DETECTION_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const WINGET_LISTS_TTL: std::time::Duration = std::time::Duration::from_secs(60);

fn invalidate_detection_caches() {
    DETECTION_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Consulta en serie: primero el listado global y, solo si falla, los dos
/// orígenes. Lanzarlos a la vez provocaba que WinGet rechazara alguno.
fn query_winget_lists(
    mut list: impl FnMut(&[&str], std::time::Duration) -> Option<String>,
) -> WingetLists {
    let all = list(&[], std::time::Duration::from_secs(12));
    if all.is_some() {
        return WingetLists {
            all,
            ..WingetLists::default()
        };
    }
    WingetLists {
        all: None,
        winget: list(&["--source", "winget"], std::time::Duration::from_secs(12)),
        store: list(&["--source", "msstore"], std::time::Duration::from_secs(4)),
    }
}

/// Listas para una detección. Una comprobación de familia reutiliza la copia
/// vigente; la pasada completa siempre consulta y renueva la copia. El
/// cerrojo de la copia se mantiene durante la consulta para que las
/// comprobaciones que esperan detrás aprovechen el resultado.
fn winget_lists_for(
    targeted: bool,
    cache: &std::sync::Mutex<Option<CachedWingetLists>>,
    generation: u64,
    now: impl Fn() -> std::time::Instant,
    list: impl FnMut(&[&str], std::time::Duration) -> Option<String>,
) -> WingetLists {
    let mut cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if targeted {
        if let Some(cached) = cache.as_ref() {
            if cached.generation == generation
                && now().saturating_duration_since(cached.at) < WINGET_LISTS_TTL
            {
                return cached.lists.clone();
            }
        }
    }
    let lists = query_winget_lists(list);
    if lists.complete() {
        *cache = Some(CachedWingetLists {
            at: now(),
            generation,
            lists: lists.clone(),
        });
    }
    lists
}

fn chocolatey_package_inventory(expected: &HashMap<String, ()>) -> HashMap<String, bool> {
    let root = std::env::var_os("ChocolateyInstall")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\ProgramData\chocolatey"));
    let installed = std::fs::read_dir(root.join("lib"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry
                .file_type()
                .ok()?
                .is_dir()
                .then(|| entry.file_name().to_string_lossy().to_ascii_lowercase())
        })
        .collect::<std::collections::HashSet<_>>();
    expected
        .keys()
        .map(|package| (package.clone(), installed.contains(package)))
        .collect()
}

fn merge_winget_inventory(
    output: &str,
    expected: &HashMap<String, ()>,
    inventory: &mut HashMap<String, bool>,
) {
    for package in expected.keys() {
        inventory.insert(package.clone(), false);
    }
    for line in output.lines() {
        for field in split_inventory_fields(line) {
            let id = normalize_inventory_field(field);
            if expected.contains_key(&id) {
                inventory.insert(id, true);
            }
        }
    }
}

/// WinGet puede adornar la tabla con secuencias ANSI y devuelve `\r` cuando
/// la salida viene de una consola Windows. Normalizar antes de comparar evita
/// que un identificador válido se convierta en un falso «no instalado».
fn split_inventory_fields(line: &str) -> impl Iterator<Item = &str> {
    line.split(|character: char| character.is_whitespace() || character == '|')
        .filter(|field| !field.is_empty())
}

fn normalize_inventory_field(field: &str) -> String {
    strip_terminal_control_sequences(field)
        .trim_matches(|character: char| {
            character == '"'
                || character == '\''
                || character == '`'
                || character == '\r'
                || character == '\u{feff}'
        })
        .to_ascii_lowercase()
}

fn strip_terminal_control_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            if !character.is_control() || character == '\t' {
                output.push(character);
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                // CSI: termina en un byte final de @ a ~.
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: termina con BEL o con ESC \\.
                let mut escaped = false;
                for next in chars.by_ref() {
                    if next == '\u{7}' || (escaped && next == '\\') {
                        break;
                    }
                    escaped = next == '\u{1b}';
                }
            }
            Some(_) | None => {}
        }
    }
    output
}

/// Detecta una herramienta instalada por Chocolatey aunque el paquete no haya
/// creado un shim global. Algunos paquetes de lenguajes (por ejemplo Elixir)
/// son portables y solo traen sus `.bat` dentro de `lib\\<id>\\tools\\bin`.
///
/// La ruta se añade únicamente al PATH del proceso de WTerminal. Así las
/// pestañas nuevas funcionan sin tocar el registro y cada arranque vuelve a
/// descubrir el paquete de forma determinista.
fn chocolatey_capability_installed(spec: &str) -> DetectionState {
    let mut fields = spec.splitn(2, '|');
    let package = fields.next().unwrap_or_default().trim();
    let command = fields.next().unwrap_or_default().trim();
    if package.is_empty() || command.is_empty() {
        return DetectionState::Missing;
    }

    if command != "__package__" && crate::path_env::is_tool_installed(command) {
        return DetectionState::Installed;
    }

    let root = std::env::var_os("ChocolateyInstall")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| {
            crate::platform::host()
                .is_windows()
                .then(|| std::path::PathBuf::from(r"C:\ProgramData\chocolatey"))
        });
    let Some(root) = root else {
        return DetectionState::Missing;
    };
    let lib = root.join("lib");
    let package_dir = lib.join(package);
    let package_dir = if package_dir.is_dir() {
        package_dir
    } else {
        let Ok(entries) = std::fs::read_dir(&lib) else {
            return DetectionState::Missing;
        };
        let Some(found) = entries.flatten().find(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(package)
        }) else {
            return DetectionState::Missing;
        };
        found.path()
    };

    if command == "__package__" {
        return DetectionState::Installed;
    }

    let tools = package_dir.join("tools");
    if !tools.is_dir() {
        // Un paquete que ya tiene su carpeta de Chocolatey está instalado aun
        // cuando sea una app gráfica o portable sin un ejecutable conocido.
        return DetectionState::Installed;
    }
    let mut candidates = vec![tools.clone(), tools.join("bin")];
    candidates.retain(|path| path.is_dir());
    for directory in &candidates {
        let value = directory.to_string_lossy();
        crate::path_env::add_to_process_path(&value);
    }
    if crate::path_env::is_tool_installed(command) {
        DetectionState::Installed
    } else {
        // La carpeta del paquete es una fuente de verdad más fiable que el
        // shim: algunos paquetes portables no exponen el binario en PATH,
        // pero sí deben ofrecer actualizar/desinstalar en el panel.
        DetectionState::Installed
    }
}

fn winget_capability_installed(spec: &str, inventory: &mut WingetInventory) -> DetectionState {
    let mut fields = spec.splitn(2, '|');
    let package = fields.next().unwrap_or_default().trim();
    let command = fields.next().unwrap_or_default().trim();
    if package.is_empty() || command.is_empty() {
        return DetectionState::Missing;
    }
    if command != "__package__" && crate::path_env::is_tool_installed(command) {
        return DetectionState::Installed;
    }
    if inventory.complete {
        return match inventory.packages.get(&package.to_ascii_lowercase()) {
            Some(true) => DetectionState::Installed,
            Some(false) => DetectionState::Missing,
            None => DetectionState::Unknown,
        };
    }
    // La consulta global de Chocolatey ya se ha intentado en paralelo. Solo
    // una coincidencia prueba que el paquete está presente; una ausencia no
    // demuestra que no exista en WinGet, por eso se conserva como Unknown y
    // evita relanzar el mismo proceso para cada acción.
    if inventory.chocolatey_checked {
        if inventory.targeted_allowed {
            if let Some(state) = inventory.targeted_packages.get(package) {
                return *state;
            }
            let state = match crate::process::winget_probe(
                &[
                    "list",
                    "--id",
                    package,
                    "-e",
                    "--accept-source-agreements",
                    "--disable-interactivity",
                ],
                std::time::Duration::from_secs(5),
            ) {
                crate::process::ProbeOutput::Success(output)
                    if inventory_has_package_id(&output, package) =>
                {
                    DetectionState::Installed
                }
                crate::process::ProbeOutput::Success(_) => DetectionState::Missing,
                crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
                crate::process::ProbeOutput::Failed | crate::process::ProbeOutput::NotFound => {
                    DetectionState::Unknown
                }
            };
            inventory
                .targeted_packages
                .insert(package.to_ascii_lowercase(), state);
            return state;
        }
        if inventory
            .chocolatey_packages
            .get(&package.to_ascii_lowercase())
            .copied()
            .unwrap_or(false)
        {
            return DetectionState::Installed;
        }
        return DetectionState::Unknown;
    }
    // No fijar `--source winget`: instalaciones registradas por otro
    // origen (o por una versión anterior del catálogo) siguen siendo
    // instalaciones válidas y deben ocultar «Instalar». La consulta
    // con fuente se conserva como respaldo para versiones antiguas de
    // WinGet que exigen ese filtro al usar `-e`.
    let mut timed_out = false;
    let mut failed = false;
    let all_sources = crate::process::winget_probe(
        &[
            "list",
            "--id",
            package,
            "-e",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
        std::time::Duration::from_secs(12),
    );
    match all_sources {
        crate::process::ProbeOutput::Success(output)
            if inventory_has_package_id(&output, package) =>
        {
            return DetectionState::Installed;
        }
        crate::process::ProbeOutput::TimedOut => timed_out = true,
        crate::process::ProbeOutput::Failed => failed = true,
        _ => {}
    }
    let from_winget = crate::process::winget_probe(
        &[
            "list",
            "--id",
            package,
            "-e",
            "--source",
            "winget",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
        std::time::Duration::from_secs(12),
    );
    match from_winget {
        crate::process::ProbeOutput::Success(output)
            if inventory_has_package_id(&output, package) =>
        {
            return DetectionState::Installed;
        }
        crate::process::ProbeOutput::TimedOut => timed_out = true,
        crate::process::ProbeOutput::Failed => failed = true,
        _ => {}
    }
    // Algunos instaladores corporativos aparecen en Chocolatey pero
    // no en WinGet. Su inventario local es una fuente de verdad igual
    // de válida para el catálogo de aplicaciones de escritorio.
    let result = match crate::process::output_text_probe(
        "choco",
        &["list", "--local-only", "--exact", package, "--limit-output"],
        std::time::Duration::from_secs(12),
    ) {
        crate::process::ProbeOutput::Success(output)
            if inventory_has_package_id(&output, package) =>
        {
            DetectionState::Installed
        }
        crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
        crate::process::ProbeOutput::Success(_)
        | crate::process::ProbeOutput::Failed
        | crate::process::ProbeOutput::NotFound => DetectionState::Missing,
    };
    let result = if (timed_out || failed) && result == DetectionState::Missing {
        DetectionState::Unknown
    } else {
        result
    };
    if result == DetectionState::Installed {
        inventory
            .packages
            .insert(package.to_ascii_lowercase(), true);
    }
    result
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
    inventory: &mut HashMap<String, crate::process::ProbeOutput>,
) -> DetectionState {
    let mut fields = spec.splitn(3, '|');
    let manager = fields.next().unwrap_or_default();
    let program = fields.next().unwrap_or_default();
    let packages = fields.next().unwrap_or_default();
    let timeout = std::time::Duration::from_secs(10);

    // `prefetch_ecosystem_inventory` comprueba una vez el runtime que alimenta
    // cada gestor. Si no existe, no debemos volver a lanzar `python -m pip`,
    // `luarocks show`, etc.: algunos alias de Windows permanecen abiertos y
    // convierten todas las acciones de la familia en «Comprobar» por timeout.
    if !program.is_empty()
        && matches!(
            inventory.get(&format!("__program|{program}")),
            Some(crate::process::ProbeOutput::NotFound)
        )
    {
        return DetectionState::Missing;
    }

    let cached = |key: String,
                  program: &str,
                  args: &[&str],
                  inventory: &mut HashMap<String, crate::process::ProbeOutput>|
     -> crate::process::ProbeOutput {
        inventory
            .entry(key)
            .or_insert_with(|| crate::process::output_text_probe(program, args, timeout))
            .clone()
    };

    let matches = |probe: crate::process::ProbeOutput, predicate: &dyn Fn(&str) -> bool| match probe
    {
        crate::process::ProbeOutput::Success(output) => {
            if predicate(&output) {
                DetectionState::Installed
            } else {
                DetectionState::Missing
            }
        }
        crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
        // El gestor respondió y terminó con error: no hay inventario válido
        // que confirme el paquete. Solo un timeout conserva «desconocido»;
        // de lo contrario las acciones de ciclo de vida se quedarían para
        // siempre en «Comprobar» aunque el gestor sí esté disponible.
        crate::process::ProbeOutput::Failed => DetectionState::Missing,
        crate::process::ProbeOutput::NotFound => DetectionState::Missing,
    };

    match manager {
        "pip" => matches(
            cached(
                format!("pip|{program}"),
                program,
                &["-m", "pip", "list", "--format=freeze"],
                inventory,
            ),
            &|output| {
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
            },
        ),
        "npm" => matches(
            cached(
                format!("npm|{program}"),
                program,
                &["root", "-g"],
                inventory,
            ),
            &|output| npm_global_root_has_packages(output, packages),
        ),
        "cargo" => matches(
            cached(
                "cargo|cargo".to_string(),
                "cargo",
                &["install", "--list"],
                inventory,
            ),
            &|output| {
                output
                    .lines()
                    .any(|line| line.split_whitespace().next() == Some(packages))
            },
        ),
        "path" => {
            if crate::path_env::is_tool_installed(packages) {
                DetectionState::Installed
            } else {
                DetectionState::Missing
            }
        }
        "composer" => matches(
            cached(
                "composer|composer".to_string(),
                "composer",
                &["global", "show", "--no-interaction", "--name-only"],
                inventory,
            ),
            &|output| output.lines().any(|line| line.trim() == packages),
        ),
        "gem" => {
            let listed = cached(
                "gem|gem".to_string(),
                "gem",
                &["list", "--local"],
                inventory,
            );
            let detected = matches(listed, &|output| {
                output.lines().any(|line| {
                    line.trim()
                        .split(|character: char| character.is_whitespace() || character == '(')
                        .next()
                        .is_some_and(|name| name.eq_ignore_ascii_case(packages))
                })
            });
            if detected != DetectionState::Missing {
                detected
            } else {
                // RubyGems puede imprimir una lista distinta cuando la app
                // hereda un GEM_HOME de usuario. La API de Ruby consulta las
                // mismas rutas efectivas y evita volver a ofrecer una gema
                // que ya existe aunque el formato de `gem list` cambie.
                match crate::process::output_text_probe(
                    "ruby",
                    &[
                        "-rrubygems",
                        "-e",
                        "exit(Gem::Specification.find_all_by_name(ARGV.fetch(0)).empty? ? 1 : 0)",
                        packages,
                    ],
                    std::time::Duration::from_secs(5),
                ) {
                    crate::process::ProbeOutput::Success(_) => DetectionState::Installed,
                    crate::process::ProbeOutput::TimedOut => DetectionState::Unknown,
                    crate::process::ProbeOutput::Failed | crate::process::ProbeOutput::NotFound => {
                        detected
                    }
                }
            }
        }
        "dotnet" => matches(
            cached(
                "dotnet|dotnet".to_string(),
                "dotnet",
                &["tool", "list", "--global"],
                inventory,
            ),
            &|output| inventory_has_package(output, packages),
        ),
        "mix" => {
            let archive = matches(
                cached(
                    "mix-archive|mix".to_string(),
                    "mix",
                    &["archive"],
                    inventory,
                ),
                &|output| output.contains(packages),
            );
            if archive == DetectionState::Installed {
                archive
            } else {
                let script = matches(
                    cached(
                        "mix-escripts|mix".to_string(),
                        "mix",
                        &["escript"],
                        inventory,
                    ),
                    &|output| output.contains(packages),
                );
                match (archive, script) {
                    (DetectionState::Installed, _) | (_, DetectionState::Installed) => {
                        DetectionState::Installed
                    }
                    (DetectionState::Unknown, _) | (_, DetectionState::Unknown) => {
                        DetectionState::Unknown
                    }
                    _ => DetectionState::Missing,
                }
            }
        }
        "dart" => matches(
            cached(
                "dart|dart".to_string(),
                "dart",
                &["pub", "global", "list"],
                inventory,
            ),
            &|output| output.lines().any(|line| line.starts_with(packages)),
        ),
        "luarocks" => matches(
            cached(
                format!("luarocks|{packages}"),
                "luarocks",
                &["show", packages],
                inventory,
            ),
            &|_| true,
        ),
        "cabal" => matches(
            cached(
                format!("cabal|{packages}"),
                "cabal",
                &["list", "--installed", packages],
                inventory,
            ),
            &|output| output.contains(packages),
        ),
        _ => DetectionState::Missing,
    }
}

fn inventory_has_package(output: &str, package: &str) -> bool {
    output.lines().any(|line| {
        line.split_whitespace()
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(package))
    })
}

/// Comprueba paquetes npm sin pedir a npm que recorra todos sus metadatos.
/// `npm root -g` devuelve una única ruta; resolver cada nombre debajo de ella
/// cubre también paquetes con scope (`@scope/name`) y no ejecuta código del
/// paquete. Se conserva la lectura JSON para aceptar cachés creadas por
/// versiones anteriores de la aplicación.
fn npm_global_root_has_packages(output: &str, packages: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(output) {
        if let Some(dependencies) = value
            .get("dependencies")
            .and_then(serde_json::Value::as_object)
        {
            return packages
                .split_whitespace()
                .all(|package| dependencies.contains_key(package));
        }
    }
    let Some(root) = output.lines().map(str::trim).find(|line| !line.is_empty()) else {
        return false;
    };
    let root = Path::new(root);
    packages
        .split_whitespace()
        .all(|package| root.join(package).exists())
}

/// WinGet y Chocolatey imprimen tablas con columnas distintas según la
/// versión, el idioma y el origen del paquete. El identificador puede estar
/// en cualquier columna; exigir una coincidencia exacta evita confundirlo con
/// otro paquete que solo comparte un prefijo.
fn inventory_has_package_id(output: &str, package: &str) -> bool {
    let package = package.to_ascii_lowercase();
    output.lines().any(|line| {
        split_inventory_fields(line).any(|field| normalize_inventory_field(field) == package)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallList {
    pub actions: Vec<InstallAction>,
    /// `true` solo cuando todas las sondas de la pasada están terminadas.
    /// El frontend no debe presentar un catálogo estructural como si fuera
    /// el inventario confirmado.
    #[serde(default)]
    pub complete: bool,
}

/// Decide qué acciones deben viajar juntas cuando se comprueba una entrada.
/// Las acciones sin `subgroup` son filas independientes aunque compartan el
/// valor nulo; solo una familia declarada explícitamente puede agrupar varias
/// acciones de ciclo de vida.
fn belongs_to_install_family(anchor: &InstallAction, candidate: &InstallAction) -> bool {
    if anchor.subgroup.is_none() {
        return candidate.id == anchor.id;
    }
    candidate.subgroup == anchor.subgroup
        && (anchor.subgroup_item.is_none() || candidate.subgroup_item == anchor.subgroup_item)
}

fn install_status_cache_path() -> std::path::PathBuf {
    crate::paths::user_data_dir().join("install-actions-cache.json")
}

fn install_snapshot_cache_path() -> std::path::PathBuf {
    crate::paths::user_data_dir().join("install-actions-snapshot.json")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CachedInstallStatus {
    id: String,
    installed: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CachedInstallSnapshot {
    schema: u8,
    language: String,
    actions: Vec<InstallAction>,
}

fn read_install_snapshot() -> Option<InstallList> {
    let text = std::fs::read_to_string(install_snapshot_cache_path()).ok()?;
    let snapshot = serde_json::from_str::<CachedInstallSnapshot>(&text).ok()?;
    if snapshot.schema != 1 || snapshot.language != crate::i18n::active_language() {
        return None;
    }
    (!snapshot.actions.is_empty()).then_some(InstallList {
        actions: snapshot.actions,
        complete: true,
    })
}

fn write_install_snapshot(actions: &[InstallAction]) {
    if actions.is_empty()
        || actions
            .iter()
            .any(|action| action.detection_status.is_some())
    {
        return;
    }
    let path = install_snapshot_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let snapshot = CachedInstallSnapshot {
        schema: 1,
        language: crate::i18n::active_language(),
        actions: actions.to_vec(),
    };
    if let Ok(text) = serde_json::to_string(&snapshot) {
        let _ = std::fs::write(path, text);
    }
}

fn read_install_status_cache() -> Vec<CachedInstallStatus> {
    std::fs::read_to_string(install_status_cache_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<CachedInstallStatus>>(&text).ok())
        .unwrap_or_default()
}

fn write_install_status_cache(actions: &[InstallAction]) {
    let path = install_status_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let statuses: Vec<CachedInstallStatus> = actions
        .iter()
        .filter(|action| action.detection_status.is_none())
        .map(|action| CachedInstallStatus {
            id: action.id.clone(),
            installed: action.installed,
        })
        .collect();
    write_cached_install_statuses(&statuses);
}

fn write_cached_install_statuses(statuses: &[CachedInstallStatus]) {
    let path = install_status_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(statuses) {
        let _ = std::fs::write(path, text);
    }
}

fn install_family_key(action: &InstallAction) -> Option<String> {
    action.subgroup.as_ref().map(|subgroup| {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            action.group,
            subgroup,
            action.subgroup_item.as_deref().unwrap_or_default()
        )
    })
}

fn overlay_cached_statuses_with_cache(
    mut list: InstallList,
    cache: Vec<CachedInstallStatus>,
) -> InstallList {
    let cached = cache
        .into_iter()
        .map(|action| (action.id.clone(), action))
        .collect::<std::collections::HashMap<_, _>>();
    // El estado persistente debe ser coherente por familia. Una caché antigua
    // podía conservar «Actualizar»/«Desinstalar» como instaladas mientras la
    // acción base seguía en «Comprobar», una combinación imposible.
    let mut family_state = std::collections::HashMap::<String, Option<bool>>::new();
    for action in &list.actions {
        if !is_install_action(action) {
            continue;
        }
        let Some(key) = install_family_key(action) else {
            continue;
        };
        let Some(previous) = cached.get(&action.id) else {
            family_state.entry(key).or_insert(None);
            continue;
        };
        let Some(installed) = previous.installed else {
            family_state.entry(key).or_insert(None);
            continue;
        };
        family_state
            .entry(key)
            .and_modify(|state| {
                if state.is_some() && *state != Some(installed) {
                    *state = None;
                }
            })
            .or_insert(Some(installed));
    }

    let mut normalized = Vec::with_capacity(list.actions.len());
    for mut action in list.actions {
        let family = install_family_key(&action)
            .and_then(|key| family_state.get(&key).copied().map(|state| (key, state)));
        if let Some((_key, state)) = family {
            match state {
                // La base falta: solo se ofrece instalar; las operaciones que
                // requieren una instalación confirmada no son aplicables.
                Some(false) if !is_install_action(&action) => continue,
                // La base existe: el botón «Instalar» ya no debe sobrevivir a
                // una caché confirmada como instalada.
                Some(true) if is_install_action(&action) => continue,
                // Sin confirmación coherente, se descarta la caché de la
                // familia completa y el usuario puede comprobarla al abrirla.
                None => {
                    action.installed = None;
                    action.detection_status = Some(DetectionStatus::Unknown);
                    normalized.push(action);
                    continue;
                }
                Some(_) => {}
            }
        }
        if let Some(previous) = cached.get(&action.id) {
            action.installed = previous.installed;
            action.detection_status = None;
        }
        normalized.push(action);
    }
    list.actions = normalized;
    list
}

/// Catálogo navegable sin sondas. Se puede pintar inmediatamente; los
/// estados desconocidos se resuelven cuando se abre una herramienta concreta.
#[tauri::command(async)]
pub fn install_catalog(state: State<'_, Arc<AppState>>) -> InstallList {
    if let Some(snapshot) = read_install_snapshot() {
        state.remember_install_actions(&snapshot.actions, true);
        log_catalog_delivery("snapshot", &snapshot.actions);
        return snapshot;
    }
    // En el primer arranque la precarga puede seguir sondeando WSL, Docker y
    // los gestores de paquetes. Esperar aquí evita presentar un catálogo
    // estructural (sin WSL ni sus distribuciones) y que la misma ventana
    // cambie al pulsar «Repetir detección». Los arranques posteriores usan el
    // snapshot anterior y no pasan por esta espera.
    if let Some(actions) = state.wait_for_install_prefetch_start(std::time::Duration::from_secs(10))
    {
        log_catalog_delivery("precarga", &actions);
        return InstallList {
            actions,
            complete: true,
        };
    }
    let inventory = state.inventory();
    // El archivo persistente es la base entre arranques. La precarga completa
    // puede estar disponible en memoria, pero no debe hacer que el primer
    // pintado dependa de que las sondas lentas hayan terminado justo en ese
    // instante. Las comprobaciones frescas quedan para la entrada concreta o
    // para «Repetir detección».
    let catalog = build_list(&state, inventory, DetectionDepth::Catalog);
    let cached = read_install_status_cache();
    if !cached.is_empty() {
        let mut result = overlay_cached_statuses_with_cache(catalog, cached);
        result.complete = false;
        log_catalog_delivery("estructura+cache", &result.actions);
        return result;
    }
    catalog
}

/// Comprueba solamente la herramienta que acaba de abrirse. Las acciones de
/// una misma familia se devuelven juntas para que instalar/actualizar/
/// desinstalar cambien de estado de forma coherente, sin escanear el resto.
#[tauri::command(async)]
pub fn install_check(state: State<'_, Arc<AppState>>, action_id: String) -> InstallList {
    let started = std::time::Instant::now();
    let inventory = state.inventory();
    let context = install_context(inventory.pkg_manager.clone(), DetectionDepth::Catalog);
    let t = Translator::new(&crate::i18n::active_language());
    let catalog = install_actions::get_install_actions(&context, &t);
    let Some(anchor) = catalog
        .iter()
        .find(|action| action.id == action_id)
        .cloned()
    else {
        return InstallList {
            actions: Vec::new(),
            complete: true,
        };
    };
    let related: Vec<InstallAction> = catalog
        .into_iter()
        .filter(|action| belongs_to_install_family(&anchor, action))
        .collect();
    let checked: Vec<InstallAction> =
        filter_available_actions_with_depth(related, DetectionDepth::Full)
            .into_iter()
            .map(|action| action.translated(&t.language))
            .collect();
    let mut cache = read_install_status_cache();
    cache.retain(|cached| {
        !checked
            .iter()
            .any(|action: &InstallAction| action.id == cached.id)
    });
    cache.extend(
        checked
            .iter()
            .filter(|action| action.detection_status.is_none())
            .map(|action| CachedInstallStatus {
                id: action.id.clone(),
                installed: action.installed,
            }),
    );
    write_cached_install_statuses(&cache);
    let unknown_after = checked
        .iter()
        .filter(|action| action.detection_status.is_some())
        .count();
    let elapsed = started.elapsed();
    if elapsed >= std::time::Duration::from_secs(1) || unknown_after > 0 {
        log_info!(
            "Familia de Dependencias comprobada",
            serde_json::json!({
                "actionId": action_id,
                "source": detection_source(&anchor),
                "actions": checked.len(),
                "unknownAfter": unknown_after,
                "durationMs": elapsed.as_millis() as u64,
            })
        );
    }
    InstallList {
        actions: checked,
        complete: true,
    }
}

/// `install:list`: compatibilidad histórica para el frontend. Devuelve solo
/// la estructura del catálogo; las sondas viven en `install_check`.
#[tauri::command(async)]
pub fn install_list(app: AppHandle, state: State<'_, Arc<AppState>>) -> InstallList {
    // Abrir el panel solo construye las tarjetas y sus acciones. Las sondas
    // costosas se reservan para `install_check`, al desplegar una herramienta.
    let _ = app;
    let inventory = state.inventory();
    build_list(&state, inventory, DetectionDepth::Catalog)
}

/// Construye el catálogo una sola vez desde el hilo de precarga del arranque.
/// La función es pública solo para coordinar los módulos internos de Tauri;
/// no se expone como comando al frontend.
pub fn prefetch_install_catalog(state: &AppState, inventory: crate::environments::Inventory) {
    let started = std::time::Instant::now();
    let list = build_list(state, inventory, DetectionDepth::Full);
    // La primera detección completa también debe dejar una base reutilizable
    // para el siguiente arranque; de lo contrario el caché solo nacía después
    // de pulsar manualmente el botón de recarga.
    write_install_status_cache(&list.actions);
    write_install_snapshot(&list.actions);
    state.finish_install_prefetch();
    log_info!(
        "Catálogo de dependencias precargado",
        serde_json::json!({ "durationMs": started.elapsed().as_millis() as u64 })
    );
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
    invalidate_detection_caches();
    let inventory = state.refresh_environments();
    let _ = app.emit("envs-updated", inventory.clone());
    // Si la precarga del arranque sigue trabajando, unirse a ella evita dos
    // pasadas completas simultáneas. Una precarga ya terminada no se
    // reutiliza: devolvía su lista (con los timeouts del arranque) y «Repetir
    // detección» no detectaba nada nuevo, ni siquiera tras instalar algo.
    if let Some(actions) =
        state.wait_for_running_install_prefetch(std::time::Duration::from_secs(600))
    {
        let list = InstallList {
            actions,
            complete: true,
        };
        write_install_status_cache(&list.actions);
        write_install_snapshot(&list.actions);
        return list;
    }
    let list = build_list(&state, inventory, DetectionDepth::Full);
    write_install_status_cache(&list.actions);
    write_install_snapshot(&list.actions);
    list
}

/// Origen de la sonda que decide el estado de una acción: el prefijo de su
/// comprobación (`winget`, `ecosystem:pip`, `module`…) o `path` si es un
/// ejecutable. Solo se usa en los registros de diagnóstico.
fn detection_source(action: &InstallAction) -> String {
    let source = |command: &str| match command.split_once(':') {
        Some(("ecosystem", rest)) => {
            format!("ecosystem:{}", rest.split('|').next().unwrap_or_default())
        }
        Some(("module", rest)) => format!("module:{}", rest.replace(':', ".")),
        Some((prefix, _)) => prefix.to_string(),
        None => "path".to_string(),
    };
    match (action.check_cmd.as_deref(), action.requires_cmd.as_deref()) {
        (Some(check), Some(requires)) => format!("{} + {}", source(check), source(requires)),
        (Some(command), None) | (None, Some(command)) => source(command),
        (None, None) => "sin-sonda".to_string(),
    }
}

/// Resumen de las acciones sin confirmar para los registros: total, recuento
/// por origen de sonda y algunos identificadores de ejemplo.
fn unknown_summary(
    actions: &[InstallAction],
) -> (
    usize,
    std::collections::BTreeMap<String, usize>,
    Vec<String>,
) {
    let mut by_source = std::collections::BTreeMap::new();
    let mut sample = Vec::new();
    let mut total = 0;
    for action in actions
        .iter()
        .filter(|action| action.detection_status.is_some())
    {
        total += 1;
        *by_source.entry(detection_source(action)).or_insert(0) += 1;
        if sample.len() < 8 {
            sample.push(action.id.clone());
        }
    }
    (total, by_source, sample)
}

fn log_catalog_delivery(source: &str, actions: &[InstallAction]) {
    let (unknown, unknown_by_source, unknown_sample) = unknown_summary(actions);
    log_info!(
        "Catálogo de Dependencias entregado",
        serde_json::json!({
            "source": source,
            "actions": actions.len(),
            "unknown": unknown,
            "unknownBySource": unknown_by_source,
            "unknownSample": unknown_sample,
        })
    );
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
        DetectionDepth::Catalog => "catalog",
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

    let (unknown, unknown_by_source, unknown_sample) = unknown_summary(&actions);
    log_info!(
        "Catalogo de acciones preparado",
        serde_json::json!({
            "depth": depth_name,
            "actions": actions.len(),
            "unknown": unknown,
            "unknownBySource": unknown_by_source,
            "unknownSample": unknown_sample,
            "durationMs": started.elapsed().as_millis() as u64,
        })
    );
    state.remember_install_actions(&actions, depth == DetectionDepth::Full);
    InstallList {
        actions,
        complete: depth == DetectionDepth::Full,
    }
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
    // Lo que se instale o desinstale ahora cambia lo que WinGet lista: la
    // siguiente comprobación de familia no debe reutilizar la copia anterior.
    invalidate_detection_caches();

    // Lo que el panel enseñó es lo que se ejecuta. Si no hay nada guardado
    // (la app acaba de arrancar y el panel no se ha abierto), se regenera el
    // catálogo con el mismo contexto para que la acción sea la misma.
    let actions = state.install_actions().unwrap_or_else(|| {
        let context = install_context(state.inventory().pkg_manager, DetectionDepth::Full);
        filter_available_actions(install_actions::get_install_actions(&context, &t))
    });
    // Una comprobación posterior puede haber sacado la acción de la lista
    // guardada (por ejemplo, la sonda ya da PSReadLine por instalado) aunque
    // la tarjeta siga mostrando su botón. Si sigue en el catálogo, se ejecuta
    // lo que el usuario pidió en vez de responder que «ya no existe».
    let Some(action) = actions
        .into_iter()
        .find(|action| action.id == action_id)
        .or_else(|| {
            let context = install_context(state.inventory().pkg_manager, DetectionDepth::Catalog);
            install_actions::get_install_actions(&context, &t)
                .into_iter()
                .find(|action| action.id == action_id)
        })
    else {
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
    // La lista que autorizó esta acción ya no representa el estado del
    // sistema. Al volver a abrir el panel se reconstruirá y podrá ocultar una
    // instalación que acaba de terminar, en vez de servir la copia cacheada.
    state.forget_install_actions();

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
        if check.is_none() && requires.is_some() {
            action.verb = Some("Actualizar".to_string());
        }
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
    fn una_instalacion_de_framework_se_ofrece_aunque_falte_su_runtime() {
        // Los frameworks se instalan encima de Lua, Python, Node, etc. Si el
        // runtime falta, la instalación debe seguir visible para que el
        // usuario pueda preparar la dependencia desde el propio catálogo.
        let mut install = accion("framework-busted", None, Some("runtime-ausente"));
        install.verb = None;
        install.check_cmd = Some("ecosystem:luarocks|luarocks|busted".to_string());
        let mut update = accion("framework-busted-update", None, Some("runtime-ausente"));
        update.verb = Some("Actualizar".to_string());

        let actions = filter_available_actions(vec![install, update]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "framework-busted");
        assert_eq!(actions[0].installed, Some(false));
        assert_eq!(actions[0].detection_status, None);
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
    fn winget_consulta_los_origenes_solo_si_falla_el_listado_global() {
        let mut calls = Vec::new();
        let lists = query_winget_lists(|extra, _| {
            calls.push(extra.join(" "));
            Some("Git.Git".to_string())
        });
        assert_eq!(calls, vec![String::new()]);
        assert!(lists.complete());

        let mut calls = Vec::new();
        let lists = query_winget_lists(|extra, _| {
            calls.push(extra.join(" "));
            (!extra.is_empty()).then(|| "Git.Git".to_string())
        });
        assert_eq!(calls, vec!["", "--source winget", "--source msstore"]);
        assert!(lists.complete());

        // Con un solo origen la lista no cubre la Store: no es completa.
        let lists = query_winget_lists(|extra, _| {
            (extra == ["--source", "winget"]).then(|| "Git.Git".to_string())
        });
        assert!(!lists.complete());
    }

    #[test]
    fn la_comprobacion_de_familia_reutiliza_las_listas_vigentes() {
        let cache = std::sync::Mutex::new(None);
        let start = std::time::Instant::now();
        let calls = std::cell::Cell::new(0);
        let list = |_: &[&str], _: std::time::Duration| {
            calls.set(calls.get() + 1);
            Some("Git.Git".to_string())
        };
        // La pasada completa consulta y deja la copia.
        winget_lists_for(false, &cache, 0, || start, list);
        assert_eq!(calls.get(), 1);
        // Una familia dentro del plazo reutiliza la copia.
        let reused = winget_lists_for(
            true,
            &cache,
            0,
            || start + std::time::Duration::from_secs(5),
            list,
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(reused.all.as_deref(), Some("Git.Git"));
        // Caducada, vuelve a consultar.
        winget_lists_for(
            true,
            &cache,
            0,
            || start + std::time::Duration::from_secs(61),
            list,
        );
        assert_eq!(calls.get(), 2);
        // Tras instalar o repetir la detección (otra generación), también.
        winget_lists_for(
            true,
            &cache,
            1,
            || start + std::time::Duration::from_secs(62),
            list,
        );
        assert_eq!(calls.get(), 3);
        // La pasada completa nunca reutiliza.
        winget_lists_for(
            false,
            &cache,
            1,
            || start + std::time::Duration::from_secs(63),
            list,
        );
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn el_inventario_de_ecosistemas_solo_reutiliza_respuestas_validas_y_vigentes() {
        use crate::process::ProbeOutput;
        let cache = std::sync::Mutex::new(None);
        let inventory: HashMap<String, ProbeOutput> = [
            (
                "pip|python".to_string(),
                ProbeOutput::Success("Django==5.0".to_string()),
            ),
            ("gem|gem".to_string(), ProbeOutput::TimedOut),
            ("npm|node".to_string(), ProbeOutput::Failed),
            ("__program|php".to_string(), ProbeOutput::NotFound),
            (
                "__program|python".to_string(),
                ProbeOutput::Success(String::new()),
            ),
            // Un módulo ausente (error) es una respuesta; su timeout, no.
            ("module|python|pip".to_string(), ProbeOutput::Failed),
            ("module|python|venv".to_string(), ProbeOutput::TimedOut),
        ]
        .into_iter()
        .collect();
        // La pasada completa guarda lo válido; un timeout o un error, no.
        remember_ecosystem_entries(&cache, 0, &inventory, false);
        let now = std::time::Instant::now();
        let reused = reusable_ecosystem_entries(&cache, 0, now);
        assert!(reused.contains_key("pip|python"));
        assert!(reused.contains_key("__program|php"));
        assert!(reused.contains_key("__program|python"));
        assert!(!reused.contains_key("gem|gem"));
        assert!(!reused.contains_key("npm|node"));
        assert!(reused.contains_key("module|python|pip"));
        assert!(!reused.contains_key("module|python|venv"));
        // Otra generación (instalación o «Repetir detección») o el plazo
        // vencido la invalidan.
        assert!(reusable_ecosystem_entries(&cache, 1, now).is_empty());
        assert!(
            reusable_ecosystem_entries(&cache, 0, now + std::time::Duration::from_secs(61))
                .is_empty()
        );
        // Una comprobación de familia amplía la copia vigente sin borrarla.
        let gem: HashMap<String, ProbeOutput> = [(
            "gem|gem".to_string(),
            ProbeOutput::Success("rails".to_string()),
        )]
        .into_iter()
        .collect();
        remember_ecosystem_entries(&cache, 0, &gem, true);
        let reused = reusable_ecosystem_entries(&cache, 0, std::time::Instant::now());
        assert!(reused.contains_key("pip|python") && reused.contains_key("gem|gem"));
    }

    #[test]
    fn un_modulo_de_un_runtime_ausente_no_lanza_su_sonda() {
        let action = accion(
            "framework-prueba",
            None,
            Some("module:programa-que-no-existe-en-ningun-sistema:pip"),
        );
        let mut inventory = HashMap::new();
        prefetch_ecosystem_inventory(std::slice::from_ref(&action), &mut inventory, true);
        assert_eq!(
            inventory.get("__program|programa-que-no-existe-en-ningun-sistema"),
            Some(&crate::process::ProbeOutput::NotFound)
        );
        assert!(!inventory.contains_key(&module_inventory_key(
            "programa-que-no-existe-en-ningun-sistema",
            "pip"
        )));
        assert_eq!(
            detection_source(&action),
            "module:programa-que-no-existe-en-ningun-sistema.pip"
        );
    }

    #[test]
    fn el_origen_de_diagnostico_incluye_la_sonda_de_requisito() {
        let action = accion(
            "framework-django-update",
            Some("ecosystem:pip|python|django"),
            Some("module:python:pip"),
        );
        assert_eq!(
            detection_source(&action),
            "ecosystem:pip + module:python.pip"
        );
    }

    #[test]
    fn unas_listas_incompletas_no_se_guardan_para_reutilizar() {
        let cache = std::sync::Mutex::new(None);
        let start = std::time::Instant::now();
        let calls = std::cell::Cell::new(0);
        let failing = |_: &[&str], _: std::time::Duration| {
            calls.set(calls.get() + 1);
            None
        };
        let lists = winget_lists_for(false, &cache, 0, || start, failing);
        assert!(!lists.complete());
        assert_eq!(calls.get(), 3);
        winget_lists_for(true, &cache, 0, || start, failing);
        assert_eq!(
            calls.get(),
            6,
            "sin copia completa, la familia vuelve a consultar"
        );
    }

    #[test]
    fn winget_reconoce_el_id_en_cualquier_columna_y_no_un_prefijo() {
        let output = "Name                 Id                 Version\nVLC media player       VideoLAN.VLC       3.0.23\n";
        assert!(inventory_has_package_id(output, "videolan.vlc"));
        assert!(!inventory_has_package_id(output, "VideoLAN.VLC.Extra"));
    }

    #[test]
    fn winget_normaliza_ansi_comillas_y_retorno_de_carro() {
        let output = "Name  Id\n\u{1b}[32mOpenVPN\u{1b}[0m  \"OpenVPNTechnologies.OpenVPN\"\r\n";
        assert!(inventory_has_package_id(
            output,
            "openvpntechnologies.openvpn"
        ));
    }

    #[test]
    fn inventario_masivo_de_winget_marca_instaladas_sin_confundir_nombres() {
        let expected = HashMap::from([
            ("videolan.vlc".to_string(), ()),
            ("docker.dockerdesktop".to_string(), ()),
            ("videolan.vlc.extra".to_string(), ()),
        ]);
        let mut inventory = HashMap::new();
        merge_winget_inventory(
            "Name                 Id                    Version\nVLC media player       VideoLAN.VLC            3.0.23\nDocker Desktop         Docker.DockerDesktop     4.91.0\n",
            &expected,
            &mut inventory,
        );
        assert_eq!(inventory.get("videolan.vlc"), Some(&true));
        assert_eq!(inventory.get("docker.dockerdesktop"), Some(&true));
        assert_eq!(inventory.get("videolan.vlc.extra"), Some(&false));
    }

    #[test]
    fn npm_acepta_la_raiz_global_y_conserva_compatibilidad_json() {
        assert!(npm_global_root_has_packages(
            "{\"dependencies\":{\"vite\":{},\"@scope/tool\":{}}}",
            "vite @scope/tool"
        ));
        assert!(!npm_global_root_has_packages(
            "{\"dependencies\":{\"vite\":{}}}",
            "vite ausente"
        ));
    }

    #[test]
    fn un_runtime_ausente_no_relanza_sondas_de_todas_las_familias() {
        let mut inventory = HashMap::from([(
            "__program|runtime-que-no-existe-en-lterminal".to_string(),
            crate::process::ProbeOutput::NotFound,
        )]);
        assert_eq!(
            ecosystem_capability_installed(
                "pip|runtime-que-no-existe-en-lterminal|django",
                &mut inventory,
            ),
            DetectionState::Missing
        );
    }

    #[test]
    fn un_paquete_confirmado_por_winget_no_vuelve_a_ofrecer_instalarse() {
        let mut inventory = WingetInventory {
            packages: HashMap::from([(String::from("videolan.vlc"), true)]),
            complete: true,
            ..WingetInventory::default()
        };
        assert_eq!(
            winget_capability_installed("VideoLAN.VLC|__package__", &mut inventory),
            DetectionState::Installed
        );
    }

    #[test]
    fn choco_reconoce_el_formato_de_salida_del_inventario_local() {
        let output = "7zip.7zip|24.09\nSumatraPDF.SumatraPDF|3.5.2\n";
        assert!(inventory_has_package_id(output, "7ZIP.7ZIP"));
        assert!(inventory_has_package_id(output, "sumatrapdf.sumatrapdf"));
        assert!(!inventory_has_package_id(output, "7zip.7zip.portable"));
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

    #[cfg(windows)]
    #[test]
    fn un_timeout_no_se_presenta_como_instalacion_pendiente() {
        let actions = filter_available_actions(vec![accion(
            "sonda-lenta",
            Some("powershell:Start-Sleep -Seconds 8"),
            None,
        )]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].installed, None);
        assert_eq!(actions[0].detection_status, Some(DetectionStatus::Unknown));
    }

    #[cfg(windows)]
    #[test]
    fn detecta_un_paquete_chocolatey_portable_sin_shim_global() {
        let package = std::path::Path::new(r"C:\ProgramData\chocolatey\lib\elixir");
        if !package.is_dir() {
            return;
        }
        assert_eq!(
            chocolatey_capability_installed("elixir|elixir"),
            DetectionState::Installed
        );
        assert!(crate::path_env::which("elixir").is_some());
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
    fn el_catalogo_navegable_no_sondea_hasta_abrir_la_herramienta() {
        let actions = filter_available_actions_with_depth(
            vec![accion(
                "python3-lazy",
                Some("powershell:throw 'la sonda no debe ejecutarse al pintar el menú'"),
                None,
            )],
            DetectionDepth::Catalog,
        );
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].installed, None);
        assert_eq!(actions[0].detection_status, Some(DetectionStatus::Unknown));
    }

    #[test]
    fn el_catalogo_marca_instalable_un_framework_cuyo_runtime_no_esta_en_path() {
        let mut install = accion(
            "framework-runtime-ausente",
            Some("ecosystem:fake-manager|fake-manager|package"),
            Some("runtime-que-no-existe-en-el-path"),
        );
        install.verb = None;
        let actions = filter_available_actions_with_depth(vec![install], DetectionDepth::Catalog);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].installed, Some(false));
        assert_eq!(actions[0].detection_status, None);
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

    #[test]
    fn comprobar_accion_suelta_no_arrastra_otras_acciones_sin_subgrupo() {
        let anchor = InstallAction::new("tool-a", "Herramienta A", "a --version");
        let other = InstallAction::new("tool-b", "Herramienta B", "b --version");
        assert!(belongs_to_install_family(&anchor, &anchor));
        assert!(!belongs_to_install_family(&anchor, &other));
    }

    #[test]
    fn comprobar_familia_conserva_solo_el_mismo_ecosistema() {
        let mut anchor = InstallAction::new("python-install", "Instalar Python", "python");
        anchor.subgroup = Some("Python".to_string());
        let mut sibling = InstallAction::new("python-update", "Actualizar Python", "python");
        sibling.subgroup = Some("Python".to_string());
        let mut other = InstallAction::new("node-install", "Instalar Node", "node");
        other.subgroup = Some("Node.js".to_string());
        assert!(belongs_to_install_family(&anchor, &sibling));
        assert!(!belongs_to_install_family(&anchor, &other));
    }

    #[test]
    fn la_cache_de_una_familia_ausente_no_muestra_actualizar_ni_desinstalar() {
        let mut install = InstallAction::new("adb-install", "Instalar ADB", "install");
        install.group = "Android · ADB".to_string();
        install.subgroup = Some("ADB · Android Platform Tools".to_string());
        let mut update = InstallAction::new("adb-update", "Actualizar ADB", "update");
        update.group = install.group.clone();
        update.subgroup = install.subgroup.clone();
        update.verb = Some("Actualizar".to_string());
        let result = overlay_cached_statuses_with_cache(
            InstallList {
                actions: vec![install, update],
                complete: true,
            },
            vec![CachedInstallStatus {
                id: "adb-install".to_string(),
                installed: Some(false),
            }],
        );
        assert_eq!(result.actions.len(), 1);
        assert_eq!(result.actions[0].id, "adb-install");
        assert_eq!(result.actions[0].installed, Some(false));
    }

    #[test]
    fn una_cache_mezclada_no_activa_el_ciclo_si_la_instalacion_sigue_desconocida() {
        let mut install = InstallAction::new("adb-install", "Instalar ADB", "install");
        install.group = "Android · ADB".to_string();
        install.subgroup = Some("ADB · Android Platform Tools".to_string());
        let mut update = InstallAction::new("adb-update", "Actualizar ADB", "update");
        update.group = install.group.clone();
        update.subgroup = install.subgroup.clone();
        update.verb = Some("Actualizar".to_string());
        let result = overlay_cached_statuses_with_cache(
            InstallList {
                actions: vec![install, update],
                complete: true,
            },
            vec![CachedInstallStatus {
                id: "adb-update".to_string(),
                installed: Some(true),
            }],
        );
        assert_eq!(result.actions.len(), 2);
        assert!(result
            .actions
            .iter()
            .all(|action| action.installed.is_none()
                && action.detection_status == Some(DetectionStatus::Unknown)));
    }
}
