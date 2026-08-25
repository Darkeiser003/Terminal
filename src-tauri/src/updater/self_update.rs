//! Cómo se actualiza la aplicación a sí misma.
//!
//! Módulo nuevo: la versión Electron no se actualizaba sola. Su release se
//! descargaba como la de cualquier otro proyecto anclado, a
//! `Documentos/<proyectos>/_releases/…`, y quedaban dos copias sin saber cuál
//! era la que se estaba ejecutando.
//!
//! ## Por qué hay que reiniciar
//!
//! Windows no deja sobrescribir un `.exe` en marcha, ni un `.dll` cargado. Lo
//! que sí deja es RENOMBRARLOS: el archivo abierto sigue vivo bajo su nombre
//! nuevo y el sitio queda libre para el archivo nuevo. Sobre eso se construye
//! todo lo de aquí:
//!
//!   1. se copia la versión nueva a `<instalación>/<nombre>.new`, sin tocar
//!      nada de lo que hay;
//!   2. solo cuando TODAS las copias han ido bien, se hacen los renombrados
//!      (`<nombre>` -> `<nombre>.old`, `<nombre>.new` -> `<nombre>`), que son
//!      rápidos y no pueden quedarse a medias por falta de disco;
//!   3. la app se reinicia; el proceso viejo muere y suelta los `.old`;
//!   4. el arranque siguiente los borra.
//!
//! El orden importa: copiar es lo lento y lo que puede fallar (disco lleno,
//! permisos, antivirus), y mientras se copia la instalación sigue entera. Si
//! algo falla ahí, se limpia y no ha pasado nada.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::platform::traits::HostPlatform;

use crate::install_dir;

/// Sufijo del archivo que se está reemplazando y sigue en uso.
const OLD_SUFFIX: &str = ".old";
/// Sufijo de la copia nueva mientras aún no ocupa su sitio.
const NEW_SUFFIX: &str = ".new";

/// Una versión comparable. Se queda con los números y descarta lo demás:
/// `v1.4.3`, `1.4.3` y `1.4.3-beta` dan los mismos tres números.
///
/// No es semver completo a propósito. Lo único que hay que responder es "¿la
/// publicada es más nueva que la que corre?", y para eso comparar los números
/// por orden basta. Tratar `1.4.3-beta` como igual a `1.4.3` es lo prudente:
/// ante la duda, no se ofrece una actualización que quizá sea la misma.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(Vec<u64>);

impl Version {
    pub fn parse(raw: &str) -> Option<Version> {
        let limpio = raw.trim().trim_start_matches(['v', 'V']);
        let numeros: Vec<u64> = limpio
            .split(['.', '-', '+', '_'])
            .map(|parte| {
                parte
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .take_while(|parte| !parte.is_empty())
            .filter_map(|parte| parte.parse().ok())
            .collect();
        (!numeros.is_empty()).then_some(Version(numeros))
    }

    /// Compara rellenando con ceros: `1.4` y `1.4.0` son la misma versión.
    pub fn is_newer_than(&self, other: &Version) -> bool {
        let largo = self.0.len().max(other.0.len());
        for indice in 0..largo {
            let mio = self.0.get(indice).copied().unwrap_or(0);
            let suyo = other.0.get(indice).copied().unwrap_or(0);
            if mio != suyo {
                return mio > suyo;
            }
        }
        false
    }
}

/// El adjunto de una release que corresponde a ESTA plataforma.
///
/// En Windows la app se distribuye como carpeta comprimida y en Linux como
/// AppImage, así que se busca por extensión. Un `.exe` de instalador o el
/// código fuente que GitHub añade solo se descartan por no coincidir.
pub fn asset_for_platform<'a>(names: &[&'a str]) -> Option<&'a str> {
    let (extension, excluir): (&str, &[&str]) = if crate::platform::host().is_windows() {
        (".zip", &["source", "linux", "macos", "darwin"])
    } else {
        (".appimage", &["source", "windows", "macos"])
    };
    names
        .iter()
        .find(|name| {
            let bajo = name.to_lowercase();
            bajo.ends_with(extension) && !excluir.iter().any(|malo| bajo.contains(malo))
        })
        .copied()
}

/// Lo que se sabe del estado de actualización, tal y como lo ve el frontend.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    /// La última publicada, si se ha llegado a consultar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub available: bool,
    /// Esta copia puede actualizarse sola. `false` en una build de desarrollo.
    pub can_self_update: bool,
    /// Dónde aterrizaría la actualización, para poder enseñarlo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// La carpeta que de verdad contiene los archivos, dentro de lo extraído.
///
/// Un `.zip` publicado puede traer los archivos en la raíz o dentro de una
/// única carpeta (`WinSlimTerminal-1.4.3/…`), según cómo se comprimiera. Se
/// desciende mientras solo haya una carpeta y nada más, para que las dos formas
/// funcionen sin que quien publique tenga que acordarse de cuál toca.
pub fn payload_root(staged: &Path) -> PathBuf {
    let mut actual = staged.to_path_buf();
    for _ in 0..4 {
        let Ok(entradas) = std::fs::read_dir(&actual) else {
            return actual;
        };
        let hijos: Vec<_> = entradas.filter_map(Result::ok).collect();
        match hijos.as_slice() {
            [unico] if unico.path().is_dir() => actual = unico.path(),
            _ => return actual,
        }
    }
    actual
}

/// Comprueba que lo descargado es de verdad esta aplicación antes de tocar
/// nada. Sin esto, un `.zip` equivocado dejaría la instalación llena de
/// archivos ajenos y sin el ejecutable.
pub fn verify_payload(root: &Path, binary_name: &str) -> Result<(), String> {
    let binario = root.join(binary_name);
    if !binario.is_file() {
        return Err(format!(
            "Lo descargado no parece esta aplicación: no trae {binary_name}."
        ));
    }
    if crate::platform::host().is_windows() {
        for recurso in windows_runtime_files() {
            if !root.join(recurso).is_file() {
                return Err(format!(
                    "La actualización Windows está incompleta: falta {recurso}."
                ));
            }
        }
    }
    Ok(())
}

/// Todo lo que necesita una carpeta portable Windows después de una
/// actualización. El instalador y la build portable ya lo validan antes de
/// publicar; repetirlo aquí evita que una release incompleta rompa una copia
/// que funcionaba.
fn windows_runtime_files() -> [&'static str; 15] {
    [
        "conpty.dll",
        "OpenConsole.exe",
        "WebView2Loader.dll",
        "scripts/containers/docker-manager.sh",
        "scripts/containers/kubernetes-manager.sh",
        "scripts/operations/docker-manager.ps1",
        "scripts/operations/kubernetes-manager.ps1",
        "scripts/operations/ssh-manager.ps1",
        "scripts/operations/service-manager.ps1",
        "scripts/operations/network-manager.ps1",
        "scripts/operations/adb-manager.ps1",
        "scripts/operations/ssh-manager.sh",
        "scripts/operations/service-manager.sh",
        "scripts/operations/network-manager.sh",
        "scripts/operations/adb-manager.sh",
    ]
}

/// Los archivos de la versión nueva, con su ruta relativa a la raíz.
fn staged_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut salida = Vec::new();
    let mut pendientes = vec![PathBuf::new()];
    while let Some(relativa) = pendientes.pop() {
        let dir = root.join(&relativa);
        let entradas = std::fs::read_dir(&dir)
            .map_err(|error| format!("No se pudo leer {}: {error}", dir.display()))?;
        for entrada in entradas.filter_map(Result::ok) {
            let hijo = relativa.join(entrada.file_name());
            if entrada.path().is_dir() {
                pendientes.push(hijo);
            } else {
                salida.push(hijo);
            }
        }
    }
    Ok(salida)
}

/// Aplica la actualización sobre la carpeta de instalación.
///
/// Después de esto la app tiene que reiniciarse: el proceso en marcha sigue
/// usando los archivos renombrados a `.old`, y hasta que muera no hay versión
/// nueva corriendo.
pub fn apply(root: &Path, install: &Path, binary_name: &str) -> Result<(), String> {
    verify_payload(root, binary_name)?;
    let archivos = staged_files(root)?;
    if archivos.is_empty() {
        return Err("La actualización descargada está vacía.".to_string());
    }

    // Fase 1: copiar. Es lo lento y lo que puede fallar; mientras tanto la
    // instalación sigue completa y en marcha.
    let mut copiados: Vec<PathBuf> = Vec::new();
    for relativa in &archivos {
        let destino = install.join(añadir_sufijo(relativa, NEW_SUFFIX));
        if let Some(padre) = destino.parent() {
            if let Err(error) = std::fs::create_dir_all(padre) {
                limpiar(&copiados);
                return Err(format!("No se pudo preparar {}: {error}", padre.display()));
            }
        }
        if let Err(error) = std::fs::copy(root.join(relativa), &destino) {
            limpiar(&copiados);
            return Err(format!("No se pudo copiar {}: {error}", relativa.display()));
        }
        copiados.push(destino);
    }

    // Fase 2: renombrar. Rápido y sin depender del disco libre. Un `.exe` o un
    // `.dll` en uso no se puede sobrescribir ni borrar, pero SÍ renombrar: por
    // eso el viejo se aparta en vez de eliminarse.
    for relativa in &archivos {
        let destino = install.join(relativa);
        let nuevo = install.join(añadir_sufijo(relativa, NEW_SUFFIX));
        if destino.exists() {
            let apartado = install.join(añadir_sufijo(relativa, OLD_SUFFIX));
            // Un `.old` de una actualización anterior que no se pudo borrar
            // bloquearía el renombrado: se intenta quitar y, si no se deja, se
            // usa un nombre libre.
            let _ = std::fs::remove_file(&apartado);
            let apartado = if apartado.exists() {
                install.join(añadir_sufijo(
                    relativa,
                    &format!(".{}{OLD_SUFFIX}", stamp()),
                ))
            } else {
                apartado
            };
            std::fs::rename(&destino, &apartado)
                .map_err(|error| format!("No se pudo apartar {}: {error}", relativa.display()))?;
        }
        std::fs::rename(&nuevo, &destino)
            .map_err(|error| format!("No se pudo instalar {}: {error}", relativa.display()))?;
    }
    Ok(())
}

/// Marca de tiempo corta para desempatar nombres. No hace falta que sea única
/// en el universo: solo que no choque con el `.old` que sigue bloqueado.
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn añadir_sufijo(relativa: &Path, sufijo: &str) -> PathBuf {
    let mut nombre = relativa.as_os_str().to_os_string();
    nombre.push(sufijo);
    PathBuf::from(nombre)
}

fn limpiar(archivos: &[PathBuf]) {
    for archivo in archivos {
        let _ = std::fs::remove_file(archivo);
    }
}

/// Borra lo que dejó una actualización anterior. Se llama al arrancar, cuando
/// el proceso que bloqueaba los `.old` ya no existe.
///
/// Lo que no se deje borrar se queda para el arranque siguiente: no es un error
/// que merezca molestar a nadie.
pub fn cleanup(install: &Path) -> usize {
    let Ok(entradas) = std::fs::read_dir(install) else {
        return 0;
    };
    let mut borrados = 0;
    for entrada in entradas.filter_map(Result::ok) {
        let nombre = entrada.file_name();
        let Some(nombre) = nombre.to_str() else {
            continue;
        };
        if nombre.ends_with(OLD_SUFFIX) && std::fs::remove_file(entrada.path()).is_ok() {
            borrados += 1;
        }
    }
    // La carpeta de preparación tampoco tiene sentido conservarla: lo que había
    // dentro ya está instalado.
    let _ = std::fs::remove_dir_all(install.join(install_dir::STAGING_DIR));
    borrados
}

/// El nombre del ejecutable de esta plataforma.
pub fn binary_name() -> String {
    // En un AppImage el ejecutable instalado es el propio archivo, no el
    // binario de dentro del montaje.
    if let Some(appimage) = install_dir::appimage_path() {
        if let Some(nombre) = appimage.file_name() {
            return nombre.to_string_lossy().to_string();
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| {
            if crate::platform::host().is_windows() {
                "winslim-terminal.exe".to_string()
            } else {
                "lterminal".to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn escribir(ruta: &Path, contenido: &str) {
        if let Some(padre) = ruta.parent() {
            std::fs::create_dir_all(padre).unwrap();
        }
        std::fs::write(ruta, contenido).unwrap();
    }

    #[test]
    fn una_version_se_lee_con_o_sin_la_uve_de_delante() {
        assert_eq!(Version::parse("v1.4.3"), Version::parse("1.4.3"));
        assert_eq!(Version::parse("  V2.0  "), Version::parse("2.0"));
        assert!(Version::parse("").is_none());
        assert!(Version::parse("sin-numeros").is_none());
    }

    #[test]
    fn se_compara_por_numeros_y_no_alfabeticamente() {
        // "1.10.0" > "1.9.0" es falso comparando textos, que es el fallo
        // clasico de estas comparaciones.
        let diez = Version::parse("1.10.0").unwrap();
        let nueve = Version::parse("1.9.0").unwrap();
        assert!(diez.is_newer_than(&nueve));
        assert!(!nueve.is_newer_than(&diez));
    }

    #[test]
    fn una_version_con_menos_tramos_se_completa_con_ceros() {
        let corta = Version::parse("1.4").unwrap();
        let larga = Version::parse("1.4.0").unwrap();
        assert!(!corta.is_newer_than(&larga));
        assert!(!larga.is_newer_than(&corta));
        assert!(Version::parse("1.4.1").unwrap().is_newer_than(&corta));
    }

    #[test]
    fn la_misma_version_no_se_ofrece_como_actualizacion() {
        let actual = Version::parse("1.4.3").unwrap();
        assert!(!actual.is_newer_than(&actual));
        // Y una preliminar de la misma version tampoco: ante la duda, no se
        // ofrece algo que quiza sea lo mismo que ya esta instalado.
        assert!(!Version::parse("1.4.3-beta").unwrap().is_newer_than(&actual));
    }

    #[test]
    fn de_una_release_se_elige_el_adjunto_de_esta_plataforma() {
        let adjuntos = [
            "WinSlimTerminal-Unpacked-1.4.3.zip",
            "LTerminal-1.4.3-x86_64.AppImage",
            "Source code (zip)",
        ];
        let elegido = asset_for_platform(&adjuntos).unwrap();
        if cfg!(windows) {
            assert_eq!(elegido, "WinSlimTerminal-Unpacked-1.4.3.zip");
        } else {
            assert_eq!(elegido, "LTerminal-1.4.3-x86_64.AppImage");
        }
    }

    #[test]
    fn el_codigo_fuente_que_anade_github_no_se_confunde_con_la_aplicacion() {
        // GitHub adjunta siempre un "Source code (zip)": en Windows termina en
        // .zip igual que el paquete de verdad.
        assert!(asset_for_platform(&["Source code (zip)", "source-1.4.3.zip"]).is_none());
    }

    #[test]
    fn una_release_sin_adjunto_para_esta_plataforma_no_devuelve_nada() {
        assert!(asset_for_platform(&["notas.txt", "checksums.sha256"]).is_none());
    }

    #[test]
    fn se_desciende_hasta_la_carpeta_que_de_verdad_trae_los_archivos() {
        let dir = tempfile::tempdir().unwrap();
        // Un zip comprimido "con carpeta dentro".
        escribir(&dir.path().join("WinSlimTerminal-1.4.3/app.exe"), "x");
        escribir(&dir.path().join("WinSlimTerminal-1.4.3/conpty.dll"), "y");
        let raiz = payload_root(dir.path());
        assert!(raiz.join("app.exe").is_file());
    }

    #[test]
    fn el_archivo_descargado_no_puede_acabar_junto_al_ejecutable() {
        // Si la descarga y lo extraido compartieran carpeta, `payload_root` se
        // quedaria en ella (tiene mas de un hijo) y el .zip contaria como un
        // archivo mas de la version nueva: acabaria copiado junto al .exe. Por
        // eso se extrae en su propia subcarpeta.
        let dir = tempfile::tempdir().unwrap();
        escribir(&dir.path().join("WinSlimTerminal-1.4.3.zip"), "zip");
        escribir(&dir.path().join("payload/app.exe"), "nuevo");

        // Mezclados, el zip entra en el reparto.
        assert_eq!(payload_root(dir.path()), dir.path());
        assert_eq!(staged_files(dir.path()).unwrap().len(), 2);

        // Separados, solo entran los archivos de la version nueva.
        let raiz = payload_root(&dir.path().join("payload"));
        assert_eq!(staged_files(&raiz).unwrap().len(), 1);
    }

    #[test]
    fn un_paquete_sin_carpeta_intermedia_se_usa_tal_cual() {
        let dir = tempfile::tempdir().unwrap();
        escribir(&dir.path().join("app.exe"), "x");
        escribir(&dir.path().join("conpty.dll"), "y");
        assert_eq!(payload_root(dir.path()), dir.path());
    }

    #[test]
    fn no_se_toca_nada_si_lo_descargado_no_trae_el_ejecutable() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("otra-cosa.exe"), "nuevo");
        escribir(&install.path().join("app.exe"), "original");

        let error = apply(staged.path(), install.path(), "app.exe").unwrap_err();
        assert!(error.contains("no parece esta aplicación"));
        // La instalación sigue intacta.
        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe")).unwrap(),
            "original"
        );
    }

    #[test]
    fn aplicar_reemplaza_los_archivos_y_aparta_los_viejos() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&staged.path().join("conpty.dll"), "dll-nueva");
        escribir(&install.path().join("app.exe"), "viejo");
        escribir(&install.path().join("conpty.dll"), "dll-vieja");

        apply(staged.path(), install.path(), "app.exe").unwrap();

        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe")).unwrap(),
            "nuevo"
        );
        // El viejo no se borra: en Windows sigue en uso por el proceso vivo.
        assert_eq!(
            std::fs::read_to_string(install.path().join("app.exe.old")).unwrap(),
            "viejo"
        );
    }

    #[test]
    fn un_archivo_nuevo_que_no_existia_se_instala_sin_apartar_nada() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&staged.path().join("locales/es.json"), "{}");
        escribir(&install.path().join("app.exe"), "viejo");

        apply(staged.path(), install.path(), "app.exe").unwrap();

        assert!(install.path().join("locales/es.json").is_file());
        assert!(!install.path().join("locales/es.json.old").exists());
    }

    #[test]
    fn no_queda_ningun_archivo_a_medias_cuando_todo_va_bien() {
        let staged = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        escribir(&staged.path().join("app.exe"), "nuevo");
        escribir(&install.path().join("app.exe"), "viejo");

        apply(staged.path(), install.path(), "app.exe").unwrap();

        let restos: Vec<String> = std::fs::read_dir(install.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|nombre| nombre.ends_with(NEW_SUFFIX))
            .collect();
        assert!(restos.is_empty(), "quedaron copias a medias: {restos:?}");
    }

    #[test]
    fn el_arranque_borra_lo_que_dejo_la_actualizacion_anterior() {
        let install = tempfile::tempdir().unwrap();
        escribir(&install.path().join("app.exe"), "actual");
        escribir(&install.path().join("app.exe.old"), "anterior");
        escribir(&install.path().join("conpty.dll.old"), "anterior");
        escribir(
            &install
                .path()
                .join(install_dir::STAGING_DIR)
                .join("app.exe"),
            "descargado",
        );

        assert_eq!(cleanup(install.path()), 2);
        assert!(!install.path().join("app.exe.old").exists());
        assert!(!install.path().join(install_dir::STAGING_DIR).exists());
        // Y no se lleva por delante lo que está en uso.
        assert!(install.path().join("app.exe").is_file());
    }

    #[test]
    fn limpiar_una_carpeta_sin_restos_no_es_un_error() {
        let install = tempfile::tempdir().unwrap();
        escribir(&install.path().join("app.exe"), "actual");
        assert_eq!(cleanup(install.path()), 0);
        assert!(install.path().join("app.exe").is_file());
    }
}
