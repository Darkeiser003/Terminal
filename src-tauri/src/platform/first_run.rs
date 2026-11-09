//! Lo que conecta el instalador modular con la app (diseño del 23-10, punto 7).
//!
//! - **Primer arranque** ([`apply`]): la página de componentes del instalador
//!   deja `first-run.json` junto al ejecutable (`hooks.nsh`) con lo elegido:
//!   WTerminal en el PATH y el menú del Explorador con el protocolo
//!   `wterminal://`. Cada usuario lo aplica una vez, en su primer arranque; lo
//!   aplicado se apunta en sus datos (la carpeta del programa es de solo
//!   lectura para él). Sin el archivo (instalación silenciosa, portable o
//!   actualización) queda lo de fábrica: el PATH se añade solo y el menú no.
//! - **Desinstalar** ([`uninstall_report`]): el desinstalador pregunta cuánto
//!   ocupan los datos de la app y la carpeta propia, y si esta es de WTerminal
//!   (la de fábrica o una con su marca), para ofrecer borrarla con su tamaño.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Argumento con el que el desinstalador pide el informe (`installer.nsi`).
pub const UNINSTALL_REPORT_ARG: &str = "--wterminal-uninstall-report";

/// Nombre del archivo que deja la página de componentes.
pub const FIRST_RUN_FILE: &str = "first-run.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct FirstRun {
    pub version: u32,
    pub path: bool,
    pub explorer: bool,
}

pub fn parse_first_run(text: &str) -> Option<FirstRun> {
    let parsed: FirstRun = serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()?;
    (parsed.version == 1).then_some(parsed)
}

/// Qué hay que hacer con lo elegido: quitar del PATH (la app se añade sola si
/// no se le dice lo contrario) y activar el menú del Explorador (apagado de
/// fábrica).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstRunPlan {
    pub disable_path: bool,
    pub enable_explorer: bool,
}

pub fn plan(choice: FirstRun) -> FirstRunPlan {
    FirstRunPlan {
        disable_path: !choice.path,
        enable_explorer: choice.explorer,
    }
}

fn applied_marker() -> PathBuf {
    crate::paths::user_data_dir().join("first-run-applied.txt")
}

/// Huella del archivo: si se reinstala con otras elecciones, se aplican otra
/// vez.
fn fingerprint(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Aplica `first-run.json` una vez por usuario. Se llama al arrancar, antes de
/// `path_integration::ensure_default_enabled`, para que «sin PATH» se respete.
pub fn apply() {
    if cfg!(test) {
        return;
    }
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(dir.join(FIRST_RUN_FILE)) else {
        return;
    };
    let print = fingerprint(&text);
    let marker = applied_marker();
    if std::fs::read_to_string(&marker).is_ok_and(|done| done.trim() == print) {
        return;
    }
    let Some(choice) = parse_first_run(&text) else {
        log_warn!(
            "first-run.json no se entiende; se deja lo de fábrica",
            serde_json::json!({})
        );
        return;
    };
    let plan = plan(choice);
    if plan.disable_path {
        if let Err(error) = super::path_integration::set_enabled(false) {
            log_warn!(
                "No se pudo quitar WTerminal del PATH (primer arranque)",
                serde_json::json!({ "error": error })
            );
        }
    }
    if plan.enable_explorer {
        if let Err(error) = super::windows_integration::set_enabled(true) {
            log_warn!(
                "No se pudo activar el menú del Explorador (primer arranque)",
                serde_json::json!({ "error": error })
            );
        }
    }
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, print);
    log_info!(
        "Primer arranque: componentes del instalador aplicados",
        serde_json::json!({ "path": choice.path, "explorer": choice.explorer })
    );
}

// ---- Informe para el desinstalador ----

fn size_label(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

/// El contenido del INI: `[data]` con lo que ocupan ajustes, registros y
/// datos locales (sin la carpeta propia) y `[store]` con la carpeta propia.
/// `deletable=1` solo si es la de fábrica o lleva la marca de WTerminal: una
/// carpeta elegida a mano que no la lleve (una raíz de disco, una carpeta con
/// otras cosas) nunca se ofrece borrar.
pub fn report_text(data_bytes: u64, store: Option<(&Path, u64, bool)>) -> String {
    let mut lines = vec![
        "[data]".to_string(),
        format!("bytes={data_bytes}"),
        format!("label={}", size_label(data_bytes)),
        String::new(),
        "[store]".to_string(),
    ];
    match store {
        Some((path, bytes, deletable)) => {
            lines.push(format!("path={}", path.display()));
            lines.push(format!("bytes={bytes}"));
            lines.push(format!("label={}", size_label(bytes)));
            lines.push(format!("deletable={}", u8::from(deletable)));
        }
        None => lines.push("deletable=0".to_string()),
    }
    lines.join("\r\n") + "\r\n"
}

fn store_is_ours(root: &Path) -> bool {
    root == crate::toolchain_store::default_root()
        || root.join(crate::toolchain_store::STORE_MARKER).is_file()
}

/// Escribe el informe en `path` en UTF-16 con BOM (lo que lee bien
/// `ReadINIStr` con rutas que no son ASCII) y devuelve el código de salida.
pub fn uninstall_report(path: &Path) -> i32 {
    let preferences = crate::preferences::current();
    crate::toolchain_store::sync_layout(&preferences);
    let root = crate::toolchain_store::effective_root(true, &preferences.toolchain_store_dir)
        .unwrap_or_else(crate::toolchain_store::default_root);
    let store = root.is_dir().then(|| {
        let bytes = crate::toolchain_store::directory_size(&root);
        (root.as_path(), bytes, store_is_ours(&root))
    });
    let mut data_bytes = 0;
    for dir in [
        dirs::config_dir().map(|dir| dir.join("wterminal")),
        dirs::data_local_dir().map(|dir| dir.join("WTerminal")),
    ]
    .into_iter()
    .flatten()
    {
        data_bytes += crate::toolchain_store::directory_size(&dir);
    }
    // La carpeta propia de fábrica vive dentro de %LOCALAPPDATA%\WTerminal:
    // no cuenta dos veces.
    if let Some((store_root, store_bytes, _)) = store {
        if dirs::data_local_dir()
            .is_some_and(|local| store_root.starts_with(local.join("WTerminal")))
        {
            data_bytes = data_bytes.saturating_sub(store_bytes);
        }
    }
    let text = report_text(data_bytes, store);
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    match std::fs::write(path, bytes) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{}: {error}", path.display());
            1
        }
    }
}

/// `--wterminal-uninstall-report <ruta>`: la ruta que sigue al argumento.
pub fn uninstall_report_argument() -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(argument) = args.next() {
        if argument == UNINSTALL_REPORT_ARG {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_archivo_del_instalador_se_lee_y_dice_que_cambiar() {
        let choice =
            parse_first_run("\u{feff}{\"version\":1,\"path\":false,\"explorer\":true}\r\n")
                .unwrap();
        assert_eq!(
            plan(choice),
            FirstRunPlan {
                disable_path: true,
                enable_explorer: true
            }
        );
        let defaults = parse_first_run("{\"version\":1,\"path\":true,\"explorer\":false}").unwrap();
        assert_eq!(
            plan(defaults),
            FirstRunPlan {
                disable_path: false,
                enable_explorer: false
            }
        );
        assert!(parse_first_run("{\"version\":2,\"path\":true,\"explorer\":true}").is_none());
        assert!(parse_first_run("basura").is_none());
    }

    #[test]
    fn el_informe_solo_ofrece_borrar_una_carpeta_propia_de_wterminal() {
        let ours = report_text(
            5 * 1024 * 1024,
            Some((
                Path::new(r"E:\WTerminal\entornos"),
                3 * 1024 * 1024 * 1024,
                true,
            )),
        );
        assert!(ours.contains("[data]\r\nbytes=5242880\r\nlabel=5.0 MB"));
        assert!(ours.contains(r"path=E:\WTerminal\entornos"));
        assert!(ours.contains("label=3.0 GB"));
        assert!(ours.contains("deletable=1"));
        let foreign = report_text(0, Some((Path::new(r"D:\"), 1, false)));
        assert!(foreign.contains("deletable=0"));
        assert!(report_text(0, None).contains("[store]\r\ndeletable=0"));
    }

    #[test]
    fn la_huella_cambia_si_cambian_las_elecciones() {
        assert_ne!(
            fingerprint("{\"version\":1,\"path\":true,\"explorer\":false}"),
            fingerprint("{\"version\":1,\"path\":true,\"explorer\":true}")
        );
    }
}
