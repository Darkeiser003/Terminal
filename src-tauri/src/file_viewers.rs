//! Qué programa hace falta para abrir un archivo que el sistema no sabe abrir.
//!
//! Port de `electron/main/fileViewers.js`.
//!
//! Cuando el sistema no consigue abrir una ruta (no hay ninguna aplicación
//! asociada a esa extensión), la app propone instalar un visor adecuado al tipo
//! de archivo. La propuesta NO se ejecuta sola: el frontend pide confirmación
//! y, al aceptar, el comando se escribe en la terminal visible como cualquier
//! otra acción del panel de dependencias.
//!
//! Los identificadores que salen de aquí son ids de acciones reales del
//! catálogo de instalación, de modo que instalar un visor desde el aviso y
//! hacerlo desde el panel son exactamente la misma operación.

use serde::Serialize;

struct ViewerCategory {
    id: &'static str,
    label: &'static str,
    extensions: &'static [&'static str],
}

#[rustfmt::skip]
static VIEWER_CATEGORIES: &[ViewerCategory] = &[
    ViewerCategory { id: "image", label: "imágenes", extensions: &[
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
        ".tif", ".tiff", ".avif", ".heic", ".psd",
    ]},
    // `.ts` no aparece en vídeo a propósito: en una terminal de desarrollo es
    // TypeScript mucho más a menudo que un MPEG transport stream.
    ViewerCategory { id: "video", label: "vídeo", extensions: &[
        ".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".wmv", ".mpg", ".mpeg", ".flv",
    ]},
    ViewerCategory { id: "audio", label: "audio", extensions: &[
        ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".wma", ".mid", ".midi",
    ]},
    ViewerCategory { id: "document", label: "documentos PDF", extensions: &[
        ".pdf", ".epub", ".mobi", ".djvu", ".xps", ".cbz", ".cbr",
    ]},
    ViewerCategory { id: "archive", label: "archivos comprimidos", extensions: &[
        ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".zst", ".iso", ".cab", ".lzh",
    ]},
    ViewerCategory { id: "code", label: "código y texto", extensions: &[
        ".c", ".h", ".cpp", ".hpp", ".cs", ".java", ".kt", ".swift", ".go", ".rs",
        ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".php", ".rb", ".py", ".lua",
        ".sql", ".yml", ".yaml", ".toml", ".ini", ".conf", ".cfg", ".env",
        ".md", ".markdown", ".txt", ".log", ".csv", ".json", ".xml", ".diff", ".patch",
    ]},
];

/// Un visor concreto: la acción del catálogo de instalación y el nombre que se
/// le enseña al usuario.
#[derive(Clone, Copy)]
struct Viewer {
    action_id: &'static str,
    app: &'static str,
}

const fn viewer(action_id: &'static str, app: &'static str) -> Option<Viewer> {
    Some(Viewer { action_id, app })
}

/// Visor recomendado por categoría y plataforma. `None` = en esa plataforma el
/// sistema ya trae visor y no hay nada que proponer (macOS abre imágenes y PDF
/// con Vista Previa).
struct ViewerRow {
    category: &'static str,
    windows: Option<Viewer>,
    linux: Option<Viewer>,
    macos: Option<Viewer>,
}

#[rustfmt::skip]
static VIEWERS: &[ViewerRow] = &[
    ViewerRow { category: "image",
        windows: viewer("viewer-image", "ImageGlass"),
        linux: viewer("viewer-image", "Eye of GNOME"),
        macos: None },
    ViewerRow { category: "video",
        windows: viewer("viewer-media", "VLC"),
        linux: viewer("viewer-media", "VLC"),
        macos: viewer("viewer-media", "VLC") },
    ViewerRow { category: "audio",
        windows: viewer("viewer-media", "VLC"),
        linux: viewer("viewer-media", "VLC"),
        macos: viewer("viewer-media", "VLC") },
    ViewerRow { category: "document",
        windows: viewer("viewer-document", "SumatraPDF"),
        linux: viewer("viewer-document", "Evince"),
        macos: None },
    ViewerRow { category: "archive",
        windows: viewer("viewer-archive", "7-Zip"),
        linux: viewer("viewer-archive", "p7zip"),
        macos: viewer("viewer-archive", "p7zip") },
    ViewerRow { category: "code",
        windows: viewer("viewer-code", "Visual Studio Code"),
        linux: viewer("viewer-code", "Visual Studio Code"),
        macos: viewer("viewer-code", "Visual Studio Code") },
];

pub fn platform_key(platform: &str) -> &'static str {
    match platform {
        "win32" | "windows" => "windows",
        "darwin" | "macos" => "macos",
        _ => "linux",
    }
}

pub fn viewer_category_for(extension: &str) -> Option<&'static str> {
    let ext = extension.to_lowercase();
    if ext.is_empty() {
        return None;
    }
    VIEWER_CATEGORIES
        .iter()
        .find(|category| category.extensions.contains(&ext.as_str()))
        .map(|category| category.id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSuggestion {
    pub category: &'static str,
    pub category_label: &'static str,
    pub app: &'static str,
    pub action_id: &'static str,
}

/// Sugerencia para un archivo concreto, o `None` si no hay ninguna que ofrecer
/// (extensión desconocida, o plataforma donde el sistema ya trae visor).
pub fn suggest_viewer(extension: &str, platform: &str) -> Option<ViewerSuggestion> {
    let category = viewer_category_for(extension)?;
    let label = VIEWER_CATEGORIES
        .iter()
        .find(|entry| entry.id == category)?
        .label;
    let row = VIEWERS.iter().find(|row| row.category == category)?;
    let chosen = match platform_key(platform) {
        "windows" => row.windows,
        "macos" => row.macos,
        _ => row.linux,
    }?;
    Some(ViewerSuggestion {
        category,
        category_label: label,
        app: chosen.app,
        action_id: chosen.action_id,
    })
}

// ---- Gestores de archivos (abrir una CARPETA) ----
//
// Abrir una carpeta no se parece a abrir un archivo: no hay extensión que mirar
// y no existe "el visor de carpetas". Windows y macOS siempre traen el suyo
// (Explorador, Finder) y el sistema da con él sin más. En Linux depende del
// escritorio: en una instalación mínima, en un servidor o en un escritorio muy
// recortado puede no haber ninguno registrado, y ahí `xdg-open` falla sin decir
// por qué. En ese caso la app pregunta con cuál abrirla de entre los que haya,
// y si no hay ninguno ofrece instalarlo.

pub struct FileManager {
    pub id: &'static str,
    /// El ejecutable que se lanza con la carpeta como único argumento: todos
    /// estos gestores aceptan esa forma.
    pub cmd: &'static str,
    pub app: &'static str,
    /// Acción de instalación, si la app ofrece instalarlo.
    pub action_id: Option<&'static str>,
}

#[rustfmt::skip]
static WINDOWS_MANAGERS: &[FileManager] = &[
    FileManager { id: "explorer", cmd: "explorer", app: "Explorador de Windows", action_id: None },
];

#[rustfmt::skip]
static MACOS_MANAGERS: &[FileManager] = &[
    FileManager { id: "finder", cmd: "open", app: "Finder", action_id: None },
];

#[rustfmt::skip]
static LINUX_MANAGERS: &[FileManager] = &[
    FileManager { id: "nautilus", cmd: "nautilus", app: "Archivos (GNOME)", action_id: Some("viewer-files-nautilus") },
    FileManager { id: "dolphin", cmd: "dolphin", app: "Dolphin (KDE)", action_id: Some("viewer-files-dolphin") },
    FileManager { id: "thunar", cmd: "thunar", app: "Thunar (Xfce)", action_id: Some("viewer-files-thunar") },
    // Estos tres se reconocen si ya están, pero no se ofrecen para instalar:
    // son los gestores propios de un escritorio concreto y llenar el panel con
    // seis instaladores para elegir uno no ayuda.
    FileManager { id: "nemo", cmd: "nemo", app: "Nemo (Cinnamon)", action_id: None },
    FileManager { id: "caja", cmd: "caja", app: "Caja (MATE)", action_id: None },
    FileManager { id: "pcmanfm", cmd: "pcmanfm", app: "PCManFM", action_id: None },
];

pub fn file_managers_for(platform: &str) -> &'static [FileManager] {
    match platform_key(platform) {
        "windows" => WINDOWS_MANAGERS,
        "macos" => MACOS_MANAGERS,
        _ => LINUX_MANAGERS,
    }
}

pub fn file_manager_by_id(platform: &str, id: &str) -> Option<&'static FileManager> {
    file_managers_for(platform)
        .iter()
        .find(|manager| manager.id == id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledManager {
    pub id: &'static str,
    pub app: &'static str,
    pub cmd: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallableManager {
    pub id: &'static str,
    pub app: &'static str,
    pub action_id: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerChoices {
    pub installed: Vec<InstalledManager>,
    pub installable: Vec<InstallableManager>,
}

/// Separa los gestores que se pueden usar ya de los que habría que instalar.
/// `is_installed` se inyecta para poder probar esto sin depender de lo que
/// tenga la máquina donde corren las pruebas.
pub fn file_manager_choices(platform: &str, is_installed: &dyn Fn(&str) -> bool) -> ManagerChoices {
    let all = file_managers_for(platform);
    let installed: Vec<&FileManager> = all
        .iter()
        .filter(|manager| is_installed(manager.cmd))
        .collect();
    ManagerChoices {
        installable: all
            .iter()
            .filter(|manager| {
                manager.action_id.is_some() && !installed.iter().any(|found| found.id == manager.id)
            })
            .map(|manager| InstallableManager {
                id: manager.id,
                app: manager.app,
                action_id: manager.action_id.unwrap_or(""),
            })
            .collect(),
        installed: installed
            .into_iter()
            .map(|manager| InstalledManager {
                id: manager.id,
                app: manager.app,
                cmd: manager.cmd,
            })
            .collect(),
    }
}

/// Cada escritorio trae su propio gestor, y es el que el usuario reconoce como
/// "el explorador de archivos" de su sistema. Con varios instalados —algo
/// normal: instalar una aplicación KDE arrastra Dolphin a un GNOME— elegir por
/// escritorio acierta mucho más que quedarse con el primero de la lista.
///
/// `$XDG_CURRENT_DESKTOP` puede traer varios separados por dos puntos
/// (`ubuntu:GNOME`), así que se busca por contenido y no por igualdad.
#[rustfmt::skip]
static DESKTOP_MANAGERS: &[(&[&str], &str)] = &[
    (&["KDE", "PLASMA"], "dolphin"),
    (&["GNOME", "UNITY", "PANTHEON"], "nautilus"),
    (&["XFCE"], "thunar"),
    (&["CINNAMON", "X-CINNAMON"], "nemo"),
    (&["MATE"], "caja"),
    (&["LXQT", "LXDE"], "pcmanfm"),
];

pub fn file_manager_for_desktop(
    desktop: &str,
    is_installed: &dyn Fn(&str) -> bool,
) -> Option<&'static FileManager> {
    let name = desktop.to_uppercase();
    if name.is_empty() {
        return None;
    }
    let (_, id) = DESKTOP_MANAGERS
        .iter()
        .find(|(needles, _)| needles.iter().any(|needle| name.contains(needle)))?;
    let manager = file_manager_by_id("linux", id)?;
    is_installed(manager.cmd).then_some(manager)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_extension_cae_en_su_categoria() {
        assert_eq!(viewer_category_for(".png"), Some("image"));
        assert_eq!(viewer_category_for(".MKV"), Some("video"));
        assert_eq!(viewer_category_for(".pdf"), Some("document"));
        assert_eq!(viewer_category_for(".7z"), Some("archive"));
        assert_eq!(viewer_category_for(".rs"), Some("code"));
        assert_eq!(viewer_category_for(".xyz"), None);
        assert_eq!(viewer_category_for(""), None);
    }

    #[test]
    fn ts_es_typescript_y_no_un_video() {
        assert_eq!(viewer_category_for(".ts"), Some("code"));
    }

    #[test]
    fn cada_plataforma_propone_su_visor() {
        assert_eq!(suggest_viewer(".png", "windows").unwrap().app, "ImageGlass");
        assert_eq!(suggest_viewer(".png", "linux").unwrap().app, "Eye of GNOME");
        // macOS ya abre imágenes con Vista Previa: no hay nada que proponer.
        assert_eq!(suggest_viewer(".png", "macos"), None);
    }

    #[test]
    fn la_sugerencia_apunta_a_una_accion_del_catalogo() {
        let suggestion = suggest_viewer(".pdf", "windows").unwrap();
        assert_eq!(suggestion.action_id, "viewer-document");
        assert_eq!(suggestion.category, "document");
        assert_eq!(suggestion.category_label, "documentos PDF");
    }

    #[test]
    fn una_extension_desconocida_no_propone_nada() {
        assert_eq!(suggest_viewer(".qqq", "windows"), None);
    }

    #[test]
    fn windows_y_macos_traen_su_gestor_y_no_se_ofrece_instalar_ninguno() {
        let todos = |_: &str| true;
        for platform in ["windows", "macos"] {
            let choices = file_manager_choices(platform, &todos);
            assert_eq!(choices.installed.len(), 1);
            assert!(choices.installable.is_empty());
        }
    }

    #[test]
    fn en_linux_se_separan_los_instalados_de_los_instalables() {
        let solo_thunar = |cmd: &str| cmd == "thunar";
        let choices = file_manager_choices("linux", &solo_thunar);
        assert_eq!(choices.installed.len(), 1);
        assert_eq!(choices.installed[0].id, "thunar");
        // Se ofrecen los otros dos que tienen acción de instalación.
        let instalables: Vec<&str> = choices.installable.iter().map(|m| m.id).collect();
        assert_eq!(instalables, vec!["nautilus", "dolphin"]);
    }

    #[test]
    fn los_gestores_sin_accion_no_se_ofrecen_para_instalar() {
        let ninguno = |_: &str| false;
        let choices = file_manager_choices("linux", &ninguno);
        let instalables: Vec<&str> = choices.installable.iter().map(|m| m.id).collect();
        assert!(!instalables.contains(&"nemo"));
        assert!(!instalables.contains(&"caja"));
        assert!(!instalables.contains(&"pcmanfm"));
    }

    #[test]
    fn el_escritorio_decide_que_gestor_es_el_natural() {
        let todos = |_: &str| true;
        assert_eq!(
            file_manager_for_desktop("ubuntu:GNOME", &todos).unwrap().id,
            "nautilus"
        );
        assert_eq!(
            file_manager_for_desktop("KDE", &todos).unwrap().id,
            "dolphin"
        );
        assert_eq!(
            file_manager_for_desktop("XFCE", &todos).unwrap().id,
            "thunar"
        );
    }

    #[test]
    fn si_el_gestor_del_escritorio_no_esta_instalado_no_se_devuelve() {
        let ninguno = |_: &str| false;
        assert!(file_manager_for_desktop("GNOME", &ninguno).is_none());
    }

    #[test]
    fn un_escritorio_desconocido_o_vacio_no_decide_nada() {
        let todos = |_: &str| true;
        assert!(file_manager_for_desktop("", &todos).is_none());
        assert!(file_manager_for_desktop("MiEscritorio", &todos).is_none());
    }

    #[test]
    fn se_encuentra_un_gestor_por_su_identificador() {
        assert_eq!(
            file_manager_by_id("linux", "dolphin").unwrap().cmd,
            "dolphin"
        );
        assert!(file_manager_by_id("linux", "inventado").is_none());
        assert!(file_manager_by_id("windows", "dolphin").is_none());
    }
}
