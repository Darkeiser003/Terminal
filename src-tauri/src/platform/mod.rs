//! Frontera entre el backend compartido y las operaciones del sistema host.
//!
//! Los módulos de negocio no deben decidir cómo se comporta Windows o Linux:
//! llaman a esta fachada y la selección se resuelve una sola vez al compilar.

#[cfg(target_os = "linux")]
mod linux;
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
pub use windows::nsudo_path;
#[cfg(windows)]
pub use windows::{open_directory, open_path};
#[cfg(windows)]
pub use windows::{probe_virtualization, run_wsl};

#[cfg(not(any(target_os = "linux", windows)))]
compile_error!("WinSlim Terminal solo admite actualmente Windows y Linux");

#[cfg(target_os = "linux")]
static HOST: LinuxPlatform = LinuxPlatform;
#[cfg(windows)]
static HOST: WindowsPlatform = WindowsPlatform;

pub fn host() -> &'static impl HostPlatform {
    &HOST
}
