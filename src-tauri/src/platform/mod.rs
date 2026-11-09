//! Frontera entre el backend compartido y las operaciones del sistema host.
//!
//! Los módulos de negocio no deben decidir cómo se comporta Windows o Linux:
//! llaman a esta fachada y la selección se resuelve una sola vez al compilar.

pub mod first_run;
#[cfg(target_os = "linux")]
mod linux;
pub mod path_integration;
pub mod recycle;
pub mod system_info;
pub mod traits;
#[cfg(windows)]
mod windows;
pub mod windows_integration;

#[cfg(target_os = "linux")]
use linux::LinuxPlatform;
#[cfg(windows)]
use windows::WindowsPlatform;

use traits::HostPlatform;

#[cfg(target_os = "linux")]
pub use linux::nsudo_path;
#[cfg(target_os = "linux")]
pub use linux::{open_directory, open_path};
#[cfg(target_os = "linux")]
pub use linux::{probe_virtualization, run_wsl};
#[cfg(windows)]
pub use windows::elevation::is_process_elevated;
#[cfg(windows)]
pub use windows::elevation::{
    gsudo_path, run_elevated, run_unelevated, windows_sudo, windows_sudo_path, WindowsSudo,
};
#[cfg(windows)]
pub use windows::nsudo_path;
#[cfg(windows)]
pub use windows::webview2;
#[cfg(windows)]
pub use windows::{open_directory, open_path};
#[cfg(windows)]
pub use windows::{probe_virtualization, run_wsl};

#[cfg(not(any(target_os = "linux", windows)))]
compile_error!("WTerminal/LTerminal solo admite actualmente Windows y Linux");

#[cfg(target_os = "linux")]
static HOST: LinuxPlatform = LinuxPlatform;
#[cfg(windows)]
static HOST: WindowsPlatform = WindowsPlatform;

pub fn host() -> &'static impl HostPlatform {
    &HOST
}

/// Argumento con el que el desinstalador NSIS llama a `wterminal.exe` antes de
/// borrar el programa (`windows/installer-hooks.nsh`).
pub const UNINSTALL_CLEANUP_ARG: &str = "--wterminal-uninstall-cleanup";

/// Deshace lo que WTerminal registró por su cuenta en el perfil del usuario y
/// que el desinstalador de Tauri no conoce: su carpeta y las `bin` de las
/// herramientas en el PATH de HKCU (solo las que añadió él), los menús «Abrir
/// con WTerminal», App Paths y el protocolo `wterminal://`, y la marca
/// RUNASADMIN. Sin esto, tras desinstalar quedaban entradas apuntando a un
/// ejecutable que ya no existe. Lo que registró otra copia que sigue existiendo
/// (un portable) se queda como está. No toca ajustes ni la carpeta propia: eso
/// lo decide la casilla «Borrar los datos» del desinstalador. Devuelve el
/// código de salida (0 si todo fue bien).
#[cfg(windows)]
pub fn uninstall_cleanup() -> i32 {
    let mut failures = 0;
    // Quita lo añadido y olvida el estado: sin la preferencia «desactivada»
    // que dejaría `path_integration_set(false)`, una reinstalación vuelve a
    // añadirse sola al PATH.
    if let Err(error) = path_integration::uninstall_cleanup() {
        eprintln!("PATH: {error}");
        failures += 1;
    }
    if let Err(error) = windows_integration::uninstall_cleanup() {
        eprintln!("Integración de Windows: {error}");
        failures += 1;
    }
    if let Err(error) = windows_integration::set_run_as_admin_flag(false) {
        eprintln!("RUNASADMIN: {error}");
        failures += 1;
    }
    i32::from(failures > 0)
}
