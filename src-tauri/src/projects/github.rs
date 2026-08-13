//! Integración pública con GitHub para el panel «Proyectos».
//!
//! Port de `electron/main/githubProjects.js`.
//!
//! No guarda tokens ni ejecuta descargas ocultas: valida perfiles/URLs, reduce
//! la respuesta de la API a campos explícitos y construye un comando
//! `git clone`/`git pull` que se escribe en una terminal visible.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::environments::{Environment, ShellKind, Transport};
use crate::shell_paths::unix_path_for;

pub const GITHUB_ORIGIN: &str = "https://github.com";
const GITHUB_API_ORIGIN: &str = "https://api.github.com";
const MAX_API_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const API_CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 128;

// ---- Validación de nombres ----

pub fn is_github_owner(value: &str) -> bool {
    if value.is_empty() || value.len() > 39 {
        return false;
    }
    let bytes = value.as_bytes();
    // Ni empieza ni termina con guion, y solo alfanuméricos o guiones dentro.
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn is_github_repo_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullName {
    pub owner: String,
    pub name: String,
    pub full_name: String,
}

pub fn parse_full_name(value: &str) -> Option<FullName> {
    let trimmed = value.trim();
    let without_git = trimmed
        .strip_suffix(".git")
        .or_else(|| trimmed.strip_suffix(".GIT"))
        .unwrap_or(trimmed);
    let parts: Vec<&str> = without_git.split('/').collect();
    if parts.len() != 2 || !is_github_owner(parts[0]) || !is_github_repo_name(parts[1]) {
        return None;
    }
    Some(FullName {
        owner: parts[0].to_string(),
        name: parts[1].to_string(),
        full_name: format!("{}/{}", parts[0], parts[1]),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Owner(String),
    Repo(FullName),
}

/// Acepta un login, `owner/repo` o una URL web normal. Se rechazan SSH,
/// `git://`, hosts alternativos, credenciales, puertos y segmentos adicionales.
pub fn parse_github_target(raw: &str) -> Option<Target> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 300 {
        return None;
    }
    if is_github_owner(value) {
        return Some(Target::Owner(value.to_string()));
    }
    if let Some(full) = parse_full_name(value) {
        return Some(Target::Repo(full));
    }

    // Solo https://github.com, sin puerto ni credenciales.
    let rest = value.strip_prefix("https://")?;
    let (host, path) = match rest.split_once('/') {
        Some((host, path)) => (host, path),
        None => (rest, ""),
    };
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    // Un `@` indica credenciales, un `:` un puerto.
    if host.contains('@') || host.contains(':') {
        return None;
    }
    let segments: Vec<&str> = path
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    match segments.len() {
        1 if is_github_owner(segments[0]) => Some(Target::Owner(segments[0].to_string())),
        2 => parse_full_name(&format!("{}/{}", segments[0], segments[1])).map(Target::Repo),
        _ => None,
    }
}

fn safe_text(value: Option<&str>, max_length: usize) -> String {
    value
        .unwrap_or("")
        .chars()
        .take(max_length)
        .collect::<String>()
}

// ---- Datos reducidos que viajan al frontend ----

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub login: String,
    pub name: String,
    pub bio: String,
    /// `User` u `Organization`: decide qué ruta de la API lista sus repos.
    #[serde(rename = "type")]
    pub kind: String,
    pub public_repos: u64,
    pub followers: u64,
    pub html_url: String,
}

pub fn sanitize_profile(raw: &Value) -> Option<Profile> {
    let login = raw.get("login")?.as_str()?;
    if !is_github_owner(login) {
        return None;
    }
    Some(Profile {
        login: login.to_string(),
        name: safe_text(raw.get("name").and_then(Value::as_str), 120),
        bio: safe_text(raw.get("bio").and_then(Value::as_str), 500),
        kind: if raw.get("type").and_then(Value::as_str) == Some("Organization") {
            "Organization".into()
        } else {
            "User".into()
        },
        public_repos: raw.get("public_repos").and_then(Value::as_u64).unwrap_or(0),
        followers: raw.get("followers").and_then(Value::as_u64).unwrap_or(0),
        html_url: format!("{GITHUB_ORIGIN}/{login}"),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub description: String,
    pub language: String,
    pub stars: u64,
    pub forks: u64,
    pub archived: bool,
    pub fork: bool,
    pub updated_at: String,
    pub html_url: String,
    pub clone_url: String,
}

pub fn sanitize_repository(raw: &Value) -> Option<Repository> {
    let owner = raw.get("owner")?.get("login")?.as_str()?;
    let name = raw.get("name")?.as_str()?;
    if !is_github_owner(owner) || !is_github_repo_name(name) {
        return None;
    }
    Some(Repository {
        owner: owner.to_string(),
        name: name.to_string(),
        full_name: format!("{owner}/{name}"),
        description: safe_text(raw.get("description").and_then(Value::as_str), 500),
        language: safe_text(raw.get("language").and_then(Value::as_str), 60),
        stars: raw
            .get("stargazers_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        forks: raw.get("forks_count").and_then(Value::as_u64).unwrap_or(0),
        archived: raw
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        fork: raw.get("fork").and_then(Value::as_bool).unwrap_or(false),
        updated_at: safe_text(raw.get("updated_at").and_then(Value::as_str), 40),
        html_url: format!("{GITHUB_ORIGIN}/{owner}/{name}"),
        clone_url: format!("{GITHUB_ORIGIN}/{owner}/{name}.git"),
    })
}

/// Un repositorio del catálogo, del que solo se conoce el nombre hasta que la
/// API responda.
pub fn repository_from_full_name(full_name: &str) -> Option<Repository> {
    let parsed = parse_full_name(full_name)?;
    Some(Repository {
        html_url: format!("{GITHUB_ORIGIN}/{}", parsed.full_name),
        clone_url: format!("{GITHUB_ORIGIN}/{}.git", parsed.full_name),
        owner: parsed.owner,
        name: parsed.name,
        full_name: parsed.full_name,
        description: String::new(),
        language: String::new(),
        stars: 0,
        forks: 0,
        archived: false,
        fork: false,
        updated_at: String::new(),
    })
}

// ---- Releases ----
//
// Un release es la forma en que la mayoría de proyectos publican algo
// ejecutable: quien solo quiere usar la herramienta no necesita clonarla ni
// compilarla. El panel enseña la última publicada y sus adjuntos.
//
// Los adjuntos NO se sirven desde api.github.com: la API devuelve una URL de
// descarga que apunta a otro host de GitHub. Se acepta una lista cerrada de
// hosts y solo https, para que un campo manipulado en la respuesta no pueda
// convertir la descarga en una petición a cualquier sitio.

#[rustfmt::skip]
const ASSET_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

pub fn is_allowed_asset_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    // Credenciales (`@`) y puerto (`:`) descartan la URL.
    if host.contains('@') || host.contains(':') {
        return false;
    }
    ASSET_HOSTS.contains(&host.to_lowercase().as_str())
}

/// Extensiones que sabemos desempaquetar. El resto (un `.exe`, un `.AppImage`,
/// un binario suelto) se descarga y se deja donde está: no hay nada que
/// extraer.
///
/// El `.tar.zst` se distingue del resto de la familia tar porque es el único
/// que el `tar` de Windows NO sabe abrir solo: bsdtar delega en el programa
/// `zstd`, y sin él falla con «Can't initialize filter». Los demás filtros
/// (gzip, bzip2, xz) sí los resuelve él.
///
/// Y un `.gz`/`.xz`/`.bz2`/`.zst` SUELTO —sin tar dentro— no es un tar: es un
/// único archivo comprimido, y `tar -xf` sobre él falla. Se trata aparte porque
/// es un adjunto de release de lo más normal (un binario comprimido).
pub fn archive_kind_for(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        return Some("tar.zst");
    }
    if lower.ends_with(".tar.gz")
        || lower.ends_with(".tar.bz2")
        || lower.ends_with(".tar.xz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tbz2")
        || lower.ends_with(".txz")
        || lower.ends_with(".tar")
    {
        return Some("tar");
    }
    if lower.ends_with(".zip") {
        return Some("zip");
    }
    if lower.ends_with(".7z") {
        return Some("7z");
    }
    if lower.ends_with(".rar") {
        return Some("rar");
    }
    if lower.ends_with(".gz") {
        return Some("gz");
    }
    if lower.ends_with(".xz") {
        return Some("xz");
    }
    if lower.ends_with(".bz2") {
        return Some("bz2");
    }
    if lower.ends_with(".zst") {
        return Some("zst");
    }
    None
}

const MAX_ASSETS: usize = 30;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub download_url: String,
    pub size: u64,
    pub downloads: u64,
    /// Con qué herramienta se desempaqueta, o `None` si no hay nada que
    /// extraer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<&'static str>,
}

pub fn sanitize_asset(raw: &Value) -> Option<Asset> {
    let name = safe_text(raw.get("name").and_then(Value::as_str), 200);
    let download_url = safe_text(raw.get("browser_download_url").and_then(Value::as_str), 500);
    // Un nombre de archivo con separadores o `..` no se escribe nunca en disco.
    if name.is_empty() || name.contains(['\\', '/']) || name == "." || name == ".." {
        return None;
    }
    if !is_allowed_asset_url(&download_url) {
        return None;
    }
    Some(Asset {
        archive: archive_kind_for(&name),
        name,
        download_url,
        size: raw.get("size").and_then(Value::as_u64).unwrap_or(0),
        downloads: raw
            .get("download_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag: String,
    pub name: String,
    pub published_at: String,
    pub html_url: String,
    pub prerelease: bool,
    /// El código fuente siempre está disponible aunque no haya adjuntos.
    pub source_zip: String,
    pub assets: Vec<Asset>,
}

pub fn sanitize_release(raw: &Value) -> Option<Release> {
    if !raw.is_object() {
        return None;
    }
    let tag = safe_text(raw.get("tag_name").and_then(Value::as_str), 100);
    let name = safe_text(raw.get("name").and_then(Value::as_str), 200);
    Some(Release {
        name: if name.is_empty() { tag.clone() } else { name },
        tag,
        published_at: safe_text(raw.get("published_at").and_then(Value::as_str), 40),
        html_url: safe_text(raw.get("html_url").and_then(Value::as_str), 500),
        prerelease: raw
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        source_zip: safe_text(raw.get("zipball_url").and_then(Value::as_str), 500),
        assets: raw
            .get("assets")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(sanitize_asset)
                    .take(MAX_ASSETS)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

// ---- Catálogo de anclados ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub brand: String,
    /// Perfiles anclados, fijos y del usuario juntos.
    pub owners: Vec<String>,
    /// Los que trae el catálogo de fábrica y no se pueden desanclar.
    pub fixed_profiles: Vec<String>,
    pub developers: Vec<String>,
    /// Responsables de la dirección del proyecto y de su creación.
    pub project_leads: Vec<String>,
    pub repositories: Vec<String>,
    /// El repositorio DE ESTA aplicación, si el catálogo lo declara.
    ///
    /// Va en el catálogo y no en el código porque es lo que cambia al construir
    /// la app para otro proyecto, igual que la marca y los créditos. Con él, la
    /// app reconoce su propia release entre todas las demás y la trata distinto:
    /// no es un proyecto que descargar a Documentos, es su propia actualización.
    pub self_repository: Option<String>,
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

fn string_list(source: &Value, key: &str) -> Vec<String> {
    source
        .get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// El catálogo puede traer un bloque por plataforma. Existe porque la
/// aplicación tiene DOS identidades (LTerminal en Windows, LTerminal en
/// Linux y macOS) y sus anclados de fábrica no tienen que coincidir.
///
/// Lo que no está en el bloque se hereda del catálogo base, así que un override
/// puede cambiar solo los perfiles anclados y dejar la marca y los repositorios
/// como estén.
fn catalog_for_platform(raw: &Value, platform: &str) -> Value {
    let Some(override_block) = raw
        .get("platformOverrides")
        .and_then(|value| value.get(platform))
        .filter(|value| value.is_object())
    else {
        return raw.clone();
    };
    let mut merged = raw.clone();
    if let (Some(target), Some(source)) = (merged.as_object_mut(), override_block.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
        target.remove("platformOverrides");
    }
    merged
}

pub fn normalize_catalog(raw: &Value, platform: &str) -> Catalog {
    let source = catalog_for_platform(raw, platform);
    let brand = safe_text(source.get("brand").and_then(Value::as_str), 100);
    Catalog {
        brand: if brand.is_empty() {
            "Darkeiser003".into()
        } else {
            brand
        },
        owners: unique(
            string_list(&source, "owners")
                .into_iter()
                .filter(|value| is_github_owner(value))
                .collect(),
        ),
        fixed_profiles: unique(
            string_list(&source, "fixedProfiles")
                .into_iter()
                .filter(|value| is_github_owner(value))
                .collect(),
        ),
        developers: unique(
            string_list(&source, "developers")
                .into_iter()
                .filter(|value| is_github_owner(value))
                .collect(),
        ),
        project_leads: unique(
            string_list(&source, "projectLeads")
                .into_iter()
                .filter(|value| is_github_owner(value))
                .collect(),
        ),
        repositories: unique(
            string_list(&source, "repositories")
                .into_iter()
                .filter_map(|value| parse_full_name(&value).map(|repo| repo.full_name))
                .collect(),
        ),
        self_repository: source
            .get("selfRepository")
            .and_then(Value::as_str)
            .and_then(parse_full_name)
            .map(|repo| repo.full_name),
    }
}

/// El catálogo de fábrica va empotrado en el binario, no como recurso del
/// paquete: son 30 líneas de JSON que no cambian sin recompilar, y un recurso
/// que se quede fuera del instalador dejaría el panel de Proyectos vacío sin
/// decir por qué. La versión Electron lo leía del disco porque allí el código
/// también era disco.
const PROJECT_CATALOG: &str = include_str!("../../config/project-catalog.json");

/// El catálogo de fábrica de ESTA plataforma.
pub fn default_catalog() -> Catalog {
    let raw = serde_json::from_str::<Value>(PROJECT_CATALOG).unwrap_or(Value::Null);
    // `platformOverrides` usa los nombres de Node, que es de donde viene el
    // archivo: `win32` y `darwin`, no `windows` y `macos`.
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    normalize_catalog(&raw, platform)
}

/// `platform` decide qué bloque de `platformOverrides` se aplica. Se pasa
/// explícitamente en vez de leer el sistema aquí para que las pruebas puedan
/// comprobar las dos identidades sin simular el sistema operativo.
pub fn load_catalog(catalog_path: &Path, platform: &str) -> Catalog {
    let raw = std::fs::read_to_string(catalog_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    normalize_catalog(&raw, platform)
}

/// Junta el catálogo de fábrica con lo que el usuario haya anclado.
pub fn merge_pins(catalog: &Catalog, settings: &serde_json::Map<String, Value>) -> Catalog {
    let pinned_owners = settings
        .get("githubPinnedOwners")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pinned_repos = settings
        .get("githubPinnedRepos")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Catalog {
        brand: catalog.brand.clone(),
        owners: unique(
            catalog
                .fixed_profiles
                .iter()
                .cloned()
                .chain(pinned_owners)
                .filter(|value| is_github_owner(value))
                .collect(),
        ),
        fixed_profiles: catalog.fixed_profiles.clone(),
        developers: catalog.developers.clone(),
        project_leads: catalog.project_leads.clone(),
        self_repository: catalog.self_repository.clone(),
        repositories: unique(
            catalog
                .repositories
                .iter()
                .cloned()
                .chain(pinned_repos)
                .filter_map(|value| parse_full_name(&value).map(|repo| repo.full_name))
                .collect(),
        ),
    }
}

// ---- Estado local y comandos ----

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    pub local_path: String,
    pub exists: bool,
    /// Hay un `.git` dentro: es un clon, no una carpeta con el mismo nombre.
    pub repository_exists: bool,
    /// `clone` o `pull`.
    pub action: &'static str,
}

pub fn local_repository_state(
    projects_folder: &str,
    repository: &Repository,
) -> Option<LocalState> {
    let root = PathBuf::from(projects_folder);
    let local_path = root.join(&repository.owner).join(&repository.name);
    // El nombre de propietario y de repositorio ya están validados, así que la
    // ruta no puede salirse; la comprobación se mantiene por si acaso.
    if !local_path.starts_with(&root) {
        return None;
    }
    let exists = local_path.exists();
    let repository_exists = exists && local_path.join(".git").exists();
    Some(LocalState {
        local_path: local_path.to_string_lossy().to_string(),
        exists,
        repository_exists,
        action: if repository_exists { "pull" } else { "clone" },
    })
}

/// Cuántos repositorios hay clonados de verdad bajo la carpeta de proyectos.
/// La estructura es `<carpeta>/<propietario>/<repositorio>`, así que se miran
/// dos niveles y solo cuenta lo que tiene un `.git` dentro: una carpeta suelta
/// con el nombre de un repositorio no es un repositorio.
///
/// Se recorre el disco, no la lista de anclados: lo interesante es lo que hay
/// descargado, incluido lo que se clonó y luego se desancló.
const MAX_SCANNED_OWNERS: usize = 200;

/// Dónde se clonan los proyectos: la carpeta que haya elegido el usuario o la
/// de fábrica, igual que `tabs::scripts_folder` con la de scripts.
pub fn projects_folder() -> String {
    crate::settings::string_setting(&crate::settings::load_settings(), "projectsFolder")
        .unwrap_or_else(|| {
            crate::paths::default_projects_dir()
                .to_string_lossy()
                .to_string()
        })
}

/// Un repositorio que YA está clonado en el disco.
///
/// Se descubre recorriendo la carpeta de proyectos, no la lista de anclados:
/// lo interesante es lo que hay descargado, incluido lo que se clonó y luego se
/// desancló. `full_name` se reconstruye de la propia estructura de carpetas
/// (`<carpeta>/<propietario>/<repositorio>`), así que no hace falta consultar a
/// GitHub para listarlos — la sección funciona sin red.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepository {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub path: String,
    /// Milisegundos desde la época de la última modificación, para poder poner
    /// arriba lo que se ha tocado hace poco.
    pub modified: u64,
}

/// Los repositorios clonados bajo la carpeta de proyectos, ordenados por lo más
/// recientemente tocado.
///
/// La estructura es `<carpeta>/<propietario>/<repositorio>` y solo cuenta lo
/// que tiene un `.git` dentro: una carpeta suelta con el nombre de un
/// repositorio no es un repositorio.
///
/// Los nombres que no son logins válidos de GitHub se descartan: la carpeta
/// `_releases` que crea la propia app cuelga del mismo sitio y no es un clon.
pub fn list_local_repositories(projects_folder: &str) -> Vec<LocalRepository> {
    if projects_folder.is_empty() {
        return Vec::new();
    }
    let Ok(owners) = std::fs::read_dir(projects_folder) else {
        return Vec::new();
    };
    let mut salida = Vec::new();
    for owner in owners
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .take(MAX_SCANNED_OWNERS)
    {
        let owner_name = owner.file_name().to_string_lossy().to_string();
        if !is_github_owner(&owner_name) {
            continue;
        }
        let Ok(repositories) = std::fs::read_dir(owner.path()) else {
            continue;
        };
        for repository in repositories.filter_map(Result::ok) {
            let path = repository.path();
            if !path.join(".git").exists() {
                continue;
            }
            let name = repository.file_name().to_string_lossy().to_string();
            if !is_github_repo_name(&name) {
                continue;
            }
            salida.push(LocalRepository {
                full_name: format!("{owner_name}/{name}"),
                owner: owner_name.clone(),
                path: path.to_string_lossy().to_string(),
                modified: modified_millis(&path),
                name,
            });
        }
    }
    // Lo tocado hace poco arriba: es donde está lo que se está usando. A igualdad
    // de fecha, alfabético, para que el orden no baile entre aperturas.
    salida.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.full_name.to_lowercase().cmp(&b.full_name.to_lowercase()))
    });
    salida
}

fn modified_millis(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn count_local_repositories(projects_folder: &str) -> usize {
    if projects_folder.is_empty() {
        return 0;
    }
    let Ok(owners) = std::fs::read_dir(projects_folder) else {
        // La carpeta puede no existir todavía: no es un error, es que aún no se
        // ha descargado nada.
        return 0;
    };
    owners
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .take(MAX_SCANNED_OWNERS)
        .map(|owner| {
            std::fs::read_dir(owner.path())
                .map(|repositories| {
                    repositories
                        .filter_map(Result::ok)
                        .filter(|repository| repository.path().join(".git").exists())
                        .count()
                })
                .unwrap_or(0)
        })
        .sum()
}

fn q_win(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn q_unix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_windows_shell(kind: ShellKind) -> bool {
    matches!(kind, ShellKind::Cmd | ShellKind::Powershell)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPlan {
    #[serde(flatten)]
    pub state: LocalState,
    pub command: String,
}

pub fn build_git_command(
    repository: &Repository,
    projects_folder: &str,
    env: &Environment,
) -> Option<GitPlan> {
    // Un contenedor y un móvil no ven la carpeta de proyectos del host.
    if matches!(env.transport, Transport::Docker | Transport::Android) {
        return None;
    }
    let state = local_repository_state(projects_folder, repository)?;
    let windows_shell = is_windows_shell(env.kind);
    let local_path = if windows_shell {
        state.local_path.clone()
    } else {
        unix_path_for(&state.local_path, env.transport)
    };
    let quote = if windows_shell { q_win } else { q_unix };
    let command = if state.repository_exists {
        format!("git -C {} pull --ff-only", quote(&local_path))
    } else {
        format!(
            "git clone -- {} {}",
            quote(&repository.clone_url),
            quote(&local_path)
        )
    };
    Some(GitPlan { state, command })
}

/// Comando para desempaquetar lo descargado. Se escribe en la terminal visible
/// como cualquier otra acción: el usuario ve qué se ejecuta sobre su disco.
///
/// No se usa una librería de descompresión dentro de la aplicación a propósito.
/// Las herramientas del sistema entienden los formatos reales que publica la
/// gente (tar.zst, 7z, rar), respetan permisos y enlaces, y dejan el comando a
/// la vista para poder repetirlo o cancelarlo.
/// Cómo desempaquetar un adjunto: el comando y, si hace falta algo que no está,
/// qué es.
///
/// El comando se devuelve SIEMPRE, incluso cuando falta la herramienta. Es a
/// propósito: así el usuario ve qué habría que ejecutar y el aviso le dice qué
/// instalar, en vez de que la acción desaparezca sin explicación. El fallo lo
/// canta el propio comando con su código de salida, como cualquier otro.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractPlan {
    pub command: String,
    /// Programa que hace falta y no se ha encontrado en el PATH.
    pub missing: Option<&'static str>,
}

/// Elige el primer candidato instalado. Devuelve también el primero de la lista
/// como respaldo, que es el canónico para ese formato: si no hay ninguno, es lo
/// que hay que instalar.
fn pick_tool<'a>(candidates: &[&'a str], installed: &dyn Fn(&str) -> bool) -> (&'a str, bool) {
    for tool in candidates {
        if installed(tool) {
            return (tool, true);
        }
    }
    (candidates[0], false)
}

pub fn build_extract_command(
    archive_path: &str,
    destination: &str,
    kind: ShellKind,
    transport: Transport,
    is_installed: &dyn Fn(&str) -> bool,
) -> Option<ExtractPlan> {
    let archive = archive_kind_for(archive_path)?;
    let windows_shell = is_windows_shell(kind);
    let (file, dir) = if windows_shell {
        (archive_path.to_string(), destination.to_string())
    } else {
        (
            unix_path_for(archive_path, transport),
            unix_path_for(destination, transport),
        )
    };
    let quote = if windows_shell { q_win } else { q_unix };

    // El PATH que se puede comprobar es el del HOST. Dentro de WSL, de un
    // contenedor o de un móvil el comando corre en otro sistema con otras
    // herramientas, así que ahí no se comprueba nada: se usa el candidato
    // canónico y que lo diga la propia shell si falta.
    let native = transport == Transport::Native;
    let probe = |tool: &str| !native || is_installed(tool);
    let choose = |candidates: &[&'static str]| -> (&'static str, Option<&'static str>) {
        if !native {
            return (candidates[0], None);
        }
        let (tool, found) = pick_tool(candidates, &is_installed);
        (tool, (!found).then_some(candidates[0]))
    };

    // Comandos por herramienta, ya con las rutas puestas.
    let con_tar = || format!("tar -xf {} -C {}", quote(&file), quote(&dir));
    let con_7z = |tool: &str| format!("{tool} x {} -o{} -y", quote(&file), quote(&dir));
    // unrar quiere el destino con separador final; sin él hay versiones que
    // tratan la ruta como un patrón de archivos y no extraen nada.
    let con_unrar = || {
        let separator = if windows_shell { '\\' } else { '/' };
        let destino = format!("{}{separator}", dir.trim_end_matches(separator));
        format!("unrar x -o+ {} {}", quote(&file), quote(&destino))
    };
    // Un archivo suelto comprimido: se descomprime CONSERVANDO el original
    // (`-k`) y dejando el resultado en la carpeta de destino, no al lado del
    // comprimido.
    let con_filtro = |tool: &str| {
        let salida = single_file_output(&file, windows_shell);
        format!(
            "{tool} -dc {} > {}",
            quote(&file),
            quote(&format!(
                "{}{}{salida}",
                dir.trim_end_matches(if windows_shell { '\\' } else { '/' }),
                if windows_shell { '\\' } else { '/' }
            ))
        )
    };

    let plan =
        |command: String, missing: Option<&'static str>| Some(ExtractPlan { command, missing });

    if windows_shell {
        return match archive {
            // bsdtar viene con Windows desde la build 17063 y resuelve él solo
            // gzip, bzip2 y xz. También abre los .zip, así que en cmd no hace
            // falta nada más.
            "tar" => plan(con_tar(), None),
            "zip" if kind == ShellKind::Cmd => plan(con_tar(), None),
            // Expand-Archive es parte de PowerShell: no puede faltar.
            "zip" => plan(
                format!(
                    "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
                    quote(&file),
                    quote(&dir)
                ),
                None,
            ),
            // El único de la familia tar que bsdtar delega a un programa
            // externo. Comprobado en Windows 10 LTSC: sin `zstd` en el PATH
            // falla con «Can't initialize filter; unable to run program».
            "tar.zst" => plan(con_tar(), (!probe("zstd")).then_some("zstd")),
            // 7-Zip extrae también rar, así que sirve para los dos; si está
            // unrar, para rar se prefiere él.
            "rar" => {
                let (tool, missing) = choose(&["7z", "unrar"]);
                plan(
                    if tool == "unrar" {
                        con_unrar()
                    } else {
                        con_7z(tool)
                    },
                    missing,
                )
            }
            "7z" => {
                let (tool, missing) = choose(&["7z"]);
                plan(con_7z(tool), missing)
            }
            // Comprimidos de un solo archivo: en Windows no hay gzip ni xz de
            // serie, y 7-Zip los abre todos.
            _ => {
                let (tool, missing) = choose(&["7z"]);
                plan(con_7z(tool), missing)
            }
        };
    }

    // Unix. El tar de GNU no abre zip, y el zstd lo delega igual que bsdtar.
    match archive {
        "tar" => plan(con_tar(), None),
        "tar.zst" => plan(con_tar(), (!probe("zstd")).then_some("zstd")),
        "zip" => {
            // En una imagen mínima puede no haber unzip; bsdtar y 7z abren zip
            // igual de bien.
            let (tool, missing) = choose(&["unzip", "bsdtar", "7z"]);
            plan(
                match tool {
                    "unzip" => format!("unzip -o {} -d {}", quote(&file), quote(&dir)),
                    "bsdtar" => format!("bsdtar -xf {} -C {}", quote(&file), quote(&dir)),
                    _ => con_7z(tool),
                },
                missing,
            )
        }
        "7z" => {
            let (tool, missing) = choose(&["7z", "7za", "7zr"]);
            plan(con_7z(tool), missing)
        }
        "rar" => {
            let (tool, missing) = choose(&["unrar", "7z"]);
            plan(
                if tool == "unrar" {
                    con_unrar()
                } else {
                    con_7z(tool)
                },
                missing,
            )
        }
        // gzip, xz, bzip2 y zstd escriben a la salida estándar con `-dc`, que es
        // lo que permite dejar el resultado en la carpeta de destino.
        other => {
            let candidates: &[&'static str] = match other {
                "gz" => &["gzip"],
                "xz" => &["xz"],
                "bz2" => &["bzip2"],
                _ => &["zstd"],
            };
            let (tool, missing) = choose(candidates);
            plan(con_filtro(tool), missing)
        }
    }
}

/// El nombre que tendrá un comprimido de un solo archivo al descomprimirlo:
/// `app.exe.gz` sale como `app.exe`. Si no queda nombre, se usa uno genérico
/// antes que dejar la ruta terminada en separador.
fn single_file_output(path: &str, windows_shell: bool) -> String {
    let separator = if windows_shell { '\\' } else { '/' };
    let name = path.rsplit(separator).next().unwrap_or(path);
    let stem = name.rsplit_once('.').map(|(base, _)| base).unwrap_or(name);
    if stem.is_empty() {
        "extraido".to_string()
    } else {
        stem.to_string()
    }
}

// ---- Cliente de la API ----

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimit {
    pub remaining: Option<i64>,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub message: String,
    pub status: u16,
    pub rate_limit: RateLimit,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl ApiError {
    fn new(message: impl Into<String>) -> ApiError {
        ApiError {
            message: message.into(),
            status: 0,
            rate_limit: RateLimit::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    /// `owner` o `repo`.
    pub target: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
    pub repositories: Vec<Repository>,
    pub rate_limit: RateLimit,
}

pub struct GithubClient {
    client: reqwest::blocking::Client,
    user_agent: String,
    cache: parking_lot::Mutex<HashMap<String, (Instant, Value, RateLimit)>>,
}

/// Un solo pool HTTP por proceso. `reqwest::Client` reutiliza conexiones y su
/// resolvedor; recrearlo en Proyectos y Actualizador duplicaba sockets y DNS.
pub fn shared_client() -> &'static GithubClient {
    static CLIENT: once_cell::sync::Lazy<GithubClient> =
        once_cell::sync::Lazy::new(|| GithubClient::new(crate::identity::current().user_agent));
    &CLIENT
}

impl GithubClient {
    pub fn new(user_agent: &str) -> GithubClient {
        GithubClient {
            client: reqwest::blocking::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                // Una redirección desde api.github.com a otro host sería una
                // sorpresa: se rechaza en vez de seguirla.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            user_agent: user_agent.chars().take(100).collect(),
            cache: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    fn request(&self, api_path: &str) -> Result<(Value, RateLimit), ApiError> {
        if !api_path.starts_with('/')
            || !api_path
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "?&=._%/-".contains(c))
        {
            return Err(ApiError::new("Ruta de API no válida."));
        }
        if let Some((at, data, rate)) = self.cache.lock().get(api_path).cloned() {
            if at.elapsed() < API_CACHE_TTL {
                return Ok((data, rate));
            }
        }
        let response = self
            .client
            .get(format!("{GITHUB_API_ORIGIN}{api_path}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", &self.user_agent)
            .send()
            .map_err(|error| {
                ApiError::new(if error.is_timeout() {
                    "GitHub tardó demasiado en responder."
                } else {
                    "No se pudo conectar con GitHub."
                })
            })?;

        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<i64>().ok())
        };
        let rate_limit = RateLimit {
            remaining: header("x-ratelimit-remaining"),
            reset_at: header("x-ratelimit-reset").and_then(|seconds| {
                chrono::DateTime::from_timestamp(seconds, 0)
                    .map(|time| time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
            }),
        };
        let status = response.status().as_u16();
        let ok = response.status().is_success();
        let text = response.text().unwrap_or_default();
        if text.len() > MAX_API_BYTES {
            return Err(ApiError {
                message: "La respuesta de GitHub es demasiado grande.".into(),
                status,
                rate_limit,
            });
        }
        let data: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !ok {
            let message = if status == 404 {
                "El perfil o repositorio no existe o no es público.".to_string()
            } else if status == 403 && rate_limit.remaining == Some(0) {
                "Se agotó temporalmente el límite de consultas públicas de GitHub.".to_string()
            } else {
                format!("GitHub respondió con el estado {status}.")
            };
            return Err(ApiError {
                message,
                status,
                rate_limit,
            });
        }
        let mut cache = self.cache.lock();
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.retain(|_, (at, _, _)| at.elapsed() < API_CACHE_TTL);
            if cache.len() >= MAX_CACHE_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(
            api_path.to_string(),
            (Instant::now(), data.clone(), rate_limit.clone()),
        );
        Ok((data, rate_limit))
    }

    pub fn lookup(&self, raw_target: &str) -> Result<Lookup, ApiError> {
        let Some(target) = parse_github_target(raw_target) else {
            return Err(ApiError::new(
                "Introduce un usuario, owner/repo o una URL pública de github.com.",
            ));
        };
        match target {
            Target::Repo(full) => {
                let (data, rate_limit) =
                    self.request(&format!("/repos/{}/{}", full.owner, full.name))?;
                let Some(repository) = sanitize_repository(&data) else {
                    return Err(ApiError::new("GitHub devolvió un repositorio no válido."));
                };
                Ok(Lookup {
                    target: "repo",
                    profile: None,
                    repositories: vec![repository],
                    rate_limit,
                })
            }
            Target::Owner(owner) => {
                let (data, _) = self.request(&format!("/users/{owner}"))?;
                let Some(profile) = sanitize_profile(&data) else {
                    return Err(ApiError::new("GitHub devolvió un perfil no válido."));
                };
                let route = if profile.kind == "Organization" {
                    "orgs"
                } else {
                    "users"
                };
                let (repos, rate_limit) = self.request(&format!(
                    "/{route}/{}/repos?sort=updated&direction=desc&per_page=100&type=public",
                    profile.login
                ))?;
                Ok(Lookup {
                    target: "owner",
                    profile: Some(profile),
                    repositories: repos
                        .as_array()
                        .map(|list| list.iter().filter_map(sanitize_repository).collect())
                        .unwrap_or_default(),
                    rate_limit,
                })
            }
        }
    }

    /// Última release publicada de un repositorio. GitHub responde 404 cuando
    /// el proyecto no ha publicado ninguna, que es lo normal en la mayoría: eso
    /// no es un error que haya que enseñar como tal.
    pub fn latest_release(
        &self,
        full_name: &str,
    ) -> Result<(Option<Release>, RateLimit), ApiError> {
        let Some(repo) = parse_full_name(full_name) else {
            return Err(ApiError::new("Repositorio no válido."));
        };
        match self.request(&format!(
            "/repos/{}/{}/releases/latest",
            repo.owner, repo.name
        )) {
            Ok((data, rate_limit)) => Ok((sanitize_release(&data), rate_limit)),
            Err(error) if error.status == 404 => Ok((None, error.rate_limit)),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env(kind: ShellKind, transport: Transport) -> Environment {
        Environment {
            transport,
            ..Environment::new("x", "x", kind, "/bin/sh", &[])
        }
    }

    // ---- Validación ----

    fn clonar(raiz: &Path, propietario: &str, nombre: &str) {
        std::fs::create_dir_all(raiz.join(propietario).join(nombre).join(".git")).unwrap();
    }

    #[test]
    fn se_listan_los_repositorios_clonados_recorriendo_el_disco() {
        let dir = tempfile::tempdir().unwrap();
        clonar(dir.path(), "torvalds", "linux");
        clonar(dir.path(), "rust-lang", "rust");
        // Una carpeta con el nombre de un repositorio pero sin .git no lo es.
        std::fs::create_dir_all(dir.path().join("torvalds").join("no-es-repo")).unwrap();

        let lista = list_local_repositories(&dir.path().to_string_lossy());
        let nombres: Vec<&str> = lista.iter().map(|r| r.full_name.as_str()).collect();
        assert_eq!(nombres.len(), 2);
        assert!(nombres.contains(&"torvalds/linux"));
        assert!(nombres.contains(&"rust-lang/rust"));
        assert!(!nombres.iter().any(|n| n.contains("no-es-repo")));
    }

    #[test]
    fn la_carpeta_de_releases_de_la_propia_app_no_cuenta_como_repositorio() {
        // `_releases` cuelga de la misma carpeta de proyectos y empieza por
        // guion bajo, que no es un login valido de GitHub.
        let dir = tempfile::tempdir().unwrap();
        clonar(dir.path(), "_releases", "loquesea");
        clonar(dir.path(), "torvalds", "linux");
        let lista = list_local_repositories(&dir.path().to_string_lossy());
        assert_eq!(lista.len(), 1);
        assert_eq!(lista[0].full_name, "torvalds/linux");
    }

    #[test]
    fn una_carpeta_de_proyectos_que_no_existe_no_es_un_error() {
        assert!(list_local_repositories("/no/existe/en/ningun/sitio").is_empty());
        assert!(list_local_repositories("").is_empty());
    }

    #[test]
    fn los_clonados_salen_por_lo_tocado_mas_recientemente() {
        let dir = tempfile::tempdir().unwrap();
        clonar(dir.path(), "aaa", "viejo");
        clonar(dir.path(), "zzz", "nuevo");
        // La fecha real depende del sistema de archivos; lo que se comprueba es
        // que el orden NO es alfabetico por defecto sino por fecha, y que a
        // igualdad de fecha desempata el nombre para no bailar entre aperturas.
        let lista = list_local_repositories(&dir.path().to_string_lossy());
        assert_eq!(lista.len(), 2);
        let fechas: Vec<u64> = lista.iter().map(|r| r.modified).collect();
        assert!(fechas[0] >= fechas[1], "no esta ordenado por fecha");
        if fechas[0] == fechas[1] {
            assert_eq!(lista[0].full_name, "aaa/viejo");
        }
    }

    #[test]
    fn el_catalogo_de_fabrica_ancla_el_perfil_del_proyecto_y_conserva_creditos() {
        let windows = load_catalog(Path::new("config/project-catalog.json"), "win32");
        assert!(windows.owners.is_empty());
        assert_eq!(windows.fixed_profiles, vec!["Darkeiser003"]);
        assert!(windows.repositories.is_empty());
        assert_eq!(windows.developers, vec!["Darkeiser003"]);
        assert!(windows.project_leads.is_empty());
        assert_eq!(
            windows.self_repository.as_deref(),
            Some("Darkeiser003/Terminal")
        );

        for plataforma in ["linux", "darwin"] {
            let otro = load_catalog(Path::new("config/project-catalog.json"), plataforma);
            assert!(otro.owners.is_empty(), "{plataforma}");
            assert_eq!(otro.fixed_profiles, vec!["Darkeiser003"], "{plataforma}");
            assert!(otro.repositories.is_empty(), "{plataforma}");
            assert_eq!(otro.developers, vec!["Darkeiser003"], "{plataforma}");
            assert!(otro.project_leads.is_empty(), "{plataforma}");
            assert_eq!(
                otro.self_repository.as_deref(),
                Some("Darkeiser003/Terminal"),
                "{plataforma}"
            );
        }
    }

    #[test]
    fn se_aceptan_los_logins_validos_de_github() {
        assert!(is_github_owner("torvalds"));
        assert!(is_github_owner("a"));
        assert!(is_github_owner("mi-org-1"));
        assert!(!is_github_owner("-empieza-mal"));
        assert!(!is_github_owner("acaba-mal-"));
        assert!(!is_github_owner("con espacio"));
        assert!(!is_github_owner(""));
        assert!(!is_github_owner(&"a".repeat(40)));
    }

    #[test]
    fn se_reconoce_owner_barra_repo_con_o_sin_git() {
        let parsed = parse_full_name("torvalds/linux.git").unwrap();
        assert_eq!(parsed.full_name, "torvalds/linux");
        assert_eq!(parse_full_name("torvalds"), None);
        assert_eq!(parse_full_name("a/b/c"), None);
    }

    #[test]
    fn se_acepta_una_url_web_de_github() {
        assert_eq!(
            parse_github_target("https://github.com/torvalds"),
            Some(Target::Owner("torvalds".into()))
        );
        match parse_github_target("https://github.com/torvalds/linux").unwrap() {
            Target::Repo(repo) => assert_eq!(repo.full_name, "torvalds/linux"),
            other => panic!("se esperaba un repo: {other:?}"),
        }
    }

    #[test]
    fn se_rechaza_todo_lo_que_no_sea_github_por_https() {
        for malo in [
            "git@github.com:torvalds/linux.git",
            "git://github.com/torvalds/linux",
            "http://github.com/torvalds",
            "https://gitlab.com/torvalds",
            "https://github.com:8443/torvalds",
            "https://user:pass@github.com/torvalds",
            "https://github.com/torvalds/linux/tree/master",
            "",
        ] {
            assert_eq!(parse_github_target(malo), None, "{malo} debería rechazarse");
        }
    }

    // ---- Reducción de respuestas ----

    #[test]
    fn del_perfil_solo_pasan_los_campos_esperados() {
        let raw = json!({
            "login": "torvalds", "name": "Linus", "bio": "x", "type": "User",
            "public_repos": 8, "followers": 200000, "secreto": "no debería pasar"
        });
        let profile = sanitize_profile(&raw).unwrap();
        assert_eq!(profile.login, "torvalds");
        assert_eq!(profile.html_url, "https://github.com/torvalds");
        let value = serde_json::to_value(&profile).unwrap();
        assert!(value.get("secreto").is_none());
    }

    #[test]
    fn un_perfil_con_login_invalido_se_descarta() {
        assert_eq!(sanitize_profile(&json!({ "login": "-malo" })), None);
        assert_eq!(sanitize_profile(&json!({})), None);
    }

    #[test]
    fn del_repositorio_se_derivan_las_urls_en_vez_de_confiar_en_las_que_llegan() {
        let raw = json!({
            "owner": { "login": "torvalds" }, "name": "linux",
            "html_url": "https://sitio-malo.example/x",
            "clone_url": "git@malo:x.git"
        });
        let repo = sanitize_repository(&raw).unwrap();
        assert_eq!(repo.html_url, "https://github.com/torvalds/linux");
        assert_eq!(repo.clone_url, "https://github.com/torvalds/linux.git");
    }

    // ---- Releases ----

    #[test]
    fn solo_se_aceptan_adjuntos_de_los_hosts_de_github() {
        assert!(is_allowed_asset_url(
            "https://github.com/x/y/releases/download/v1/a.zip"
        ));
        assert!(is_allowed_asset_url(
            "https://objects.githubusercontent.com/x"
        ));
        assert!(!is_allowed_asset_url("https://malo.example/a.zip"));
        assert!(!is_allowed_asset_url("http://github.com/x"));
        assert!(!is_allowed_asset_url("https://user@github.com/x"));
        assert!(!is_allowed_asset_url("https://github.com:8443/x"));
    }

    #[test]
    fn un_adjunto_con_ruta_en_el_nombre_se_descarta() {
        let raw = json!({
            "name": "../fuera.zip",
            "browser_download_url": "https://github.com/x/y/a.zip"
        });
        assert_eq!(sanitize_asset(&raw), None);

        let raw = json!({
            "name": "sub/dentro.zip",
            "browser_download_url": "https://github.com/x/y/a.zip"
        });
        assert_eq!(sanitize_asset(&raw), None);
    }

    #[test]
    fn se_reconoce_el_formato_de_cada_adjunto() {
        assert_eq!(archive_kind_for("app.tar.gz"), Some("tar"));
        assert_eq!(archive_kind_for("app.tgz"), Some("tar"));
        assert_eq!(archive_kind_for("app.tar.bz2"), Some("tar"));
        assert_eq!(archive_kind_for("app.tar.xz"), Some("tar"));
        assert_eq!(archive_kind_for("app.ZIP"), Some("zip"));
        assert_eq!(archive_kind_for("app.7z"), Some("7z"));
        assert_eq!(archive_kind_for("app.rar"), Some("rar"));
        // El zstd va aparte: es el único de la familia tar que el tar de
        // Windows no resuelve solo.
        assert_eq!(archive_kind_for("app.tar.zst"), Some("tar.zst"));
        assert_eq!(archive_kind_for("app.tzst"), Some("tar.zst"));
        // Comprimidos de un solo archivo, sin tar dentro.
        assert_eq!(archive_kind_for("app.bin.gz"), Some("gz"));
        assert_eq!(archive_kind_for("app.bin.xz"), Some("xz"));
        assert_eq!(archive_kind_for("app.bin.bz2"), Some("bz2"));
        assert_eq!(archive_kind_for("app.bin.zst"), Some("zst"));
        // Lo que no se sabe desempaquetar simplemente se descarga.
        assert_eq!(archive_kind_for("app.exe"), None);
        assert_eq!(archive_kind_for("app.AppImage"), None);
    }

    #[test]
    fn una_release_sin_nombre_usa_su_etiqueta() {
        let release = sanitize_release(&json!({ "tag_name": "v1.2.3" })).unwrap();
        assert_eq!(release.name, "v1.2.3");
        assert!(release.assets.is_empty());
    }

    #[test]
    fn los_adjuntos_se_recortan_al_tope() {
        let assets: Vec<Value> = (0..50)
            .map(|index| {
                json!({
                    "name": format!("a{index}.zip"),
                    "browser_download_url": "https://github.com/x/y/a.zip"
                })
            })
            .collect();
        let release = sanitize_release(&json!({ "tag_name": "v1", "assets": assets })).unwrap();
        assert_eq!(release.assets.len(), MAX_ASSETS);
    }

    // ---- Catálogo ----

    #[test]
    fn el_catalogo_descarta_lo_que_no_es_valido() {
        let raw = json!({
            "brand": "Darkeiser003",
            "owners": ["bueno", "-malo", 5],
            "repositories": ["a/b", "no-valido", "c/d"]
        });
        let catalog = normalize_catalog(&raw, "win32");
        assert_eq!(catalog.owners, vec!["bueno"]);
        assert_eq!(catalog.repositories, vec!["a/b", "c/d"]);
    }

    #[test]
    fn cada_plataforma_puede_anclar_lo_suyo() {
        let raw = json!({
            "brand": "Darkeiser003",
            "fixedProfiles": ["winslim"],
            "repositories": ["a/b"],
            "platformOverrides": { "linux": { "fixedProfiles": ["lterminal"] } }
        });
        let windows = normalize_catalog(&raw, "win32");
        assert_eq!(windows.fixed_profiles, vec!["winslim"]);
        // El override cambia solo lo suyo: la marca y los repos se heredan.
        let linux = normalize_catalog(&raw, "linux");
        assert_eq!(linux.fixed_profiles, vec!["lterminal"]);
        assert_eq!(linux.brand, "Darkeiser003");
        assert_eq!(linux.repositories, vec!["a/b"]);
    }

    #[test]
    fn los_anclados_del_usuario_se_suman_a_los_de_fabrica() {
        let catalog = normalize_catalog(
            &json!({ "fixedProfiles": ["winslim"], "repositories": ["a/b"] }),
            "win32",
        );
        let mut settings = serde_json::Map::new();
        settings.insert("githubPinnedOwners".into(), json!(["torvalds", "-malo"]));
        settings.insert("githubPinnedRepos".into(), json!(["c/d"]));

        let merged = merge_pins(&catalog, &settings);
        assert_eq!(merged.owners, vec!["winslim", "torvalds"]);
        assert_eq!(merged.repositories, vec!["a/b", "c/d"]);
        // Los de fábrica siguen marcados como tales: no se pueden desanclar.
        assert_eq!(merged.fixed_profiles, vec!["winslim"]);
    }

    #[test]
    fn un_catalogo_ilegible_no_deja_la_app_sin_marca() {
        let catalog = load_catalog(Path::new("/no/existe/catalogo.json"), "win32");
        assert_eq!(catalog.brand, "Darkeiser003");
        assert!(catalog.owners.is_empty());
    }

    // ---- Estado local y comandos ----

    #[test]
    fn un_repositorio_sin_clonar_propone_clone_y_uno_clonado_pull() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let repo = repository_from_full_name("torvalds/linux").unwrap();

        let state = local_repository_state(&folder, &repo).unwrap();
        assert!(!state.exists);
        assert_eq!(state.action, "clone");

        std::fs::create_dir_all(dir.path().join("torvalds").join("linux").join(".git")).unwrap();
        let state = local_repository_state(&folder, &repo).unwrap();
        assert!(state.repository_exists);
        assert_eq!(state.action, "pull");
    }

    #[test]
    fn el_comando_de_git_depende_de_si_ya_esta_clonado() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let repo = repository_from_full_name("torvalds/linux").unwrap();
        let shell = env(ShellKind::Cmd, Transport::Native);

        let plan = build_git_command(&repo, &folder, &shell).unwrap();
        assert!(plan
            .command
            .starts_with("git clone -- \"https://github.com/torvalds/linux.git\""));

        std::fs::create_dir_all(dir.path().join("torvalds").join("linux").join(".git")).unwrap();
        let plan = build_git_command(&repo, &folder, &shell).unwrap();
        assert!(plan.command.starts_with("git -C \""));
        assert!(plan.command.ends_with(" pull --ff-only"));
    }

    #[test]
    fn un_contenedor_no_ve_la_carpeta_de_proyectos_del_host() {
        let repo = repository_from_full_name("a/b").unwrap();
        for transport in [Transport::Docker, Transport::Android] {
            assert_eq!(
                build_git_command(&repo, "/proyectos", &env(ShellKind::Bash, transport)),
                None
            );
        }
    }

    #[test]
    fn se_cuentan_solo_las_carpetas_con_git_dentro() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("ana").join("uno").join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("ana").join("dos")).unwrap();
        std::fs::create_dir_all(dir.path().join("beto").join("tres").join(".git")).unwrap();

        assert_eq!(count_local_repositories(&dir.path().to_string_lossy()), 2);
        assert_eq!(count_local_repositories("/no/existe"), 0);
        assert_eq!(count_local_repositories(""), 0);
    }

    // ---- Extracción ----

    /// Todo instalado, que es el caso de una máquina de desarrollo.
    fn todo() -> impl Fn(&str) -> bool {
        |_| true
    }

    /// Nada instalado más allá de lo que trae el sistema.
    fn nada() -> impl Fn(&str) -> bool {
        |_| false
    }

    fn solo(disponibles: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |tool| disponibles.contains(&tool)
    }

    fn plan(archivo: &str, kind: ShellKind, instalado: &dyn Fn(&str) -> bool) -> ExtractPlan {
        let destino = if is_windows_shell(kind) {
            "C:\\d"
        } else {
            "/d"
        };
        let origen = if is_windows_shell(kind) {
            format!("C:\\d\\{archivo}")
        } else {
            format!("/d/{archivo}")
        };
        build_extract_command(&origen, destino, kind, Transport::Native, instalado).unwrap()
    }

    #[test]
    fn cada_shell_desempaqueta_con_lo_que_tiene() {
        assert!(plan("a.zip", ShellKind::Powershell, &todo())
            .command
            .starts_with("Expand-Archive"));
        // El tar de Windows (bsdtar) también abre zip.
        assert!(plan("a.zip", ShellKind::Cmd, &todo())
            .command
            .starts_with("tar -xf"));
        // El tar de GNU no: en Unix se usa unzip.
        assert!(plan("a.zip", ShellKind::Bash, &todo())
            .command
            .starts_with("unzip -o"));
    }

    /// Lo que trae el sistema no puede faltar, así que no se avisa de nada.
    #[test]
    fn lo_que_resuelve_el_propio_sistema_nunca_pide_instalar_nada() {
        for (archivo, kind) in [
            ("a.tar.gz", ShellKind::Cmd),
            ("a.tar.bz2", ShellKind::Cmd),
            ("a.tar.xz", ShellKind::Powershell),
            ("a.zip", ShellKind::Cmd),
            ("a.zip", ShellKind::Powershell),
            ("a.tar.gz", ShellKind::Bash),
        ] {
            assert_eq!(
                plan(archivo, kind, &nada()).missing,
                None,
                "{archivo} {kind:?}"
            );
        }
    }

    /// Comprobado en Windows 10 LTSC: bsdtar delega el zstd en un programa
    /// externo y sin él falla con «Can't initialize filter».
    #[test]
    fn el_tar_zst_avisa_de_que_hace_falta_zstd() {
        let sin = plan("a.tar.zst", ShellKind::Cmd, &nada());
        assert!(sin.command.starts_with("tar -xf"));
        assert_eq!(sin.missing, Some("zstd"));

        let con = plan("a.tar.zst", ShellKind::Cmd, &solo(&["zstd"]));
        assert_eq!(con.missing, None);
    }

    #[test]
    fn los_formatos_que_no_trae_el_sistema_dicen_que_falta() {
        let siete = plan("a.7z", ShellKind::Cmd, &nada());
        assert!(siete.command.starts_with("7z x"));
        assert_eq!(siete.missing, Some("7z"));

        let rar = plan("a.rar", ShellKind::Bash, &nada());
        assert_eq!(rar.missing, Some("unrar"));
    }

    /// 7-Zip abre rar, así que si está no hace falta unrar; y al revés, unrar
    /// es preferente en Unix cuando está.
    #[test]
    fn para_el_rar_se_usa_la_herramienta_que_haya() {
        assert!(plan("a.rar", ShellKind::Cmd, &solo(&["7z"]))
            .command
            .starts_with("7z x"));
        assert!(plan("a.rar", ShellKind::Cmd, &solo(&["unrar"]))
            .command
            .starts_with("unrar x"));
        assert!(plan("a.rar", ShellKind::Bash, &solo(&["7z"]))
            .command
            .starts_with("7z x"));
    }

    /// Sin separador final hay versiones de unrar que toman el destino como un
    /// patrón de archivos y no extraen nada.
    #[test]
    fn unrar_recibe_el_destino_con_separador_final() {
        assert!(plan("a.rar", ShellKind::Cmd, &solo(&["unrar"]))
            .command
            .contains("\"C:\\d\\\""));
        assert!(plan("a.rar", ShellKind::Bash, &solo(&["unrar"]))
            .command
            .contains("'/d/'"));
    }

    /// En una imagen mínima sin unzip, bsdtar y 7z abren el zip igual.
    #[test]
    fn el_zip_en_unix_cae_a_lo_que_este_instalado() {
        assert!(plan("a.zip", ShellKind::Bash, &solo(&["bsdtar"]))
            .command
            .starts_with("bsdtar -xf"));
        assert!(plan("a.zip", ShellKind::Bash, &solo(&["7z"]))
            .command
            .starts_with("7z x"));
        assert_eq!(
            plan("a.zip", ShellKind::Bash, &nada()).missing,
            Some("unzip")
        );
    }

    /// Un `.gz` suelto NO es un tar: `tar -xf` sobre él falla. Se descomprime
    /// como archivo único y el resultado va a la carpeta de destino.
    #[test]
    fn un_comprimido_de_un_solo_archivo_no_se_trata_como_tar() {
        let unix = plan("app.bin.gz", ShellKind::Bash, &todo());
        assert_eq!(unix.command, "gzip -dc '/d/app.bin.gz' > '/d/app.bin'");

        let windows = plan("app.bin.gz", ShellKind::Cmd, &solo(&["7z"]));
        assert!(windows.command.starts_with("7z x"));

        assert_eq!(
            plan("app.bin.zst", ShellKind::Bash, &todo()).command,
            "zstd -dc '/d/app.bin.zst' > '/d/app.bin'"
        );
    }

    #[test]
    fn un_adjunto_que_no_es_un_archivo_comprimido_no_se_extrae() {
        assert_eq!(
            build_extract_command(
                "/d/app.AppImage",
                "/d",
                ShellKind::Bash,
                Transport::Native,
                &todo()
            ),
            None
        );
    }

    #[test]
    fn dentro_de_wsl_la_ruta_de_extraccion_se_traduce() {
        let plan = build_extract_command(
            "C:\\d\\a.tar.gz",
            "C:\\d",
            ShellKind::Bash,
            Transport::Wsl,
            &todo(),
        )
        .unwrap();
        assert!(plan.command.contains("'/mnt/c/d/a.tar.gz'"));
        assert!(plan.command.contains("-C '/mnt/c/d'"));
    }

    /// Dentro de WSL o de un contenedor el comando corre en OTRO sistema: mirar
    /// el PATH del host para decidir qué falta daría un aviso falso.
    #[test]
    fn fuera_del_host_no_se_comprueba_el_path_del_host() {
        for transport in [Transport::Wsl, Transport::Docker, Transport::Android] {
            let plan = build_extract_command("/d/a.7z", "/d", ShellKind::Bash, transport, &nada())
                .unwrap();
            assert_eq!(plan.missing, None, "{transport:?}");
            assert!(plan.command.starts_with("7z x"));
        }
    }
}
