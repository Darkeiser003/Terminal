//! Preflight del runtime WebView2 en Windows.
//!
//! `WebView2Loader.dll` es únicamente el puente nativo; el motor Evergreen se
//! instala aparte en Windows. Windows 11 lo trae siempre y Windows 10 lo recibe
//! con sus actualizaciones; falta en LTSC, Server o imágenes recortadas. Los
//! paquetes ya no llevan el instalador offline de Microsoft (215 MB de los 223
//! que pesaba cada uno): si falta, se busca por este orden, antes de que Tauri
//! cree la primera ventana:
//!
//! 1. un instalador junto al ejecutable (equipos sin Internet: lo deja ahí el
//!    administrador), o el que lleva dentro una build `-WebView2 Offline`;
//! 2. el instalador ligero de Microsoft, descargado, si Ajustes lo permite
//!    (`webview2Missing`: preguntar, descargar o nada);
//! 3. un aviso nativo (sin WebView2 no hay interfaz web) para descargarlo,
//!    elegir un instalador, abrir la página de Microsoft o salir.
//!
//! Nada se ejecuta sin comprobar antes que su firma Authenticode es válida y de
//! Microsoft Corporation.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

use super::CREATE_NO_WINDOW;

const WEBVIEW2_CLIENT: &str =
    r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_CLIENT_WOW6432: &str =
    r"Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const BOOTSTRAPPER_NAMES: [&str; 3] = [
    "MicrosoftEdgeWebView2Setup.exe",
    "MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
    "WebView2Bootstrapper.exe",
];

/// El instalador «Evergreen» ligero de Microsoft (unos 2 MB), que descarga el
/// runtime. Es el mismo enlace que usa el instalador NSIS de Tauri.
pub const DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
pub const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
/// `wterminal --install-webview2 [ruta]`: instala sin ventana y sale.
pub const INSTALL_ARG: &str = "--install-webview2";
/// El instalador ligero ronda los 2 MB y el offline los 215; más de esto no es
/// un instalador de WebView2.
const MAX_DOWNLOAD_BYTES: u64 = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const SIGNER: &str = "Microsoft Corporation";

/// Qué hacer si falta el runtime (`webview2Missing` en Ajustes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingPolicy {
    Ask,
    Download,
    Never,
}

impl MissingPolicy {
    pub fn from_preference(value: &str) -> MissingPolicy {
        match value {
            "download" => MissingPolicy::Download,
            "never" => MissingPolicy::Never,
            _ => MissingPolicy::Ask,
        }
    }
}

type RegistryRoot = *mut std::ffi::c_void;

fn registered_runtime(root: RegistryRoot, path: &str, view: u32) -> bool {
    RegKey::predef(root)
        .open_subkey_with_flags(path, KEY_READ | view)
        .ok()
        .and_then(|key| key.get_value::<String, _>("pv").ok())
        .is_some_and(|version| !version.trim().is_empty())
}

fn runtime_is_registered() -> bool {
    [
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT),
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_WOW6432),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_WOW6432),
    ]
    .into_iter()
    .any(|(root, path)| {
        registered_runtime(root, path, KEY_WOW64_64KEY)
            || registered_runtime(root, path, KEY_WOW64_32KEY)
    })
}

/// Las pruebas no pueden desinstalar WebView2: con
/// `LTERMINAL_WEBVIEW2_FORCE_MISSING=1` (solo junto a `LTERMINAL_E2E_TESTING=1`)
/// la app lo da por ausente hasta que un instalador termina bien.
static INSTALLED_THIS_RUN: AtomicBool = AtomicBool::new(false);

fn forced_missing() -> bool {
    std::env::var("LTERMINAL_E2E_TESTING").as_deref() == Ok("1")
        && std::env::var("LTERMINAL_WEBVIEW2_FORCE_MISSING").as_deref() == Ok("1")
        && !INSTALLED_THIS_RUN.load(Ordering::Relaxed)
}

fn runtime_present() -> bool {
    !forced_missing() && runtime_is_registered()
}

/// Sin ventana: en las pruebas y en `--install-webview2` no se puede esperar a
/// que alguien pulse un botón.
fn dialogs_allowed() -> bool {
    std::env::var("LTERMINAL_E2E_TESTING").as_deref() != Ok("1")
        && std::env::var("LTERMINAL_WEBVIEW2_NO_DIALOG").as_deref() != Ok("1")
}

fn bootstrapper_path() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    BOOTSTRAPPER_NAMES
        .iter()
        .map(|name| exe_dir.join(name))
        .find(|path| path.is_file())
}

/// Una carpeta temporal propia que se borra al soltarla, con lo que haya
/// dentro: el instalador embebido o el descargado.
struct TemporaryInstaller {
    folder: PathBuf,
    path: PathBuf,
}

impl TemporaryInstaller {
    fn new(kind: &str) -> std::io::Result<Self> {
        let folder =
            std::env::temp_dir().join(format!("WTerminal-WebView2-{kind}-{}", std::process::id()));
        std::fs::create_dir_all(&folder)?;
        let path = folder.join(crate::single_file::WEBVIEW2_INSTALLER);
        Ok(Self { folder, path })
    }

    /// El que lleva dentro el portable de un solo archivo de una build offline.
    fn embedded() -> Option<Self> {
        let payload = crate::single_file::current()?;
        payload.entry(crate::single_file::WEBVIEW2_INSTALLER)?;
        let installer = Self::new("embebido").ok()?;
        match payload.extract(crate::single_file::WEBVIEW2_INSTALLER, &installer.path) {
            Ok(()) => Some(installer),
            Err(error) => {
                log_warn!(
                    "No se pudo preparar el instalador embebido de WebView2",
                    serde_json::json!({ "error": error.to_string() })
                );
                None
            }
        }
    }

    fn download() -> Result<Self, String> {
        let installer = Self::new("descarga").map_err(|error| error.to_string())?;
        let client = reqwest::blocking::Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .user_agent(concat!("WTerminal/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| error.to_string())?;
        let mut response = client
            .get(DOWNLOAD_URL)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
        {
            return Err(
                "la descarga no parece el instalador de WebView2 (demasiado grande)".into(),
            );
        }
        let mut file = std::fs::File::create(&installer.path).map_err(|error| error.to_string())?;
        let copied = std::io::copy(
            &mut std::io::Read::take(&mut response, MAX_DOWNLOAD_BYTES + 1),
            &mut file,
        )
        .map_err(|error| error.to_string())?;
        if copied > MAX_DOWNLOAD_BYTES {
            return Err(
                "la descarga no parece el instalador de WebView2 (demasiado grande)".into(),
            );
        }
        Ok(installer)
    }
}

impl Drop for TemporaryInstaller {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

/// Comprueba la firma y ejecuta el instalador en silencio. Si termina bien y el
/// runtime queda registrado, la app sigue.
fn install_from(installer: &Path) -> Result<(), String> {
    signature::require_microsoft(installer)?;
    log_info!(
        "WebView2 Runtime ausente; instalando",
        serde_json::json!({ "installer": installer.to_string_lossy() })
    );
    let status = Command::new(installer)
        .args(["/silent", "/install"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("no se pudo ejecutar el instalador: {error}"))?;
    if !status.success() {
        return Err(format!("el instalador terminó con {status}"));
    }
    INSTALLED_THIS_RUN.store(true, Ordering::Relaxed);
    if runtime_present() {
        Ok(())
    } else {
        Err("el instalador terminó, pero WebView2 sigue sin registrarse".into())
    }
}

fn install_downloaded() -> Result<(), String> {
    log_info!(
        "Descargando el instalador de WebView2 de Microsoft",
        serde_json::json!({ "url": DOWNLOAD_URL })
    );
    let installer = TemporaryInstaller::download()?;
    install_from(&installer.path)
}

/// Lo que no necesita red ni preguntar: junto al ejecutable o embebido.
fn install_local() -> Result<(), String> {
    if let Some(path) = bootstrapper_path() {
        return install_from(&path);
    }
    match TemporaryInstaller::embedded() {
        Some(installer) => install_from(&installer.path),
        None => Err("no hay instalador local".into()),
    }
}

fn record_failure(step: &str, error: &str) {
    log_warn!(
        "No se pudo instalar WebView2",
        serde_json::json!({ "step": step, "error": error })
    );
}

/// Cómo quedó WebView2 tras el preflight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    /// Sigue faltando: la app sigue como antes y Tauri informará al crear la
    /// ventana (sin aviso posible, por ejemplo en las pruebas).
    Missing,
    /// El usuario eligió «Salir» en el aviso.
    UserExit,
}

/// Comprueba WebView2 antes de que Tauri cree la primera ventana y, si falta,
/// lo consigue según `webview2Missing`.
pub fn ensure_runtime() -> Readiness {
    if runtime_present() || std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return Readiness::Ready;
    }
    if std::env::var("LTERMINAL_WEBVIEW2_AUTO_INSTALL").as_deref() == Ok("0") {
        log_warn!(
            "WebView2 Runtime ausente; instalación automática desactivada",
            serde_json::json!({})
        );
        return Readiness::Missing;
    }
    let policy = MissingPolicy::from_preference(&crate::preferences::current().webview2_missing);
    log_warn!(
        "WebView2 Runtime ausente",
        serde_json::json!({ "policy": format!("{policy:?}") })
    );
    let mut last_error = match install_local() {
        Ok(()) => return Readiness::Ready,
        Err(error) => {
            record_failure("local", &error);
            None
        }
    };
    if policy == MissingPolicy::Download {
        match install_downloaded() {
            Ok(()) => return Readiness::Ready,
            Err(error) => {
                record_failure("descarga", &error);
                last_error = Some(error);
            }
        }
    }
    if !dialogs_allowed() {
        return Readiness::Missing;
    }
    loop {
        let outcome = match dialog::ask(policy, last_error.as_deref()) {
            dialog::Choice::Download => install_downloaded(),
            dialog::Choice::Choose => match dialog::choose_installer() {
                Some(path) => install_from(&path),
                None => continue,
            },
            dialog::Choice::OpenPage => {
                dialog::open_page();
                continue;
            }
            dialog::Choice::Exit => return Readiness::UserExit,
        };
        match outcome {
            Ok(()) => return Readiness::Ready,
            Err(error) => {
                record_failure("aviso", &error);
                last_error = Some(error);
            }
        }
    }
}

/// `wterminal --install-webview2 [ruta]`: sin ventana. Con ruta, ese
/// instalador; sin ella, el de junto al ejecutable o el de Microsoft. Devuelve
/// el código de salida: 0 instalado (o ya estaba), 1 falló, 2 firma rechazada.
pub fn install_command(path: Option<&Path>) -> i32 {
    // La build de release es una app de ventana, sin consola propia: los
    // mensajes van a la consola desde la que se lanzó, si la hay. Desde el
    // Explorador o un instalador no hay ninguna y no pasa nada.
    unsafe {
        let _ = windows::Win32::System::Console::AttachConsole(
            windows::Win32::System::Console::ATTACH_PARENT_PROCESS,
        );
    }
    if path.is_none() && runtime_present() {
        eprintln!("WebView2 Runtime ya está instalado.");
        return 0;
    }
    let result = match path {
        Some(path) => install_from(path),
        None => install_local().or_else(|_| install_downloaded()),
    };
    match result {
        Ok(()) => {
            eprintln!("WebView2 Runtime instalado.");
            0
        }
        Err(error) => {
            record_failure("orden", &error);
            eprintln!("No se pudo instalar WebView2: {error}");
            if error.starts_with(signature::REJECTED) {
                2
            } else {
                1
            }
        }
    }
}

/// `None` si no se pidió `--install-webview2`; si se pidió, la ruta que lo
/// sigue, si la hay.
pub fn install_argument() -> Option<Option<PathBuf>> {
    install_argument_in(std::env::args())
}

fn install_argument_in(args: impl Iterator<Item = String>) -> Option<Option<PathBuf>> {
    let mut args = args.skip_while(|argument| argument != INSTALL_ARG);
    args.next()?;
    Some(
        args.next()
            .filter(|next| !next.starts_with("--"))
            .map(PathBuf::from),
    )
}

/// Firma Authenticode de un ejecutable: válida y de Microsoft Corporation.
pub mod signature {
    use std::path::Path;

    use windows::core::{GUID, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, HWND};
    use windows::Win32::Security::Cryptography::{
        CertGetNameStringW, CERT_CONTEXT, CERT_NAME_ISSUER_FLAG, CERT_NAME_SIMPLE_DISPLAY_TYPE,
    };
    use windows::Win32::Security::WinTrust::{
        WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
        WTD_UI_NONE,
    };

    /// Prefijo de los errores de firma, para que la orden devuelva su código.
    pub const REJECTED: &str = "firma rechazada";

    /// Quién firmó: el sujeto y el emisor del certificado del firmante.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Signer {
        pub subject: String,
        pub issuer: String,
    }

    /// La regla, aparte de Windows para poder probarla: el firmante es Microsoft
    /// Corporation y su certificado lo emitió una CA de Microsoft.
    pub fn is_microsoft(signer: &Signer) -> bool {
        signer.subject == super::SIGNER && signer.issuer.starts_with("Microsoft ")
    }

    pub fn require_microsoft(path: &Path) -> Result<(), String> {
        let signer = verified_signer(path)?;
        if is_microsoft(&signer) {
            Ok(())
        } else {
            Err(format!(
                "{REJECTED}: lo firmó «{}» ({}), no {}",
                signer.subject,
                signer.issuer,
                super::SIGNER
            ))
        }
    }

    fn name_of(cert: *const CERT_CONTEXT, flags: u32) -> String {
        let mut buffer = [0u16; 512];
        let length = unsafe {
            CertGetNameStringW(
                cert,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                flags,
                None,
                Some(&mut buffer),
            )
        } as usize;
        String::from_utf16_lossy(&buffer[..length.saturating_sub(1).min(buffer.len())])
    }

    /// `WinVerifyTrust` sin revocación: el instalador junto al ejecutable es
    /// justo para equipos sin red, donde consultar la revocación fallaría. La
    /// cadena sí tiene que llegar a una raíz de confianza del equipo.
    pub fn verified_signer(path: &Path) -> Result<Signer, String> {
        let wide = HSTRING::from(path.as_os_str());
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(wide.as_ptr()),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            ..Default::default()
        };
        let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status = unsafe {
            WinVerifyTrust(
                HWND::default(),
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut _,
            )
        };
        let signer = if status == 0 {
            unsafe {
                let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
                let signer = if provider.is_null() {
                    std::ptr::null_mut()
                } else {
                    WTHelperGetProvSignerFromChain(provider, 0, false, 0)
                };
                if signer.is_null() || (*signer).csCertChain == 0 {
                    None
                } else {
                    let cert = (*(*signer).pasCertChain).pCert;
                    Some(Signer {
                        subject: name_of(cert, 0),
                        issuer: name_of(cert, CERT_NAME_ISSUER_FLAG),
                    })
                }
            }
        } else {
            None
        };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe {
            WinVerifyTrust(
                HWND::default(),
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut _,
            );
        }
        let _: HANDLE = data.hWVTStateData;
        match signer {
            Some(signer) => Ok(signer),
            None if status == 0 => Err(format!("{REJECTED}: no se pudo leer el firmante")),
            None => Err(format!(
                "{REJECTED}: el archivo no tiene una firma válida (0x{:08X})",
                status as u32
            )),
        }
    }
}

/// El aviso nativo: sin WebView2 no hay interfaz web, así que es un
/// TaskDialog de Windows en el idioma de la app.
mod dialog {
    use std::path::PathBuf;

    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    use windows::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOG_BUTTON,
        TDF_ALLOW_DIALOG_CANCELLATION, TDF_USE_COMMAND_LINKS, TD_WARNING_ICON,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::MissingPolicy;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Choice {
        Download,
        Choose,
        OpenPage,
        Exit,
    }

    const DOWNLOAD: i32 = 100;
    const CHOOSE: i32 = 101;
    const PAGE: i32 = 102;
    const EXIT: i32 = 103;

    /// Los botones de cada caso. Con «nada» en Ajustes no se ofrece descargar.
    pub fn buttons(policy: MissingPolicy, retry: bool) -> Vec<(i32, &'static str, &'static str)> {
        let mut buttons = Vec::new();
        if policy != MissingPolicy::Never {
            buttons.push(if retry {
                (DOWNLOAD, "webview2.retry", "Reintentar la descarga")
            } else {
                (
                    DOWNLOAD,
                    "webview2.download",
                    "Descargarlo de Microsoft e instalarlo",
                )
            });
        }
        buttons.push((
            CHOOSE,
            "webview2.choose",
            "Elegir un instalador de WebView2…",
        ));
        buttons.push((PAGE, "webview2.page", "Abrir la página de Microsoft"));
        buttons.push((EXIT, "webview2.exit", "Salir"));
        buttons
    }

    pub fn ask(policy: MissingPolicy, error: Option<&str>) -> Choice {
        let t = crate::i18n::Translator::new(&crate::i18n::active_language());
        let title = HSTRING::from(t.t("webview2.title", "WTerminal necesita WebView2"));
        let instruction = HSTRING::from(t.t(
            "webview2.instruction",
            "Falta Microsoft Edge WebView2 Runtime",
        ));
        let mut content = t.t(
            "webview2.content",
            "WTerminal dibuja su ventana con WebView2, el componente de Microsoft que traen Windows 11 y Windows 10 actualizado. En este equipo no está instalado.",
        );
        if let Some(error) = error {
            content.push_str("\n\n");
            content.push_str(&t.tp(
                "webview2.failed",
                &[("error", error.to_string())],
                "No se pudo instalar: {error}",
            ));
        }
        let content = HSTRING::from(content);
        let labels: Vec<(i32, HSTRING)> = buttons(policy, error.is_some())
            .into_iter()
            .map(|(id, key, fallback)| (id, HSTRING::from(t.t(key, fallback))))
            .collect();
        let raw: Vec<TASKDIALOG_BUTTON> = labels
            .iter()
            .map(|(id, label)| TASKDIALOG_BUTTON {
                nButtonID: *id,
                pszButtonText: PCWSTR(label.as_ptr()),
            })
            .collect();
        let config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            dwFlags: TDF_USE_COMMAND_LINKS | TDF_ALLOW_DIALOG_CANCELLATION,
            pszWindowTitle: PCWSTR(title.as_ptr()),
            Anonymous1: TASKDIALOGCONFIG_0 {
                pszMainIcon: TD_WARNING_ICON,
            },
            pszMainInstruction: PCWSTR(instruction.as_ptr()),
            pszContent: PCWSTR(content.as_ptr()),
            cButtons: raw.len() as u32,
            pButtons: raw.as_ptr(),
            nDefaultButton: raw.first().map_or(EXIT, |button| button.nButtonID),
            ..Default::default()
        };
        let mut pressed = EXIT;
        if unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) }.is_err() {
            return Choice::Exit;
        }
        match pressed {
            DOWNLOAD => Choice::Download,
            CHOOSE => Choice::Choose,
            PAGE => Choice::OpenPage,
            _ => Choice::Exit,
        }
    }

    pub fn choose_installer() -> Option<PathBuf> {
        let t = crate::i18n::Translator::new(&crate::i18n::active_language());
        let title = HSTRING::from(t.t("webview2.choose", "Elegir un instalador de WebView2…"));
        let filter: Vec<u16> = format!(
            "{}\0*.exe\0\0",
            t.t("webview2.filter", "Instalador de WebView2 (*.exe)")
        )
        .encode_utf16()
        .collect();
        let mut file = vec![0u16; 1024];
        let mut dialog = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: HWND::default(),
            lpstrFilter: PCWSTR(filter.as_ptr()),
            lpstrFile: PWSTR(file.as_mut_ptr()),
            nMaxFile: file.len() as u32,
            lpstrTitle: PCWSTR(title.as_ptr()),
            Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
            ..Default::default()
        };
        if !unsafe { GetOpenFileNameW(&mut dialog) }.as_bool() {
            return None;
        }
        let end = file
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(file.len());
        Some(PathBuf::from(String::from_utf16_lossy(&file[..end])))
    }

    pub fn open_page() {
        let page = HSTRING::from(super::DOWNLOAD_PAGE);
        let open = HSTRING::from("open");
        unsafe {
            ShellExecuteW(
                None,
                PCWSTR(open.as_ptr()),
                PCWSTR(page.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn los_nombres_del_instalador_son_portables_y_explicitos() {
        assert!(BOOTSTRAPPER_NAMES.iter().all(|name| Path::new(name)
            .extension()
            .is_some_and(|extension| extension == "exe")));
        assert!(BOOTSTRAPPER_NAMES.contains(&crate::single_file::WEBVIEW2_INSTALLER));
    }

    #[test]
    fn las_claves_cubren_hklm_hkcu_y_las_dos_vistas() {
        assert!(WEBVIEW2_CLIENT.contains("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5"));
        assert!(WEBVIEW2_CLIENT_WOW6432.contains("WOW6432Node"));
    }

    #[test]
    fn la_preferencia_elige_que_hacer_y_por_defecto_pregunta() {
        assert_eq!(
            MissingPolicy::from_preference("download"),
            MissingPolicy::Download
        );
        assert_eq!(
            MissingPolicy::from_preference("never"),
            MissingPolicy::Never
        );
        assert_eq!(MissingPolicy::from_preference("ask"), MissingPolicy::Ask);
        assert_eq!(MissingPolicy::from_preference("raro"), MissingPolicy::Ask);
    }

    #[test]
    fn con_nada_en_ajustes_el_aviso_no_ofrece_descargar() {
        let ids = |policy, retry| -> Vec<i32> {
            dialog::buttons(policy, retry)
                .into_iter()
                .map(|button| button.0)
                .collect()
        };
        assert_eq!(ids(MissingPolicy::Never, false), vec![101, 102, 103]);
        assert_eq!(ids(MissingPolicy::Ask, false), vec![100, 101, 102, 103]);
        assert_eq!(
            dialog::buttons(MissingPolicy::Download, true)[0].1,
            "webview2.retry"
        );
    }

    #[test]
    fn solo_vale_un_firmante_de_microsoft_con_ca_de_microsoft() {
        let signer = |subject: &str, issuer: &str| signature::Signer {
            subject: subject.into(),
            issuer: issuer.into(),
        };
        assert!(signature::is_microsoft(&signer(
            "Microsoft Corporation",
            "Microsoft Code Signing PCA 2011"
        )));
        assert!(!signature::is_microsoft(&signer(
            "Microsoft Corporation",
            "Otra CA Cualquiera"
        )));
        assert!(!signature::is_microsoft(&signer(
            "Microsoft Corporation Falsa",
            "Microsoft Code Signing PCA 2011"
        )));
    }

    /// Un ejecutable de verdad firmado por Microsoft: el propio WebView2
    /// instalado. Si el equipo no lo tiene, no hay nada que comprobar.
    fn installed_webview2_executable() -> Option<std::path::PathBuf> {
        let root =
            std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application");
        std::fs::read_dir(&root)
            .ok()?
            .flatten()
            .map(|entry| entry.path().join("msedgewebview2.exe"))
            .find(|path| path.is_file())
    }

    #[test]
    fn la_firma_de_un_ejecutable_de_microsoft_se_acepta() {
        let Some(path) = installed_webview2_executable() else {
            return;
        };
        assert_eq!(signature::require_microsoft(&path), Ok(()));
    }

    #[test]
    fn un_ejecutable_sin_firmar_se_rechaza() {
        // El propio binario de pruebas no lleva firma.
        let path = std::env::current_exe().unwrap();
        let error = signature::require_microsoft(&path).unwrap_err();
        assert!(error.starts_with(signature::REJECTED), "{error}");
    }

    #[test]
    fn la_orden_lee_la_ruta_que_sigue_al_argumento() {
        let args = |list: &[&str]| install_argument_in(list.iter().map(|arg| arg.to_string()));
        assert_eq!(args(&["wterminal.exe"]), None);
        assert_eq!(args(&["wterminal.exe", INSTALL_ARG]), Some(None));
        assert_eq!(
            args(&["wterminal.exe", INSTALL_ARG, r"D:\WebView2.exe"]),
            Some(Some(std::path::PathBuf::from(r"D:\WebView2.exe")))
        );
        assert_eq!(args(&["wterminal.exe", INSTALL_ARG, "--otra"]), Some(None));
    }
}
