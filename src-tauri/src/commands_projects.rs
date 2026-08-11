//! Los comandos del panel de Proyectos y repositorios de GitHub.
//!
//! Port de los canales `projects:*` de `electron/main.js`. La lógica (la API,
//! el catálogo, los comandos de git y de descompresión) está en `github`; aquí
//! está lo que hace falta para atenderlos desde el frontend.
//!
//! Regla que atraviesa el módulo, igual que en los otros paneles: el frontend
//! nunca manda un repositorio ni una URL que el backend no le haya dado antes.
//! Una consulta se hace sobre un repositorio que esta sesión ya ha visto, y una
//! descarga solo acepta adjuntos de la release que se acaba de enseñar. Sin
//! esto, una inyección en el frontend podría hacer que la app descargara una
//! URL cualquiera.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands_panels::ActionResult;
use crate::environments::{Environment, Transport};
use crate::github::{self, Profile, RateLimit, Release, Repository};
use crate::i18n::Translator;
use crate::state::AppState;

/// Tope de lo que se descarga de una release. Medio giga es más que cualquier
/// adjunto razonable y evita llenar el disco por accidente.
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;

/// Cuántos saltos se siguen en una descarga. GitHub redirige a su CDN de
/// adjuntos; más de un par de saltos no es un flujo normal.
const MAX_REDIRECTS: usize = 5;

fn translator() -> Translator {
    Translator::new(&crate::i18n::active_language())
}

/// El catálogo de fábrica junto con lo que el usuario haya anclado.
fn project_pins() -> github::Catalog {
    github::merge_pins(
        &github::default_catalog(),
        &crate::settings::load_settings(),
    )
}

// ---- Estado del panel ----

/// Un repositorio tal y como lo ve el panel: lo que dice GitHub más lo que hay
/// en el disco de esta máquina.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRepository {
    #[serde(flatten)]
    pub repository: Repository,
    /// Está clonado.
    pub local: bool,
    /// La carpeta de destino existe pero no es un repositorio: clonar ahí
    /// fallaría, y el panel lo avisa en vez de ofrecer un comando condenado.
    pub local_conflict: bool,
    pub local_path: String,
    /// Pertenece al catálogo de fábrica.
    pub official: bool,
    /// Lo ha anclado el usuario (solo en el resultado de una búsqueda).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

fn public_repository(repository: Repository, projects_folder: &str) -> PublicRepository {
    let local = github::local_repository_state(projects_folder, &repository);
    PublicRepository {
        local: local
            .as_ref()
            .map(|state| state.repository_exists)
            .unwrap_or(false),
        local_conflict: local
            .as_ref()
            .map(|state| state.exists && !state.repository_exists)
            .unwrap_or(false),
        local_path: local
            .as_ref()
            .map(|state| state.local_path.clone())
            .unwrap_or_default(),
        official: false,
        pinned: None,
        repository,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub login: String,
    /// Del catálogo de fábrica.
    pub official: bool,
    /// Desarrollador de la aplicación.
    pub developer: bool,
    /// Creador de WinSlim y responsable de la dirección de proyectos.
    pub project_lead: bool,
    /// No se puede desanclar: viene fijo con el catálogo.
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsState {
    pub brand: String,
    pub projects_folder: String,
    pub owners: Vec<Owner>,
    pub repositories: Vec<PublicRepository>,
}

fn eq_ignore_case(list: &[String], value: &str) -> bool {
    list.iter().any(|item| item.eq_ignore_ascii_case(value))
}

fn projects_state(state: &AppState) -> ProjectsState {
    let pins = project_pins();
    let catalog = github::default_catalog();
    let projects_folder = github::projects_folder();

    let repositories: Vec<PublicRepository> = pins
        .repositories
        .iter()
        .filter_map(|full_name| github::repository_from_full_name(full_name))
        .map(|repository| {
            let official = eq_ignore_case(&catalog.repositories, &repository.full_name);
            PublicRepository {
                official,
                ..public_repository(repository, &projects_folder)
            }
        })
        .collect();
    state.remember_repositories(repositories.iter().map(|item| &item.repository));

    ProjectsState {
        // En Windows la marca es la del catálogo; fuera, la identidad de la app,
        // que es lo que el usuario reconoce ahí.
        brand: if cfg!(windows) {
            pins.brand.clone()
        } else {
            format!("{} · Proyectos", crate::identity::current().name)
        },
        projects_folder,
        owners: pins
            .owners
            .iter()
            .map(|login| Owner {
                official: eq_ignore_case(&catalog.owners, login),
                developer: eq_ignore_case(&catalog.developers, login),
                project_lead: eq_ignore_case(&catalog.project_leads, login),
                locked: eq_ignore_case(&catalog.fixed_profiles, login),
                login: login.clone(),
            })
            .collect(),
        repositories,
    }
}

/// `projects:state`
#[tauri::command(async)]
pub fn projects_state_get(state: State<'_, Arc<AppState>>) -> ProjectsState {
    projects_state(&state)
}

/// `projects:downloaded`: lo que ya está clonado en el disco.
///
/// Se descubre recorriendo la carpeta de proyectos, no la lista de anclados, y
/// sin consultar a GitHub: la sección funciona sin red. Cada uno entra en la
/// lista blanca de la sesión, que es lo que permite después actualizarlo o
/// entrar en él sin que el frontend mande una ruta suya.
#[tauri::command(async)]
pub fn projects_downloaded(state: State<'_, Arc<AppState>>) -> Vec<github::LocalRepository> {
    let clonados = github::list_local_repositories(&github::projects_folder());
    let conocidos: Vec<github::Repository> = clonados
        .iter()
        .filter_map(|local| github::repository_from_full_name(&local.full_name))
        .collect();
    state.remember_repositories(conocidos.iter());
    log_info!(
        "Repositorios descargados listados",
        serde_json::json!({ "total": clonados.len() })
    );
    clonados
}

/// `projects:cd`: lleva la terminal a la carpeta de un repositorio clonado.
///
/// Solo acepta repositorios de la lista blanca, igual que el resto del módulo, y
/// la ruta la reconstruye el backend a partir de la carpeta de proyectos: no se
/// escribe en la terminal una ruta que venga del frontend.
#[tauri::command(async)]
pub fn projects_cd(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    full_name: String,
) -> ActionResult {
    let Some(repository) = state.visible_repository(&full_name) else {
        return ActionResult::failed("El repositorio no pertenece a la vista actual.");
    };
    let Some(env) = state.tabs.environment_of(&tab_id) else {
        return ActionResult::failed("La pestaña activa ya no está disponible.");
    };
    if env.repl {
        return ActionResult::failed("La pestaña activa es un REPL, no una shell.");
    }
    let Some(local) = github::local_repository_state(&github::projects_folder(), &repository)
    else {
        return ActionResult::failed("No se pudo resolver la carpeta del repositorio.");
    };
    if !local.repository_exists {
        return ActionResult::failed("Ese repositorio ya no está clonado.");
    }
    let Some(command) = crate::scripts::build_cd_command(
        &local.local_path,
        env.kind,
        true,
        &crate::scripts::LaunchContext {
            transport: Some(env.transport),
            host_root: env.host_root.clone(),
            container_root: env.container_root.clone(),
            windows_host: None,
        },
    ) else {
        return ActionResult::failed("Este entorno no puede llegar a la carpeta de proyectos.");
    };
    log_info!(
        "cd a un repositorio descargado",
        serde_json::json!({ "tabId": tab_id, "repo": repository.full_name })
    );
    if !state.tabs.write_command(&tab_id, &command) {
        return ActionResult::failed("No se pudo escribir en la terminal.");
    }
    ActionResult {
        ok: true,
        command: Some(command),
        tab_id: Some(tab_id),
        ..Default::default()
    }
}

// ---- Consulta a la API ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    #[serde(flatten)]
    pub profile: Profile,
    pub pinned: bool,
    pub official: bool,
    pub developer: bool,
    pub project_lead: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<PublicProfile>,
    pub repositories: Vec<PublicRepository>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<RateLimit>,
}

fn github_client() -> github::GithubClient {
    github::GithubClient::new(crate::identity::current().user_agent)
}

/// `projects:lookup`
#[tauri::command(async)]
pub fn projects_lookup(state: State<'_, Arc<AppState>>, raw_target: String) -> LookupResult {
    let result = match github_client().lookup(&raw_target) {
        Ok(result) => result,
        Err(error) => {
            log_warn!(
                "Consulta GitHub fallida",
                serde_json::json!({ "error": error.message, "status": error.status })
            );
            return LookupResult {
                ok: false,
                error: Some(error.message),
                rate_limit: Some(error.rate_limit),
                ..Default::default()
            };
        }
    };

    let pins = project_pins();
    let catalog = github::default_catalog();
    let projects_folder = github::projects_folder();
    let repositories: Vec<PublicRepository> = result
        .repositories
        .into_iter()
        .map(|repository| {
            let full_name = repository.full_name.clone();
            PublicRepository {
                official: eq_ignore_case(&catalog.repositories, &full_name),
                pinned: Some(eq_ignore_case(&pins.repositories, &full_name)),
                ..public_repository(repository, &projects_folder)
            }
        })
        .collect();
    state.remember_repositories(repositories.iter().map(|item| &item.repository));

    log_info!(
        "Perfil/repositorio GitHub consultado",
        serde_json::json!({
            "target": result.target,
            "repositories": repositories.len(),
            "rateRemaining": result.rate_limit.remaining,
        })
    );
    LookupResult {
        ok: true,
        target: Some(result.target),
        profile: result.profile.map(|profile| PublicProfile {
            pinned: eq_ignore_case(&pins.owners, &profile.login),
            official: eq_ignore_case(&catalog.owners, &profile.login),
            developer: eq_ignore_case(&catalog.developers, &profile.login),
            project_lead: eq_ignore_case(&catalog.project_leads, &profile.login),
            locked: eq_ignore_case(&catalog.fixed_profiles, &profile.login),
            profile,
        }),
        repositories,
        rate_limit: Some(result.rate_limit),
        error: None,
    }
}

// ---- Releases ----

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// `None` con `ok: true` significa que el repositorio no tiene releases
    /// publicadas, que no es un error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<Release>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<RateLimit>,
}

/// `projects:release`
#[tauri::command(async)]
pub fn projects_release(state: State<'_, Arc<AppState>>, full_name: String) -> ReleaseResult {
    let t = translator();
    // Solo repositorios que esta sesión ha visto: el frontend no puede pedir
    // una consulta sobre un nombre cualquiera.
    let Some(repository) = state.visible_repository(&full_name) else {
        return ReleaseResult {
            ok: false,
            error: Some(t.t(
                "error.repoNotInView",
                "Ese repositorio no pertenece a la vista actual.",
            )),
            ..Default::default()
        };
    };

    match github_client().latest_release(&repository.full_name) {
        Ok((None, rate_limit)) => {
            log_info!(
                "Repositorio sin releases publicadas",
                serde_json::json!({ "repo": repository.full_name })
            );
            ReleaseResult {
                ok: true,
                rate_limit: Some(rate_limit),
                ..Default::default()
            }
        }
        Ok((Some(release), rate_limit)) => {
            log_info!(
                "Release consultada",
                serde_json::json!({
                    "repo": repository.full_name,
                    "tag": release.tag,
                    "assets": release.assets.len(),
                })
            );
            // Se recuerda la release entera: la descarga posterior solo acepta
            // adjuntos de la que se acaba de enseñar, nunca una URL del
            // frontend.
            state.remember_release(&repository.full_name, &release);
            ReleaseResult {
                ok: true,
                release: Some(release),
                rate_limit: Some(rate_limit),
                error: None,
            }
        }
        Err(error) => {
            log_warn!(
                "Consulta de release fallida",
                serde_json::json!({ "repo": repository.full_name, "error": error.message })
            );
            ReleaseResult {
                ok: false,
                error: Some(error.message),
                rate_limit: Some(error.rate_limit),
                ..Default::default()
            }
        }
    }
}

/// Las descargas viven aparte de los clones para no mezclar un árbol de git con
/// un ZIP desempaquetado. `_releases` no puede chocar con un propietario real:
/// un login de GitHub nunca empieza por guion bajo.
fn releases_folder_for(projects_folder: &str, repository: &Repository, tag: &str) -> PathBuf {
    let safe_tag: String = tag
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || ".-_".contains(c) {
                c
            } else {
                '-'
            }
        })
        .take(60)
        .collect();
    let safe_tag = if safe_tag.is_empty() {
        "latest".to_string()
    } else {
        safe_tag
    };
    PathBuf::from(projects_folder)
        .join("_releases")
        .join(&repository.owner)
        .join(&repository.name)
        .join(safe_tag)
}

/// Descarga un adjunto al disco. Los redirecciones se siguen a mano para poder
/// comprobar cada salto: uno fuera de los hosts de GitHub convertiría la
/// descarga en una petición a un sitio arbitrario, así que se corta ahí.
/// Igual que `download_asset`, con los textos en el idioma activo. La usa
/// también la actualización de la propia app, que no tiene un traductor a mano.
pub(crate) fn download_asset_to(url: &str, destination: &Path) -> Result<u64, String> {
    download_asset(url, destination, &translator())
}

fn download_asset(url: &str, destination: &Path, t: &Translator) -> Result<u64, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;

    let mut current = url.to_string();
    let mut response = None;
    for _ in 0..=MAX_REDIRECTS {
        if !github::is_allowed_asset_url(&current) {
            return Err(t.t(
                "release.badRedirect",
                "La descarga intentó salir de los servidores de GitHub.",
            ));
        }
        let attempt = client
            .get(&current)
            .send()
            .map_err(|error| error.to_string())?;
        if attempt.status().is_redirection() {
            let next = attempt
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
                .ok_or_else(|| {
                    t.t(
                        "release.badRedirect",
                        "La descarga intentó salir de los servidores de GitHub.",
                    )
                })?;
            current = next;
            continue;
        }
        response = Some(attempt);
        break;
    }
    let Some(mut response) = response else {
        return Err(t.t(
            "release.badRedirect",
            "La descarga intentó salir de los servidores de GitHub.",
        ));
    };
    if !response.status().is_success() {
        return Err(t.tp(
            "release.httpError",
            &[("status", response.status().as_u16().to_string())],
            "GitHub respondió con el estado {status} al descargar.",
        ));
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // Se escribe a trozos y con el tope por delante: un adjunto enorme se corta
    // antes de llenar el disco, no después de haberlo llenado.
    let mut file = std::fs::File::create(destination).map_err(|error| error.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes: u64 = 0;
    loop {
        let read = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                let message = error.to_string();
                drop(file);
                let _ = std::fs::remove_file(destination);
                return Err(message);
            }
        };
        bytes += read as u64;
        if bytes > MAX_ASSET_BYTES {
            drop(file);
            let _ = std::fs::remove_file(destination);
            return Err(t.t(
                "release.tooBig",
                "El archivo supera el tamaño máximo admitido.",
            ));
        }
        if let Err(error) = file.write_all(&buffer[..read]) {
            let message = error.to_string();
            drop(file);
            let _ = std::fs::remove_file(destination);
            return Err(message);
        }
    }
    Ok(bytes)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub bytes: u64,
    /// Se ha escrito el comando de desempaquetado en una terminal.
    pub extracted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub created: bool,
}

impl DownloadResult {
    fn failed(error: String) -> DownloadResult {
        DownloadResult {
            ok: false,
            error: Some(error),
            ..Default::default()
        }
    }
}

/// `projects:downloadRelease`
///
/// Descargar una release es la vía corta para quien solo quiere USAR la
/// herramienta: nada de clonar el repositorio ni compilarlo. La aplicación se
/// encarga de la descarga (es tráfico de red, no un comando) y deja el
/// desempaquetado en la terminal visible, como el resto de acciones que tocan
/// el disco del usuario.
#[tauri::command(async)]
pub fn projects_download_release(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    full_name: String,
    asset_name: String,
) -> DownloadResult {
    let t = translator();
    let Some((pending_name, release)) = state.pending_release() else {
        return DownloadResult::failed(t.t(
            "release.stale",
            "Vuelve a consultar la release antes de descargarla.",
        ));
    };
    if !pending_name.eq_ignore_ascii_case(&full_name) {
        return DownloadResult::failed(t.t(
            "release.stale",
            "Vuelve a consultar la release antes de descargarla.",
        ));
    }
    let Some(asset) = release
        .assets
        .iter()
        .find(|candidate| candidate.name == asset_name)
    else {
        return DownloadResult::failed(t.t(
            "release.assetGone",
            "Ese archivo ya no pertenece a la release mostrada.",
        ));
    };
    let Some(repository) = github::repository_from_full_name(&pending_name) else {
        return DownloadResult::failed(t.t(
            "error.repoNotInView",
            "Ese repositorio no pertenece a la vista actual.",
        ));
    };

    // La release de la PROPIA aplicación no es un proyecto que descargar a
    // Documentos: es la versión nueva de lo que está corriendo, y va donde la
    // app ya está instalada. Con esto no quedan dos copias — la instalada y
    // otra recién bajada en otra carpeta — sin saber cuál se ejecuta.
    let auto = crate::install_dir::is_self_repository(&pending_name);
    let folder = match auto.then(crate::install_dir::staging).flatten() {
        Some(staging) => staging,
        None => {
            if auto {
                // Una build de desarrollo: actualizarla sobrescribiría el árbol
                // de compilación con una release descargada.
                log_warn!(
                    "Actualización propia sobre una build de desarrollo: se descarga como un proyecto más"
                );
            }
            let projects_folder = github::projects_folder();
            releases_folder_for(&projects_folder, &repository, &release.tag)
        }
    };
    // Solo el nombre del archivo, nunca una ruta: el nombre viene de la API y
    // podría traer separadores.
    let file_name = Path::new(&asset.name)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "descarga".to_string());
    let destination = folder.join(&file_name);

    log_info!(
        "Descargando adjunto de release",
        serde_json::json!({
            "repo": pending_name, "tag": release.tag, "asset": asset.name,
            "destination": destination.to_string_lossy(),
        })
    );
    let bytes = match download_asset(&asset.download_url, &destination, &t) {
        Ok(bytes) => bytes,
        Err(error) => {
            log_warn!(
                "Descarga de release fallida",
                serde_json::json!({ "asset": asset.name, "error": error })
            );
            return DownloadResult::failed(error);
        }
    };
    log_info!(
        "Adjunto descargado",
        serde_json::json!({ "asset": asset.name, "bytes": bytes })
    );

    let path = destination.to_string_lossy().to_string();
    let downloaded = DownloadResult {
        ok: true,
        path: Some(path.clone()),
        bytes,
        ..Default::default()
    };
    // Lo que no es un archivo comprimido se queda donde está: no hay nada que
    // extraer.
    if asset.archive.is_none() {
        return downloaded;
    }
    let Some((target_tab, env, created)) =
        crate::commands_install::shell_tab(&app, &state, &tab_id)
    else {
        return downloaded;
    };
    let target = folder.join("extraido");
    if std::fs::create_dir_all(&target).is_err() {
        return downloaded;
    }
    let Some(plan) = github::build_extract_command(
        &path,
        &target.to_string_lossy(),
        env.kind,
        env.transport,
        &|tool| crate::path_env::which(tool).is_some(),
    ) else {
        return downloaded;
    };
    let command = plan.command;
    // Cuando falta el programa que abre ese formato se dice ANTES de ejecutar
    // nada. El comando se escribe igual: así se ve qué haría falta, y el fallo
    // lo canta su propio código de salida en vez de no pasar nada.
    let note = match plan.missing {
        Some(tool) => t.tp(
            "console.needsTool",
            &[
                ("tool", tool.to_string()),
                ("path", target.to_string_lossy().to_string()),
            ],
            "Hace falta «{tool}», que no está instalado. Destino: {path}",
        ),
        None => t.tp(
            "console.intoFolder",
            &[("path", target.to_string_lossy().to_string())],
            "Destino: {path}",
        ),
    };
    // El desempaquetado no lo hace la aplicación por dentro: se escribe en la
    // terminal para que el usuario vea qué se ejecuta sobre su disco.
    let notice =
        crate::console_ui::Notice::new(t.t("verb.extract", "Extraer"), &file_name, &command)
            .note(Some(note))
            .done(t.tp(
                "console.extracted",
                &[("name", file_name.clone())],
                "{name} · extraído",
            ));
    let command = crate::console_ui::decorate(&command, &notice, env.kind, false, &t);
    if !state.tabs.write_command(&target_tab, &command) {
        return downloaded;
    }
    DownloadResult {
        extracted: true,
        tab_id: Some(target_tab),
        created,
        ..downloaded
    }
}

// ---- Anclados y carpeta ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ProjectsState>,
}

fn pin_failed(error: &str) -> PinResult {
    PinResult {
        ok: false,
        error: Some(error.to_string()),
        state: None,
    }
}

fn string_list(settings: &serde_json::Map<String, Value>, key: &str) -> Vec<String> {
    settings
        .get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `projects:pin`
#[tauri::command(async)]
pub fn projects_pin(
    state: State<'_, Arc<AppState>>,
    kind: String,
    value: String,
    pinned: Option<bool>,
) -> PinResult {
    let pinned = pinned.unwrap_or(true);
    let settings = crate::settings::load_settings();
    let catalog = github::default_catalog();

    let (key, values) = match kind.as_str() {
        "owner" => {
            if !github::is_github_owner(&value) {
                return pin_failed("Perfil no válido.");
            }
            if !pinned && eq_ignore_case(&catalog.fixed_profiles, &value) {
                return pin_failed("Este perfil es un desarrollador fijo del catálogo.");
            }
            let mut values: Vec<String> = string_list(&settings, "githubPinnedOwners")
                .into_iter()
                .filter(|item| github::is_github_owner(item))
                .filter(|item| !item.eq_ignore_ascii_case(&value))
                .collect();
            if pinned {
                values.push(value);
            }
            ("githubPinnedOwners", values)
        }
        "repo" => {
            let Some(parsed) = github::parse_full_name(&value) else {
                return pin_failed("Repositorio no válido.");
            };
            if !pinned && eq_ignore_case(&catalog.repositories, &parsed.full_name) {
                return pin_failed("Este repositorio pertenece al catálogo fijo del proyecto.");
            }
            let mut values: Vec<String> = string_list(&settings, "githubPinnedRepos")
                .into_iter()
                .filter_map(|item| github::parse_full_name(&item).map(|repo| repo.full_name))
                .filter(|item| !item.eq_ignore_ascii_case(&parsed.full_name))
                .collect();
            if pinned {
                values.push(parsed.full_name);
            }
            ("githubPinnedRepos", values)
        }
        _ => return pin_failed("Tipo de anclado no válido."),
    };

    let mut patch = serde_json::Map::new();
    patch.insert(key.to_string(), serde_json::json!(values));
    crate::settings::save_settings(&patch);
    log_info!(
        "Anclado de proyectos actualizado",
        serde_json::json!({ "tipo": kind, "anclado": pinned, "total": values.len() })
    );
    PinResult {
        ok: true,
        error: None,
        state: Some(projects_state(&state)),
    }
}

/// `projects:chooseFolder`
#[tauri::command(async)]
pub fn projects_choose_folder(app: AppHandle, state: State<'_, Arc<AppState>>) -> ProjectsState {
    let current = github::projects_folder();
    let chosen = app
        .dialog()
        .file()
        .set_directory(&current)
        .blocking_pick_folder();
    if let Some(folder) = chosen.and_then(|path| path.into_path().ok()) {
        let mut patch = serde_json::Map::new();
        patch.insert(
            "projectsFolder".to_string(),
            serde_json::json!(folder.to_string_lossy()),
        );
        crate::settings::save_settings(&patch);
        log_info!("Carpeta de proyectos cambiada");
    }
    projects_state(&state)
}

/// `projects:openGithub`
///
/// Devuelve el mensaje de error, o una cadena vacía si se abrió bien. La URL la
/// construye el backend a partir de un objetivo ya validado: nunca se abre una
/// cadena que venga del frontend.
#[tauri::command(async)]
pub fn projects_open_github(raw_target: String) -> String {
    let Some(target) = github::parse_github_target(&raw_target) else {
        return "URL de GitHub no válida.".to_string();
    };
    let url = match target {
        github::Target::Repo(repo) => format!("https://github.com/{}", repo.full_name),
        github::Target::Owner(owner) => format!("https://github.com/{owner}"),
    };
    match tauri_plugin_opener::open_url(&url, None::<&str>) {
        Ok(()) => String::new(),
        Err(error) => error.to_string(),
    }
}

// ---- Clonar / actualizar ----

/// La shell con la que se ejecuta git. Un contenedor y un móvil no ven la
/// carpeta de proyectos del host, así que ahí no sirve la pestaña actual.
fn preferred_git_environment(state: &AppState, tab_id: &str) -> Option<Environment> {
    let host = |env: &Environment| !matches!(env.transport, Transport::Docker | Transport::Android);
    if let Some(env) = state.tabs.environment_of(tab_id) {
        if host(&env) && !env.repl {
            return Some(env);
        }
    }
    let envs = state.environments();
    for id in ["gitbash", "pwsh", "powershell", "cmd"] {
        if let Some(env) = envs.iter().find(|env| env.id == id && env.available) {
            return Some(env.clone());
        }
    }
    envs.into_iter()
        .find(|env| host(env) && env.available && !env.repl)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRunResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Qué herramienta habría que instalar para que esto funcionara.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<crate::command_not_found::ToolSuggestion>,
    /// `clone` o `pull`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub created: bool,
}

fn git_failed(error: &str) -> GitRunResult {
    GitRunResult {
        ok: false,
        error: Some(error.to_string()),
        ..Default::default()
    }
}

/// `projects:run`
#[tauri::command(async)]
pub fn projects_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    full_name: String,
) -> GitRunResult {
    let Some(repository) = state.visible_repository(&full_name) else {
        return git_failed("El repositorio no pertenece a la vista actual.");
    };
    let Some(env) = preferred_git_environment(&state, &tab_id) else {
        return git_failed("No hay una shell compatible disponible.");
    };
    // Dentro de WSL git es el de la distro, que la app no puede comprobar desde
    // aquí; fuera, si no está, el panel de dependencias lo instala.
    if env.transport != Transport::Wsl && !crate::path_env::is_tool_installed("git") {
        return GitRunResult {
            ok: false,
            error: Some(
                "Git no está instalado. Abre Entorno y dependencias para instalarlo.".to_string(),
            ),
            suggestion: Some(crate::command_not_found::ToolSuggestion {
                tool: "git".to_string(),
                label: "Git".to_string(),
                action_id: cfg!(windows).then(|| "winget-git".to_string()),
            }),
            ..Default::default()
        };
    }

    let projects_folder = github::projects_folder();
    let Some(plan) = github::build_git_command(&repository, &projects_folder, &env) else {
        return git_failed("Este entorno no puede trabajar con la carpeta de proyectos.");
    };
    if plan.state.exists && !plan.state.repository_exists {
        return git_failed(
            "La carpeta de destino ya existe pero no contiene un repositorio Git. Elige otra \
             carpeta o renómbrala.",
        );
    }
    // `git clone` no crea la carpeta del propietario, solo la del repositorio.
    if plan.state.action == "clone" {
        if let Some(parent) = Path::new(&plan.state.local_path).parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return git_failed("No se pudo preparar la carpeta de destino.");
            }
        }
    }

    let (target_tab, created) = match state.tabs.environment_of(&tab_id) {
        Some(current) if current.id == env.id => (tab_id, false),
        _ => match find_tab_for_environment(&state, &env) {
            Some(found) => (found, false),
            None => (state.tabs.create_tab(&app, &env, None).id, true),
        },
    };

    let t = translator();
    let (verb, done) = if plan.state.action == "clone" {
        ("verb.clone", "console.cloned")
    } else {
        ("verb.pull", "console.pulled")
    };
    let notice = crate::console_ui::Notice::new(
        t.t(
            verb,
            if plan.state.action == "clone" {
                "Clonar"
            } else {
                "Actualizar"
            },
        ),
        &repository.full_name,
        &plan.command,
    )
    .note(Some(t.tp(
        "console.intoFolder",
        &[("path", plan.state.local_path.clone())],
        "Destino: {path}",
    )))
    .done(t.tp(
        done,
        &[("repo", repository.full_name.clone())],
        if plan.state.action == "clone" {
            "{repo} · clonado"
        } else {
            "{repo} · actualizado"
        },
    ));
    let command = crate::console_ui::decorate(&plan.command, &notice, env.kind, false, &t);
    if !state.tabs.write_command(&target_tab, &command) {
        return git_failed("La terminal elegida terminó antes de poder enviar el comando Git.");
    }
    log_info!(
        "Accion GitHub enviada a la terminal",
        serde_json::json!({
            "repository": repository.full_name, "action": plan.state.action,
            "tabId": target_tab, "envId": env.id,
        })
    );
    GitRunResult {
        ok: true,
        action: Some(plan.state.action),
        local_path: Some(plan.state.local_path),
        tab_id: Some(target_tab),
        created,
        ..Default::default()
    }
}

/// Una pestaña ya abierta con este mismo entorno, para no acumular una por cada
/// acción del panel.
fn find_tab_for_environment(state: &AppState, env: &Environment) -> Option<String> {
    state
        .tabs
        .list()
        .tabs
        .into_iter()
        .find(|summary| {
            state
                .tabs
                .environment_of(&summary.id)
                .is_some_and(|found| found.id == env.id)
        })
        .map(|summary| summary.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_catalogo_de_fabrica_va_dentro_del_binario_y_se_lee_sin_disco() {
        let catalog = github::default_catalog();
        assert!(!catalog.brand.is_empty());
        assert!(!catalog.developers.is_empty());
        assert!(!catalog.project_leads.is_empty());
    }

    #[test]
    fn la_release_de_la_propia_app_no_se_descarga_como_un_proyecto_mas() {
        // El repositorio de la app es el unico que no va a Documentos: su
        // release es la version nueva de lo que esta corriendo.
        let propio = github::default_catalog().self_repository.unwrap();
        assert!(crate::install_dir::is_self_repository(&propio));
        assert!(!crate::install_dir::is_self_repository(
            "Darkeiser003/OtraCosa"
        ));
    }

    #[test]
    fn una_etiqueta_de_release_con_caracteres_raros_no_se_sale_de_su_carpeta() {
        let repository = github::repository_from_full_name("owner/repo").unwrap();
        let folder = releases_folder_for("/proyectos", &repository, "../../etc/v1.0");
        // Los separadores se sustituyen, así que la etiqueta entera queda como
        // UN solo tramo del que no se puede salir: los puntos que sobreviven ya
        // no forman un componente ".." sino parte de un nombre de carpeta.
        assert_eq!(folder.file_name().unwrap(), "..-..-etc-v1.0");
        assert!(!folder.components().any(|parte| parte.as_os_str() == ".."));
        assert!(folder
            .to_string_lossy()
            .replace('\\', "/")
            .contains("/_releases/owner/repo/"));
    }

    #[test]
    fn una_etiqueta_vacia_cae_en_latest_en_vez_de_dejar_la_carpeta_sin_nombre() {
        let repository = github::repository_from_full_name("owner/repo").unwrap();
        let folder = releases_folder_for("/proyectos", &repository, "");
        assert!(folder.ends_with("latest"));
    }

    #[test]
    fn el_nombre_del_adjunto_se_reduce_a_su_ultimo_tramo() {
        // El nombre viene de la API: si trajera separadores, escribiría fuera
        // de la carpeta de la release.
        let name = Path::new("../../../evil.exe")
            .file_name()
            .map(|value| value.to_string_lossy().to_string());
        assert_eq!(name.as_deref(), Some("evil.exe"));
    }

    #[test]
    fn los_creditos_no_se_inyectan_como_proyectos_anclados() {
        let catalog = github::default_catalog();
        assert!(catalog.fixed_profiles.is_empty());
        assert!(catalog.repositories.is_empty());
        assert!(catalog.developers.iter().any(|p| p == "tiranosaurio73"));
        assert!(catalog.project_leads.iter().any(|p| p == "Christianlg97"));
    }
}
