//! Panel de información del sistema estilo fastfetch/neofetch, que se imprime
//! una vez como salida normal al abrir cada pestaña y bajo demanda con
//! `sysinfo` o `:banner preset full`.
//!
//! Port de `electron/main/systemInfo.js`. Donde el original usaba el módulo
//! `os` de Node, aquí está el crate `sysinfo`; el resto (identidad real del SO,
//! GPU, discos) sigue leyéndose igual: del registro en Windows, de
//! `/etc/os-release` en Linux y de `sw_vers` en macOS.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sysinfo::{Disks, System};

#[cfg(windows)]
use winreg::enums::{
    HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, REG_DWORD, REG_EXPAND_SZ, REG_QWORD, REG_SZ,
};
#[cfg(windows)]
use winreg::types::FromRegValue;
#[cfg(windows)]
use winreg::{RegKey, RegValue};

use crate::i18n::Translator;
use crate::process;

const RESET: &str = "\x1b[0m";
const CYAN: &str = "\x1b[36m";
const BOLD: &str = "\x1b[1m";

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

fn format_bytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1024f64.powi(3))
}

#[allow(dead_code)]
fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    parts.push(format!("{minutes}m"));
    parts.join(" ")
}

#[allow(dead_code)]
fn format_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Quita adornos que no aportan (emojis, tildes decorativas de los nombres
/// personalizados tipo "🚀 ~ LTerminal 10 ~ 🚀") y colapsa espacios: el banner se
/// escribe en un archivo que la consola lee en su propia página de códigos,
/// donde cualquier carácter no ASCII acabaría como "?".
pub fn clean_identity_value(value: &str) -> String {
    let replaced: String = value
        .chars()
        .map(|c| {
            let keep = (' '..='~').contains(&c) || ('\u{a1}'..='\u{24f}').contains(&c);
            if keep && c != '{' && c != '}' && c != '?' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let trimmed = replaced
        .trim_matches(|c: char| c.is_whitespace() || c == '~' || c == '|' || c == '-' || c == '?');
    trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---- Identidad real del sistema ----
// El nombre del kernel no es el que el usuario reconoce como suyo: en Linux da
// "7.1.6-1-cachyos" en vez de "CachyOS", y en Windows "10.0.19045" en vez de la
// edición instalada. El nombre de verdad vive en /etc/os-release, en el
// registro o en sw_vers, según la plataforma. Leerlo cuesta una llamada, así
// que se cachea: no cambia mientras la app está abierta.

#[derive(Debug, Clone, Default)]
pub struct OsIdentity {
    pub name: String,
    pub build: Option<String>,
    /// Marca de una ISO personalizada (LTerminal y compañía), leída de la
    /// información OEM del registro.
    pub brand: Option<String>,
}

static IDENTITY: Lazy<Mutex<Option<OsIdentity>>> = Lazy::new(|| Mutex::new(None));

pub fn os_identity() -> OsIdentity {
    let mut cache = IDENTITY.lock();
    if let Some(identity) = cache.as_ref() {
        return identity.clone();
    }
    let detected = detect_identity().filter(|identity| !identity.name.is_empty());
    // Sin identidad legible se cae al dato del kernel, que siempre existe.
    let identity = detected.unwrap_or_else(|| OsIdentity {
        name: format!(
            "{} {}",
            System::name().unwrap_or_else(|| std::env::consts::OS.to_string()),
            System::os_version().unwrap_or_default()
        )
        .trim()
        .to_string(),
        build: None,
        brand: None,
    });
    *cache = Some(identity.clone());
    identity
}

#[cfg(windows)]
fn detect_identity() -> Option<OsIdentity> {
    Some(read_windows_identity())
}

#[cfg(target_os = "macos")]
fn detect_identity() -> Option<OsIdentity> {
    let read = |flag: &str| {
        process::output_text("sw_vers", &[flag], PROBE_TIMEOUT).map(|out| out.trim().to_string())
    };
    let name = [read("-productName"), read("-productVersion")]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        return None;
    }
    Some(OsIdentity {
        name: clean_identity_value(&name),
        build: read("-buildVersion").filter(|value| !value.is_empty()),
        brand: None,
    })
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn detect_identity() -> Option<OsIdentity> {
    read_linux_identity()
}

/// `/etc/os-release` es el estándar de systemd y lo traen todas las distros
/// modernas; `/usr/lib/os-release` es el respaldo oficial para sistemas con
/// `/etc` mínimo.
#[allow(dead_code)]
fn read_linux_identity() -> Option<OsIdentity> {
    for file in ["/etc/os-release", "/usr/lib/os-release"] {
        let Ok(content) = std::fs::read_to_string(file) else {
            continue;
        };
        let values = parse_os_release(&content);
        let lookup = |key: &str| {
            values
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        let name = lookup("PRETTY_NAME")
            .or_else(|| {
                let composed = [lookup("NAME"), lookup("VERSION")]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ");
                (!composed.trim().is_empty()).then_some(composed)
            })
            .or_else(|| lookup("ID"))?;
        if !name.is_empty() {
            return Some(OsIdentity {
                name: clean_identity_value(&name),
                build: lookup("BUILD_ID"),
                brand: None,
            });
        }
    }
    None
}

fn parse_os_release(content: &str) -> Vec<(String, String)> {
    content
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            if !key.chars().all(|c| c.is_ascii_uppercase() || c == '_') || key.is_empty() {
                return None;
            }
            Some((
                key.to_string(),
                value.trim().trim_matches(['"', '\'']).to_string(),
            ))
        })
        .collect()
}

#[allow(dead_code)]
const WIN_NT_KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion";
#[allow(dead_code)]
const WIN_OEM_KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OEMInformation";

/// Lee una clave directamente mediante la API del Registro. La versión
/// anterior lanzaba un `reg.exe` por clave; la GPU por sí sola podía abrir diez
/// procesos antes incluso de que Tauri mostrara la ventana.
#[allow(dead_code)]
fn reg_values(key: &str) -> Vec<(String, String)> {
    #[cfg(windows)]
    {
        let relative = key
            .strip_prefix("HKLM\\")
            .or_else(|| key.strip_prefix("HKEY_LOCAL_MACHINE\\"))
            .unwrap_or(key);
        let Ok(subkey) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(relative, KEY_READ | KEY_WOW64_64KEY)
        else {
            return Vec::new();
        };
        subkey
            .enum_values()
            .filter_map(Result::ok)
            .filter_map(|(name, value)| registry_value_text(&value).map(|text| (name, text)))
            .collect()
    }

    #[cfg(not(windows))]
    {
        let _ = key;
        Vec::new()
    }
}

#[cfg(windows)]
fn registry_value_text(value: &RegValue) -> Option<String> {
    match value.vtype {
        REG_SZ | REG_EXPAND_SZ => String::from_reg_value(value).ok(),
        REG_DWORD => u32::from_reg_value(value)
            .ok()
            .map(|number| number.to_string()),
        REG_QWORD => u64::from_reg_value(value)
            .ok()
            .map(|number| number.to_string()),
        _ => None,
    }
}

#[allow(dead_code)]
fn parse_reg_query(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        // Las líneas de valor van indentadas con cuatro espacios; la de la
        // propia clave, no.
        .filter(|line| line.starts_with("    ") && !line.starts_with("     "))
        .filter_map(|line| {
            let trimmed = line.trim();
            let mut parts = trimmed.split_whitespace();
            let name = parts.next()?;
            let kind = parts.next()?;
            if !kind.starts_with("REG_") {
                return None;
            }
            let value_start = trimmed.find(kind)? + kind.len();
            Some((name.to_string(), trimmed[value_start..].trim().to_string()))
        })
        .collect()
}

#[allow(dead_code)]
fn reg_number(value: &str) -> Option<u64> {
    match value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => value.parse().ok(),
    }
}

#[cfg(windows)]
fn read_windows_identity() -> OsIdentity {
    let nt = reg_values(WIN_NT_KEY);
    let get = |key: &str| {
        nt.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };

    // ProductName se quedó anclado en "Windows 10" en los Windows 11, así que
    // la build manda para decidir la generación: 22000 es el primer build de
    // Windows 11.
    let mut product = clean_identity_value(&get("ProductName").unwrap_or_default());
    if product.is_empty() {
        product = format!(
            "{} {}",
            System::name().unwrap_or_else(|| "Windows".into()),
            System::os_version().unwrap_or_default()
        );
    }
    let build = get("CurrentBuild")
        .or_else(|| get("CurrentBuildNumber"))
        .and_then(|value| reg_number(&value))
        .unwrap_or(0);
    if build >= 22_000 {
        product = product.replace("Windows 10", "Windows 11");
    }
    let display = clean_identity_value(
        &get("DisplayVersion")
            .or_else(|| get("ReleaseId"))
            .unwrap_or_default(),
    );
    if !display.is_empty() {
        product.push(' ');
        product.push_str(&display);
    }

    // Las ISOs personalizadas (LTerminal y compañía) escriben su marca en la
    // información OEM: es el nombre que el usuario ve en "Acerca de" y el que
    // espera reconocer aquí, no el de la edición base de Microsoft.
    let oem = reg_values(WIN_OEM_KEY);
    let oem_get = |key: &str| {
        oem.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    let brand = clean_identity_value(
        &oem_get("Model")
            .or_else(|| oem_get("Manufacturer"))
            .unwrap_or_default(),
    );

    OsIdentity {
        build: (build > 0).then(|| match get("UBR").and_then(|v| reg_number(&v)) {
            Some(ubr) => format!("{build}.{ubr}"),
            None => build.to_string(),
        }),
        brand: (!brand.is_empty() && !brand.eq_ignore_ascii_case(&product)).then_some(brand),
        name: product,
    }
}

/// Modelo de la tarjeta gráfica. Cada plataforma lo pregunta a su manera y
/// ninguna es rápida, así que se cachea con el resto de la identidad.
#[allow(dead_code)]
#[cfg(windows)]
fn read_gpu_model() -> String {
    process::output_text(
        "wmic",
        &["path", "win32_VideoController", "get", "name"],
        PROBE_TIMEOUT,
    )
    .map(|output| parse_wmic_gpu(&output))
    .unwrap_or_default()
}

#[allow(dead_code)]
#[cfg(target_os = "macos")]
fn read_gpu_model() -> String {
    process::output_text("system_profiler", &["SPDisplaysDataType"], PROBE_TIMEOUT)
        .map(|output| parse_system_profiler_gpu(&output))
        .unwrap_or_default()
}

#[allow(dead_code)]
#[cfg(all(not(windows), not(target_os = "macos")))]
fn read_gpu_model() -> String {
    process::output_text(
        "sh",
        &[
            "-c",
            "command -v lspci >/dev/null 2>&1 && lspci -nn | grep -Ei \"vga|3d|display\" | head -n 1",
        ],
        PROBE_TIMEOUT,
    )
    .map(|output| parse_lspci_gpu(output.trim()))
    .unwrap_or_default()
}

/// `system_profiler` describe la tarjeta con una de estas dos etiquetas según
/// la versión de macOS.
#[allow(dead_code)]
fn parse_system_profiler_gpu(output: &str) -> String {
    for prefix in ["Chipset Model:", "Graphics:"] {
        if let Some(line) = output.lines().find(|line| line.trim().starts_with(prefix)) {
            return line.trim()[prefix.len()..].trim().to_string();
        }
    }
    String::new()
}

/// `wmic ... get name` imprime la cabecera "Name" y luego una línea por
/// tarjeta. Interesa la primera de verdad.
#[allow(dead_code)]
fn parse_wmic_gpu(output: &str) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() > 1 {
        lines[1].to_string()
    } else {
        lines
            .first()
            .map(|line| line.to_string())
            .unwrap_or_default()
    }
}

/// Extrae fabricante y modelo de la línea normal de `lspci -nn`. `-mm` no es
/// uniforme entre versiones de pciutils: en algunas distribuciones separa por
/// espacios y comillas, y el parser antiguo terminaba enseñando el bus y la
/// clase en lugar de la GPU.
#[allow(dead_code)]
fn parse_lspci_gpu(output: &str) -> String {
    if output.is_empty() {
        return String::new();
    }
    // Compatibilidad con una salida `-mm` real separada por tabuladores.
    let fields: Vec<&str> = output.split('\t').collect();
    if fields.len() >= 4 {
        return fields[2..].join(" ").replace('"', "").trim().to_string();
    }

    // En la salida normal el último «: » separa la clase del fabricante. El
    // primero pertenece al bus PCI (`01:00.0`) y no debe usarse.
    let model = output
        .rsplit_once(": ")
        .map(|(_, value)| value)
        .unwrap_or(output);
    let model = model
        .split_once(" (rev ")
        .map(|(value, _)| value)
        .unwrap_or(model)
        .trim();
    // `-nn` añade al final `[vendor:device]`; se elimina únicamente ese bloque
    // hexadecimal y se conservan nombres útiles como `[GeForce GTX 1660]`.
    if let Some((head, tail)) = model.rsplit_once(" [") {
        let id = tail.strip_suffix(']').unwrap_or(tail);
        if id.len() == 9
            && id.as_bytes().get(4) == Some(&b':')
            && id
                .chars()
                .enumerate()
                .all(|(index, ch)| index == 4 && ch == ':' || index != 4 && ch.is_ascii_hexdigit())
        {
            return head.trim().to_string();
        }
    }
    model.trim_matches('"').trim().to_string()
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

/// Convierte la descripción técnica del driver en un nombre legible para el
/// banner. Algunas versiones de `lspci` devuelven, por ejemplo,
/// `NVidia Corporation TU116s`, mientras que otras incluyen el nombre
/// comercial entre corchetes. No se debe mostrar el identificador interno del
/// chip cuando el modelo comercial está disponible.
fn clean_gpu_name(value: &str) -> String {
    let normalized = clean_identity_value(value)
        .replace("NVidia", "NVIDIA")
        .replace("Nvidia", "NVIDIA")
        .replace("nvidia", "NVIDIA");
    if normalized.is_empty() {
        return String::new();
    }

    let lower = normalized.to_ascii_lowercase();
    let vendor = if lower.starts_with("nvidia") {
        Some("NVIDIA")
    } else if lower.starts_with("advanced micro devices") || lower.starts_with("amd") {
        Some("AMD")
    } else if lower.starts_with("intel") {
        Some("Intel")
    } else if lower.starts_with("matrox") {
        Some("Matrox")
    } else {
        None
    };

    let commercial_model = normalized
        .split('[')
        .skip(1)
        .filter_map(|part| part.split_once(']').map(|(candidate, _)| candidate.trim()))
        .map(clean_identity_value)
        .find(|candidate| {
            let candidate_lower = candidate.to_ascii_lowercase();
            !candidate.contains(':')
                && [
                    "geforce",
                    "quadro",
                    "tesla",
                    "rtx",
                    "gtx",
                    "radeon",
                    "arc",
                    "iris",
                    "uhd",
                    "hd graphics",
                    "vega",
                    "firepro",
                ]
                .iter()
                .any(|marker| candidate_lower.contains(marker))
        });

    let body = if let Some(model) = commercial_model {
        model
    } else if let Some(vendor_name) = vendor {
        strip_prefix_ignore_ascii_case(&normalized, vendor_name)
            .and_then(|rest| {
                strip_prefix_ignore_ascii_case(rest.trim_start(), "Corporation")
                    .or_else(|| strip_prefix_ignore_ascii_case(rest.trim_start(), "Inc."))
                    .or_else(|| Some(rest.trim_start()))
            })
            .unwrap_or(normalized.as_str())
            .trim()
            .to_string()
    } else {
        normalized.clone()
    };

    let body = body
        .replace("[AMD/ATI]", "")
        .replace("Corporation", "")
        .replace("Advanced Micro Devices, Inc.", "")
        .split_whitespace()
        .map(|token| {
            // Hay salidas de pciutils que añaden una `s` al codename, por
            // ejemplo `TU116s`. Solo se elimina en tokens alfanuméricos que
            // contienen dígitos para no alterar palabras como `Graphics`.
            if token.len() > 4 && token.ends_with('s') {
                let stem = &token[..token.len() - 1];
                if stem.chars().any(|ch| ch.is_ascii_digit())
                    && stem.chars().all(|ch| ch.is_ascii_alphanumeric())
                {
                    return stem.to_string();
                }
            }
            token.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ");

    match (vendor, body.is_empty()) {
        (Some(vendor), false) if !body.eq_ignore_ascii_case(vendor) => format!("{vendor} {body}"),
        (Some(vendor), _) => vendor.to_string(),
        (None, _) => body,
    }
}

/// Windows puede devolver un adaptador genérico aunque el controlador haya
/// dejado una descripción comercial en el Registro. En una VM también es una
/// respuesta legítima: el invitado solo ve la tarjeta virtual y no puede
/// conocer la GPU física del host sin passthrough.
#[allow(dead_code)]
fn is_generic_gpu_name(value: &str) -> bool {
    let lower = clean_identity_value(value).to_ascii_lowercase();
    lower.contains("microsoft basic display adapter")
        || lower.contains("microsoft remote display adapter")
        || lower.contains("standard vga graphics adapter")
        || lower.contains("vmware svga")
        || lower.contains("virtualbox graphics adapter")
        || lower.contains("hyper-v video")
        || lower.contains("virtio gpu")
}

#[allow(dead_code)]
fn preferred_gpu_name(primary: &str, fallback: &str) -> String {
    let primary = clean_gpu_name(primary);
    let fallback = clean_gpu_name(fallback);
    if (primary.is_empty() || is_generic_gpu_name(&primary)) && !fallback.is_empty() {
        return fallback;
    }
    primary
}

// El esquema 3 invalida las cachés que aún contienen nombres técnicos de GPU
// como `NVidia Corporation TU116s`.
const HARDWARE_CACHE_SCHEMA: u32 = 3;
const DISK_CACHE_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StaticHardware {
    schema: u32,
    fingerprint: String,
    cpu_model: String,
    motherboard: String,
    gpu: String,
    ram: String,
}

static STATIC_HARDWARE: OnceLock<StaticHardware> = OnceLock::new();
static QUICK_CPU: OnceLock<String> = OnceLock::new();
static HARDWARE_PREWARM_STARTED: AtomicBool = AtomicBool::new(false);

// Enumerar discos parece barato, pero puede consultar montajes FUSE, SMB o
// unidades desconectadas. Nunca debe formar parte del primer frame de la
// terminal: se calcula una sola vez en segundo plano y el siguiente repintado
// lo incorpora si ya está disponible.
static DISK_CACHE: Lazy<Mutex<Option<Vec<DiskRow>>>> = Lazy::new(|| Mutex::new(None));
static DISK_PREWARM_STARTED: AtomicBool = AtomicBool::new(false);
static DISK_REFRESH_COMPLETED: AtomicBool = AtomicBool::new(false);

fn hardware_cache_path() -> PathBuf {
    crate::paths::user_data_dir().join("hardware-cache.json")
}

fn disk_cache_path() -> PathBuf {
    crate::paths::user_data_dir().join("disk-cache.json")
}

fn fingerprint_source() -> String {
    #[cfg(windows)]
    {
        let machine_guid = reg_values(r"HKLM\SOFTWARE\Microsoft\Cryptography")
            .into_iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("MachineGuid"))
            .map(|(_, value)| value)
            .unwrap_or_default();
        let bios = reg_values(r"HKLM\HARDWARE\DESCRIPTION\System\BIOS");
        let product = bios
            .iter()
            .find(|(name, _)| name == "SystemProductName")
            .map(|(_, value)| value.as_str())
            .unwrap_or_default();
        format!(
            "windows|{}|{machine_guid}|{product}",
            std::env::consts::ARCH
        )
    }

    #[cfg(target_os = "macos")]
    {
        let host = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_default();
        format!(
            "macos|{}|{}|{}",
            std::env::consts::ARCH,
            host,
            crate::paths::home_dir().to_string_lossy()
        )
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let machine = ["/etc/machine-id", "/var/lib/dbus/machine-id"]
            .into_iter()
            .find_map(|file| std::fs::read_to_string(file).ok())
            .unwrap_or_default();
        let product = std::fs::read_to_string("/sys/class/dmi/id/product_uuid").unwrap_or_default();
        format!(
            "{}|{}|{}|{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            machine.trim(),
            product.trim()
        )
    }
}

fn machine_fingerprint() -> String {
    // La fuente nunca sale de la máquina: se guarda únicamente su hash para
    // invalidar la caché al copiarla a otro equipo.
    let mut hasher = DefaultHasher::new();
    fingerprint_source().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn valid_hardware_cache(value: StaticHardware, fingerprint: &str) -> Option<StaticHardware> {
    (value.schema == HARDWARE_CACHE_SCHEMA && value.fingerprint == fingerprint).then_some(value)
}

fn load_hardware_cache(path: &Path, fingerprint: &str) -> Option<StaticHardware> {
    let text = std::fs::read_to_string(path).ok()?;
    valid_hardware_cache(serde_json::from_str(&text).ok()?, fingerprint)
}

fn save_hardware_cache(path: &Path, value: &StaticHardware) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let Ok(text) = serde_json::to_string_pretty(value) else {
        return;
    };
    if std::fs::write(&temp, text).is_ok() {
        // Windows no permite renombrar encima de un archivo existente.
        let _ = std::fs::remove_file(path);
        if std::fs::rename(&temp, path).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }
}

fn detect_cpu_model() -> String {
    QUICK_CPU
        .get_or_init(|| {
            let mut system = System::new();
            system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
            system
                .cpus()
                .first()
                .map(|cpu| {
                    clean_cpu_model(&cpu.brand().split_whitespace().collect::<Vec<_>>().join(" "))
                })
                .unwrap_or_else(|| "desconocida".to_string())
        })
        .clone()
}

fn detect_static_hardware(fingerprint: String) -> StaticHardware {
    // Las cuatro sondas son independientes. En Windows las tres que necesitan
    // WMI comparten además un único OnceLock (ver `windows_cim_snapshot`).
    let (cpu_model, motherboard, gpu, ram) = std::thread::scope(|scope| {
        let cpu = scope.spawn(detect_cpu_model);
        let motherboard = scope.spawn(read_motherboard);
        let gpu = scope.spawn(read_full_gpu);
        let ram = scope.spawn(read_ram_speed);
        (
            cpu.join().unwrap_or_else(|_| "desconocida".to_string()),
            motherboard.join().unwrap_or_default(),
            gpu.join().unwrap_or_default(),
            ram.join().unwrap_or_default(),
        )
    });
    StaticHardware {
        schema: HARDWARE_CACHE_SCHEMA,
        fingerprint,
        cpu_model,
        motherboard,
        gpu: clean_gpu_name(&gpu),
        ram,
    }
}

fn static_hardware() -> &'static StaticHardware {
    STATIC_HARDWARE.get_or_init(|| {
        let fingerprint = machine_fingerprint();
        if !cfg!(test) {
            if let Some(cached) = load_hardware_cache(&hardware_cache_path(), &fingerprint) {
                return cached;
            }
        }
        let detected = detect_static_hardware(fingerprint);
        if !cfg!(test) {
            save_hardware_cache(&hardware_cache_path(), &detected);
        }
        detected
    })
}

fn start_hardware_prewarm() {
    if HARDWARE_PREWARM_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::Builder::new()
        .name("hardware-probe".into())
        .spawn(|| {
            let _ = os_identity();
            let _ = static_hardware();
        })
        .ok();
}

fn start_disk_prewarm() {
    if DISK_PREWARM_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Some(cached) = load_disk_cache(&disk_cache_path(), &machine_fingerprint()) {
        *DISK_CACHE.lock() = Some(cached);
    }
    std::thread::Builder::new()
        .name("disk-probe".into())
        .spawn(|| {
            let disks = read_disks();
            save_disk_cache(&disk_cache_path(), &disks);
            *DISK_CACHE.lock() = Some(disks);
            DISK_REFRESH_COMPLETED.store(true, Ordering::Release);
        })
        .ok();
}

/// Snapshot rápido para el primer banner. Si la sonda completa aún está
/// trabajando, solo se usa la CPU local y se deja que el repintado progresivo
/// añada placa, GPU y RAM después. El banner no puede esperar a WMI, lspci o a
/// un montaje remoto.
fn banner_hardware() -> StaticHardware {
    if let Some(hardware) = STATIC_HARDWARE.get() {
        return hardware.clone();
    }
    start_hardware_prewarm();
    StaticHardware {
        schema: HARDWARE_CACHE_SCHEMA,
        fingerprint: String::new(),
        cpu_model: detect_cpu_model(),
        ..StaticHardware::default()
    }
}

// Los tests de integración del banner necesitan inspeccionar el sistema real
// de forma determinista. El binario normal siempre usa el camino asíncrono y
// no bloquea el primer frame.
#[cfg(test)]
fn cached_disks() -> Vec<DiskRow> {
    read_disks()
}

#[cfg(not(test))]
fn cached_disks() -> Vec<DiskRow> {
    start_disk_prewarm();
    DISK_CACHE.lock().clone().unwrap_or_default()
}

/// Indica si ya están disponibles todos los datos lentos para una impresión
/// explícita del banner.
pub fn banner_data_ready() -> bool {
    hardware_data_ready() && disks_data_ready()
}

pub fn hardware_data_ready() -> bool {
    STATIC_HARDWARE.get().is_some()
}

pub fn disks_data_ready() -> bool {
    DISK_REFRESH_COMPLETED.load(Ordering::Acquire) && DISK_CACHE.lock().is_some()
}

/// Precarga el snapshot estático en segundo plano. Con una caché válida es una
/// lectura local mínima; en el primer arranque las sondas se ejecutan en
/// paralelo y el hilo que construya el banner comparte ese mismo resultado.
pub fn prewarm_hardware_info() {
    start_hardware_prewarm();
    start_disk_prewarm();
}

pub fn motherboard_info() -> String {
    static_hardware().motherboard.clone()
}

#[cfg(windows)]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsCimSnapshot {
    motherboard: String,
    socket: String,
    gpu_name: String,
    gpu_vram: Option<u64>,
    ram_speed: Option<u64>,
    ram_type: Option<u32>,
}

#[cfg(windows)]
static WINDOWS_CIM: OnceLock<WindowsCimSnapshot> = OnceLock::new();

#[cfg(windows)]
fn windows_cim_snapshot() -> &'static WindowsCimSnapshot {
    WINDOWS_CIM.get_or_init(|| {
        // Un único host de PowerShell y una única serialización sustituyen las
        // consultas separadas de placa, socket, GPU y RAM.
        const QUERY: &str = "$b=Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue|Select-Object -First 1;$c=Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue|Select-Object -First 1;$g=Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue|Select-Object -First 1;$m=Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue|Select-Object -First 1;[pscustomobject]@{motherboard=(($b.Manufacturer+' '+$b.Product).Trim());socket=[string]$c.SocketDesignation;gpuName=[string]$g.Name;gpuVram=if($g.AdapterRAM){[uint64]$g.AdapterRAM}else{$null};ramSpeed=if($m.Speed){[uint64]$m.Speed}else{$null};ramType=if($m.SMBIOSMemoryType){[uint32]$m.SMBIOSMemoryType}else{$null}}|ConvertTo-Json -Compress";
        process::output_text(
            "powershell",
            &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", QUERY],
            PROBE_TIMEOUT,
        )
        .and_then(|output| serde_json::from_str(output.trim()).ok())
        .unwrap_or_default()
    })
}

fn read_motherboard() -> String {
    #[cfg(windows)]
    {
        let mut mobo_name = String::new();

        // 1. Lectura ultra-rápida desde el Registro de Windows (0ms)
        let bios_vals = reg_values(r"HKLM\HARDWARE\DESCRIPTION\System\BIOS");
        let get_bios = |k: &str| {
            bios_vals
                .iter()
                .find(|(name, _)| name == k)
                .map(|(_, val)| val.clone())
        };
        let mfg = get_bios("BaseBoardManufacturer").unwrap_or_default();
        let prod = get_bios("BaseBoardProduct").unwrap_or_default();
        if !prod.is_empty() {
            let clean_mfg = mfg
                .replace("ASUSTeK COMPUTER INC.", "ASUS")
                .replace("Micro-Star International Co., Ltd.", "MSI")
                .replace("Gigabyte Technology Co., Ltd.", "Gigabyte");
            let combined = format!("{clean_mfg} {prod}");
            let clean = clean_identity_value(&combined);
            if !clean.is_empty() && clean != "desconocido" {
                mobo_name = clean;
            }
        }

        let cim = windows_cim_snapshot();

        // La consulta agrupada es el único respaldo si el Registro no declara
        // el modelo de placa.
        if mobo_name.is_empty() {
            mobo_name = clean_identity_value(&cim.motherboard);
        }

        let socket_name = cim.socket.trim().replace("Socket", "").trim().to_string();

        if !mobo_name.is_empty() {
            if !socket_name.is_empty() {
                return format!("{mobo_name} ({socket_name})");
            } else {
                return mobo_name;
            }
        }
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let vendor = std::fs::read_to_string("/sys/class/dmi/id/board_vendor").unwrap_or_default();
        let product = std::fs::read_to_string("/sys/class/dmi/id/board_name").unwrap_or_default();
        clean_identity_value(&format!("{} {}", vendor.trim(), product.trim()))
    }

    #[cfg(any(windows, target_os = "macos"))]
    {
        String::new()
    }
}

pub fn gpu_info() -> String {
    clean_gpu_name(&static_hardware().gpu)
}

#[cfg(windows)]
fn read_gpu_vram_bytes() -> Option<u64> {
    // Prioridad 1: Buscar `HardwareInformation.qwMemorySize` en subclaves 0000..0010 del Registro de Windows.
    // Se descarta expresamente 4_294_967_295 (0xFFFFFFFF) por ser el límite máximo de 32 bits de WMI.
    for i in 0..=10 {
        let key = format!(
            r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{i:04}"
        );
        let vals = reg_values(&key);
        for (name, val) in &vals {
            if name.eq_ignore_ascii_case("HardwareInformation.qwMemorySize") {
                if let Some(num) = reg_number(val) {
                    if num > 4_294_967_295 {
                        return Some(num);
                    }
                }
            }
        }
    }
    windows_cim_snapshot().gpu_vram
}

#[cfg(windows)]
fn registry_gpu_name() -> String {
    for i in 0..=10 {
        let key = format!(
            r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{i:04}"
        );
        let values = reg_values(&key);
        for candidate in ["DriverDesc", "HardwareInformation.AdapterString"] {
            if let Some((_, value)) = values
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(candidate))
            {
                let clean = clean_identity_value(value);
                if !clean.is_empty() {
                    return clean;
                }
            }
        }
    }
    String::new()
}

fn read_full_gpu() -> String {
    #[cfg(windows)]
    {
        let vram_64bit = read_gpu_vram_bytes();
        let cim = windows_cim_snapshot();
        let from_registry = registry_gpu_name();
        let clean = preferred_gpu_name(&cim.gpu_name, &from_registry);
        if !clean.is_empty() {
            if let Some(bytes) = vram_64bit {
                let gb = (bytes as f64 / 1024f64.powi(3)).round() as u64;
                return format!("{clean} ({gb} GB)");
            }
            return clean;
        }
    }

    #[cfg(not(windows))]
    {
        clean_gpu_name(&read_gpu_model())
    }

    #[cfg(windows)]
    {
        String::new()
    }
}

pub fn ram_speed_info() -> String {
    static_hardware().ram.clone()
}

fn read_ram_speed() -> String {
    #[cfg(windows)]
    {
        let cim = windows_cim_snapshot();
        let speed = cim.ram_speed.unwrap_or(0);
        let ddr_type = match cim.ram_type.unwrap_or(0) {
            34 => "DDR5",
            26 => "DDR4",
            24 => "DDR3",
            21 => "DDR2",
            _ if speed >= 4800 => "DDR5",
            _ if speed >= 2133 => "DDR4",
            _ => "RAM",
        };
        if speed > 0 {
            return format!("{ddr_type} {speed} MHz");
        }
    }
    String::new()
}

/// Cuánto lleva instalado el sistema, estimado por la fecha de creación de la
/// primera ruta que la tenga.
#[allow(dead_code)]
fn estimate_os_age() -> Option<u64> {
    let system_root = if cfg!(windows) {
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())
    } else {
        "/".to_string()
    };
    let candidates = [
        system_root.as_str(),
        "/etc/os-release",
        "/var/log/installer",
        "/var/log/pacman.log",
        "/var/log/apt/history.log",
        "/var/log/dpkg.log",
    ];
    for candidate in candidates {
        let Ok(meta) = std::fs::metadata(Path::new(candidate)) else {
            continue;
        };
        let created = meta.created().or_else(|_| meta.modified()).ok()?;
        if let Ok(elapsed) = created.elapsed() {
            if elapsed.as_secs() > 0 {
                return Some(elapsed.as_secs());
            }
        }
    }
    None
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskRow {
    device: String,
    mount: String,
    used: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskCacheFile {
    schema: u32,
    fingerprint: String,
    disks: Vec<DiskRow>,
}

fn load_disk_cache(path: &Path, fingerprint: &str) -> Option<Vec<DiskRow>> {
    let text = std::fs::read_to_string(path).ok()?;
    let cache: DiskCacheFile = serde_json::from_str(&text).ok()?;
    (cache.schema == DISK_CACHE_SCHEMA && cache.fingerprint == fingerprint).then_some(cache.disks)
}

fn save_disk_cache(path: &Path, disks: &[DiskRow]) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let value = DiskCacheFile {
        schema: DISK_CACHE_SCHEMA,
        fingerprint: machine_fingerprint(),
        disks: disks.to_vec(),
    };
    let Ok(text) = serde_json::to_string_pretty(&value) else {
        return;
    };
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    if std::fs::write(&temp, text).is_ok() {
        let _ = std::fs::remove_file(path);
        if std::fs::rename(&temp, path).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }
}

/// Los discos montados que merece la pena enseñar. En Linux el original leía
/// `/proc/mounts` y llamaba a `df`; `sysinfo` ya da lo mismo sin lanzar
/// procesos, y de paso funciona igual en las tres plataformas.
#[allow(dead_code)]
fn read_disks() -> Vec<DiskRow> {
    let disks = Disks::new_with_refreshed_list();
    let mut rows: Vec<DiskRow> = disks
        .list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .map(|disk| DiskRow {
            device: disk.name().to_string_lossy().to_string(),
            mount: disk.mount_point().to_string_lossy().to_string(),
            used: disk.total_space().saturating_sub(disk.available_space()),
            total: disk.total_space(),
        })
        .collect();
    rows.sort_by(|a, b| a.mount.cmp(&b.mount));
    rows.dedup_by(|a, b| a.mount == b.mount);
    // El mismo tope que el original: cuatro puntos de montaje bastan para
    // hacerse una idea y el banner no se convierte en una lista de particiones.
    rows.truncate(4);
    rows
}

#[allow(dead_code)]
fn used_percent(used: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        (used as f64 / total as f64 * 100.0).round() as u64
    }
}

fn short_disk_identity(disk: &DiskRow) -> String {
    let mount = disk.mount.trim_end_matches(['/', '\\']);
    if disk.mount == "/" || disk.mount == "\\" {
        return "/".to_string();
    }
    if let Some(name) = mount
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    disk.device
        .trim_start_matches("/dev/")
        .trim_start_matches("\\\\.\\")
        .to_string()
}

fn storage_rows(disks: &[DiskRow], compact: bool, storage_label: &str) -> Vec<(String, String)> {
    if disks.is_empty() {
        return Vec::new();
    }
    if compact {
        let used: u64 = disks.iter().map(|disk| disk.used).sum();
        let total: u64 = disks.iter().map(|disk| disk.total).sum();
        return vec![(
            storage_label.to_string(),
            format!(
                "{} unidades · {} / {} ({}%)",
                disks.len(),
                format_bytes(used),
                format_bytes(total),
                used_percent(used, total)
            ),
        )];
    }

    disks
        .iter()
        .enumerate()
        .map(|(index, disk)| {
            let identity = short_disk_identity(disk);
            let label = if identity.is_empty() {
                format!("{storage_label} {}", index + 1)
            } else {
                format!("{storage_label} {} [{identity}]", index + 1)
            };
            (
                label,
                format!(
                    "{} / {} ({}%)",
                    format_bytes(disk.used),
                    format_bytes(disk.total),
                    used_percent(disk.used, disk.total)
                ),
            )
        })
        .collect()
}

fn compact_storage(pane_count: usize, rows: u16) -> bool {
    pane_count >= 4 || (if rows == 0 { 24 } else { rows as usize }) < 22
}

#[allow(dead_code)]
fn username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "usuario".to_string())
}

/// El nombre de la terminal, arriba del todo y centrado sobre las cajas.
///
/// Va en el banner, que permanece separado del scrollback aunque `clear` borre
/// la salida de la shell: así una pestaña recién limpiada sigue diciendo qué
/// terminal se está usando. El nombre sale de la
/// identidad de la plataforma, así que cada build enseña el suyo — «WinSlim
/// Terminal» en Windows y «LTerminal» en Linux y macOS — sin nada que tocar
/// aquí al compilar para la otra.
#[allow(dead_code)]
fn title_line(display_name: &str, box_width: usize) -> String {
    let padding = box_width.saturating_sub(display_name.chars().count()) / 2;
    format!("{}{BOLD}{CYAN}{display_name}{RESET}", " ".repeat(padding))
}

/// Una caja con título, con las etiquetas alineadas y el ancho igualado entre
/// las tres secciones.
/// Recorta a lo ancho que quepa, con un «…» que avisa de que falta texto. Sin
/// esto, una fila más larga que la caja se salía por la derecha y la terminal
/// la partía en dos, que es como se rompía el banner en una casilla estrecha.
fn ellipsize(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    if max <= 1 {
        return "…".repeat(max);
    }
    let recortado: String = value.chars().take(max - 1).collect();
    format!("{recortado}…")
}

#[allow(dead_code)]
fn section_box(title: &str, rows: &[(String, String)], content_width: usize) -> String {
    let title = ellipsize(title, content_width);
    let title = title.as_str();
    let title_text = format!(" {title} ");
    let title_len = title_text.chars().count();
    let total_width = std::cmp::max(content_width + 4, title_len + 2);
    let top = format!(
        "┌{}{title_text}┐",
        "─".repeat(total_width.saturating_sub(title_len + 2))
    );
    let bottom = format!("└{}┘", "─".repeat(total_width.saturating_sub(2)));
    let label_width = rows
        .iter()
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(0);

    let mut lines = vec![top];
    for (label, value) in rows {
        // Lo que no quepa se recorta aquí: la caja ya tiene un ancho fijo, y
        // dejar pasar un valor más largo la rompe entera.
        let value = ellipsize(value, content_width.saturating_sub(label_width + 2));
        let value = value.as_str();
        let padding = label_width.saturating_sub(label.chars().count());
        // El ancho visible de la fila cuenta la etiqueta YA rellenada. El
        // original medía `label.length` sin el relleno, con lo que las filas de
        // etiqueta corta se pasaban de largo y el borde derecho de la caja
        // quedaba escalonado.
        let raw_length = label_width + 2 + value.chars().count();
        let filler = total_width.saturating_sub(raw_length + 4);
        lines.push(format!(
            "│ {CYAN}{label}{}{RESET}  {value}{} │",
            " ".repeat(padding),
            " ".repeat(filler)
        ));
    }
    lines.push(bottom);
    lines.join("\r\n")
}

/// El banner de una pestaña. Nunca debe tumbar el arranque de un pty por un
/// dato del sistema que falle al leerse: si algo va mal, se devuelve un banner
/// mínimo en vez de nada.
/// El banner sin marco, para cuando la terminal es más estrecha de lo que una
/// caja necesita. Mismo contenido y mismo orden; solo se van los bordes.
#[allow(dead_code)]
fn plain_rows(display_name: &str, sections: &[&Vec<(String, String)>], width: usize) -> String {
    let mut lines = vec![format!("{BOLD}{CYAN}{display_name}{RESET}")];
    let label_width = sections
        .iter()
        .flat_map(|rows| rows.iter())
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(0);
    for rows in sections {
        for (label, value) in rows.iter() {
            let padding = label_width.saturating_sub(label.chars().count());
            let value = ellipsize(value, width.saturating_sub(label_width + 2));
            lines.push(format!(
                "{CYAN}{label}{}{RESET}  {value}",
                " ".repeat(padding)
            ));
        }
    }
    lines.join("\r\n") + "\r\n"
}

/// Ancho mínimo con el que las cajas siguen siendo legibles. Por debajo se
/// dibujan sin marco: un recuadro de 24 columnas deja tan poco sitio al valor
/// que solo se leen puntos suspensivos.
#[allow(dead_code)]
fn clean_cpu_model(raw: &str) -> String {
    let s = raw
        .replace("Processor", "")
        .replace("Core(TM)", "")
        .replace("Core", "")
        .replace("CPU", "")
        .replace("8-Core", "")
        .replace("16-Thread", "")
        .replace("AuthenticAMD", "AMD")
        .replace("GenuineIntel", "Intel");
    let cleaned = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        raw.to_string()
    } else {
        cleaned
    }
}

fn clean_os_name(raw: &str) -> String {
    let s = raw
        .replace("IoT Enterprise LTSC 2024", "IoT Enterprise")
        .replace("Enterprise LTSC 2024", "Enterprise")
        .replace("Enterprise LTSC 2021", "Enterprise")
        .replace("Christianlg97", "")
        .replace("By Christian", "")
        .replace("Rev.27", "")
        .replace("P-1.1.3_050826", "")
        .replace("Build R1.5", "")
        .replace(['{', '}', '|'], "");
    let cleaned = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        "Windows 11".to_string()
    } else {
        cleaned
    }
}

#[allow(dead_code)]
const MIN_BOXED_WIDTH: usize = 40;
const ASSUMED_COLUMNS: usize = 80;

fn banner_item_enabled(hidden_items: &str, item: &str) -> bool {
    !hidden_items.split(',').any(|hidden| hidden == item)
}

fn hex_to_ansi(hex: &str) -> String {
    let hex = hex.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&hex[0..2], 16),
            u8::from_str_radix(&hex[2..4], 16),
            u8::from_str_radix(&hex[4..6], 16),
        ) {
            return format!("\x1b[38;2;{r};{g};{b}m");
        }
    }
    "\x1b[38;2;184;190;198m".to_string()
}

pub fn build_banner(
    env_label: &str,
    app_name: &str,
    columns: u16,
    rows: u16,
    pane_count: usize,
    t: &Translator,
) -> String {
    let display_name = if app_name.trim().is_empty() {
        crate::identity::current().name
    } else {
        app_name.trim()
    };

    // Las pruebas unitarias deben ser reproducibles y no depender del
    // settings.json del usuario que lanza `cargo test` (la E2E cambia esas
    // preferencias deliberadamente). El binario real sigue leyendo siempre
    // la configuración persistente.
    #[cfg(test)]
    let prefs = crate::preferences::Preferences::default();
    #[cfg(not(test))]
    let prefs = crate::preferences::current();
    let accent = hex_to_ansi(&prefs.fastfetch_color);
    let hardware = banner_hardware();
    let show = |item: &str| banner_item_enabled(&prefs.banner_hidden_items, item);

    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());

    let cpu_model = &hardware.cpu_model;

    let total_memory = system.total_memory();
    let used_memory = total_memory.saturating_sub(system.available_memory());

    let identity = os_identity();
    let os_name = clean_os_name(&identity.name);

    let mut system_rows: Vec<(String, String)> = Vec::new();
    if show("system") {
        system_rows.push((t.t("banner.system", "Sistema"), os_name));
    }
    if show("host") {
        if let Some(host) = System::host_name().filter(|value| !value.trim().is_empty()) {
            system_rows.push((t.t("banner.pc", "Equipo"), host));
        }
    }
    if show("kernel") {
        let kernel = System::kernel_version()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| t.t("banner.unknown", "No disponible"));
        system_rows.push((t.t("banner.kernel", "Kernel"), kernel));
    }
    if show("environment") && !env_label.trim().is_empty() {
        system_rows.push((
            t.t("banner.environment", "Entorno"),
            env_label.trim().to_string(),
        ));
    }

    let mut hardware_rows: Vec<(String, String)> = Vec::new();

    let mobo = hardware.motherboard.clone();
    if show("motherboard") && !mobo.is_empty() {
        hardware_rows.push((t.t("banner.motherboard", "Placa"), mobo));
    }

    let logical_cpus = system.cpus().len();
    let physical_cores = System::physical_core_count().unwrap_or(logical_cpus);
    let cpu_desc = if physical_cores > 0 && physical_cores != logical_cpus {
        format!("{cpu_model} ({physical_cores}C/{logical_cpus}T)")
    } else {
        format!("{cpu_model} ({logical_cpus}T)")
    };
    if show("cpu") {
        hardware_rows.push((t.t("banner.cpu", "CPU"), cpu_desc));
    }

    let gpu = clean_gpu_name(&hardware.gpu);
    if show("gpu") && !gpu.is_empty() {
        hardware_rows.push((t.t("banner.gpu", "GPU"), gpu));
    }

    let memory_pct = if total_memory > 0 {
        (used_memory as f64 / total_memory as f64 * 100.0).round() as u64
    } else {
        0
    };
    let ram_extra = hardware.ram.clone();
    let memory_str = if !ram_extra.is_empty() {
        format!(
            "{} / {} ({}%) - {}",
            format_bytes(used_memory),
            format_bytes(total_memory),
            memory_pct,
            ram_extra
        )
    } else {
        format!(
            "{} / {} ({}%)",
            format_bytes(used_memory),
            format_bytes(total_memory),
            memory_pct
        )
    };
    if show("memory") {
        hardware_rows.push((t.t("banner.memory", "Memoria"), memory_str));
    }

    // En un panel grande se conserva una línea por disco, pero se eliminan
    // las rutas completas: saber qué unidad ocupa cuánto es más útil que leer
    // /dev/... o el punto de montaje entero. Con cuatro paneles o poca altura
    // se usa un único resumen para que el banner no empuje el prompt fuera de
    // la zona visible.
    let disks: Vec<_> = cached_disks()
        .into_iter()
        .filter(|disk| disk.total >= 1_000_000_000)
        .collect();
    if show("storage") && !disks.is_empty() {
        hardware_rows.extend(storage_rows(
            &disks,
            compact_storage(pane_count, rows),
            &t.t("banner.storage", "Disco"),
        ));
    }

    let available_cols = if columns == 0 {
        ASSUMED_COLUMNS
    } else {
        columns as usize
    };

    // El ancho depende solo de las columnas reales del panel, no del orden en
    // que se abrió o repintó la pestaña. Así todos los paneles iguales reciben
    // exactamente la misma distribución.
    // `columns` representa exactamente el ancho de texto disponible de xterm;
    // no hay que reservar columnas para una capa flotante.
    let max_line_cols = std::cmp::min(available_cols, 88);
    let max_sep = std::cmp::min(46, max_line_cols.saturating_sub(2));
    // En una casilla extrema (por ejemplo, mientras el divisor arrastra una
    // ventana hasta una sola columna) ni siquiera caben tres guiones. Nunca
    // generar una línea más ancha que el viewport: el separador se adapta al
    // ancho real y conserva al menos un carácter cuando hay espacio.
    let sep_len = if max_line_cols < 3 {
        max_line_cols.max(1)
    } else {
        max_sep.clamp(3, 46)
    };
    let separator = "-".repeat(sep_len);

    let mut session_rows = Vec::new();
    if show("uptime") {
        session_rows.push((
            t.t("banner.uptime", "Tiempo activo"),
            format_uptime(System::uptime()),
        ));
    }
    if show("datetime") {
        session_rows.push((t.t("banner.datetime", "Fecha"), format_now()));
    }
    let sections = [
        (t.t("banner.system", "Sistema"), &system_rows),
        (t.t("banner.hardware", "Hardware"), &hardware_rows),
        (t.t("banner.session", "Sesión"), &session_rows),
    ]
    .into_iter()
    .filter(|(_, rows)| !rows.is_empty())
    .collect::<Vec<_>>();

    let max_label_len = sections
        .iter()
        .flat_map(|(_, rows)| rows.iter())
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(8)
        .min(max_line_cols.saturating_sub(4));

    let mut lines = Vec::new();
    let version = env!("CARGO_PKG_VERSION");
    let title = ellipsize(&format!("{display_name} {version}"), max_line_cols);
    lines.push(format!("{BOLD}{accent}{title}{RESET}"));
    lines.push(format!("\x1b[90m{separator}{RESET}"));

    // Una terminal con muy pocas filas no puede enseñar las tres secciones
    // completas: el prompt desplazaría justo la CPU y la memoria fuera de la
    // vista. Conservamos la identidad y los datos esenciales en una línea por
    // campo; el modo normal sigue mostrando todas las secciones y discos.
    // El inspector acoplado y el explorador pueden dejar una casilla de unas
    // 20 filas aunque la ventana exterior parezca grande. Durante el primer
    // frame tras un resize el PTY puede conservar temporalmente el tamaño
    // anterior; solo se compacta cuando el viewport es realmente bajo.
    // Con 25 filas o más cabe el formato legible (secciones, aire y divisor
    // antes del prompt). El umbral anterior de 40 activaba el modo compacto
    // en una ventana normal y hacía que fastfetch pareciera una lista pegada.
    // El modo compacto necesita espacio para el prompt además de sus datos.
    // En casillas menores se omite de forma explícita para no desplazar la
    // entrada; una nueva sesión o una orden explícita podrá volver a mostrarlo.
    if rows > 0 && usize::from(rows) < 12 {
        return String::new();
    }
    let compact_vertical = rows > 0 && usize::from(rows) <= 24;
    // Una división de tres o cuatro paneles puede conservar muchas filas en
    // el PTY, pero cada celda ya no tiene anchura suficiente para tres
    // secciones completas. Compactar también por anchura evita que el banner
    // empuje el prompt fuera de la vista durante un redimensionado.
    // Una vista dividida debe ser homogénea aunque una de sus casillas sea
    // más ancha (por ejemplo, la tercera de la rejilla 1+2). Si cada panel
    // decide por separado entre el formato completo y el compacto, al pasar
    // de 2 a 3/4 quedan cabeceras visualmente distintas y es fácil confundir
    // un repintado pendiente con una parte perdida del banner.
    let compact_layout = compact_vertical || available_cols < 88 || pane_count > 1;
    let compact_rows = if compact_layout {
        let cpu_label = t.t("banner.cpu", "CPU");
        let memory_label = t.t("banner.memory", "Memoria");
        let storage_label = t.t("banner.storage", "Disco");
        let uptime_label = t.t("banner.uptime", "Tiempo activo");
        let datetime_label = t.t("banner.datetime", "Fecha");
        let mut compact = Vec::new();
        macro_rules! take_row {
            ($source:expr, $label:expr) => {
                if let Some(row) = $source.iter().find(|(row_label, _)| row_label == $label) {
                    compact.push(row.clone());
                }
            };
        }

        // El orden es deliberado: en el perfil esencial caben CPU, Uptime y
        // Memoria además del título y el sistema.
        take_row!(hardware_rows, &cpu_label);
        take_row!(session_rows, &uptime_label);
        take_row!(hardware_rows, &memory_label);

        // En modo estrecho se mantiene el resumen de discos; con más filas,
        // `storage_rows` puede aportar una línea por unidad y se muestran de
        // forma progresiva junto con el resto de datos configurables.
        for row in hardware_rows.iter().filter(|(label, _)| {
            label == &storage_label || label.starts_with(&format!("{storage_label} "))
        }) {
            compact.push(row.clone());
        }

        take_row!(system_rows, &t.t("banner.pc", "Equipo"));
        take_row!(system_rows, &t.t("banner.kernel", "Kernel"));
        take_row!(system_rows, &t.t("banner.environment", "Entorno"));
        take_row!(hardware_rows, &t.t("banner.motherboard", "Placa"));
        take_row!(hardware_rows, &t.t("banner.gpu", "GPU"));
        take_row!(session_rows, &datetime_label);

        Some(compact)
    } else {
        None
    };

    let format_row = |label: &str, value: &str| {
        // El formato habitual alinea la columna de valores con dos espacios,
        // pero esos espacios no pueden convertirse en un desbordamiento en
        // casillas de 1–3 columnas. Se calcula el presupuesto después de
        // recortar la etiqueta y solo se inserta el hueco que realmente cabe.
        let label_budget = max_label_len.min(max_line_cols);
        let label = ellipsize(label, label_budget);
        let label_len = label.chars().count();
        let padding = max_label_len
            .saturating_sub(label_len)
            .min(max_line_cols.saturating_sub(label_len));
        let base_len = label_len + padding;
        let gap = if max_line_cols > base_len {
            (max_line_cols - base_len).min(2)
        } else {
            0
        };
        let max_val_len = max_line_cols.saturating_sub(base_len + gap);
        let val_trimmed = ellipsize(value, max_val_len);

        format!(
            "{accent}{label}{RESET}{}{}{}",
            " ".repeat(padding),
            " ".repeat(gap),
            val_trimmed
        )
    };

    if let Some(rows) = compact_rows.as_ref() {
        // En compacto cada dato ocupa su propia fila. Esto evita que Uptime,
        // discos o una etiqueta traducida se peguen a otra información y
        // hagan que xterm envuelva una línea. La lista se recorta al espacio
        // real disponible al final de la función, dejando que el contenido
        // aparezca completo en una única salida, sin depender de repintados.
        let title_text = ellipsize(&format!("{display_name} {version}"), max_line_cols);
        let system = system_rows
            .iter()
            .find(|(label, _)| label == &t.t("banner.system", "Sistema"));
        lines.clear();
        lines.push(format!("{BOLD}{accent}{}{RESET}", title_text));
        // En el modo compacto el título y el sistema no se pegan en una sola
        // línea. En Windows el nombre de la edición puede ser largo
        // (`Windows 11 IoT Enterprise ...`) y, junto al nombre de la app,
        // producía una cabecera difícil de leer y demasiado sensible al
        // ancho del panel. Cada línea se recorta por separado.
        if let Some((system_label, system_value)) = system {
            lines.push(format_row(system_label, system_value));
        }
        for (label, value) in rows {
            if label == &t.t("banner.system", "Sistema") {
                continue;
            }
            lines.push(format_row(label, value));
        }
    } else {
        let mut first_section = true;
        for (section, rows) in sections {
            if !first_section {
                lines.push(String::new());
            }
            first_section = false;
            lines.push(format!(
                "{BOLD}{accent}{}:{RESET}",
                ellipsize(&section, max_line_cols)
            ));
            for (label, value) in rows {
                lines.push(format_row(label, value));
            }
        }
    }

    if compact_rows.is_none() {
        lines.push(format!("\x1b[90m{separator}{RESET}"));
        // Dejar una línea limpia después del divisor hace visible dónde acaba
        // el fastfetch y evita que el prompt quede pegado a la última métrica.
        lines.push(String::new());
    }

    // La entrada siempre conserva cinco filas después del banner. Es el
    // espacio mínimo útil para ver el prompt y escribir uno o dos comandos,
    // incluso cuando el inspector está acoplado o el explorador ha reducido
    // la celda. Si no queda sitio, se oculta el banner temporalmente: nunca
    // se sacrifica la zona de trabajo del usuario.
    if rows > 0 {
        let available_banner_rows = usize::from(rows).saturating_sub(5);
        lines.truncate(available_banner_rows);
    }
    if lines.is_empty() {
        String::new()
    } else {
        lines.join("\r\n") + "\r\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached_hardware(fingerprint: &str) -> StaticHardware {
        StaticHardware {
            schema: HARDWARE_CACHE_SCHEMA,
            fingerprint: fingerprint.to_string(),
            cpu_model: "CPU de prueba".to_string(),
            motherboard: "Placa de prueba".to_string(),
            gpu: "GPU de prueba (8 GB)".to_string(),
            ram: "DDR5 6000 MHz".to_string(),
        }
    }

    #[test]
    fn cada_disco_se_muestra_con_su_capacidad_sin_ruta_completa() {
        let gb = 1024u64.pow(3);
        let disks = vec![
            DiskRow {
                device: "/dev/nvme0n1p1".into(),
                mount: "/".into(),
                used: 300 * gb,
                total: 500 * gb,
            },
            DiskRow {
                device: "/dev/sdb1".into(),
                mount: "/mnt/JuegosLinux".into(),
                used: 100 * gb,
                total: 200 * gb,
            },
        ];
        let rows = storage_rows(&disks, false, "Disco");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "Disco 1 [/]");
        assert_eq!(rows[1].0, "Disco 2 [JuegosLinux]");
        assert!(rows[0].1.contains("300.0 GB / 500.0 GB"));
        assert!(!rows[1].1.contains("/dev/"));
    }

    #[test]
    fn cuatro_pantallas_pueden_usar_un_resumen_de_discos() {
        let gb = 1024u64.pow(3);
        let disks = vec![
            DiskRow {
                device: "C:\\".into(),
                mount: "C:\\".into(),
                used: 300 * gb,
                total: 500 * gb,
            },
            DiskRow {
                device: "D:\\".into(),
                mount: "D:\\".into(),
                used: 100 * gb,
                total: 200 * gb,
            },
        ];
        let rows = storage_rows(&disks, true, "Disco");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.contains("2 unidades"));
        assert!(rows[0].1.contains("400.0 GB / 700.0 GB"));
    }

    #[test]
    fn el_espacio_vertical_tambien_activa_el_modo_compacto() {
        assert!(compact_storage(4, 40));
        assert!(compact_storage(1, 21));
        assert!(!compact_storage(2, 22));
        assert!(!compact_storage(1, 0));
    }

    #[test]
    fn el_banner_vertical_compacto_conserva_la_informacion_esencial() {
        let banner = build_banner("fish", "LTerminal", 60, 14, 2, &Translator::default());
        assert!(banner.contains("LTerminal"), "{banner}");
        assert!(banner.contains("Sistema"), "{banner}");
        assert!(banner.contains("CPU"), "{banner}");
        assert!(banner.contains("Memoria"), "{banner}");
        assert!(
            banner.contains("Tiempo activo") || banner.contains("Uptime"),
            "{banner}"
        );
        for line in banner.lines() {
            assert!(
                crate::current_dir::strip_ansi(line).chars().count() <= 60,
                "{line:?}"
            );
        }
    }

    #[test]
    fn el_banner_compacto_separa_titulo_y_sistema() {
        let lines: Vec<String> = build_banner(
            "cmd.exe",
            "WinSlim Terminal",
            80,
            24,
            1,
            &Translator::default(),
        )
        .lines()
        .map(crate::current_dir::strip_ansi)
        .collect();
        assert!(lines
            .first()
            .is_some_and(|line| line.contains("WinSlim Terminal")));
        assert!(lines
            .get(1)
            .is_some_and(|line| line.starts_with("Sistema  ")));
        assert!(!lines.first().is_some_and(|line| line.contains("Sistema")));
    }

    #[test]
    fn la_cache_de_hardware_exige_esquema_y_maquina_correctos() {
        assert!(valid_hardware_cache(cached_hardware("equipo-a"), "equipo-a").is_some());
        assert!(valid_hardware_cache(cached_hardware("equipo-a"), "equipo-b").is_none());
        let mut antigua = cached_hardware("equipo-a");
        antigua.schema = HARDWARE_CACHE_SCHEMA + 1;
        assert!(valid_hardware_cache(antigua, "equipo-a").is_none());
    }

    #[test]
    fn la_cache_de_hardware_se_reabre_sin_perder_campos() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hardware-cache.json");
        let expected = cached_hardware("equipo-a");
        save_hardware_cache(&file, &expected);
        assert_eq!(load_hardware_cache(&file, "equipo-a"), Some(expected));
    }

    #[test]
    fn los_emojis_y_adornos_desaparecen_del_nombre() {
        assert_eq!(
            clean_identity_value("🚀 ~ LTerminal 10 ~ 🚀"),
            "LTerminal 10"
        );
        assert_eq!(clean_identity_value("|-- Debian --|"), "Debian");
    }

    #[test]
    fn los_espacios_repetidos_se_colapsan() {
        assert_eq!(
            clean_identity_value("Windows   11    Pro"),
            "Windows 11 Pro"
        );
    }

    #[test]
    fn las_tildes_normales_se_conservan() {
        assert_eq!(clean_identity_value("Edición Española"), "Edición Española");
    }

    #[test]
    fn un_valor_vacio_no_rompe_nada() {
        assert_eq!(clean_identity_value(""), "");
        assert_eq!(clean_identity_value("   ~~~   "), "");
    }

    #[test]
    fn los_tamanos_se_muestran_en_gigabytes() {
        assert_eq!(format_bytes(0), "0.0 GB");
        assert_eq!(format_bytes(8 * 1024 * 1024 * 1024), "8.0 GB");
    }

    #[test]
    fn el_uptime_omite_los_tramos_vacios_pero_nunca_los_minutos() {
        assert_eq!(format_uptime(0), "0m");
        assert_eq!(format_uptime(90), "1m");
        assert_eq!(format_uptime(3 * 3600 + 5 * 60), "3h 5m");
        assert_eq!(format_uptime(2 * 86_400 + 3600), "2d 1h 0m");
    }

    #[test]
    fn el_porcentaje_de_uso_no_divide_por_cero() {
        assert_eq!(used_percent(0, 0), 0);
        assert_eq!(used_percent(50, 200), 25);
    }

    #[test]
    fn se_parsea_la_salida_de_reg_query() {
        // `reg query` indenta cada valor con exactamente cuatro espacios; la
        // línea de la propia clave va sin indentar.
        let salida = [
            "",
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
            "    ProductName    REG_SZ    Windows 10 Pro",
            "    CurrentBuild    REG_SZ    19044",
            "    UBR    REG_DWORD    0x1cf9",
            "",
        ]
        .join("\r\n");
        let values = parse_reg_query(&salida);
        let get = |key: &str| {
            values
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("ProductName"), Some("Windows 10 Pro"));
        assert_eq!(get("CurrentBuild"), Some("19044"));
        assert_eq!(reg_number(get("UBR").unwrap()), Some(7417));
    }

    #[test]
    fn una_clave_de_registro_vacia_no_da_valores() {
        assert!(parse_reg_query("").is_empty());
        assert!(parse_reg_query("HKEY_LOCAL_MACHINE\\SOFTWARE\r\n").is_empty());
    }

    #[test]
    fn se_lee_el_nombre_bonito_de_os_release() {
        let contenido = "NAME=\"Ubuntu\"\nVERSION=\"22.04.3 LTS\"\nPRETTY_NAME=\"Ubuntu 22.04.3 LTS\"\nID=ubuntu\n";
        let values = parse_os_release(contenido);
        let get = |key: &str| {
            values
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("PRETTY_NAME"), Some("Ubuntu 22.04.3 LTS"));
        assert_eq!(get("ID"), Some("ubuntu"));
    }

    #[test]
    fn wmic_devuelve_la_primera_tarjeta_tras_la_cabecera() {
        let salida = "Name\r\nNVIDIA GeForce RTX 3060\r\nIntel UHD Graphics\r\n";
        assert_eq!(parse_wmic_gpu(salida), "NVIDIA GeForce RTX 3060");
        // Sin cabecera (una sola línea) se devuelve esa.
        assert_eq!(parse_wmic_gpu("Radeon\r\n"), "Radeon");
        assert_eq!(parse_wmic_gpu(""), "");
    }

    #[test]
    fn lspci_se_queda_con_el_modelo() {
        let salida = "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation TU116 [GeForce GTX 1660] [10de:2184] (rev a1)";
        assert_eq!(
            parse_lspci_gpu(salida),
            "NVIDIA Corporation TU116 [GeForce GTX 1660]"
        );
        let amd = "05:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Picasso [Radeon Vega 8 Graphics] [1002:15d8] (rev c8)";
        assert_eq!(
            parse_lspci_gpu(amd),
            "Advanced Micro Devices, Inc. [AMD/ATI] Picasso [Radeon Vega 8 Graphics]"
        );
        let mm = "01:00.0\t\"VGA compatible controller\"\t\"NVIDIA\"\t\"GA106 [RTX 3060]\"";
        assert_eq!(parse_lspci_gpu(mm), "NVIDIA GA106 [RTX 3060]");
        assert_eq!(parse_lspci_gpu(""), "");
    }

    #[test]
    fn gpu_quita_el_sufijo_tecnico_y_prefiere_el_modelo_comercial() {
        assert_eq!(clean_gpu_name("NVidia Corporation TU116s"), "NVIDIA TU116");
        assert_eq!(
            clean_gpu_name("NVIDIA Corporation TU116 [GeForce GTX 1660]"),
            "NVIDIA GeForce GTX 1660"
        );
        assert_eq!(
            clean_gpu_name(
                "Advanced Micro Devices, Inc. [AMD/ATI] Picasso [Radeon Vega 8 Graphics]"
            ),
            "AMD Radeon Vega 8 Graphics"
        );
    }

    #[test]
    fn gpu_prefiere_el_registro_si_wmi_devuelve_un_adaptador_generico() {
        assert_eq!(
            preferred_gpu_name(
                "Microsoft Basic Display Adapter",
                "AMD Radeon Vega 8 Graphics"
            ),
            "AMD Radeon Vega 8 Graphics"
        );
        assert_eq!(
            preferred_gpu_name("Microsoft Basic Display Adapter", ""),
            "Microsoft Basic Display Adapter"
        );
        assert!(is_generic_gpu_name("Microsoft Basic Display Adapter"));
        assert!(is_generic_gpu_name("VMware SVGA 3D"));
        assert!(!is_generic_gpu_name("AMD Radeon Vega 8 Graphics"));
    }

    #[test]
    fn la_caja_alinea_las_columnas_y_cierra_a_la_misma_anchura() {
        let filas = vec![
            ("CPU".to_string(), "x86".to_string()),
            ("Memoria".to_string(), "8.0 GB".to_string()),
        ];
        let caja = section_box("Hardware", &filas, 46);
        // Los códigos de color no ocupan columna en pantalla: se quitan antes
        // de medir.
        let anchos: Vec<usize> = caja
            .split("\r\n")
            .map(|line| crate::current_dir::strip_ansi(line).chars().count())
            .collect();
        assert!(
            anchos.windows(2).all(|par| par[0] == par[1]),
            "líneas de distinta anchura: {anchos:?}"
        );
        assert!(caja.starts_with('┌'));
        assert!(caja.ends_with('┘'));
    }

    #[test]
    fn el_banner_real_se_genera_con_los_datos_universales_del_sistema() {
        let t = Translator::default();
        let banner = build_banner("cmd.exe", "LTerminal", 120, 80, 1, &t);
        assert!(banner.contains("Sistema"), "{banner}");
        assert!(banner.contains("CPU"), "{banner}");
        assert!(banner.contains("Memoria"), "{banner}");
        // El perfil esencial oculta Kernel por defecto para conservar un
        // bloque breve (5–8 líneas). Cuando el usuario activa ese elemento
        // (perfil completo o Ajustes), sí debe aparecer; la aserción respeta
        // ambos perfiles sin depender del host donde corre el test.
        let prefs = crate::preferences::Preferences::default();
        if banner_item_enabled(&prefs.banner_hidden_items, "kernel") {
            assert!(banner.contains("Kernel"), "{banner}");
        }
        assert!(
            banner.contains(&t.t("banner.uptime", "Tiempo activo")),
            "{banner}"
        );
        assert!(banner.ends_with("\r\n"));
    }

    #[test]
    fn el_banner_legible_separa_secciones_y_prompt() {
        let banner = build_banner(
            "cmd.exe",
            "WinSlim Terminal",
            120,
            40,
            1,
            &Translator::default(),
        );
        let lines: Vec<String> = banner.lines().map(crate::current_dir::strip_ansi).collect();
        assert!(lines.iter().any(|line| line.is_empty()), "{banner}");
        assert!(
            lines.iter().filter(|line| line.starts_with("---")).count() >= 2,
            "{banner}"
        );
        assert!(lines.iter().any(|line| line == "Sistema:"), "{banner}");
        assert!(lines.iter().any(|line| line == "Hardware:"), "{banner}");
        assert!(lines.iter().any(|line| line == "Sesión:"), "{banner}");
    }

    #[test]
    fn el_banner_compacto_conserva_datos_esenciales_sin_rutas_de_disco() {
        let t = Translator::default();
        let banner = build_banner("fish", "LTerminal", 120, 20, 2, &t);
        assert!(!banner.contains("/dev/"), "{banner}");
        assert!(banner.contains("Sistema"), "{banner}");
        assert!(banner.contains("CPU"), "{banner}");
        assert!(banner.contains("Memoria"), "{banner}");
    }

    #[test]
    fn una_rejilla_mantiene_el_mismo_formato_en_todas_sus_casillas() {
        let t = Translator::default();
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 120, 40, 4, &t);
        let lineas: Vec<_> = banner.lines().map(crate::current_dir::strip_ansi).collect();
        assert!(
            lineas.iter().any(|linea| linea.starts_with("CPU")),
            "{banner}"
        );
        assert!(!lineas.iter().any(|linea| linea == "Hardware:"), "{banner}");
        assert!(!lineas.iter().any(|linea| linea == "Sesión:"), "{banner}");
    }

    #[test]
    fn el_uptime_tiene_linea_propia_en_compacto() {
        let t = Translator::default();
        let banner = build_banner("fish", "LTerminal", 60, 20, 2, &t);
        let uptime = t.t("banner.uptime", "Tiempo activo");
        let memory = t.t("banner.memory", "Memoria");
        let uptime_line = banner
            .lines()
            .map(crate::current_dir::strip_ansi)
            .find(|line| line.contains(&uptime))
            .unwrap_or_default();
        assert!(!uptime_line.contains(&memory), "{banner}");
    }

    #[test]
    fn cinco_filas_de_trabajo_dejan_el_banner_fuera() {
        let banner = build_banner("fish", "LTerminal", 120, 5, 1, &Translator::default());
        assert!(banner.is_empty(), "{banner}");
    }

    #[test]
    fn una_casilla_demasiado_baja_no_deja_la_cola_del_banner() {
        for rows in [6, 9, 11] {
            let banner = build_banner("cmd.exe", "LTerminal", 120, rows, 2, &Translator::default());
            assert!(banner.is_empty(), "rows={rows}: {banner}");
        }
    }

    /// El nombre va ARRIBA DEL TODO y es el de la build que se está ejecutando.
    #[test]
    fn el_banner_abre_con_el_nombre_de_la_terminal() {
        let t = Translator::default();
        for nombre in [crate::identity::WINDOWS.name, crate::identity::LINUX.name] {
            let banner = build_banner("cmd.exe", nombre, 120, 40, 1, &t);
            let primera = crate::current_dir::strip_ansi(banner.lines().next().unwrap());
            assert!(primera.contains(nombre), "{banner}");
        }
    }

    #[test]
    fn un_nombre_vacio_usa_la_identidad_de_la_build() {
        let banner = build_banner("cmd.exe", "", 120, 40, 1, &Translator::default());
        let primera = crate::current_dir::strip_ansi(banner.lines().next().unwrap());
        assert!(
            primera.contains(crate::identity::current().name),
            "{banner}"
        );
    }

    #[test]
    fn el_nombre_abre_el_banner() {
        let banner = build_banner("cmd.exe", "LTerminal", 120, 40, 1, &Translator::default());
        let lineas: Vec<String> = banner.lines().map(crate::current_dir::strip_ansi).collect();
        let titulo = &lineas[0];
        assert!(titulo.contains("LTerminal"));
    }

    /// El fallo que se veia al dividir la ventana: el banner se dibujaba con el
    /// ancho que pidiera el contenido y la terminal partia cada linea por la
    /// mitad, dejando el marco hecho pedazos.
    #[test]
    fn ninguna_linea_del_banner_pasa_del_ancho_de_la_terminal() {
        let t = Translator::default();
        // Cubre desde un panel estrecho hasta el viewport que puede producir
        // una ventana 8K con una celda de unos 8px: no probamos solo tamaños
        // de escritorio habituales, también los límites que usa el backend.
        for columnas in [
            1u16, 2, 3, 4, 5, 40, 55, 60, 80, 120, 200, 320, 480, 768, 960,
        ] {
            let banner = build_banner("cmd.exe", "LTerminal", columnas, 40, 1, &t);
            for linea in banner.lines() {
                let ancho = crate::current_dir::strip_ansi(linea).chars().count();
                assert!(
                    ancho <= columnas as usize,
                    "linea de {ancho} columnas con terminal de {columnas}: {linea:?}"
                );
            }
        }
    }

    #[test]
    fn el_banner_de_ancho_extremo_no_desborda_ni_pierde_su_cabecera() {
        let t = Translator::default();
        for columnas in [1u16, 2, 3, 4, 5] {
            let banner = build_banner("cmd.exe", "WinSlim Terminal", columnas, 40, 1, &t);
            for linea in banner.lines() {
                let ancho = crate::current_dir::strip_ansi(linea).chars().count();
                assert!(ancho <= columnas as usize, "{columnas}: {linea:?}");
            }
            assert!(
                banner.lines().next().is_some_and(|linea| !linea.is_empty()),
                "{columnas}: {banner:?}"
            );
        }
    }

    #[test]
    fn cada_panel_de_una_rejilla_recibe_un_banner_autocontenido() {
        let t = Translator::default();
        // Las dimensiones pequeñas son las que más fácilmente dejan restos
        // de una pintura anterior: cada panel debe empezar por su propia
        // cabecera y no generar líneas que xterm parta por la mitad.
        for (columnas, filas) in [(48u16, 14u16), (58, 17), (80, 22), (120, 30)] {
            for paneles in [2usize, 3, 4] {
                let banner =
                    build_banner("cmd.exe", "WinSlim Terminal", columnas, filas, paneles, &t);
                let lineas: Vec<_> = banner.lines().map(crate::current_dir::strip_ansi).collect();
                assert!(
                    lineas
                        .first()
                        .is_some_and(|linea| linea.contains("WinSlim Terminal")),
                    "panel {paneles} de {columnas}x{filas}: {banner:?}"
                );
                assert!(
                    lineas
                        .iter()
                        .all(|linea| linea.chars().count() <= columnas as usize),
                    "panel {paneles} de {columnas}x{filas}: {lineas:?}"
                );
                assert!(
                    lineas.len() <= usize::from(filas.saturating_sub(5)),
                    "panel {paneles} de {columnas}x{filas}: {lineas:?}"
                );
            }
        }
    }

    /// Por debajo del minimo se sueltan los bordes: tres cajas de puntos
    /// suspensivos no las lee nadie.
    #[test]
    fn en_una_casilla_muy_estrecha_el_banner_pierde_el_marco() {
        let banner = build_banner("cmd.exe", "LTerminal", 30, 20, 1, &Translator::default());
        assert!(!banner.contains('\u{250c}'), "{banner}");
        // Pero sigue diciendo lo mismo.
        assert!(banner.contains("CPU"), "{banner}");
        assert!(banner.contains("Sistema"), "{banner}");
        for linea in banner.lines() {
            assert!(
                crate::current_dir::strip_ansi(linea).chars().count() <= 30,
                "{linea:?}"
            );
        }
    }

    /// Sin tamano conocido se supone el clasico de 80 columnas, no un ancho
    /// cualquiera que volviera a romper el marco.
    #[test]
    fn sin_saber_el_ancho_se_supone_una_terminal_de_ochenta() {
        let banner = build_banner("cmd.exe", "LTerminal", 0, 24, 1, &Translator::default());
        for linea in banner.lines() {
            assert!(
                crate::current_dir::strip_ansi(linea).chars().count() <= 80,
                "{linea:?}"
            );
        }
    }

    #[test]
    fn lo_que_no_cabe_se_recorta_con_puntos_suspensivos() {
        assert_eq!(ellipsize("abcdef", 10), "abcdef");
        assert_eq!(ellipsize("abcdef", 6), "abcdef");
        assert_eq!(ellipsize("abcdef", 4), "abc\u{2026}");
        assert_eq!(ellipsize("abcdef", 1), "\u{2026}");
        assert_eq!(ellipsize("abcdef", 0), "");
    }

    #[test]
    fn el_banner_traducido_usa_las_etiquetas_del_catalogo() {
        let banner = build_banner("bash", "App", 120, 40, 1, &Translator::new("en"));
        assert!(banner.contains("Memory"), "{banner}");
    }

    #[test]
    fn la_identidad_del_sistema_nunca_queda_vacia() {
        assert!(!os_identity().name.trim().is_empty());
    }
}
