//! Archivos temporales de cada pestaña: banner, ayuda e inicialización de la
//! shell.
//!
//! Port de la parte de `electron/main.js` que escribe `banner-<tab>.txt`,
//! `bannerclear-<tab>.txt`, `help-<tab>.txt` e `init-<tab>.<ext>`.

use std::path::PathBuf;

use crate::alias_profiles::{self, InitOptions, ScriptAlias};
use crate::environments::Environment;
use crate::i18n::Translator;
use crate::paths;

/// El banner lo imprime la SHELL (`type`/`cat`), no la app, y en cmd.exe eso
/// significa pasar por la página de códigos OEM de la consola (850 en un
/// Windows en español), donde un archivo UTF-8 se vería como galimatías. Se
/// reduce a ASCII: se quitan las tildes y los caracteres de dibujo de cajas,
/// que es lo único no ASCII que genera el banner. Las secuencias de color son
/// ASCII y se conservan.
pub fn to_console_ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '─' | '━' => out.push('-'),
            '│' | '┃' => out.push('|'),
            '▶' | '►' => out.push('>'),
            // El punto medio separa etiquetas por toda la app ("Git Bash ·
            // bash"). Sin esta línea acababa como "?" en la consola, que es
            // justo lo que el resto de la función intenta evitar.
            '·' | '•' => out.push('-'),
            _ if ch.is_ascii() => out.push(ch),
            // Descompone las letras acentuadas y quita las tildes sueltas
            // (á -> a), en vez de convertirlas en un signo de interrogación.
            _ => match strip_accent(ch) {
                Some(plain) => out.push(plain),
                None => out.push(' '),
            },
        }
    }
    out
}

/// Equivalente a `normalize('NFD')` + quitar los diacríticos combinantes, para
/// las letras que de verdad aparecen en los textos de la app (español). Una
/// tabla corta evita arrastrar una dependencia de normalización Unicode entera
/// para diez caracteres.
fn strip_accent(ch: char) -> Option<char> {
    #[rustfmt::skip]
    const TABLE: [(char, char); 26] = [
        ('á', 'a'), ('é', 'e'), ('í', 'i'), ('ó', 'o'), ('ú', 'u'), ('ü', 'u'),
        ('Á', 'A'), ('É', 'E'), ('Í', 'I'), ('Ó', 'O'), ('Ú', 'U'), ('Ü', 'U'),
        ('à', 'a'), ('è', 'e'), ('ì', 'i'), ('ò', 'o'), ('ù', 'u'),
        ('À', 'A'), ('È', 'E'), ('Ì', 'I'), ('Ò', 'O'), ('Ù', 'U'),
        ('â', 'a'), ('ê', 'e'), ('î', 'i'), ('ô', 'o'),
    ];
    TABLE
        .iter()
        .find(|(accented, _)| *accented == ch)
        .map(|(_, plain)| *plain)
}

/// Lo que la pestaña necesita saber después de preparar sus archivos.
pub struct SessionFiles {
    /// La línea corta que hay que teclear en la shell para cargar la
    /// inicialización, o `None` si este entorno no lleva ninguna (o si el
    /// temporal no era escribible: ahí la terminal funciona igual, solo se
    /// queda sin alias).
    pub init_command: Option<String>,
    /// El banner que tiene que pintar la app cuando no lo pinta la shell.
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
}

/// Escribe el banner y el archivo de inicialización de una pestaña.
pub fn write_session_files(request: &SessionRequest<'_>, t: &Translator) -> SessionFiles {
    let banner_text = if request.show_banner {
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

    if request.show_banner {
        if let Some(dir) = &dir {
            // Dos versiones del banner. La normal la usa "sysinfo", que solo
            // imprime. La de limpieza lleva delante un borrado explícito de
            // pantalla e historial: tras un `cls`, ConPTY repinta la línea del
            // prompt anterior, y sin esto quedaba flotando encima del banner.
            let ascii = to_console_ascii(&banner_text);
            let normal = dir.join(format!("banner-{}.txt", request.tab_id));
            let cleared = dir.join(format!("bannerclear-{}.txt", request.tab_id));
            match (
                std::fs::write(&normal, &ascii),
                std::fs::write(&cleared, format!("\x1b[H\x1b[2J\x1b[3J{ascii}")),
            ) {
                (Ok(()), Ok(())) => {
                    banner_path = Some(normal);
                    banner_clear_path = Some(cleared);
                }
                _ => log_warn!(
                    "No se pudo escribir el banner de la pestaña",
                    serde_json::json!({ "tabId": request.tab_id })
                ),
            }
        }
    }

    // Docker, ADB y Wine no llegan a los temporales del host: allí el banner lo
    // escribe la app en el xterm y no se intenta cargar inicialización ninguna.
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
    let help_str = help_path.as_ref().map(|p| p.to_string_lossy().to_string());

    let script = alias_profiles::build_init_script(
        request.env.kind,
        t,
        &InitOptions {
            nsudo_path: request.nsudo_path,
            script_aliases: request.script_aliases,
            banner_path: banner_str.as_deref(),
            banner_clear_path: banner_clear_str.as_deref(),
            help_path: help_str.as_deref(),
            transport: request.env.transport,
            app_name: request.app_name,
            env_label: &request.env.label,
            manager_label: request.manager_label,
            platform: std::env::consts::OS,
            windows_manager: request.windows_manager,
        },
    );

    let Some(script) = script else {
        return SessionFiles {
            init_command: None,
            banner_text,
        };
    };

    if let (Some(help_path), Some(help_text)) = (&help_path, &script.help_text) {
        // Solo cmd y Windows PowerShell leen el archivo en la página de códigos
        // de la consola, donde un UTF-8 se ve como galimatías. bash, zsh, fish y
        // WSL lo imprimen bien con `cat`, así que ahí la ayuda conserva sus
        // tildes en vez de quedar en "Sesion".
        let needs_ascii = matches!(
            request.env.kind,
            crate::environments::ShellKind::Cmd | crate::environments::ShellKind::Powershell
        );
        let body = if needs_ascii {
            to_console_ascii(help_text)
        } else {
            help_text.clone()
        };
        // Sin archivo de ayuda la sesión funciona igual: `ayuda` imprimirá el
        // archivo vacío en vez del resumen. No se aborta por esto.
        if std::fs::write(help_path, body).is_err() {
            log_warn!(
                "No se pudo escribir la ayuda de la pestaña",
                serde_json::json!({ "tabId": request.tab_id })
            );
        }
    }

    let Some(dir) = dir else {
        return SessionFiles {
            init_command: None,
            banner_text,
        };
    };
    let init_path = dir.join(format!("init-{}.{}", request.tab_id, script.ext));
    if std::fs::write(&init_path, &script.content).is_err() {
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

/// Borra los temporales de una pestaña que se cierra. Son archivos de usar y
/// tirar: un fallo aquí (carpeta ya borrada, sin permisos) no importa.
pub fn remove_for_tab(tab_id: &str) {
    let dir = paths::SESSION_DIR.clone();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let needle = format!("-{tab_id}.");
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(&needle) {
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
    fn el_dibujo_de_cajas_se_convierte_en_ascii() {
        assert_eq!(to_console_ascii("─│▶·"), "-|>-");
        assert_eq!(to_console_ascii("━┃►•"), "-|>-");
    }

    #[test]
    fn las_tildes_se_quitan_en_vez_de_perderse() {
        assert_eq!(to_console_ascii("Sesión iniciada"), "Sesion iniciada");
        assert_eq!(to_console_ascii("ÁÉÍÓÚ áéíóú"), "AEIOU aeiou");
    }

    #[test]
    fn las_secuencias_de_color_se_conservan() {
        let coloreado = "\x1b[33maviso\x1b[0m";
        assert_eq!(to_console_ascii(coloreado), coloreado);
    }

    #[test]
    fn lo_que_no_se_sabe_reducir_acaba_en_espacio() {
        assert_eq!(to_console_ascii("日本"), "  ");
        // La eñe no lleva tilde que quitar: no es reducible a 'n' sin perder
        // la letra, así que sigue el mismo camino que el resto.
        assert_eq!(to_console_ascii("ñ"), " ");
    }

    #[test]
    fn solo_se_borran_los_temporales_de_la_pestana_indicada() {
        let dir = dir().expect("la carpeta de sesión se crea");
        std::fs::write(dir.join("banner-tab-99.txt"), "x").unwrap();
        std::fs::write(dir.join("init-tab-99.cmd"), "x").unwrap();
        std::fs::write(dir.join("banner-tab-98.txt"), "x").unwrap();

        remove_for_tab("tab-99");

        assert!(!dir.join("banner-tab-99.txt").exists());
        assert!(!dir.join("init-tab-99.cmd").exists());
        assert!(dir.join("banner-tab-98.txt").exists());

        std::fs::remove_file(dir.join("banner-tab-98.txt")).unwrap();
    }
}
