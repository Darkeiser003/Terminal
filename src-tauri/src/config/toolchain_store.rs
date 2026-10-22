//! Carpeta propia (`entornos`) para lo que descargan y crean desde WTerminal
//! los lenguajes, gestores de paquetes, herramientas y REPL, y vista del
//! espacio que ocupan. Va por categorías, cada una con su interruptor:
//!
//! | Categoría | Subcarpeta | Qué reubica | De fábrica |
//! |---|---|---|---|
//! | Cachés | `cache/` | npm, Yarn, Bun, Deno, pip, uv, Go, NuGet, Coursier, Composer | activa |
//! | Descargas del panel | `descargas/` | Los archivos que bajan las acciones del panel (ADB…) | activa |
//! | Modelos de IA | `ia/` | `HF_HOME`; `OLLAMA_MODELS` solo si aún no hay modelos de Ollama | activa |
//! | Herramientas nuevas | `herramientas/` | `npm -g`, `cargo install`, `go install`, `pip --user`, con su `bin` en el PATH | apagada |
//! | Historial de los REPL | `historial/` | Node, Python 3.13+, SQLite y psql | apagada |
//!
//! Cada herramienta ya permite elegir su carpeta con una variable de entorno
//! estándar. WTerminal la inyecta solo en los procesos que lanza (terminales
//! y sondas de detección): no toca las variables del sistema, no pisa las que
//! el usuario ya haya definido y nunca mueve nada ya instalado. Por eso
//! «Herramientas nuevas» va apagada de fábrica: lo que se instale con ella
//! queda en el PATH solo dentro de WTerminal (y de la integración con el PATH
//! si se activa), y lo que ya estaba instalado sigue donde estaba y se sigue
//! detectando. Los navegadores de Playwright, los entornos de Poetry o
//! `GRADLE_USER_HOME` (con credenciales) no se reubican nunca.
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
}

impl Category {
    pub const ALL: [Category; 5] = [
        Category::Caches,
        Category::Downloads,
        Category::AiModels,
        Category::Tools,
        Category::ReplHistory,
    ];

    /// Subcarpeta dentro de la raíz. `cache` conserva el nombre de siempre:
    /// las cachés ya descargadas siguen en su sitio.
    fn dir(self) -> &'static str {
        match self {
            Category::Caches => "cache",
            Category::Downloads => "descargas",
            Category::AiModels => "ia",
            Category::Tools => "herramientas",
            Category::ReplHistory => "historial",
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
}

impl Categories {
    pub fn from_preferences(preferences: &crate::preferences::Preferences) -> Categories {
        Categories {
            caches: true,
            downloads: preferences.toolchain_store_downloads,
            ai_models: preferences.toolchain_store_ai_models,
            tools: preferences.toolchain_store_tools,
            repl_history: preferences.toolchain_store_repl_history,
        }
    }

    pub fn includes(self, category: Category) -> bool {
        match category {
            Category::Caches => self.caches,
            Category::Downloads => self.downloads,
            Category::AiModels => self.ai_models,
            Category::Tools => self.tools,
            Category::ReplHistory => self.repl_history,
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
    root.join(cache.category.dir()).join(cache.subdir)
}

/// Entradas que se reubican con estas categorías. `existing_ollama_models`
/// dice si ya hay modelos en la carpeta de siempre de Ollama.
fn active_entries(
    categories: Categories,
    existing_ollama_models: bool,
) -> impl Iterator<Item = &'static CacheDef> {
    CACHES.iter().filter(move |cache| {
        categories.includes(cache.category) && !(cache.id == OLLAMA_ENTRY && existing_ollama_models)
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
    let mut dirs = Vec::new();
    for cache in active_entries(categories, false).filter(|cache| !user_defined(cache.variable)) {
        let base = cache_path(root, cache);
        match cache.bin {
            Bin::None => {}
            Bin::Same => dirs.push(base),
            Bin::Sub(sub) => dirs.push(base.join(sub)),
            Bin::NpmPrefix if windows => dirs.push(base),
            Bin::NpmPrefix => dirs.push(base.join("bin")),
            Bin::PythonUser if windows => {
                let mut versions: Vec<PathBuf> = std::fs::read_dir(&base)
                    .map(|entries| {
                        entries
                            .filter_map(Result::ok)
                            .filter(|entry| {
                                entry.file_name().to_string_lossy().starts_with("Python")
                            })
                            .map(|entry| entry.path().join("Scripts"))
                            .collect()
                    })
                    .unwrap_or_default();
                versions.sort();
                versions.reverse();
                dirs.extend(versions);
            }
            Bin::PythonUser => dirs.push(base.join("bin")),
        }
    }
    dirs
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
        ("cargo-install", _) => std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| home(&[".cargo"])),
        ("go-bin", _) => std::env::var_os("GOPATH")
            .map(|gopath| PathBuf::from(gopath).join("bin"))
            .or_else(|| home(&["go", "bin"])),
        ("pip-user", true) => roaming(&["Python"]),
        ("pip-user", false) => home(&[".local"]),
        ("node-history", _) => home(&[".node_repl_history"]),
        ("python-history", _) => home(&[".python_history"]),
        ("sqlite-history", _) => home(&[".sqlite_history"]),
        ("psql-history", true) => roaming(&["postgresql", "psql_history"]),
        ("psql-history", false) => home(&[".psql_history"]),
        _ => None,
    }
}

/// `true` si Ollama ya tiene modelos en su carpeta de siempre.
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
    let root = effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    );
    let user_defined = |variable: &str| std::env::var_os(variable).is_some();
    extra_path_dirs(
        root.as_deref(),
        Categories::from_preferences(&preferences),
        cfg!(windows),
        &user_defined,
    )
}

/// Recalcula las variables con las preferencias guardadas y las publica para
/// todo lo que lance la app. Se llama al arrancar y cada vez que se guardan
/// los Ajustes: afecta a las terminales que se abran a partir de entonces.
pub fn refresh_environment() {
    let preferences = crate::preferences::current();
    let root = effective_root(
        preferences.toolchain_store_enabled,
        &preferences.toolchain_store_dir,
    );
    let categories = Categories::from_preferences(&preferences);
    let existing_ollama = ollama_has_existing_models();
    let user_defined = |variable: &str| std::env::var_os(variable).is_some();
    if let Some(root) = root.as_deref() {
        // Las carpetas existen desde el principio para poder abrirlas en
        // Ajustes, y las de historial para que el REPL pueda crear su archivo.
        let _ = std::fs::create_dir_all(root.join(Category::Caches.dir()));
        for cache in active_entries(categories, existing_ollama) {
            let path = cache_path(root, cache);
            let dir = if cache.file {
                path.parent().map(Path::to_path_buf)
            } else {
                Some(path)
            };
            if let Some(dir) = dir {
                let _ = std::fs::create_dir_all(dir);
            }
        }
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

/// Tamaño de una carpeta sin seguir enlaces ni uniones (evita bucles y contar
/// dos veces lo que apunta fuera).
fn directory_size(path: &Path) -> u64 {
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
        Category::ReplHistory => {
            return info(
                Safety::Safe,
                &format!("Historial de órdenes de {} ({}).", cache.name, cache.variable),
                "Se puede borrar: solo se pierde el historial de ese intérprete.",
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
    let enabled = preferences.toolchain_store_enabled;
    let categories = Categories::from_preferences(&preferences);
    let existing_ollama = ollama_has_existing_models();
    let root = effective_root(true, &preferences.toolchain_store_dir).unwrap_or_else(default_root);
    let caches = std::thread::scope(|scope| {
        let home = crate::paths::home_dir();
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
        let temp = std::env::temp_dir();
        let pending: Vec<_> = CACHES
            .iter()
            .map(|cache| {
                let user_value = std::env::var_os(cache.variable).map(PathBuf::from);
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
                let handle = scope.spawn(move || {
                    if location == "system" {
                        cached_system_size(&measured, file)
                    } else {
                        measure_path(&measured, file)
                    }
                });
                (cache, path, user_value.is_some(), location, handle)
            })
            .collect();
        pending
            .into_iter()
            .map(|(cache, path, user_defined, location, handle)| StoreCache {
                id: cache.id.to_string(),
                name: cache.name.to_string(),
                variable: cache.variable.to_string(),
                path: path.to_string_lossy().into_owned(),
                bytes: handle.join().unwrap_or(0),
                user_defined,
                location,
                category: cache.category,
                active: enabled
                    && active_entries(categories, existing_ollama)
                        .any(|active| active.id == cache.id),
                info: cache_info(cache, user_defined),
            })
            .collect::<Vec<_>>()
    });
    // «Vaciar cachés» solo cuenta y borra las cachés de la carpeta propia.
    let cache_bytes = caches
        .iter()
        .filter(|cache| cache.location == "own" && cache.category == Category::Caches)
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

/// Lo que responde `toolchain_store_status` si la medición no pudo terminar
/// (el hilo de trabajo acabó con un pánico): la carpeta, sin tamaños.
fn status_unavailable() -> StoreStatus {
    let preferences = crate::preferences::current();
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

/// Vacía las cachés propias (nunca una carpeta que defina el usuario ni nada
/// fuera de `<raíz>/cache`). Devuelve los bytes liberados.
pub fn clear_caches() -> u64 {
    let preferences = crate::preferences::current();
    let root = effective_root(true, &preferences.toolchain_store_dir).unwrap_or_else(default_root);
    let cache_root = root.join("cache");
    let mut freed = 0;
    for cache in CACHES
        .iter()
        .filter(|cache| cache.category == Category::Caches)
    {
        if std::env::var_os(cache.variable).is_some() {
            continue;
        }
        let path = cache_path(&root, cache);
        if !path.starts_with(&cache_root) || !path.is_dir() {
            continue;
        }
        let before = directory_size(&path);
        let _ = std::fs::remove_dir_all(&path);
        freed += before.saturating_sub(directory_size(&path));
    }
    freed
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
    };

    /// Lo de antes de centralizarlo todo: sin herramientas ni historial.
    const SOLO_CACHES_DESCARGAS_E_IA: Categories = Categories {
        tools: false,
        repl_history: false,
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
        let solo_caches = Categories {
            downloads: false,
            ai_models: false,
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
