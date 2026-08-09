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
            if keep {
                c
            } else {
                ' '
            }
        })
        .collect();
    let trimmed =
        replaced.trim_matches(|c: char| c.is_whitespace() || c == '~' || c == '|' || c == '-');
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

const WIN_NT_KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion";
const WIN_OEM_KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OEMInformation";

/// Lee los valores de una clave del registro con `reg query`, que viene siempre
/// con Windows y no necesita ningún módulo nativo. Los REG_DWORD llegan como
/// "0x1cf9" y se dejan tal cual; quien los quiera como número los convierte.
fn reg_values(key: &str) -> Vec<(String, String)> {
    let Some(output) = process::output_text("reg", &["query", key], PROBE_TIMEOUT) else {
        return Vec::new();
    };
    parse_reg_query(&output)
}

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

#[cfg(target_os = "macos")]
fn read_gpu_model() -> String {
    process::output_text("system_profiler", &["SPDisplaysDataType"], PROBE_TIMEOUT)
        .map(|output| parse_system_profiler_gpu(&output))
        .unwrap_or_default()
}

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

/// Cuánto lleva instalado el sistema, estimado por la fecha de creación de la
/// primera ruta que la tenga.
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

#[derive(Debug, Clone)]
struct DiskRow {
    mount: String,
    used: u64,
    total: u64,
}

/// Los discos montados que merece la pena enseñar. En Linux el original leía
/// `/proc/mounts` y llamaba a `df`; `sysinfo` ya da lo mismo sin lanzar
/// procesos, y de paso funciona igual en las tres plataformas.
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

fn used_percent(used: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        (used as f64 / total as f64 * 100.0).round() as u64
    }
}

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
const MIN_BOXED_WIDTH: usize = 40;
/// Si no se sabe el tamaño real de la terminal se supone el clásico de 80.
const ASSUMED_COLUMNS: usize = 80;

pub fn build_banner(env_label: &str, app_name: &str, columns: u16, t: &Translator) -> String {
    let display_name = if app_name.trim().is_empty() {
        "Terminal"
    } else {
        app_name.trim()
    };

    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());

    let cpus = system.cpus();
    let cpu_model = cpus
        .first()
        .map(|cpu| cpu.brand().split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|brand| !brand.is_empty())
        .unwrap_or_else(|| "desconocida".to_string());
    let total_memory = system.total_memory();
    let used_memory = total_memory.saturating_sub(system.available_memory());

    let identity = os_identity();
    let kernel = if cfg!(windows) {
        let build = identity
            .build
            .as_ref()
            .map(|build| format!(" · build {build}"))
            .unwrap_or_default();
        format!("NT {}{build}", System::kernel_version().unwrap_or_default())
    } else {
        format!(
            "{} {}",
            System::name().unwrap_or_default(),
            System::kernel_version().unwrap_or_default()
        )
    };

    let unknown = t.t("banner.unknown", "desconocido");

    let mut hardware = vec![
        (
            t.t("banner.pc", "PC"),
            System::host_name().unwrap_or_else(|| unknown.clone()),
        ),
        (
            t.t("banner.cpu", "CPU"),
            format!(
                "{cpu_model} ({})",
                t.tp(
                    "banner.cores",
                    &[("count", cpus.len().to_string())],
                    "{count} núcleos"
                )
            ),
        ),
        (t.t("banner.gpu", "GPU"), {
            let gpu = read_gpu_model();
            if gpu.is_empty() {
                unknown.clone()
            } else {
                gpu
            }
        }),
        (
            t.t("banner.memory", "Memoria"),
            format!(
                "{} / {} ({}%)",
                format_bytes(used_memory),
                format_bytes(total_memory),
                used_percent(used_memory, total_memory)
            ),
        ),
    ];
    for disk in read_disks() {
        hardware.push((
            disk.mount.clone(),
            format!(
                "{} / {} ({}%)",
                format_bytes(disk.used),
                format_bytes(disk.total),
                used_percent(disk.used, disk.total)
            ),
        ));
    }

    let mut software = vec![
        (t.t("banner.user", "Usuario"), username()),
        (
            t.t("banner.system", "Sistema"),
            format!("{} ({})", identity.name, std::env::consts::ARCH),
        ),
    ];
    if let Some(brand) = &identity.brand {
        software.push((t.t("banner.edition", "Edición"), brand.clone()));
    }
    software.push((t.t("banner.kernel", "Kernel"), kernel));
    software.push((
        t.t("banner.environment", "Entorno"),
        if env_label.is_empty() {
            unknown.clone()
        } else {
            env_label.to_string()
        },
    ));

    let mut uptime_rows = Vec::new();
    if let Some(age) = estimate_os_age() {
        uptime_rows.push((t.t("banner.osAge", "Edad del SO"), format_uptime(age)));
    }
    uptime_rows.push((
        t.t("banner.uptime", "Uptime"),
        format_uptime(System::uptime()),
    ));
    uptime_rows.push((t.t("banner.datetime", "Fecha y hora"), format_now()));

    let hardware_title = t.t("banner.hardware", "Hardware");
    let software_title = t.t("banner.software", "Software");
    let uptime_title = t.t("banner.uptimeAge", "Uptime / Age / DT");

    // Las tres cajas comparten ancho: si cada una se ajustara a su contenido,
    // el banner quedaría escalonado.
    let deseado = hardware
        .iter()
        .chain(software.iter())
        .chain(uptime_rows.iter())
        .map(|(label, value)| label.chars().count() + 2 + value.chars().count())
        .chain([
            hardware_title.chars().count() + 4,
            software_title.chars().count() + 4,
            uptime_title.chars().count() + 4,
        ])
        .chain([46])
        .max()
        .unwrap_or(46);

    if hardware.is_empty() || software.is_empty() {
        return format!("{BOLD}{CYAN}{display_name}{RESET}\r\n");
    }

    // Y ninguna cabe más ancha que la terminal. Antes el banner se dibujaba con
    // el ancho que pidiera el contenido —del orden de 90 columnas con una ruta
    // larga en «Edición»— y en una casilla dividida la terminal partía cada
    // línea por la mitad: el marco se veía hecho pedazos. Las cuatro columnas
    // que se restan son los bordes y sus espacios.
    let disponible = if columns == 0 {
        ASSUMED_COLUMNS
    } else {
        columns as usize
    };
    let content_width = std::cmp::min(deseado, disponible.saturating_sub(4));

    // Demasiado estrecho para un marco: se enseñan las filas a secas, que es
    // preferible a tres cajas de puntos suspensivos.
    if disponible < MIN_BOXED_WIDTH {
        return plain_rows(
            display_name,
            &[&hardware, &software, &uptime_rows],
            disponible,
        );
    }

    // El mismo ancho que acaban teniendo las cajas: `section_box` lo ensancha si
    // su título no cabe, así que se calcula igual aquí para que el nombre quede
    // centrado sobre ellas y no sobre una anchura que ninguna caja tiene.
    let box_width = [&hardware_title, &software_title, &uptime_title]
        .iter()
        .map(|title| std::cmp::max(content_width + 4, title.chars().count() + 4))
        .max()
        .unwrap_or(content_width + 4);

    [
        title_line(display_name, box_width),
        section_box(&hardware_title, &hardware, content_width),
        section_box(&software_title, &software, content_width),
        section_box(&uptime_title, &uptime_rows, content_width),
    ]
    .join("\r\n")
        + "\r\n"
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
    fn el_banner_real_se_genera_y_lleva_las_tres_secciones() {
        let t = Translator::default();
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 120, &t);
        assert!(banner.contains("Hardware"), "{banner}");
        assert!(banner.contains("Software"), "{banner}");
        assert!(banner.contains("Entorno"), "{banner}");
        assert!(banner.contains("cmd.exe"), "{banner}");
        assert!(banner.ends_with("\r\n"));
    }

    /// El nombre va ARRIBA DEL TODO y es el de la build que se está ejecutando:
    /// una Linux no puede acabar enseñando la marca de Windows.
    #[test]
    fn el_banner_abre_con_el_nombre_de_la_terminal() {
        let t = Translator::default();
        for nombre in [crate::identity::WINDOWS.name, crate::identity::LINUX.name] {
            let banner = build_banner("cmd.exe", nombre, 120, &t);
            let primera = crate::current_dir::strip_ansi(banner.lines().next().unwrap());
            assert_eq!(primera.trim(), nombre, "{banner}");
        }
    }

    /// Centrado sobre las cajas, no sobre una anchura cualquiera: el relleno de
    /// la izquierda tiene que dejar el nombre dentro del ancho real del marco.
    #[test]
    fn el_nombre_queda_centrado_sobre_las_cajas() {
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 120, &Translator::default());
        let lineas: Vec<String> = banner.lines().map(crate::current_dir::strip_ansi).collect();
        let ancho_caja = lineas
            .iter()
            .find(|line| line.starts_with('┌'))
            .map(|line| line.chars().count())
            .expect("el banner debe traer cajas");
        let titulo = &lineas[0];
        let sangria = titulo.chars().take_while(|c| *c == ' ').count();
        assert!(
            titulo.chars().count() <= ancho_caja,
            "el nombre se sale del marco: {titulo:?} sobre {ancho_caja}"
        );
        assert_eq!(
            sangria,
            (ancho_caja - "WinSlim Terminal".chars().count()) / 2,
            "sangría inesperada en {titulo:?}"
        );
    }

    /// El fallo que se veia al dividir la ventana: el banner se dibujaba con el
    /// ancho que pidiera el contenido y la terminal partia cada linea por la
    /// mitad, dejando el marco hecho pedazos.
    #[test]
    fn ninguna_linea_del_banner_pasa_del_ancho_de_la_terminal() {
        let t = Translator::default();
        for columnas in [40u16, 55, 60, 80, 120, 200] {
            let banner = build_banner("cmd.exe", "WinSlim Terminal", columnas, &t);
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
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 30, &Translator::default());
        assert!(!banner.contains('\u{250c}'), "{banner}");
        // Pero sigue diciendo lo mismo.
        assert!(banner.contains("CPU"), "{banner}");
        assert!(banner.contains("Uptime"), "{banner}");
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
        let banner = build_banner("cmd.exe", "WinSlim Terminal", 0, &Translator::default());
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
        let banner = build_banner("bash", "App", 120, &Translator::new("en"));
        assert!(banner.contains("Memory"), "{banner}");
        assert!(banner.contains("Environment"), "{banner}");
    }

    #[test]
    fn la_identidad_del_sistema_nunca_queda_vacia() {
        assert!(!os_identity().name.trim().is_empty());
    }
}
