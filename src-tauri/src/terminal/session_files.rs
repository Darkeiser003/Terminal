//! Archivos temporales de cada pestaña: datos del banner, ayuda e
//! inicialización de la shell.
//!
//! Port de la parte de `electron/main.js` que escribe `banner-<tab>.txt`,
//! `bannerclear-<tab>.txt`, el indicador configurable de `clear`,
//! `help-<tab>.txt` e `init-<tab>.<ext>`.

use std::path::{Path, PathBuf};

use crate::alias_profiles::{
    self, help_runner_path, help_topic_path, HelpTopic, InitOptions, InitScript, ScriptAlias,
};
use crate::environments::Environment;
use crate::i18n::Translator;
use crate::paths;

/// Lo que la pestaña necesita saber después de preparar sus archivos.
pub struct SessionFiles {
    /// La línea corta que hay que teclear en la shell para cargar la
    /// inicialización, o `None` si este entorno no lleva ninguna (o si el
    /// temporal no era escribible: ahí la terminal funciona igual, solo se
    /// queda sin alias).
    pub init_command: Option<String>,
    /// Texto que se imprime en el PTY al iniciar la sesión y que `sysinfo`
    /// puede mostrar de nuevo bajo demanda.
    pub banner_text: String,
}

pub struct SessionRequest<'a> {
    pub tab_id: &'a str,
    pub env: &'a Environment,
    pub script_aliases: &'a [ScriptAlias],
    pub app_name: &'a str,
    pub nsudo_path: Option<&'a str>,
    pub windows_manager: Option<&'a str>,
    pub manager_label: Option<&'a str>,
    pub show_banner: bool,
    /// El texto del banner ya montado. Se recibe hecho para no atar este módulo
    /// a la lectura del hardware.
    pub banner: &'a str,
    /// Indica si el script de inicialización debe imprimir el banner una vez.
    pub initial_banner: bool,
    /// Controla si `clear`/`cls` vuelve a imprimir el banner de esta pestaña.
    pub clear_reprint_banner: bool,
}

/// Windows PowerShell 5 solo interpreta UTF-8 de forma fiable cuando el archivo
/// lleva BOM. El resto de shells requiere UTF-8 sin BOM (en especial el
/// shebang de Bash), por eso la excepción se limita a los `.ps1` temporales.
fn write_init_script(
    path: &Path,
    kind: crate::environments::ShellKind,
    content: &str,
) -> std::io::Result<()> {
    if kind == crate::environments::ShellKind::Powershell {
        let mut bytes = Vec::with_capacity(content.len() + 3);
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        bytes.extend_from_slice(content.as_bytes());
        std::fs::write(path, bytes)
    } else {
        std::fs::write(path, content)
    }
}

/// Escribe el banner y el archivo de inicialización de una pestaña.
pub fn write_session_files(request: &SessionRequest<'_>, t: &Translator) -> SessionFiles {
    // Un REPL (Python, Node, etc.) mantiene un prompt de entrada vivo (`>>>`,
    // `>`, ...). Inyectar el fastfetch como salida inicial es una carrera: el
    // intérprete puede pintar su prompt antes o después del bloque y acabar
    // dentro del banner. Los REPL no cargan aliases ni `sysinfo`, así que el
    // banner automático no aporta nada y sí puede hacer ilegible la sesión.
    let is_repl = request.env.repl || request.env.kind == crate::environments::ShellKind::Repl;
    let show_banner = request.show_banner && !is_repl;
    let banner_text = if show_banner {
        let note = match request.env.note.as_deref() {
            Some(note) => format!("\x1b[33m{note}\x1b[0m\r\n\r\n"),
            None => String::new(),
        };
        format!("\r\n{}{note}", request.banner)
    } else {
        String::new()
    };

    let dir = dir();
    let mut banner_path: Option<PathBuf> = None;
    let mut banner_clear_path: Option<PathBuf> = None;

    if show_banner {
        if let Some(dir) = &dir {
            // Dos versiones del banner. La normal la usa "sysinfo", que solo
            // imprime. La de limpieza lleva delante un borrado explícito de
            // pantalla e historial: tras un `cls`, ConPTY repinta la línea del
            // prompt anterior, y sin esto quedaba flotando encima del banner.
            let normal = dir.join(format!("banner-{}.txt", request.tab_id));
            let cleared = dir.join(format!("bannerclear-{}.txt", request.tab_id));
            let clear_toggle = dir.join(format!("clear-banner-{}.flag", request.tab_id));
            match (
                std::fs::write(&normal, &banner_text),
                std::fs::write(&cleared, format!("\x1b[H\x1b[2J\x1b[3J{banner_text}")),
            ) {
                (Ok(()), Ok(())) => {
                    banner_path = Some(normal);
                    banner_clear_path = Some(cleared);
                    if request.clear_reprint_banner {
                        let _ = std::fs::write(clear_toggle, "1");
                    } else {
                        let _ = std::fs::remove_file(clear_toggle);
                    }
                }
                _ => log_warn!(
                    "No se pudo escribir el banner de la pestaña",
                    serde_json::json!({ "tabId": request.tab_id })
                ),
            }
        }
    }

    // Docker, ADB y Wine no llegan a los temporales del host: el backend
    // entregará el banner como salida PTY en el primer resize real. Los REPL
    // ya salieron arriba sin banner para proteger su prompt interactivo.
    if !alias_profiles::transport_loads_host_files(request.env.transport) {
        return SessionFiles {
            init_command: None,
            banner_text,
        };
    }

    // La ruta de la ayuda se decide antes de generar el script porque el alias
    // tiene que referenciarla, y el contenido llega después: solo
    // `build_init_script` sabe qué scripts se han registrado de verdad.
    let help_path = dir
        .as_ref()
        .map(|dir| dir.join(format!("help-{}.txt", request.tab_id)));

    let banner_str = banner_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    let banner_clear_str = banner_clear_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    let clear_banner_flag_path = dir
        .as_ref()
        .map(|dir| dir.join(format!("clear-banner-{}.flag", request.tab_id)))
        .map(|p| p.to_string_lossy().to_string());
    let help_str = help_path.as_ref().map(|p| p.to_string_lossy().to_string());

    let script = alias_profiles::build_init_script(
        request.env.kind,
        t,
        &InitOptions {
            nsudo_path: request.nsudo_path,
            script_aliases: request.script_aliases,
            banner_path: banner_str.as_deref(),
            banner_clear_path: banner_clear_str.as_deref(),
            clear_banner_flag_path: clear_banner_flag_path.as_deref(),
            help_path: help_str.as_deref(),
            transport: request.env.transport,
            app_name: request.app_name,
            env_label: &request.env.label,
            manager_label: request.manager_label,
            platform: std::env::consts::OS,
            windows_manager: request.windows_manager,
            initial_banner: request.initial_banner && show_banner,
        },
    );

    let Some(script) = script else {
        return SessionFiles {
            init_command: None,
            banner_text,
        };
    };

    if let Some(help_path) = &help_path {
        write_help_files(request.tab_id, help_path, request.env.kind, &script);
    }

    let Some(dir) = dir else {
        return SessionFiles {
            init_command: None,
            banner_text,
        };
    };
    let init_path = dir.join(format!("init-{}.{}", request.tab_id, script.ext));
    if write_init_script(&init_path, request.env.kind, &script.content).is_err() {
        log_warn!(
            "No se pudo escribir la inicializacion de la pestaña",
            serde_json::json!({ "tabId": request.tab_id })
        );
        return SessionFiles {
            init_command: None,
            banner_text,
        };
    }

    SessionFiles {
        init_command: alias_profiles::build_init_invocation(
            request.env.kind,
            &init_path.to_string_lossy(),
            request.env.transport,
        ),
        banner_text,
    }
}

/// Escribe la ayuda completa de una pestaña. Se mantiene separado de la
/// creación del script porque el idioma puede cambiar mientras la shell sigue
/// viva: el alias ya apunta al mismo archivo y basta con sustituir su contenido.
pub fn write_help_files(
    tab_id: &str,
    help_path: &Path,
    kind: crate::environments::ShellKind,
    script: &InitScript,
) {
    let Some(help_text) = &script.help_text else {
        return;
    };
    // Todas las shells leen ayuda UTF-8. cmd activa 65001 en init.cmd y
    // PowerShell usa Get-Content -Encoding UTF8 en sus aliases.
    if std::fs::write(help_path, help_text).is_err() {
        log_warn!(
            "No se pudo escribir la ayuda de la pestaña",
            serde_json::json!({ "tabId": tab_id })
        );
    }
    if let Some(topics) = &script.help_topics {
        for (key, text) in topics {
            let topic = HelpTopic::from_argument(Some(key)).unwrap_or(HelpTopic::General);
            let topic_path = help_topic_path(&help_path.to_string_lossy(), topic);
            if std::fs::write(topic_path, text).is_err() {
                log_warn!(
                    "No se pudo escribir una sección de ayuda de la pestaña",
                    serde_json::json!({ "tabId": tab_id, "section": key })
                );
            }
        }
    }
    if let Some(runner) = &script.help_runner {
        let runner_path = help_runner_path(&help_path.to_string_lossy(), kind);
        if write_init_script(Path::new(&runner_path), kind, runner).is_err() {
            log_warn!(
                "No se pudo escribir el selector de secciones de ayuda",
                serde_json::json!({ "tabId": tab_id })
            );
        }
    }
}

/// Actualiza los archivos que usan `sysinfo` y `clear` después de una nueva
/// sesión o de una solicitud explícita. El indicador separado permite cambiar
/// el comportamiento de `clear` sin tener que redefinir el alias de la shell.
pub fn refresh_banner_files(tab_id: &str, note: Option<&str>, banner: &str) {
    let Some(dir) = dir() else {
        return;
    };
    let note = note
        .map(|value| format!("\x1b[33m{value}\x1b[0m\r\n\r\n"))
        .unwrap_or_default();
    let text = format!("\r\n{}{note}", banner);
    let normal = dir.join(format!("banner-{tab_id}.txt"));
    let cleared = dir.join(format!("bannerclear-{tab_id}.txt"));
    let clear_toggle = dir.join(format!("clear-banner-{tab_id}.flag"));
    let preferences = crate::preferences::current();
    let clear_reprint = preferences.show_system_banner && preferences.clear_reprint_banner;
    if std::fs::write(&normal, &text).is_err()
        || std::fs::write(&cleared, format!("\x1b[H\x1b[2J\x1b[3J{text}")).is_err()
    {
        log_warn!(
            "No se pudo actualizar el banner de la pestaña",
            serde_json::json!({ "tabId": tab_id })
        );
    } else if clear_reprint {
        let _ = std::fs::write(clear_toggle, "1");
    } else {
        let _ = std::fs::remove_file(clear_toggle);
    }
}

/// Borra los temporales de una pestaña que se cierra. Son archivos de usar y
/// tirar: un fallo aquí (carpeta ya borrada, sin permisos) no importa.
pub fn remove_for_tab(tab_id: &str) {
    let dir = paths::SESSION_DIR.clone();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let needles = [format!("-{tab_id}."), format!("-{tab_id}-")];
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if needles.iter().any(|needle| name.contains(needle)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Borra la carpeta de sesión entera al cerrar la app.
pub fn cleanup() {
    let dir = paths::SESSION_DIR.clone();
    if dir.exists() {
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            log_warn!(
                "No se pudo limpiar la carpeta de sesión",
                serde_json::json!({ "dir": dir.to_string_lossy(), "error": error.to_string() })
            );
        }
    }
}

/// La carpeta de sesión, creada si aún no existía.
pub fn dir() -> Option<std::path::PathBuf> {
    match paths::session_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            log_warn!(
                "No se pudo crear la carpeta de sesión",
                serde_json::json!({ "error": error.to_string() })
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_banner_actualizado_reemplaza_tambien_el_archivo_de_sysinfo() {
        let tab_id = "banner-refresh-regression";
        let dir = dir().expect("la carpeta de sesión se crea");
        remove_for_tab(tab_id);

        refresh_banner_files(tab_id, Some("Aviso de sesión"), "banner nuevo");

        let normal = std::fs::read_to_string(dir.join(format!("banner-{tab_id}.txt"))).unwrap();
        let cleared =
            std::fs::read_to_string(dir.join(format!("bannerclear-{tab_id}.txt"))).unwrap();
        assert!(normal.contains("banner nuevo"));
        assert!(normal.contains("Aviso de sesión"));
        assert!(cleared.starts_with("\x1b[H\x1b[2J\x1b[3J"));

        remove_for_tab(tab_id);
    }

    #[test]
    fn el_banner_preserva_unicode_incluida_la_ene() {
        let tab_id = "banner-utf8-regression";
        let dir = dir().expect("la carpeta de sesión se crea");
        remove_for_tab(tab_id);

        refresh_banner_files(tab_id, Some("España ñ 日本"), "Información ñ");

        let normal = std::fs::read_to_string(dir.join(format!("banner-{tab_id}.txt"))).unwrap();
        assert!(normal.contains("España ñ 日本"));
        assert!(normal.contains("Información ñ"));
        remove_for_tab(tab_id);
    }

    #[test]
    fn solo_se_borran_los_temporales_de_la_pestana_indicada() {
        let dir = dir().expect("la carpeta de sesión se crea");
        std::fs::write(dir.join("banner-tab-99.txt"), "x").unwrap();
        std::fs::write(dir.join("init-tab-99.cmd"), "x").unwrap();
        std::fs::write(dir.join("help-tab-99-paquetes.txt"), "x").unwrap();
        std::fs::write(dir.join("banner-tab-98.txt"), "x").unwrap();

        remove_for_tab("tab-99");

        assert!(!dir.join("banner-tab-99.txt").exists());
        assert!(!dir.join("init-tab-99.cmd").exists());
        assert!(!dir.join("help-tab-99-paquetes.txt").exists());
        assert!(dir.join("banner-tab-98.txt").exists());

        std::fs::remove_file(dir.join("banner-tab-98.txt")).unwrap();
    }

    #[test]
    fn los_repl_no_reciben_fastfetch_automatico() {
        let tab_id = "repl-banner-regression";
        remove_for_tab(tab_id);
        let env = Environment::new(
            "lang:python",
            "Python · REPL",
            crate::environments::ShellKind::Repl,
            "python",
            &[],
        );
        let request = SessionRequest {
            tab_id,
            env: &env,
            script_aliases: &[],
            app_name: "WinSlim Terminal",
            nsudo_path: None,
            windows_manager: None,
            manager_label: None,
            show_banner: true,
            banner: "WinSlim Terminal\nCPU: test",
            initial_banner: true,
            clear_reprint_banner: true,
        };
        let files = write_session_files(&request, &Translator::new("es"));
        assert!(files.banner_text.is_empty());
        assert!(files.init_command.is_none());
        let dir = dir().expect("la carpeta de sesión se crea");
        assert!(!dir.join(format!("banner-{tab_id}.txt")).exists());
        remove_for_tab(tab_id);
    }
}
