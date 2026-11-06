//! Cómo se actualiza la aplicación a sí misma.
//!
//! Módulo nuevo: la versión Electron no se actualizaba sola. Su release se
//! descargaba como la de cualquier otro proyecto anclado, a
//! `Documentos/<proyectos>/_releases/…`, y quedaban dos copias sin saber cuál
//! era la que se estaba ejecutando.
//!
//! ## Por qué hay que reiniciar
//!
//! Windows no deja sobrescribir un `.exe` en marcha, ni un `.dll` cargado. Lo
//! que sí deja es RENOMBRARLOS: el archivo abierto sigue vivo bajo su nombre
//! nuevo y el sitio queda libre para el archivo nuevo. Sobre eso se construye
//! todo lo de aquí:
//!
//!   1. se copia la versión nueva a `<instalación>/<nombre>.new`, sin tocar
//!      nada de lo que hay;
//!   2. solo cuando TODAS las copias han ido bien, se hacen los renombrados
//!      (`<nombre>` -> `<nombre>.old`, `<nombre>.new` -> `<nombre>`), que son
//!      rápidos y no pueden quedarse a medias por falta de disco;
//!   3. la app se reinicia; el proceso viejo muere y suelta los `.old`;
//!   4. el arranque siguiente los borra.
//!
//! El orden importa: copiar es lo lento y lo que puede fallar (disco lleno,
//! permisos, antivirus), y mientras se copia la instalación sigue entera. Si
//! algo falla ahí, se limpia y no ha pasado nada.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::platform::traits::HostPlatform;

use crate::install_dir;

/// Sufijo del archivo que se está reemplazando y sigue en uso.
const OLD_SUFFIX: &str = ".old";
/// Sufijo de la copia nueva mientras aún no ocupa su sitio.
const NEW_SUFFIX: &str = ".new";

/// Una versión comparable. Se queda con los números y descarta lo demás:
/// `v1.4.3`, `1.4.3` y `1.4.3-beta` dan los mismos tres números.
///
/// No es semver completo a propósito. Lo único que hay que responder es "¿la
/// publicada es más nueva que la que corre?", y para eso comparar los números
/// por orden basta. Tratar `1.4.3-beta` como igual a `1.4.3` es lo prudente:
/// ante la duda, no se ofrece una actualización que quizá sea la misma.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(Vec<u64>);

impl Version {
    pub fn parse(raw: &str) -> Option<Version> {
        let limpio = raw.trim().trim_start_matches(['v', 'V']);
        let numeros: Vec<u64> = limpio
            .split(['.', '-', '+', '_'])
            .map(|parte| {
                parte
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .take_while(|parte| !parte.is_empty())
            .filter_map(|parte| parte.parse().ok())
            .collect();
        (!numeros.is_empty()).then_some(Version(numeros))
    }

    /// Compara rellenando con ceros: `1.4` y `1.4.0` son la misma versión.
    pub fn is_newer_than(&self, other: &Version) -> bool {
        let largo = self.0.len().max(other.0.len());
        for indice in 0..largo {
            let mio = self.0.get(indice).copied().unwrap_or(0);
            let suyo = other.0.get(indice).copied().unwrap_or(0);
            if mio != suyo {
                return mio > suyo;
            }
        }
        false
    }
}

/// Cómo se distribuyó la copia que está corriendo, que decide qué adjunto de
/// la release la actualiza.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageKind {
    /// Carpeta unpacked: se actualiza con el `.zip`.
    WindowsFolder,
    /// Copia del instalador NSIS (tiene `uninstall.exe` al lado): se actualiza
    /// con el `-setup.exe`, que pide UAC para escribir en Archivos de programa
    /// y mantiene al día el desinstalador, su entrada del registro y los
    /// accesos directos. Con el `.zip` nada de eso cambiaba y, sin permisos de
    /// administrador, ni siquiera podía copiarse.
    WindowsInstalled,
    /// `WTerminal-<versión>-Portable.exe`: el archivo descargado es la
    /// versión nueva entera y sustituye al ejecutable, como un AppImage.
    WindowsSingleFile,
    LinuxAppImage,
    /// Instalado con el `.deb`: el binario está en `/usr` y es de `dpkg`. Se
    /// actualiza instalando el `.deb` nuevo con `apt-get` (vía `pkexec`), para
    /// que el gestor siga sabiendo qué versión hay y qué archivos son suyos.
    LinuxDeb,
    /// Lo mismo con el `.rpm` (`dnf`, `zypper` o `rpm -U`).
    LinuxRpm,
    /// La carpeta del `.tar.gz`, descomprimida donde sea: se actualiza como la
    /// carpeta de Windows, copiando encima.
    LinuxFolder,
}

impl PackageKind {
    pub fn current() -> Self {
        if !crate::platform::host().is_windows() {
            linux_current()
        } else if crate::single_file::is_single_file() {
            PackageKind::WindowsSingleFile
        } else if install_dir::current().is_some_and(|dir| is_installer_copy(&dir)) {
            PackageKind::WindowsInstalled
        } else {
            PackageKind::WindowsFolder
        }
    }

    /// El paquete es un único archivo que reemplaza al ejecutable, sin
    /// extraer nada.
    pub fn is_single_file(self) -> bool {
        matches!(
            self,
            PackageKind::WindowsSingleFile | PackageKind::LinuxAppImage
        )
    }

    /// La copia la instaló el sistema (el instalador NSIS, o `dpkg`/`rpm`): se
    /// actualiza ejecutando el paquete nuevo con permisos de administrador, no
    /// copiando archivos encima de algo que no es de la app.
    pub fn uses_system_installer(self) -> bool {
        matches!(
            self,
            PackageKind::WindowsInstalled | PackageKind::LinuxDeb | PackageKind::LinuxRpm
        )
    }

    fn is_linux(self) -> bool {
        matches!(
            self,
            PackageKind::LinuxAppImage
                | PackageKind::LinuxDeb
                | PackageKind::LinuxRpm
                | PackageKind::LinuxFolder
        )
    }
}

/// Se decide una vez por arranque: preguntar a `dpkg` o a `rpm` cuesta un
/// proceso, y la respuesta no cambia mientras la app corre.
fn linux_current() -> PackageKind {
    static KIND: std::sync::OnceLock<PackageKind> = std::sync::OnceLock::new();
    *KIND.get_or_init(|| {
        let exe = std::env::current_exe()
            .ok()
            .map(|exe| std::fs::canonicalize(&exe).unwrap_or(exe));
        linux_kind(
            install_dir::appimage_path().is_some(),
            exe.as_deref(),
            system_package_owns,
        )
    })
}

/// Cómo se distribuyó una copia Linux. El AppImage lo dice su runtime
/// (`$APPIMAGE`). Un `.deb` o un `.rpm` dejan el binario bajo `/usr` y su
/// gestor lo reclama; a los gestores solo se les pregunta por eso, así una
/// carpeta descomprimida en el home no lanza ningún proceso. Lo demás es la
/// carpeta del `.tar.gz`.
pub fn linux_kind(
    appimage: bool,
    exe: Option<&Path>,
    owned_by: impl Fn(&str, &Path) -> bool,
) -> PackageKind {
    if appimage {
        return PackageKind::LinuxAppImage;
    }
    let Some(exe) = exe else {
        return PackageKind::LinuxFolder;
    };
    if !exe.starts_with("/usr") || exe.starts_with("/usr/local") {
        PackageKind::LinuxFolder
    } else if owned_by("dpkg", exe) {
        PackageKind::LinuxDeb
    } else if owned_by("rpm", exe) {
        PackageKind::LinuxRpm
    } else {
        PackageKind::LinuxFolder
    }
}

/// `dpkg-query -S` o `rpm -qf`: si algún paquete instalado contiene el archivo.
fn system_package_owns(manager: &str, exe: &Path) -> bool {
    let path = exe.to_string_lossy();
    let path = path.as_ref();
    let (tool, args) = if manager == "dpkg" {
        ("dpkg-query", ["-S", path])
    } else {
        ("rpm", ["-qf", path])
    };
    crate::path_env::which(tool).is_some()
        && crate::process::run_with_timeout(tool, &args, std::time::Duration::from_secs(10))
            .is_some_and(|output| output.status.success())
}

/// La orden que instala el paquete nuevo encima del instalado, con `pkexec`
/// (el diálogo de contraseña del escritorio). `apt-get` resuelve las
/// dependencias de un `.deb` local; un `.rpm` va con `dnf`, con `zypper` en
/// openSUSE o, sin ninguno, con `rpm -U`. El paquete ya pasó el SHA-256 del
/// manifiesto firmado, por eso `zypper` puede aceptarlo sin firma GPG propia.
/// `None` si falta `pkexec` o el gestor: entonces se dice qué hacer a mano.
pub fn linux_package_command(
    kind: PackageKind,
    package: &Path,
    locate: impl Fn(&str) -> Option<PathBuf>,
) -> Option<Vec<String>> {
    let pkexec = locate("pkexec")?;
    let package = package.to_string_lossy().to_string();
    let candidates: &[(&str, &[&str])] = match kind {
        PackageKind::LinuxDeb => &[("apt-get", &["install", "-y"]), ("dpkg", &["-i"])],
        PackageKind::LinuxRpm => &[
            ("dnf", &["install", "-y"]),
            (
                "zypper",
                &["--non-interactive", "install", "--allow-unsigned-rpm"],
            ),
            ("rpm", &["-U"]),
        ],
        _ => return None,
    };
    candidates.iter().find_map(|(tool, args)| {
        let tool = locate(tool)?;
        Some(
            [
                pkexec.to_string_lossy().to_string(),
                tool.to_string_lossy().to_string(),
            ]
            .into_iter()
            .chain(args.iter().map(|arg| arg.to_string()))
            .chain(Some(package.clone()))
            .collect(),
        )
    })
}

/// La carpeta la creó el instalador NSIS: deja `uninstall.exe` junto al
/// ejecutable. La release desempaquetada y el portable no lo traen.
pub fn is_installer_copy(dir: &Path) -> bool {
    dir.join("uninstall.exe").is_file()
}

/// Los argumentos del instalador NSIS de Tauri para actualizar sin preguntar:
/// `/P` (pasivo: solo la barra de progreso), `/UPDATE` (conserva la
/// configuración y no reinstala WebView2) y `/R` (vuelve a abrir la app como
/// usuario normal al terminar).
pub const INSTALLER_UPDATE_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// Dónde descarga la copia instalada su instalador o paquete nuevo. No puede
/// ser junto al ejecutable (ni Archivos de programa ni `/usr` se escriben sin
/// ser administrador): es `%LOCALAPPDATA%\WTerminal\update` en Windows y
/// `$XDG_CACHE_HOME/lterminal/update` (o `~/.cache/…`) en Linux. `None` en una
/// build de desarrollo, igual que `install_dir::staging`.
pub fn installer_staging() -> Option<PathBuf> {
    install_dir::staging()?;
    let absolute = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    if crate::platform::host().is_windows() {
        return absolute("LOCALAPPDATA").map(|local| local.join("WTerminal").join("update"));
    }
    absolute("XDG_CACHE_HOME")
        .or_else(|| absolute("HOME").map(|home| home.join(".cache")))
        .map(|cache| cache.join("lterminal").join("update"))
}

/// La orden que se lanza con UAC para actualizar la copia instalada. Espera a
/// que esta app se cierre antes de abrir el instalador: el de Tauri se niega
/// a seguir (o la cierra a la fuerza) si la encuentra en marcha.
pub fn installer_launch_script(app_pid: u32, installer: &Path) -> String {
    let quoted = |text: &str| format!("'{}'", text.replace('\'', "''"));
    let args = INSTALLER_UPDATE_ARGS
        .iter()
        .map(|arg| quoted(arg))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "Wait-Process -Id {app_pid} -Timeout 60 -ErrorAction SilentlyContinue; \
         Start-Process -FilePath {} -ArgumentList {args}",
        quoted(&installer.to_string_lossy())
    )
}

/// El adjunto de una release que corresponde a ESTA copia.
pub fn asset_for_platform<'a>(names: &[&'a str]) -> Option<&'a str> {
    asset_for_package(names, PackageKind::current())
}

/// En Windows la carpeta se distribuye comprimida, el portable como un único
/// `-Portable.exe` y en Linux como AppImage, `.deb`, `.rpm` o `.tar.gz`, así
/// que se busca por el final del nombre. El instalador `-setup.exe` o el
/// código fuente que GitHub añade solo se descartan por no coincidir. En Linux
/// se descartan además los paquetes de otra arquitectura.
pub fn asset_for_package<'a>(names: &[&'a str], kind: PackageKind) -> Option<&'a str> {
    let (sufijo, excluir): (&str, &[&str]) = match kind {
        PackageKind::WindowsFolder => (".zip", &["source", "linux", "macos", "darwin"]),
        PackageKind::WindowsInstalled => (
            "-setup.exe",
            &["source", "portable", "linux", "macos", "darwin", "arm64"],
        ),
        PackageKind::WindowsSingleFile => (
            "-portable.exe",
            &["source", "setup", "linux", "macos", "darwin"],
        ),
        PackageKind::LinuxAppImage => (".appimage", &["source", "windows", "macos"]),
        PackageKind::LinuxDeb => (".deb", &["source", "windows", "macos"]),
        // `.src.rpm` es el paquete de código fuente, no la app.
        PackageKind::LinuxRpm => (".rpm", &["source", ".src.", "windows", "macos"]),
        PackageKind::LinuxFolder => (".tar.gz", &["source", "windows", "macos", "darwin"]),
    };
    let otra_arquitectura: &[&str] = if kind.is_linux() {
        foreign_arch_markers()
    } else {
        &[]
    };
    names
        .iter()
        .find(|name| {
            let bajo = name.to_lowercase();
            bajo.ends_with(sufijo)
                && !excluir
                    .iter()
                    .chain(otra_arquitectura)
                    .any(|malo| bajo.contains(malo))
        })
        .copied()
}

/// Cómo se nombran en los paquetes Linux las arquitecturas que NO son la de
/// esta copia (`x86_64`/`amd64` o `aarch64`/`arm64`), para no ofrecer un
/// paquete que no arrancaría.
fn foreign_arch_markers() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["x86_64", "amd64", "i386", "i686"]
    } else {
        &["aarch64", "arm64", "armhf", "armv7", "i386", "i686"]
    }
}

/// Lo que se sabe del estado de actualización, tal y como lo ve el frontend.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    /// La última publicada, si se ha llegado a consultar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub available: bool,
    /// Esta copia puede actualizarse sola. `false` en una build de desarrollo.
    pub can_self_update: bool,
    /// Dónde aterrizaría la actualización, para poder enseñarlo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// La carpeta que de verdad contiene los archivos, dentro de lo extraído.
///
/// Un `.zip` publicado puede traer los archivos en la raíz o dentro de una
/// única carpeta (`WTerminal-1.4.3/…`), según cómo se comprimiera. Se
/// desciende mientras solo haya una carpeta y nada más, para que las dos formas
/// funcionen sin que quien publique tenga que acordarse de cuál toca.
pub fn payload_root(staged: &Path) -> PathBuf {
    let mut actual = staged.to_path_buf();
    for _ in 0..4 {
        let Ok(entradas) = std::fs::read_dir(&actual) else {
            return actual;
        };
        let hijos: Vec<_> = entradas.filter_map(Result::ok).collect();
        match hijos.as_slice() {
            [unico]
                if std::fs::symlink_metadata(unico.path())
                    .is_ok_and(|metadata| metadata.is_dir()) =>
            {
                actual = unico.path();
            }
            _ => return actual,
        }
    }
    actual
}

/// Comprueba que lo descargado es de verdad esta aplicación antes de tocar
/// nada. Sin esto, un `.zip` equivocado dejaría la instalación llena de
/// archivos ajenos y sin el ejecutable.
pub fn verify_payload(root: &Path, binary_name: &str) -> Result<(), String> {
    verify_payload_as(root, binary_name, PackageKind::current())
}

fn verify_payload_as(root: &Path, binary_name: &str, kind: PackageKind) -> Result<(), String> {
    let binario = root.join(binary_name);
    if !binario.is_file() {
        return Err(format!(
            "Lo descargado no parece esta aplicación: no trae {binary_name}."
        ));
    }
    // El AppImage y el binario de la carpeta del `.tar.gz` son ejecutables
    // ELF: un archivo de texto o de otro sistema con el mismo nombre no pasa.
    if !crate::platform::host().is_windows()
        && (binary_name.to_ascii_lowercase().ends_with(".appimage")
            || kind == PackageKind::LinuxFolder)
    {
        let mut magic = [0u8; 4];
        let mut file = std::fs::File::open(&binario)
            .map_err(|error| format!("No se pudo leer el ejecutable nuevo: {error}"))?;
        std::io::Read::read_exact(&mut file, &mut magic)
            .map_err(|error| format!("El ejecutable nuevo está incompleto: {error}"))?;
        if magic != *b"\x7fELF" {
            return Err("La actualización Linux no es un ejecutable ELF válido.".into());
        }
    }
    if kind == PackageKind::WindowsSingleFile {
        // El portable no trae archivos sueltos: todo va dentro del `.exe`, y
        // se comprueba que esté completo antes de reemplazar el que corre.
        return crate::single_file::verify_executable(&binario);
    }
    if crate::platform::host().is_windows() {
        for recurso in windows_runtime_files() {
            if !root.join(recurso).is_file() {
                return Err(format!(
                    "La actualización Windows está incompleta: falta {recurso}."
                ));
            }
        }
    }
    Ok(())
}

/// Rechaza enlaces y tipos especiales después de extraer. La validación previa
/// de nombres evita traversal; esta segunda barrera evita que un archivo del
/// paquete pueda redirigir la copia hacia fuera del staging.
pub fn validate_payload_tree(root: &Path) -> Result<(), String> {
    const MAX_FILES: usize = 10_000;
    const MAX_BYTES: u64 = 512 * 1024 * 1024;
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("No se pudo inspeccionar la raíz del payload: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("La raíz del payload debe ser una carpeta real, no un enlace.".into());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("No se pudo fijar la raíz del payload: {error}"))?;
    let mut pending = vec![root.to_path_buf()];
    let mut files = 0usize;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("No se pudo leer el payload: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("No se pudo leer una entrada del payload: {error}"))?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("No se pudo inspeccionar el payload: {error}"))?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "El payload contiene una ruta fuera de su raíz.".to_string())?;
            if relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            }) {
                return Err("El payload contiene una ruta fuera de su raíz.".into());
            }
            if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
                return Err(format!(
                    "El payload contiene un tipo de archivo no permitido: {}",
                    relative.display()
                ));
            }
            let canonical = path
                .canonicalize()
                .map_err(|error| format!("No se pudo resolver el payload: {error}"))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(format!(
                    "El payload sale de su raíz: {}",
                    relative.display()
                ));
            }
            if metadata.is_dir() {
                pending.push(path);
            } else {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
                if files > MAX_FILES || bytes > MAX_BYTES {
                    return Err(
                        "El payload extraído supera los límites de archivos o tamaño.".into(),
                    );
                }
            }
        }
    }
    Ok(())
}

/// Todo lo que necesita una carpeta portable Windows después de una
/// actualización. El instalador y la build portable ya lo validan antes de
/// publicar; repetirlo aquí evita que una release incompleta rompa una copia
/// que funcionaba.
fn windows_runtime_files() -> [&'static str; 3] {
    ["conpty.dll", "OpenConsole.exe", "WebView2Loader.dll"]
}

/// Los archivos de la versión nueva, con su ruta relativa a la raíz.
fn staged_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut salida = Vec::new();
    let mut pendientes = vec![PathBuf::new()];
    while let Some(relativa) = pendientes.pop() {
        let dir = root.join(&relativa);
        let entradas = std::fs::read_dir(&dir)
            .map_err(|error| format!("No se pudo leer {}: {error}", dir.display()))?;
        for entrada in entradas.filter_map(Result::ok) {
            let hijo = relativa.join(entrada.file_name());
            if entrada.path().is_dir() {
                pendientes.push(hijo);
            } else {
                salida.push(hijo);
            }
        }
    }
    Ok(salida)
}

/// Aplica la actualización sobre la carpeta de instalación.
///
/// Después de esto la app tiene que reiniciarse: el proceso en marcha sigue
/// usando los archivos renombrados a `.old`, y hasta que muera no hay versión
/// nueva corriendo.
pub fn apply(root: &Path, install: &Path, binary_name: &str) -> Result<(), String> {
    apply_as(root, install, binary_name, PackageKind::current())
}

fn apply_as(
    root: &Path,
    install: &Path,
    binary_name: &str,
    kind: PackageKind,
) -> Result<(), String> {
    verify_payload_as(root, binary_name, kind)?;
    validate_payload_tree(root)?;
    let install = install
        .canonicalize()
        .map_err(|error| format!("No se pudo resolver la carpeta de instalación: {error}"))?;
    let install_metadata = std::fs::symlink_metadata(&install)
        .map_err(|error| format!("No se pudo inspeccionar la carpeta de instalación: {error}"))?;
    if install_metadata.file_type().is_symlink() || !install_metadata.is_dir() {
        return Err("La carpeta de instalación debe ser un directorio real.".into());
    }
    let archivos = staged_files(root)?;
    if archivos.is_empty() {
        return Err("La actualización descargada está vacía.".to_string());
    }

    // Fase 1: copiar. Es lo lento y lo que puede fallar; mientras tanto la
    // instalación sigue completa y en marcha.
    let mut copiados: Vec<PathBuf> = Vec::new();
    for relativa in &archivos {
        let padre_relativo = relativa.parent().unwrap_or_else(|| Path::new(""));
        let padre = match preparar_padre_instalacion(&install, padre_relativo) {
            Ok(padre) => padre,
            Err(error) => {
                limpiar(&copiados);
                return Err(error);
            }
        };
        let Some(nombre) = relativa.file_name() else {
            limpiar(&copiados);
            return Err(format!(
                "La ruta descargada no es un archivo: {}",
                relativa.display()
            ));
        };
        let destino = padre.join(añadir_sufijo(Path::new(nombre), NEW_SUFFIX));
        match std::fs::symlink_metadata(&destino) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                if let Err(error) = std::fs::remove_file(&destino) {
                    limpiar(&copiados);
                    return Err(format!(
                        "No se pudo retirar el temporal anterior {}: {error}",
                        destino.display()
                    ));
                }
            }
            Ok(_) => {
                limpiar(&copiados);
                return Err(format!(
                    "La ruta temporal no es un archivo seguro: {}",
                    destino.display()
                ));
            }
            Err(error) => {
                limpiar(&copiados);
                return Err(format!(
                    "No se pudo inspeccionar {}: {error}",
                    destino.display()
                ));
            }
        }
        if let Err(error) = copiar_archivo_nuevo(&root.join(relativa), &destino) {
            limpiar(&copiados);
            return Err(format!("No se pudo copiar {}: {error}", relativa.display()));
        }
        copiados.push(destino);
    }

    // Fase 2: renombrar. Un `.exe` o un `.dll` en uso no se puede sobrescribir
    // ni borrar, pero sí renombrar: por eso el viejo se aparta en vez de
    // eliminarse. Cada paso queda registrado para poder deshacer todos los
    // anteriores si el siguiente falla por antivirus, permisos o un bloqueo.
    let mut aplicados = Vec::new();
    for relativa in &archivos {
        let destino = install.join(relativa);
        let nuevo = install.join(añadir_sufijo(relativa, NEW_SUFFIX));
        let mut apartado_real = None;
        match std::fs::symlink_metadata(&destino) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                limpiar(&copiados);
                let rollback = rollback_aplicados(&mut aplicados);
                return Err(update_failure(
                    format!(
                        "La ruta de instalación no es un archivo regular: {}",
                        destino.display()
                    ),
                    rollback,
                ));
            }
            Ok(_) => {
                let apartado = install.join(añadir_sufijo(relativa, OLD_SUFFIX));
                // Un `.old` de una actualización anterior que no se pudo borrar
                // bloquearía el renombrado: se intenta quitar y, si no se deja, se
                // usa un nombre libre.
                let _ = std::fs::remove_file(&apartado);
                let apartado = if apartado.exists() {
                    install.join(añadir_sufijo(
                        relativa,
                        &format!(".{}{OLD_SUFFIX}", stamp()),
                    ))
                } else {
                    apartado
                };
                if let Err(error) = std::fs::rename(&destino, &apartado) {
                    limpiar(&copiados);
                    let rollback = rollback_aplicados(&mut aplicados);
                    return Err(update_failure(
                        format!("No se pudo apartar {}: {error}", relativa.display()),
                        rollback,
                    ));
                }
                apartado_real = Some(apartado);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                limpiar(&copiados);
                let rollback = rollback_aplicados(&mut aplicados);
                return Err(update_failure(
                    format!("No se pudo inspeccionar {}: {error}", destino.display()),
                    rollback,
                ));
            }
        }
        if let Err(error) = std::fs::rename(&nuevo, &destino) {
            let mut rollback = rollback_aplicados(&mut aplicados);
            if let Some(apartado) = apartado_real {
                if let Err(restore_error) = std::fs::rename(&apartado, &destino) {
                    rollback.push(format!(
                        "no se pudo restaurar {}: {restore_error}",
                        relativa.display()
                    ));
                }
            }
            limpiar(&copiados);
            return Err(update_failure(
                format!("No se pudo instalar {}: {error}", relativa.display()),
                rollback,
            ));
        }
        aplicados.push(Aplicado {
            destino,
            apartado: apartado_real,
        });
    }
    Ok(())
}

/// Recorre y crea las carpetas como entradas reales; no deja que la copia siga
/// un enlace ya presente dentro de la instalación.
fn preparar_padre_instalacion(install: &Path, relativa: &Path) -> Result<PathBuf, String> {
    let mut actual = install.to_path_buf();
    for componente in relativa.components() {
        let std::path::Component::Normal(nombre) = componente else {
            return Err(format!(
                "La ruta del payload no es relativa: {}",
                relativa.display()
            ));
        };
        actual.push(nombre);
        match std::fs::symlink_metadata(&actual) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!(
                    "La carpeta de instalación no es segura: {}",
                    actual.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(&actual) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!("No se pudo preparar {}: {error}", actual.display()));
                    }
                }
                let metadata = std::fs::symlink_metadata(&actual).map_err(|error| {
                    format!("No se pudo inspeccionar {}: {error}", actual.display())
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "La carpeta de instalación no es segura: {}",
                        actual.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "No se pudo inspeccionar {}: {error}",
                    actual.display()
                ));
            }
        }
        let canonica = actual
            .canonicalize()
            .map_err(|error| format!("No se pudo resolver {}: {error}", actual.display()))?;
        if !canonica.starts_with(install) {
            return Err(format!(
                "La carpeta de instalación sale de su raíz: {}",
                actual.display()
            ));
        }
        actual = canonica;
    }
    Ok(actual)
}

/// Crea el temporal con `create_new`: una carrera que plante un enlace entre
/// la inspección y la copia no puede hacer que se siga.
fn copiar_archivo_nuevo(origen: &Path, destino: &Path) -> std::io::Result<()> {
    let mut entrada = std::fs::File::open(origen)?;
    let permisos = entrada.metadata()?.permissions();
    let mut salida = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destino)?;
    let resultado = (|| {
        std::io::copy(&mut entrada, &mut salida)?;
        salida.set_permissions(permisos)?;
        std::io::Write::flush(&mut salida)
    })();
    drop(salida);
    if resultado.is_err() {
        let _ = std::fs::remove_file(destino);
    }
    resultado.map(|_| ())
}

struct Aplicado {
    destino: PathBuf,
    apartado: Option<PathBuf>,
}

fn rollback_aplicados(aplicados: &mut Vec<Aplicado>) -> Vec<String> {
    let mut errores = Vec::new();
    while let Some(aplicado) = aplicados.pop() {
        if aplicado.destino.exists() {
            if let Err(error) = std::fs::remove_file(&aplicado.destino) {
                errores.push(format!(
                    "no se pudo retirar {}: {error}",
                    aplicado.destino.display()
                ));
                continue;
            }
        }
        if let Some(apartado) = aplicado.apartado {
            if let Err(error) = std::fs::rename(&apartado, &aplicado.destino) {
                errores.push(format!(
                    "no se pudo restaurar {}: {error}",
                    aplicado.destino.display()
                ));
            }
        }
    }
    errores
}

fn update_failure(reason: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        return format!("{reason}; la instalación anterior se restauró");
    }
    format!(
        "{reason}; el rollback tuvo errores: {}",
        rollback_errors.join("; ")
    )
}

/// Marca de tiempo corta para desempatar nombres. No hace falta que sea única
/// en el universo: solo que no choque con el `.old` que sigue bloqueado.
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn añadir_sufijo(relativa: &Path, sufijo: &str) -> PathBuf {
    let mut nombre = relativa.as_os_str().to_os_string();
    nombre.push(sufijo);
    PathBuf::from(nombre)
}

fn limpiar(archivos: &[PathBuf]) {
    for archivo in archivos {
        let _ = std::fs::remove_file(archivo);
    }
}

/// Borra lo que dejó una actualización anterior. Se llama al arrancar, cuando
/// el proceso que bloqueaba los `.old` ya no existe.
///
/// Lo que no se deje borrar se queda para el arranque siguiente: no es un error
/// que merezca molestar a nadie.
pub fn cleanup(install: &Path) -> usize {
    let Ok(install) = install.canonicalize() else {
        return 0;
    };
    let mut archivos = vec![PathBuf::from(binary_name())];
    if crate::platform::host().is_windows() {
        archivos.extend(windows_runtime_files().into_iter().map(PathBuf::from));
    }
    archivos.sort();
    archivos.dedup();
    let borrados = cleanup_managed_backups(&install, &archivos);

    // La carpeta de preparación tampoco tiene sentido conservarla: lo que había
    // dentro ya está instalado.
    let staging = install.join(install_dir::STAGING_DIR);
    if let Ok(metadata) = std::fs::symlink_metadata(&staging) {
        if metadata.file_type().is_symlink() {
            let _ = std::fs::remove_file(&staging);
        } else if metadata.is_dir() {
            let _ = std::fs::remove_dir_all(&staging);
        } else {
            let _ = std::fs::remove_file(&staging);
        }
    }
    borrados
}

/// Limpia solo copias `.old` de rutas que pertenecen al paquete de LTerminal.
/// No busca recursivamente ni borra archivos ajenos con un sufijo parecido; las
/// carpetas intermedias se inspeccionan sin atravesar enlaces simbólicos.
fn cleanup_managed_backups(install: &Path, managed_files: &[PathBuf]) -> usize {
    let Ok(install) = install.canonicalize() else {
        return 0;
    };
    let mut borrados = 0;
    for relativa in managed_files {
        let Some(nombre) = relativa.file_name() else {
            continue;
        };
        let padre_relativo = relativa.parent().unwrap_or_else(|| Path::new(""));
        let Some(padre) = existing_install_parent(&install, padre_relativo) else {
            continue;
        };
        let backup = padre.join(añadir_sufijo(Path::new(nombre), OLD_SUFFIX));
        match std::fs::symlink_metadata(&backup) {
            Ok(metadata)
                if (metadata.file_type().is_symlink() || metadata.is_file())
                    && std::fs::remove_file(&backup).is_ok() =>
            {
                borrados += 1;
            }
            _ => {}
        }
    }
    borrados
}

fn existing_install_parent(install: &Path, relative: &Path) -> Option<PathBuf> {
    let mut actual = install.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return None;
        };
        actual.push(name);
        let metadata = std::fs::symlink_metadata(&actual).ok()?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return None;
        }
        actual = actual.canonicalize().ok()?;
        if !actual.starts_with(install) {
            return None;
        }
    }
    Some(actual)
}

/// El nombre del ejecutable de esta plataforma.
pub fn binary_name() -> String {
    // En un AppImage el ejecutable instalado es el propio archivo, no el
    // binario de dentro del montaje.
    if let Some(appimage) = install_dir::appimage_path() {
        if let Some(nombre) = appimage.file_name() {
            return nombre.to_string_lossy().to_string();
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| {
            if crate::platform::host().is_windows() {
                "wterminal.exe".to_string()
            } else {
                "lterminal".to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn escribir(ruta: &Path, contenido: &str) {
        if let Some(padre) = ruta.parent() {
            std::fs::create_dir_all(padre).unwrap();
        }
        std::fs::write(ruta, contenido).unwrap();
    }

    fn preparar_payload_windows(root: &Path) {
        if cfg!(windows) {
            for recurso in windows_runtime_files() {
                escribir(&root.join(recurso), "fixture");
            }
        }
    }

    #[test]
    fn una_version_se_lee_con_o_sin_la_uve_de_delante() {
        assert_eq!(Version::parse("v1.4.3"), Version::parse("1.4.3"));
        assert_eq!(Version::parse("  V2.0  "), Version::parse("2.0"));
        assert!(Version::parse("").is_none());
        assert!(Version::parse("sin-numeros").is_none());
    }

    #[test]
    fn se_compara_por_numeros_y_no_alfabeticamente() {
        // "1.10.0" > "1.9.0" es falso comparando textos, que es el fallo
        // clasico de estas comparaciones.
        let diez = Version::parse("1.10.0").unwrap();
        let nueve = Version::parse("1.9.0").unwrap();
        assert!(diez.is_newer_than(&nueve));
        assert!(!nueve.is_newer_than(&diez));
    }

    #[test]
    fn una_version_con_menos_tramos_se_completa_con_ceros() {
        let corta = Version::parse("1.4").unwrap();
        let larga = Version::parse("1.4.0").unwrap();
        assert!(!corta.is_newer_than(&larga));
        assert!(!larga.is_newer_than(&corta));
        assert!(Version::parse("1.4.1").unwrap().is_newer_than(&corta));
    }

    #[test]
    fn la_misma_version_no_se_ofrece_como_actualizacion() {
        let actual = Version::parse("1.4.3").unwrap();
        assert!(!actual.is_newer_than(&actual));
        // Y una preliminar de la misma version tampoco: ante la duda, no se
        // ofrece algo que quiza sea lo mismo que ya esta instalado.
        assert!(!Version::parse("1.4.3-beta").unwrap().is_newer_than(&actual));
    }

    #[test]
    fn de_una_release_se_elige_el_adjunto_de_esta_plataforma() {
        let adjuntos = [
            "WTerminal-Unpacked-1.4.3.zip",
            "LTerminal-1.4.3-x86_64.AppImage",
            "Source code (zip)",
        ];
        let elegido = asset_for_platform(&adjuntos).unwrap();
        if cfg!(windows) {
            assert_eq!(elegido, "WTerminal-Unpacked-1.4.3.zip");
        } else {
            assert_eq!(elegido, "LTerminal-1.4.3-x86_64.AppImage");
        }
    }

    #[test]
    fn cada_forma_de_distribucion_elige_su_propio_adjunto() {
        let adjuntos = [
            "WTerminal-1.4.3-x64-setup.exe",
            "WTerminal-1.4.3-Portable.exe",
            "WTerminal-Unpacked-1.4.3.zip",
            "LTerminal-1.4.3-x86_64.AppImage",
            "SHA256SUMS.txt",
        ];
        assert_eq!(
            asset_for_package(&adjuntos, PackageKind::WindowsFolder),
            Some("WTerminal-Unpacked-1.4.3.zip")
        );
        assert_eq!(
            asset_for_package(&adjuntos, PackageKind::WindowsSingleFile),
            Some("WTerminal-1.4.3-Portable.exe")
        );
        assert_eq!(
            asset_for_package(&adjuntos, PackageKind::LinuxAppImage),
            Some("LTerminal-1.4.3-x86_64.AppImage")
        );
        // Sin portable publicado, el portable no cae en el instalador.
        assert_eq!(
            asset_for_package(
                &[
                    "WTerminal-1.4.3-x64-setup.exe",
                    "WTerminal-Unpacked-1.4.3.zip"
                ],
                PackageKind::WindowsSingleFile
            ),
            None
        );
        assert!(PackageKind::WindowsSingleFile.is_single_file());
        assert!(!PackageKind::WindowsFolder.is_single_file());
        // La copia instalada se actualiza con el instalador, nunca con el zip
        // ni con el portable.
        assert_eq!(
            asset_for_package(&adjuntos, PackageKind::WindowsInstalled),
            Some("WTerminal-1.4.3-x64-setup.exe")
        );
        assert_eq!(
            asset_for_package(
                &[
                    "WTerminal-1.4.3-Portable.exe",
                    "WTerminal-Unpacked-1.4.3.zip"
                ],
                PackageKind::WindowsInstalled
            ),
            None
        );
        assert!(!PackageKind::WindowsInstalled.is_single_file());
    }

    #[test]
    fn cada_paquete_linux_elige_su_adjunto_y_su_arquitectura() {
        let adjuntos = [
            "WTerminal-Unpacked-1.4.3.zip",
            "WTerminal-1.4.3-x64-setup.exe",
            "LTerminal-1.4.3-aarch64.AppImage",
            "LTerminal-1.4.3-x86_64.AppImage",
            "LTerminal_1.4.3_arm64.deb",
            "LTerminal_1.4.3_amd64.deb",
            "LTerminal-1.4.3-1.src.rpm",
            "LTerminal-1.4.3-1.x86_64.rpm",
            "LTerminal-Unpacked-1.4.3-x86_64.tar.gz",
            "SHA256SUMS.txt",
        ];
        let elegido = |kind| asset_for_package(&adjuntos, kind);
        if cfg!(target_arch = "x86_64") {
            assert_eq!(
                elegido(PackageKind::LinuxAppImage),
                Some("LTerminal-1.4.3-x86_64.AppImage"),
                "el de otra arquitectura no se ofrece aunque vaya antes"
            );
            assert_eq!(
                elegido(PackageKind::LinuxDeb),
                Some("LTerminal_1.4.3_amd64.deb")
            );
            assert_eq!(
                elegido(PackageKind::LinuxRpm),
                Some("LTerminal-1.4.3-1.x86_64.rpm"),
                "el .src.rpm es código fuente"
            );
            assert_eq!(
                elegido(PackageKind::LinuxFolder),
                Some("LTerminal-Unpacked-1.4.3-x86_64.tar.gz")
            );
        }
        // Sin su paquete, una copia Linux no cae en el de otro formato.
        assert_eq!(
            asset_for_package(
                &[
                    "LTerminal-1.4.3-x86_64.AppImage",
                    "WTerminal-Unpacked-1.4.3.zip"
                ],
                PackageKind::LinuxDeb
            ),
            None
        );
        // El zip de Windows no filtra arquitecturas Linux ni coge el tar.gz.
        assert_eq!(
            elegido(PackageKind::WindowsFolder),
            Some("WTerminal-Unpacked-1.4.3.zip")
        );
        for kind in [
            PackageKind::WindowsInstalled,
            PackageKind::LinuxDeb,
            PackageKind::LinuxRpm,
        ] {
            assert!(kind.uses_system_installer(), "{kind:?}");
            assert!(!kind.is_single_file(), "{kind:?}");
        }
        for kind in [
            PackageKind::WindowsFolder,
            PackageKind::WindowsSingleFile,
            PackageKind::LinuxAppImage,
            PackageKind::LinuxFolder,
        ] {
            assert!(!kind.uses_system_installer(), "{kind:?}");
        }
        assert!(!PackageKind::LinuxFolder.is_single_file());
    }

    #[test]
    fn una_copia_linux_se_reconoce_por_su_appimage_su_gestor_o_su_carpeta() {
        let preguntas = std::cell::RefCell::new(Vec::new());
        let gestor = |dueño: &'static str| {
            let preguntas = &preguntas;
            move |manager: &str, _: &Path| {
                preguntas.borrow_mut().push(manager.to_string());
                manager == dueño
            }
        };
        let usr = Path::new("/usr/bin/lterminal");
        assert_eq!(
            linux_kind(true, Some(usr), gestor("dpkg")),
            PackageKind::LinuxAppImage
        );
        assert_eq!(
            linux_kind(false, Some(usr), gestor("dpkg")),
            PackageKind::LinuxDeb
        );
        assert_eq!(
            linux_kind(false, Some(usr), gestor("rpm")),
            PackageKind::LinuxRpm
        );
        assert_eq!(
            linux_kind(false, Some(usr), gestor("ninguno")),
            PackageKind::LinuxFolder,
            "en /usr pero de nadie: se copió a mano"
        );
        preguntas.borrow_mut().clear();
        for carpeta in [
            "/home/romen/LTerminal-1.4.3/lterminal",
            "/opt/LTerminal/lterminal",
            "/usr/local/bin/lterminal",
        ] {
            assert_eq!(
                linux_kind(false, Some(Path::new(carpeta)), gestor("dpkg")),
                PackageKind::LinuxFolder,
                "{carpeta}"
            );
        }
        assert!(
            preguntas.borrow().is_empty(),
            "fuera de /usr no se lanza ni dpkg ni rpm"
        );
        assert_eq!(
            linux_kind(false, None, gestor("dpkg")),
            PackageKind::LinuxFolder
        );
    }

    #[test]
    fn el_paquete_linux_se_instala_con_pkexec_y_el_gestor_que_haya() {
        let paquete = Path::new("/home/romen/.cache/lterminal/update/LTerminal_1.4.3_amd64.deb");
        let con = |herramientas: &'static [&'static str]| {
            move |tool: &str| {
                herramientas
                    .contains(&tool)
                    .then(|| PathBuf::from(format!("/usr/bin/{tool}")))
            }
        };
        let texto = |orden: Option<Vec<String>>| orden.map(|orden| orden.join(" "));
        assert_eq!(
            texto(linux_package_command(
                PackageKind::LinuxDeb,
                paquete,
                con(&["pkexec", "apt-get", "dpkg"])
            ))
            .as_deref(),
            Some("/usr/bin/pkexec /usr/bin/apt-get install -y /home/romen/.cache/lterminal/update/LTerminal_1.4.3_amd64.deb")
        );
        assert!(texto(linux_package_command(
            PackageKind::LinuxDeb,
            paquete,
            con(&["pkexec", "dpkg"])
        ))
        .is_some_and(|orden| orden.starts_with("/usr/bin/pkexec /usr/bin/dpkg -i ")));
        let rpm = Path::new("/tmp/LTerminal-1.4.3-1.x86_64.rpm");
        assert!(texto(linux_package_command(
            PackageKind::LinuxRpm,
            rpm,
            con(&["pkexec", "dnf", "rpm"])
        ))
        .is_some_and(|orden| orden.contains("/usr/bin/dnf install -y ")));
        assert!(texto(linux_package_command(
            PackageKind::LinuxRpm,
            rpm,
            con(&["pkexec", "zypper", "rpm"])
        ))
        .is_some_and(|orden| orden.contains("--allow-unsigned-rpm")));
        // Sin pkexec, sin gestor o con un tipo que no es un paquete: a mano.
        assert_eq!(
            linux_package_command(PackageKind::LinuxDeb, paquete, con(&["apt-get"])),
            None
        );
        assert_eq!(
            linux_package_command(PackageKind::LinuxRpm, rpm, con(&["pkexec", "apt-get"])),
            None
        );
        assert_eq!(
            linux_package_command(
                PackageKind::LinuxFolder,
                paquete,
                con(&["pkexec", "apt-get"])
            ),
            None
        );
    }

    #[test]
    fn la_copia_del_instalador_se_reconoce_por_su_desinstalador() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_installer_copy(dir.path()));
        std::fs::write(dir.path().join("uninstall.exe"), b"MZ").unwrap();
        assert!(is_installer_copy(dir.path()));
        // Una carpeta llamada así no cuenta: tiene que ser un archivo.
        let otra = tempfile::tempdir().unwrap();
        std::fs::create_dir(otra.path().join("uninstall.exe")).unwrap();
        assert!(!is_installer_copy(otra.path()));
    }

    #[test]
    fn el_instalador_se_abre_cuando_la_app_ha_cerrado_y_en_modo_pasivo() {
        let script = installer_launch_script(
            4321,
            Path::new(
                r"C:\Users\O'Brien\AppData\Local\WTerminal\update\WTerminal-1.4.3-x64-setup.exe",
            ),
        );
        assert!(script.starts_with("Wait-Process -Id 4321 "));
        assert!(script.contains(r"-FilePath 'C:\Users\O''Brien\AppData"));
        assert!(script.ends_with("-ArgumentList '/P','/UPDATE','/R'"));
    }

    #[test]
    fn el_codigo_fuente_que_anade_github_no_se_confunde_con_la_aplicacion() {
        // GitHub adjunta siempre un "Source code (zip)": en Windows termina en
        // .zip igual que el paquete de verdad.
        assert!(asset_for_platform(&["Source code (zip)", "source-1.4.3.zip"]).is_none());
    }

    #[test]
    fn una_release_sin_adjunto_para_esta_plataforma_no_devuelve_nada() {
        assert!(asset_for_platform(&["notas.txt", "checksums.sha256"]).is_none());
    }

    #[test]
    fn se_desciende_hasta_la_carpeta_que_de_verdad_trae_los_archivos() {
        let dir = tempfile::tempdir().unwrap();
        // Un zip comprimido "con carpeta dentro".
        escribir(&dir.path().join("WTerminal-1.4.3/app.exe"), "x");
        escribir(&dir.path().join("WTerminal-1.4.3/conpty.dll"), "y");
        let raiz = payload_root(dir.path());
        assert!(raiz.join("app.exe").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn no_se_sigue_un_enlace_simbolico_como_raiz_del_payload() {
        use std::os::unix::fs::symlink;

        let staged = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        escribir(&outside.path().join("app.exe"), "fuera del staging");
        symlink(outside.path(), staged.path().join("payload")).unwrap();

        // La raíz se queda en staging para que la segunda barrera vea el
        // enlace y rechace el árbol completo; nunca debe devolver la carpeta
        // externa como si fuera parte de la release.
        assert_eq!(payload_root(staged.path()), staged.path());
        assert!(validate_payload_tree(staged.path()).is_err());
    }

    #[test]
    fn el_archivo_descargado_no_puede_acabar_junto_al_ejecutable() {
        // Si la descarga y lo extraido compartieran carpeta, `payload_root` se
        // quedaria en ella (tiene mas de un hijo) y el .zip contaria como un
        // archivo mas de la version nueva: acabaria copiado junto al .exe. Por
        // eso se extrae en su propia subcarpeta.
        let dir = tempfile::tempdir().unwrap();
        escribir(&dir.path().join("WTerminal-1.4.3.zip"), "zip");
        escribir(&dir.path().join("payload/app.exe"), "nuevo");

        // Mezclados, el zip entra en el reparto.
        assert_eq!(payload_root(dir.path()), dir.path());
        assert_eq!(staged_files(dir.path()).unwrap().len(), 2);

        // Separados, solo entran los archivos de la version nueva.
        let raiz = payload_root(&dir.path().join("payload"));
        assert_eq!(staged_files(&raiz).unwrap().len(), 1);
    }

    #[test]
    fn un_paquete_sin_carpeta_intermedia_se_usa_tal_cual() {
        let dir = tempfile::tempdir().unwrap();
        escribir(&dir.path().join("app.exe"), "x");
        escribir(&dir.path().join("conpty.dll"), "y");
        assert_eq!(payload_root(dir.path()), dir.path());
    }

    #[test]
    fn no_se_toca_nada_si_lo_descargado_no_trae_el_ejecutable() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("otra-cosa.exe"), "nuevo");
        escribir(&install.path().join("app.exe"), "original");

        let error = apply(staged.path(), install.path(), "app.exe").unwrap_err();
        assert!(error.contains("no parece esta aplicación"));
        // La instalación sigue intacta.
        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe")).unwrap(),
            "original"
        );
    }

    #[test]
    fn aplicar_reemplaza_los_archivos_y_aparta_los_viejos() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        preparar_payload_windows(staged.path());
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&staged.path().join("conpty.dll"), "dll-nueva");
        escribir(&install.path().join("app.exe"), "viejo");
        escribir(
            &install.path().join("app.exe.new"),
            "temporal incompleto anterior",
        );
        escribir(&install.path().join("conpty.dll"), "dll-vieja");

        apply(staged.path(), install.path(), "app.exe").unwrap();

        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe")).unwrap(),
            "nuevo"
        );
        // El viejo no se borra: en Windows sigue en uso por el proceso vivo.
        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe.old")).unwrap(),
            "viejo"
        );
    }

    #[test]
    fn el_portable_de_un_solo_archivo_solo_reemplaza_su_ejecutable() {
        // El portable puede vivir en Descargas junto a archivos ajenos: la
        // actualización trae un único `-Portable.exe` y no toca nada más.
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        let nombre = "WTerminal-1.0.0-Portable.exe";
        std::fs::write(
            staged.path().join(nombre),
            portable_de_prueba(&[("conpty.dll", b"dll"), ("OpenConsole.exe", b"host")]),
        )
        .unwrap();
        escribir(&install.path().join(nombre), "viejo");
        escribir(&install.path().join("documento.txt"), "del usuario");
        escribir(&install.path().join("conpty.dll"), "ajeno");

        apply_as(
            staged.path(),
            install.path(),
            nombre,
            PackageKind::WindowsSingleFile,
        )
        .unwrap();

        let nuevo = std::fs::read(install.path().join(nombre)).unwrap();
        assert!(nuevo.starts_with(b"MZ") && nuevo.ends_with(crate::single_file::MAGIC));
        assert_eq!(
            std::fs::read_to_string(install.path().join(format!("{nombre}.old"))).unwrap(),
            "viejo"
        );
        assert_eq!(
            std::fs::read_to_string(install.path().join("documento.txt")).unwrap(),
            "del usuario"
        );
        assert_eq!(
            std::fs::read_to_string(install.path().join("conpty.dll")).unwrap(),
            "ajeno"
        );
    }

    #[test]
    fn un_portable_incompleto_no_reemplaza_al_que_corre() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        let nombre = "WTerminal-1.0.0-Portable.exe";
        // Sin OpenConsole.exe dentro, o un ejecutable normal de la carpeta.
        std::fs::write(
            staged.path().join(nombre),
            portable_de_prueba(&[("conpty.dll", b"dll")]),
        )
        .unwrap();
        escribir(&install.path().join(nombre), "viejo");
        assert!(apply_as(
            staged.path(),
            install.path(),
            nombre,
            PackageKind::WindowsSingleFile
        )
        .unwrap_err()
        .contains("OpenConsole.exe"));
        escribir(&staged.path().join(nombre), "MZ normal");
        assert!(apply_as(
            staged.path(),
            install.path(),
            nombre,
            PackageKind::WindowsSingleFile
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(install.path().join(nombre)).unwrap(),
            "viejo"
        );
        assert!(!install.path().join(format!("{nombre}.old")).exists());
    }

    /// Un portable mínimo con el formato de `scripts/create-single-file-portable.mjs`.
    fn portable_de_prueba(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = b"MZ".to_vec();
        let payload_start = output.len() as u64;
        let mut entries = Vec::new();
        for (name, content) in files {
            let hash = ring::digest::digest(&ring::digest::SHA256, content);
            entries.push(serde_json::json!({
                "name": name,
                "offset": output.len() as u64,
                "size": content.len() as u64,
                "sha256": hash.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            }));
            output.extend_from_slice(content);
        }
        let index =
            serde_json::to_vec(&serde_json::json!({ "format": 1, "files": entries })).unwrap();
        let index_offset = output.len() as u64;
        output.extend_from_slice(&index);
        output.extend_from_slice(&payload_start.to_le_bytes());
        output.extend_from_slice(&index_offset.to_le_bytes());
        output.extend_from_slice(&(index.len() as u64).to_le_bytes());
        output.extend_from_slice(crate::single_file::MAGIC);
        output
    }

    #[cfg(unix)]
    #[test]
    fn no_sigue_un_enlace_temporal_new_que_apunta_fuera_de_la_instalacion() {
        use std::os::unix::fs::symlink;

        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&install.path().join("app.exe"), "original");
        escribir(&outside.path().join("objetivo"), "no tocar");
        symlink(
            outside.path().join("objetivo"),
            install.path().join("app.exe.new"),
        )
        .unwrap();

        assert!(apply(staged.path(), install.path(), "app.exe").is_err());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("objetivo")).unwrap(),
            "no tocar"
        );
        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe")).unwrap(),
            "original"
        );
        assert!(
            std::fs::symlink_metadata(install.path().join("app.exe.new"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn no_copia_por_una_carpeta_de_instalacion_enlazada_hacia_fuera() {
        use std::os::unix::fs::symlink;

        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&staged.path().join("scripts/evil.txt"), "nuevo fuera");
        escribir(&install.path().join("app.exe"), "original");
        symlink(outside.path(), install.path().join("scripts")).unwrap();

        assert!(apply(staged.path(), install.path(), "app.exe").is_err());
        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe")).unwrap(),
            "original"
        );
        assert!(!outside.path().join("evil.txt.new").exists());
        assert!(!outside.path().join("evil.txt").exists());
    }

    #[test]
    fn un_archivo_nuevo_que_no_existia_se_instala_sin_apartar_nada() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        preparar_payload_windows(staged.path());
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&staged.path().join("locales/es.json"), "{}");
        escribir(&install.path().join("app.exe"), "viejo");

        apply(staged.path(), install.path(), "app.exe").unwrap();

        assert!(install.path().join("locales/es.json").is_file());
        assert!(!install.path().join("locales/es.json.old").exists());
    }

    #[test]
    fn no_queda_ningun_archivo_a_medias_cuando_todo_va_bien() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        preparar_payload_windows(staged.path());
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&install.path().join("app.exe"), "viejo");

        apply(staged.path(), install.path(), "app.exe").unwrap();

        let restos: Vec<String> = std::fs::read_dir(install.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|nombre| nombre.ends_with(NEW_SUFFIX))
            .collect();
        assert!(restos.is_empty(), "quedaron copias a medias: {restos:?}");
    }

    #[test]
    fn el_rollback_restituye_los_archivos_anteriores_en_orden_inverso() {
        let install = tempfile::tempdir().unwrap();
        let destination = install.path().join("app.exe");
        let backup = install.path().join("app.exe.old");
        escribir(&backup, "viejo");
        escribir(&destination, "nuevo");

        let mut aplicados = vec![Aplicado {
            destino: destination.clone(),
            apartado: Some(backup.clone()),
        }];
        assert!(rollback_aplicados(&mut aplicados).is_empty());
        assert_eq!(std::fs::read_to_string(destination).unwrap(), "viejo");
        assert!(!backup.exists());
    }

    #[test]
    fn el_arranque_borra_lo_que_dejo_la_actualizacion_anterior() {
        let install = tempfile::tempdir().unwrap();
        escribir(&install.path().join("app.exe"), "actual");
        let executable = PathBuf::from(binary_name());
        let backup = install.path().join(añadir_sufijo(&executable, OLD_SUFFIX));
        escribir(&backup, "anterior");
        // Una ruta que no pertenece al paquete no se elimina por compartir el
        // sufijo: la limpieza no debe barrer datos propios del usuario.
        escribir(&install.path().join("archivo-del-usuario.old"), "conservar");
        escribir(
            &install
                .path()
                .join(install_dir::STAGING_DIR)
                .join("app.exe"),
            "descargado",
        );

        assert_eq!(cleanup(install.path()), 1);
        assert!(!backup.exists());
        assert!(install.path().join("archivo-del-usuario.old").exists());
        assert!(!install.path().join(install_dir::STAGING_DIR).exists());
        // Y no se lleva por delante lo que está en uso.
        assert!(install.path().join("app.exe").is_file());
    }

    #[test]
    fn la_limpieza_quita_respaldos_anidados_del_paquete_y_conserva_archivos_ajenos() {
        let install = tempfile::tempdir().unwrap();
        let managed = [PathBuf::from("wterminal.exe"), PathBuf::from("conpty.dll")];
        escribir(&install.path().join("wterminal.exe.old"), "anterior");
        escribir(&install.path().join("conpty.dll.old"), "anterior");
        escribir(&install.path().join("scripts/mi-script.old"), "conservar");

        assert_eq!(cleanup_managed_backups(install.path(), &managed), 2);
        assert!(!install.path().join("wterminal.exe.old").exists());
        assert!(!install.path().join("conpty.dll.old").exists());
        assert!(install.path().join("scripts/mi-script.old").exists());
    }

    #[cfg(unix)]
    #[test]
    fn la_limpieza_no_sigue_carpetas_enlazadas_fuera_de_la_instalacion() {
        use std::os::unix::fs::symlink;

        let install = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        escribir(&outside.path().join("conpty.dll.old"), "no eliminar");
        symlink(outside.path(), install.path().join("scripts")).unwrap();
        let managed = [PathBuf::from("scripts/conpty.dll")];

        assert_eq!(cleanup_managed_backups(install.path(), &managed), 0);
        assert_eq!(
            std::fs::read_to_string(outside.path().join("conpty.dll.old")).unwrap(),
            "no eliminar"
        );
    }

    #[test]
    fn limpiar_una_carpeta_sin_restos_no_es_un_error() {
        let install = tempfile::tempdir().unwrap();
        escribir(&install.path().join("app.exe"), "actual");
        assert_eq!(cleanup(install.path()), 0);
        assert!(install.path().join("app.exe").is_file());
    }
}
