//! Carpeta propia (`entornos`) para lo que descargan y crean desde WTerminal
//! los lenguajes, gestores de paquetes, herramientas y REPL, y vista del
//! espacio que ocupan. Va por categorías, cada una con su interruptor:
//!
//! | Categoría | Subcarpeta | Qué reubica | De fábrica |
//! |---|---|---|---|
//! | Cachés | `cache/` | npm, Yarn, Bun, Deno, pip, uv, Go, NuGet, Coursier, Composer, pub | activa |
//! | Descargas del panel | `descargas/` | Los archivos que bajan las acciones del panel (ADB…) | activa |
//! | Modelos de IA | `ia/` | `HF_HOME`; `OLLAMA_MODELS` solo si aún no hay modelos de Ollama | activa |
//! | Herramientas nuevas | `herramientas/` | `npm -g`, `cargo install`, `go install`, `pip --user`, con su `bin` en el PATH | activa |
//! | Historial de los REPL | `historial/` | Node, Python 3.13+, SQLite y psql | activa |
//! | Toolchains completas | `toolchains/` | rustup, cargo, GOPATH, Gradle, .NET, Android; solo si aún no estaban instaladas | activa |
//! | Programas | `programas/<id>` | `--location` de WinGet en las acciones «Instalar»; Chocolatey (con sus paquetes) y sus herramientas sueltas también | activa |
//! | Proyectos de GitHub | `proyectos/` | La carpeta donde se clonan los proyectos | apagada |
//!
//! Cada herramienta ya permite elegir su carpeta con una variable de entorno
//! estándar. WTerminal la inyecta solo en los procesos que lanza (terminales
//! y sondas de detección): no toca las variables del sistema, no pisa las que
//! el usuario ya haya definido y nunca mueve nada ya instalado: lo que ya
//! estaba sigue donde estaba y se sigue detectando, y una toolchain ya
//! instalada no se reubica. Las carpetas `bin` nuevas van en el PATH de
//! WTerminal y, con la integración con el PATH, también en el del usuario
//! junto a las variables que necesitan (`BIN_REQUIRES`). Los proyectos de
//! GitHub siguen de fábrica en Documentos. Los navegadores de Playwright o los
//! entornos de Poetry no se reubican nunca.
//!
//! Ajustes enseña además cada carpeta que usa WTerminal (ajustes, registros,
//! datos de la interfaz, temporales…) y las ubicaciones habituales de otras
//! herramientas, cada una con una explicación ([`LocationInfo`]): para qué
//! sirve, si se puede borrar y qué pasa si se borra.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

/// Si una carpeta se puede borrar a mano y qué pasa entonces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Safety {
    /// Temporales o registros: se borra sin perder nada.
    Safe,
    /// Caché: se puede borrar y se vuelve a descargar o generar.
    Regenerates,
    /// Contiene programas instalados o configuración: borrarlo los quita.
    Caution,
    /// No se borra a mano: se gestiona con su propia herramienta.
    Keep,
}

/// La explicación que Ajustes enseña al pasar el ratón por una ubicación.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    /// Qué es, para qué sirve y quién la crea.
    pub purpose: String,
    /// Si se puede borrar, qué pasa si se borra y cómo hacerlo bien.
    pub deletion: String,
    pub safety: Safety,
}

fn info(safety: Safety, purpose: &str, deletion: &str) -> LocationInfo {
    LocationInfo {
        purpose: purpose.to_string(),
        deletion: deletion.to_string(),
        safety,
    }
}

/// Las categorías de la carpeta propia, cada una con su interruptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Caches,
    Downloads,
    AiModels,
    Tools,
    ReplHistory,
    Toolchains,
    Programs,
    Projects,
    /// Configuración de los REPL (IPython, Jupyter): solo si aún no existía.
    Config,
    /// Plugins de las shells: caché de starship y el perfil de Clink propio
    /// de WTerminal.
    Plugins,
}

impl Category {
    pub const ALL: [Category; 10] = [
        Category::Caches,
        Category::Downloads,
        Category::AiModels,
        Category::Tools,
        Category::ReplHistory,
        Category::Toolchains,
        Category::Programs,
        Category::Projects,
        Category::Config,
        Category::Plugins,
    ];

    /// El identificador que ve el frontend (el mismo que da serde).
    pub fn id(self) -> &'static str {
        match self {
            Category::Caches => "caches",
            Category::Downloads => "downloads",
            Category::AiModels => "aiModels",
            Category::Tools => "tools",
            Category::ReplHistory => "replHistory",
            Category::Toolchains => "toolchains",
            Category::Programs => "programs",
            Category::Projects => "projects",
            Category::Config => "config",
            Category::Plugins => "plugins",
        }
    }

    pub fn from_id(id: &str) -> Option<Category> {
        Category::ALL
            .into_iter()
            .find(|category| category.id() == id)
    }

    /// Subcarpeta dentro de la raíz. `cache` conserva el nombre de siempre:
    /// las cachés ya descargadas siguen en su sitio.
    fn dir(self) -> &'static str {
        match self {
            Category::Caches => "cache",
            Category::Downloads => "descargas",
            Category::AiModels => "ia",
            Category::Tools => "herramientas",
            Category::ReplHistory => "historial",
            Category::Toolchains => "toolchains",
            Category::Programs => "programas",
            Category::Projects => "proyectos",
            Category::Config => "configuracion",
            Category::Plugins => "plugins",
        }
    }
}

/// Qué categorías están activas (además del interruptor general).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Categories {
    pub caches: bool,
    pub downloads: bool,
    pub ai_models: bool,
    pub tools: bool,
    pub repl_history: bool,
    pub toolchains: bool,
    pub programs: bool,
    pub projects: bool,
    pub config: bool,
    pub plugins: bool,
}

impl Categories {
    pub fn from_preferences(preferences: &crate::preferences::Preferences) -> Categories {
        Categories {
            caches: true,
            downloads: preferences.toolchain_store_downloads,
            ai_models: preferences.toolchain_store_ai_models,
            tools: preferences.toolchain_store_tools,
            repl_history: preferences.toolchain_store_repl_history,
            toolchains: preferences.toolchain_store_toolchains,
            programs: preferences.toolchain_store_programs,
            projects: preferences.toolchain_store_projects,
            config: preferences.toolchain_store_config,
            plugins: preferences.toolchain_store_plugins,
        }
    }

    pub fn includes(self, category: Category) -> bool {
        match category {
            Category::Caches => self.caches,
            Category::Downloads => self.downloads,
            Category::AiModels => self.ai_models,
            Category::Tools => self.tools,
            Category::ReplHistory => self.repl_history,
            Category::Toolchains => self.toolchains,
            Category::Programs => self.programs,
            Category::Projects => self.projects,
            Category::Config => self.config,
            Category::Plugins => self.plugins,
        }
    }
}

/// Qué carpeta de una herramienta hay que añadir al PATH.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bin {
    None,
    /// La propia carpeta (`GOBIN`).
    Same,
    /// Una subcarpeta (`bin` de `cargo install`).
    Sub(&'static str),
    /// npm global: la carpeta en Windows, `bin/` en el resto.
    NpmPrefix,
    /// `pip --user`: `PythonXY\Scripts` en Windows (una por versión), `bin/`
    /// en el resto.
    PythonUser,
}

/// Algo que WTerminal reubica en la carpeta propia.
struct CacheDef {
    id: &'static str,
    name: &'static str,
    variable: &'static str,
    subdir: &'static str,
    category: Category,
    /// La variable apunta a un archivo (historial), no a una carpeta.
    file: bool,
    bin: Bin,
}

const fn entry(
    id: &'static str,
    name: &'static str,
    variable: &'static str,
    subdir: &'static str,
    category: Category,
) -> CacheDef {
    CacheDef {
        id,
        name,
        variable,
        subdir,
        category,
        file: false,
        bin: Bin::None,
    }
}

const fn tool(
    id: &'static str,
    name: &'static str,
    variable: &'static str,
    subdir: &'static str,
    bin: Bin,
) -> CacheDef {
    CacheDef {
        bin,
        ..entry(id, name, variable, subdir, Category::Tools)
    }
}

const fn toolchain(
    id: &'static str,
    name: &'static str,
    variable: &'static str,
    subdir: &'static str,
    bin: Bin,
) -> CacheDef {
    CacheDef {
        bin,
        ..entry(id, name, variable, subdir, Category::Toolchains)
    }
}

const fn history(
    id: &'static str,
    name: &'static str,
    variable: &'static str,
    file: &'static str,
) -> CacheDef {
    CacheDef {
        file: true,
        ..entry(id, name, variable, file, Category::ReplHistory)
    }
}

/// Id de la entrada de Ollama: solo se reubica si aún no hay modelos en su
/// carpeta de siempre (si no, `ollama serve` lanzado desde una pestaña dejaría
/// de verlos).
const OLLAMA_ENTRY: &str = "ollama";

/// Lo que cambia dónde va cada entrada además de la raíz: una carpeta propia
/// por categoría (Ajustes), entradas apagadas una a una y entradas traídas con
/// «Traer lo ya instalado» (`store_adopt`), que se reubican aunque ya
/// existieran en su sitio de siempre, porque su contenido ya está copiado.
#[derive(Debug, Default, Clone)]
struct Layout {
    category_dirs: HashMap<&'static str, PathBuf>,
    disabled: std::collections::HashSet<String>,
    adopted: std::collections::HashSet<String>,
}

static LAYOUT: Lazy<Mutex<Layout>> = Lazy::new(|| Mutex::new(Layout::default()));

/// Lee la carpeta de cada categoría y las entradas apagadas de las
/// preferencias, y las traídas del diario de `store_adopt`. Se llama antes de
/// calcular variables, carpetas `bin` o el estado.
pub fn sync_layout(preferences: &crate::preferences::Preferences) {
    let mut layout = Layout::default();
    for (category, dir) in parse_category_dirs(&preferences.toolchain_store_category_dirs) {
        layout.category_dirs.insert(category.id(), dir);
    }
    layout.disabled = preferences
        .toolchain_store_disabled
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    layout.adopted = crate::store_adopt::adopted_variable_ids()
        .into_iter()
        .collect();
    *LAYOUT.lock() = layout;
}

/// `categoría=carpeta`, una por línea (`caches=E:\cachés`). Las líneas con
/// una categoría desconocida o una carpeta relativa se ignoran.
pub fn parse_category_dirs(text: &str) -> Vec<(Category, PathBuf)> {
    text.lines()
        .filter_map(|line| {
            let (id, dir) = line.split_once('=')?;
            let category = Category::from_id(id.trim())?;
            let dir = PathBuf::from(dir.trim());
            dir.is_absolute().then_some((category, dir))
        })
        .collect()
}

/// Id del perfil de Clink propio de WTerminal en «Traer lo ya instalado».
pub const CLINK_PROFILE_ENTRY: &str = "clink-profile";

/// Dónde va el perfil de Clink de WTerminal con la categoría de plugins
/// activa: `<plugins>\clink` si aún no existía el de siempre (`default_dir`)
/// o si se trajo con «Traer lo ya instalado». `None` = el de siempre.
pub fn clink_profile_in_store(default_dir: &Path) -> Option<PathBuf> {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    if !preferences.toolchain_store_plugins || entry_disabled(CLINK_PROFILE_ENTRY) {
        return None;
    }
    let root = effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    )?;
    let in_store = category_base(&root, Category::Plugins).join("clink");
    (adopted(CLINK_PROFILE_ENTRY) || in_store.exists() || !default_dir.exists()).then_some(in_store)
}

/// Archivo que deja WTerminal en la raíz de la carpeta propia: explica qué es
/// y marca la carpeta como suya. El desinstalador solo ofrece borrar una
/// carpeta propia elegida a mano si lo lleva (`platform::first_run`).
pub const STORE_MARKER: &str = "LEEME-carpeta-propia-WTerminal.txt";

const STORE_MARKER_TEXT: &str = "Carpeta propia de WTerminal: cachés, descargas, modelos de IA, herramientas, historial, toolchains, configuración, plugins y programas instalados desde WTerminal, cada cosa en su subcarpeta.\r\nSe gestiona en Ajustes > Comportamiento > «Gestionar la carpeta propia…». Al desinstalar WTerminal se puede borrar entera.\r\n";

/// La entrada se trajo a la carpeta propia con «Traer lo ya instalado».
pub fn adopted(id: &str) -> bool {
    LAYOUT.lock().adopted.contains(id)
}

/// La entrada está apagada a mano en Ajustes, aunque su categoría siga activa.
pub fn entry_disabled(id: &str) -> bool {
    LAYOUT.lock().disabled.contains(id)
}

/// La carpeta de una categoría: la que eligió el usuario para ella o
/// `<raíz>\<subcarpeta>`.
pub fn category_base(root: &Path, category: Category) -> PathBuf {
    LAYOUT
        .lock()
        .category_dirs
        .get(category.id())
        .cloned()
        .unwrap_or_else(|| root.join(category.dir()))
}

#[rustfmt::skip]
const CACHES: &[CacheDef] = &[
    entry("npm", "npm", "npm_config_cache", "npm", Category::Caches),
    entry("yarn", "Yarn", "YARN_CACHE_FOLDER", "yarn", Category::Caches),
    entry("bun", "Bun", "BUN_INSTALL_CACHE_DIR", "bun", Category::Caches),
    entry("deno", "Deno", "DENO_DIR", "deno", Category::Caches),
    entry("pip", "pip", "PIP_CACHE_DIR", "pip", Category::Caches),
    entry("uv", "uv", "UV_CACHE_DIR", "uv", Category::Caches),
    entry("go-mod", "Go (mod)", "GOMODCACHE", "go-mod", Category::Caches),
    entry("go-build", "Go (build)", "GOCACHE", "go-build", Category::Caches),
    entry("nuget", "NuGet", "NUGET_PACKAGES", "nuget", Category::Caches),
    entry("coursier", "Coursier", "COURSIER_CACHE", "coursier", Category::Caches),
    entry("composer", "Composer", "COMPOSER_CACHE_DIR", "composer", Category::Caches),
    // Junto a las demás cachés: Ajustes pinta una cabecera cada vez que
    // cambia la categoría respecto a la fila anterior, y detrás de las
    // toolchains salía una segunda «Cachés» solo con pub.
    entry("pub", "Dart y Flutter (pub)", "PUB_CACHE", "pub", Category::Caches),
    entry("downloads", "Descargas del panel", "WTERMINAL_DOWNLOADS", "panel", Category::Downloads),
    entry("huggingface", "Hugging Face", "HF_HOME", "huggingface", Category::AiModels),
    entry(OLLAMA_ENTRY, "Ollama (modelos)", "OLLAMA_MODELS", "ollama", Category::AiModels),
    tool("npm-global", "npm (paquetes globales)", "npm_config_prefix", "npm", Bin::NpmPrefix),
    tool("cargo-install", "cargo install", "CARGO_INSTALL_ROOT", "cargo", Bin::Sub("bin")),
    tool("go-bin", "go install", "GOBIN", "go-bin", Bin::Same),
    tool("pip-user", "pip --user", "PYTHONUSERBASE", "python", Bin::PythonUser),
    history("node-history", "Node.js (REPL)", "NODE_REPL_HISTORY", "node_repl_history"),
    history("python-history", "Python 3.13+ (REPL)", "PYTHON_HISTORY", "python_history"),
    history("sqlite-history", "SQLite", "SQLITE_HISTORY", "sqlite_history"),
    history("psql-history", "psql", "PSQL_HISTORY", "psql_history"),
    toolchain("rustup", "Rust (rustup)", "RUSTUP_HOME", "rustup", Bin::None),
    toolchain("cargo-home", "Rust (cargo)", "CARGO_HOME", "cargo-home", Bin::Sub("bin")),
    toolchain("gopath", "Go (GOPATH)", "GOPATH", "gopath", Bin::Sub("bin")),
    toolchain("gradle", "Gradle", "GRADLE_USER_HOME", "gradle", Bin::None),
    toolchain("dotnet-home", ".NET (dotnet)", "DOTNET_CLI_HOME", "dotnet", Bin::None),
    toolchain("android-user", "Android (AVD y ajustes)", "ANDROID_USER_HOME", "android", Bin::None),
    // Haskell y Elixir: paquetes, índices y compiladores descargados. Sin
    // `bin` en el PATH: cada una lo gestiona con su propia configuración.
    toolchain("cabal", "Haskell (cabal)", "CABAL_DIR", "cabal", Bin::None),
    toolchain("stack", "Haskell (Stack)", "STACK_ROOT", "stack", Bin::None),
    toolchain("mix", "Elixir (Mix)", "MIX_HOME", "mix", Bin::None),
    // Configuración de los REPL: solo si aún no existía (como las
    // toolchains), para no dejar de ver la que ya tienes.
    entry("ipython", "IPython (configuración y perfiles)", "IPYTHONDIR", "ipython", Category::Config),
    entry("jupyter", "Jupyter (configuración)", "JUPYTER_CONFIG_DIR", "jupyter", Category::Config),
    // Plugins de las shells. El perfil de Clink no va por variable: WTerminal
    // ya le pasa el suyo con `--profile` (`shell_assist::clink_profile_dir`), y
    // `CLINK_PROFILE` lo anularía.
    entry("starship-cache", "starship (caché)", "STARSHIP_CACHE", "starship", Category::Plugins),
    // Las acciones «Instalar» de WinGet y Chocolatey instalan en
    // `<esta carpeta>\<id>` si la variable existe
    // (`packages::actions::centralized_install`).
    entry("winget-programs", "Programas (WinGet y Chocolatey)", "WTERMINAL_PROGRAMS", "", Category::Programs),
    // Carpeta de proyectos de fábrica (`projects::github::projects_folder`).
    entry(PROJECTS_ENTRY, "Proyectos de GitHub", "WTERMINAL_PROJECTS", "", Category::Projects),
];

/// Id de la entrada de los proyectos de GitHub: apagarla en la vista de la
/// carpeta propia devuelve los clones a su sitio de siempre
/// ([`centralized_projects_dir`]).
const PROJECTS_ENTRY: &str = "projects";

/// Variables sin las que la carpeta `bin` de una entrada no funciona fuera de
/// WTerminal. Los lanzadores de `pip --user` (`ipython.exe`…) importan su
/// módulo de `PYTHONUSERBASE`; los proxies de rustup de `CARGO_HOME\bin`
/// buscan las toolchains en `RUSTUP_HOME`. El resto (`cargo install`,
/// `go install`, npm global) son ejecutables o shims autónomos.
#[rustfmt::skip]
const BIN_REQUIRES: &[(&str, &[&str])] = &[
    ("pip-user", &["PYTHONUSERBASE"]),
    ("cargo-home", &["CARGO_HOME", "RUSTUP_HOME"]),
];

/// Una ubicación que Ajustes mide y explica.
struct Location {
    id: String,
    label: String,
    /// La carpeta que se enseña y se abre.
    path: PathBuf,
    /// Si no está vacío, solo estos archivos de `path` cuentan para el
    /// tamaño (los ajustes comparten carpeta con otras cosas).
    files: Vec<PathBuf>,
    info: LocationInfo,
}

impl Location {
    fn new(id: &str, name: &str, path: PathBuf, info: LocationInfo) -> Location {
        Location {
            id: id.to_string(),
            label: format!("{name} ({})", display_path(&path)),
            path,
            files: Vec::new(),
            info,
        }
    }

    fn exists(&self) -> bool {
        if self.files.is_empty() {
            self.path.is_dir()
        } else {
            self.files.iter().any(|file| file.exists())
        }
    }

    fn size(&self) -> u64 {
        if self.files.is_empty() {
            directory_size(&self.path)
        } else {
            self.files
                .iter()
                .map(|file| match file.symlink_metadata() {
                    Ok(meta) if meta.is_dir() => directory_size(file),
                    Ok(meta) => meta.len(),
                    Err(_) => 0,
                })
                .sum()
        }
    }
}

/// La ruta como la escribiría el usuario: `%LOCALAPPDATA%\…`, `~/…`.
fn display_path(path: &Path) -> String {
    let mut prefixes: Vec<(PathBuf, &str)> = Vec::new();
    if cfg!(windows) {
        for (variable, shown) in [
            ("LOCALAPPDATA", "%LOCALAPPDATA%"),
            ("APPDATA", "%APPDATA%"),
            ("TEMP", "%TEMP%"),
        ] {
            if let Some(value) = std::env::var_os(variable) {
                prefixes.push((PathBuf::from(value), shown));
            }
        }
    }
    prefixes.push((crate::paths::home_dir(), "~"));
    // El prefijo más largo primero: %TEMP% vive dentro de %LOCALAPPDATA%.
    prefixes.sort_by_key(|(prefix, _)| std::cmp::Reverse(prefix.as_os_str().len()));
    for (prefix, shown) in prefixes {
        if let Ok(rest) = path.strip_prefix(&prefix) {
            let separator = if cfg!(windows) { "\\" } else { "/" };
            let rest = rest.to_string_lossy();
            return if rest.is_empty() {
                shown.to_string()
            } else {
                format!("{shown}{separator}{rest}")
            };
        }
    }
    path.to_string_lossy().into_owned()
}

/// Las carpetas que usa la propia WTerminal.
fn app_locations() -> Vec<Location> {
    let user_data = crate::paths::user_data_dir();
    let identity = crate::identity::current();
    let local = dirs::data_local_dir()
        .unwrap_or_else(|| crate::paths::home_dir().join(".local").join("share"));
    let mut locations = vec![
        Location {
            files: ["settings.json", "plugins-state.json", "path-integration-auto"]
                .iter()
                .map(|name| user_data.join(name))
                .collect(),
            ..Location::new(
                "app-settings",
                "Ajustes",
                user_data.join("settings.json"),
                info(
                    Safety::Keep,
                    "Tus preferencias de WTerminal: tema, fuentes, atajos, entornos visibles y todo lo que cambias en Ajustes. Lo crea y actualiza la propia app.",
                    "No lo borres: WTerminal volvería a la configuración de fábrica. Para llevártela a otro equipo usa «Exportar perfil».",
                ),
            )
        },
        Location::new(
            "app-scripts",
            "Biblioteca de scripts",
            crate::paths::default_scripts_dir(),
            info(
                Safety::Caution,
                "Los scripts que guardas en la Biblioteca para lanzarlos desde la app.",
                "Solo si ya no los quieres: se pierden los scripts guardados. WTerminal no la vacía nunca.",
            ),
        ),
        Location {
            files: vec![user_data.join("plugins"), user_data.join("plugin-backups")],
            ..Location::new(
                "app-plugins",
                "Plugins",
                user_data.join("plugins"),
                info(
                    Safety::Caution,
                    "Plugins instalados y las copias de seguridad que se guardan al actualizarlos.",
                    "Borrarlo desinstala los plugins. Para quitar uno, hazlo desde Ajustes → Plugins.",
                ),
            )
        },
        Location::new(
            "app-logs",
            "Registros",
            crate::logger::log_dir().unwrap_or_else(|| user_data.join("logs")),
            info(
                Safety::Safe,
                "Registro de diagnóstico de WTerminal (main.log y su copia rotada): sirve para investigar errores.",
                "Se puede borrar: se vuelve a crear. Rota solo al pasar de cierto tamaño, así que no crece sin límite.",
            ),
        ),
        Location {
            files: [
                "install-actions-cache.json",
                "install-actions-snapshot.json",
                "disk-cache.json",
                "hardware-cache.json",
            ]
            .iter()
            .map(|name| user_data.join(name))
            .collect(),
            ..Location::new(
                "app-detection-cache",
                "Caché de detección",
                user_data.clone(),
                info(
                    Safety::Regenerates,
                    "Resultados guardados de la detección (Entorno y dependencias, discos y hardware del banner) para que se abran al instante.",
                    "Se puede borrar: la próxima detección tarda un poco más y lo vuelve a crear.",
                ),
            )
        },
        Location::new(
            "app-webview",
            "Datos de la interfaz",
            webview_data_dir(&local),
            info(
                Safety::Regenerates,
                if cfg!(windows) {
                    "Datos de WebView2, el motor que dibuja la interfaz: su caché y su almacenamiento local. Tus ajustes no están aquí."
                } else {
                    "Datos de WebKitGTK, el motor que dibuja la interfaz: su caché y su almacenamiento local. Tus ajustes no están aquí."
                },
                "Se puede borrar con WTerminal cerrado: se vuelve a crear al abrirla. Con la app abierta está en uso.",
            ),
        ),
        Location::new(
            "app-session",
            "Temporales de sesión",
            crate::paths::temp_dir().join(identity.slug),
            info(
                Safety::Safe,
                "Archivos de usar y tirar de cada ejecución: scripts de inicio y banners de las pestañas, en una carpeta por proceso.",
                "Se puede borrar. WTerminal borra la suya al cerrarse y, al arrancar, las que dejaron procesos que ya no existen (cierres forzados o apagados).",
            ),
        ),
        Location::new(
            "app-projects",
            "Proyectos",
            PathBuf::from(crate::github::projects_folder()),
            info(
                Safety::Keep,
                "La carpeta de proyectos: los repositorios que clonas o anclas desde el panel Proyectos.",
                "No la borres a mano: son tus repositorios y tu trabajo. Para quitar uno, bórralo desde Proyectos.",
            ),
        ),
    ];
    if cfg!(windows) {
        let own = local.join(identity.name);
        locations.push(Location::new(
            "app-runtime",
            "Componentes del portable",
            own.join("runtime"),
            info(
                Safety::Regenerates,
                "ConPTY (conpty.dll y OpenConsole.exe) que el portable de un solo archivo saca de su propio .exe para poder abrir terminales. Solo lo usa el portable.",
                "Se puede borrar con WTerminal cerrado: el portable lo vuelve a extraer al abrirse. Las versiones antiguas se borran solas.",
            ),
        ));
        locations.push(Location::new(
            "app-clink",
            "Perfil de Clink",
            own.join("clink"),
            info(
                Safety::Regenerates,
                "Perfil de Clink de las pestañas de cmd: historial de órdenes, los valores de fábrica de las sugerencias y lo que configures con «clink set».",
                "Se puede borrar: se recrea con los valores de fábrica, pero pierdes el historial de cmd y tus ajustes de Clink.",
            ),
        ));
    }
    locations.retain(Location::exists);
    locations
}

/// Carpeta de datos del WebView: Tauri la crea en los datos locales con el
/// identificador de la app (`EBWebView` en Windows).
fn webview_data_dir(local: &Path) -> PathBuf {
    if cfg!(windows) {
        local.join("com.wterminal.terminal").join("EBWebView")
    } else {
        local.join("com.lterminal.terminal")
    }
}

/// Ubicaciones habituales fuera de la carpeta propia. Solo se muestran (con su
/// tamaño y su explicación) para saber qué ocupa espacio; WTerminal no las
/// vacía.
fn external_locations() -> Vec<Location> {
    let home = crate::paths::home_dir();
    let local = dirs::data_local_dir();
    let regenerates = |what: &str, how: &str| {
        info(
            Safety::Regenerates,
            &format!("Caché de descargas de {what}: lo que baja para no volver a descargarlo."),
            &format!("Se puede borrar ({how}): se vuelve a descargar cuando haga falta."),
        )
    };
    let mut locations = vec![
        Location::new(
            "cargo",
            "Cargo",
            home.join(".cargo"),
            info(
                Safety::Caution,
                "Rust: los programas instalados con «cargo install» (bin) y la caché del registro de crates y de las dependencias git.",
                "Con cuidado: borrarlo quita lo instalado con cargo install (y cargo mismo si vino con rustup). Las subcarpetas registry y git son caché y se vuelven a descargar.",
            ),
        ),
        Location::new(
            "rustup",
            "rustup",
            home.join(".rustup"),
            info(
                Safety::Caution,
                "Los compiladores de Rust (toolchains) y componentes que instala rustup.",
                "Borrarlo deja Rust sin compilador. Para quitar versiones usa «rustup toolchain uninstall».",
            ),
        ),
        Location::new(
            "go",
            "Go",
            home.join("go"),
            info(
                Safety::Caution,
                "GOPATH de Go: programas de «go install» (bin) y caché de módulos (pkg/mod).",
                "pkg/mod es caché («go clean -modcache»); bin contiene programas instalados.",
            ),
        ),
        Location::new(
            "nuget",
            "NuGet",
            home.join(".nuget"),
            regenerates("paquetes de .NET (NuGet)", "dotnet nuget locals all --clear"),
        ),
        Location::new(
            "gradle",
            "Gradle",
            home.join(".gradle"),
            info(
                Safety::Caution,
                "Dependencias y distribuciones descargadas por Gradle; puede tener gradle.properties con credenciales.",
                "caches y wrapper se vuelven a descargar; conserva gradle.properties.",
            ),
        ),
        Location::new(
            "maven",
            "Maven",
            home.join(".m2"),
            info(
                Safety::Caution,
                "Repositorio local de Maven (repository) y su configuración (settings.xml).",
                "repository se vuelve a descargar; settings.xml tiene tu configuración (y credenciales).",
            ),
        ),
        Location::new(
            "bun",
            "Bun",
            home.join(".bun"),
            info(
                Safety::Caution,
                "Bun: el propio runtime, los paquetes instalados con «bun add -g» y su caché.",
                "Borrarlo desinstala Bun y sus paquetes globales; install/cache se puede vaciar con «bun pm cache rm».",
            ),
        ),
        Location::new(
            "ollama",
            "Modelos de Ollama",
            crate::environments::ai::ollama_models_dir(),
            info(
                Safety::Caution,
                "Los modelos de IA locales descargados con Ollama (cada uno ocupa de cientos de MB a decenas de GB).",
                "Quita modelos con «ollama rm <modelo>» o desde Entorno y dependencias; se vuelven a descargar con «ollama pull».",
            ),
        ),
    ];
    if cfg!(windows) {
        if let Some(roaming) = dirs::config_dir() {
            locations.push(Location::new(
                "npm-global",
                "npm global",
                roaming.join("npm"),
                info(
                    Safety::Caution,
                    "Paquetes globales de npm (npm install -g): CLIs como Claude Code, Gemini CLI o TypeScript.",
                    "Borrarlo desinstala esos programas; usa «npm uninstall -g <paquete>».",
                ),
            ));
        }
        if let Some(local) = local.as_ref() {
            locations.push(Location::new(
                "npm-cache",
                "npm cache",
                local.join("npm-cache"),
                regenerates("npm", "npm cache clean --force"),
            ));
            locations.push(Location::new(
                "pip-cache",
                "pip cache",
                local.join("pip"),
                regenerates("pip", "pip cache purge"),
            ));
            locations.push(Location::new(
                "pnpm-store",
                "pnpm store",
                local.join("pnpm").join("store"),
                regenerates("pnpm", "pnpm store prune"),
            ));
            locations.push(Location::new(
                "yarn-cache",
                "Yarn cache",
                local.join("Yarn").join("Cache"),
                regenerates("Yarn", "yarn cache clean"),
            ));
            locations.push(Location::new(
                "uv-cache",
                "uv cache",
                local.join("uv").join("cache"),
                regenerates("uv", "uv cache clean"),
            ));
            locations.push(Location::new(
                "deno-cache",
                "Deno",
                local.join("deno"),
                regenerates("Deno", "deno clean"),
            ));
            locations.push(Location::new(
                "winget",
                "WinGet",
                local.join("Microsoft").join("WinGet").join("Packages"),
                info(
                    Safety::Keep,
                    "Programas portables que instaló WinGet (no es una caché).",
                    "No lo borres a mano: desinstala con «winget uninstall» o desde Entorno y dependencias.",
                ),
            ));
            locations.push(Location::new(
                "docker",
                "Docker",
                local.join("Docker").join("wsl"),
                info(
                    Safety::Keep,
                    "Discos virtuales de Docker Desktop: imágenes, contenedores y volúmenes.",
                    "No lo borres a mano: perderías todos los contenedores y volúmenes. Libera espacio con «docker system prune».",
                ),
            ));
        }
        locations.push(Location::new(
            "chocolatey",
            "Chocolatey",
            PathBuf::from(r"C:\ProgramData\chocolatey\lib"),
            info(
                Safety::Keep,
                "Paquetes instalados con Chocolatey.",
                "No lo borres a mano: desinstala con «choco uninstall <paquete>».",
            ),
        ));
        locations.push(Location::new(
            "scoop",
            "Scoop",
            home.join("scoop"),
            info(
                Safety::Keep,
                "Programas instalados con Scoop y su caché de descargas.",
                "Desinstala con «scoop uninstall»; la caché se vacía con «scoop cache rm *».",
            ),
        ));
        locations.extend(wsl_distro_locations());
    } else {
        let cache = home.join(".cache");
        locations.push(Location::new(
            "npm-cache",
            "npm cache",
            home.join(".npm"),
            regenerates("npm", "npm cache clean --force"),
        ));
        locations.push(Location::new(
            "pip-cache",
            "pip cache",
            cache.join("pip"),
            regenerates("pip", "pip cache purge"),
        ));
        locations.push(Location::new(
            "pnpm-store",
            "pnpm store",
            home.join(".local").join("share").join("pnpm").join("store"),
            regenerates("pnpm", "pnpm store prune"),
        ));
        locations.push(Location::new(
            "yarn-cache",
            "Yarn cache",
            cache.join("yarn"),
            regenerates("Yarn", "yarn cache clean"),
        ));
        locations.push(Location::new(
            "uv-cache",
            "uv cache",
            cache.join("uv"),
            regenerates("uv", "uv cache clean"),
        ));
        locations.push(Location::new(
            "deno-cache",
            "Deno",
            cache.join("deno"),
            regenerates("Deno", "deno clean"),
        ));
        locations.push(Location::new(
            "go-build",
            "Go (build)",
            cache.join("go-build"),
            regenerates("las compilaciones de Go", "go clean -cache"),
        ));
    }
    locations.retain(Location::exists);
    locations
}

/// El disco de cada distro WSL (su carpeta `BasePath` del registro): el
/// `ext4.vhdx` de WSL 2 o la carpeta `rootfs` de WSL 1.
#[cfg(windows)]
fn wsl_distro_locations() -> Vec<Location> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(lxss) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Lxss")
    else {
        return Vec::new();
    };
    lxss.enum_keys()
        .flatten()
        .filter_map(|guid| lxss.open_subkey(&guid).ok())
        .filter_map(|key| {
            let name: String = key.get_value("DistributionName").ok()?;
            let base: String = key.get_value("BasePath").ok()?;
            // Las de Docker Desktop ya cuentan en «Docker».
            if name.to_lowercase().starts_with("docker-desktop") {
                return None;
            }
            let base = PathBuf::from(base.trim_start_matches(r"\\?\"));
            let disk = base.join("ext4.vhdx");
            let mut location = Location::new(
                &format!("wsl-{}", name.to_lowercase()),
                &format!("WSL {name}"),
                base.clone(),
                info(
                    Safety::Keep,
                    &format!("Disco de la distribución WSL {name}: todo su sistema de archivos (programas, paquetes y tu carpeta personal de Linux)."),
                    "No lo borres a mano: elimina la distro con «wsl --unregister <nombre>», que borra todo su contenido. Para reducir espacio, limpia dentro de la distro (por ejemplo, la caché del gestor de paquetes).",
                ),
            );
            location.files = if disk.is_file() {
                vec![disk]
            } else {
                vec![base.join("rootfs")]
            };
            Some(location)
        })
        .collect()
}

#[cfg(not(windows))]
fn wsl_distro_locations() -> Vec<Location> {
    Vec::new()
}

/// Raíz por defecto: `%LOCALAPPDATA%\WTerminal\entornos` en Windows (datos
/// locales del usuario; `ProgramData` es compartido entre cuentas y permitiría
/// a otra plantar paquetes en estas cachés). En E2E vive dentro del perfil
/// aislado de la prueba para no escribir en el perfil real.
pub fn default_root() -> PathBuf {
    if std::env::var("LTERMINAL_E2E_TESTING").ok().as_deref() == Some("1") {
        if let Some(dir) = std::env::var_os("LTERMINAL_E2E_APP_DATA_DIR").map(PathBuf::from) {
            if dir.is_absolute() {
                return dir.join("entornos");
            }
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| crate::paths::home_dir().join(".local").join("share"))
        .join(crate::identity::current().name)
        .join("entornos")
}

/// `<carpeta propia>\proyectos` si «Proyectos de GitHub» está activa: la
/// carpeta de Proyectos de fábrica cuando el usuario no eligió otra
/// (`projects::github::projects_folder`). `None` si la categoría o su
/// elemento están apagados: los clones vuelven a su sitio de siempre, como
/// dice la vista de la carpeta propia.
pub fn centralized_projects_dir() -> Option<PathBuf> {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    if !preferences.toolchain_store_projects || entry_disabled(PROJECTS_ENTRY) {
        return None;
    }
    effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    )
    .map(|root| category_base(&root, Category::Projects))
}

/// Raíz efectiva según las preferencias: `None` si está desactivada.
pub fn effective_root(enabled: bool, configured: &str) -> Option<PathBuf> {
    if !enabled {
        return None;
    }
    let configured = configured.trim();
    Some(
        if configured.is_empty() || !Path::new(configured).is_absolute() {
            default_root()
        } else {
            PathBuf::from(configured)
        },
    )
}

fn cache_path(root: &Path, cache: &CacheDef) -> PathBuf {
    cache_path_in(category_base(root, cache.category), cache)
}

/// La carpeta de una entrada dentro de la de su categoría (`dir`).
fn cache_path_in(dir: PathBuf, cache: &CacheDef) -> PathBuf {
    // Programas no tiene subcarpeta: `<raíz>\programas\<id>`.
    if cache.subdir.is_empty() {
        dir
    } else {
        dir.join(cache.subdir)
    }
}

/// Entradas que se reubican con estas categorías. `existing_ollama_models`
/// dice si ya hay modelos en la carpeta de siempre de Ollama.
fn active_entries(
    categories: Categories,
    existing_ollama_models: bool,
) -> impl Iterator<Item = &'static CacheDef> {
    CACHES.iter().filter(move |cache| {
        categories.includes(cache.category)
            && !entry_disabled(cache.id)
            && !(cache.id == OLLAMA_ENTRY && existing_ollama_models && !adopted(cache.id))
            && !toolchain_preinstalled(cache)
    })
}

/// Variables que se añaden a los procesos lanzados. `user_defined` dice si el
/// usuario ya tiene esa variable en su entorno: entonces se respeta la suya.
fn overrides_for(
    root: Option<&Path>,
    categories: Categories,
    existing_ollama_models: bool,
    user_defined: &dyn Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let Some(root) = root else {
        return Vec::new();
    };
    active_entries(categories, existing_ollama_models)
        .filter(|cache| !user_defined(cache.variable))
        .map(|cache| {
            (
                cache.variable.to_string(),
                cache_path(root, cache).to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// Carpetas `bin` de las herramientas nuevas que van delante en el PATH de
/// WTerminal (pestañas, sondas y detección). Las de `pip --user` en Windows
/// dependen de la versión de Python: se añaden las que ya existen.
fn extra_path_dirs(
    root: Option<&Path>,
    categories: Categories,
    windows: bool,
    user_defined: &dyn Fn(&str) -> bool,
) -> Vec<PathBuf> {
    let Some(root) = root else {
        return Vec::new();
    };
    active_entries(categories, false)
        .filter(|cache| !user_defined(cache.variable))
        .flat_map(|cache| bin_dirs(cache, &cache_path(root, cache), windows))
        .collect()
}

/// Las carpetas `bin` de una entrada ya reubicada en `base`.
fn bin_dirs(cache: &CacheDef, base: &Path, windows: bool) -> Vec<PathBuf> {
    match cache.bin {
        Bin::None => Vec::new(),
        Bin::Same => vec![base.to_path_buf()],
        Bin::Sub(sub) => vec![base.join(sub)],
        Bin::NpmPrefix if windows => vec![base.to_path_buf()],
        Bin::NpmPrefix => vec![base.join("bin")],
        Bin::PythonUser if windows => {
            let mut versions: Vec<PathBuf> = std::fs::read_dir(base)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|entry| entry.file_name().to_string_lossy().starts_with("Python"))
                        .map(|entry| entry.path().join("Scripts"))
                        .collect()
                })
                .unwrap_or_default();
            versions.sort();
            versions.reverse();
            versions
        }
        Bin::PythonUser => vec![base.join("bin")],
    }
}

/// De las variables que inyecta WTerminal (`overrides`), las que necesitan las
/// carpetas `bin` publicadas (`BIN_REQUIRES`). Una entrada sin carpetas (p. ej.
/// `pip --user` antes de instalar nada) no publica su variable: así no cambia
/// dónde instala `pip --user` fuera de WTerminal sin motivo.
fn required_variables(
    root: Option<&Path>,
    categories: Categories,
    windows: bool,
    overrides: &[(String, String)],
    user_defined: &dyn Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let Some(root) = root else {
        return Vec::new();
    };
    let mut required = Vec::new();
    for (id, variables) in BIN_REQUIRES {
        let Some(cache) = active_entries(categories, false).find(|cache| cache.id == *id) else {
            continue;
        };
        if user_defined(cache.variable)
            || bin_dirs(cache, &cache_path(root, cache), windows).is_empty()
        {
            continue;
        }
        for variable in *variables {
            if let Some(pair) = overrides.iter().find(|(name, _)| name == variable) {
                if !required.contains(pair) {
                    required.push(pair.clone());
                }
            }
        }
    }
    required
}

/// Clave para comparar carpetas: barras normales, sin la del final y, en
/// Windows, sin mayúsculas (`C:\Users\Ana\` y `c:/users/ana` son la misma).
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_string()
    }
}

fn same_dir(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

/// `inner` es `outer` o está dentro de ella, comparando como [`same_dir`]
/// y por componentes completos (`npm-cache` no está dentro de `npm`).
fn within(inner: &Path, outer: &Path) -> bool {
    let inner = path_key(inner);
    let outer = path_key(outer);
    inner == outer || inner.starts_with(&format!("{outer}/"))
}

/// La raíz de un disco (`D:\`, `\\servidor\recurso`, `/`): no tiene carpeta
/// madre.
fn is_disk_root(path: &Path) -> bool {
    path.parent().is_none()
}

/// La ruta con sus enlaces, uniones y nombres cortos (`ADMINI~1`) resueltos,
/// para comparar carpetas que quizá aún no existen: se resuelve la parte que
/// ya existe y se le añade el resto tal cual. Sin el prefijo `\\?\` que pone
/// Windows. Si no existe nada de la ruta, la devuelve igual.
fn resolved(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            let mut real = without_verbatim_prefix(real);
            for part in rest.iter().rev() {
                real.push(part);
            }
            return real;
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Una de las dos rutas es la otra o está dentro de ella, con enlaces,
/// uniones y nombres cortos resueltos y, en Windows, sin mayúsculas.
/// `store_adopt` la usa para no borrar un original que es (o contiene) su
/// propia copia.
pub fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = resolved(left);
    let right = resolved(right);
    within(&left, &right) || within(&right, &left)
}

/// La variable la definió el usuario (y manda la suya). Si vale justo la
/// carpeta que pondría WTerminal no cuenta: es la que publicó la integración
/// con el PATH, y tratarla como del usuario haría que la siguiente
/// sincronización retirara su propia carpeta `bin`.
fn defined_by_user(root: Option<&Path>, variable: &str) -> bool {
    let Some(value) = std::env::var_os(variable) else {
        return false;
    };
    let ours = root.and_then(|root| {
        CACHES
            .iter()
            .find(|cache| cache.variable == variable)
            .map(|cache| cache_path(root, cache))
    });
    !ours.is_some_and(|ours| same_dir(Path::new(&value), &ours))
}

/// Dónde guarda cada herramienta lo suyo cuando WTerminal no lo centraliza:
/// su ubicación de siempre. Ajustes la mide y la enseña igual, para que se
/// vea el espacio aunque la categoría esté apagada.
fn system_location(
    cache: &CacheDef,
    windows: bool,
    home: &Path,
    local: Option<&Path>,
    roaming: Option<&Path>,
    temp: &Path,
) -> Option<PathBuf> {
    let local = |rest: &[&str]| {
        local.map(|dir| {
            rest.iter()
                .fold(dir.to_path_buf(), |path, part| path.join(part))
        })
    };
    let roaming = |rest: &[&str]| {
        roaming.map(|dir| {
            rest.iter()
                .fold(dir.to_path_buf(), |path, part| path.join(part))
        })
    };
    let home = |rest: &[&str]| {
        Some(
            rest.iter()
                .fold(home.to_path_buf(), |path, part| path.join(part)),
        )
    };
    match (cache.id, windows) {
        ("npm", true) => local(&["npm-cache"]),
        ("npm", false) => home(&[".npm"]),
        ("yarn", true) => local(&["Yarn", "Cache"]),
        ("yarn", false) => home(&[".cache", "yarn"]),
        ("bun", _) => home(&[".bun", "install", "cache"]),
        ("deno", true) => local(&["deno"]),
        ("deno", false) => home(&[".cache", "deno"]),
        ("pip", true) => local(&["pip", "Cache"]),
        ("pip", false) => home(&[".cache", "pip"]),
        ("uv", true) => local(&["uv", "cache"]),
        ("uv", false) => home(&[".cache", "uv"]),
        ("go-mod", _) => home(&["go", "pkg", "mod"]),
        ("go-build", true) => local(&["go-build"]),
        ("go-build", false) => home(&[".cache", "go-build"]),
        ("nuget", _) => home(&[".nuget", "packages"]),
        ("coursier", true) => local(&["Coursier", "cache"]),
        ("coursier", false) => home(&[".cache", "coursier"]),
        ("composer", true) => local(&["Composer"]),
        ("composer", false) => home(&[".cache", "composer"]),
        ("downloads", _) => Some(temp.to_path_buf()),
        ("huggingface", _) => home(&[".cache", "huggingface"]),
        (OLLAMA_ENTRY, _) => home(&[".ollama", "models"]),
        ("npm-global", true) => roaming(&["npm"]),
        ("npm-global", false) => home(&[".npm-global"]),
        // Solo `bin`: el resto de CARGO_HOME (registro, config.toml,
        // credentials.toml) es de «Rust (cargo)», que ya lo mide entero.
        ("cargo-install", _) => std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| home(&[".cargo"]))
            .map(|cargo_home| cargo_home.join("bin")),
        ("go-bin", _) => std::env::var_os("GOPATH")
            .map(|gopath| PathBuf::from(gopath).join("bin"))
            .or_else(|| home(&["go", "bin"])),
        ("pip-user", true) => roaming(&["Python"]),
        // Fuera de Windows `pip --user` usa `~/.local`, que comparte con
        // `~/.local/bin` y `~/.local/share` de todas las aplicaciones: lo suyo
        // está en `lib/pythonX.Y`. Nunca se trae ([`adoptable`]).
        ("pip-user", false) => home(&[".local", "lib"]),
        ("node-history", _) => home(&[".node_repl_history"]),
        ("python-history", _) => home(&[".python_history"]),
        ("sqlite-history", _) => home(&[".sqlite_history"]),
        ("psql-history", true) => roaming(&["postgresql", "psql_history"]),
        ("psql-history", false) => home(&[".psql_history"]),
        ("rustup", _) => home(&[".rustup"]),
        ("cargo-home", _) => home(&[".cargo"]),
        ("gopath", _) => home(&["go"]),
        ("gradle", _) => home(&[".gradle"]),
        ("dotnet-home", _) => home(&[".dotnet"]),
        ("android-user", _) => home(&[".android"]),
        ("cabal", true) => roaming(&["cabal"]),
        ("cabal", false) => home(&[".cabal"]),
        ("stack", true) => roaming(&["stack"]),
        ("stack", false) => home(&[".stack"]),
        ("mix", _) => home(&[".mix"]),
        ("pub", true) => local(&["Pub", "Cache"]),
        ("pub", false) => home(&[".pub-cache"]),
        ("ipython", _) => home(&[".ipython"]),
        ("jupyter", _) => home(&[".jupyter"]),
        ("starship-cache", true) => local(&["starship"]),
        ("starship-cache", false) => home(&[".cache", "starship"]),
        // Sin centralizar, WinGet decide: Program Files para los instaladores y
        // sus paquetes portables en LOCALAPPDATA, que es lo que se mide aquí.
        ("winget-programs", true) => local(&["Microsoft", "WinGet", "Packages"]),
        ("winget-programs", false) => home(&[".local"]),
        ("projects", _) => Some(crate::paths::default_projects_dir()),
        _ => None,
    }
}

/// `true` si Ollama ya tiene modelos en su carpeta de siempre.
/// Una toolchain que ya está en su carpeta de siempre no se reubica: con la
/// variable apuntando a una carpeta vacía, rustup, cargo o Gradle dejarían de
/// ver lo que ya tienes instalado. La categoría solo sirve para instalaciones
/// nuevas, igual que la regla de Ollama.
fn toolchain_preinstalled(cache: &CacheDef) -> bool {
    // La configuración de los REPL sigue la misma regla: con IPYTHONDIR en
    // una carpeta vacía, IPython dejaría de ver tus perfiles. Lo ya instalado
    // se trae a la carpeta propia a propósito, con «Traer lo ya instalado»
    // (`store_adopt`), y entonces sí se reubica.
    if !matches!(cache.category, Category::Toolchains | Category::Config) {
        return false;
    }
    if adopted(cache.id) {
        return false;
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    system_location(
        cache,
        cfg!(windows),
        &crate::paths::home_dir(),
        local.as_deref(),
        roaming.as_deref(),
        &std::env::temp_dir(),
    )
    .is_some_and(|path| path.exists())
}

fn ollama_has_existing_models() -> bool {
    let default_dir = std::env::var_os("OLLAMA_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().join(".ollama").join("models"));
    std::fs::read_dir(default_dir.join("manifests"))
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// Carpetas `bin` de las herramientas nuevas con las preferencias guardadas:
/// las mismas que van delante en el PATH de WTerminal. La integración con el
/// PATH las pone también en el del usuario (`path_integration::sync_tool_bins`).
pub fn published_bin_dirs() -> Vec<PathBuf> {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    let root = effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    );
    let user_defined = |variable: &str| defined_by_user(root.as_deref(), variable);
    extra_path_dirs(
        root.as_deref(),
        Categories::from_preferences(&preferences),
        cfg!(windows),
        &user_defined,
    )
}

/// Variables que la integración con el PATH publica junto a esas carpetas
/// `bin`, para que sus programas funcionen también fuera de WTerminal
/// (`BIN_REQUIRES`). Nunca incluye una variable que ya definió el usuario.
pub fn published_variables() -> Vec<(String, String)> {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    let root = effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    );
    let categories = Categories::from_preferences(&preferences);
    let user_defined = |variable: &str| defined_by_user(root.as_deref(), variable);
    let overrides = overrides_for(
        root.as_deref(),
        categories,
        ollama_has_existing_models(),
        &user_defined,
    );
    let mut variables = required_variables(
        root.as_deref(),
        categories,
        cfg!(windows),
        &overrides,
        &user_defined,
    );
    // Lo traído con «Traer lo ya instalado»: tras confirmar se borra el
    // original, y sin la variable en el usuario rustup, cargo o IPython
    // dejarían de encontrar lo suyo fuera de WTerminal.
    for cache in CACHES.iter().filter(|cache| adopted(cache.id)) {
        if let Some(pair) = overrides.iter().find(|(name, _)| name == cache.variable) {
            if !variables.contains(pair) {
                variables.push(pair.clone());
            }
        }
    }
    variables
}

/// Lo que «Traer lo ya instalado» (`store_adopt`) puede traer por variable:
/// cada entrada con su ubicación de siempre y su sitio en la carpeta propia.
/// Fuera quedan las descargas (temporales), los programas (van con una unión,
/// aparte), los proyectos (tienen su propia carpeta en Ajustes) y lo que
/// comparte carpeta con otras cosas ([`adoptable`]).
pub struct AdoptableEntry {
    pub id: String,
    pub label: String,
    pub category: Category,
    pub variable: &'static str,
    pub source: PathBuf,
    pub destination: PathBuf,
    /// El usuario ya define la variable: manda la suya.
    pub user_defined: bool,
    /// Por qué no se puede traer sin peligro aunque tenga contenido. `None`
    /// si se puede. `store_adopt` la enseña bloqueada con
    /// [`AdoptConflict::reason`]; lo ya traído (en su diario) sigue saliendo.
    pub conflict: Option<AdoptConflict>,
}

/// Lo que impide traer una entrada: copiar y luego confirmar (que borra el
/// original) perdería datos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdoptConflict {
    /// El destino es el origen, está dentro de él o lo contiene (una carpeta
    /// de categoría que coincide con la de siempre, o `~/.local` en Linux con
    /// la raíz de fábrica dentro): no se copiaría nada, o la copia se
    /// metería dentro de sí misma, y confirmar borraría la única copia.
    Destination,
    /// El origen está dentro de la carpeta propia (o de la carpeta de otra
    /// entrada) o la contiene: confirmar borraría parte de la carpeta propia.
    Store,
    /// Otra entrada tiene el mismo origen: confirmar una borraría lo de la
    /// otra.
    SharedSource,
}

impl AdoptConflict {
    /// El motivo que ve el usuario, como los demás de `store_adopt`.
    pub fn reason(self) -> &'static str {
        match self {
            AdoptConflict::Destination => "Su sitio en la carpeta propia es su carpeta de siempre, o está dentro de ella o la contiene: no hay nada que traer y confirmar borraría la única copia. Elige otra carpeta para esta categoría.",
            AdoptConflict::Store => "Su carpeta de siempre está dentro de la carpeta propia o la contiene: confirmar borraría parte de la carpeta propia.",
            AdoptConflict::SharedSource => "Otro elemento usa la misma carpeta de siempre: confirmar uno borraría lo del otro.",
        }
    }
}

/// Si una entrada se puede traer por variable. No se traen nunca:
/// - Las descargas, los programas y los proyectos (ver [`AdoptableEntry`]).
/// - «cargo install»: lo suyo vive dentro de CARGO_HOME, en `bin` junto a
///   los proxies de rustup (`cargo`, `rustc`, `rustup`) y con su registro de
///   lo instalado (`.crates.toml`) en la raíz, mezclado con el registro de
///   paquetes, `config.toml` y `credentials.toml`. Traer CARGO_HOME entero
///   borraba todo eso al confirmar, y traer solo `bin` se llevaría los
///   proxies. «Rust (cargo)» ya trae CARGO_HOME entero, con lo instalado.
/// - `pip --user` fuera de Windows: su carpeta es `~/.local`, compartida con
///   `~/.local/bin` y `~/.local/share` de todas las aplicaciones (y la raíz
///   de fábrica de LTerminal vive dentro).
fn adoptable(cache: &CacheDef, windows: bool) -> bool {
    if matches!(
        cache.category,
        Category::Downloads | Category::Programs | Category::Projects
    ) {
        return false;
    }
    match cache.id {
        "cargo-install" => false,
        "pip-user" => windows,
        _ => true,
    }
}

pub fn adoptable_entries(root: &Path) -> Vec<AdoptableEntry> {
    let home = crate::paths::home_dir();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    let temp = std::env::temp_dir();
    let mut entries: Vec<AdoptableEntry> = CACHES
        .iter()
        .filter(|cache| adoptable(cache, cfg!(windows)))
        .filter_map(|cache| {
            let source = system_location(
                cache,
                cfg!(windows),
                &home,
                local.as_deref(),
                roaming.as_deref(),
                &temp,
            )?;
            Some(AdoptableEntry {
                id: cache.id.to_string(),
                label: cache.name.to_string(),
                category: cache.category,
                variable: cache.variable,
                source,
                destination: cache_path(root, cache),
                user_defined: defined_by_user(Some(root), cache.variable),
                conflict: None,
            })
        })
        .collect();
    // Todo lo que ocupa la carpeta propia, aunque no se pueda traer ni esté
    // activo: las carpetas de todas las entradas y las de las categorías.
    let store_dirs: Vec<PathBuf> = CACHES.iter().map(|cache| cache_path(root, cache)).collect();
    let bases: Vec<PathBuf> = Category::ALL
        .into_iter()
        .map(|category| category_base(root, category))
        .collect();
    mark_conflicts(&mut entries, root, &store_dirs, &bases);
    entries
}

/// Marca las entradas que no se pueden traer sin peligro
/// ([`AdoptConflict`]). Compara con las rutas resueltas ([`resolved`]) y, en
/// Windows, sin mayúsculas: `%APPDATA%\Python` y `herramientas\python` son la
/// misma carpeta si la de Herramientas es `%APPDATA%`.
fn mark_conflicts(
    entries: &mut [AdoptableEntry],
    root: &Path,
    store_dirs: &[PathBuf],
    bases: &[PathBuf],
) {
    let overlap = |left: &Path, right: &Path| within(left, right) || within(right, left);
    let root = resolved(root);
    let store_dirs: Vec<PathBuf> = store_dirs.iter().map(|dir| resolved(dir)).collect();
    let bases: Vec<PathBuf> = bases.iter().map(|dir| resolved(dir)).collect();
    let sources: Vec<PathBuf> = entries
        .iter()
        .map(|entry| resolved(&entry.source))
        .collect();
    for (index, entry) in entries.iter_mut().enumerate() {
        let source = &sources[index];
        let destination = resolved(&entry.destination);
        entry.conflict = if overlap(source, &destination) {
            Some(AdoptConflict::Destination)
        } else if overlap(source, &root)
            || store_dirs.iter().any(|dir| overlap(source, dir))
            || bases.iter().any(|base| within(base, source))
        {
            Some(AdoptConflict::Store)
        } else if sources
            .iter()
            .enumerate()
            .any(|(other, path)| other != index && same_dir(path, source))
        {
            Some(AdoptConflict::SharedSource)
        } else {
            None
        };
    }
}

/// La categoría de una entrada por su id.
pub fn entry_category(id: &str) -> Option<Category> {
    CACHES
        .iter()
        .find(|cache| cache.id == id)
        .map(|cache| cache.category)
}

/// Recalcula las variables con las preferencias guardadas y las publica para
/// todo lo que lance la app. Se llama al arrancar y cada vez que se guardan
/// los Ajustes: afecta a las terminales que se abran a partir de entonces.
pub fn refresh_environment() {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    let root = effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    );
    let categories = Categories::from_preferences(&preferences);
    let existing_ollama = ollama_has_existing_models();
    let user_defined = |variable: &str| defined_by_user(root.as_deref(), variable);
    if let Some(root) = root.as_deref() {
        // Las carpetas existen desde el principio para poder abrirlas en
        // Ajustes, y las de historial para que el REPL pueda crear su archivo.
        let mut dirs = vec![category_base(root, Category::Caches)];
        dirs.extend(
            active_entries(categories, existing_ollama).filter_map(|cache| {
                let path = cache_path(root, cache);
                if cache.file {
                    path.parent().map(Path::to_path_buf)
                } else {
                    Some(path)
                }
            }),
        );
        prepare_root(root, same_dir(root, &default_root()), &dirs);
    }
    crate::process::set_extra_environment(overrides_for(
        root.as_deref(),
        categories,
        existing_ollama,
        &user_defined,
    ));
    let bins = extra_path_dirs(root.as_deref(), categories, cfg!(windows), &user_defined);
    for dir in &bins {
        let _ = std::fs::create_dir_all(dir);
    }
    crate::process::set_extra_path(
        bins.iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect(),
    );
    crate::path_env::clear_which_cache();
}

/// Crea las carpetas (`dirs`) y deja la marca [`STORE_MARKER`] solo si la
/// raíz es de WTerminal: la de fábrica (`factory`), o una que no existía o
/// estaba vacía antes de crear nada en ella. Una carpeta elegida a mano que
/// ya tenía otras cosas (`D:\Desarrollo`, la carpeta personal) nunca se
/// marca, ni una raíz de disco: el desinstalador ofrece borrar entera una
/// carpeta marcada (`platform::first_run`).
fn prepare_root(root: &Path, factory: bool, dirs: &[PathBuf]) {
    let ours = factory || (root_is_unused(root) && !is_disk_root(root));
    for dir in dirs {
        let _ = std::fs::create_dir_all(dir);
    }
    if ours {
        let _ = std::fs::create_dir_all(root);
        let marker = root.join(STORE_MARKER);
        if !marker.exists() {
            let _ = std::fs::write(&marker, STORE_MARKER_TEXT);
        }
    }
}

/// La carpeta no existe o está vacía. Si no se puede leer, cuenta como
/// usada: nunca se marca una carpeta sin saber qué tiene.
fn root_is_unused(root: &Path) -> bool {
    match std::fs::read_dir(root) {
        Ok(mut entries) => entries.next().is_none(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Tamaño de una carpeta sin seguir enlaces ni uniones (evita bucles y contar
/// dos veces lo que apunta fuera).
pub fn directory_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCache {
    pub id: String,
    pub name: String,
    pub variable: String,
    pub path: String,
    pub bytes: u64,
    /// El usuario ya define la variable: se usa su carpeta, no la propia.
    pub user_defined: bool,
    /// Dónde está lo que se mide: `own` (la carpeta propia, centralizado),
    /// `user` (la variable del usuario) o `system` (la ubicación de siempre de
    /// la herramienta, porque no se centraliza).
    pub location: &'static str,
    pub category: Category,
    /// La categoría está activa y la entrada se aplica a las pestañas nuevas.
    pub active: bool,
    /// `false` si no se ha medido: una toolchain que sigue en su sitio de
    /// siempre (`~\.rustup`, `~\.cargo`…) tarda decenas de segundos en
    /// medirse y ya sale en «Ubicaciones externas».
    pub measured: bool,
    /// La medición sigue en marcha (carpeta grande): no terminó dentro de
    /// [`STATUS_MEASURE_BUDGET`] y su tamaño llega en la próxima apertura.
    pub measuring: bool,
    pub info: LocationInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLocation {
    pub id: String,
    pub label: String,
    pub path: String,
    pub bytes: u64,
    /// `app`: una carpeta de WTerminal; `external`: de otra herramienta.
    pub group: &'static str,
    pub info: LocationInfo,
}

fn cache_info(cache: &CacheDef, user_defined: bool) -> LocationInfo {
    match cache.category {
        Category::Caches => {}
        Category::Downloads => {
            return info(
                Safety::Safe,
                &format!("Archivos que descargan las acciones del panel antes de instalarlos (variable {}).", cache.variable),
                "Se puede borrar: son temporales y se vuelven a descargar si hace falta.",
            )
        }
        Category::AiModels if cache.id == OLLAMA_ENTRY => {
            return info(
                Safety::Caution,
                &format!("Modelos de Ollama cuando el servidor se arranca desde una pestaña de WTerminal ({}). Solo se usa si aún no tenías modelos en la carpeta de siempre: los que ya tienes no se mueven.", cache.variable),
                "Borrarla quita los modelos descargados aquí; se pueden volver a descargar con «ollama pull». Mejor «Borrar» cada modelo desde el panel.",
            )
        }
        Category::AiModels => {
            return info(
                Safety::Regenerates,
                &format!("Modelos y conjuntos de datos que descargan las bibliotecas de Hugging Face ({}).", cache.variable),
                "Se puede borrar: se vuelven a descargar al usarlos, pero pueden ser muchos gigas.",
            )
        }
        Category::Tools => {
            return info(
                Safety::Caution,
                &format!("Herramientas instaladas desde WTerminal con {} ({}). Su carpeta de programas va delante en el PATH de WTerminal; lo que ya tenías instalado sigue donde estaba.", cache.name, cache.variable),
                "Borrarla desinstala esas herramientas. Mejor desinstalarlas desde el panel.",
            )
        }
        Category::Toolchains => {
            return info(
                Safety::Keep,
                &format!("{} instalado desde WTerminal ({}). Solo se usa si no lo tenías ya en su carpeta de siempre: lo instalado no se mueve. Fuera de WTerminal esa instalación no se ve salvo que definas la variable en tu usuario.", cache.name, cache.variable),
                "No la borres a mano: desinstala con su propia herramienta (rustup self uninstall, etc.). Borrarla quita la toolchain completa.",
            )
        }
        Category::Projects => {
            return info(
                Safety::Keep,
                &format!("Proyectos que clonas o creas desde WTerminal ({}): cada uno en <propietario>\\<repositorio>. Solo si no elegiste otra carpeta de Proyectos en Ajustes; los que ya tenías siguen donde estaban.", cache.variable),
                "No la borres: son tus repositorios, con su código y su historial de Git.",
            )
        }
        Category::Programs => {
            return info(
                Safety::Keep,
                &format!("Programas instalados con WinGet desde las acciones de WTerminal ({}): cada uno en su carpeta con el identificador del paquete. Los que ya tenías siguen donde estaban.", cache.variable),
                "No la borres a mano: desinstala cada programa desde el panel o con winget uninstall. Borrarla dejaría programas rotos y entradas huérfanas en «Aplicaciones instaladas».",
            )
        }
        Category::ReplHistory => {
            return info(
                Safety::Safe,
                &format!("Historial de órdenes de {} ({}).", cache.name, cache.variable),
                "Se puede borrar: solo se pierde el historial de ese intérprete.",
            )
        }
        Category::Config => {
            return info(
                Safety::Caution,
                &format!("Configuración y perfiles de {} ({}). Solo se usa si aún no la tenías en su sitio de siempre, o si la trajiste con «Traer lo ya instalado».", cache.name, cache.variable),
                "Borrarla quita tu configuración de ese intérprete; se vuelve a crear vacía al abrirlo.",
            )
        }
        Category::Plugins => {
            return info(
                Safety::Regenerates,
                &format!("Caché de {} ({}).", cache.name, cache.variable),
                "Se puede borrar: se vuelve a generar sola.",
            )
        }
    }
    if user_defined {
        info(
            Safety::Regenerates,
            &format!(
                "Caché de descargas de {} en la carpeta que fijaste con {}.",
                cache.name, cache.variable
            ),
            "Es tu carpeta: WTerminal la usa pero no la vacía. Borrarla solo obliga a volver a descargar.",
        )
    } else {
        info(
            Safety::Regenerates,
            &format!(
                "Caché de descargas de {}: WTerminal la guarda aquí (variable {}) para que no se repartan por el sistema.",
                cache.name, cache.variable
            ),
            "Se puede borrar: se vuelve a descargar cuando haga falta. «Vaciar cachés» lo hace por ti.",
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub enabled: bool,
    pub root: String,
    pub default_root: String,
    pub caches: Vec<StoreCache>,
    pub cache_bytes: u64,
}

/// Estado y tamaño de las cachés propias. Solo mide carpetas de WTerminal (o
/// las que el usuario haya definido para esas variables): responde en cuanto
/// se abre Ajustes. Las ubicaciones externas van aparte, en
/// [`external_sizes`], porque `~/.rustup` o WinGet tardan decenas de segundos.
pub fn status() -> StoreStatus {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    let enabled = preferences.toolchain_store_enabled;
    let categories = Categories::from_preferences(&preferences);
    let existing_ollama = ollama_has_existing_models();
    let root = effective_root(true, &preferences.toolchain_store_dir).unwrap_or_else(default_root);
    let started = Instant::now();
    let caches = {
        let home = crate::paths::home_dir();
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
        let temp = std::env::temp_dir();
        let pending: Vec<_> = CACHES
            .iter()
            .map(|cache| {
                let user_value = std::env::var_os(cache.variable)
                    .filter(|_| defined_by_user(Some(&root), cache.variable))
                    .map(PathBuf::from);
                let centralized = enabled
                    && active_entries(categories, existing_ollama)
                        .any(|active| active.id == cache.id);
                let (path, location) = match (&user_value, centralized) {
                    (Some(value), _) => (value.clone(), "user"),
                    (None, true) => (cache_path(&root, cache), "own"),
                    (None, false) => system_location(
                        cache,
                        cfg!(windows),
                        &home,
                        local.as_deref(),
                        roaming.as_deref(),
                        &temp,
                    )
                    .map(|path| (path, "system"))
                    .unwrap_or_else(|| (cache_path(&root, cache), "own")),
                };
                let measured = path.clone();
                let file = cache.file;
                // Abrir Ajustes no debe esperar a recorrer una toolchain entera.
                let skip = location == "system" && cache.category == Category::Toolchains;
                // Cada medición va en su propio hilo, que puede seguir después
                // de responder: lo que no termine a tiempo queda en la caché de
                // tamaños para la próxima apertura.
                let (sender, receiver) = std::sync::mpsc::channel();
                if skip {
                    let _ = sender.send(0);
                } else {
                    std::thread::spawn(move || {
                        // Solo las cachés propias se miden siempre en el
                        // momento (al vaciarlas tiene que verse lo liberado);
                        // las del usuario y las de siempre no se tocan desde
                        // aquí y se reutilizan unos minutos.
                        let bytes = if location == "own" {
                            measure_path(&measured, file)
                        } else {
                            cached_system_size(&measured, file)
                        };
                        let _ = sender.send(bytes);
                    });
                }
                (cache, path, user_value.is_some(), location, skip, receiver)
            })
            .collect();
        pending
            .into_iter()
            .map(|(cache, path, user_defined, location, skip, receiver)| {
                let left = STATUS_MEASURE_BUDGET.saturating_sub(started.elapsed());
                let bytes = receiver.recv_timeout(left).ok();
                StoreCache {
                    id: cache.id.to_string(),
                    name: cache.name.to_string(),
                    variable: cache.variable.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    bytes: bytes.unwrap_or(0),
                    user_defined,
                    location,
                    category: cache.category,
                    active: enabled
                        && active_entries(categories, existing_ollama)
                            .any(|active| active.id == cache.id),
                    measured: !skip && bytes.is_some(),
                    measuring: !skip && bytes.is_none(),
                    info: cache_info(cache, user_defined),
                }
            })
            .collect::<Vec<_>>()
    };
    // «Vaciar cachés» solo cuenta y borra las cachés de la carpeta propia, y
    // las mismas que borraría ([`clearable_caches`]): si no, ofrecía vaciar
    // unos GB y luego no liberaba nada.
    let clearable = clearable_caches(
        &|category| category_base(&root, category),
        &crate::paths::home_dir(),
        &|variable| defined_by_user(Some(&root), variable),
    );
    let cache_bytes = caches
        .iter()
        .filter(|cache| cache.location == "own" && cache.category == Category::Caches)
        .filter(|cache| {
            clearable
                .iter()
                .any(|path| same_dir(path, Path::new(&cache.path)))
        })
        .map(|cache| cache.bytes)
        .sum();
    StoreStatus {
        enabled,
        root: root.to_string_lossy().into_owned(),
        default_root: default_root().to_string_lossy().into_owned(),
        caches,
        cache_bytes,
    }
}

/// Lo más que espera Ajustes a las mediciones de la carpeta propia. Con las
/// variables apuntando a carpetas del usuario grandes (en la VM con todo el
/// catálogo: GOPATH, `pip --user` con PyTorch y TensorFlow, el npm global con
/// cientos de miles de archivos) medirlas pasaba de 20 s y la lista de
/// cachés no aparecía. Lo que no termina sale sin medir (`measured: false`) y
/// se completa en la siguiente apertura.
const STATUS_MEASURE_BUDGET: Duration = Duration::from_secs(3);

/// Lo que responde `toolchain_store_status` si la medición no pudo terminar
/// (el hilo de trabajo acabó con un pánico): la carpeta, sin tamaños.
fn status_unavailable() -> StoreStatus {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    let root = effective_root(true, &preferences.toolchain_store_dir).unwrap_or_else(default_root);
    StoreStatus {
        enabled: preferences.toolchain_store_enabled,
        root: root.to_string_lossy().into_owned(),
        default_root: default_root().to_string_lossy().into_owned(),
        caches: Vec::new(),
        cache_bytes: 0,
    }
}

/// Las ubicaciones externas se miden una vez y se reutilizan unos minutos:
/// recorrer `~/.rustup`, `~/.cargo` o los paquetes de WinGet cuesta decenas
/// de segundos y su tamaño apenas cambia mientras Ajustes está abierto.
const EXTERNAL_SIZES_TTL: Duration = Duration::from_secs(600);

fn measure_path(path: &Path, file: bool) -> u64 {
    if file {
        path.metadata().map(|meta| meta.len()).unwrap_or(0)
    } else {
        directory_size(path)
    }
}

/// Tamaño de una ubicación «de siempre» (una categoría sin centralizar:
/// `~/.cargo`, el npm global, `%TEMP%`…). Medirlas en cada apertura de
/// Ajustes tardaba de 7 a 11 s, y como `toolchain_store_status` retiene su
/// hilo del runtime mientras mide, varias aperturas seguidas dejaban un
/// `settings_save` esperando más de 10 s. Se reutiliza como las ubicaciones
/// externas; las cachés propias se siguen midiendo siempre (al vaciarlas
/// tiene que verse el espacio liberado).
fn cached_system_size(path: &Path, file: bool) -> u64 {
    static SIZES: Lazy<Mutex<HashMap<PathBuf, (Instant, u64)>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));
    if let Some((measured_at, bytes)) = SIZES.lock().get(path) {
        if measured_at.elapsed() < EXTERNAL_SIZES_TTL {
            return *bytes;
        }
    }
    let bytes = measure_path(path, file);
    SIZES
        .lock()
        .insert(path.to_path_buf(), (Instant::now(), bytes));
    bytes
}

/// Última medición de las ubicaciones externas y cuándo se hizo.
type MeasuredLocations = (Instant, Vec<ExternalLocation>);

static EXTERNAL_SIZES: Lazy<Mutex<Option<MeasuredLocations>>> = Lazy::new(|| Mutex::new(None));
/// Una sola medición a la vez: una segunda petición espera y reutiliza la que
/// acaba de terminar en vez de recorrer las mismas carpetas en paralelo.
static EXTERNAL_MEASURE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn measure_external() -> Vec<ExternalLocation> {
    let locations = app_locations()
        .into_iter()
        .map(|location| ("app", location))
        .chain(
            external_locations()
                .into_iter()
                .map(|location| ("external", location)),
        );
    std::thread::scope(|scope| {
        let pending: Vec<_> = locations
            .map(|(group, location)| {
                let handle = scope.spawn(move || {
                    let bytes = location.size();
                    (location, bytes)
                });
                (group, handle)
            })
            .collect();
        pending
            .into_iter()
            .filter_map(|(group, handle)| {
                let (location, bytes) = handle.join().ok()?;
                Some(ExternalLocation {
                    id: location.id,
                    label: location.label,
                    path: location.path.to_string_lossy().into_owned(),
                    bytes,
                    group,
                    info: location.info,
                })
            })
            .collect()
    })
}

/// Tamaño de las ubicaciones conocidas fuera de la carpeta propia (solo
/// lectura). `refresh` fuerza una medición nueva.
pub fn external_sizes(refresh: bool) -> Vec<ExternalLocation> {
    let requested_at = Instant::now();
    let _measuring = EXTERNAL_MEASURE.lock();
    if let Some((measured_at, locations)) = EXTERNAL_SIZES.lock().as_ref() {
        // Si otra petición midió mientras esta esperaba, ese resultado ya es
        // posterior a la pulsación de «Recalcular».
        let fresh_enough = if refresh {
            *measured_at >= requested_at
        } else {
            measured_at.elapsed() < EXTERNAL_SIZES_TTL
        };
        if fresh_enough {
            return locations.clone();
        }
    }
    let locations = measure_external();
    *EXTERNAL_SIZES.lock() = Some((Instant::now(), locations.clone()));
    locations
}

/// Vacía las cachés propias ([`clearable_caches`]): nunca una carpeta que
/// defina el usuario ni nada fuera de la carpeta de la categoría de cachés.
/// Devuelve los bytes liberados.
pub fn clear_caches() -> u64 {
    let preferences = crate::preferences::current();
    sync_layout(&preferences);
    let root = effective_root(true, &preferences.toolchain_store_dir).unwrap_or_else(default_root);
    let user_defined = |variable: &str| defined_by_user(Some(&root), variable);
    let mut freed = 0;
    for path in clearable_caches(
        &|category| category_base(&root, category),
        &crate::paths::home_dir(),
        &user_defined,
    ) {
        if !path.is_dir() {
            continue;
        }
        let before = directory_size(&path);
        let _ = std::fs::remove_dir_all(&path);
        freed += before.saturating_sub(directory_size(&path));
    }
    freed
}

/// Las carpetas que vacía «Vaciar cachés»: las de la categoría de cachés en
/// su carpeta (la elegida para la categoría o `<raíz>\cache`, `base_of`),
/// salvo las que fija el usuario con su variable. Si esa carpeta es una raíz
/// de disco, la carpeta personal (o una que la contiene) o coincide con la de
/// otra categoría, está dentro de ella o la contiene (npm global y la caché
/// de npm acabarían en la misma `npm`), no se vacía nada.
fn clearable_caches(
    base_of: &dyn Fn(Category) -> PathBuf,
    home: &Path,
    user_defined: &dyn Fn(&str) -> bool,
) -> Vec<PathBuf> {
    let base = base_of(Category::Caches);
    let cache_root = resolved(&base);
    let collides = Category::ALL
        .into_iter()
        .filter(|category| *category != Category::Caches)
        .any(|category| {
            let other = resolved(&base_of(category));
            within(&other, &cache_root) || within(&cache_root, &other)
        });
    if collides || is_disk_root(&cache_root) || within(&resolved(home), &cache_root) {
        return Vec::new();
    }
    CACHES
        .iter()
        .filter(|cache| cache.category == Category::Caches && !user_defined(cache.variable))
        .map(|cache| cache_path_in(base.clone(), cache))
        .collect()
}

// Los tres comandos miden o borran carpetas y pueden tardar (la primera
// medición externa pasa del minuto en frío). Van a `spawn_blocking`: un
// comando síncrono marcado `async` ocupa uno de los pocos hilos del runtime
// de Tauri mientras espera, y cada apertura de Ajustes pedía otra medición
// que esperaba a la anterior. Con ocho aperturas seguidas el runtime se
// quedaba sin hilos y dejaban de responder todos los comandos asíncronos,
// guardar preferencias incluido.

/// Estado y espacio de la carpeta propia.
#[tauri::command]
pub async fn toolchain_store_status() -> StoreStatus {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .unwrap_or_else(|_| status_unavailable())
}

/// Espacio de las ubicaciones conocidas fuera de la carpeta propia.
#[tauri::command]
pub async fn toolchain_store_external_sizes(refresh: Option<bool>) -> Vec<ExternalLocation> {
    let refresh = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || external_sizes(refresh))
        .await
        .unwrap_or_default()
}

/// Vacía las cachés propias y devuelve los bytes liberados.
#[tauri::command]
pub async fn toolchain_store_clear_caches() -> u64 {
    tauri::async_runtime::spawn_blocking(clear_caches)
        .await
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_ubicaciones_de_siempre_se_miden_una_vez_y_las_propias_siempre() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), [0u8; 10]).unwrap();
        assert_eq!(cached_system_size(dir.path(), false), 10);
        std::fs::write(dir.path().join("b.bin"), [0u8; 20]).unwrap();
        // Dentro del plazo se reutiliza: abrir Ajustes no vuelve a recorrer
        // carpetas como `~/.cargo` ni retiene el hilo del runtime.
        assert_eq!(cached_system_size(dir.path(), false), 10);
        // Una caché propia se mide en el momento (al vaciarla se ve).
        assert_eq!(measure_path(dir.path(), false), 30);
        let file = dir.path().join("a.bin");
        assert_eq!(measure_path(&file, true), 10);
    }

    const CATEGORIAS_DE_FABRICA: Categories = Categories {
        caches: true,
        downloads: true,
        ai_models: true,
        tools: true,
        repl_history: true,
        toolchains: true,
        programs: true,
        projects: false,
        config: true,
        plugins: true,
    };

    /// Lo de antes de centralizarlo todo: sin herramientas ni historial.
    #[test]
    fn las_toolchains_solo_se_reubican_si_no_estaban_ya_instaladas() {
        let home = Path::new("C:/Users/ana");
        let toolchains: Vec<&CacheDef> = CACHES
            .iter()
            .filter(|cache| cache.category == Category::Toolchains)
            .collect();
        // rustup, cargo, GOPATH, Gradle, .NET, Android y, desde el 09-11,
        // cabal, Stack y Mix.
        assert_eq!(toolchains.len(), 9);
        // cabal y Stack viven en %APPDATA% en Windows: la prueba da las tres
        // carpetas del perfil, como las da el sistema.
        let local = Path::new("C:/Users/ana/AppData/Local");
        let roaming = Path::new("C:/Users/ana/AppData/Roaming");
        for cache in &toolchains {
            // Cada una sabe dónde vive cuando no se centraliza: es lo que se
            // comprueba antes de reubicarla.
            assert!(
                system_location(
                    cache,
                    true,
                    home,
                    Some(local),
                    Some(roaming),
                    Path::new("C:/tmp")
                )
                .is_some(),
                "{} sin ubicación de siempre",
                cache.id
            );
        }
        // Las demás categorías no pasan por esta regla (la configuración de
        // los REPL sí).
        assert!(CACHES
            .iter()
            .filter(|cache| !matches!(cache.category, Category::Toolchains | Category::Config))
            .all(|cache| !toolchain_preinstalled(cache)));
        // Activa de fábrica; apagada, ninguna variable de toolchain.
        const _: () = assert!(CATEGORIAS_DE_FABRICA.toolchains && !CATEGORIAS_DE_FABRICA.projects);
        let overrides = overrides_for(
            Some(Path::new("C:/store")),
            Categories {
                toolchains: false,
                ..CATEGORIAS_DE_FABRICA
            },
            false,
            &|_| false,
        );
        assert!(!overrides
            .iter()
            .any(|(variable, _)| variable == "RUSTUP_HOME" || variable == "GRADLE_USER_HOME"));
    }

    const SOLO_CACHES_DESCARGAS_E_IA: Categories = Categories {
        tools: false,
        repl_history: false,
        programs: false,
        ..CATEGORIAS_DE_FABRICA
    };

    #[test]
    fn de_fabrica_se_centraliza_todo_y_las_herramientas_llevan_su_bin() {
        let defaults = crate::preferences::Preferences::default();
        assert_eq!(
            Categories::from_preferences(&defaults),
            CATEGORIAS_DE_FABRICA
        );
        let root = PathBuf::from(if cfg!(windows) {
            r"C:\entornos"
        } else {
            "/entornos"
        });
        let overrides = overrides_for(Some(&root), CATEGORIAS_DE_FABRICA, false, &|_| false);
        let value = |key: &str| {
            overrides
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| PathBuf::from(value))
        };
        assert_eq!(
            value("WTERMINAL_DOWNLOADS"),
            Some(root.join("descargas").join("panel"))
        );
        assert_eq!(value("HF_HOME"), Some(root.join("ia").join("huggingface")));
        assert_eq!(value("OLLAMA_MODELS"), Some(root.join("ia").join("ollama")));
        for centralized in [
            "npm_config_prefix",
            "CARGO_INSTALL_ROOT",
            "GOBIN",
            "PYTHONUSERBASE",
            "NODE_REPL_HISTORY",
        ] {
            assert!(value(centralized).is_some(), "{centralized}");
        }
        // PATH nunca va como variable: las carpetas bin se publican aparte.
        assert!(value("PATH").is_none());
        assert!(!extra_path_dirs(Some(&root), CATEGORIAS_DE_FABRICA, true, &|_| false).is_empty());
        // Apagando herramientas e historial vuelve lo de antes: nada en el PATH.
        let solo = overrides_for(Some(&root), SOLO_CACHES_DESCARGAS_E_IA, false, &|_| false);
        assert!(solo
            .iter()
            .all(|(key, _)| key != "npm_config_prefix" && key != "NODE_REPL_HISTORY"));
        assert!(
            extra_path_dirs(Some(&root), SOLO_CACHES_DESCARGAS_E_IA, true, &|_| false).is_empty()
        );
    }

    #[test]
    fn los_modelos_de_ollama_que_ya_tienes_no_se_dejan_de_ver() {
        let root = PathBuf::from("/entornos");
        let overrides = overrides_for(Some(&root), CATEGORIAS_DE_FABRICA, true, &|_| false);
        assert!(overrides.iter().all(|(key, _)| key != "OLLAMA_MODELS"));
        assert!(overrides.iter().any(|(key, _)| key == "HF_HOME"));
    }

    #[test]
    fn las_herramientas_nuevas_van_a_su_carpeta_y_su_bin_al_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let todo = Categories {
            tools: true,
            repl_history: true,
            ..CATEGORIAS_DE_FABRICA
        };
        let overrides = overrides_for(Some(root), todo, false, &|variable| variable == "GOBIN");
        let value = |key: &str| {
            overrides
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| PathBuf::from(value))
        };
        assert_eq!(
            value("npm_config_prefix"),
            Some(root.join("herramientas").join("npm"))
        );
        assert_eq!(
            value("CARGO_INSTALL_ROOT"),
            Some(root.join("herramientas").join("cargo"))
        );
        assert_eq!(value("GOBIN"), None, "la variable del usuario manda");
        assert_eq!(
            value("NODE_REPL_HISTORY"),
            Some(root.join("historial").join("node_repl_history"))
        );
        let scripts = root
            .join("herramientas")
            .join("python")
            .join("Python313")
            .join("Scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        let windows = extra_path_dirs(Some(root), todo, true, &|variable| variable == "GOBIN");
        assert_eq!(
            windows,
            vec![
                root.join("herramientas").join("npm"),
                root.join("herramientas").join("cargo").join("bin"),
                scripts,
            ]
        );
        let unix = extra_path_dirs(Some(root), todo, false, &|_| false);
        assert!(unix.contains(&root.join("herramientas").join("npm").join("bin")));
        assert!(unix.contains(&root.join("herramientas").join("go-bin")));
        assert!(unix.contains(&root.join("herramientas").join("python").join("bin")));
        // Sin la categoría no se añade nada al PATH.
        assert!(
            extra_path_dirs(Some(root), SOLO_CACHES_DESCARGAS_E_IA, true, &|_| false).is_empty()
        );
    }

    #[test]
    fn la_integracion_publica_pythonuserbase_solo_si_su_bin_existe() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let todo = Categories {
            tools: true,
            ..CATEGORIAS_DE_FABRICA
        };
        let overrides = overrides_for(Some(root), todo, false, &|_| false);
        let names = |pairs: Vec<(String, String)>| {
            pairs.into_iter().map(|(name, _)| name).collect::<Vec<_>>()
        };
        // Sin nada instalado con `pip --user` no hay Scripts: no se publica.
        let before = required_variables(Some(root), todo, true, &overrides, &|_| false);
        assert!(!names(before).contains(&"PYTHONUSERBASE".to_string()));

        std::fs::create_dir_all(root.join("herramientas/python/Python312/Scripts")).unwrap();
        let after = required_variables(Some(root), todo, true, &overrides, &|_| false);
        assert_eq!(
            after,
            vec![(
                "PYTHONUSERBASE".to_string(),
                root.join("herramientas")
                    .join("python")
                    .to_string_lossy()
                    .into_owned()
            )]
        );
        // `cargo install` y npm global funcionan sin su variable.
        assert!(!after.iter().any(|(name, _)| name == "CARGO_INSTALL_ROOT"));
        // Si el usuario definió la suya, su bin no se publica ni la variable.
        let user = required_variables(Some(root), todo, true, &overrides, &|variable| {
            variable == "PYTHONUSERBASE"
        });
        assert!(user.is_empty());
        // Sin la categoría, nada.
        assert!(required_variables(
            Some(root),
            SOLO_CACHES_DESCARGAS_E_IA,
            true,
            &overrides,
            &|_| { false }
        )
        .iter()
        .all(|(name, _)| name != "PYTHONUSERBASE"));
    }

    #[test]
    fn la_variable_publicada_por_wterminal_no_cuenta_como_del_usuario() {
        let root = PathBuf::from(r"E:\WTerminal\entornos");
        let ours = cache_path(
            &root,
            CACHES.iter().find(|cache| cache.id == "pip-user").unwrap(),
        );
        assert!(same_dir(
            &ours,
            &PathBuf::from(format!("{}/", ours.display()))
        ));
        assert!(!same_dir(&ours, &PathBuf::from(r"D:\mi-python")));
        // Sin la variable en el entorno nunca es del usuario.
        assert!(!defined_by_user(
            Some(&root),
            "WTERMINAL_VARIABLE_QUE_NO_EXISTE"
        ));
    }

    #[test]
    fn sin_centralizar_se_mide_la_ubicacion_de_siempre_de_cada_herramienta() {
        let home = PathBuf::from("/home/u");
        let local = PathBuf::from("/local");
        let roaming = PathBuf::from("/roaming");
        let temp = PathBuf::from("/tmp");
        let at = |id: &str, windows: bool| {
            let cache = CACHES.iter().find(|cache| cache.id == id).unwrap();
            system_location(cache, windows, &home, Some(&local), Some(&roaming), &temp)
        };
        assert_eq!(at("npm", true), Some(local.join("npm-cache")));
        assert_eq!(at("npm", false), Some(home.join(".npm")));
        assert_eq!(at("npm-global", true), Some(roaming.join("npm")));
        assert_eq!(at("pip-user", true), Some(roaming.join("Python")));
        // En Linux, lo de `pip --user`, no `~/.local` entero.
        assert_eq!(at("pip-user", false), Some(home.join(".local").join("lib")));
        assert_eq!(
            at("node-history", false),
            Some(home.join(".node_repl_history"))
        );
        assert_eq!(
            at(OLLAMA_ENTRY, true),
            Some(home.join(".ollama").join("models"))
        );
        assert_eq!(at("downloads", true), Some(temp.clone()));
        // Todas las entradas tienen una ubicación de siempre en las dos familias.
        for cache in CACHES {
            for windows in [true, false] {
                assert!(
                    system_location(cache, windows, &home, Some(&local), Some(&roaming), &temp)
                        .is_some(),
                    "{} sin ubicación de siempre (windows={windows})",
                    cache.id
                );
            }
        }
    }

    #[test]
    fn vaciar_caches_solo_cuenta_la_categoria_de_caches() {
        for cache in CACHES {
            let info = cache_info(cache, false);
            assert!(
                !info.purpose.is_empty() && !info.deletion.is_empty(),
                "{}",
                cache.id
            );
            if cache.category == Category::Tools {
                assert_eq!(info.safety, Safety::Caution, "{}", cache.id);
            }
        }
        let ids: std::collections::HashSet<_> = CACHES.iter().map(|cache| cache.id).collect();
        assert_eq!(ids.len(), CACHES.len(), "ids repetidos");
        for category in Category::ALL {
            assert!(
                CACHES.iter().any(|cache| cache.category == category),
                "{category:?} sin entradas"
            );
        }
    }

    #[test]
    fn cada_categoria_sale_una_sola_vez_y_seguida() {
        // Ajustes pinta una cabecera cada vez que cambia la categoría respecto
        // a la fila anterior: una entrada lejos de las suyas la repetía
        // («Cachés» dos veces, la segunda solo con pub).
        let mut order: Vec<Category> = Vec::new();
        for cache in CACHES {
            if order.last() != Some(&cache.category) {
                assert!(
                    !order.contains(&cache.category),
                    "{} está lejos de las demás de su categoría",
                    cache.id
                );
                order.push(cache.category);
            }
        }
        // El orden que espera el E2E (`expectedCategories` de smoke.mjs).
        assert_eq!(
            order,
            vec![
                Category::Caches,
                Category::Downloads,
                Category::AiModels,
                Category::Tools,
                Category::ReplHistory,
                Category::Toolchains,
                Category::Config,
                Category::Plugins,
                Category::Programs,
                Category::Projects,
            ]
        );
    }

    #[test]
    fn el_elemento_de_proyectos_se_apaga_por_su_id() {
        // `centralized_projects_dir` mira este id: apagarlo en la vista
        // devuelve los clones a su sitio de siempre.
        let projects = CACHES
            .iter()
            .find(|cache| cache.id == PROJECTS_ENTRY)
            .unwrap();
        assert_eq!(projects.category, Category::Projects);
        assert_eq!(projects.variable, "WTERMINAL_PROJECTS");
    }

    #[test]
    fn cargo_install_y_pip_user_en_linux_no_se_traen_y_ningun_origen_se_repite() {
        let home = PathBuf::from("/home/u");
        let local = PathBuf::from("/local");
        let roaming = PathBuf::from("/roaming");
        let temp = PathBuf::from("/tmp");
        for windows in [true, false] {
            let sources: Vec<(&str, PathBuf)> = CACHES
                .iter()
                .filter(|cache| adoptable(cache, windows))
                .filter_map(|cache| {
                    system_location(cache, windows, &home, Some(&local), Some(&roaming), &temp)
                        .map(|source| (cache.id, source))
                })
                .collect();
            let ids: Vec<&str> = sources.iter().map(|(id, _)| *id).collect();
            // «Rust (cargo)» ya trae CARGO_HOME entero, con lo instalado con
            // «cargo install»; traer este se llevaba (y al confirmar borraba)
            // CARGO_HOME o los proxies de rustup.
            assert!(!ids.contains(&"cargo-install"), "windows={windows}");
            assert!(ids.contains(&"cargo-home"), "windows={windows}");
            // En Linux `pip --user` comparte `~/.local` con todo lo demás.
            assert_eq!(ids.contains(&"pip-user"), windows);
            for fuera in ["downloads", "winget-programs", "projects"] {
                assert!(!ids.contains(&fuera), "{fuera}");
            }
            for (index, (id, source)) in sources.iter().enumerate() {
                assert_ne!(source, &home.join(".local"), "{id}");
                for (other, path) in &sources[index + 1..] {
                    assert!(
                        !same_dir(source, path),
                        "{id} y {other} comparten origen (windows={windows})"
                    );
                }
            }
        }
        // Lo que se mide de «cargo install» es su `bin`, no CARGO_HOME entero
        // (que ya mide «Rust (cargo)»).
        let cargo_install = CACHES
            .iter()
            .find(|cache| cache.id == "cargo-install")
            .unwrap();
        let measured = system_location(
            cargo_install,
            true,
            &home,
            Some(&local),
            Some(&roaming),
            &temp,
        )
        .unwrap();
        assert!(measured.ends_with("bin"), "{}", measured.display());
    }

    fn adoptable_entry(id: &str, source: PathBuf, destination: PathBuf) -> AdoptableEntry {
        AdoptableEntry {
            id: id.to_string(),
            label: id.to_string(),
            category: Category::Tools,
            variable: "WTERMINAL_PRUEBA",
            source,
            destination,
            user_defined: false,
            conflict: None,
        }
    }

    #[test]
    fn no_se_trae_lo_que_pisa_su_destino_la_carpeta_propia_u_otro_origen() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        // La raíz de fábrica de LTerminal vive dentro de `~/.local`.
        let root = home
            .join(".local")
            .join("share")
            .join("LTerminal")
            .join("entornos");
        let base = |category: Category| root.join(category.dir());
        let roaming = home.join("AppData").join("Roaming");
        std::fs::create_dir_all(roaming.join("Python")).unwrap();
        std::fs::create_dir_all(home.join(".cache").join("huggingface")).unwrap();
        let elegida = home.join("datos").join("ia");
        let mut entries = vec![
            // La carpeta de «Modelos de IA» es `~/.cache`: el destino es el
            // origen y confirmar borraría la única copia (C19).
            adoptable_entry(
                "huggingface",
                home.join(".cache").join("huggingface"),
                home.join(".cache").join("huggingface"),
            ),
            // Con Herramientas en `%APPDATA%`: `Python` y `python` son la
            // misma carpeta en Windows.
            adoptable_entry("pip-user", roaming.join("Python"), roaming.join("python")),
            // `~/.local` contiene el destino: la copia se metía en sí misma
            // (C3).
            adoptable_entry(
                "local",
                home.join(".local"),
                base(Category::Tools).join("python"),
            ),
            // El CARGO_HOME que ya publicó WTerminal está dentro de la raíz.
            adoptable_entry(
                "dentro",
                base(Category::Toolchains).join("cargo-home"),
                base(Category::Tools).join("cargo"),
            ),
            // Contiene la carpeta elegida para una categoría fuera de la raíz.
            adoptable_entry("contiene", home.join("datos"), home.join("otra")),
            // Dos entradas con el mismo origen (C2).
            adoptable_entry(
                "a",
                home.join(".cargo"),
                base(Category::Toolchains).join("a"),
            ),
            adoptable_entry("b", home.join(".cargo"), base(Category::Tools).join("b")),
            // Lo normal: nada se pisa (`npm-cache` no está dentro de `npm`).
            adoptable_entry(
                "npm",
                home.join("npm-cache"),
                base(Category::Caches).join("npm"),
            ),
        ];
        let mut bases: Vec<PathBuf> = Category::ALL.into_iter().map(base).collect();
        bases.push(elegida);
        let store_dirs = vec![base(Category::Caches).join("npm"), home.join("npm")];
        mark_conflicts(&mut entries, &root, &store_dirs, &bases);
        let conflict = |id: &str| {
            entries
                .iter()
                .find(|entry| entry.id == id)
                .unwrap()
                .conflict
        };
        assert_eq!(conflict("huggingface"), Some(AdoptConflict::Destination));
        assert_eq!(
            conflict("pip-user"),
            cfg!(windows).then_some(AdoptConflict::Destination)
        );
        assert_eq!(conflict("local"), Some(AdoptConflict::Destination));
        assert_eq!(conflict("dentro"), Some(AdoptConflict::Store));
        assert_eq!(conflict("contiene"), Some(AdoptConflict::Store));
        assert_eq!(conflict("a"), Some(AdoptConflict::SharedSource));
        assert_eq!(conflict("b"), Some(AdoptConflict::SharedSource));
        assert_eq!(conflict("npm"), None);
        for conflict in [
            AdoptConflict::Destination,
            AdoptConflict::Store,
            AdoptConflict::SharedSource,
        ] {
            assert!(conflict.reason().len() > 40, "{conflict:?}");
        }
    }

    #[test]
    fn las_rutas_se_comparan_por_carpetas_completas_y_sin_mayusculas_en_windows() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("Roaming");
        std::fs::create_dir_all(base.join("Python")).unwrap();
        assert!(paths_overlap(
            &base.join("Python"),
            &base.join("Python").join("Python312")
        ));
        assert!(paths_overlap(&base, &base.join("npm")));
        assert!(!paths_overlap(&base.join("npm-cache"), &base.join("npm")));
        assert_eq!(
            paths_overlap(&base.join("Python"), &base.join("python")),
            cfg!(windows)
        );
        // Lo que aún no existe se compara igual que lo que sí.
        assert!(paths_overlap(
            &base.join("no").join("existe"),
            &base.join("no")
        ));
        assert!(is_disk_root(Path::new(if cfg!(windows) {
            r"D:\"
        } else {
            "/"
        })));
        assert!(!is_disk_root(&base));
    }

    #[test]
    fn la_marca_solo_va_en_una_raiz_que_crea_wterminal_o_en_la_de_fabrica() {
        let dir = tempfile::tempdir().unwrap();
        let marked = |root: &Path| root.join(STORE_MARKER).is_file();
        // No existía: la crea WTerminal, con sus carpetas y la marca.
        let nueva = dir.path().join("nueva");
        prepare_root(&nueva, false, &[nueva.join("cache")]);
        assert!(nueva.join("cache").is_dir());
        assert!(marked(&nueva));
        // La siguiente vez ya tiene contenido, pero la marca sigue.
        prepare_root(&nueva, false, &[nueva.join("cache")]);
        assert!(marked(&nueva));
        // Vacía: también la llena WTerminal.
        let vacia = dir.path().join("vacia");
        std::fs::create_dir_all(&vacia).unwrap();
        prepare_root(&vacia, false, &[vacia.join("cache")]);
        assert!(marked(&vacia));
        // Una carpeta con cosas del usuario (C17): se crean las carpetas,
        // pero nunca la marca, o el desinstalador ofrecería borrarla entera.
        let ajena = dir.path().join("Desarrollo");
        std::fs::create_dir_all(ajena.join("mi-proyecto")).unwrap();
        prepare_root(&ajena, false, &[ajena.join("cache")]);
        assert!(ajena.join("cache").is_dir());
        assert!(!marked(&ajena));
        prepare_root(&ajena, false, &[ajena.join("cache")]);
        assert!(!marked(&ajena));
        // La de fábrica siempre es de WTerminal.
        prepare_root(&ajena, true, &[]);
        assert!(marked(&ajena));
        // Lo que no existe está sin usar; lo que tiene algo, no.
        assert!(root_is_unused(&dir.path().join("no-existe")));
        assert!(!root_is_unused(&ajena));
    }

    #[test]
    fn vaciar_caches_usa_la_carpeta_de_la_categoria_y_no_pisa_otras() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("entornos");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let fabrica = |category: Category| root.join(category.dir());
        let caches = CACHES
            .iter()
            .filter(|cache| cache.category == Category::Caches)
            .count();
        let todas = clearable_caches(&fabrica, &home, &|_| false);
        assert_eq!(todas.len(), caches);
        assert!(todas
            .iter()
            .all(|path| path.starts_with(root.join("cache"))));
        // La que fija el usuario con su variable no se toca.
        let sin_npm = clearable_caches(&fabrica, &home, &|variable| variable == "npm_config_cache");
        assert_eq!(sin_npm.len(), caches - 1);
        assert!(!sin_npm.contains(&root.join("cache").join("npm")));
        // Con una carpeta elegida para las cachés se vacía esa (C20).
        let propia = dir.path().join("E").join("caches");
        let elegida = |category: Category| {
            if category == Category::Caches {
                propia.clone()
            } else {
                fabrica(category)
            }
        };
        let paths = clearable_caches(&elegida, &home, &|_| false);
        assert_eq!(paths.len(), caches);
        assert!(paths.contains(&propia.join("npm")));
        // La misma que Herramientas: la caché de npm y npm global serían la
        // misma `npm`.
        let compartida = |category: Category| match category {
            Category::Caches | Category::Tools => propia.clone(),
            _ => fabrica(category),
        };
        assert!(clearable_caches(&compartida, &home, &|_| false).is_empty());
        // Dentro de la de otra categoría.
        let dentro = |category: Category| {
            if category == Category::Caches {
                fabrica(Category::Programs).join("cache")
            } else {
                fabrica(category)
            }
        };
        assert!(clearable_caches(&dentro, &home, &|_| false).is_empty());
        // Una raíz de disco, la carpeta personal o una que la contiene.
        let disco = PathBuf::from(if cfg!(windows) { r"C:\" } else { "/" });
        for peligrosa in [disco, home.clone(), dir.path().join("..")] {
            let base = |category: Category| {
                if category == Category::Caches {
                    peligrosa.clone()
                } else {
                    fabrica(category)
                }
            };
            assert!(
                clearable_caches(&base, &home, &|_| false).is_empty(),
                "{}",
                peligrosa.display()
            );
        }
    }

    #[test]
    fn la_carpeta_de_cada_categoria_solo_acepta_categorias_conocidas_y_rutas_absolutas() {
        let absoluta = if cfg!(windows) {
            r"E:\ia"
        } else {
            "/mnt/datos/ia"
        };
        let texto =
            format!("aiModels={absoluta}\ninventada=/x\ncaches=relativa\n\nplugins = {absoluta}");
        let dirs = parse_category_dirs(&texto);
        assert_eq!(
            dirs,
            vec![
                (Category::AiModels, PathBuf::from(absoluta)),
                (Category::Plugins, PathBuf::from(absoluta)),
            ]
        );
        // Cada categoría tiene su id y se encuentra por él.
        for category in Category::ALL {
            assert_eq!(Category::from_id(category.id()), Some(category));
        }
    }

    #[test]
    fn desactivado_no_inyecta_nada() {
        assert!(overrides_for(None, CATEGORIAS_DE_FABRICA, false, &|_| false).is_empty());
        assert_eq!(effective_root(false, ""), None);
    }

    #[test]
    fn inyecta_las_cachés_bajo_la_raíz_y_respeta_las_del_usuario() {
        let root = PathBuf::from(if cfg!(windows) {
            r"C:\entornos"
        } else {
            "/entornos"
        });
        // Solo la categoría de cachés: desde el 09-11 la configuración y los
        // complementos (IPython, Jupyter, starship) también llevan variables.
        let solo_caches = Categories {
            downloads: false,
            ai_models: false,
            toolchains: false,
            config: false,
            plugins: false,
            ..SOLO_CACHES_DESCARGAS_E_IA
        };
        let overrides = overrides_for(Some(&root), solo_caches, false, &|variable| {
            variable == "GOMODCACHE"
        });
        let npm = overrides
            .iter()
            .find(|(key, _)| key == "npm_config_cache")
            .unwrap();
        assert_eq!(PathBuf::from(&npm.1), root.join("cache").join("npm"));
        assert!(overrides.iter().all(|(key, _)| key != "GOMODCACHE"));
        let caches = CACHES
            .iter()
            .filter(|cache| cache.category == Category::Caches)
            .count();
        assert_eq!(overrides.len(), caches - 1);
        // Nunca se tocan instalaciones globales ni el PATH.
        for forbidden in [
            "PATH",
            "npm_config_prefix",
            "CARGO_HOME",
            "GRADLE_USER_HOME",
            "PLAYWRIGHT_BROWSERS_PATH",
        ] {
            assert!(
                overrides.iter().all(|(key, _)| key != forbidden),
                "{forbidden}"
            );
        }
    }

    #[test]
    fn una_ruta_configurada_relativa_usa_la_raíz_por_defecto() {
        assert_eq!(effective_root(true, "relativa"), Some(default_root()));
        assert_eq!(effective_root(true, "  "), Some(default_root()));
        let absolute = if cfg!(windows) {
            r"D:\cachés"
        } else {
            "/datos/cachés"
        };
        assert_eq!(
            effective_root(true, absolute),
            Some(PathBuf::from(absolute))
        );
    }

    #[test]
    fn cada_ubicacion_explica_para_que_sirve_y_si_se_puede_borrar() {
        let all: Vec<Location> = app_locations()
            .into_iter()
            .chain(external_locations())
            .collect();
        for location in &all {
            assert!(location.info.purpose.len() > 20, "{}", location.id);
            assert!(location.info.deletion.len() > 20, "{}", location.id);
            assert!(location.label.contains('('), "{}", location.id);
        }
        // Lo que guarda trabajo o configuración del usuario nunca se presenta
        // como borrable sin más.
        for (safety, purpose) in [
            (Safety::Keep, "Tus preferencias"),
            (Safety::Keep, "repositorios"),
        ] {
            assert!(all
                .iter()
                .filter(|location| location.info.purpose.contains(purpose))
                .all(|location| location.info.safety == safety));
        }
        let cache = &CACHES[0];
        assert_eq!(cache_info(cache, false).safety, Safety::Regenerates);
        assert!(cache_info(cache, true).deletion.contains("no la vacía"));
    }

    #[test]
    fn las_rutas_se_ensenan_como_las_escribiria_el_usuario() {
        let home = crate::paths::home_dir();
        let shown = display_path(&home.join(".cargo"));
        assert!(shown.starts_with('~') || shown.starts_with('%'), "{shown}");
        assert!(shown.ends_with(".cargo"));
        assert_eq!(
            display_path(Path::new("/opt/otra")),
            Path::new("/opt/otra").to_string_lossy()
        );
    }

    #[test]
    fn el_tamano_de_unos_archivos_concretos_no_cuenta_el_resto_de_la_carpeta() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.path().join("otro.bin"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir_all(dir.path().join("plugins")).unwrap();
        std::fs::write(dir.path().join("plugins").join("a"), vec![0u8; 5]).unwrap();
        let location = Location {
            files: vec![
                dir.path().join("settings.json"),
                dir.path().join("plugins"),
                dir.path().join("no-existe"),
            ],
            ..Location::new(
                "x",
                "X",
                dir.path().to_path_buf(),
                info(Safety::Keep, "", ""),
            )
        };
        assert!(location.exists());
        assert_eq!(location.size(), 15);
    }

    #[test]
    fn el_tamaño_suma_archivos_y_no_sigue_enlaces() {
        let dir = std::env::temp_dir().join(format!("wterminal-store-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("sub").join("b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(directory_size(&dir), 150);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
