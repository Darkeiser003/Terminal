//! Detección pasiva de actualizaciones de aplicaciones administradas por el
//! gestor nativo del sistema. Nunca instala ni solicita actualizar índices;
//! algunos gestores pueden refrescar sus propias cachés como parte de la consulta.

use std::time::Duration;

use serde::Serialize;

use crate::platform::traits::HostPlatform;

const CHECK_TIMEOUT: Duration = Duration::from_secs(12);
const C_LOCALE: &[(&str, &str)] = &[("LC_ALL", "C"), ("LANG", "C")];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateStatus {
    pub available: bool,
    /// Nombre de un gestor de una lista permitida; no procede de entrada IPC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager: Option<String>,
}

/// Gestor nativo que la aplicación puede consultar de forma no interactiva.
/// En Linux se reutiliza el resultado del inventario rápido; no se inicia otra
/// detección de shells, WSL, Docker ni ADB.
pub fn host_manager(linux_manager: Option<&str>) -> Option<&'static str> {
    if crate::platform::host().is_windows() {
        crate::path_env::is_tool_installed("winget").then_some("winget")
    } else {
        match linux_manager? {
            "apt" => Some("apt"),
            "dnf" => Some("dnf"),
            "pacman" => Some("pacman"),
            "zypper" => Some("zypper"),
            "apk" => Some("apk"),
            _ => None,
        }
    }
}

/// Comprueba solo con el gestor ya seleccionado por el host. La salida del
/// proceso se analiza localmente y todos los comandos tienen timeout; una
/// fuente lenta o rota no retrasa la ventana ni bloquea su hilo principal.
pub fn check(manager: &str) -> PackageUpdateStatus {
    let available = query(manager).unwrap_or_else(|| {
        log_warn!(
            "No se pudo consultar el estado de actualizaciones de paquetes",
            serde_json::json!({ "manager": manager })
        );
        false
    });
    PackageUpdateStatus {
        available,
        manager: Some(manager.to_string()),
    }
}

fn query(manager: &str) -> Option<bool> {
    let (program, args) = query_command(manager)?;
    let output = crate::process::run_with_timeout_env(program, args, CHECK_TIMEOUT, C_LOCALE)?;
    let code = output.status.code()?;
    match manager {
        "dnf" => dnf_has_updates(code),
        "apt" => output
            .status
            .success()
            .then(|| apt_has_updates(&output.stdout)),
        "pacman" => output
            .status
            .success()
            .then(|| pacman_has_updates(&output.stdout)),
        "zypper" => output
            .status
            .success()
            .then(|| zypper_has_updates(&output.stdout)),
        "apk" => output
            .status
            .success()
            .then(|| apk_has_updates(&output.stdout)),
        "winget" => output
            .status
            .success()
            // Una salida nueva/desconocida de WinGet no debe crear avisos
            // falsos: solo se anuncia cuando se reconoce una fila de paquete.
            .then(|| winget_has_updates(&output.stdout).unwrap_or(false)),
        _ => None,
    }
}

fn query_command(manager: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match manager {
        "winget" => (
            "winget",
            &[
                "list",
                "--upgrade-available",
                "--accept-source-agreements",
                "--disable-interactivity",
            ],
        ),
        // `-s` simula la transacción: no refresca apt ni instala nada.
        "apt" => ("apt-get", &["-s", "upgrade"]),
        // dnf devuelve 100 cuando hay actualizaciones y 0 cuando está al día.
        "dnf" => ("dnf", &["check-update", "--quiet"]),
        "pacman" => ("pacman", &["-Qu"]),
        "zypper" => ("zypper", &["--non-interactive", "list-updates"]),
        "apk" => ("apk", &["version", "-l", "<"]),
        _ => return None,
    })
}

fn text(output: &[u8]) -> String {
    String::from_utf8_lossy(output).into_owned()
}

fn apt_has_updates(output: &[u8]) -> bool {
    text(output).lines().any(|line| line.starts_with("Inst "))
}

fn pacman_has_updates(output: &[u8]) -> bool {
    text(output)
        .lines()
        .any(|line| line.split_once(" -> ").is_some())
}

fn zypper_has_updates(output: &[u8]) -> bool {
    text(output).lines().any(|line| {
        let line = line.trim();
        line.starts_with("v |")
            && !line.contains("Repository")
            && line.split('|').count() >= 6
            && line
                .split('|')
                .skip(1)
                .any(|column| !column.trim().is_empty())
    })
}

fn apk_has_updates(output: &[u8]) -> bool {
    text(output)
        .lines()
        .any(|line| line.contains(" < ") && !line.trim().is_empty())
}

fn dnf_has_updates(exit_code: i32) -> Option<bool> {
    match exit_code {
        0 => Some(false),
        100 => Some(true),
        _ => None,
    }
}

fn winget_has_updates(output: &[u8]) -> Option<bool> {
    let output = text(output);
    let lines: Vec<&str> = output.lines().collect();
    let divider = lines.iter().position(|line| {
        let trimmed = line.trim();
        trimmed.len() >= 5 && trimmed.bytes().all(|byte| byte == b'-')
    })?;
    let has_header = lines[..divider]
        .iter()
        .any(|line| line.split_whitespace().count() >= 3);
    if !has_header {
        return None;
    }
    Some(lines[divider + 1..].iter().any(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.bytes().all(|byte| byte == b'-') {
            return false;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("upgrade available") || lower.contains("upgrades available") {
            return false;
        }
        let columns: Vec<&str> = trimmed.split_whitespace().collect();
        // WinGet's Name column may contain spaces, so the package ID is not
        // reliably column 2 when split on whitespace. Its ID and the three
        // trailing Version/Available/Source fields are single tokens; inspect
        // that stable suffix instead of dropping updates for names like
        // "Visual Studio Code".
        columns.len() >= 4
            && columns.get(columns.len() - 4).is_some_and(|id| {
                id.bytes().any(|byte| byte.is_ascii_alphanumeric())
                    && id.bytes().any(|byte| matches!(byte, b'.' | b'-' | b'_'))
                    && id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+')
                    })
            })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apt_cuenta_solo_lineas_de_instalacion_simulada() {
        assert!(apt_has_updates(
            b"Reading package lists... Done\nInst curl [8.0] (8.1 repo)\n"
        ));
        assert!(!apt_has_updates(
            b"Reading package lists... Done\n0 upgraded, 0 newly installed\n"
        ));
    }

    #[test]
    fn winget_reconoce_filas_y_no_confunde_el_pie_de_tabla() {
        let rows = b"Name Id Version Available Source\n------------------------------------------------------------\nTerminal.Example  Example.Terminal  1.2  1.3  winget\n1 upgrades available.\n";
        assert_eq!(winget_has_updates(rows), Some(true));
        let spaced_name = b"Name Id Version Available Source\n------------------------------------------------------------\nMicrosoft Visual Studio Code Microsoft.VisualStudioCode 1.2.0 1.3.0 winget\n";
        assert_eq!(winget_has_updates(spaced_name), Some(true));
        let current = b"Name Id Version Available Source\n------------------------------------------------------------\nNo applicable upgrade found.\n";
        assert_eq!(winget_has_updates(current), Some(false));
        assert_eq!(winget_has_updates(b"source unavailable"), None);
    }

    #[test]
    fn los_listados_de_pacman_brew_y_apk_solo_avisan_si_hay_filas() {
        assert!(pacman_has_updates(b"bash 5.2 -> 5.3\n"));
        assert!(!pacman_has_updates(b"warning: database is out of date\n"));
        assert!(apk_has_updates(b"bash-5.2 < 5.3\n"));
        assert!(!apk_has_updates(b"bash-5.3\n"));
    }

    #[test]
    fn zypper_ignora_la_cabecera_y_detecta_filas_de_paquetes() {
        let listing = b"Repository | Name | Current Version | Available Version | Arch\n---+---+---+---+---\nv | repo | package | 1.0 | 1.1 | x86_64\n";
        assert!(zypper_has_updates(listing));
        assert!(!zypper_has_updates(
            b"Repository | Name | Current Version | Available Version | Arch\n"
        ));
    }

    #[test]
    fn dnf_codifica_su_estado_de_salida_de_actualizaciones() {
        assert_eq!(dnf_has_updates(100), Some(true));
        assert_eq!(dnf_has_updates(0), Some(false));
        assert_eq!(dnf_has_updates(1), None);
    }

    #[test]
    fn cada_sonda_usa_su_comando_de_consulta_permitido() {
        // `apt-get -s upgrade` contiene la palabra upgrade, pero -s fuerza una
        // simulación. Comparar cada comando completo evita confundirla con una
        // instalación real y detecta que una futura sonda pase a mutar paquetes.
        let expected: [(&str, &str, &[&str]); 6] = [
            (
                "winget",
                "winget",
                &[
                    "list",
                    "--upgrade-available",
                    "--accept-source-agreements",
                    "--disable-interactivity",
                ],
            ),
            ("apt", "apt-get", &["-s", "upgrade"]),
            ("dnf", "dnf", &["check-update", "--quiet"]),
            ("pacman", "pacman", &["-Qu"]),
            ("zypper", "zypper", &["--non-interactive", "list-updates"]),
            ("apk", "apk", &["version", "-l", "<"]),
        ];
        for (manager, program, args) in expected {
            assert_eq!(query_command(manager), Some((program, args)));
        }
        assert!(query_command("arbitrary-command").is_none());
    }
}
