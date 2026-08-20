//! Catálogo de acciones de "entorno y dependencias adicionales".
//!
//! Port de `electron/main/installActions.js`.
//!
//! Cada acción se limita a escribir un comando en la terminal activa: el
//! usuario ve exactamente qué se va a ejecutar y mantiene el control total
//! (puede cancelar con Ctrl+C, como cualquier otro comando). No se ejecuta
//! nada oculto ni con permisos elevados por detrás.
//!
//! Dos campos deciden cuándo se ve cada acción en el panel (ver
//! `filter_available_actions` en `commands_panels.rs`):
//!   - `check_cmd` -> se OCULTA si ese comando ya está instalado ("Instalar X"
//!     no tiene sentido cuando X ya está);
//!   - `requires_cmd` -> se MUESTRA solo si ese comando está instalado
//!     (actualizar, verificar o usar algo que todavía no existe en el sistema).
//!
//! Así, para cada herramienta se ofrece "Instalar" antes y
//! "Actualizar"/"Ver" después, nunca las dos cosas a la vez.
//!
//! El catálogo se escribe en español y se traduce al generarlo: `t` resuelve
//! las etiquetas que salen de un patrón ("Instalar X (winget)", "Actualizar a
//! la última versión"...), que son la mayoría. Los ids, los comandos y el
//! orden no dependen del idioma, que es lo que el resto del sistema usa para
//! identificar una acción.

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::i18n::Translator;
use crate::wsl_env::WslContext;

/// Orden en el que se pintan los apartados del panel. Es fijo a propósito:
/// depende solo de qué apartados existen en este sistema, no del orden en que
/// se hayan ido añadiendo acciones al catálogo. Lo que no esté aquí va al
/// final, alfabéticamente.
#[rustfmt::skip]
pub static GROUP_ORDER: &[&str] = &[
    "Actualizaciones",
    "Shells",
    "Sistema y herramientas",
    "Lenguajes",
    "Frameworks",
    "Visores de archivos",
    "Compatibilidad Windows",
    "WSL",
    "Contenedores y Kubernetes",
    "Android · ADB",
    "Red y acceso remoto",
];

// Nombres de los subgrupos (el plegable de segundo nivel: todas las acciones
// de UNA herramienta juntas). Se centralizan porque varias plataformas tienen
// que coincidir exactamente para no partir la misma herramienta en dos.
const ADB_SUBGROUP: &str = "ADB · Android Platform Tools";
const SSH_SUBGROUP: &str = "SSH (OpenSSH)";
const ADB_GROUP: &str = "Android · ADB";
const SSH_GROUP: &str = "Red y acceso remoto";
const DOCKER_GROUP: &str = "Contenedores y Kubernetes";
const WSL_GROUP: &str = "WSL";
const VIEWER_GROUP: &str = "Visores de archivos";
const CODE_EDITORS_SUBGROUP: &str = "Editores de código";
const UPDATES_GROUP: &str = "Actualizaciones";
const SHELLS_GROUP: &str = "Shells";
const TOOLS_GROUP: &str = "Sistema y herramientas";
const LANGUAGES_GROUP: &str = "Lenguajes";
const FRAMEWORKS_GROUP: &str = "Frameworks";
const WINDOWS_COMPAT_GROUP: &str = "Compatibilidad Windows";

/// Una acción del panel. `shell` es la shell que el comando necesita para
/// funcionar (`powershell` o ninguna en particular); quien la ejecuta se
/// encarga de adaptarla a la shell de la pestaña.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAction {
    pub id: String,
    pub label: String,
    pub short_label: Option<String>,
    pub command: String,
    /// Vacío mientras el catálogo se construye: `default_group` lo rellena
    /// antes de que la acción salga de este módulo.
    pub group: String,
    pub subgroup: Option<String>,
    pub verb: Option<String>,
    pub hint: Option<String>,
    pub shell: Option<String>,
    pub check_cmd: Option<String>,
    pub requires_cmd: Option<String>,
    /// Lo declara el catálogo solo cuando lo sabe por otra vía que no sea
    /// `check_cmd`/`requires_cmd` (las distros WSL, que vienen del inventario
    /// de la sonda). El resto lo deduce el filtro.
    pub installed: Option<bool>,
    /// La clave de traducción del apartado. La rellena `translated`, en la
    /// frontera con el frontend: el catálogo no conoce los idiomas.
    pub group_key: Option<&'static str>,
}

impl InstallAction {
    pub(crate) fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        command: impl Into<String>,
    ) -> Self {
        InstallAction {
            id: id.into(),
            label: label.into(),
            short_label: None,
            command: command.into(),
            group: String::new(),
            subgroup: None,
            verb: None,
            hint: None,
            shell: None,
            check_cmd: None,
            requires_cmd: None,
            installed: None,
            group_key: None,
        }
    }

    /// Traducción de una acción concreta del panel. Port de `translateAction`
    /// de `electron/main/i18n.js`; vive aquí, y no en `i18n`, porque el
    /// catálogo de traducciones no tiene por qué conocer el tipo de una acción:
    /// la dependencia va en un único sentido.
    ///
    /// Las claves se derivan del identificador estable de la acción
    /// (`pkg-pwsh` -> `action.pkg-pwsh.label`), de modo que traducir una acción
    /// no obliga a tocar el catálogo ni a reordenar nada. Lo que no esté
    /// traducido se queda en español, que es el idioma en el que está escrito.
    pub fn translated(&self, language: &str) -> InstallAction {
        let campo = |nombre: &str, actual: &Option<String>| -> Option<String> {
            let actual = actual.as_deref()?;
            let clave = format!("action.{}.{nombre}", self.id);
            let texto = crate::i18n::translate(language, &clave, &[], actual);
            if !tiene_hueco(&texto) && texto != actual {
                return Some(texto);
            }
            if nombre == "hint" {
                if self.id.contains("git-pull") {
                    let fb = crate::i18n::translate(language, "action.gitPull.hint", &[], actual);
                    if fb != actual {
                        return Some(fb);
                    }
                }
                if self.id.ends_with("-uninstall") || self.id.ends_with("-remove") {
                    let fb = crate::i18n::translate(language, "action.uninstall.hint", &[], actual);
                    if fb != actual {
                        return Some(fb);
                    }
                }
            }
            Some(if tiene_hueco(&texto) {
                actual.to_string()
            } else {
                texto
            })
        };
        InstallAction {
            label: campo("label", &Some(self.label.clone())).unwrap_or_default(),
            short_label: campo("shortLabel", &self.short_label),
            hint: campo("hint", &self.hint),
            verb: self
                .verb
                .as_deref()
                .map(|verb| match crate::i18n::verb_key_for(verb) {
                    Some(clave) => crate::i18n::translate(language, clave, &[], verb),
                    None => verb.to_string(),
                }),
            subgroup: self.subgroup.as_deref().map(|subgroup| {
                crate::i18n::translate(
                    language,
                    &format!("action.subgroup.{subgroup}"),
                    &[],
                    subgroup,
                )
            }),
            group_key: crate::i18n::group_key_for(&self.group),
            ..self.clone()
        }
    }

    fn short(mut self, short_label: impl Into<String>) -> Self {
        self.short_label = Some(short_label.into());
        self
    }

    fn group(mut self, group: impl Into<String>) -> Self {
        self.group = group.into();
        self
    }

    fn subgroup(mut self, subgroup: impl Into<String>) -> Self {
        self.subgroup = Some(subgroup.into());
        self
    }

    fn verb(mut self, verb: &str) -> Self {
        self.verb = Some(verb.to_string());
        self
    }

    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Marca el comando como script de PowerShell: cmdlets y variables `$` que
    /// hay que envolver antes de escribirlos en una shell que no sea esa.
    fn powershell(mut self) -> Self {
        self.shell = Some("powershell".to_string());
        self
    }

    fn check(mut self, cmd: Option<&str>) -> Self {
        self.check_cmd = cmd.map(str::to_string);
        self
    }

    fn requires(mut self, cmd: Option<&str>) -> Self {
        self.requires_cmd = cmd.map(str::to_string);
        self
    }

    fn installed(mut self, installed: bool) -> Self {
        self.installed = Some(installed);
        self
    }
}

/// Contexto del sistema que necesita el catálogo para no ofrecer nada
/// imposible. Lo calcula quien atiende `install_list` e `install_run`, igual
/// en los dos, para que la acción que se ejecuta sea exactamente la que se
/// mostró.
#[derive(Debug, Clone, Default)]
pub struct InstallContext {
    /// El valor de `std::env::consts::OS`: `windows`, `linux` o `macos`.
    pub platform: String,
    pub pkg_manager: Option<String>,
    pub wsl: Option<WslContext>,
    pub has_snap: bool,
    /// `paru` o `yay` si alguno está instalado (solo Arch).
    pub aur_helper: Option<String>,
    pub projects_folder: String,
}

/// Disponible en los tres SO con la misma sintaxis: solo lee, no instala nada,
/// así que sirve para verificar el estado de Docker sin riesgo.
fn docker_check_action() -> InstallAction {
    InstallAction::new(
        "docker-check",
        "Verificar Docker (version + daemon)",
        "docker --version && docker info",
    )
    .short("Verificar versión y daemon")
    .verb("Verificar")
    .requires(Some("docker"))
    .group(DOCKER_GROUP)
}

/// Ver qué imágenes y contenedores hay: son justo los que la app convierte en
/// entornos del selector, así que sirve para entender qué va a aparecer ahí.
fn docker_list_action() -> InstallAction {
    InstallAction::new(
        "docker-list",
        "Ver imágenes y contenedores Docker",
        "docker image ls && docker ps -a",
    )
    .short("Ver imágenes y contenedores")
    .verb("Ver")
    .requires(Some("docker"))
    .group(DOCKER_GROUP)
}

/// Instalación de ADB en Windows desde la descarga oficial de Google.
///
/// Por qué no winget: el paquete `Google.PlatformTools` apunta a una URL que
/// Google reescribe con cada release SIN cambiar el número de versión, así que
/// el hash del manifiesto queda obsoleto y winget aborta con "el hash del
/// instalador no coincide" — y encima se niega a permitir saltárselo cuando se
/// ejecuta como administrador. La descarga directa desde el dominio oficial de
/// Google evita el problema y siempre trae la última versión.
///
/// IMPORTANTE: este script se escribe tal cual (`shell: powershell`, ver
/// `wrap_powershell_command`), así que no puede contener comillas DOBLES: se
/// envuelve entre comillas dobles al invocarlo desde cmd.exe.
#[rustfmt::skip]
static ADB_INSTALL_PS: Lazy<String> = Lazy::new(|| {
    [
        // adb.exe bloquea su propio archivo mientras el servidor está vivo.
        "Get-Process adb -ErrorAction SilentlyContinue | Stop-Process -Force",
        "$dest = Join-Path $env:LOCALAPPDATA 'Android'",
        "$zip = Join-Path $env:TEMP 'platform-tools-latest.zip'",
        "New-Item -ItemType Directory -Force -Path $dest | Out-Null",
        "Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $zip",
        "Expand-Archive -Path $zip -DestinationPath $dest -Force",
        "Remove-Item $zip -Force",
        "$tools = Join-Path $dest 'platform-tools'",
        // PATH persistente del USUARIO (no el de máquina): no requiere permisos
        // de administrador y basta para que adb funcione desde cualquier ruta.
        // Si el valor no existe todavía, GetEnvironmentVariable devuelve null y
        // concatenar dejaría un ';' inicial: por eso el if en vez de concatenar
        // directamente.
        "$userPath = [Environment]::GetEnvironmentVariable('Path','User')",
        "if (-not $userPath) { $userPath = '' }",
        "if (($userPath -split ';') -notcontains $tools) { $nuevo = if ($userPath) { $userPath.TrimEnd(';') + ';' + $tools } else { $tools }; [Environment]::SetEnvironmentVariable('Path', $nuevo, 'User') }",
        // ...y también en la sesión actual, para que quien lance esto desde una
        // pestaña de PowerShell pueda usar adb ahí mismo, sin abrir otra.
        "if (($env:Path -split ';') -notcontains $tools) { $env:Path = $env:Path.TrimEnd(';') + ';' + $tools }",
        "& (Join-Path $tools 'adb.exe') version",
        "Write-Host ('ADB instalado en ' + $tools + ' y anadido al PATH - abre una pestana nueva para usar adb desde cualquier ruta') -ForegroundColor Green",
    ]
    .join("; ")
});

/// Desinstalación de ADB: solo deshace lo que instaló la acción de esta app —
/// la carpeta en `%LOCALAPPDATA%\Android\platform-tools` y su entrada en el
/// PATH del usuario. Una instalación de Android Studio no se toca.
#[rustfmt::skip]
static ADB_UNINSTALL_PS: Lazy<String> = Lazy::new(|| {
    [
        "Get-Process adb -ErrorAction SilentlyContinue | Stop-Process -Force",
        "$tools = Join-Path $env:LOCALAPPDATA 'Android\\platform-tools'",
        "if (Test-Path $tools) { Remove-Item -Recurse -Force $tools; Write-Host ('Eliminado ' + $tools) -ForegroundColor Green } else { Write-Host 'No hay una instalacion propia de platform-tools en LOCALAPPDATA.' -ForegroundColor Yellow }",
        "$userPath = [Environment]::GetEnvironmentVariable('Path','User')",
        "if ($userPath) { $limpio = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $tools }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $limpio, 'User') }",
    ]
    .join("; ")
});

/// `true` si el texto conserva un parámetro sin sustituir (`{source}`).
fn tiene_hueco(texto: &str) -> bool {
    let bytes = texto.as_bytes();
    bytes.iter().enumerate().any(|(inicio, byte)| {
        *byte == b'{'
            && bytes[inicio + 1..]
                .iter()
                .position(|b| *b == b'}')
                .is_some_and(|largo| {
                    largo > 0
                        && bytes[inicio + 1..inicio + 1 + largo]
                            .iter()
                            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
                })
    })
}

/// Identificador estable a partir de un nombre libre (el de una distro WSL).
/// Solo minúsculas, dígitos y guiones, sin guiones sueltos en los extremos.
fn safe_id(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.extend(ch.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Entrecomillado literal de PowerShell: dentro de comillas simples nada se
/// interpola y la propia comilla se escribe duplicada.
fn ps_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Entrecomillado literal POSIX: se cierra la comilla, se escapa la comilla
/// suelta y se vuelve a abrir.
fn sh_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// ---- Herramientas de Windows (winget) ----

/// `cmd` es el ejecutable que decide si la herramienta está presente; `verify`
/// es el comando que muestra la versión instalada.
///
/// `no_detect` es para aplicaciones de escritorio que no dejan ningún
/// ejecutable en el PATH (ImageGlass, VLC, SumatraPDF...). Ahí no se puede
/// saber si están instaladas mirando el sistema, así que se ofrecen siempre
/// las cuatro acciones y la de "versión" pregunta directamente a winget, en
/// vez de fingir una detección que daría siempre "no instalado".
struct WindowsTool {
    /// Se conserva tal cual porque `command_not_found` apunta a él para
    /// sugerir la instalación cuando la shell responde "comando no encontrado".
    install_id: &'static str,
    label_key: Option<&'static str>,
    label: &'static str,
    cmd: &'static str,
    pkg: &'static str,
    verify: Option<&'static str>,
    group: &'static str,
    hint: Option<&'static str>,
    no_detect: bool,
}

const fn win(
    install_id: &'static str,
    label: &'static str,
    cmd: &'static str,
    pkg: &'static str,
    verify: Option<&'static str>,
    group: &'static str,
) -> WindowsTool {
    WindowsTool {
        install_id,
        label_key: None,
        label,
        cmd,
        pkg,
        verify,
        group,
        hint: None,
        no_detect: false,
    }
}

#[rustfmt::skip]
static WINDOWS_TOOLS: Lazy<Vec<WindowsTool>> = Lazy::new(|| vec![
    win("winget-pwsh",   "PowerShell 7",    "pwsh",   "Microsoft.PowerShell",           Some("pwsh -v"),                      SHELLS_GROUP),
    win("winget-nushell", "Nushell",        "nu",     "Nushell.Nushell",                Some("nu --version"),                  SHELLS_GROUP),
    WindowsTool { label_key: Some("tool.gitBash"), ..win("winget-git", "Git + Git Bash", "git", "Git.Git", Some("git --version"), TOOLS_GROUP) },
    win("winget-wt",     "Windows Terminal", "wt",    "Microsoft.WindowsTerminal",      None,                                 TOOLS_GROUP),
    win("winget-nsudo",  "NSudo · elevación avanzada", "NSudoLC", "M2Team.NSudo",       Some("$n = @('C:\\WSCore\\Components\\Hooks\\NSudo\\NSudoLC.exe', 'C:\\Program Files\\NSudo\\NSudoLC.exe', 'C:\\Program Files\\NSudo Launcher\\NSudoLC.exe', 'C:\\Program Files (x86)\\NSudo\\NSudoLC.exe', 'C:\\Tools\\NSudo\\NSudoLC.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1; if (-not $n) { $n = (Get-Command NSudoLC.exe -ErrorAction Stop).Source }; & $n -?"), TOOLS_GROUP),
    WindowsTool { label_key: Some("tool.nodeLts"), ..win("winget-node", "Node.js LTS", "node", "OpenJS.NodeJS.LTS", Some("node -v; npm -v"), LANGUAGES_GROUP) },
    win("winget-mariadb", "MariaDB + InnoDB", "mariadb", "MariaDB.Server", Some("mariadb --version"), LANGUAGES_GROUP),
    win("winget-mysql", "MySQL + InnoDB", "mysql", "Oracle.MySQL", Some("mysql --version"), LANGUAGES_GROUP),
    win("winget-postgresql", "PostgreSQL + psql", "psql", "PostgreSQL.PostgreSQL", Some("psql --version"), LANGUAGES_GROUP),
    win("winget-kotlin", "Kotlin", "kotlinc", "JetBrains.Kotlin.Compiler", Some("kotlinc -version"), LANGUAGES_GROUP),
    win("winget-dart", "Dart", "dart", "Dart.Dart", Some("dart --version"), LANGUAGES_GROUP),
    win("winget-zig", "Zig", "zig", "zig.zig", Some("zig version"), LANGUAGES_GROUP),
    win("winget-swift", "Swift", "swift", "Swift.Toolchain", Some("swift --version"), LANGUAGES_GROUP),
    win("winget-mongosh", "MongoDB · mongosh", "mongosh", "MongoDB.Shell", Some("mongosh --version"), LANGUAGES_GROUP),
    win("winget-redis-cli", "Redis · redis-cli", "redis-cli", "Redis.Redis", Some("redis-cli --version"), LANGUAGES_GROUP),
    win("winget-python", "Python",          "python", "Python.Python.3.12",             Some("python --version"),             LANGUAGES_GROUP),
    win("winget-ruby",   "Ruby",            "ruby",   "RubyInstallerTeam.Ruby.3.3",     Some("ruby -v"),                      LANGUAGES_GROUP),
    WindowsTool {
        label_key: Some("tool.java"),
        hint: Some("Instala un JDK completo: incluye jshell, que es el REPL que aparece en el selector de entorno."),
        ..win("winget-java", "Java (JDK)", "java", "EclipseAdoptium.Temurin.21.JDK", Some("java -version"), LANGUAGES_GROUP)
    },
    // Las versiones antiguas desaparecen del directorio activo de descargas
    // de PHP. El manifiesto 8.3.32 de winget conserva una URL sin `/archives/`
    // y devuelve 404; la rama estable actual usa las URLs archivadas válidas.
    win("winget-php",    "PHP",             "php",    "PHP.PHP.8.5",                    Some("php -v"),                       LANGUAGES_GROUP),
    win("winget-go",     "Go",              "go",     "GoLang.Go",                      Some("go version"),                   LANGUAGES_GROUP),
    win("winget-rust",   "Rust (rustup)",   "rustc",  "Rustlang.Rustup",                Some("rustc --version; cargo --version"), LANGUAGES_GROUP),
    win("winget-perl",   "Perl",            "perl",   "StrawberryPerl.StrawberryPerl",  Some("perl -v"),                      LANGUAGES_GROUP),
    win("winget-lua",    "Lua",             "lua",    "DEVCOM.Lua",                     Some("lua -v"),                       LANGUAGES_GROUP),
    win("winget-deno",   "Deno",            "deno",   "DenoLand.Deno",                  Some("deno --version"),               LANGUAGES_GROUP),
    win("winget-bun",    "Bun",             "bun",    "Oven-sh.Bun",                    Some("bun --version"),                LANGUAGES_GROUP),
    win("winget-julia",  "Julia",           "julia",  "Julialang.Julia",               Some("julia --version"),              LANGUAGES_GROUP),
    win("winget-r",      "R",               "R",      "RProject.R",                     Some("R --version"),                  LANGUAGES_GROUP),
    win("winget-dotnet", "C#/F# · .NET SDK", "dotnet", "Microsoft.DotNet.SDK.8",        Some("dotnet --info"),                LANGUAGES_GROUP),
    win("winget-llvm",   "C/C++ · Clang/LLVM", "clang", "LLVM.LLVM",                    Some("clang --version; clang++ --version"), LANGUAGES_GROUP),
    win("winget-cmake",  "C/C++ · CMake",   "cmake",  "Kitware.CMake",                  Some("cmake --version"),               LANGUAGES_GROUP),
    win("winget-maven",  "Java · Maven",   "mvn",    "Apache.Maven",                    Some("mvn --version"),                 LANGUAGES_GROUP),
    win("winget-gradle", "JVM · Gradle",   "gradle", "Gradle.Gradle",                   Some("gradle --version"),              LANGUAGES_GROUP),
    win("winget-ant",    "Java · Ant",     "ant",    "Apache.Ant",                      Some("ant -version"),                   LANGUAGES_GROUP),
    win("winget-bazel",  "C/C++ · Bazel",  "bazel",  "Bazel.Bazel",                     Some("bazel --version"),               LANGUAGES_GROUP),
    win("winget-ninja",  "C/C++ · Ninja",  "ninja",  "Ninja-build.Ninja",               Some("ninja --version"),               LANGUAGES_GROUP),
    win("winget-meson",  "C/C++ · Meson",  "meson",  "MesonBuild.Meson",                Some("meson --version"),               LANGUAGES_GROUP),
    win("winget-gdb",    "C/C++ · GDB",    "gdb",    "MSYS2.MSYS2",                     Some("gdb --version"),                 LANGUAGES_GROUP),
    win("winget-groovy", "Groovy",          "groovysh", "Apache.Groovy.4",              Some("groovy --version"),              LANGUAGES_GROUP),
    win("winget-jq",     "jq · JSON",        "jq",     "jqlang.jq",                      Some("jq --version"),                  TOOLS_GROUP),
    win("winget-yq",     "yq · YAML",        "yq",     "MikeFarah.yq",                   Some("yq --version"),                  TOOLS_GROUP),
    win("winget-openvpn", "OpenVPN",         "openvpn", "OpenVPNTechnologies.OpenVPN",   Some("openvpn --version"),             SSH_GROUP),
    win("winget-wireguard", "WireGuard",     "wg",      "WireGuard.WireGuard",            Some("wg --version"),                  SSH_GROUP),
    win("winget-tailscale", "Tailscale",     "tailscale", "Tailscale.Tailscale",          Some("tailscale version"),             SSH_GROUP),
    win("winget-kubectl", "Kubernetes · kubectl", "kubectl", "Kubernetes.kubectl",       Some("kubectl version --client"),      DOCKER_GROUP),
    win("winget-helm",    "Kubernetes · Helm", "helm", "Helm.Helm",                     Some("helm version --short"),          DOCKER_GROUP),
    win("winget-k9s",     "Kubernetes · k9s (interactivo)", "k9s", "Derailed.k9s",       Some("k9s version --short"),           DOCKER_GROUP),
    WindowsTool {
        hint: Some("Requiere WSL2 y normalmente pide reiniciar Windows antes de poder usarse."),
        ..win("winget-docker", "Docker Desktop", "docker", "Docker.DockerDesktop", Some("docker --version"), DOCKER_GROUP)
    },
]);

/// Visores propuestos cuando el sistema no sabe abrir un archivo (ver
/// `file_viewers`). Aparecen también en el panel para poder instalarlos sin
/// esperar a que algo falle; los ids los referencia `file_viewers`.
#[rustfmt::skip]
static WINDOWS_VIEWERS: Lazy<Vec<WindowsTool>> = Lazy::new(|| vec![
    // Aplicaciones de escritorio: no dejan ejecutable en el PATH, así que no
    // se puede detectar si están instaladas (no_detect).
    WindowsTool { label_key: Some("tool.viewerImage"),       no_detect: true, ..win("viewer-image",    "ImageGlass (imágenes, SVG)",           "", "DuongDieuPhap.ImageGlass", None, VIEWER_GROUP) },
    WindowsTool { label_key: Some("tool.viewerMediaWin"),    no_detect: true, ..win("viewer-media",    "VLC (audio y vídeo)",                  "", "VideoLAN.VLC",             None, VIEWER_GROUP) },
    WindowsTool { label_key: Some("tool.viewerDocumentWin"), no_detect: true, ..win("viewer-document", "SumatraPDF (PDF y libros)",            "", "SumatraPDF.SumatraPDF",    None, VIEWER_GROUP) },
    WindowsTool { label_key: Some("tool.viewerArchiveWin"),  no_detect: true, ..win("viewer-archive",  "7-Zip (comprimidos)",                  "", "7zip.7zip",                None, VIEWER_GROUP) },
]);

const WINGET_INSTALL_FLAGS: &str = "-e --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity";
const WINGET_QUERY_FLAGS: &str =
    "-e --source winget --accept-source-agreements --disable-interactivity";

fn winget_install_command(pkg: &str) -> String {
    format!("winget install --id {pkg} {WINGET_INSTALL_FLAGS}")
}

/// `winget upgrade` solo reconoce instalaciones que puede asociar con su
/// catálogo. Una herramienta presente en PATH (Git instalado desde su web,
/// por ejemplo) puede no estar registrada y el comando respondería que no hay
/// ningún paquete coincidente. Se consulta primero sin mostrar esa salida:
/// si winget no la conoce, `install` hace la adopción/actualización; si ya está
/// al día, se informa sin convertir ese estado normal en un error.
fn winget_update_command(pkg: &str) -> String {
    let install = winget_install_command(pkg);
    format!(
        "$wingetInstalled = winget list --id {pkg} {WINGET_QUERY_FLAGS} | Out-String; \
         if ($wingetInstalled -notmatch [regex]::Escape('{pkg}')) {{ {install} }} else {{ \
         $wingetUpdate = winget list --id {pkg} {WINGET_QUERY_FLAGS} --upgrade-available \
         --include-unknown | Out-String; if ($wingetUpdate -match [regex]::Escape('{pkg}')) {{ \
         winget upgrade --id {pkg} {WINGET_INSTALL_FLAGS} --include-unknown }} else {{ \
         Write-Host '{pkg}: no hay actualizaciones disponibles.' }} }}"
    )
}

fn winget_uninstall_command(pkg: &str) -> String {
    format!(
        "$wingetInstalled = winget list --id {pkg} {WINGET_QUERY_FLAGS} | Out-String; \
         if ($wingetInstalled -match [regex]::Escape('{pkg}')) {{ winget uninstall --id {pkg} \
         -e --source winget --disable-interactivity }} else {{ Write-Host \
         '{pkg}: no está registrado en winget; no se ha desinstalado.' }}"
    )
}

/// Las cuatro acciones de una herramienta de Windows: instalar (solo si
/// falta), y actualizar, desinstalar y ver versión (solo si ya está).
fn windows_tool_actions(tool: &WindowsTool, t: &Translator) -> Vec<InstallAction> {
    let detect = if tool.no_detect || tool.cmd.is_empty() {
        None
    } else {
        Some(tool.cmd)
    };
    // Nombres como "VLC (audio y vídeo)" llevan una coletilla descriptiva que
    // sí se traduce; el nombre propio de dentro, no.
    let label = match tool.label_key {
        Some(key) => t.t(key, tool.label),
        None => tool.label.to_string(),
    };
    // `subgroup` agrupa en el panel las cuatro acciones de una misma
    // herramienta; `short_label` es cómo se lee dentro de ese subgrupo, donde
    // repetir el nombre en cada línea sobra.
    let subgroup = label.clone();

    let mut actions = vec![
        InstallAction::new(
            tool.install_id,
            t.tp(
                "action.install",
                &[("tool", label.clone()), ("source", "winget".to_string())],
                "Instalar {tool} ({source})",
            ),
            winget_install_command(tool.pkg),
        )
        .short(t.tp(
            "action.installShort",
            &[("source", "winget".to_string())],
            "Instalar con {source}",
        ))
        .subgroup(&subgroup)
        .powershell()
        .group(tool.group)
        .check(detect),
        InstallAction::new(
            format!("{}-update", tool.install_id),
            t.tp(
                "action.update",
                &[("tool", label.clone())],
                "Actualizar {tool}",
            ),
            winget_update_command(tool.pkg),
        )
        .short(t.t("action.updateShort", "Actualizar a la última versión"))
        .subgroup(&subgroup)
        .powershell()
        .group(tool.group)
        .verb("Actualizar")
        .requires(detect),
        InstallAction::new(
            format!("{}-uninstall", tool.install_id),
            t.tp(
                "action.uninstall",
                &[("tool", label.clone())],
                "Desinstalar {tool}",
            ),
            winget_uninstall_command(tool.pkg),
        )
        .short(t.t("action.uninstallShort", "Desinstalar del sistema"))
        .subgroup(&subgroup)
        .powershell()
        .group(tool.group)
        .verb("Desinstalar")
        .requires(detect)
        .hint(
            "Elimina la herramienta del sistema. El comando se escribe en la \
             terminal: revísalo antes de confirmarlo.",
        ),
    ];
    if let Some(hint) = tool.hint {
        actions[0] = actions[0].clone().hint(hint);
    }

    let verify = tool.verify.map(str::to_string).or_else(|| {
        tool.no_detect
            .then(|| format!("winget list --id {} {WINGET_QUERY_FLAGS}", tool.pkg))
    });
    if let Some(verify) = verify {
        let (label_key, label_fallback, short_key, short_fallback, verb) = if tool.no_detect {
            (
                "action.check",
                "Comprobar si {tool} está instalado",
                "action.checkShort",
                "Comprobar si está instalado",
                "Comprobar",
            )
        } else {
            (
                "action.version",
                "Ver versión de {tool}",
                "action.versionShort",
                "Ver versión instalada",
                "Versión",
            )
        };
        actions.push(
            InstallAction::new(
                format!("{}-version", tool.install_id),
                t.tp(label_key, &[("tool", label.clone())], label_fallback),
                verify,
            )
            .short(t.t(short_key, short_fallback))
            .subgroup(&subgroup)
            .powershell()
            .group(tool.group)
            .verb(verb)
            .requires(detect),
        );
    }
    actions
}

// ---- Herramientas de Linux y macOS ----

/// `remove_core` es el desinstalar SIN respuesta automática, para paquetes de
/// los que cuelga medio sistema (bash). El comando se escribe en la terminal
/// igual que los demás, pero ahí el gestor va a preguntar y a listar lo que se
/// llevaría por delante en vez de darlo por aceptado.
struct PkgCommands {
    install: &'static str,
    update: &'static str,
    update_one: &'static str,
    remove: &'static str,
    remove_core: Option<&'static str>,
}

#[rustfmt::skip]
static LINUX_PKG_COMMANDS: &[(&str, PkgCommands)] = &[
    ("apt", PkgCommands {
        install: "sudo apt install -y",
        update: "sudo apt update && sudo apt upgrade -y",
        update_one: "sudo apt install -y --only-upgrade",
        remove: "sudo apt remove -y",
        remove_core: Some("sudo apt remove"),
    }),
    ("dnf", PkgCommands {
        install: "sudo dnf install -y",
        update: "sudo dnf upgrade -y",
        update_one: "sudo dnf upgrade -y",
        remove: "sudo dnf remove -y",
        remove_core: Some("sudo dnf remove"),
    }),
    ("pacman", PkgCommands {
        install: "sudo pacman -S --noconfirm",
        update: "sudo pacman -Syu --noconfirm",
        update_one: "sudo pacman -S --noconfirm",
        remove: "sudo pacman -Rs --noconfirm",
        remove_core: Some("sudo pacman -Rs"),
    }),
    ("zypper", PkgCommands {
        install: "sudo zypper install -y",
        update: "sudo zypper update -y",
        update_one: "sudo zypper update -y",
        remove: "sudo zypper remove -y",
        remove_core: Some("sudo zypper remove"),
    }),
    ("apk", PkgCommands {
        install: "sudo apk add",
        update: "sudo apk update && sudo apk upgrade",
        update_one: "sudo apk upgrade",
        remove: "sudo apk del",
        remove_core: Some("sudo apk del"),
    }),
];

/// Homebrew no distingue entre paquetes normales y "de sistema": no hay
/// `remove_core` que ofrecer.
static BREW_COMMANDS: PkgCommands = PkgCommands {
    install: "brew install",
    update: "brew update && brew upgrade",
    update_one: "brew upgrade",
    remove: "brew uninstall",
    remove_core: None,
};

fn linux_pkg_commands(pkg_manager: &str) -> Option<&'static PkgCommands> {
    LINUX_PKG_COMMANDS
        .iter()
        .find(|(name, _)| *name == pkg_manager)
        .map(|(_, commands)| commands)
}

/// Herramienta con ciclo de vida completo sobre un gestor de paquetes.
/// `pkgs` da el nombre del paquete por gestor, con `default` como respaldo;
/// las de macOS usan una única entrada `default` porque brew es el único.
struct PkgTool {
    id: &'static str,
    label_key: Option<&'static str>,
    label: &'static str,
    cmd: &'static str,
    pkgs: &'static [(&'static str, &'static str)],
    verify: Option<&'static str>,
    group: &'static str,
    /// Medio sistema depende de él: su desinstalación no se automatiza.
    core: bool,
    hint: Option<&'static str>,
}

const fn pkg(
    id: &'static str,
    label: &'static str,
    cmd: &'static str,
    pkgs: &'static [(&'static str, &'static str)],
    verify: Option<&'static str>,
    group: &'static str,
) -> PkgTool {
    PkgTool {
        id,
        label_key: None,
        label,
        cmd,
        pkgs,
        verify,
        group,
        core: false,
        hint: None,
    }
}

impl PkgTool {
    /// El paquete para ESTE gestor, o el de respaldo. Una tabla sin `default`
    /// y sin entrada para el gestor no tiene paquete que instalar.
    fn package_for(&self, pkg_manager: &str) -> Option<&'static str> {
        self.pkgs
            .iter()
            .find(|(name, _)| *name == pkg_manager)
            .or_else(|| self.pkgs.iter().find(|(name, _)| *name == "default"))
            .map(|(_, package)| *package)
    }
}

#[rustfmt::skip]
static LINUX_TOOLS: Lazy<Vec<PkgTool>> = Lazy::new(|| vec![
    // bash está siempre instalado, pero eso no quita que se quiera ver su
    // versión o actualizarlo: sin esta entrada el apartado Shells solo ofrecía
    // acciones de las shells que NO estaban.
    PkgTool { core: true, ..pkg("pkg-bash", "bash", "bash", &[("default", "bash")], Some("bash --version"), SHELLS_GROUP) },
    pkg("pkg-zsh",    "zsh",    "zsh",     &[("default", "zsh")],    Some("zsh --version"),    SHELLS_GROUP),
    pkg("pkg-fish",   "fish",   "fish",    &[("default", "fish")],   Some("fish --version"),   SHELLS_GROUP),
    pkg("pkg-nushell", "Nushell", "nu", &[("pacman", "nushell")], Some("nu --version"), SHELLS_GROUP),
    pkg("pkg-xonsh", "Xonsh", "xonsh", &[("default", "xonsh")], Some("xonsh --version"), SHELLS_GROUP),
    pkg("pkg-elvish", "Elvish", "elvish", &[("default", "elvish")], Some("elvish --version"), SHELLS_GROUP),
    pkg("pkg-git",    "Git",    "git",     &[("default", "git")],    Some("git --version"),    TOOLS_GROUP),
    pkg("pkg-jq", "jq · JSON", "jq", &[("default", "jq")], Some("jq --version"), TOOLS_GROUP),
    pkg("pkg-yq", "yq · YAML", "yq", &[("default", "yq"), ("apt", "yq"), ("pacman", "yq")], Some("yq --version"), TOOLS_GROUP),
    pkg("pkg-gcc", "C/C++ · GCC y herramientas de compilación", "gcc", &[("apt", "build-essential"), ("pacman", "base-devel"), ("dnf", "gcc gcc-c++ make"), ("zypper", "gcc gcc-c++ make"), ("apk", "build-base")], Some("gcc --version; g++ --version"), LANGUAGES_GROUP),
    pkg("pkg-clang", "C/C++ · Clang/LLVM", "clang", &[("default", "clang"), ("pacman", "clang")], Some("clang --version; clang++ --version"), LANGUAGES_GROUP),
    pkg("pkg-cmake", "C/C++ · CMake", "cmake", &[("default", "cmake")], Some("cmake --version"), LANGUAGES_GROUP),
    pkg("pkg-nasm", "Ensamblador · NASM", "nasm", &[("default", "nasm")], Some("nasm -version"), LANGUAGES_GROUP),
    pkg("pkg-yasm", "Ensamblador · YASM", "yasm", &[("default", "yasm")], Some("yasm --version"), LANGUAGES_GROUP),
    pkg("pkg-binutils", "Ensamblador · GNU binutils", "as", &[("default", "binutils")], Some("as --version"), LANGUAGES_GROUP),
    pkg("pkg-gfortran", "Fortran · GNU", "gfortran", &[("default", "gfortran")], Some("gfortran --version"), LANGUAGES_GROUP),
    pkg("pkg-haxe", "Haxe", "haxe", &[("default", "haxe")], Some("haxe --version"), LANGUAGES_GROUP),
    pkg("pkg-guile", "Scheme · Guile", "guile", &[("default", "guile")], Some("guile --version"), LANGUAGES_GROUP),
    pkg("pkg-sbcl", "Common Lisp · SBCL", "sbcl", &[("default", "sbcl")], Some("sbcl --version"), LANGUAGES_GROUP),
    pkg("pkg-tcl", "Tcl", "tclsh", &[("default", "tcl")], Some("tclsh <<< 'puts [info patchlevel]'"), LANGUAGES_GROUP),
    pkg("pkg-octave", "GNU Octave", "octave", &[("default", "octave")], Some("octave --version"), LANGUAGES_GROUP),
    pkg("pkg-maxima", "Maxima", "maxima", &[("default", "maxima")], Some("maxima --version"), LANGUAGES_GROUP),
    pkg("pkg-swipl", "Prolog · SWI", "swipl", &[("default", "swi-prolog")], Some("swipl --version"), LANGUAGES_GROUP),
    pkg("pkg-gforth", "Forth · Gforth", "gforth", &[("default", "gforth")], Some("gforth --version"), LANGUAGES_GROUP),
    pkg("pkg-dotnet-sdk", "C#/F# · .NET SDK", "dotnet", &[("apt", "dotnet-sdk-8.0"), ("pacman", "dotnet-sdk"), ("dnf", "dotnet-sdk-8.0"), ("zypper", "dotnet-sdk-8.0")], Some("dotnet --info"), LANGUAGES_GROUP),
    PkgTool { label_key: Some("tool.nodeNpm"), ..pkg("pkg-node", "Node.js + npm", "node", &[("default", "nodejs npm")], Some("node -v; npm -v"), LANGUAGES_GROUP) },
    pkg("pkg-typescript", "TypeScript + ts-node", "tsc", &[("default", "node-typescript"), ("apt", "node-typescript"), ("dnf", "typescript"), ("pacman", "typescript"), ("zypper", "node-typescript"), ("apk", "typescript")], Some("tsc --version"), LANGUAGES_GROUP),
    pkg("pkg-deno", "Deno", "deno", &[("default", "deno")], Some("deno --version"), LANGUAGES_GROUP),
    pkg("pkg-bun", "Bun", "bun", &[("default", "bun")], Some("bun --version"), LANGUAGES_GROUP),
    pkg("pkg-kotlin", "Kotlin", "kotlinc", &[("default", "kotlin")], Some("kotlinc -version"), LANGUAGES_GROUP),
    pkg("pkg-scala", "Scala", "scala", &[("default", "scala")], Some("scala -version"), LANGUAGES_GROUP),
    pkg("pkg-dart", "Dart", "dart", &[("default", "dart")], Some("dart --version"), LANGUAGES_GROUP),
    pkg("pkg-zig", "Zig", "zig", &[("default", "zig")], Some("zig version"), LANGUAGES_GROUP),
    pkg("pkg-nim", "Nim", "nim", &[("default", "nim")], Some("nim --version"), LANGUAGES_GROUP),
    pkg("pkg-crystal", "Crystal", "crystal", &[("default", "crystal")], Some("crystal --version"), LANGUAGES_GROUP),
    pkg("pkg-swift", "Swift", "swift", &[("default", "swift")], Some("swift --version"), LANGUAGES_GROUP),
    pkg("pkg-maven", "Java · Maven", "mvn", &[("default", "maven")], Some("mvn --version"), LANGUAGES_GROUP),
    pkg("pkg-gradle", "JVM · Gradle", "gradle", &[("default", "gradle")], Some("gradle --version"), LANGUAGES_GROUP),
    pkg("pkg-ant", "Java · Ant", "ant", &[("default", "ant")], Some("ant -version"), LANGUAGES_GROUP),
    pkg("pkg-sbt", "Scala · sbt", "sbt", &[("default", "sbt")], Some("sbt --version"), LANGUAGES_GROUP),
    pkg("pkg-bazel", "C/C++ · Bazel", "bazel", &[("default", "bazel")], Some("bazel --version"), LANGUAGES_GROUP),
    pkg("pkg-ninja", "C/C++ · Ninja", "ninja", &[("default", "ninja-build")], Some("ninja --version"), LANGUAGES_GROUP),
    pkg("pkg-meson", "C/C++ · Meson", "meson", &[("default", "meson")], Some("meson --version"), LANGUAGES_GROUP),
    pkg("pkg-clang-tidy", "C/C++ · clang-tidy", "clang-tidy", &[("default", "clang-tools-extra")], Some("clang-tidy --version"), LANGUAGES_GROUP),
    pkg("pkg-gdb", "C/C++ · GDB", "gdb", &[("default", "gdb")], Some("gdb --version"), LANGUAGES_GROUP),
    pkg("pkg-lldb", "C/C++ · LLDB", "lldb", &[("default", "lldb")], Some("lldb --version"), LANGUAGES_GROUP),
    pkg("pkg-valgrind", "C/C++ · Valgrind", "valgrind", &[("default", "valgrind")], Some("valgrind --version"), LANGUAGES_GROUP),
    pkg("pkg-python", "Python", "python3", &[("default", "python3"), ("pacman", "python")], Some("python3 --version"), LANGUAGES_GROUP),
    pkg("pkg-ruby",   "Ruby",   "ruby",    &[("default", "ruby"), ("apt", "ruby-full")], Some("ruby -v"), LANGUAGES_GROUP),
    PkgTool {
        label_key: Some("tool.java"),
        hint: Some("El JDK incluye jshell, el REPL de Java que aparece en el selector de entorno."),
        ..pkg("pkg-java", "Java (JDK)", "java",
            &[("default", "java-openjdk-devel"), ("apt", "default-jdk"), ("dnf", "java-latest-openjdk-devel"), ("pacman", "jdk-openjdk"), ("apk", "openjdk17-jdk")],
            Some("java -version"), LANGUAGES_GROUP)
    },
    pkg("pkg-php",    "PHP",    "php",     &[("default", "php-cli"), ("pacman", "php"), ("zypper", "php8")], Some("php -v"), LANGUAGES_GROUP),
    pkg("pkg-go",     "Go",     "go",      &[("default", "golang"), ("pacman", "go"), ("zypper", "go")], Some("go version"), LANGUAGES_GROUP),
    pkg("pkg-rust",   "Rust",   "rustc",   &[("default", "rust cargo"), ("apt", "rustc cargo"), ("pacman", "rust")], Some("rustc --version; cargo --version"), LANGUAGES_GROUP),
    pkg("pkg-perl",   "Perl",   "perl",    &[("default", "perl")],   Some("perl -v"),          LANGUAGES_GROUP),
    pkg("pkg-lua",    "Lua",    "lua",     &[("default", "lua"), ("apt", "lua5.4"), ("zypper", "lua54")], Some("lua -v"), LANGUAGES_GROUP),
    pkg("pkg-julia",  "Julia",  "julia",   &[("default", "julia")], Some("julia --version"), LANGUAGES_GROUP),
    pkg("pkg-r",      "R",      "R",       &[("default", "r-base"), ("pacman", "r"), ("dnf", "R")], Some("R --version"), LANGUAGES_GROUP),
    pkg("pkg-erlang", "Erlang", "erl",     &[("default", "erlang")], Some("erl -noshell -eval 'halt().'"), LANGUAGES_GROUP),
    pkg("pkg-elixir", "Elixir", "iex",     &[("default", "elixir")], Some("elixir --version"), LANGUAGES_GROUP),
    pkg("pkg-ocaml",  "OCaml",  "ocaml",   &[("default", "ocaml")], Some("ocaml -version"), LANGUAGES_GROUP),
    pkg("pkg-racket", "Racket", "racket",  &[("default", "racket")], Some("racket --version"), LANGUAGES_GROUP),
    pkg("pkg-clojure","Clojure","clj",    &[("default", "clojure")], Some("clojure -Sdescribe"), LANGUAGES_GROUP),
    pkg("pkg-haskell","Haskell · GHCi", "ghci", &[("default", "ghc")], Some("ghc --version"), LANGUAGES_GROUP),
    pkg("pkg-sqlite", "SQLite", "sqlite3", &[("default", "sqlite3")], Some("sqlite3 --version"), LANGUAGES_GROUP),
    pkg("pkg-mariadb", "MariaDB + InnoDB", "mariadb", &[("apt", "mariadb-client"), ("dnf", "mariadb"), ("pacman", "mariadb"), ("zypper", "mariadb"), ("apk", "mariadb")], Some("mariadb --version"), LANGUAGES_GROUP),
    pkg("pkg-mysql", "MySQL + InnoDB", "mysql", &[("apt", "default-mysql-client"), ("dnf", "mysql"), ("pacman", "mariadb"), ("zypper", "mysql-client"), ("apk", "mysql-client")], Some("mysql --version"), LANGUAGES_GROUP),
    pkg("pkg-postgresql", "PostgreSQL + psql", "psql", &[("default", "postgresql"), ("apt", "postgresql-client"), ("dnf", "postgresql"), ("pacman", "postgresql"), ("zypper", "postgresql"), ("apk", "postgresql-client")], Some("psql --version"), LANGUAGES_GROUP),
    pkg("pkg-duckdb", "DuckDB", "duckdb", &[("default", "duckdb")], Some("duckdb --version"), LANGUAGES_GROUP),
    pkg("pkg-mongosh", "MongoDB · mongosh", "mongosh", &[("default", "mongodb-mongosh")], Some("mongosh --version"), LANGUAGES_GROUP),
    pkg("pkg-redis-cli", "Redis · redis-cli", "redis-cli", &[("default", "redis")], Some("redis-cli --version"), LANGUAGES_GROUP),
    pkg("pkg-openvpn", "OpenVPN", "openvpn", &[("default", "openvpn")], Some("openvpn --version"), SSH_GROUP),
    pkg("pkg-wireguard", "WireGuard", "wg", &[("default", "wireguard-tools")], Some("wg --version"), SSH_GROUP),
    pkg("pkg-kubectl", "Kubernetes · kubectl", "kubectl", &[("apt", "kubectl"), ("pacman", "kubectl"), ("dnf", "kubernetes-client"), ("zypper", "kubectl"), ("apk", "kubectl")], Some("kubectl version --client"), DOCKER_GROUP),
    pkg("pkg-helm", "Kubernetes · Helm", "helm", &[("pacman", "helm"), ("dnf", "helm"), ("zypper", "helm"), ("apk", "helm")], Some("helm version --short"), DOCKER_GROUP),
    pkg("pkg-k9s", "Kubernetes · k9s (interactivo)", "k9s", &[("pacman", "k9s")], Some("k9s version --short"), DOCKER_GROUP),
    pkg("pkg-tailscale", "Tailscale", "tailscale", &[("pacman", "tailscale"), ("apk", "tailscale")], Some("tailscale version"), SSH_GROUP),
]);

#[rustfmt::skip]
static LINUX_VIEWERS: Lazy<Vec<PkgTool>> = Lazy::new(|| vec![
    PkgTool { label_key: Some("tool.viewerImageLinux"), ..pkg("viewer-image",    "Eye of GNOME (imágenes)", "eog",   &[("default", "eog")],    None,                  VIEWER_GROUP) },
    PkgTool { label_key: Some("tool.viewerMedia"),      ..pkg("viewer-media",    "VLC (audio y vídeo)",     "vlc",   &[("default", "vlc")],    Some("vlc --version"), VIEWER_GROUP) },
    PkgTool { label_key: Some("tool.viewerDocument"),   ..pkg("viewer-document", "Evince (PDF)",            "evince",&[("default", "evince")], None,                  VIEWER_GROUP) },
    PkgTool { label_key: Some("tool.viewerArchive"),    ..pkg("viewer-archive",  "p7zip (comprimidos)",     "7z",    &[("default", "p7zip"), ("apt", "p7zip-full")], Some("7z i"), VIEWER_GROUP) },
]);

/// Gestores de archivos gráficos. Solo hacen falta en Linux: Windows y macOS
/// traen el suyo y nunca se puede quedar el sistema sin ninguno. Se ofrecen
/// para abrir una carpeta basta con tener uno y no conviene convertir una
/// elección simple en una lista de instaladores. Los
/// ids coinciden con los de `FILE_MANAGERS` en `file_viewers`.
#[rustfmt::skip]
static FILE_MANAGER_TOOLS: Lazy<Vec<PkgTool>> = Lazy::new(|| vec![
    pkg("viewer-files-dolphin", "Dolphin (KDE)",          "dolphin", &[("default", "dolphin")], Some("dolphin --version"), VIEWER_GROUP),
]);

/// macOS: mismo ciclo de vida sobre Homebrew. Los identificadores de instalar
/// se conservan porque `command_not_found` los referencia.
#[rustfmt::skip]
static MAC_TOOLS: Lazy<Vec<PkgTool>> = Lazy::new(|| vec![
    // macOS trae bash 3.2 de 2007 por licencia; brew instala uno actual.
    PkgTool { core: true, ..pkg("brew-bash", "bash", "bash", &[("default", "bash")], Some("bash --version"), SHELLS_GROUP) },
    pkg("brew-zsh",    "zsh",           "zsh",     &[("default", "zsh")],    Some("zsh --version"),    SHELLS_GROUP),
    pkg("brew-fish",   "fish",          "fish",    &[("default", "fish")],   Some("fish --version"),   SHELLS_GROUP),
    pkg("brew-git",    "Git",           "git",     &[("default", "git")],    Some("git --version"),    TOOLS_GROUP),
    pkg("brew-node",   "Node.js",       "node",    &[("default", "node")],   Some("node -v; npm -v"),  LANGUAGES_GROUP),
    pkg("brew-python", "Python",        "python3", &[("default", "python")], Some("python3 --version"), LANGUAGES_GROUP),
    pkg("brew-ruby",   "Ruby",          "ruby",    &[("default", "ruby")],   Some("ruby -v"),          LANGUAGES_GROUP),
    PkgTool { label_key: Some("tool.java"), ..pkg("brew-java", "Java (JDK)", "java", &[("default", "openjdk")], Some("java -version"), LANGUAGES_GROUP) },
    pkg("brew-maven", "Java · Maven", "mvn", &[("default", "maven")], Some("mvn --version"), LANGUAGES_GROUP),
    pkg("brew-gradle", "JVM · Gradle", "gradle", &[("default", "gradle")], Some("gradle --version"), LANGUAGES_GROUP),
    pkg("brew-ant", "Java · Ant", "ant", &[("default", "ant")], Some("ant -version"), LANGUAGES_GROUP),
    pkg("brew-bazel", "C/C++ · Bazel", "bazel", &[("default", "bazel")], Some("bazel --version"), LANGUAGES_GROUP),
    pkg("brew-ninja", "C/C++ · Ninja", "ninja", &[("default", "ninja")], Some("ninja --version"), LANGUAGES_GROUP),
    pkg("brew-meson", "C/C++ · Meson", "meson", &[("default", "meson")], Some("meson --version"), LANGUAGES_GROUP),
    pkg("brew-php",    "PHP",           "php",     &[("default", "php")],    Some("php -v"),           LANGUAGES_GROUP),
    pkg("brew-go",     "Go",            "go",      &[("default", "go")],     Some("go version"),       LANGUAGES_GROUP),
    pkg("brew-rust",   "Rust",          "rustc",   &[("default", "rust")],   Some("rustc --version; cargo --version"), LANGUAGES_GROUP),
    pkg("brew-perl",   "Perl",          "perl",    &[("default", "perl")],   Some("perl -v"),          LANGUAGES_GROUP),
    pkg("brew-lua",    "Lua",           "lua",     &[("default", "lua")],    Some("lua -v"),           LANGUAGES_GROUP),
    pkg("brew-deno",   "Deno",          "deno",    &[("default", "deno")],   Some("deno --version"),   LANGUAGES_GROUP),
]);

#[rustfmt::skip]
static MAC_VIEWERS: Lazy<Vec<PkgTool>> = Lazy::new(|| vec![
    PkgTool { label_key: Some("tool.viewerMedia"),   ..pkg("viewer-media",   "VLC (audio y vídeo)",                 "vlc",  &[("default", "--cask vlc")], None,                   VIEWER_GROUP) },
    PkgTool { label_key: Some("tool.viewerArchive"), ..pkg("viewer-archive", "p7zip (comprimidos)",                 "7z",   &[("default", "p7zip")],      Some("7z i"),           VIEWER_GROUP) },
    PkgTool { label_key: Some("tool.viewerCode"),    ..pkg("viewer-code",    "Visual Studio Code (código y texto)", "code", &[("default", "--cask visual-studio-code")], Some("code --version"), VIEWER_GROUP) },
]);

/// Instalar, actualizar, desinstalar y ver versión a partir de una entrada de
/// las tablas anteriores. Compartido por Linux y macOS.
fn tool_lifecycle_actions(
    tool: &PkgTool,
    package: &str,
    commands: &PkgCommands,
    source: &str,
    t: &Translator,
) -> Vec<InstallAction> {
    let label = match tool.label_key {
        Some(key) => t.t(key, tool.label),
        None => tool.label.to_string(),
    };
    let subgroup = label.clone();

    let mut install = InstallAction::new(
        tool.id,
        t.tp(
            "action.install",
            &[("tool", label.clone()), ("source", source.to_string())],
            "Instalar {tool} ({source})",
        ),
        format!("{} {package}", commands.install),
    )
    .short(t.tp(
        "action.installShort",
        &[("source", source.to_string())],
        "Instalar con {source}",
    ))
    .subgroup(&subgroup)
    .group(tool.group)
    .check(Some(tool.cmd));
    if let Some(hint) = tool.hint {
        install = install.hint(hint);
    }

    let remove = match (tool.core, commands.remove_core) {
        (true, Some(remove_core)) => remove_core,
        _ => commands.remove,
    };
    let uninstall_hint = if tool.core {
        format!(
            "Muchísimos paquetes y scripts del sistema dependen de {label}: el gestor va a pedir \
             confirmación y a listar todo lo que se llevaría por delante. Léelo antes de aceptar."
        )
    } else {
        "Elimina el paquete del sistema. El comando se escribe en la terminal: revísalo antes de \
         confirmarlo."
            .to_string()
    };

    let mut actions = vec![
        install,
        InstallAction::new(
            format!("{}-update", tool.id),
            t.tp(
                "action.update",
                &[("tool", label.clone())],
                "Actualizar {tool}",
            ),
            format!("{} {package}", commands.update_one),
        )
        .short(t.t("action.updateShort", "Actualizar a la última versión"))
        .subgroup(&subgroup)
        .group(tool.group)
        .verb("Actualizar")
        .requires(Some(tool.cmd)),
        InstallAction::new(
            format!("{}-uninstall", tool.id),
            t.tp(
                "action.uninstall",
                &[("tool", label.clone())],
                "Desinstalar {tool}",
            ),
            format!("{remove} {package}"),
        )
        .short(t.t("action.uninstallShort", "Desinstalar del sistema"))
        .subgroup(&subgroup)
        .group(tool.group)
        .verb("Desinstalar")
        .requires(Some(tool.cmd))
        .hint(uninstall_hint),
    ];
    if let Some(verify) = tool.verify {
        actions.push(
            InstallAction::new(
                format!("{}-version", tool.id),
                t.tp(
                    "action.version",
                    &[("tool", label.clone())],
                    "Ver versión de {tool}",
                ),
                verify,
            )
            .short(t.t("action.versionShort", "Ver versión instalada"))
            .subgroup(&subgroup)
            .group(tool.group)
            .verb("Versión")
            .requires(Some(tool.cmd)),
        );
    }
    actions
}

/// Editores de código como menú único. Son alternativas excluyentes de la
/// misma función, no ocho visores distintos: el usuario puede desplegar el
/// apartado y elegir el editor que prefiera sin que VS Code aparezca como
/// instalación predeterminada.
fn linux_code_editor_actions(
    pm: &str,
    commands: &PkgCommands,
    _t: &Translator,
) -> Vec<InstallAction> {
    let editors = [
        ("viewer-code-oss", "Code - OSS", "code", "code-oss"),
        (
            "viewer-code",
            "Visual Studio Code",
            "code",
            "visual-studio-code-bin",
        ),
        ("editor-vscodium", "VSCodium", "codium", "vscodium"),
        ("editor-zed", "Zed", "zed", "zed"),
        ("editor-kate", "Kate", "kate", "kate"),
        ("editor-neovim", "Neovim", "nvim", "neovim"),
        ("editor-geany", "Geany", "geany", "geany"),
        ("editor-emacs", "Emacs", "emacs", "emacs"),
        ("editor-helix", "Helix", "hx", "helix"),
        ("editor-micro", "micro", "micro", "micro"),
    ];
    editors
        .into_iter()
        .map(|(id, label, command, package)| {
            // En Arch, `code` es el paquete comunitario de Code - OSS. En
            // las demás familias conservamos el nombre habitual `code-oss`.
            // VS Code sigue siendo una alternativa separada y, en Arch,
            // utiliza el paquete binario de AUR que ya ofrecía el catálogo.
            let package = match (id, pm) {
                ("viewer-code-oss", "pacman") => "code",
                ("viewer-code", "pacman") => "visual-studio-code-bin",
                _ => package,
            };
            InstallAction::new(
                id,
                format!("{label} (código y texto)"),
                format!("{} {package}", commands.install),
            )
            // Dentro del submenú no sirve repetir «Instalar con pacman»: el
            // usuario necesita distinguir qué editor va a instalar. El
            // gestor queda visible en el comando y en la ayuda de abajo.
            .short(format!("{label} (código y texto)"))
            .group(VIEWER_GROUP)
            .subgroup(CODE_EDITORS_SUBGROUP)
            .check(Some(command))
            .hint("Alternativa de editor; la disponibilidad del paquete depende de la distribución y sus repositorios." )
        })
        .collect()
}

fn windows_code_editor_actions(_t: &Translator) -> Vec<InstallAction> {
    let editors = [
        (
            "viewer-code",
            "Visual Studio Code",
            "Microsoft.VisualStudioCode",
            "code",
            Some("code"),
        ),
        (
            "editor-vscodium-win",
            "VSCodium",
            "VSCodium.VSCodium",
            "codium",
            Some("codium"),
        ),
        (
            "editor-zed-win",
            "Zed",
            "ZedIndustries.Zed",
            "zed",
            Some("zed"),
        ),
        (
            "editor-notepadpp-win",
            "Notepad++",
            "Notepad++.Notepad++",
            "notepad++",
            Some("notepad++"),
        ),
        (
            "editor-sublime-win",
            "Sublime Text",
            "SublimeHQ.SublimeText.4",
            "subl",
            Some("subl"),
        ),
        (
            "editor-cursor-win",
            "Cursor",
            "Anysphere.Cursor",
            "cursor",
            Some("cursor"),
        ),
        (
            "editor-antigravity-win",
            "Google Antigravity",
            "",
            "antigravity",
            None,
        ),
        (
            "editor-visualstudio-win",
            "Visual Studio Community",
            "Microsoft.VisualStudio.2022.Community",
            "devenv",
            Some("devenv"),
        ),
        (
            "editor-jetbrains-toolbox-win",
            "JetBrains Toolbox",
            "JetBrains.Toolbox",
            "jetbrains-toolbox",
            Some("jetbrains-toolbox"),
        ),
    ];
    editors
        .into_iter()
        .map(|(id, label, package, _command, check)| {
            let is_official_download = package.is_empty();
            InstallAction::new(
                id,
                if is_official_download {
                    "Google Antigravity (descarga oficial)".to_string()
                } else {
                    format!("{label} (código y texto)")
                },
                if is_official_download {
                    "Start-Process 'https://antigravity.google/download?app=antigravity'".to_string()
                } else {
                    winget_install_command(package)
                },
            )
            .short(if is_official_download {
                "Abrir descarga oficial".to_string()
            } else {
                format!("{label} (código y texto)")
            })
            .group(VIEWER_GROUP)
            .subgroup(CODE_EDITORS_SUBGROUP)
            .powershell()
            .check(check)
            .hint(if is_official_download {
                "Abre la página oficial para elegir el instalador de Windows. No se descarga ni instala nada en segundo plano."
            } else {
                "Editor opcional; se instala desde el catálogo de winget y solo aparece mientras no esté detectado."
            })
        })
        .collect()
}

/// `sh` no es un paquete: es un enlace al intérprete POSIX que haya elegido la
/// distribución (bash en Arch y macOS, dash en Debian/Ubuntu). Por eso aquí no
/// hay instalar/actualizar/desinstalar que ofrecer sin mentir — se actualiza y
/// se quita con el paquete que lo proporciona — y lo útil es justo poder ver
/// cuál es ese paquete. El comando lo resuelve en el momento.
fn posix_sh_action() -> InstallAction {
    InstallAction::new(
        "sh-version",
        "Ver qué shell proporciona sh",
        "command -v sh; readlink -f \"$(command -v sh)\"; sh --version 2>/dev/null || echo \"(sh POSIX, sin --version)\"",
    )
    .short("Ver versión y de dónde sale")
    .subgroup("sh")
    .group(SHELLS_GROUP)
    .verb("Versión")
    .requires(Some("sh"))
    .hint(
        "sh es un enlace al intérprete POSIX del sistema (bash o dash según la distribución). Se \
         actualiza y se desinstala junto al paquete que lo proporciona, no por separado.",
    )
}

// ---- Actualización de los repositorios clonados ----

const GIT_PULL_HINT: &str = "Recorre la carpeta de proyectos y hace pull --ff-only en cada \
                             repositorio Git. Los que tengan cambios locales o divergentes se \
                             saltan con su aviso.";

/// Actualización con git de los repositorios que la app ha clonado en la
/// carpeta de proyectos (`<carpeta>/<propietario>/<repositorio>`). Solo hace
/// `pull --ff-only`: nunca reescribe historia ni descarta cambios locales, y un
/// repositorio con trabajo sin guardar simplemente informa y se salta.
fn git_pull_projects_action(projects_folder: &str) -> InstallAction {
    let folder = ps_single(projects_folder);
    InstallAction::new(
        "git-pull-projects",
        "Actualizar repositorios clonados (git pull)",
        format!(
            "if (Test-Path {folder}) {{ \
             Get-ChildItem -Path {folder} -Directory -Recurse -Depth 2 \
             | Where-Object {{ Test-Path (Join-Path $_.FullName '.git') }} \
             | ForEach-Object {{ Write-Host ('== ' + $_.FullName) -ForegroundColor Cyan; git -C $_.FullName pull --ff-only }} \
             }} else {{ Write-Host 'Todavia no hay repositorios clonados en la carpeta de proyectos.' -ForegroundColor Yellow }}"
        ),
    )
    .powershell()
    .group(UPDATES_GROUP)
    .verb("Actualizar")
    .requires(Some("git"))
    .hint(GIT_PULL_HINT)
}

/// Equivalente POSIX del anterior, para macOS y Linux. Igual que el resto de
/// acciones de esas plataformas, asume una shell tipo bash/zsh/sh.
fn git_pull_projects_posix_action(projects_folder: &str) -> InstallAction {
    let folder = sh_single(projects_folder);
    InstallAction::new(
        "git-pull-projects",
        "Actualizar repositorios clonados (git pull)",
        format!(
            "for repo in {folder}/*/*/.git; do [ -d \"$repo\" ] || continue; \
             dir=\"${{repo%/.git}}\"; echo \"== $dir\"; git -C \"$dir\" pull --ff-only; done"
        ),
    )
    .group(UPDATES_GROUP)
    .verb("Actualizar")
    .requires(Some("git"))
    .hint(GIT_PULL_HINT)
}

/// Mete un bloque de acciones sueltas en el mismo apartado y plegable. Una
/// acción que ya trae apartado o plegable propio conserva el suyo.
fn in_subgroup(group: &str, subgroup: &str, actions: Vec<InstallAction>) -> Vec<InstallAction> {
    actions
        .into_iter()
        .map(|mut action| {
            if action.group.is_empty() {
                action.group = group.to_string();
            }
            if action.subgroup.is_none() {
                action.subgroup = Some(subgroup.to_string());
            }
            action
        })
        .collect()
}

/// Ecosistemas que se instalan encima de un intérprete. No son shells ni
/// lenguajes nuevos: se muestran en su propio apartado para que, por ejemplo,
/// Pyramid no quede mezclado con Python ni TypeScript se confunda con Node.
/// Las acciones requieren el runtime correspondiente y siguen escribiendo el
/// comando visible en la pestaña activa, igual que el resto del catálogo.
fn ecosystem_action(
    id: &str,
    label: &str,
    command: String,
    subgroup: &str,
    hint: &str,
) -> InstallAction {
    InstallAction::new(id.to_string(), label.to_string(), command)
        .short(format!("Instalar {label}"))
        .group(FRAMEWORKS_GROUP)
        .subgroup(subgroup)
        .hint(hint)
}

fn ecosystem_actions(python_cmd: &'static str, npm_cmd: &'static str) -> Vec<InstallAction> {
    let mut actions = Vec::new();
    for (id, label, package) in [
        ("framework-pyramid", "Pyramid", "pyramid"),
        ("framework-django", "Django", "django"),
        ("framework-flask", "Flask", "flask"),
        ("framework-fastapi", "FastAPI", "fastapi"),
        ("framework-sqlalchemy", "SQLAlchemy", "sqlalchemy"),
        ("framework-tornado", "Tornado", "tornado"),
        ("framework-sanic", "Sanic", "sanic"),
        ("framework-pydantic", "Pydantic", "pydantic"),
        ("framework-celery", "Celery", "celery"),
        ("framework-scrapy", "Scrapy", "scrapy"),
        ("framework-pytest", "pytest", "pytest"),
        ("framework-jupyter", "Jupyter", "jupyter"),
        ("framework-bottle", "Bottle", "bottle"),
        ("framework-falcon", "Falcon", "falcon"),
        ("framework-litestar", "Litestar", "litestar"),
        ("framework-wagtail", "Wagtail", "wagtail"),
        ("framework-streamlit", "Streamlit", "streamlit"),
        ("framework-mkdocs", "MkDocs", "mkdocs"),
        ("framework-poetry", "Poetry", "poetry"),
        ("framework-pipenv", "Pipenv", "pipenv"),
        ("framework-starlette", "Starlette", "starlette"),
        ("framework-aiohttp", "aiohttp", "aiohttp"),
        ("framework-httpx", "HTTPX", "httpx"),
        ("framework-uvicorn", "Uvicorn", "uvicorn"),
        ("framework-gunicorn", "Gunicorn", "gunicorn"),
        ("framework-jinja", "Jinja", "jinja2"),
        ("framework-alembic", "Alembic", "alembic"),
        ("framework-marshmallow", "Marshmallow", "marshmallow"),
        ("framework-hypothesis", "Hypothesis", "hypothesis"),
        (
            "framework-pytest-asyncio",
            "pytest-asyncio",
            "pytest-asyncio",
        ),
        ("framework-numpy", "NumPy", "numpy"),
        ("framework-pandas", "pandas", "pandas"),
        ("framework-scipy", "SciPy", "scipy"),
        ("framework-matplotlib", "Matplotlib", "matplotlib"),
        ("framework-gradio", "Gradio", "gradio"),
        ("framework-locust", "Locust", "locust"),
        ("framework-sphinx", "Sphinx", "sphinx"),
        ("framework-pre-commit", "pre-commit", "pre-commit"),
        ("framework-mypy", "Mypy", "mypy"),
        ("framework-ruff", "Ruff", "ruff"),
        ("framework-black", "Black", "black"),
        ("framework-isort", "isort", "isort"),
        ("framework-tox", "tox", "tox"),
        ("framework-nox", "Nox", "nox"),
        ("framework-invoke", "Invoke", "invoke"),
        ("framework-click", "Click", "click"),
        ("framework-typer", "Typer", "typer"),
        (
            "framework-django-rest",
            "Django REST Framework",
            "djangorestframework",
        ),
        ("framework-django-ninja", "Django Ninja", "django-ninja"),
        ("framework-robot", "Robot Framework", "robotframework"),
        ("framework-coverage", "Coverage.py", "coverage"),
        ("framework-seaborn", "Seaborn", "seaborn"),
        ("framework-polars", "Polars", "polars"),
        ("framework-torch", "PyTorch", "torch"),
        ("framework-tensorflow", "TensorFlow", "tensorflow"),
        ("framework-opencv", "OpenCV", "opencv-python"),
        ("framework-pillow", "Pillow", "pillow"),
        ("framework-pyspark", "PySpark", "pyspark"),
        ("framework-sqlmodel", "SQLModel", "sqlmodel"),
        ("framework-tortoise", "Tortoise ORM", "tortoise-orm"),
        ("framework-psycopg", "Psycopg", "psycopg[binary]"),
        ("framework-asyncpg", "asyncpg", "asyncpg"),
        ("framework-redis-py", "redis-py", "redis"),
        ("framework-boto3", "Boto3", "boto3"),
        ("framework-ansible", "Ansible", "ansible"),
        ("framework-prefect", "Prefect", "prefect"),
        ("framework-mlflow", "MLflow", "mlflow"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Python)"),
            format!("{python_cmd} -m pip install --user {package}"),
            "Python · frameworks y librerías",
            "Necesita Python y pip. Si no están instalados, instálalos primero desde Lenguajes; después, vuelve a abrir Entorno y dependencias.",
        ));
    }
    for (id, label, packages) in [
        (
            "tool-typescript",
            "TypeScript + ts-node",
            "typescript ts-node",
        ),
        ("framework-vite", "Vite", "vite"),
        ("framework-nest", "NestJS CLI", "@nestjs/cli"),
        ("framework-angular", "Angular CLI", "@angular/cli"),
        ("framework-next", "Next.js", "create-next-app"),
        ("framework-nuxt", "Nuxt", "nuxi"),
        ("framework-astro", "Astro", "create-astro"),
        ("framework-svelte", "Svelte", "svelte"),
        ("framework-electron", "Electron", "electron"),
        ("framework-express", "Express", "express-generator"),
        ("framework-remix", "Remix", "create-remix"),
        ("framework-redwood", "RedwoodJS", "redwoodjs"),
        ("framework-playwright", "Playwright", "playwright"),
        ("framework-jest", "Jest", "jest"),
        ("framework-eslint", "ESLint", "eslint"),
        ("framework-prettier", "Prettier", "prettier"),
        (
            "framework-react",
            "React · create-react-app",
            "create-react-app",
        ),
        ("framework-vue", "Vue CLI", "@vue/cli"),
        ("framework-solid", "SolidStart", "create-solid"),
        ("framework-qwik", "Qwik", "create-qwik"),
        ("framework-preact", "Preact", "preact-cli"),
        ("framework-webpack", "Webpack", "webpack webpack-cli"),
        ("framework-rollup", "Rollup", "rollup"),
        ("framework-parcel", "Parcel", "parcel"),
        ("framework-esbuild", "esbuild", "esbuild"),
        ("framework-swc", "SWC", "@swc/cli @swc/core"),
        ("framework-babel", "Babel", "@babel/cli @babel/core"),
        ("framework-tsx", "tsx", "tsx"),
        ("framework-pnpm", "pnpm", "pnpm"),
        ("framework-yarn", "Yarn", "yarn"),
        ("framework-turbo", "Turborepo", "turbo"),
        ("framework-nx", "Nx", "nx"),
        ("framework-storybook", "Storybook", "storybook"),
        ("framework-vitest", "Vitest", "vitest"),
        ("framework-cypress", "Cypress", "cypress"),
        ("framework-mocha", "Mocha", "mocha"),
        ("framework-ava", "AVA", "ava"),
        ("framework-prisma", "Prisma", "prisma"),
        ("framework-drizzle", "Drizzle Kit", "drizzle-kit"),
        ("framework-typeorm", "TypeORM CLI", "typeorm"),
        ("framework-sequelize", "Sequelize CLI", "sequelize-cli"),
        ("framework-lerna", "Lerna", "lerna"),
        ("framework-changesets", "Changesets", "@changesets/cli"),
        ("framework-hono", "Hono", "hono"),
        ("framework-fastify", "Fastify", "fastify"),
        ("framework-koa", "Koa", "koa-generator"),
        ("framework-sails", "Sails.js", "sails"),
        ("framework-trpc", "tRPC", "@trpc/server @trpc/client"),
        ("framework-serverless", "Serverless Framework", "serverless"),
        ("framework-vercel", "Vercel CLI", "vercel"),
        ("framework-netlify", "Netlify CLI", "netlify-cli"),
        ("framework-firebase", "Firebase CLI", "firebase-tools"),
        ("framework-aws-cdk", "AWS CDK", "aws-cdk"),
        ("framework-tsup", "tsup", "tsup"),
        ("framework-unbuild", "unbuild", "unbuild"),
        ("framework-gulp", "Gulp", "gulp-cli"),
        ("framework-grunt", "Grunt", "grunt-cli"),
        ("framework-husky", "Husky", "husky"),
        ("framework-lint-staged", "lint-staged", "lint-staged"),
        (
            "framework-commitlint",
            "Commitlint",
            "@commitlint/cli @commitlint/config-conventional",
        ),
        (
            "framework-semantic-release",
            "semantic-release",
            "semantic-release",
        ),
        ("framework-release-it", "release-it", "release-it"),
        ("framework-msw", "Mock Service Worker", "msw"),
        ("framework-supertest", "Supertest", "supertest"),
        ("framework-c8", "c8", "c8"),
        ("framework-typedoc", "TypeDoc", "typedoc"),
        ("framework-ts-jest", "ts-jest", "ts-jest"),
        ("framework-zod", "Zod", "zod"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (JavaScript / TypeScript)"),
            format!("{npm_cmd} install --global {packages}"),
            "JavaScript / TypeScript · herramientas y frameworks",
            "Necesita Node.js y npm. Si no están instalados, instálalos primero desde Lenguajes; después, vuelve a abrir Entorno y dependencias.",
        ));
    }

    for (id, label, packages) in [
        ("framework-purescript", "PureScript", "purescript"),
        ("framework-spago", "Spago", "spago"),
        ("framework-pulp", "Pulp", "pulp"),
        ("framework-elm", "Elm", "elm"),
        ("framework-elm-test", "Elm Test", "elm-test"),
        ("framework-elm-format", "Elm Format", "elm-format"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (PureScript / Elm)"),
            format!("{npm_cmd} install --global {packages}"),
            "PureScript / Elm · ecosistema funcional",
            "Necesita Node.js y npm. Instala las herramientas del ecosistema para poder abrir sus REPL o crear proyectos.",
        ));
    }

    for (id, label, command) in [
        (
            "framework-cargo-leptos",
            "Leptos",
            "cargo install cargo-leptos",
        ),
        (
            "framework-wasm-pack",
            "wasm-pack",
            "cargo install wasm-pack",
        ),
        (
            "framework-trunk",
            "Trunk · WebAssembly",
            "cargo install trunk",
        ),
        (
            "framework-cargo-watch",
            "cargo-watch",
            "cargo install cargo-watch",
        ),
        (
            "framework-cargo-nextest",
            "cargo-nextest",
            "cargo install cargo-nextest",
        ),
        ("framework-sqlx-cli", "SQLx CLI", "cargo install sqlx-cli"),
        (
            "framework-diesel-cli",
            "Diesel CLI",
            "cargo install diesel_cli",
        ),
        ("framework-mdbook", "mdBook", "cargo install mdbook"),
        (
            "framework-cargo-generate",
            "cargo-generate",
            "cargo install cargo-generate",
        ),
        (
            "framework-cargo-audit",
            "cargo-audit",
            "cargo install cargo-audit",
        ),
        (
            "framework-cargo-deny",
            "cargo-deny",
            "cargo install cargo-deny",
        ),
        (
            "framework-cargo-edit",
            "cargo-edit",
            "cargo install cargo-edit",
        ),
        (
            "framework-cargo-expand",
            "cargo-expand",
            "cargo install cargo-expand",
        ),
        (
            "framework-cargo-make",
            "cargo-make",
            "cargo install cargo-make",
        ),
        (
            "framework-cargo-release",
            "cargo-release",
            "cargo install cargo-release",
        ),
        (
            "framework-cargo-tarpaulin",
            "cargo-tarpaulin",
            "cargo install cargo-tarpaulin",
        ),
        (
            "framework-cargo-fuzz",
            "cargo-fuzz",
            "cargo install cargo-fuzz",
        ),
        (
            "framework-cargo-binstall",
            "cargo-binstall",
            "cargo install cargo-binstall",
        ),
        (
            "framework-cargo-udeps",
            "cargo-udeps",
            "cargo install cargo-udeps",
        ),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Rust)"),
            command.to_string(),
            "Rust · frameworks y herramientas",
            "Necesita Rust y Cargo. Se instala como herramienta global del usuario.",
        ));
    }

    for (id, label, command) in [
        (
            "framework-air",
            "Air · recarga Go",
            "go install github.com/air-verse/air@latest",
        ),
        (
            "framework-golangci-lint",
            "golangci-lint",
            "go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest",
        ),
        (
            "framework-goreleaser",
            "GoReleaser",
            "go install github.com/goreleaser/goreleaser/v2@latest",
        ),
        (
            "framework-gopls",
            "gopls",
            "go install golang.org/x/tools/gopls@latest",
        ),
        (
            "framework-goose",
            "Goose · migraciones",
            "go install github.com/pressly/goose/v3/cmd/goose@latest",
        ),
        (
            "framework-sqlc",
            "sqlc",
            "go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest",
        ),
        (
            "framework-swag",
            "Swag · OpenAPI para Go",
            "go install github.com/swaggo/swag/cmd/swag@latest",
        ),
        ("framework-gofumpt", "gofumpt", "go install mvdan.cc/gofumpt@latest"),
        ("framework-goimports", "goimports", "go install golang.org/x/tools/cmd/goimports@latest"),
        ("framework-staticcheck", "staticcheck", "go install honnef.co/go/tools/cmd/staticcheck@latest"),
        ("framework-delve", "Delve", "go install github.com/go-delve/delve/cmd/dlv@latest"),
        ("framework-mockgen", "GoMock · mockgen", "go install go.uber.org/mock/mockgen@latest"),
        ("framework-oapi-codegen", "oapi-codegen", "go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest"),
        ("framework-templ", "templ", "go install github.com/a-h/templ/cmd/templ@latest"),
        ("framework-ginkgo", "Ginkgo", "go install github.com/onsi/ginkgo/v2/ginkgo@latest"),
        ("framework-golang-migrate", "golang-migrate", "go install -tags 'postgres mysql sqlite3' github.com/golang-migrate/migrate/v4/cmd/migrate@latest"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Go)"),
            command.to_string(),
            "Go · frameworks y herramientas",
            "Necesita Go. Se instala con go install en el entorno del usuario.",
        ));
    }

    for (id, label, package) in [
        (
            "framework-laravel",
            "Laravel Installer",
            "laravel/installer",
        ),
        ("framework-symfony", "Symfony Components", "symfony/console"),
        ("framework-cakephp", "CakePHP", "cakephp/cakephp"),
        (
            "framework-codeigniter",
            "CodeIgniter",
            "codeigniter4/framework",
        ),
        ("framework-phpunit", "PHPUnit", "phpunit/phpunit"),
        ("framework-phpstan", "PHPStan", "phpstan/phpstan"),
        (
            "framework-php-cs-fixer",
            "PHP CS Fixer",
            "friendsofphp/php-cs-fixer",
        ),
        ("framework-drush", "Drush · Drupal", "drush/drush"),
        (
            "framework-php-codesniffer",
            "PHP_CodeSniffer",
            "squizlabs/php_codesniffer",
        ),
        ("framework-psalm", "Psalm", "vimeo/psalm"),
        ("framework-pest", "Pest", "pestphp/pest"),
        ("framework-livewire", "Livewire", "livewire/livewire"),
        ("framework-doctrine", "Doctrine ORM", "doctrine/orm"),
        ("framework-guzzle", "Guzzle", "guzzlehttp/guzzle"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (PHP)"),
            format!("composer global require {package}"),
            "PHP · frameworks y herramientas",
            "Necesita PHP y Composer. Los paquetes se instalan en el perfil global de Composer.",
        ));
    }

    for (id, label, package) in [
        ("framework-rails", "Ruby on Rails", "rails"),
        ("framework-sinatra", "Sinatra", "sinatra"),
        ("framework-hanami", "Hanami", "hanami"),
        ("framework-rspec", "RSpec", "rspec"),
        ("framework-rubocop", "RuboCop", "rubocop"),
        ("framework-jekyll", "Jekyll", "jekyll"),
        ("framework-bundler", "Bundler", "bundler"),
        ("framework-minitest", "Minitest", "minitest"),
        ("framework-sidekiq", "Sidekiq", "sidekiq"),
        ("framework-puma", "Puma", "puma"),
        ("framework-rake", "Rake", "rake"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Ruby)"),
            format!("gem install {package}"),
            "Ruby · frameworks y herramientas",
            "Necesita Ruby y RubyGems. Se instala en el perfil de gemas del usuario.",
        ));
    }

    for (id, label, command) in [
        (
            "framework-dotnet-ef",
            "Entity Framework CLI",
            "dotnet tool install --global dotnet-ef",
        ),
        (
            "framework-aspnet-codegenerator",
            "ASP.NET Code Generator",
            "dotnet tool install --global dotnet-aspnet-codegenerator",
        ),
        (
            "framework-csharpier",
            "CSharpier",
            "dotnet tool install --global csharpier",
        ),
        (
            "framework-nswag",
            "NSwag",
            "dotnet tool install --global NSwag.ConsoleCore",
        ),
        (
            "framework-paket",
            "Paket",
            "dotnet tool install --global paket",
        ),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (.NET)"),
            command.to_string(),
            ".NET · herramientas y frameworks",
            "Necesita el SDK de .NET. Se instala como herramienta global de dotnet.",
        ));
    }

    for (id, label, command) in [
        (
            "framework-phoenix",
            "Phoenix",
            "mix archive.install hex phx_new",
        ),
        ("framework-credo", "Credo", "mix escript.install hex credo"),
        (
            "framework-ex-doc",
            "ExDoc",
            "mix escript.install hex ex_doc",
        ),
        (
            "framework-nerves",
            "Nerves",
            "mix archive.install hex nerves_bootstrap",
        ),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Elixir)"),
            command.to_string(),
            "Elixir · frameworks y herramientas",
            "Necesita Elixir, Erlang y Mix. El comando instala la herramienta en el perfil de Mix.",
        ));
    }

    for (id, label, command) in [
        (
            "framework-dart-melos",
            "Melos",
            "dart pub global activate melos",
        ),
        (
            "framework-dart-mason",
            "Mason CLI",
            "dart pub global activate mason_cli",
        ),
        (
            "framework-dart-very-good",
            "Very Good CLI",
            "dart pub global activate very_good_cli",
        ),
        (
            "framework-dart-pana",
            "Pana",
            "dart pub global activate pana",
        ),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Dart / Flutter)"),
            command.to_string(),
            "Dart / Flutter · herramientas y ecosistema",
            "Necesita Dart. Flutter puede instalarse aparte desde el gestor de dependencias del sistema.",
        ));
    }

    for (id, label, package) in [
        ("framework-luarocks-busted", "Busted", "busted"),
        ("framework-luarocks-luacheck", "Luacheck", "luacheck"),
        ("framework-luarocks-penlight", "Penlight", "penlight"),
        ("framework-luarocks-lpeg", "LPeg", "lpeg"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Lua)"),
            format!("luarocks install {package}"),
            "Lua · frameworks y herramientas",
            "Necesita Lua y LuaRocks.",
        ));
    }

    for (id, label, packages) in [
        ("framework-conan", "Conan", "conan"),
        ("framework-meson", "Meson", "meson"),
        ("framework-platformio", "PlatformIO", "platformio"),
        ("framework-cppcheck", "Cppcheck", "cppcheck"),
        ("framework-clang-format", "clang-format", "clang-format"),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (C / C++)"),
            format!("{python_cmd} -m pip install --user {packages}"),
            "C / C++ · build y herramientas",
            "Necesita Python y pip; algunas herramientas también necesitan un compilador C/C++.",
        ));
    }

    for (id, label, package) in [
        ("framework-cabal-hlint", "HLint", "hlint"),
        ("framework-cabal-ormolu", "Ormolu", "ormolu"),
        ("framework-cabal-fourmolu", "Fourmolu", "fourmolu"),
        (
            "framework-cabal-hls",
            "Haskell Language Server",
            "haskell-language-server",
        ),
    ] {
        actions.push(ecosystem_action(
            id,
            &format!("{label} (Haskell)"),
            format!("cabal install {package}"),
            "Haskell · herramientas y ecosistema",
            "Necesita GHC y Cabal.",
        ));
    }

    actions
}

// ---- WSL ----

/// Instalar paquetes DENTRO de una distro, desde PowerShell. `apt` necesita
/// refrescar índices antes, y solo instala si ese refresco fue bien.
fn wsl_package_install(distro: &str, pkg_manager: &str, packages: &str) -> Option<String> {
    let prefix = format!("wsl.exe -d {} --", ps_single(distro));
    match pkg_manager {
        "apt" => Some(format!(
            "{prefix} sudo apt update; if ($LASTEXITCODE -eq 0) {{ {prefix} sudo apt install -y {packages} }}"
        )),
        "dnf" => Some(format!("{prefix} sudo dnf install -y {packages}")),
        "pacman" => Some(format!("{prefix} sudo pacman -S --noconfirm {packages}")),
        "zypper" => Some(format!("{prefix} sudo zypper install -y {packages}")),
        "apk" => Some(format!("{prefix} sudo apk add {packages}")),
        _ => None,
    }
}

fn wsl_package_update(distro: &str, pkg_manager: &str) -> Option<String> {
    let prefix = format!("wsl.exe -d {} --", ps_single(distro));
    match pkg_manager {
        "apt" => Some(format!(
            "{prefix} sudo apt update; if ($LASTEXITCODE -eq 0) {{ {prefix} sudo apt upgrade -y }}"
        )),
        "dnf" => Some(format!("{prefix} sudo dnf upgrade -y")),
        "pacman" => Some(format!("{prefix} sudo pacman -Syu --noconfirm")),
        "zypper" => Some(format!("{prefix} sudo zypper update -y")),
        "apk" => Some(format!(
            "{prefix} sudo apk update && {prefix} sudo apk upgrade"
        )),
        _ => None,
    }
}

/// Todo WSL vive bajo un único apartado; dentro, cada bloque (la plataforma, el
/// catálogo de distribuciones y cada distro instalada) es un subgrupo
/// plegable. Antes cada bloque era un apartado de primer nivel y en un Windows
/// con dos o tres distros el panel se convertía en una lista interminable de
/// cabeceras "WSL · ...".
fn wsl_actions(wsl: Option<&WslContext>, t: &Translator) -> Vec<InstallAction> {
    let Some(wsl) = wsl.filter(|context| context.available) else {
        return vec![InstallAction::new(
            "wsl-install-base",
            "Activar WSL",
            "wsl.exe --install --no-distribution",
        )
        .short("Activar la plataforma WSL")
        .powershell()
        .group(WSL_GROUP)
        .subgroup("WSL (plataforma)")
        .hint(
            "Instala únicamente la plataforma WSL. Después podrás elegir la distribución desde \
             este panel; puede pedir reinicio.",
        )];
    };

    let mut actions = vec![
        // wsl.exe escribe en UTF-16LE por defecto y la consola lo interpreta
        // con su página de códigos: el listado llegaba vacío o ilegible.
        // WSL_UTF8=1 (WSL 0.64+) hace que emita UTF-8 normal.
        InstallAction::new(
            "wsl-list",
            "Ver distribuciones instaladas",
            "$env:WSL_UTF8=1; wsl.exe --list --verbose",
        )
        .short("Ver distribuciones instaladas")
        .powershell()
        .group(WSL_GROUP)
        .subgroup("WSL (plataforma)")
        .verb("Ver")
        .installed(true),
        InstallAction::new(
            "wsl-update",
            "Actualizar el núcleo de WSL",
            "wsl.exe --update",
        )
        .short("Actualizar el núcleo de WSL")
        .powershell()
        .group(WSL_GROUP)
        .subgroup("WSL (plataforma)")
        .verb("Actualizar")
        .installed(true),
    ];

    let installed_names: Vec<String> = wsl
        .installed
        .iter()
        .map(|distro| distro.name.to_lowercase())
        .collect();
    for distro in &wsl.online {
        if installed_names.contains(&distro.name.to_lowercase()) {
            continue;
        }
        let nombre = if distro.friendly_name.is_empty() {
            &distro.name
        } else {
            &distro.friendly_name
        };
        let install_label = t.tp(
            "action.wslDistroInstall",
            &[("distro", nombre.to_string())],
            "Instalar {distro}",
        );
        actions.push(
            InstallAction::new(
                format!("wsl-distro-{}", safe_id(&distro.name)),
                &install_label,
                format!("wsl.exe --install -d {}", ps_single(&distro.name)),
            )
            .short(install_label)
            .powershell()
            .group(WSL_GROUP)
            .subgroup("Distribuciones disponibles")
            .installed(false)
            .hint(t.tp(
                "action.wslDistroInstall.hint",
                &[("name", distro.name.clone())],
                "Nombre WSL: {name}. Windows puede pedir reinicio o la creación del usuario Linux.",
            )),
        );
    }

    for distro in &wsl.installed {
        // Si la distro no respondió no se inventan instalaciones pendientes:
        // podrían estar ya presentes. El selector la conserva y el usuario
        // puede refrescar cuando WSL vuelva a estar disponible.
        if distro.probe_error {
            continue;
        }
        let subgroup = format!("{} · {}", distro.name, distro.shell);
        let pkg_manager = distro.package_manager.as_deref().unwrap_or_default();

        // Lo que se puede instalar DENTRO de la distro. `presente` mira el
        // inventario que trajo la sonda: si ya está, no se ofrece.
        let python_pkg = if pkg_manager == "pacman" {
            "python"
        } else {
            "python3"
        };
        #[rustfmt::skip]
        let candidates: [(&str, &str, &str, bool, bool); 6] = [
            // clave,    etiqueta,        paquete,       ya presente,                                   es una shell
            ("bash",   "bash",           "bash",        distro.shells.iter().any(|s| s == "bash"),      true),
            ("zsh",    "zsh",            "zsh",         distro.shells.iter().any(|s| s == "zsh"),       true),
            ("fish",   "fish",           "fish",        distro.shells.iter().any(|s| s == "fish"),      true),
            ("node",   "Node.js + npm",  "nodejs npm",  distro.tools.iter().any(|s| s == "node"),       false),
            ("git",    "Git",            "git",         distro.tools.iter().any(|s| s == "git"),        false),
            ("python", "Python",         python_pkg,    distro.tools.iter().any(|s| s == "python3"),    false),
        ];

        for (key, label, package, present, shell_hint) in candidates {
            if present {
                continue;
            }
            let Some(command) = wsl_package_install(&distro.name, pkg_manager, package) else {
                continue;
            };
            let tool = if label == "Node.js + npm" {
                t.t("tool.nodeNpm", label)
            } else {
                label.to_string()
            };
            let hint = if shell_hint {
                t.tp(
                    "action.wslInsideInstall.shellHint",
                    &[
                        ("distro", distro.name.clone()),
                        ("command", key.to_string()),
                    ],
                    "Se instala solo dentro de {distro}. Para convertirlo en shell predeterminada usa chsh -s $(command -v {command}).",
                )
            } else {
                t.tp(
                    "action.wslInsideInstall.hint",
                    &[("distro", distro.name.clone())],
                    "Se instala solo dentro de {distro}.",
                )
            };
            actions.push(
                InstallAction::new(
                    format!("wsl-{}-{key}", safe_id(&distro.name)),
                    t.tp(
                        "action.wslInsideInstall",
                        &[("tool", tool.clone()), ("distro", distro.name.clone())],
                        "Instalar {tool} en {distro}",
                    ),
                    command,
                )
                .short(t.tp(
                    "action.wslInsideInstallShort",
                    &[("tool", tool)],
                    "Instalar {tool}",
                ))
                .powershell()
                .group(WSL_GROUP)
                .subgroup(&subgroup)
                .installed(false)
                .hint(hint),
            );
        }

        if let Some(command) = wsl_package_update(&distro.name, pkg_manager) {
            actions.push(
                InstallAction::new(
                    format!("wsl-{}-update", safe_id(&distro.name)),
                    t.tp(
                        "action.wslDistroUpdate",
                        &[("distro", distro.name.clone())],
                        "Actualizar paquetes de {distro}",
                    ),
                    command,
                )
                .short(t.t(
                    "action.wslDistroUpdateShort",
                    "Actualizar paquetes de la distro",
                ))
                .powershell()
                .group(WSL_GROUP)
                .subgroup(&subgroup)
                .verb("Actualizar")
                .installed(true),
            );
        }
    }

    actions
}

// ---- Catálogos por plataforma ----

fn windows_actions(
    wsl: Option<&WslContext>,
    projects_folder: &str,
    t: &Translator,
) -> Vec<InstallAction> {
    let mut actions: Vec<InstallAction> = WINDOWS_TOOLS
        .iter()
        .chain(WINDOWS_VIEWERS.iter())
        .flat_map(|tool| windows_tool_actions(tool, t))
        .collect();
    actions.extend(windows_code_editor_actions(t));

    // Mismo subgrupo que la herramienta 'docker' de WINDOWS_TOOLS: así
    // instalar, actualizar, verificar y arrancar Docker caen todas bajo un
    // único plegable en vez de repartirse por el panel.
    actions.extend(in_subgroup(
        DOCKER_GROUP,
        "Docker Desktop",
        vec![
            InstallAction {
                command: "docker --version; if ($LASTEXITCODE -eq 0) { docker info }".to_string(),
                ..docker_check_action()
            }
            .powershell(),
            InstallAction {
                command: "docker image ls; if ($LASTEXITCODE -eq 0) { docker ps -a }".to_string(),
                ..docker_list_action()
            }
            .powershell(),
            InstallAction::new(
                "docker-start-win",
                "Iniciar Docker Desktop",
                "Start-Process (Join-Path $env:ProgramFiles 'Docker\\Docker\\Docker Desktop.exe')",
            )
            .short("Iniciar Docker Desktop")
            .powershell()
            .hint("La app ya intenta arrancarlo sola al abrirse; esto es por si quieres forzarlo.")
            .verb("Iniciar")
            .requires(Some("docker")),
        ],
    ));

    actions.extend(in_subgroup(
        ADB_GROUP,
        ADB_SUBGROUP,
        vec![
            InstallAction::new(
                "adb-install",
                "Instalar ADB / Android Platform Tools",
                ADB_INSTALL_PS.clone(),
            )
            .short("Instalar (descarga oficial de Google)")
            .powershell()
            .hint(
                "Descarga oficial de Google (no usa winget: su paquete de platform-tools suele \
                 fallar por hash desactualizado). Instala en %LOCALAPPDATA%\\Android y lo añade al \
                 PATH del usuario: abre una pestaña nueva para usar \"adb\" desde cualquier ruta.",
            )
            .check(Some("adb")),
            InstallAction::new(
                "adb-update",
                "Actualizar ADB a la última versión",
                ADB_INSTALL_PS.clone(),
            )
            .short("Actualizar a la última versión")
            .powershell()
            .hint("Vuelve a descargar la última versión oficial y sobrescribe la actual.")
            .verb("Actualizar")
            .requires(Some("adb")),
            InstallAction::new("adb-check", "Ver dispositivos ADB conectados", "adb devices")
                .short("Ver dispositivos conectados")
                .verb("Ver")
                .requires(Some("adb")),
            InstallAction::new("adb-version", "Ver versión de ADB", "adb version")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("adb")),
            InstallAction::new(
                "adb-uninstall",
                "Desinstalar ADB / Android Platform Tools",
                ADB_UNINSTALL_PS.clone(),
            )
            .short("Desinstalar del sistema")
            .powershell()
            .verb("Desinstalar")
            .requires(Some("adb"))
            .hint(
                "Borra la carpeta que instaló esta app y limpia su entrada del PATH de usuario. Si \
                 instalaste ADB con Android Studio, elimínalo desde su gestor de SDK.",
            ),
            InstallAction::new(
                "adb-authorize",
                "Reiniciar ADB y volver a pedir autorización",
                "adb kill-server; if ($LASTEXITCODE -eq 0) { adb devices }",
            )
            .short("Reiniciar y volver a pedir autorización")
            .powershell()
            .verb("Reiniciar")
            .hint(
                "Para un dispositivo que aparece como \"unauthorized\": desbloquea la pantalla del \
                 móvil y acepta el diálogo de depuración USB que saldrá al reiniciar el servidor.",
            )
            .requires(Some("adb")),
        ],
    ));

    actions.extend(in_subgroup(
        SSH_GROUP,
        SSH_SUBGROUP,
        vec![
            InstallAction::new(
                "winget-ssh",
                "Instalar cliente SSH (OpenSSH)",
                "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0",
            )
            .short("Instalar como capacidad de Windows")
            .powershell()
            .hint("En Windows 10 (1809+)/11 casi siempre ya viene instalado.")
            .check(Some("ssh")),
            InstallAction::new("ssh-check", "Ver versión de SSH instalada", "ssh -V")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("ssh")),
            InstallAction::new(
                "winget-ssh-uninstall",
                "Desinstalar cliente SSH (OpenSSH)",
                "Remove-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0",
            )
            .short("Desinstalar del sistema")
            .powershell()
            .verb("Desinstalar")
            .requires(Some("ssh"))
            .hint(
                "OpenSSH es una capacidad opcional de Windows; quitarla requiere permisos de \
                 administrador.",
            ),
        ],
    ));

    actions.extend(ecosystem_actions("python", "npm"));

    actions.push(
        // --include-unknown alcanza también a los programas cuya versión
        // instalada winget no puede leer, que si no quedaban fuera.
        InstallAction::new(
            "winget-upgrade",
            "Actualizar todo con winget",
            "winget upgrade --all --include-unknown --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity",
        )
        .powershell()
        .verb("Actualizar"),
    );
    actions.push(git_pull_projects_action(projects_folder));
    actions.extend(wsl_actions(wsl, t));
    actions
}

fn mac_actions(projects_folder: &str, t: &Translator) -> Vec<InstallAction> {
    let mut actions = vec![
        git_pull_projects_posix_action(projects_folder),
        InstallAction::new(
            "brew-install",
            "Instalar Homebrew",
            "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
        )
        .hint("Descarga y ejecuta el instalador oficial de Homebrew.")
        .check(Some("brew")),
    ];

    actions.extend(MAC_TOOLS.iter().chain(MAC_VIEWERS.iter()).flat_map(|tool| {
        let package = tool.package_for("brew").unwrap_or_default();
        tool_lifecycle_actions(tool, package, &BREW_COMMANDS, "brew", t)
    }));

    actions.extend(in_subgroup(
        DOCKER_GROUP,
        "Docker Desktop",
        vec![
            InstallAction::new(
                "brew-docker",
                "Instalar Docker Desktop (brew)",
                "brew install --cask docker",
            )
            .short("Instalar con brew")
            .hint(
                "Tras instalar hay que abrir Docker.app al menos una vez para arrancar el daemon.",
            )
            .check(Some("docker")),
            InstallAction::new(
                "brew-docker-uninstall",
                "Desinstalar Docker Desktop (brew)",
                "brew uninstall --cask docker",
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("docker"))
            .hint(
                "Elimina la aplicación. Las imágenes y volúmenes de ~/Library/Containers no se \
                 borran.",
            ),
            InstallAction::new(
                "brew-docker-version",
                "Ver versión de Docker",
                "docker --version",
            )
            .short("Ver versión instalada")
            .verb("Versión")
            .requires(Some("docker")),
            docker_check_action(),
            docker_list_action(),
            InstallAction::new(
                "docker-start-mac",
                "Iniciar Docker Desktop",
                "open -a Docker",
            )
            .short("Iniciar Docker Desktop")
            .verb("Iniciar")
            .requires(Some("docker")),
        ],
    ));

    actions.extend(in_subgroup(
        ADB_GROUP,
        ADB_SUBGROUP,
        vec![
            InstallAction::new(
                "brew-adb",
                "Instalar ADB / Android Platform Tools (brew)",
                "brew install android-platform-tools",
            )
            .short("Instalar con brew")
            .check(Some("adb")),
            InstallAction::new(
                "brew-adb-update",
                "Actualizar ADB a la última versión (brew)",
                "brew upgrade android-platform-tools",
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("adb")),
            InstallAction::new(
                "brew-adb-uninstall",
                "Desinstalar ADB (brew)",
                "brew uninstall android-platform-tools",
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("adb")),
            InstallAction::new(
                "adb-check",
                "Ver dispositivos ADB conectados",
                "adb devices",
            )
            .short("Ver dispositivos conectados")
            .verb("Ver")
            .requires(Some("adb")),
            InstallAction::new("adb-version", "Ver versión de ADB", "adb version")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("adb")),
        ],
    ));

    actions.extend(in_subgroup(
        SSH_GROUP,
        SSH_SUBGROUP,
        vec![
            InstallAction::new(
                "brew-ssh",
                "Instalar cliente SSH (brew)",
                "brew install openssh",
            )
            .short("Instalar con brew")
            .hint("macOS trae SSH preinstalado casi siempre.")
            .check(Some("ssh")),
            InstallAction::new(
                "brew-ssh-uninstall",
                "Desinstalar cliente SSH (brew)",
                "brew uninstall openssh",
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("ssh"))
            .hint(
                "Solo quita el OpenSSH instalado con brew; el que trae macOS de serie sigue ahí.",
            ),
            InstallAction::new("ssh-check", "Ver versión de SSH instalada", "ssh -V")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("ssh")),
        ],
    ));

    actions.push(posix_sh_action());
    // Homebrew comparte los mismos ecosistemas de usuario que Linux: Python,
    // Node y las herramientas globales de cada lenguaje se mantienen en el
    // mismo catálogo para que el panel no pierda familias al cambiar de host.
    actions.extend(ecosystem_actions("python3", "npm"));
    actions.push(
        InstallAction::new(
            "brew-update",
            "Actualizar paquetes (brew)",
            BREW_COMMANDS.update,
        )
        .verb("Actualizar"),
    );
    actions
}

/// Añadir el repositorio de Microsoft e instalar PowerShell desde él.
///
/// `/etc/os-release` da `$ID` y `$VERSION_ID`, que es justo la ruta que usa
/// `packages.microsoft.com/config/`. Componerla en el momento en vez de dejarla
/// escrita evita que el catálogo se quede obsoleto con cada versión nueva de
/// Ubuntu o Debian.
///
/// `None` para pacman: en Arch esto no existe — ahí la vía es el AUR.
fn microsoft_repo_install(pkg_manager: &str) -> Option<String> {
    match pkg_manager {
        // `dpkg -i` deja el repo y su clave; el `apt update` siguiente ya ve el
        // paquete. El `.deb` se borra: no hace falta después.
        "apt" => Some(
            "sudo apt update && sudo apt install -y wget apt-transport-https \
             && . /etc/os-release \
             && wget -q \"https://packages.microsoft.com/config/$ID/$VERSION_ID/packages-microsoft-prod.deb\" \
             -O /tmp/packages-microsoft-prod.deb \
             && sudo dpkg -i /tmp/packages-microsoft-prod.deb \
             && rm -f /tmp/packages-microsoft-prod.deb \
             && sudo apt update && sudo apt install -y powershell"
                .to_string(),
        ),
        // En Fedora la versión va en `%fedora`, no en VERSION_ID de os-release,
        // que ahí trae lo mismo pero no en las derivadas.
        "dnf" => Some(
            "sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc \
             && sudo dnf install -y \
             \"https://packages.microsoft.com/config/fedora/$(rpm -E %fedora)/packages-microsoft-prod.rpm\" \
             && sudo dnf install -y powershell"
                .to_string(),
        ),
        "zypper" => Some(
            "sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc \
             && sudo zypper --non-interactive ar \
             https://packages.microsoft.com/sles/15/prod/ microsoft \
             && sudo zypper --gpg-auto-import-keys refresh \
             && sudo zypper install -y powershell"
                .to_string(),
        ),
        _ => None,
    }
}

/// snapd no siempre basta con instalarlo: en las distribuciones donde no viene
/// activado hay que arrancar su socket para que `snap install` funcione.
#[rustfmt::skip]
static SNAPD_INSTALL: &[(&str, &str)] = &[
    ("apt", "sudo apt install -y snapd"),
    ("dnf", "sudo dnf install -y snapd && sudo systemctl enable --now snapd.socket && sudo ln -sf /var/lib/snapd/snap /snap"),
    ("pacman", "sudo pacman -S --noconfirm snapd && sudo systemctl enable --now snapd.socket && sudo ln -sf /var/lib/snapd/snap /snap"),
    ("zypper", "sudo zypper install -y snapd && sudo systemctl enable --now snapd"),
];

/// Instalar Wine, con el soporte de 32 bits que necesita para servir de algo.
///
/// La mayoría de los `.exe` que alguien quiere abrir con Wine siguen siendo de
/// 32 bits, y un Wine sin la arquitectura i386 habilitada los rechaza con un
/// error que no dice por qué. En Debian y derivadas la arquitectura hay que
/// añadirla a mano ANTES de instalar; en las demás familias el paquete de
/// 32 bits viene con el principal o se resuelve solo.
///
/// Es la causa más común de "instalé Wine y no me funciona nada", así que va
/// dentro del propio comando de instalación y no en un aviso que se lee después.
fn wine_install_command(pkg_manager: &str, commands: &PkgCommands) -> String {
    if pkg_manager == "apt" {
        return format!(
            "sudo dpkg --add-architecture i386 && sudo apt update && {} wine wine32 wine64",
            commands.install
        );
    }
    format!("{} wine", commands.install)
}

/// Wine en Arch está en el repositorio multilib, que viene desactivado en una
/// instalación estándar: sin habilitarlo, pacman responde que el paquete no
/// existe igual que con PowerShell.
fn wine_hint(pkg_manager: &str) -> &'static str {
    if pkg_manager == "pacman" {
        "Wine aporta cmd/wscript compatibles, pero no sustituye Windows. En Arch está en el \
         repositorio multilib: si pacman dice que no encuentra el paquete, descomenta la sección \
         [multilib] de /etc/pacman.conf, ejecuta \"sudo pacman -Sy\" y vuelve a intentarlo."
    } else {
        "Wine aporta cmd/wscript compatibles, pero no sustituye Windows y algunos .cmd/.vbs \
         dependientes del sistema no funcionarán. Al terminar, \"cmd.exe · Wine\" aparece como \
         entorno en el selector."
    }
}

const COMPAT_APPS: &str = "Aplicaciones Windows";
const COMPAT_GAMES: &str = "Juegos Windows";
const COMPAT_FULL_WINDOWS: &str = "Windows completo";
const COMPAT_AUXILIARY: &str = "Herramientas auxiliares";
const COMPAT_DEVELOPMENT: &str = "Desarrollo Windows";

/// Herramientas Linux que amplían Wine con runners, juegos, máquinas virtuales
/// y utilidades de desarrollo. Se mantienen fuera de `LINUX_TOOLS` para que no
/// aparezcan mezcladas con los lenguajes y el apartado de sistema.
#[rustfmt::skip]
static LINUX_WINDOWS_COMPAT_TOOLS: Lazy<Vec<(PkgTool, &'static str)>> = Lazy::new(|| vec![
    (PkgTool { hint: Some("En Debian/Ubuntu suele instalarse desde Flathub (com.usebottles.bottles) si no existe un paquete nativo."), ..pkg("compat-bottles", "Bottles", "bottles", &[("default", "bottles"), ("pacman", "bottles")], Some("bottles --version"), WINDOWS_COMPAT_GROUP) }, COMPAT_APPS),
    (pkg("compat-steam", "Steam · Proton", "steam", &[("default", "steam"), ("apt", "steam-installer"), ("pacman", "steam")], Some("steam --version"), WINDOWS_COMPAT_GROUP), COMPAT_GAMES),
    (PkgTool { hint: Some("ProtonUp-Qt suele distribuirse como Flatpak o AppImage cuando no aparece en los repositorios de la distribución."), ..pkg("compat-protonup", "Proton-GE · ProtonUp-Qt", "protonup-qt", &[("default", "protonup-qt"), ("pacman", "protonup-qt")], Some("protonup-qt --version"), WINDOWS_COMPAT_GROUP) }, COMPAT_GAMES),
    (pkg("compat-lutris", "Lutris", "lutris", &[("default", "lutris"), ("apt", "lutris"), ("dnf", "lutris"), ("pacman", "lutris")], Some("lutris --version"), WINDOWS_COMPAT_GROUP), COMPAT_GAMES),
    (pkg("compat-qemu", "QEMU/KVM", "qemu-system-x86_64", &[("default", "qemu-desktop"), ("apt", "qemu-system-x86"), ("dnf", "qemu-system-x86-core"), ("zypper", "qemu-x86"), ("apk", "qemu-system-x86_64")], Some("qemu-system-x86_64 --version"), WINDOWS_COMPAT_GROUP), COMPAT_FULL_WINDOWS),
    (pkg("compat-libvirt", "libvirt · daemon de virtualización", "virsh", &[("default", "libvirt"), ("apt", "libvirt-daemon-system libvirt-clients"), ("dnf", "libvirt"), ("pacman", "libvirt"), ("zypper", "libvirt"), ("apk", "libvirt")], Some("virsh --version"), WINDOWS_COMPAT_GROUP), COMPAT_FULL_WINDOWS),
    (pkg("compat-virt-manager", "virt-manager", "virt-manager", &[ ("default", "virt-manager") ], Some("virt-manager --version"), WINDOWS_COMPAT_GROUP), COMPAT_FULL_WINDOWS),
    (pkg("compat-gnome-boxes", "GNOME Boxes", "gnome-boxes", &[ ("default", "gnome-boxes") ], Some("gnome-boxes --version"), WINDOWS_COMPAT_GROUP), COMPAT_FULL_WINDOWS),
    (pkg("compat-winetricks", "Winetricks", "winetricks", &[ ("default", "winetricks") ], Some("winetricks --version"), WINDOWS_COMPAT_GROUP), COMPAT_AUXILIARY),
    (pkg("compat-dxvk", "DXVK", "setup_dxvk", &[("default", "dxvk")], Some("setup_dxvk"), WINDOWS_COMPAT_GROUP), COMPAT_AUXILIARY),
    (pkg("compat-vkd3d", "VKD3D-Proton", "vkd3d", &[("default", "vkd3d")], Some("vkd3d"), WINDOWS_COMPAT_GROUP), COMPAT_AUXILIARY),
    (pkg("compat-cabextract", "cabextract", "cabextract", &[ ("default", "cabextract") ], Some("cabextract --version"), WINDOWS_COMPAT_GROUP), COMPAT_AUXILIARY),
    (pkg("compat-msitools", "msitools", "msiinfo", &[ ("default", "msitools") ], Some("msiinfo --version"), WINDOWS_COMPAT_GROUP), COMPAT_AUXILIARY),
    (pkg("compat-mingw", "MinGW-w64", "x86_64-w64-mingw32-gcc", &[("default", "mingw-w64-gcc"), ("apt", "mingw-w64"), ("dnf", "mingw64-gcc"), ("zypper", "mingw64-cross-gcc")], Some("x86_64-w64-mingw32-gcc --version"), WINDOWS_COMPAT_GROUP), COMPAT_DEVELOPMENT),
]);

fn compatibility_open_action(
    id: &str,
    label: &str,
    command: &str,
    subgroup: &str,
    requires: &str,
    hint: &str,
) -> InstallAction {
    InstallAction::new(id, label, command)
        .short("Abrir configuración")
        .subgroup(subgroup)
        .group(WINDOWS_COMPAT_GROUP)
        .verb("Abrir")
        .requires(Some(requires))
        .hint(hint)
}

fn linux_windows_compatibility_actions(
    pm: &str,
    commands: &PkgCommands,
    t: &Translator,
) -> Vec<InstallAction> {
    let mut actions = Vec::new();
    for (tool, subgroup) in LINUX_WINDOWS_COMPAT_TOOLS.iter() {
        let Some(package) = tool.package_for(pm) else {
            continue;
        };
        let mut lifecycle = tool_lifecycle_actions(tool, package, commands, pm, t);
        // En este apartado el segundo nivel representa la categoría, no cada
        // paquete: así se puede desplegar «Juegos Windows» y ver todos sus
        // runners sin fabricar un acordeón por herramienta.
        for action in &mut lifecycle {
            action.subgroup = Some((*subgroup).to_string());
        }
        actions.extend(lifecycle);
    }

    // CrossOver no es un paquete libre de los repositorios: requiere descarga
    // oficial y licencia. Se ofrece el enlace y una comprobación/configuración
    // separadas, evitando inventar un comando de instalación que fallaría.
    actions.extend([
        InstallAction::new(
            "compat-crossover-download",
            "Descargar CrossOver",
            "xdg-open https://www.codeweavers.com/download",
        )
        .short("Abrir descarga oficial")
        .subgroup(COMPAT_APPS)
        .group(WINDOWS_COMPAT_GROUP)
        .hint("Alternativa comercial a Wine con soporte técnico y buena integración de aplicaciones como Microsoft Office."),
        InstallAction::new(
            "compat-crossover-check",
            "Comprobar CrossOver",
            "cxoffice --version",
        )
        .short("Ver versión instalada")
        .subgroup(COMPAT_APPS)
        .group(WINDOWS_COMPAT_GROUP)
        .verb("Verificar")
        .requires(Some("cxoffice")),
        compatibility_open_action(
            "compat-bottles-open",
            "Abrir Bottles",
            "bottles",
            COMPAT_APPS,
            "bottles",
            "Gestiona prefijos separados, runners Wine/Proton, dependencias y configuración por aplicación.",
        ),
        compatibility_open_action(
            "compat-lutris-open",
            "Abrir Lutris",
            "lutris",
            COMPAT_GAMES,
            "lutris",
            "Centraliza juegos, launchers y runners Wine, Proton y DOSBox.",
        ),
        compatibility_open_action(
            "compat-steam-open",
            "Abrir Steam",
            "steam",
            COMPAT_GAMES,
            "steam",
            "Gestiona juegos Windows con Proton y permite seleccionar Proton-GE desde Steam.",
        ),
        compatibility_open_action(
            "compat-protonup-open",
            "Abrir ProtonUp-Qt",
            "protonup-qt",
            COMPAT_GAMES,
            "protonup-qt",
            "Instala y gestiona Proton-GE y otros runners para Steam y Lutris.",
        ),
        compatibility_open_action(
            "compat-virt-manager-open",
            "Abrir virt-manager",
            "virt-manager",
            COMPAT_FULL_WINDOWS,
            "virt-manager",
            "Gestiona máquinas virtuales QEMU/KVM; ofrece la compatibilidad más completa, con mayor consumo.",
        ),
        compatibility_open_action(
            "compat-gnome-boxes-open",
            "Abrir GNOME Boxes",
            "gnome-boxes",
            COMPAT_FULL_WINDOWS,
            "gnome-boxes",
            "Interfaz sencilla para crear y abrir máquinas virtuales QEMU/KVM.",
        ),
    ]);
    actions
}

/// PowerShell NO está en los repositorios oficiales de ninguna distribución
/// grande: Microsoft lo publica por su cuenta (repo propio, Snap o tarball), y
/// en Arch vive en el AUR. Escribir `pacman -S powershell` o `apt install
/// powershell` en la terminal solo produce "no se ha encontrado el paquete",
/// que es exactamente lo que veía el usuario. Así que las acciones se generan a
/// partir de lo que ESTE sistema puede usar de verdad, y si no hay ninguna vía
/// disponible se ofrece primero el requisito (snapd) en vez de un comando
/// condenado a fallar.
///
/// `aur_helper` es `paru` o `yay` si alguno está instalado. Se invocan SIN sudo
/// a propósito: piden ellos la contraseña cuando toca y makepkg se niega a
/// ejecutarse como root.
fn power_shell_actions(
    pkg_manager: &str,
    has_snap: bool,
    aur_helper: Option<&str>,
    t: &Translator,
) -> Vec<InstallAction> {
    let aur = aur_helper.filter(|_| pkg_manager == "pacman");
    let mut installers = Vec::new();

    // La vía que Microsoft documenta para esta familia de distribución: su
    // propio repositorio. Es la primera de la lista donde existe, porque deja
    // PowerShell como un paquete más del sistema — se actualiza con el resto y
    // se desinstala con el gestor, cosa que ni Snap ni un tarball dan.
    //
    // La URL se compone en el momento a partir de /etc/os-release en vez de
    // llevar la distribución escrita: así vale igual para Ubuntu 22.04 que para
    // Debian 12 sin tocar el catálogo.
    if let Some(command) = microsoft_repo_install(pkg_manager) {
        installers.push(
            InstallAction::new(
                "pkg-pwsh-msrepo",
                "Instalar PowerShell (repositorio de Microsoft)",
                command,
            )
            .short("Instalar desde el repositorio de Microsoft")
            .check(Some("pwsh"))
            .hint(
                "Añade el repositorio oficial de Microsoft para esta distribución y luego instala \
                 el paquete. Es la vía que Microsoft documenta: PowerShell queda como un paquete \
                 normal del sistema y se actualiza con los demás.",
            ),
        );
    }

    if let Some(aur) = aur {
        installers.push(
            InstallAction::new(
                "pkg-pwsh-aur",
                format!("Instalar PowerShell (AUR · {aur})"),
                format!("{aur} -S --noconfirm powershell-bin"),
            )
            .short(format!("Instalar desde el AUR con {aur}"))
            .check(Some("pwsh"))
            .hint(
                "powershell-bin son los binarios oficiales de Microsoft empaquetados para Arch. El \
                 asistente del AUR no se ejecuta como root: pedirá la contraseña cuando la \
                 necesite.",
            ),
        );
    }
    if has_snap {
        installers.push(
            InstallAction::new(
                "pkg-pwsh-snap",
                "Instalar PowerShell (Snap oficial)",
                "sudo snap install powershell --classic",
            )
            .short("Instalar desde Snap")
            .check(Some("pwsh"))
            .hint(
                "Instala el paquete estable de PowerShell publicado en Snap. PowerShell aparecerá \
                 como entorno al refrescar.",
            ),
        );
    }
    // Ninguna vía directa disponible. En vez de escribir un comando que se sabe
    // que va a fallar, se ofrece el requisito que sí está en los repositorios
    // oficiales de todas las distribuciones.
    if installers.is_empty() {
        let install = linux_pkg_commands(pkg_manager)
            .map(|commands| commands.install)
            .unwrap_or_default();
        let snapd = SNAPD_INSTALL
            .iter()
            .find(|(name, _)| *name == pkg_manager)
            .map(|(_, command)| (*command).to_string())
            .unwrap_or_else(|| format!("{install} snapd"));
        let arch = if pkg_manager == "pacman" {
            " (en Arch vive en el AUR)"
        } else {
            ""
        };
        installers.push(
            InstallAction::new(
                "pkg-pwsh-snapd",
                t.tp(
                    "action.pkg-pwsh.label",
                    &[("source", pkg_manager.to_string())],
                    "Instalar snapd, requisito para PowerShell ({source})",
                ),
                snapd,
            )
            .short(t.tp(
                "action.pkg-pwsh.shortLabel",
                &[("source", pkg_manager.to_string())],
                "Instalar snapd con {source}",
            ))
            .check(Some("snap"))
            .hint(format!(
                "Microsoft no publica PowerShell en los repositorios de las distribuciones{arch}, \
                 así que \"{install} powershell\" solo responde que el paquete no existe. Snap es \
                 la vía soportada: instala snapd, refresca este panel y aparecerá \"Instalar \
                 PowerShell (Snap oficial)\"."
            )),
        );
        if pkg_manager == "pacman" {
            installers.push(
                InstallAction::new(
                    "pkg-paru",
                    "Instalar paru, asistente del AUR",
                    "sudo pacman -S --needed --noconfirm base-devel git \
                     && git clone https://aur.archlinux.org/paru-bin.git /tmp/paru-bin \
                     && cd /tmp/paru-bin && makepkg -si",
                )
                .short("Instalar el asistente del AUR")
                .check(Some("paru"))
                .hint(
                    "Alternativa a snapd en Arch: paru da acceso al AUR, donde está powershell-bin. \
                     Clona el repositorio del propio asistente y lo compila con makepkg; revisa el \
                     comando antes de aceptarlo.",
                ),
            );
        }
    }

    // El primero de la lista es la vía recomendada en ESTE sistema y conserva
    // el id estable `pkg-pwsh`: es al que apunta la sugerencia automática de
    // `command_not_found` cuando la shell responde "pwsh: orden no encontrada".
    installers[0].id = "pkg-pwsh".to_string();

    // Actualizar y desinstalar solo por una vía que exista aquí. Sin
    // repositorio de Microsoft, AUR ni Snap no se ofrece ninguna: no hay forma
    // de saber de dónde salió el pwsh instalado, y adivinarlo con el gestor de
    // la distribución reproduciría el mismo "paquete no encontrado".
    //
    // El repositorio de Microsoft va primero porque, una vez añadido, PowerShell
    // es un paquete normal: se actualiza y se quita con el gestor del sistema.
    if let (Some(commands), true) = (
        linux_pkg_commands(pkg_manager),
        microsoft_repo_install(pkg_manager).is_some(),
    ) {
        installers.push(
            InstallAction::new(
                "pkg-pwsh-update",
                "Actualizar PowerShell",
                format!("{} powershell", commands.update_one),
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("pwsh")),
        );
        installers.push(
            InstallAction::new(
                "pkg-pwsh-uninstall",
                "Desinstalar PowerShell",
                format!("{} powershell", commands.remove),
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("pwsh"))
            .hint("El repositorio de Microsoft se queda añadido; quitarlo es aparte."),
        );
    } else if let Some(aur) = aur {
        installers.push(
            InstallAction::new(
                "pkg-pwsh-update",
                format!("Actualizar PowerShell (AUR · {aur})"),
                format!("{aur} -S --noconfirm powershell-bin"),
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("pwsh")),
        );
        installers.push(
            InstallAction::new(
                "pkg-pwsh-uninstall",
                "Desinstalar PowerShell",
                "sudo pacman -Rs --noconfirm powershell-bin",
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("pwsh")),
        );
    } else if has_snap {
        installers.push(
            InstallAction::new(
                "pkg-pwsh-update",
                "Actualizar PowerShell (Snap)",
                "sudo snap refresh powershell",
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("pwsh")),
        );
        installers.push(
            InstallAction::new(
                "pkg-pwsh-uninstall",
                "Desinstalar PowerShell (Snap)",
                "sudo snap remove powershell",
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("pwsh")),
        );
    }

    installers.push(
        InstallAction::new("pkg-pwsh-version", "Ver versión de PowerShell", "pwsh -v")
            .short("Ver versión instalada")
            .verb("Versión")
            .requires(Some("pwsh")),
    );
    installers
}

// Nombres de paquete que cambian de una distro a otra. Los lenguajes y las
// shells llevan los suyos en LINUX_TOOLS; aquí quedan solo los de las
// herramientas que no pasan por tool_lifecycle_actions.
#[rustfmt::skip]
static LINUX_DOCKER_PKG: &[(&str, &str)] = &[("apt", "docker.io"), ("dnf", "docker"), ("pacman", "docker"), ("zypper", "docker"), ("apk", "docker")];
#[rustfmt::skip]
static LINUX_ADB_PKG: &[(&str, &str)] = &[("apt", "android-tools-adb"), ("dnf", "android-tools"), ("pacman", "android-tools"), ("zypper", "android-tools"), ("apk", "android-tools")];
#[rustfmt::skip]
static LINUX_SSH_PKG: &[(&str, &str)] = &[("apt", "openssh-client"), ("dnf", "openssh-clients"), ("pacman", "openssh"), ("zypper", "openssh-clients"), ("apk", "openssh-client")];

fn package_for(table: &[(&str, &'static str)], pkg_manager: &str) -> &'static str {
    table
        .iter()
        .find(|(name, _)| *name == pkg_manager)
        .map(|(_, package)| *package)
        .unwrap_or_default()
}

fn linux_actions(
    pkg_manager: Option<&str>,
    has_snap: bool,
    projects_folder: &str,
    aur_helper: Option<&str>,
    t: &Translator,
) -> Vec<InstallAction> {
    // Un gestor desconocido (o ninguno) cae en apt: es el más extendido y sus
    // comandos son los que más probabilidades tienen de servir.
    let pm = pkg_manager
        .filter(|name| linux_pkg_commands(name).is_some())
        .unwrap_or("apt");
    let commands = linux_pkg_commands(pm).expect("apt siempre está en la tabla");

    let mut actions = vec![git_pull_projects_posix_action(projects_folder)];

    actions.extend(
        LINUX_TOOLS
            .iter()
            .chain(LINUX_VIEWERS.iter())
            .chain(FILE_MANAGER_TOOLS.iter())
            .flat_map(|tool| {
                let package = tool.package_for(pm).unwrap_or_default();
                tool_lifecycle_actions(tool, package, commands, pm, t)
            }),
    );
    actions.extend(linux_code_editor_actions(pm, commands, t));
    actions.push(posix_sh_action());
    actions.extend(ecosystem_actions("python3", "npm"));

    // En Linux "Compatibilidad Windows" es lo que en Windows es WSL: la forma
    // de ejecutar lo del otro sistema. PowerShell y Wine son dos herramientas
    // distintas, así que cada una lleva su propio plegable.
    actions.extend(in_subgroup(
        WINDOWS_COMPAT_GROUP,
        "PowerShell",
        power_shell_actions(pm, has_snap, aur_helper, t),
    ));
    actions.extend(in_subgroup(
        WINDOWS_COMPAT_GROUP,
        "Wine · cmd.exe y VBS",
        vec![
            InstallAction::new(
                "pkg-wine",
                t.tp(
                    "action.pkg-wine.label",
                    &[("source", pm.to_string())],
                    "Instalar compatibilidad CMD/VBS con Wine ({source})",
                ),
                wine_install_command(pm, commands),
            )
            .short(t.tp(
                "action.installShort",
                &[("source", pm.to_string())],
                "Instalar con {source}",
            ))
            .check(Some("wine"))
            .hint(wine_hint(pm)),
            InstallAction::new(
                "wine-check",
                "Comprobar CMD compatible de Wine",
                "wine cmd /c ver",
            )
            .short("Comprobar que el CMD responde")
            .verb("Verificar")
            .requires(Some("wine")),
            // Muchos .exe y .msi antiguos necesitan componentes de Windows que
            // Wine no puede redistribuir (vcrun, .NET, fuentes básicas).
            // winetricks es la herramienta con la que se instalan, y sin ella
            // "Wine no funciona" acaba siendo "le falta una DLL".
            InstallAction::new(
                "pkg-winetricks",
                "Instalar winetricks (componentes de Windows para Wine)",
                format!("{} winetricks", commands.install),
            )
            .short("Instalar winetricks")
            .check(Some("winetricks"))
            .requires(Some("wine"))
            .hint(
                "Instala dentro del prefijo de Wine los componentes que Wine no puede \
                 redistribuir (Visual C++, .NET, fuentes). Es lo que hace falta cuando un .exe \
                 se queja de una DLL que falta.",
            ),
            InstallAction::new(
                "pkg-wine-update",
                "Actualizar Wine",
                format!("{} wine", commands.update_one),
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("wine")),
            InstallAction::new(
                "pkg-wine-uninstall",
                "Desinstalar Wine",
                format!("{} wine", commands.remove),
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("wine"))
            .hint("El prefijo con los programas instalados (~/.wine) no se borra."),
        ],
    ));
    actions.extend(linux_windows_compatibility_actions(pm, commands, t));

    let docker_pkg = package_for(LINUX_DOCKER_PKG, pm);
    actions.extend(in_subgroup(
        DOCKER_GROUP,
        "Docker",
        vec![
            InstallAction::new(
                "pkg-docker",
                t.tp(
                    "action.pkg-docker.label",
                    &[("source", pm.to_string())],
                    "Instalar Docker ({source})",
                ),
                format!(
                    "{} {docker_pkg} && sudo systemctl enable --now docker",
                    commands.install
                ),
            )
            .short(t.tp(
                "action.installShort",
                &[("source", pm.to_string())],
                "Instalar con {source}",
            ))
            .check(Some("docker"))
            .hint(
                "Para usar docker sin sudo: sudo usermod -aG docker $USER (requiere cerrar sesión \
                 y volver a entrar).",
            ),
            InstallAction::new(
                "pkg-docker-update",
                "Actualizar Docker",
                format!("{} {docker_pkg}", commands.update_one),
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("docker")),
            InstallAction::new(
                "pkg-docker-uninstall",
                "Desinstalar Docker",
                format!(
                    "sudo systemctl disable --now docker; {} {docker_pkg}",
                    commands.remove
                ),
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("docker"))
            .hint(
                "Detiene el servicio y elimina el paquete. Las imágenes y volúmenes en \
                 /var/lib/docker no se borran.",
            ),
            InstallAction::new("pkg-docker-version", "Ver versión de Docker", "docker --version")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("docker")),
            docker_check_action(),
            docker_list_action(),
            InstallAction::new(
                "docker-start-linux",
                "Iniciar servicio Docker",
                "sudo systemctl start docker",
            )
            .short("Iniciar el servicio")
            .hint(
                "En Linux el daemon es un servicio del sistema: requiere sudo, por eso la app no lo \
                 arranca sola.",
            )
            .verb("Iniciar")
            .requires(Some("docker")),
        ],
    ));

    let adb_pkg = package_for(LINUX_ADB_PKG, pm);
    actions.extend(in_subgroup(
        ADB_GROUP,
        ADB_SUBGROUP,
        vec![
            InstallAction::new(
                "pkg-adb",
                t.tp(
                    "action.pkg-adb.label",
                    &[("source", pm.to_string())],
                    "Instalar ADB / Android Platform Tools ({source})",
                ),
                format!("{} {adb_pkg}", commands.install),
            )
            .short(t.tp(
                "action.installShort",
                &[("source", pm.to_string())],
                "Instalar con {source}",
            ))
            .check(Some("adb")),
            InstallAction::new(
                "pkg-adb-update",
                t.tp(
                    "action.pkg-adb-update.label",
                    &[("source", pm.to_string())],
                    "Actualizar ADB a la última versión ({source})",
                ),
                format!("{} {adb_pkg}", commands.update_one),
            )
            .short(t.t("action.updateShort", "Actualizar a la última versión"))
            .verb("Actualizar")
            .requires(Some("adb")),
            InstallAction::new(
                "pkg-adb-uninstall",
                "Desinstalar ADB",
                format!("{} {adb_pkg}", commands.remove),
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("adb")),
            InstallAction::new(
                "adb-check",
                "Ver dispositivos ADB conectados",
                "adb devices",
            )
            .short("Ver dispositivos conectados")
            .verb("Ver")
            .requires(Some("adb")),
            InstallAction::new("adb-version", "Ver versión de ADB", "adb version")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("adb")),
        ],
    ));

    let ssh_pkg = package_for(LINUX_SSH_PKG, pm);
    actions.extend(in_subgroup(
        SSH_GROUP,
        SSH_SUBGROUP,
        vec![
            InstallAction::new(
                "pkg-ssh",
                t.tp(
                    "action.pkg-ssh.label",
                    &[("source", pm.to_string())],
                    "Instalar cliente SSH ({source})",
                ),
                format!("{} {ssh_pkg}", commands.install),
            )
            .short(t.tp(
                "action.installShort",
                &[("source", pm.to_string())],
                "Instalar con {source}",
            ))
            .check(Some("ssh")),
            InstallAction::new(
                "pkg-ssh-update",
                "Actualizar cliente SSH",
                format!("{} {ssh_pkg}", commands.update_one),
            )
            .short("Actualizar a la última versión")
            .verb("Actualizar")
            .requires(Some("ssh")),
            InstallAction::new(
                "pkg-ssh-uninstall",
                "Desinstalar cliente SSH",
                format!("{} {ssh_pkg}", commands.remove),
            )
            .short("Desinstalar del sistema")
            .verb("Desinstalar")
            .requires(Some("ssh")),
            InstallAction::new("ssh-check", "Ver versión de SSH instalada", "ssh -V")
                .short("Ver versión instalada")
                .verb("Versión")
                .requires(Some("ssh")),
        ],
    ));

    actions.push(
        InstallAction::new(
            "pkg-update",
            "Actualizar paquetes del sistema",
            commands.update,
        )
        .verb("Actualizar"),
    );
    actions
}

// ---- Ensamblado ----

/// Red de seguridad para las acciones sueltas que no declaran apartado. Antes
/// comparaba con `starts_with` y las de id `pkg-docker-*` / `pkg-adb-*` caían
/// en "Sistema y herramientas": Docker aparecía a la vez ahí y en su propio
/// apartado. Ahora el nombre de la herramienta se busca en cualquier tramo del
/// id, no solo al principio.
fn default_group(mut action: InstallAction) -> InstallAction {
    if !action.group.is_empty() {
        return action;
    }
    let parts: Vec<&str> = action.id.split('-').collect();
    let has = |name: &str| parts.contains(&name);
    action.group = if has("docker") {
        DOCKER_GROUP
    } else if has("adb") {
        ADB_GROUP
    } else if has("ssh") {
        SSH_GROUP
    } else if has("update") || has("upgrade") || has("pull") {
        UPDATES_GROUP
    } else {
        TOOLS_GROUP
    }
    .to_string();
    action
}

/// El panel se pinta en el orden en que llegan las acciones, así que el orden
/// de los apartados se decide aquí y no depende de en qué punto del catálogo
/// esté escrita cada acción. Dentro de cada apartado se respeta el orden
/// original: el frontend es quien coloca lo instalado antes que lo pendiente.
fn sort_by_group(mut actions: Vec<InstallAction>) -> Vec<InstallAction> {
    let rank = |name: &str| {
        GROUP_ORDER
            .iter()
            .position(|group| *group == name)
            .unwrap_or(GROUP_ORDER.len())
    };
    // `sort_by` es estable, así que dos acciones del mismo apartado conservan
    // el orden en el que las escribió el catálogo.
    actions.sort_by(|a, b| {
        rank(&a.group).cmp(&rank(&b.group)).then_with(|| {
            // Dos apartados fuera del orden fijo: alfabético, para que al menos
            // sea estable y previsible. Hoy no ocurre — todo apartado del
            // catálogo está en GROUP_ORDER — pero un apartado nuevo sin
            // declarar tiene que caer en algún sitio concreto.
            a.group.cmp(&b.group)
        })
    });
    actions
}

/// El catálogo completo para este sistema, ya ordenado por apartados. Sigue sin
/// filtrar: qué acciones tienen sentido aquí lo decide quien las pide, que es
/// el único que sabe qué comandos existen en el PATH.
pub fn get_install_actions(context: &InstallContext, t: &Translator) -> Vec<InstallAction> {
    let actions = match context.platform.as_str() {
        "windows" => windows_actions(context.wsl.as_ref(), &context.projects_folder, t),
        "macos" => mac_actions(&context.projects_folder, t),
        _ => linux_actions(
            context.pkg_manager.as_deref(),
            context.has_snap,
            &context.projects_folder,
            context.aur_helper.as_deref(),
            t,
        ),
    };
    sort_by_group(actions.into_iter().map(default_group).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl_env::{InstalledDistro, OnlineDistro};

    fn t() -> Translator {
        Translator::default()
    }

    fn contexto(platform: &str) -> InstallContext {
        InstallContext {
            platform: platform.to_string(),
            projects_folder: "C:\\Proyectos".to_string(),
            ..InstallContext::default()
        }
    }

    fn buscar<'a>(actions: &'a [InstallAction], id: &str) -> &'a InstallAction {
        actions
            .iter()
            .find(|action| action.id == id)
            .unwrap_or_else(|| panic!("no existe la accion '{id}'"))
    }

    fn distro(name: &str, pkg_manager: &str) -> InstalledDistro {
        InstalledDistro {
            name: name.to_string(),
            shell: "/bin/bash".to_string(),
            package_manager: Some(pkg_manager.to_string()),
            shells: vec!["bash".to_string()],
            tools: vec![],
            detailed: true,
            probe_error: false,
        }
    }

    #[test]
    fn cada_herramienta_de_windows_ofrece_su_ciclo_de_vida_completo() {
        let actions = get_install_actions(&contexto("windows"), &t());
        for sufijo in ["", "-update", "-uninstall", "-version"] {
            let id = format!("winget-git{sufijo}");
            assert!(
                actions.iter().any(|action| action.id == id),
                "falta la accion '{id}'"
            );
        }
    }

    #[test]
    fn instalar_y_actualizar_nunca_se_ofrecen_a_la_vez_para_la_misma_herramienta() {
        let actions = get_install_actions(&contexto("windows"), &t());
        // Instalar se oculta si el comando ya está; actualizar se muestra solo
        // si está. Las dos condiciones son excluyentes sobre el mismo comando.
        assert_eq!(
            buscar(&actions, "winget-go").check_cmd.as_deref(),
            Some("go")
        );
        assert_eq!(
            buscar(&actions, "winget-go-update").requires_cmd.as_deref(),
            Some("go")
        );
        assert!(buscar(&actions, "winget-go").requires_cmd.is_none());
        assert!(buscar(&actions, "winget-go-update").check_cmd.is_none());
    }

    #[test]
    fn una_aplicacion_de_escritorio_no_se_detecta_y_pregunta_a_winget_por_su_version() {
        let actions = get_install_actions(&contexto("windows"), &t());
        // ImageGlass no deja ejecutable en el PATH: fingir una detección daría
        // siempre "no instalado" y la acción de instalar no desaparecería nunca.
        let instalar = buscar(&actions, "viewer-image");
        assert!(instalar.check_cmd.is_none());
        let version = buscar(&actions, "viewer-image-version");
        assert_eq!(
            version.command,
            "winget list --id DuongDieuPhap.ImageGlass -e --source winget --accept-source-agreements --disable-interactivity"
        );
        assert_eq!(version.verb.as_deref(), Some("Comprobar"));
    }

    #[test]
    fn actualizar_con_winget_adopta_instalaciones_ajenas_y_no_falla_si_esta_al_dia() {
        let actions = get_install_actions(&contexto("windows"), &t());
        let command = &buscar(&actions, "winget-git-update").command;
        assert!(command.contains("winget list --id Git.Git"));
        assert!(command.contains("winget install --id Git.Git"));
        assert!(command.contains("winget upgrade --id Git.Git"));
        assert!(command.contains("no hay actualizaciones disponibles"));
        assert!(command.contains("--source winget"));
        assert!(command.contains("--disable-interactivity"));
    }

    #[test]
    fn instalar_con_winget_acepta_contratos_y_fija_el_origen() {
        let actions = get_install_actions(&contexto("windows"), &t());
        let command = &buscar(&actions, "winget-git").command;
        assert!(command.contains("--accept-source-agreements"));
        assert!(command.contains("--accept-package-agreements"));
        assert!(command.contains("--source winget"));
        assert!(command.contains("--disable-interactivity"));
    }

    #[test]
    fn php_usa_la_rama_estable_cuyo_manifiesto_apunta_al_archivo_vigente() {
        let actions = get_install_actions(&contexto("windows"), &t());
        let command = &buscar(&actions, "winget-php").command;

        assert!(command.contains("--id PHP.PHP.8.5 "));
        assert!(!command.contains("PHP.PHP.8.3"));
    }

    #[test]
    fn los_editores_de_codigo_se_muestran_en_un_subgrupo_comun() {
        let actions = get_install_actions(&contexto("windows"), &t());
        assert_eq!(
            buscar(&actions, "viewer-code").check_cmd.as_deref(),
            Some("code")
        );
        assert_eq!(
            buscar(&actions, "viewer-code").subgroup.as_deref(),
            Some("Editores de código")
        );
        assert!(actions.iter().any(|a| a.id == "editor-vscodium-win"
            && a.subgroup.as_deref() == Some("Editores de código")));
        for id in ["editor-visualstudio-win", "editor-jetbrains-toolbox-win"] {
            assert!(
                actions
                    .iter()
                    .any(|a| a.id == id && a.subgroup.as_deref() == Some("Editores de código")),
                "falta {id} en el submenú de IDE"
            );
        }
    }

    #[test]
    fn linux_incluye_code_oss_como_visor_de_codigo() {
        let actions = get_install_actions(&contexto("linux"), &t());
        let code_oss = buscar(&actions, "viewer-code-oss");
        assert_eq!(code_oss.check_cmd.as_deref(), Some("code"));
        assert_eq!(code_oss.subgroup.as_deref(), Some("Editores de código"));
        assert_eq!(code_oss.command, "sudo apt install -y code-oss");

        let arch = get_install_actions(
            &InstallContext {
                pkg_manager: Some("pacman".to_string()),
                ..contexto("linux")
            },
            &t(),
        );
        assert_eq!(
            buscar(&arch, "viewer-code-oss").command,
            "sudo pacman -S --noconfirm code"
        );

        for platform in ["windows", "macos"] {
            let actions = get_install_actions(&contexto(platform), &t());
            assert!(
                !actions.iter().any(|action| action.id == "viewer-code-oss"),
                "Code - OSS no debe aparecer en {platform}"
            );
        }
    }

    #[test]
    fn linux_expone_la_compatibilidad_windows_por_categorias() {
        let actions = get_install_actions(&contexto("linux"), &t());
        let expected = [
            ("compat-bottles", COMPAT_APPS),
            ("compat-crossover-download", COMPAT_APPS),
            ("compat-steam", COMPAT_GAMES),
            ("compat-protonup", COMPAT_GAMES),
            ("compat-lutris", COMPAT_GAMES),
            ("compat-qemu", COMPAT_FULL_WINDOWS),
            ("compat-libvirt", COMPAT_FULL_WINDOWS),
            ("compat-virt-manager", COMPAT_FULL_WINDOWS),
            ("compat-gnome-boxes", COMPAT_FULL_WINDOWS),
            ("compat-winetricks", COMPAT_AUXILIARY),
            ("compat-dxvk", COMPAT_AUXILIARY),
            ("compat-vkd3d", COMPAT_AUXILIARY),
            ("compat-cabextract", COMPAT_AUXILIARY),
            ("compat-msitools", COMPAT_AUXILIARY),
            ("compat-mingw", COMPAT_DEVELOPMENT),
        ];
        for (id, category) in expected {
            let action = buscar(&actions, id);
            assert_eq!(
                action.group, WINDOWS_COMPAT_GROUP,
                "{id} fuera de compatibilidad"
            );
            assert_eq!(
                action.subgroup.as_deref(),
                Some(category),
                "{id} en categoría incorrecta"
            );
        }
        assert_eq!(
            buscar(&actions, "compat-bottles-open").verb.as_deref(),
            Some("Abrir")
        );
    }

    #[test]
    fn las_categorias_y_acciones_de_compatibilidad_se_traducen() {
        let actions = get_install_actions(&contexto("linux"), &t());
        let bottles = buscar(&actions, "compat-bottles-open").translated("en");
        assert_eq!(bottles.subgroup.as_deref(), Some("Windows Applications"));
        assert_eq!(bottles.verb.as_deref(), Some("Open"));
        assert_eq!(bottles.label, "Open Bottles");
    }

    #[test]
    fn la_compatibilidad_windows_de_linux_no_se_mezcla_con_windows_nativo() {
        let actions = get_install_actions(&contexto("windows"), &t());
        for id in [
            "compat-bottles",
            "compat-steam",
            "compat-qemu",
            "compat-winetricks",
            "compat-mingw",
        ] {
            assert!(
                !actions.iter().any(|action| action.id == id),
                "{id} no debe aparecer en Windows nativo"
            );
        }
    }

    #[test]
    fn cada_editor_conserva_su_nombre_dentro_del_submenu() {
        for platform in ["linux", "windows"] {
            let actions = get_install_actions(&contexto(platform), &t());
            let editors: Vec<&InstallAction> = actions
                .iter()
                .filter(|action| action.subgroup.as_deref() == Some(CODE_EDITORS_SUBGROUP))
                .collect();
            assert!(!editors.is_empty(), "{platform}: no hay editores");
            for editor in editors {
                let short = editor.short_label.as_deref().unwrap_or_default();
                assert_ne!(short, "Instalar con pacman", "{platform}: {}", editor.id);
                assert_ne!(short, "Instalar con winget", "{platform}: {}", editor.id);
                assert!(
                    short.contains("código") || short.contains("descarga oficial"),
                    "{platform}: el editor {} perdió su nombre: {short}",
                    editor.id
                );
            }
        }
    }

    #[test]
    fn las_cuatro_acciones_de_una_herramienta_comparten_plegable() {
        let actions = get_install_actions(&contexto("windows"), &t());
        let subgrupos: Vec<Option<&str>> = ["", "-update", "-uninstall", "-version"]
            .iter()
            .map(|sufijo| {
                buscar(&actions, &format!("winget-python{sufijo}"))
                    .subgroup
                    .as_deref()
            })
            .collect();
        assert!(subgrupos.iter().all(|s| *s == Some("Python")));
    }

    #[test]
    fn docker_de_windows_cae_bajo_el_mismo_plegable_que_su_instalador() {
        let actions = get_install_actions(&contexto("windows"), &t());
        // Instalar, verificar y arrancar Docker tienen que quedar juntos: antes
        // se repartían entre "Docker Desktop" y acciones sueltas del apartado.
        for id in ["winget-docker", "docker-check", "docker-start-win"] {
            let action = buscar(&actions, id);
            assert_eq!(action.group, DOCKER_GROUP, "{id} fuera del apartado Docker");
            assert_eq!(action.subgroup.as_deref(), Some("Docker Desktop"), "{id}");
        }
    }

    #[test]
    fn cada_sistema_solo_ofrece_su_forma_de_arrancar_docker() {
        let windows = get_install_actions(&contexto("windows"), &t());
        assert!(windows.iter().any(|action| action.id == "docker-start-win"));
        assert!(!windows
            .iter()
            .any(|action| action.id == "docker-start-linux"));

        let linux = get_install_actions(&contexto("linux"), &t());
        assert!(linux.iter().any(|action| action.id == "docker-start-linux"));
        assert!(!linux.iter().any(|action| action.id == "docker-start-win"));
        assert_eq!(
            buscar(&linux, "docker-start-linux").command,
            "sudo systemctl start docker"
        );
    }

    #[test]
    fn windows_incluye_nsudo_lenguajes_y_kubernetes_en_el_catalogo() {
        let actions = get_install_actions(&contexto("windows"), &t());
        for id in [
            "winget-nsudo",
            "winget-bun",
            "winget-julia",
            "winget-r",
            "winget-dotnet",
            "winget-llvm",
            "winget-cmake",
            "winget-openvpn",
            "winget-wireguard",
            "winget-tailscale",
            "winget-kubectl",
            "winget-helm",
            "winget-k9s",
        ] {
            assert!(
                actions.iter().any(|action| action.id == id),
                "falta {id} en Windows"
            );
        }
        for id in ["winget-kubectl", "winget-helm", "winget-k9s"] {
            assert_eq!(buscar(&actions, id).group, DOCKER_GROUP, "{id}");
        }
        assert_eq!(buscar(&actions, "winget-nsudo").group, TOOLS_GROUP);
    }

    #[test]
    fn el_script_de_adb_no_lleva_comillas_dobles_porque_cmd_lo_envuelve_con_ellas() {
        // wrap_powershell_command mete el script entero entre comillas dobles
        // para invocarlo desde cmd.exe: una comilla doble dentro lo partiría.
        assert!(!ADB_INSTALL_PS.contains('"'));
        assert!(!ADB_UNINSTALL_PS.contains('"'));
    }

    #[test]
    fn sin_wsl_solo_se_ofrece_activar_la_plataforma() {
        let actions = get_install_actions(&contexto("windows"), &t());
        assert!(actions.iter().any(|a| a.id == "wsl-install-base"));
        assert!(!actions.iter().any(|a| a.id == "wsl-update"));
    }

    #[test]
    fn una_distro_ya_instalada_no_vuelve_a_ofrecerse_en_el_catalogo_en_linea() {
        let context = InstallContext {
            wsl: Some(WslContext {
                available: true,
                installed: vec![distro("Ubuntu", "apt")],
                online: vec![
                    OnlineDistro {
                        name: "Ubuntu".to_string(),
                        friendly_name: "Ubuntu LTS".to_string(),
                    },
                    OnlineDistro {
                        name: "Debian".to_string(),
                        friendly_name: "Debian GNU/Linux".to_string(),
                    },
                ],
            }),
            ..contexto("windows")
        };
        let actions = get_install_actions(&context, &t());
        assert!(!actions.iter().any(|a| a.id == "wsl-distro-ubuntu"));
        assert_eq!(
            buscar(&actions, "wsl-distro-debian").label,
            "Instalar Debian GNU/Linux"
        );
    }

    #[test]
    fn dentro_de_una_distro_solo_se_ofrece_lo_que_la_sonda_no_encontro() {
        let mut ubuntu = distro("Ubuntu", "apt");
        ubuntu.shells = vec!["bash".to_string(), "zsh".to_string()];
        ubuntu.tools = vec!["git".to_string()];
        let context = InstallContext {
            wsl: Some(WslContext {
                available: true,
                installed: vec![ubuntu],
                online: vec![],
            }),
            ..contexto("windows")
        };
        let actions = get_install_actions(&context, &t());
        // bash, zsh y git ya están; fish, node y python3 no.
        for ausente in ["wsl-ubuntu-bash", "wsl-ubuntu-zsh", "wsl-ubuntu-git"] {
            assert!(!actions.iter().any(|a| a.id == ausente), "{ausente} sobra");
        }
        for presente in ["wsl-ubuntu-fish", "wsl-ubuntu-node", "wsl-ubuntu-python"] {
            assert!(actions.iter().any(|a| a.id == presente), "falta {presente}");
        }
    }

    #[test]
    fn una_distro_que_no_respondio_a_la_sonda_no_genera_instalaciones_inventadas() {
        let mut ubuntu = distro("Ubuntu", "apt");
        ubuntu.probe_error = true;
        let context = InstallContext {
            wsl: Some(WslContext {
                available: true,
                installed: vec![ubuntu],
                online: vec![],
            }),
            ..contexto("windows")
        };
        let actions = get_install_actions(&context, &t());
        assert!(!actions.iter().any(|a| a.id.starts_with("wsl-ubuntu-")));
    }

    #[test]
    fn apt_refresca_indices_antes_de_instalar_y_solo_sigue_si_fue_bien() {
        let command = wsl_package_install("Ubuntu", "apt", "git").unwrap();
        assert!(command.contains("sudo apt update; if ($LASTEXITCODE -eq 0)"));
        assert!(command.contains("sudo apt install -y git"));
        // pacman no necesita ese refresco previo.
        assert_eq!(
            wsl_package_install("Arch", "pacman", "git").unwrap(),
            "wsl.exe -d 'Arch' -- sudo pacman -S --noconfirm git"
        );
        assert_eq!(
            wsl_package_install("Alpine", "apk", "git").unwrap(),
            "wsl.exe -d 'Alpine' -- sudo apk add git"
        );
    }

    #[test]
    fn un_gestor_desconocido_dentro_de_wsl_no_genera_ningun_comando() {
        assert!(wsl_package_install("Rara", "portage", "git").is_none());
        assert!(wsl_package_update("Rara", "portage").is_none());
    }

    #[test]
    fn el_nombre_de_una_distro_con_comillas_no_rompe_el_comando_de_powershell() {
        assert_eq!(ps_single("O'Linux"), "'O''Linux'");
        assert_eq!(sh_single("O'Linux"), "'O'\\''Linux'");
    }

    #[test]
    fn safe_id_deja_un_identificador_legible_sin_guiones_sueltos() {
        assert_eq!(safe_id("Ubuntu-24.04 LTS"), "ubuntu-24-04-lts");
        assert_eq!(safe_id("  openSUSE  "), "opensuse");
        assert_eq!(safe_id("---"), "");
    }

    #[test]
    fn en_arch_con_asistente_del_aur_powershell_se_instala_desde_ahi() {
        let actions = power_shell_actions("pacman", false, Some("paru"), &t());
        // El id estable lo lleva la vía recomendada en este sistema, que es a
        // la que apunta la sugerencia de "comando no encontrado".
        assert_eq!(actions[0].id, "pkg-pwsh");
        assert_eq!(actions[0].command, "paru -S --noconfirm powershell-bin");
        assert_eq!(
            buscar(&actions, "pkg-pwsh-uninstall").command,
            "sudo pacman -Rs --noconfirm powershell-bin"
        );
    }

    #[test]
    fn donde_microsoft_publica_repositorio_esa_es_la_via_recomendada() {
        // Antes, en una Ubuntu el panel mandaba instalar snapd: `apt install
        // powershell` no existe en los repos de la distro. Pero Microsoft sí
        // publica el suyo, que es lo que su propia documentación manda usar.
        for pm in ["apt", "dnf", "zypper"] {
            let actions = power_shell_actions(pm, false, None, &t());
            assert_eq!(actions[0].id, "pkg-pwsh", "{pm}");
            assert!(
                actions[0].command.contains("packages.microsoft.com"),
                "{pm}: la via recomendada no es el repositorio de Microsoft"
            );
            assert_eq!(actions[0].check_cmd.as_deref(), Some("pwsh"));
        }
    }

    #[test]
    fn la_url_del_repositorio_sale_de_os_release_y_no_lleva_la_distro_escrita() {
        // Con la version escrita a mano, el catalogo caduca con cada Ubuntu
        // nueva. `$ID` y `$VERSION_ID` los resuelve la propia maquina.
        let apt = power_shell_actions("apt", false, None, &t());
        assert!(apt[0].command.contains("/etc/os-release"));
        assert!(apt[0].command.contains("$ID"));
        assert!(apt[0].command.contains("$VERSION_ID"));
        // Fedora numera aparte: ahi la version la da rpm, no os-release.
        let dnf = power_shell_actions("dnf", false, None, &t());
        assert!(dnf[0].command.contains("rpm -E %fedora"));
    }

    #[test]
    fn con_repositorio_de_microsoft_powershell_se_mantiene_con_el_gestor_del_sistema() {
        // Una vez anadido el repositorio es un paquete mas: no hace falta snap
        // ni el AUR para actualizarlo o quitarlo.
        let actions = power_shell_actions("apt", false, None, &t());
        assert_eq!(
            buscar(&actions, "pkg-pwsh-update").command,
            "sudo apt install -y --only-upgrade powershell"
        );
        assert_eq!(
            buscar(&actions, "pkg-pwsh-uninstall").command,
            "sudo apt remove -y powershell"
        );
    }

    #[test]
    fn con_snap_powershell_sigue_ofreciendose_como_alternativa() {
        let actions = power_shell_actions("apt", true, None, &t());
        // El repositorio manda, pero Snap no desaparece: quien lo prefiera lo
        // tiene ahi.
        assert!(actions[0].command.contains("packages.microsoft.com"));
        assert!(actions
            .iter()
            .any(|a| a.command == "sudo snap install powershell --classic"));
    }

    #[test]
    fn en_arch_no_hay_repositorio_de_microsoft_y_se_sigue_cayendo_a_snapd() {
        // Microsoft no publica para Arch: alli la via es el AUR, y sin asistente
        // ni snap lo unico honesto es ofrecer el requisito.
        let actions = power_shell_actions("pacman", false, None, &t());
        assert_eq!(actions[0].id, "pkg-pwsh");
        assert!(actions[0].command.contains("snapd"));
        assert!(!actions.iter().any(|a| a.id == "pkg-pwsh-update"));
    }

    #[test]
    fn en_arch_sin_asistente_se_ofrece_tambien_instalar_paru() {
        let actions = power_shell_actions("pacman", false, None, &t());
        assert!(actions.iter().any(|a| a.id == "pkg-paru"));
        // El asistente del AUR se invoca sin sudo: makepkg se niega a correr
        // como root y paru pide la contraseña cuando la necesita.
        assert!(!buscar(&actions, "pkg-paru")
            .command
            .contains("sudo makepkg"));
    }

    #[test]
    fn un_asistente_del_aur_fuera_de_arch_se_ignora() {
        // yay instalado en una Debian no significa nada: el AUR es de Arch.
        let actions = power_shell_actions("apt", false, Some("yay"), &t());
        assert!(!actions.iter().any(|a| a.id == "pkg-pwsh-aur"));
    }

    #[test]
    fn desinstalar_bash_no_lleva_respuesta_automatica_porque_medio_sistema_depende_de_el() {
        let actions = get_install_actions(
            &InstallContext {
                pkg_manager: Some("apt".to_string()),
                ..contexto("linux")
            },
            &t(),
        );
        assert_eq!(
            buscar(&actions, "pkg-bash-uninstall").command,
            "sudo apt remove bash"
        );
        // zsh no arrastra medio sistema: ahí sí se acepta por adelantado.
        assert_eq!(
            buscar(&actions, "pkg-zsh-uninstall").command,
            "sudo apt remove -y zsh"
        );
    }

    #[test]
    fn cada_distribucion_recibe_el_nombre_de_paquete_que_usa_su_gestor() {
        for (pm, java, docker) in [
            ("apt", "default-jdk", "docker.io"),
            ("dnf", "java-latest-openjdk-devel", "docker"),
            ("pacman", "jdk-openjdk", "docker"),
            ("zypper", "java-openjdk-devel", "docker"),
            ("apk", "openjdk17-jdk", "docker"),
        ] {
            let actions = get_install_actions(
                &InstallContext {
                    pkg_manager: Some(pm.to_string()),
                    ..contexto("linux")
                },
                &t(),
            );
            assert!(
                buscar(&actions, "pkg-java").command.ends_with(java),
                "{pm}: se esperaba el paquete {java}"
            );
            assert!(
                buscar(&actions, "pkg-docker").command.contains(docker),
                "{pm}: se esperaba el paquete {docker}"
            );
        }
    }

    #[test]
    fn un_gestor_de_paquetes_desconocido_cae_en_apt() {
        let actions = get_install_actions(
            &InstallContext {
                pkg_manager: Some("portage".to_string()),
                ..contexto("linux")
            },
            &t(),
        );
        assert_eq!(
            buscar(&actions, "pkg-git").command,
            "sudo apt install -y git"
        );
    }

    #[test]
    fn wine_en_debian_habilita_los_32_bits_antes_de_instalarse() {
        // La mayoria de .exe que alguien abre con Wine siguen siendo de 32 bits,
        // y sin la arquitectura i386 Wine los rechaza con un error que no dice
        // por que. Es la causa mas comun de "instale Wine y no funciona nada".
        let apt = get_install_actions(
            &InstallContext {
                pkg_manager: Some("apt".to_string()),
                ..contexto("linux")
            },
            &t(),
        );
        let wine = buscar(&apt, "pkg-wine");
        assert!(wine
            .command
            .starts_with("sudo dpkg --add-architecture i386"));
        assert!(wine.command.contains("wine32"));

        // En las demas familias el paquete de 32 bits viene resuelto.
        let pacman = get_install_actions(
            &InstallContext {
                pkg_manager: Some("pacman".to_string()),
                ..contexto("linux")
            },
            &t(),
        );
        assert_eq!(
            buscar(&pacman, "pkg-wine").command,
            "sudo pacman -S --noconfirm wine"
        );
    }

    #[test]
    fn winetricks_solo_se_ofrece_cuando_wine_ya_esta() {
        let actions = get_install_actions(&contexto("linux"), &t());
        let winetricks = buscar(&actions, "pkg-winetricks");
        assert_eq!(winetricks.requires_cmd.as_deref(), Some("wine"));
        assert_eq!(winetricks.check_cmd.as_deref(), Some("winetricks"));
    }

    #[test]
    fn sh_no_ofrece_instalarse_porque_no_es_un_paquete() {
        let actions = get_install_actions(&contexto("linux"), &t());
        let sh: Vec<&InstallAction> = actions
            .iter()
            .filter(|a| a.subgroup.as_deref() == Some("sh"))
            .collect();
        assert_eq!(sh.len(), 1);
        assert_eq!(sh[0].verb.as_deref(), Some("Versión"));
    }

    #[test]
    fn en_macos_el_ciclo_de_vida_pasa_entero_por_homebrew() {
        let actions = get_install_actions(&contexto("macos"), &t());
        assert_eq!(buscar(&actions, "brew-go").command, "brew install go");
        assert_eq!(
            buscar(&actions, "brew-go-update").command,
            "brew upgrade go"
        );
        assert_eq!(
            buscar(&actions, "brew-go-uninstall").command,
            "brew uninstall go"
        );
        // Sin remove_core, bash se desinstala como cualquier otro paquete.
        assert_eq!(
            buscar(&actions, "brew-bash-uninstall").command,
            "brew uninstall bash"
        );
    }

    #[test]
    fn los_visores_de_macos_conservan_el_prefijo_cask_del_paquete() {
        let actions = get_install_actions(&contexto("macos"), &t());
        assert_eq!(
            buscar(&actions, "viewer-code").command,
            "brew install --cask visual-studio-code"
        );
    }

    #[test]
    fn los_gestores_de_archivos_graficos_solo_aparecen_en_linux() {
        let linux = get_install_actions(&contexto("linux"), &t());
        assert!(linux.iter().any(|a| a.id == "viewer-files-dolphin"));
        for platform in ["windows", "macos"] {
            let actions = get_install_actions(&contexto(platform), &t());
            assert!(
                !actions.iter().any(|a| a.id.starts_with("viewer-files-")),
                "{platform} no necesita gestor de archivos: ya trae el suyo"
            );
        }
    }

    #[test]
    fn los_apartados_salen_en_el_orden_declarado_y_no_en_el_que_se_escribieron() {
        for platform in ["windows", "linux", "macos"] {
            let actions = get_install_actions(&contexto(platform), &t());
            let ranks: Vec<usize> = actions
                .iter()
                .map(|action| {
                    GROUP_ORDER
                        .iter()
                        .position(|group| *group == action.group)
                        .unwrap_or_else(|| {
                            panic!("{platform}: apartado '{}' no declarado", action.group)
                        })
                })
                .collect();
            assert!(
                ranks.windows(2).all(|par| par[0] <= par[1]),
                "{platform}: los apartados llegan desordenados"
            );
        }
    }

    #[test]
    fn dentro_de_un_apartado_se_respeta_el_orden_en_que_lo_escribio_el_catalogo() {
        let actions = get_install_actions(&contexto("windows"), &t());
        let lenguajes: Vec<&str> = actions
            .iter()
            .filter(|a| a.group == LANGUAGES_GROUP && a.check_cmd.is_some())
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(lenguajes.first(), Some(&"winget-node"));
        assert_eq!(lenguajes.last(), Some(&"winget-groovy"));
    }

    #[test]
    fn el_catalogo_de_ecosistemas_cubre_las_familias_principales() {
        let esperados = [
            "Python · frameworks y librerías",
            "JavaScript / TypeScript · herramientas y frameworks",
            "Rust · frameworks y herramientas",
            "Go · frameworks y herramientas",
            "PHP · frameworks y herramientas",
            "Ruby · frameworks y herramientas",
            ".NET · herramientas y frameworks",
            "Elixir · frameworks y herramientas",
            "Dart / Flutter · herramientas y ecosistema",
            "Lua · frameworks y herramientas",
            "C / C++ · build y herramientas",
            "Haskell · herramientas y ecosistema",
        ];

        for platform in ["windows", "linux", "macos"] {
            let actions = get_install_actions(&contexto(platform), &t());
            let subgroups: Vec<&str> = actions
                .iter()
                .filter(|action| action.group == FRAMEWORKS_GROUP)
                .filter_map(|action| action.subgroup.as_deref())
                .collect();
            for subgroup in esperados {
                assert!(
                    subgroups.contains(&subgroup),
                    "{platform}: falta el subgrupo de ecosistema '{subgroup}'"
                );
            }
            assert!(
                subgroups.len() >= 12,
                "{platform}: el catálogo de frameworks no tiene suficientes familias"
            );
        }
    }

    #[test]
    fn una_accion_sin_apartado_lo_deduce_de_cualquier_tramo_de_su_id() {
        // Con startsWith, "pkg-docker-update" caía en "Sistema y herramientas"
        // y Docker aparecía a la vez ahí y en su propio apartado.
        let deducido = |id: &str| default_group(InstallAction::new(id, "", "")).group;
        assert_eq!(deducido("pkg-docker-update"), DOCKER_GROUP);
        assert_eq!(deducido("pkg-adb-uninstall"), ADB_GROUP);
        assert_eq!(deducido("winget-ssh"), SSH_GROUP);
        assert_eq!(deducido("winget-upgrade"), UPDATES_GROUP);
        assert_eq!(deducido("git-pull-projects"), UPDATES_GROUP);
        assert_eq!(deducido("algo-suelto"), TOOLS_GROUP);
    }

    #[test]
    fn una_accion_con_apartado_propio_conserva_el_suyo_dentro_de_un_plegable() {
        // El apartado de docker-check es Docker aunque se meta en el bloque de
        // otro grupo: el spread del original iba después a propósito.
        let actions = in_subgroup("Otro", "Plegable", vec![docker_check_action()]);
        assert_eq!(actions[0].group, DOCKER_GROUP);
        assert_eq!(actions[0].subgroup.as_deref(), Some("Plegable"));
    }

    #[test]
    fn ninguna_accion_repite_identificador_en_la_misma_plataforma() {
        for platform in ["windows", "linux", "macos"] {
            let actions = get_install_actions(&contexto(platform), &t());
            let mut ids: Vec<&str> = actions.iter().map(|a| a.id.as_str()).collect();
            ids.sort_unstable();
            let total = ids.len();
            ids.dedup();
            assert_eq!(
                total,
                ids.len(),
                "{platform}: hay identificadores repetidos"
            );
        }
    }

    #[test]
    fn toda_accion_llega_con_id_etiqueta_comando_y_apartado() {
        for platform in ["windows", "linux", "macos"] {
            for action in get_install_actions(&contexto(platform), &t()) {
                assert!(!action.id.is_empty(), "{platform}: accion sin id");
                assert!(
                    !action.label.is_empty(),
                    "{platform}: {} sin etiqueta",
                    action.id
                );
                assert!(
                    !action.command.is_empty(),
                    "{platform}: {} sin comando",
                    action.id
                );
                assert!(
                    !action.group.is_empty(),
                    "{platform}: {} sin apartado",
                    action.id
                );
            }
        }
    }

    #[test]
    fn los_ids_a_los_que_apunta_la_sugerencia_de_comando_no_encontrado_siguen_existiendo() {
        // command_not_found y file_viewers referencian estos ids: cambiarlos
        // rompe la sugerencia sin que falle nada más.
        let windows = get_install_actions(&contexto("windows"), &t());
        for id in ["winget-git", "winget-node", "adb-install", "viewer-code"] {
            assert!(windows.iter().any(|a| a.id == id), "falta {id} en Windows");
        }
        let linux = get_install_actions(&contexto("linux"), &t());
        for id in [
            "pkg-git",
            "pkg-node",
            "pkg-pwsh",
            "pkg-wine",
            "viewer-image",
        ] {
            assert!(linux.iter().any(|a| a.id == id), "falta {id} en Linux");
        }
    }

    #[test]
    fn actualizar_los_repositorios_clonados_nunca_reescribe_historia() {
        let windows = git_pull_projects_action("C:\\Proyectos");
        let posix = git_pull_projects_posix_action("/home/yo/Proyectos");
        assert!(windows.command.contains("-Depth 2"));
        for action in [&windows, &posix] {
            assert!(action.command.contains("pull --ff-only"));
            assert!(!action.command.contains("--force"));
            assert!(!action.command.contains("reset"));
            assert_eq!(action.requires_cmd.as_deref(), Some("git"));
        }
    }

    #[test]
    fn el_catalogo_se_traduce_al_generarlo_sin_cambiar_ids_ni_comandos() {
        let espanol = get_install_actions(&contexto("windows"), &Translator::new("es"));
        let ingles = get_install_actions(&contexto("windows"), &Translator::new("en"));
        assert_eq!(espanol.len(), ingles.len());
        for (es, en) in espanol.iter().zip(ingles.iter()) {
            assert_eq!(es.id, en.id);
            assert_eq!(es.command, en.command);
            assert_eq!(es.group, en.group);
        }
        assert_eq!(buscar(&espanol, "winget-go").label, "Instalar Go (winget)");
        assert_eq!(buscar(&ingles, "winget-go").label, "Install Go (winget)");
    }

    #[test]
    fn ninguna_etiqueta_traducida_deja_un_parametro_sin_resolver() {
        for language in ["es", "en"] {
            let t = Translator::new(language);
            for platform in ["windows", "linux", "macos"] {
                for action in get_install_actions(&contexto(platform), &t) {
                    for texto in [Some(&action.label), action.short_label.as_ref()]
                        .into_iter()
                        .flatten()
                    {
                        assert!(
                            !texto.contains('{'),
                            "{language}/{platform}: '{texto}' ({}) tiene un hueco sin rellenar",
                            action.id
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn la_traduccion_por_id_alcanza_a_las_acciones_escritas_a_mano() {
        // Las etiquetas que no salen de un patrón no las traduce el generador:
        // se traducen aquí, por el id estable de la acción.
        let actions = get_install_actions(&contexto("windows"), &Translator::new("en"));
        let adb = buscar(&actions, "adb-check").translated("en");
        assert_eq!(adb.label, "Show connected ADB devices");
        assert_eq!(adb.verb.as_deref(), Some("View"));
        assert_eq!(adb.group_key, Some("group.android"));
    }

    #[test]
    fn las_cabeceras_plegables_de_wsl_no_se_quedan_en_espanol() {
        for (raw, expected) in [
            ("WSL (plataforma)", "WSL (platform)"),
            ("Distribuciones disponibles", "Available distributions"),
        ] {
            let action = InstallAction::new("wsl-test", "Acción", "comando")
                .group(WSL_GROUP)
                .subgroup(raw)
                .translated("en");
            assert_eq!(action.subgroup.as_deref(), Some(expected));
        }
    }

    #[test]
    fn las_etiquetas_y_ayudas_dinamicas_del_panel_se_traducen() {
        let french = Translator::new("fr");
        let context = InstallContext {
            wsl: Some(WslContext {
                available: true,
                installed: vec![distro("Ubuntu", "apt")],
                online: vec![OnlineDistro {
                    name: "Debian".to_string(),
                    friendly_name: "Debian GNU/Linux".to_string(),
                }],
            }),
            ..contexto("windows")
        };
        let actions = get_install_actions(&context, &french);

        let online = buscar(&actions, "wsl-distro-debian");
        assert_eq!(online.label, "Installer Debian GNU/Linux");
        assert!(online
            .hint
            .as_deref()
            .is_some_and(|hint| hint.starts_with("Nom WSL : Debian.")));

        let inside = buscar(&actions, "wsl-ubuntu-node");
        assert_eq!(inside.label, "Installer Node.js et npm dans Ubuntu");
        assert_eq!(
            inside.hint.as_deref(),
            Some("Installé uniquement dans Ubuntu.")
        );

        let adb = buscar(&actions, "adb-authorize").translated("fr");
        assert!(adb
            .hint
            .as_deref()
            .is_some_and(|hint| hint.starts_with("Pour un appareil")));

        let docker = buscar(&actions, "winget-docker").translated("fr");
        assert!(docker
            .hint
            .as_deref()
            .is_some_and(|hint| hint.starts_with("Nécessite WSL2")));
    }

    #[test]
    fn una_etiqueta_sin_traducir_se_queda_en_espanol_en_vez_de_en_su_clave() {
        let accion = InstallAction::new("id-que-no-existe", "Etiqueta propia", "comando")
            .group(DOCKER_GROUP)
            .verb("Catapultar");
        let traducida = accion.translated("en");
        assert_eq!(traducida.label, "Etiqueta propia");
        // Un verbo fuera del vocabulario cerrado tampoco se inventa.
        assert_eq!(traducida.verb.as_deref(), Some("Catapultar"));
    }

    #[test]
    fn traducir_no_toca_el_id_ni_el_comando_ni_las_condiciones() {
        let original = buscar(
            &get_install_actions(&contexto("linux"), &Translator::new("es")),
            "pkg-docker",
        )
        .clone();
        let traducida = original.translated("en");
        assert_eq!(traducida.id, original.id);
        assert_eq!(traducida.command, original.command);
        assert_eq!(traducida.check_cmd, original.check_cmd);
        assert_eq!(traducida.shell, original.shell);
    }

    #[test]
    fn una_etiqueta_traducida_con_huecos_sin_datos_se_descarta_a_favor_de_la_generada() {
        // "action.pkg-docker.label" es "Install Docker ({source})": traducirla
        // aquí, sin el gestor de paquetes, dejaría "{source}" a la vista.
        let actions = get_install_actions(
            &InstallContext {
                pkg_manager: Some("pacman".to_string()),
                ..contexto("linux")
            },
            &Translator::new("en"),
        );
        let docker = buscar(&actions, "pkg-docker").translated("en");
        assert_eq!(docker.label, "Install Docker (pacman)");
        assert!(!docker.label.contains('{'));
    }

    #[test]
    fn reconocer_un_hueco_no_confunde_una_llave_suelta_de_powershell() {
        assert!(tiene_hueco("Instalar Docker ({source})"));
        assert!(tiene_hueco("{count} distros"));
        // Los scripts del catálogo llevan bloques de PowerShell con llaves.
        assert!(!tiene_hueco("if ($x) { Write-Host 'hola' }"));
        assert!(!tiene_hueco("sin llaves"));
        assert!(!tiene_hueco("{}"));
    }
}
