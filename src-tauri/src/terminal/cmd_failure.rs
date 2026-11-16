//! Órdenes fallidas en cmd.
//!
//! cmd no puede dar el código de salida en su prompt: su marca OSC 133 `D` va
//! sin código, así que la pestaña nunca sabía si una orden había fallado (ni
//! marca roja ni modo consejero). Para el caso más común, una orden que no
//! existe (`epo` en vez de `echo`), cmd escribe siempre el mismo mensaje de
//! Windows: el número 9009 de `cmd.exe`, en el idioma del sistema
//! («"%1" no se reconoce como un comando interno o externo, …» en español).
//! Ese número es además el código que deja en `ERRORLEVEL`.
//!
//! Aquí se lee ese texto del propio Windows, una sola vez, y la pestaña lo busca
//! en la salida de cada orden de cmd (`src/lib/command-marks.ts`,
//! `inferCmdExitCode`). Leerlo del sistema, y no de una lista fija, vale para
//! cualquier idioma de Windows.

use std::sync::OnceLock;

/// El código que deja cmd en `ERRORLEVEL` cuando la orden no existe; es también
/// el número del mensaje en `cmd.exe`.
pub const NOT_FOUND_CODE: u32 = 9009;

/// La parte fija del mensaje de cmd para una orden que no existe, sin el nombre
/// de la orden; en español, `" no se reconoce como un comando interno o externo,`.
/// `None` fuera de Windows o si el sistema no la da: entonces nada cambia.
#[tauri::command]
pub fn cmd_not_found_text() -> Option<String> {
    static TEXT: OnceLock<Option<String>> = OnceLock::new();
    TEXT.get_or_init(|| {
        system_message(NOT_FOUND_CODE)
            .as_deref()
            .and_then(fixed_part)
    })
    .clone()
}

/// De la plantilla (`"%1" no se reconoce …`), el trozo de una línea que va
/// pegado al nombre de la orden: lo de después de `%1` o, si no queda nada,
/// lo de antes. Tiene que tener bastantes letras: unas pocas sueltas marcarían
/// como fallidas órdenes que salieron bien.
fn fixed_part(template: &str) -> Option<String> {
    let (before, after) = template.split_once("%1")?;
    let enough = |text: &str| text.chars().filter(|c| c.is_alphabetic()).count() >= 8;
    let after = after.lines().next().unwrap_or("").trim_end();
    if enough(after) {
        return Some(after.to_string());
    }
    let before = before.lines().last().unwrap_or("").trim_start();
    enough(before).then(|| before.to_string())
}

#[cfg(windows)]
fn system_message(id: u32) -> Option<String> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::System::Diagnostics::Debug::{
        FormatMessageW, FORMAT_MESSAGE_FROM_HMODULE, FORMAT_MESSAGE_IGNORE_INSERTS,
    };
    use windows::Win32::System::LibraryLoader::{
        LoadLibraryExW, LOAD_LIBRARY_AS_DATAFILE, LOAD_LIBRARY_AS_IMAGE_RESOURCE,
    };

    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let cmd = std::path::Path::new(&root).join("System32").join("cmd.exe");
    // Como datos: no se ejecuta nada de cmd.exe, solo se leen sus mensajes
    // (Windows busca el texto en el .mui del idioma del usuario).
    let module = unsafe {
        LoadLibraryExW(
            &HSTRING::from(cmd.as_os_str()),
            None,
            LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE,
        )
    }
    .ok()?;
    let mut buffer = vec![0u16; 4096];
    let length = unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_FROM_HMODULE | FORMAT_MESSAGE_IGNORE_INSERTS,
            Some(module.0 as *const core::ffi::c_void),
            id,
            0,
            PWSTR(buffer.as_mut_ptr()),
            buffer.len() as u32,
            None,
        )
    };
    let _ = unsafe { FreeLibrary(module) };
    (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
}

#[cfg(not(windows))]
fn system_message(_id: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn se_queda_con_lo_que_va_pegado_al_nombre_de_la_orden() {
        let spanish = "\"%1\" no se reconoce como un comando interno o externo,\r\nprograma o archivo por lotes ejecutable.\r\n";
        assert_eq!(
            fixed_part(spanish).as_deref(),
            Some("\" no se reconoce como un comando interno o externo,")
        );
        let german = "Der Befehl \"%1\" ist entweder falsch geschrieben oder\r\nkonnte nicht gefunden werden.\r\n";
        assert_eq!(
            fixed_part(german).as_deref(),
            Some("\" ist entweder falsch geschrieben oder")
        );
        // Si después del nombre no queda texto, vale lo de antes.
        assert_eq!(
            fixed_part("Unknown command name: %1\r\n").as_deref(),
            Some("Unknown command name: ")
        );
    }

    #[test]
    fn sin_texto_suficiente_no_hay_nada_que_buscar() {
        assert_eq!(fixed_part("sin marcador"), None);
        assert_eq!(fixed_part("%1?"), None);
        assert_eq!(fixed_part("Error %1."), None);
    }

    /// El texto leído de Windows es el mismo que escribe cmd de verdad, y
    /// dentro de la sesión `ERRORLEVEL` vale 9009. Ojo: el código de salida
    /// del proceso `cmd /c` es 1, no 9009; en una pestaña lo que cuenta es el
    /// `ERRORLEVEL` de la sesión (lo que enseña `echo %errorlevel%`).
    #[cfg(windows)]
    #[test]
    fn el_texto_de_windows_es_el_que_escribe_cmd() {
        use std::os::windows::process::CommandExt;
        let text = cmd_not_found_text().expect("cmd.exe debe tener el mensaje 9009");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/v:on", "/s", "/c"])
            .raw_arg("\"wtordenquenoexiste9009 & echo WTCODE=!ERRORLEVEL!\"")
            .output()
            .expect("cmd.exe arranca");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains(&format!("WTCODE={NOT_FOUND_CODE}")),
            "ERRORLEVEL de la sesión: {stdout:?}"
        );
        // cmd escribe en la página de códigos de la consola: se comparan las
        // letras ASCII, que coinciden en cualquier página.
        let ascii = |bytes: &[u8]| -> String {
            bytes
                .iter()
                .filter(|byte| byte.is_ascii_alphanumeric())
                .map(|byte| *byte as char)
                .collect()
        };
        let written = ascii(&output.stderr);
        let expected = ascii(text.as_bytes());
        assert!(
            written.contains(&expected),
            "{written:?} debería contener {expected:?}"
        );
    }
}
