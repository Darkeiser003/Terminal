//! Panel de información del sistema estilo fastfetch/neofetch, que se imprime
//! al abrir cada pestaña y bajo demanda con el alias `sysinfo`.
//!
//! Port de `electron/main/systemInfo.js`. Donde el original usaba el módulo
//! `os` de Node, aquí está el crate `sysinfo`; el resto (identidad real del SO,
//! GPU, discos) sigue leyéndose igual: del registro en Windows, de
//! `/etc/os-release` en Linux y de `sw_vers` en macOS.

use std::path::Path;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use sysinfo::{Disks, System};

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
/// personalizados tipo "🚀 ~ WinSlim 10 ~ 🚀") y colapsa espacios: el banner se
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
    /// Marca de una ISO personalizada (WinSlim y compañía), leída de la
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

/// Lee los valores de una clave del registro con `reg query`, que viene siempre
/// con Windows y no necesita ningún módulo nativo. Los REG_DWORD llegan como
/// "0x1cf9" y se dejan tal cual; quien los quiera como número los convierte.
#[allow(dead_code)]
fn reg_values(key: &str) -> Vec<(String, String)> {
    let Some(output) = process::output_text("reg", &["query", key], PROBE_TIMEOUT) else {
        return Vec::new();
    };
    parse_reg_query(&output)
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

    // Las ISOs personalizadas (WinSlim y compañía) escriben su marca en la
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
            "command -v lspci >/dev/null 2>&1 && lspci -mm | grep -Ei \"vga|3d|display\" | head -n 1",
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

/// `lspci -mm` separa los campos por tabulador: los dos primeros son el bus y
/// la clase, y el modelo empieza en el tercero.
#[allow(dead_code)]
fn parse_lspci_gpu(output: &str) -> String {
    if output.is_empty() {
        return String::new();
    }
    let joined = output.split('\t').skip(2).collect::<Vec<_>>().join(" ");
    let joined = joined.trim();
    if !joined.is_empty() {
        return joined.to_string();
    }
    // Sin tabuladores (formato antiguo): se quita el prefijo hasta los dos
    // puntos y el identificador entre corchetes del final.
    let without_prefix = output
        .split_once(": ")
        .map(|(_, rest)| rest)
        .unwrap_or(output)
        .trim();
    match without_prefix
        .strip_suffix(']')
        .and_then(|rest| rest.rsplit_once('['))
    {
        Some((head, _)) => head.trim().to_string(),
        None => without_prefix.to_string(),
    }
}

static MOBO_CACHE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static GPU_CACHE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static RAM_CACHE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Precarga en segundo plano al arrancar la app para que la primera pestaña
/// abra al instante (< 1ms) sin esperar a las consultas de hardware.
pub fn prewarm_hardware_info() {
    std::thread::spawn(|| {
        let _ = os_identity();
        let _ = motherboard_info();
        let _ = gpu_info();
        let _ = ram_speed_info();
    });
}

pub fn motherboard_info() -> String {
    let mut cache = MOBO_CACHE.lock();
    if let Some(mobo) = cache.as_ref() {
        return mobo.clone();
    }
    let detected = read_motherboard();
    *cache = Some(detected.clone());
    detected
}

fn read_motherboard() -> String {
    if cfg!(windows) {
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

        // 2. WMIC estándar como respaldo para el nombre de la placa
        if mobo_name.is_empty() {
            if let Some(out) = process::output_text(
                "wmic",
                &["baseboard", "get", "Manufacturer,Product"],
                PROBE_TIMEOUT,
            ) {
                for line in out.lines().map(str::trim) {
                    if line.is_empty()
                        || line.eq_ignore_ascii_case("Manufacturer  Product")
                        || line.starts_with("Manufacturer")
                    {
                        continue;
                    }
                    let clean = clean_identity_value(line);
                    if !clean.is_empty() {
                        mobo_name = clean;
                        break;
                    }
                }
            }
        }

        // 3. Detección del Socket del procesador
        let mut socket_name = String::new();
        if let Some(out) =
            process::output_text("wmic", &["cpu", "get", "SocketDesignation"], PROBE_TIMEOUT)
        {
            for line in out.lines().map(str::trim) {
                if line.is_empty() || line.eq_ignore_ascii_case("SocketDesignation") {
                    continue;
                }
                let clean_sock = line.replace("Socket", "").trim().to_string();
                if !clean_sock.is_empty() {
                    socket_name = clean_sock;
                    break;
                }
            }
        }
        if socket_name.is_empty() {
            if let Some(out) = process::output_text(
                "powershell",
                &[
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_Processor).SocketDesignation",
                ],
                PROBE_TIMEOUT,
            ) {
                let clean_sock = out.trim().replace("Socket", "").trim().to_string();
                if !clean_sock.is_empty() {
                    socket_name = clean_sock;
                }
            }
        }

        if !mobo_name.is_empty() {
            if !socket_name.is_empty() {
                return format!("{mobo_name} ({socket_name})");
            } else {
                return mobo_name;
            }
        }
    }
    String::new()
}

pub fn gpu_info() -> String {
    let mut cache = GPU_CACHE.lock();
    if let Some(gpu) = cache.as_ref() {
        return gpu.clone();
    }
    let detected = read_full_gpu();
    *cache = Some(detected.clone());
    detected
}

fn read_gpu_vram_bytes() -> Option<u64> {
    if cfg!(windows) {
        // Prioridad 1: Buscar `HardwareInformation.qwMemorySize` en subclaves 0000..0010 del Registro de Windows.
        // Se descarta expresamente 4_294_967_295 (0xFFFFFFFF) por ser el límite máximo de 32 bits de WMI.
        for i in 0..10 {
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

        // Prioridad 2: Buscar en PowerShell el valor QWORD de 64 bits > 4GB
        if let Some(out) = process::output_text(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' -ErrorAction SilentlyContinue | ForEach-Object { $_.'HardwareInformation.qwMemorySize' } | Where-Object { $_ -and $_ -gt 4294967295 } | Select-Object -First 1",
            ],
            PROBE_TIMEOUT,
        ) {
            if let Ok(bytes) = out.trim().parse::<u64>() {
                if bytes > 4_294_967_295 {
                    return Some(bytes);
                }
            }
        }
    }
    None
}

fn read_full_gpu() -> String {
    if cfg!(windows) {
        let vram_64bit = read_gpu_vram_bytes();

        // 1. PowerShell CIM query combinada con lectura de QWORD >4GB
        if let Some(out) = process::output_text(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "$g = Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, AdapterRAM; $qw = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' -ErrorAction SilentlyContinue | ForEach-Object { $_.'HardwareInformation.qwMemorySize' } | Where-Object { $_ -and $_ -gt 4294967295 } | Select-Object -First 1; $v = if ($qw) { $qw } else { $g.AdapterRAM }; if ($g) { Write-Output ($g.Name + '|' + $v) }",
            ],
            PROBE_TIMEOUT,
        ) {
            let trimmed = out.trim();
            if let Some((name_str, ram_str)) = trimmed.split_once('|') {
                let clean = clean_identity_value(name_str);
                if !clean.is_empty() {
                    let bytes = vram_64bit.unwrap_or_else(|| {
                        ram_str.trim().parse::<u64>().unwrap_or(0)
                    });
                    if bytes >= 500_000_000 {
                        let gb = (bytes as f64 / 1024f64.powi(3)).round() as u64;
                        return format!("{clean} ({gb} GB)");
                    }
                    return clean;
                }
            } else if !trimmed.is_empty() {
                let clean = clean_identity_value(trimmed);
                if !clean.is_empty() {
                    if let Some(bytes) = vram_64bit {
                        let gb = (bytes as f64 / 1024f64.powi(3)).round() as u64;
                        return format!("{clean} ({gb} GB)");
                    }
                    return clean;
                }
            }
        }

        // 2. WMIC básico sin /format:csv
        let basic = read_gpu_model();
        let clean = clean_identity_value(&basic);
        if !clean.is_empty() {
            if let Some(bytes) = vram_64bit {
                let gb = (bytes as f64 / 1024f64.powi(3)).round() as u64;
                return format!("{clean} ({gb} GB)");
            }
            return clean;
        }
    }
    String::new()
}

pub fn ram_speed_info() -> String {
    let mut cache = RAM_CACHE.lock();
    if let Some(ram) = cache.as_ref() {
        return ram.clone();
    }
    let detected = read_ram_speed();
    *cache = Some(detected.clone());
    detected
}

fn read_ram_speed() -> String {
    if cfg!(windows) {
        // PowerShell CIM query
        if let Some(out) = process::output_text(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "$m = Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1 Speed, SMBIOSMemoryType; if ($m) { Write-Output ($m.Speed.ToString() + '|' + $m.SMBIOSMemoryType.ToString()) }",
            ],
            PROBE_TIMEOUT,
        ) {
            let trimmed = out.trim();
            if let Some((speed_str, type_str)) = trimmed.split_once('|') {
                let speed = speed_str.trim().parse::<u64>().unwrap_or(0);
                let smbios_type = type_str.trim().parse::<u32>().unwrap_or(0);
                let ddr_type = match smbios_type {
                    34 => "DDR5",
                    26 => "DDR4",
                    24 => "DDR3",
                    21 => "DDR2",
                    _ => {
                        if speed >= 4800 {
                            "DDR5"
                        } else if speed >= 2133 {
                            "DDR4"
                        } else {
                            "RAM"
                        }
                    }
                };
                if speed > 0 {
                    return format!("{ddr_type} {speed} MHz");
                }
            }
        }

        // WMIC básico sin /format:csv
        if let Some(out) =
            process::output_text("wmic", &["memorychip", "get", "Speed"], PROBE_TIMEOUT)
        {
            for line in out.lines().map(str::trim) {
                if line.is_empty() || line.eq_ignore_ascii_case("Speed") {
                    continue;
                }
                if let Ok(speed) = line.parse::<u64>() {
                    if speed > 0 {
                        let ddr_type = if speed >= 4800 { "DDR5" } else { "DDR4" };
                        return format!("{ddr_type} {speed} MHz");
                    }
                }
            }
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
#[derive(Debug, Clone)]
struct DiskRow {
    mount: String,
    used: u64,
    total: u64,
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

#[allow(dead_code)]
fn username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "usuario".to_string())
}

/// El nombre de la terminal, arriba del todo y centrado sobre las cajas.
///
/// Va en el banner y no en un texto de bienvenida suelto porque `clear` repinta
/// el banner y borra todo lo demás: sin esto, una pestaña recién limpiada no
/// dice en ningún sitio qué terminal se está usando. El nombre sale de la
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
    _env_label: &str,
    app_name: &str,
    columns: u16,
    _tab_count: usize,
    t: &Translator,
) -> String {
    let display_name = if app_name.trim().is_empty() {
        "WinSlim Terminal"
    } else {
        app_name.trim()
    };

    let prefs = crate::preferences::current();
    let accent = hex_to_ansi(&prefs.fastfetch_color);

    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());

    let cpus = system.cpus();
    let raw_cpu = cpus
        .first()
        .map(|cpu| cpu.brand().split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|brand| !brand.is_empty())
        .unwrap_or_else(|| "desconocida".to_string());
    let cpu_model = clean_cpu_model(&raw_cpu);

    let total_memory = system.total_memory();
    let used_memory = total_memory.saturating_sub(system.available_memory());

    let identity = os_identity();
    let os_name = clean_os_name(&identity.name);

    let mut rows: Vec<(String, String)> = Vec::new();

    rows.push((t.t("banner.system", "Sistema"), os_name));

    let mobo = motherboard_info();
    if !mobo.is_empty() {
        rows.push((t.t("banner.motherboard", "Placa"), mobo));
    }

    let logical_cpus = system.cpus().len();
    let physical_cores = System::physical_core_count().unwrap_or(logical_cpus);
    let cpu_desc = if physical_cores > 0 && physical_cores != logical_cpus {
        format!("{cpu_model} ({physical_cores}C/{logical_cpus}T)")
    } else {
        format!("{cpu_model} ({logical_cpus}T)")
    };
    rows.push((t.t("banner.cpu", "CPU"), cpu_desc));

    let gpu = gpu_info();
    if !gpu.is_empty() {
        rows.push((t.t("banner.gpu", "GPU"), gpu));
    }

    let memory_pct = if total_memory > 0 {
        (used_memory as f64 / total_memory as f64 * 100.0).round() as u64
    } else {
        0
    };
    let ram_extra = ram_speed_info();
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
    rows.push((t.t("banner.memory", "Memoria"), memory_str));

    let disks_list = sysinfo::Disks::new_with_refreshed_list();
    let mut total_storage: u64 = 0;
    let mut used_storage: u64 = 0;
    for disk in disks_list.iter() {
        if !disk.is_removable() && disk.total_space() >= 1_000_000_000 {
            let total = disk.total_space();
            let avail = disk.available_space();
            total_storage += total;
            used_storage += total.saturating_sub(avail);
        }
    }
    if total_storage > 0 {
        let pct = (used_storage as f64 / total_storage as f64 * 100.0).round() as u64;
        rows.push((
            t.t("banner.storage", "Disco"),
            format!(
                "{} / {} ({}%)",
                format_bytes(used_storage),
                format_bytes(total_storage),
                pct
            ),
        ));
    }

    let available_cols = if columns == 0 {
        ASSUMED_COLUMNS
    } else {
        columns as usize
    };

    // Se limita el ancho a 48 columnas para garantizar que ninguna línea del banner
    // ni el separador hagan salto de línea en la vista de ventanas divididas (multiventana).
    let max_line_cols = std::cmp::min(available_cols, 48);
    let max_sep = std::cmp::min(46, max_line_cols.saturating_sub(2));
    let sep_len = if max_sep < 15 { 15 } else { max_sep };
    let separator = "-".repeat(sep_len);

    let max_label_len = rows
        .iter()
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(8);

    let mut lines = Vec::new();
    let version = env!("CARGO_PKG_VERSION");
    lines.push(format!(
        "{BOLD}{accent}{display_name}{RESET} {accent}{version}{RESET}"
    ));
    lines.push(format!("\x1b[90m{separator}{RESET}"));

    for (label, value) in rows {
        let label_pad = max_label_len.saturating_sub(label.chars().count());
        let max_val_len = max_line_cols.saturating_sub(max_label_len + 3);
        let val_trimmed = ellipsize(&value, max_val_len);

        lines.push(format!(
            "{accent}{label}{RESET}{}  {val_trimmed}",
            " ".repeat(label_pad)
        ));
    }

    lines.push(format!("\x1b[90m{separator}{RESET}"));

    lines.join("\r\n") + "\r\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_emojis_y_adornos_desaparecen_del_nombre() {
        assert_eq!(clean_identity_value("🚀 ~ WinSlim 10 ~ 🚀"), "WinSlim 10");
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
        let salida = "01:00.0\t\"VGA compatible controller\"\t\"NVIDIA\"\t\"GA106 [RTX 3060]\"";
        assert_eq!(parse_lspci_gpu(salida), "\"NVIDIA\" \"GA106 [RTX 3060]\"");
        assert_eq!(parse_lspci_gpu(""), "");
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
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 120, 1, &t);
        assert!(banner.contains("Sistema"), "{banner}");
        assert!(banner.contains("CPU"), "{banner}");
        assert!(banner.contains("Memoria"), "{banner}");
        assert!(banner.contains("Disco"), "{banner}");
        assert!(banner.ends_with("\r\n"));
    }

    /// El nombre va ARRIBA DEL TODO y es el de la build que se está ejecutando.
    #[test]
    fn el_banner_abre_con_el_nombre_de_la_terminal() {
        let t = Translator::default();
        for nombre in [crate::identity::WINDOWS.name, crate::identity::LINUX.name] {
            let banner = build_banner("cmd.exe", nombre, 120, 1, &t);
            let primera = crate::current_dir::strip_ansi(banner.lines().next().unwrap());
            assert!(primera.contains(nombre), "{banner}");
        }
    }

    #[test]
    fn el_nombre_abre_el_banner() {
        let banner = build_banner(
            "cmd.exe",
            "WinSlim Terminal",
            120,
            1,
            &Translator::default(),
        );
        let lineas: Vec<String> = banner.lines().map(crate::current_dir::strip_ansi).collect();
        let titulo = &lineas[0];
        assert!(titulo.contains("WinSlim Terminal"));
    }

    /// El fallo que se veia al dividir la ventana: el banner se dibujaba con el
    /// ancho que pidiera el contenido y la terminal partia cada linea por la
    /// mitad, dejando el marco hecho pedazos.
    #[test]
    fn ninguna_linea_del_banner_pasa_del_ancho_de_la_terminal() {
        let t = Translator::default();
        for columnas in [40u16, 55, 60, 80, 120, 200] {
            let banner = build_banner("cmd.exe", "WinSlim Terminal", columnas, 1, &t);
            for linea in banner.lines() {
                let ancho = crate::current_dir::strip_ansi(linea).chars().count();
                assert!(
                    ancho <= columnas as usize,
                    "linea de {ancho} columnas con terminal de {columnas}: {linea:?}"
                );
            }
        }
    }

    /// Por debajo del minimo se sueltan los bordes: tres cajas de puntos
    /// suspensivos no las lee nadie.
    #[test]
    fn en_una_casilla_muy_estrecha_el_banner_pierde_el_marco() {
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 30, 1, &Translator::default());
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
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 0, 1, &Translator::default());
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
        let banner = build_banner("bash", "App", 120, 1, &Translator::new("en"));
        assert!(banner.contains("Memory"), "{banner}");
    }

    #[test]
    fn la_identidad_del_sistema_nunca_queda_vacia() {
        assert!(!os_identity().name.trim().is_empty());
    }
}
