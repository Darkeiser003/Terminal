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
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::environments::{Environment, ShellKind, Transport};
use crate::i18n::Translator;
use crate::install_actions::{self, InstallAction, InstallContext};
use crate::state::AppState;

/// Arch no empaqueta PowerShell: está en el AUR, al que se llega con un
/// asistente externo. Cuál hay instalado decide qué acciones tienen sentido
/// ofrecer (ver `power_shell_actions` en `install_actions`).
fn detect_aur_helper() -> Option<String> {
    if std::env::consts::OS != "linux" {
        return None;
    }
    ["paru", "yay"]
        .into_iter()
        .find(|helper| crate::path_env::is_tool_installed(helper))
        .map(str::to_string)
}

/// Contexto del sistema que necesita el catálogo para no ofrecer nada
/// imposible. Se calcula igual desde `install_list` y desde `install_run`, para
/// que la acción que se ejecuta sea exactamente la que se mostró.
fn install_context(pkg_manager: Option<String>) -> InstallContext {
    let platform = std::env::consts::OS.to_string();
    InstallContext {
        wsl: (platform == "windows")
            .then(|| crate::wsl_env::get_wsl_context(crate::wsl_env::ContextOptions::default())),
        has_snap: platform == "linux" && crate::path_env::is_tool_installed("snap"),
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
    let mut installed = |cmd: &str| -> bool {
        *checked
            .entry(cmd.to_string())
            .or_insert_with(|| crate::path_env::is_tool_installed(cmd))
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

/// Un dato del resumen de arriba del panel: qué puede tener este sistema y qué
/// tiene de verdad.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallList {
    pub actions: Vec<InstallAction>,
    pub components: Vec<Component>,
}

/// El resumen enseña lo que ESTE sistema puede tener. WSL solo existe en
/// Windows: en Linux y macOS ocupa su sitio la compatibilidad en sentido
/// contrario (Wine para cmd.exe, PowerShell).
fn compatibility_component(wsl: Option<&crate::wsl_env::WslContext>, t: &Translator) -> Component {
    let no_instalado = t.t("deps.summaryNone", "No instalado");
    if cfg!(windows) {
        let available = wsl.map(|context| context.available).unwrap_or(false);
        let count = if available {
            wsl.map(|context| context.installed.len()).unwrap_or(0)
        } else {
            0
        };
        return Component {
            label: t.t("deps.summaryWsl", "WSL"),
            value: if available {
                let (key, fallback) = if count == 1 {
                    ("deps.summaryWslCount", "{count} distro")
                } else {
                    ("deps.summaryWslCountPlural", "{count} distros")
                };
                t.tp(key, &[("count", count.to_string())], fallback)
            } else {
                no_instalado
            },
        };
    }
    let present: Vec<&str> = [
        crate::path_env::is_tool_installed("wine").then_some("cmd (Wine)"),
        crate::path_env::is_tool_installed("pwsh").then_some("PowerShell"),
    ]
    .into_iter()
    .flatten()
    .collect();
    Component {
        label: t.t("deps.summaryCompat", "Compatibilidad Windows"),
        value: if present.is_empty() {
            t.t("deps.summaryCompatNone", "No instalada")
        } else {
            present.join(" + ")
        },
    }
}

fn summary_components(
    inventory: &crate::environments::Inventory,
    wsl: Option<&crate::wsl_env::WslContext>,
    projects_folder: &str,
    t: &Translator,
) -> Vec<Component> {
    let no_instalado = t.t("deps.summaryNone", "No instalado");

    let docker = if !inventory.docker_installed {
        no_instalado.clone()
    } else if !inventory.docker_daemon_ready {
        t.t("deps.summaryDockerStopped", "Instalado, detenido")
    } else if inventory.docker_container_count == 0 {
        t.t("deps.summaryDockerReady", "Listo")
    } else {
        let (key, fallback) = if inventory.docker_container_count == 1 {
            ("deps.summaryDockerReadyCount", "Listo ({count} activo)")
        } else {
            ("deps.summaryDockerReadyCount", "Listo ({count} activos)")
        };
        t.tp(
            key,
            &[("count", inventory.docker_container_count.to_string())],
            fallback,
        )
    };

    let android = if inventory.android_installed {
        let count = inventory.android_device_count;
        let (key, fallback) = if count == 1 {
            ("deps.summaryAdbCount", "{count} dispositivo")
        } else {
            ("deps.summaryAdbCountPlural", "{count} dispositivos")
        };
        t.tp(key, &[("count", count.to_string())], fallback)
    } else {
        no_instalado.clone()
    };

    // Con repositorios ya clonados, el resumen dice cuántos hay, igual que
    // Docker dice cuántos contenedores están en marcha.
    let git = if !crate::path_env::is_tool_installed("git") {
        no_instalado
    } else {
        let repos = crate::github::count_local_repositories(projects_folder);
        if repos == 0 {
            t.t("deps.summaryGitReady", "Listo")
        } else {
            let (key, fallback) = if repos == 1 {
                ("deps.summaryGitRepos", "Listo ({count} repo)")
            } else {
                ("deps.summaryGitReposPlural", "Listo ({count} repos)")
            };
            t.tp(key, &[("count", repos.to_string())], fallback)
        }
    };

    let languages = if inventory.language_count == 0 {
        t.t("deps.summaryLanguagesNone", "Ninguno")
    } else {
        t.tp(
            "deps.summaryLanguagesCount",
            &[("count", inventory.language_count.to_string())],
            "{count} REPL",
        )
    };

    let shells = inventory
        .envs
        .iter()
        .filter(|env| env.group == crate::environments::SYSTEM_SHELLS_GROUP)
        .count();

    let mut componentes = vec![
        Component {
            label: t.t("deps.summaryShells", "Shells"),
            value: shells.to_string(),
        },
        compatibility_component(wsl, t),
        Component {
            label: t.t("deps.summaryDocker", "Docker"),
            value: docker,
        },
        Component {
            label: t.t("deps.summaryAdb", "ADB"),
            value: android,
        },
        Component {
            label: t.t("deps.summaryGit", "Git"),
            value: git,
        },
        Component {
            label: t.t("deps.summaryLanguages", "Lenguajes"),
            value: languages,
        },
    ];

    // WSL2 y Docker Desktop no arrancan sin virtualización. Decirlo aquí evita
    // que alguien instale Docker entero para descubrir después que su Windows
    // no puede ejecutarlo. Solo se añade cuando se sabe algo: un "no se sabe"
    // en el resumen no ayuda a nadie.
    if cfg!(windows) {
        let virt = crate::virtualization::detect();
        let valor = if virt.is_ready() {
            Some(t.t("deps.summaryVirtReady", "Disponible"))
        } else if virt.needs_firmware_enabled() {
            Some(t.t("deps.summaryVirtBios", "Desactivada en la BIOS"))
        } else if virt.needs_platform_enabled() {
            Some(t.t("deps.summaryVirtOff", "Desactivada en Windows"))
        } else {
            None
        };
        if let Some(valor) = valor {
            componentes.push(Component {
                label: t.t("deps.summaryVirt", "Virtualización"),
                value: valor,
            });
        }
    }
    componentes
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
    let components = summary_components(
        &inventory,
        context.wsl.as_ref(),
        &context.projects_folder,
        &t,
    );
    InstallList {
        actions,
        components,
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
    crate::console_ui::Notice::new(verb, subject, command).note(action.hint.clone())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_actions::InstallAction;

    fn accion(id: &str, check: Option<&str>, requires: Option<&str>) -> InstallAction {
        let mut action = InstallAction::new(id, "Etiqueta", "comando");
        action.check_cmd = check.map(str::to_string);
        action.requires_cmd = requires.map(str::to_string);
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
}
