//! Integración con ADB (Android Platform Tools):
//!   - localiza `adb` aunque el PATH del proceso esté desactualizado (recién
//!     instalado con la app abierta) y lo añade al PATH que heredan las
//!     pestañas nuevas,
//!   - detecta los dispositivos conectados y los ofrece como entornos del
//!     selector, igual que se hace con los contenedores/imágenes de Docker:
//!     elegir uno abre una shell REAL dentro del dispositivo (`adb shell`).
//!
//! Port de `electron/main/androidEnv.js`.
//!
//! La llamada a `adb` lleva plazo: arrancar el servidor de adb puede tardar un
//! par de segundos y esta detección corre durante el arranque de la app.

use std::path::PathBuf;
use std::time::Duration;

use crate::environments::{Environment, ShellKind, Transport};
use crate::path_env::{add_to_process_path, which};
use crate::platform::traits::HostPlatform;
use crate::process;

const ADB_TIMEOUT: Duration = Duration::from_millis(6000);

/// Cuántos dispositivos como máximo se convierten en entornos. Un banco de
/// pruebas con muchos emuladores no debe llenar el desplegable.
pub const MAX_ADB_ENVS: usize = 10;

fn adb_exe_name() -> &'static str {
    if crate::platform::host().is_windows() {
        "adb.exe"
    } else {
        "adb"
    }
}

/// Rutas donde suele acabar platform-tools, en orden de preferencia. La primera
/// es exactamente donde instala la acción "Instalar ADB" de esta app; las demás
/// cubren instalaciones previas hechas con Android Studio o a mano.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(key) {
            dirs.push(PathBuf::from(root).join("platform-tools"));
        }
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);

    if crate::platform::host().is_windows() {
        if let Some(local) = &local {
            dirs.push(local.join("Android").join("platform-tools"));
            dirs.push(local.join("Android").join("Sdk").join("platform-tools"));
        }
        if let Some(home) = &home {
            dirs.push(home.join("Android").join("Sdk").join("platform-tools"));
        }
        if let Some(program_files) = &program_files {
            dirs.push(program_files.join("Android").join("platform-tools"));
        }
    } else {
        if let Some(home) = &home {
            dirs.push(home.join("Android").join("Sdk").join("platform-tools"));
        }
        dirs.push(PathBuf::from("/usr/lib/android-sdk/platform-tools"));
    }
    dirs
}

/// El ejecutable de adb instalado en el sistema, buscando primero en el PATH y
/// cayendo a las rutas conocidas.
pub fn find_adb_path() -> Option<PathBuf> {
    if let Some(on_path) = which("adb") {
        return Some(on_path);
    }
    candidate_dirs()
        .into_iter()
        .map(|dir| dir.join(adb_exe_name()))
        // Una ruta ilegible (unidad desconectada, permisos) simplemente no
        // existe a efectos de esta comprobación.
        .find(|exe| exe.is_file())
}

/// Si adb existe pero no es visible en el PATH del proceso (caso típico: acaba
/// de instalarse desde la propia terminal y la app arrancó antes), se añade su
/// carpeta. A partir de ahí, cualquier pestaña NUEVA puede usar `adb` desde
/// cualquier ruta sin reiniciar la app.
pub fn ensure_adb_on_path() -> Option<String> {
    if which("adb").is_some() {
        return None;
    }
    let exe = find_adb_path()?;
    let dir = exe.parent()?.to_string_lossy().to_string();
    add_to_process_path(&dir).then_some(dir)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
}

/// Estados que devuelve `adb devices` distintos de "listo para usar". Se
/// muestran igualmente en el selector: ver el dispositivo con su estado es más
/// útil que no verlo (y al abrirlo, adb explica en la propia terminal qué
/// falta, p. ej. aceptar la huella RSA en la pantalla del móvil).
#[rustfmt::skip]
const STATE_LABELS: &[(&str, &str)] = &[
    ("unauthorized", "sin autorizar"),
    ("offline", "offline"),
    ("authorizing", "autorizando"),
    ("recovery", "recovery"),
    ("sideload", "sideload"),
    ("bootloader", "bootloader"),
    ("rescue", "rescue"),
    ("host", "host"),
    ("no permissions", "sin permisos"),
];

/// Qué hacer cuando el dispositivo no está en estado "device": `adb shell` va a
/// fallar y salir al instante, y el error de adb (en inglés y sin contexto) no
/// deja claro que la pelota está en la pantalla del móvil.
#[rustfmt::skip]
const STATE_NOTES: &[(&str, &str)] = &[
    ("unauthorized", "Desbloquea el móvil, acepta \"Permitir depuración por USB\" y pulsa refrescar en el selector de entorno."),
    ("offline", "El dispositivo no responde. Reconecta el cable o usa \"adb kill-server\" y pulsa refrescar."),
    ("authorizing", "Acepta el diálogo de autorización en el móvil y pulsa refrescar cuando termine."),
    ("bootloader", "El dispositivo está en el bootloader: ahí no hay shell, solo comandos fastboot."),
    ("sideload", "El dispositivo está en modo sideload (recovery): ahí no hay shell interactiva."),
    ("no permissions", "El sistema no da permisos sobre el dispositivo USB (reglas udev en Linux). Revisa la documentación de adb sobre reglas udev."),
];

/// Solo se habilitan estados que realmente aceptan `adb shell`. En particular,
/// `wait-for-device` no espera a la autorización RSA: con un dispositivo
/// `unauthorized` termina y `shell` falla inmediatamente. Es más honesto dejar
/// la opción visible pero deshabilitada hasta que el usuario autorice y pulse
/// refrescar.
const SHELL_STATES: [&str; 3] = ["device", "recovery", "rescue"];

fn lookup<'a>(table: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    table
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, value)| *value)
}

/// Parsea la salida de `adb devices -l`:
///
/// ```text
/// List of devices attached
/// 7a466cd1        unauthorized usb:1-4 transport_id:1
/// emulator-5554   device product:sdk model:Pixel_3a device:generic
/// ```
pub fn parse_devices(output: &str) -> Vec<Device> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // Cabecera y mensajes del servidor ("* daemon started successfully").
        .filter(|line| !line.starts_with('*') && !starts_with_ignore_case(line, "List of devices"))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            let state = parts.next()?.to_lowercase();
            if serial.is_empty() || state.is_empty() {
                return None;
            }
            let model = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("model:"))
                .map(|value| value.replace('_', " "));
            Some(Device {
                serial: serial.to_string(),
                state,
                model,
            })
        })
        .collect()
}

fn starts_with_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack.len() >= needle.len() && haystack[..needle.len()].eq_ignore_ascii_case(needle)
}

pub fn device_label(device: &Device) -> String {
    let name = match &device.model {
        Some(model) => format!("{model} ({})", device.serial),
        None => device.serial.clone(),
    };
    match lookup(STATE_LABELS, &device.state) {
        Some(state) => format!("ADB ▶ {name} — {state}"),
        None => format!("ADB ▶ {name}"),
    }
}

fn to_env(adb_path: &str, device: &Device) -> Environment {
    let available = SHELL_STATES.contains(&device.state.as_str());
    Environment {
        id: format!("adb:{}", device.serial),
        label: device_label(device),
        group: "Android (ADB)".into(),
        kind: ShellKind::Android,
        transport: Transport::Android,
        exe: adb_path.to_string(),
        args: vec!["-s".into(), device.serial.clone(), "shell".into()],
        available,
        note: lookup(STATE_NOTES, &device.state)
            .map(str::to_string)
            .or_else(|| {
                (!available)
                    .then(|| format!("Estado ADB: {}. Refresca cuando esté listo.", device.state))
            }),
        ..Default::default()
    }
}

#[derive(Debug, Default)]
pub struct AndroidInventory {
    pub installed: bool,
    pub adb_path: Option<String>,
    pub device_count: usize,
    pub envs: Vec<Environment>,
}

/// Entornos ADB disponibles ahora mismo. Si adb no está instalado, o no hay
/// ningún dispositivo conectado, la lista queda vacía y el resto de entornos
/// funciona con normalidad.
pub fn detect_android_environments() -> AndroidInventory {
    let Some(adb_path) = find_adb_path() else {
        return AndroidInventory::default();
    };
    let adb_path = adb_path.to_string_lossy().to_string();

    let devices = process::output_text(&adb_path, &["devices", "-l"], ADB_TIMEOUT)
        .map(|out| parse_devices(&out))
        .unwrap_or_default();

    AndroidInventory {
        installed: true,
        device_count: devices.len(),
        envs: devices
            .iter()
            .take(MAX_ADB_ENVS)
            .map(|device| to_env(&adb_path, device))
            .collect(),
        adb_path: Some(adb_path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALIDA: &str = "* daemon not running; starting now at tcp:5037\n\
                          * daemon started successfully\n\
                          List of devices attached\n\
                          7a466cd1        unauthorized usb:1-4 transport_id:1\n\
                          emulator-5554   device product:sdk model:Pixel_3a device:generic\n";

    #[test]
    fn se_ignoran_la_cabecera_y_los_mensajes_del_servidor() {
        let devices = parse_devices(SALIDA);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "7a466cd1");
        assert_eq!(devices[1].serial, "emulator-5554");
    }

    #[test]
    fn el_modelo_se_lee_y_se_deja_legible() {
        let devices = parse_devices(SALIDA);
        assert_eq!(devices[0].model, None);
        assert_eq!(devices[1].model.as_deref(), Some("Pixel 3a"));
    }

    #[test]
    fn una_salida_sin_dispositivos_no_da_nada() {
        assert!(parse_devices("List of devices attached\n\n").is_empty());
        assert!(parse_devices("").is_empty());
    }

    #[test]
    fn solo_los_estados_que_aceptan_shell_quedan_disponibles() {
        let devices = parse_devices(SALIDA);
        let sin_autorizar = to_env("adb", &devices[0]);
        let listo = to_env("adb", &devices[1]);
        assert!(!sin_autorizar.available);
        assert!(listo.available);
    }

    #[test]
    fn un_estado_conocido_explica_que_hacer() {
        let device = Device {
            serial: "abc".into(),
            state: "unauthorized".into(),
            model: None,
        };
        let env = to_env("adb", &device);
        assert!(env.note.unwrap().contains("Permitir depuración por USB"));
    }

    #[test]
    fn un_estado_desconocido_tambien_deja_un_aviso() {
        let device = Device {
            serial: "abc".into(),
            state: "raro".into(),
            model: None,
        };
        let env = to_env("adb", &device);
        assert_eq!(
            env.note.as_deref(),
            Some("Estado ADB: raro. Refresca cuando esté listo.")
        );
        assert!(!env.available);
    }

    #[test]
    fn un_dispositivo_listo_no_lleva_aviso() {
        let device = Device {
            serial: "abc".into(),
            state: "device".into(),
            model: None,
        };
        assert_eq!(to_env("adb", &device).note, None);
    }

    #[test]
    fn la_etiqueta_incluye_modelo_serie_y_estado() {
        let device = Device {
            serial: "7a466cd1".into(),
            state: "unauthorized".into(),
            model: Some("Pixel 3a".into()),
        };
        assert_eq!(
            device_label(&device),
            "ADB ▶ Pixel 3a (7a466cd1) — sin autorizar"
        );
    }

    #[test]
    fn el_dispositivo_no_recibe_los_alias_de_las_shells_del_host() {
        let device = Device {
            serial: "abc".into(),
            state: "device".into(),
            model: None,
        };
        let env = to_env("adb", &device);
        assert_eq!(env.kind, ShellKind::Android);
        assert!(!env.transport.loads_host_files());
    }

    #[test]
    fn el_comando_apunta_al_dispositivo_concreto() {
        let device = Device {
            serial: "emulator-5554".into(),
            state: "device".into(),
            model: None,
        };
        let env = to_env("/opt/adb", &device);
        assert_eq!(env.exe, "/opt/adb");
        assert_eq!(env.args, vec!["-s", "emulator-5554", "shell"]);
    }
}
