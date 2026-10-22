//! Token efectivo de WTerminal y elevación bajo demanda.
//!
//! Cuando hace falta ser administrador WTerminal se relanza con UAC:
//! «Reiniciar como administrador» en Ajustes, al arrancar si el usuario eligió
//! «Iniciar siempre como administrador», o Windows lo eleva si el usuario puso
//! la marca RUNASADMIN desde Ajustes. Para volver atrás, `run_unelevated`
//! relanza con el token del Explorador, que no está elevado. NSudo, que exige un proceso
//! padre elevado (sin él termina con -1), se abre a través de gsudo o del sudo
//! de Windows en modo «en línea» si están disponibles: piden el UAC y la shell
//! elevada queda dentro de la misma pestaña, sin elevar el resto de la app.

use std::path::{Path, PathBuf};

#[link(name = "shell32")]
extern "system" {
    fn IsUserAnAdmin() -> i32;
    fn ShellExecuteW(
        hwnd: *mut core::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

/// Devuelve si el proceso actual tiene un token administrativo efectivo.
pub fn is_process_elevated() -> bool {
    // IsUserAnAdmin consulta el token efectivo: para un administrador sujeto
    // a UAC devuelve falso hasta que Windows inicia la aplicación elevada.
    unsafe { IsUserAnAdmin() != 0 }
}

/// Modo del sudo integrado de Windows 11 (`HKLM\SOFTWARE\Microsoft\Windows\
/// CurrentVersion\Sudo`, valor `Enabled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsSudo {
    /// No existe `sudo.exe` (Windows anterior a 24H2).
    Missing,
    Disabled,
    /// «En una ventana nueva»: abre otra consola, no sirve para una pestaña.
    NewWindow,
    /// «Con la entrada deshabilitada»: no sirve para una shell interactiva.
    InputDisabled,
    /// «En línea»: el proceso elevado usa la misma consola.
    Inline,
}

impl WindowsSudo {
    pub fn from_registry(value: Option<u32>, executable_present: bool) -> WindowsSudo {
        if !executable_present {
            return WindowsSudo::Missing;
        }
        match value {
            Some(1) => WindowsSudo::NewWindow,
            Some(2) => WindowsSudo::InputDisabled,
            Some(3) => WindowsSudo::Inline,
            _ => WindowsSudo::Disabled,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WindowsSudo::Missing => "missing",
            WindowsSudo::Disabled => "disabled",
            WindowsSudo::NewWindow => "new-window",
            WindowsSudo::InputDisabled => "input-disabled",
            WindowsSudo::Inline => "inline",
        }
    }
}

pub fn windows_sudo_path() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("sudo.exe")
}

pub fn windows_sudo() -> WindowsSudo {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let value = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo")
        .and_then(|key| key.get_value::<u32, _>("Enabled"))
        .ok();
    WindowsSudo::from_registry(value, windows_sudo_path().is_file())
}

pub fn gsudo_path() -> Option<PathBuf> {
    crate::path_env::which("gsudo")
}

/// Un argumento de línea de órdenes de Windows con las reglas de
/// `CommandLineToArgvW`: comillas si hace falta, y las barras invertidas que
/// preceden a una comilla (o al cierre) se duplican.
pub fn quote_windows_arg(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_string();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0usize;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            other => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(other);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Lanza `executable` con UAC («runas»). Vuelve en cuanto Windows lo arranca
/// o el usuario cancela el aviso; un error en ese caso deja todo como estaba.
pub fn run_elevated(
    executable: &Path,
    arguments: &[String],
    directory: &Path,
) -> Result<(), String> {
    let parameters = arguments
        .iter()
        .map(|argument| quote_windows_arg(argument))
        .collect::<Vec<_>>()
        .join(" ");
    let operation = wide("runas");
    let file = wide(&executable.to_string_lossy());
    let parameters = wide(&parameters);
    let directory = wide(&directory.to_string_lossy());
    // SW_SHOWNORMAL. Un resultado mayor que 32 es éxito; 5 (acceso denegado)
    // es lo que devuelve Windows cuando el usuario rechaza el UAC.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            directory.as_ptr(),
            1,
        )
    };
    match result {
        code if code > 32 => Ok(()),
        5 => Err("Se canceló el aviso de permisos de administrador.".to_string()),
        code => Err(format!(
            "Windows no pudo iniciar el proceso como administrador (código {code})."
        )),
    }
}

type Handle = *mut core::ffi::c_void;

#[link(name = "user32")]
extern "system" {
    fn GetShellWindow() -> Handle;
    fn GetWindowThreadProcessId(window: Handle, process_id: *mut u32) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn DuplicateTokenEx(
        existing: Handle,
        access: u32,
        attributes: *mut core::ffi::c_void,
        impersonation_level: i32,
        token_type: i32,
        new_token: *mut Handle,
    ) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: i32,
        information: *mut core::ffi::c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
    fn CreateProcessWithTokenW(
        token: Handle,
        logon_flags: u32,
        application: *const u16,
        command_line: *mut u16,
        creation_flags: u32,
        environment: *mut core::ffi::c_void,
        current_directory: *const u16,
        startup_info: *const StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> i32;
}

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    reserved2_size: u16,
    reserved2: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;
const TOKEN_ADJUST_SESSIONID: u32 = 0x0100;
const SECURITY_IMPERSONATION: i32 = 2;
const TOKEN_PRIMARY: i32 = 1;
const TOKEN_ELEVATION_CLASS: i32 = 20;

/// Un HANDLE de Windows que se cierra al salir del ámbito.
struct OwnedHandle(Handle);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn os_error(action: &str) -> String {
    format!("No se pudo {action}: {}", std::io::Error::last_os_error())
}

fn token_is_elevated(token: Handle) -> bool {
    let mut elevation = 0u32;
    let mut returned = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TOKEN_ELEVATION_CLASS,
            (&mut elevation as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            &mut returned,
        )
    };
    ok != 0 && elevation != 0
}

/// Línea de órdenes para `CreateProcess*`: el ejecutable y sus argumentos,
/// cada uno citado como lo lee `CommandLineToArgvW`.
pub fn command_line(executable: &Path, arguments: &[String]) -> String {
    std::iter::once(quote_windows_arg(&executable.to_string_lossy()))
        .chain(arguments.iter().map(|argument| quote_windows_arg(argument)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Lanza `executable` SIN elevar aunque quien llama sea administrador. Un
/// proceso elevado no puede soltar sus permisos y todo lo que lanza los
/// hereda; la vía que da Windows es copiar el token de la shell del escritorio
/// (el Explorador, que no está elevado) y crear el proceso con él. Si el
/// Explorador también está elevado no hay sesión normal a la que volver.
pub fn run_unelevated(
    executable: &Path,
    arguments: &[String],
    directory: &Path,
) -> Result<(), String> {
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err(
            "No hay escritorio del Explorador del que tomar los permisos normales.".to_string(),
        );
    }
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(shell, &mut process_id) };
    if process_id == 0 {
        return Err(os_error("encontrar el proceso del Explorador"));
    }
    let process =
        OwnedHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) });
    if process.0.is_null() {
        return Err(os_error("abrir el proceso del Explorador"));
    }
    let mut shell_token = OwnedHandle(std::ptr::null_mut());
    if unsafe { OpenProcessToken(process.0, TOKEN_DUPLICATE | TOKEN_QUERY, &mut shell_token.0) }
        == 0
    {
        return Err(os_error("leer los permisos del Explorador"));
    }
    if token_is_elevated(shell_token.0) {
        return Err("El Explorador también se ejecuta como administrador: en esta sesión no hay permisos normales a los que volver.".to_string());
    }
    let mut primary = OwnedHandle(std::ptr::null_mut());
    let access = TOKEN_QUERY
        | TOKEN_DUPLICATE
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID;
    if unsafe {
        DuplicateTokenEx(
            shell_token.0,
            access,
            std::ptr::null_mut(),
            SECURITY_IMPERSONATION,
            TOKEN_PRIMARY,
            &mut primary.0,
        )
    } == 0
    {
        return Err(os_error("copiar los permisos del Explorador"));
    }
    let application = wide(&executable.to_string_lossy());
    let mut command = wide(&command_line(executable, arguments));
    let directory = wide(&directory.to_string_lossy());
    // Todo a cero salvo el tamaño: ventana normal, sin redirecciones.
    let mut startup: StartupInfoW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<StartupInfoW>() as u32;
    let mut information: ProcessInformation = unsafe { std::mem::zeroed() };
    // Sin entorno propio: Windows crea el del usuario, no hereda el del
    // proceso elevado.
    let created = unsafe {
        CreateProcessWithTokenW(
            primary.0,
            0,
            application.as_ptr(),
            command.as_mut_ptr(),
            0,
            std::ptr::null_mut(),
            directory.as_ptr(),
            &startup,
            &mut information,
        )
    };
    if created == 0 {
        return Err(os_error("abrir WTerminal sin permisos de administrador"));
    }
    drop(OwnedHandle(information.thread));
    drop(OwnedHandle(information.process));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_modo_de_sudo_sale_del_registro_y_de_que_exista_sudo_exe() {
        assert_eq!(
            WindowsSudo::from_registry(Some(3), false),
            WindowsSudo::Missing
        );
        assert_eq!(
            WindowsSudo::from_registry(None, true),
            WindowsSudo::Disabled
        );
        assert_eq!(
            WindowsSudo::from_registry(Some(0), true),
            WindowsSudo::Disabled
        );
        assert_eq!(
            WindowsSudo::from_registry(Some(1), true),
            WindowsSudo::NewWindow
        );
        assert_eq!(
            WindowsSudo::from_registry(Some(2), true),
            WindowsSudo::InputDisabled
        );
        assert_eq!(
            WindowsSudo::from_registry(Some(3), true),
            WindowsSudo::Inline
        );
    }

    #[test]
    fn los_argumentos_se_citan_como_los_lee_windows() {
        assert_eq!(
            quote_windows_arg("--elevated-relaunch"),
            "--elevated-relaunch"
        );
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(
            quote_windows_arg(r"C:\Program Files\x"),
            r#""C:\Program Files\x""#
        );
        assert_eq!(quote_windows_arg(r#"di "hola""#), r#""di \"hola\"""#);
        assert_eq!(
            quote_windows_arg(r"C:\con espacio\"),
            r#""C:\con espacio\\""#
        );
    }

    #[test]
    fn la_linea_de_ordenes_cita_el_ejecutable_y_cada_argumento() {
        assert_eq!(
            command_line(
                Path::new(r"C:\Program Files\WTerminal\wterminal.exe"),
                &["--open-path".to_string(), r"C:\x y".to_string()],
            ),
            r#""C:\Program Files\WTerminal\wterminal.exe" --open-path "C:\x y""#
        );
        assert_eq!(command_line(Path::new(r"C:\w\w.exe"), &[]), r"C:\w\w.exe");
    }

    #[test]
    fn sin_elevar_un_ejecutable_que_no_existe_da_error_y_no_abre_nada() {
        // Sin Explorador (servicio), sin el privilegio de suplantar (proceso
        // sin elevar) o con el archivo inexistente: siempre un error claro.
        let missing = std::env::temp_dir().join("wterminal-no-existe-7f3a.exe");
        let error = run_unelevated(&missing, &[], &std::env::temp_dir())
            .expect_err("no puede abrir un ejecutable que no existe");
        assert!(!error.is_empty());
    }
}
