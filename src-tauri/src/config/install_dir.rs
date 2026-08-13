//! Dónde está instalada ESTA copia de la aplicación.
//!
//! Módulo nuevo: hasta ahora la app no necesitaba saberlo. Hace falta para su
//! propia actualización — una release del repositorio de la app no es un
//! proyecto que descargar a Documentos, es la versión nueva de lo que está
//! corriendo, y tiene que aterrizar donde ya está instalada.
//!
//! La respuesta sale de `current_exe()` y no de una ruta escrita en el código.
//! Escribir `C:\WSCore\Components\Terminal` daría lo correcto solo mientras la
//! app estuviera exactamente ahí: una copia arrancada desde Descargas para
//! probarla se actualizaría encima de la instalada, que es justo la duplicidad
//! que se quiere evitar. Preguntando al sistema, cada copia se actualiza sobre
//! sí misma, esté donde esté.

use std::path::{Path, PathBuf};

/// Subcarpeta donde se prepara una actualización antes de aplicarla. El punto
/// inicial la deja fuera de la vista en el explorador de archivos y de los
/// listados normales.
pub const STAGING_DIR: &str = ".update";

/// La carpeta donde vive el ejecutable que está corriendo.
///
/// `None` solo si el sistema no sabe decir su propia ruta, que en la práctica
/// significa que hay algo muy roto; quien llame decide qué hacer sin eso.
pub fn current() -> Option<PathBuf> {
    // Un AppImage se monta en /tmp/.mount_xxxx y `current_exe` devuelve la ruta
    // DENTRO del montaje, que es de solo lectura y desaparece al cerrar. El
    // archivo real lo dice `$APPIMAGE`, que el propio runtime exporta.
    // Actualizar sin esto escribiría en un punto de montaje temporal.
    if let Some(appimage) = appimage_path() {
        return appimage.parent().map(Path::to_path_buf);
    }
    let exe = std::env::current_exe().ok()?;
    // `canonicalize` resuelve enlaces simbólicos: en Linux es normal tener el
    // binario enlazado desde /usr/local/bin, y actualizar el enlace en vez de
    // la carpeta real no serviría de nada.
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    exe.parent().map(Path::to_path_buf)
}

/// La ruta del `.AppImage` que está corriendo, si la app se distribuyó así.
pub fn appimage_path() -> Option<PathBuf> {
    let valor = std::env::var("APPIMAGE").ok()?;
    let ruta = PathBuf::from(valor);
    ruta.is_file().then_some(ruta)
}

/// `true` si esto es una compilación de desarrollo, no una copia instalada.
///
/// Cargo deja el binario en `target/debug` o `target/release`, junto a sus
/// artefactos. Dejar que la app se "actualice" ahí sobrescribiría el árbol de
/// compilación con una release descargada: no rompe la instalación de nadie,
/// pero destruye el trabajo en curso de quien la esté desarrollando.
pub fn is_development_build(dir: &Path) -> bool {
    let Some(nombre) = dir.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if nombre != "debug" && nombre != "release" {
        return false;
    }
    dir.parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        == Some("target")
}

/// Dónde dejar la actualización descargada, o `None` si esta copia no se puede
/// actualizar sola.
pub fn staging() -> Option<PathBuf> {
    let dir = current()?;
    if is_development_build(&dir) {
        return None;
    }
    Some(dir.join(STAGING_DIR))
}

/// Si un repositorio es el de esta misma aplicación. Se compara sin distinguir
/// mayúsculas porque GitHub tampoco las distingue.
pub fn is_self_repository(full_name: &str) -> bool {
    crate::github::default_catalog()
        .self_repository
        .is_some_and(|propio| propio.eq_ignore_ascii_case(full_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_build_de_cargo_se_reconoce_y_no_se_actualiza_sobre_si_misma() {
        assert!(is_development_build(Path::new("/proyecto/target/debug")));
        assert!(is_development_build(Path::new("/proyecto/target/release")));
        // Una carpeta instalada que se llame igual pero no cuelgue de `target`
        // sí es actualizable: el nombre solo no basta.
        assert!(!is_development_build(Path::new(
            "C:/WSCore/Components/Terminal/release"
        )));
        assert!(!is_development_build(Path::new(
            "C:/WSCore/Components/Terminal"
        )));
    }

    #[test]
    fn el_catalogo_declara_el_repositorio_para_actualizaciones() {
        assert_eq!(
            crate::github::default_catalog().self_repository.as_deref(),
            Some("Darkeiser003/Terminal")
        );
    }

    #[test]
    fn el_repositorio_propio_se_reconoce_sin_distinguir_mayusculas() {
        assert!(is_self_repository("Darkeiser003/Terminal"));
        assert!(is_self_repository("DARKEISER003/terminal"));
        assert!(!is_self_repository("otro/proyecto"));
    }

    #[test]
    fn la_carpeta_de_la_app_es_la_del_ejecutable_que_esta_corriendo() {
        // En las pruebas el binario vive en target/debug/deps, así que lo que
        // se comprueba es que responde algo y que es una carpeta real.
        let dir = current().expect("el sistema debe saber decir su propia ruta");
        assert!(dir.is_dir());
    }
}
