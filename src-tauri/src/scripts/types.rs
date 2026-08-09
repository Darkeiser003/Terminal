//! Qué clases de archivo reconoce el lanzador y cómo se agrupan en el panel.
//!
//! Port de las tablas de la cabecera de `electron/main/scriptLauncher.js`.

use serde::{Deserialize, Serialize};

/// Cómo se ejecuta (o se abre) un archivo. No es lo mismo que su extensión:
/// un archivo sin extensión con shebang `#!/bin/bash` es `Shell`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptType {
    Powershell,
    Batch,
    Shell,
    Fish,
    Python,
    Node,
    Vbscript,
    Ruby,
    Php,
    Perl,
    Lua,
    Rscript,
    Groovy,
    Java,
    Program,
    Html,
    Image,
    Audio,
    Video,
}

/// El grupo con el que el panel filtra. Varios tipos comparten categoría:
/// Ruby, PHP, Perl, Lua y R caben todos en "otros scripts".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileCategory {
    Batch,
    Powershell,
    Shell,
    Fish,
    Python,
    Node,
    Vbscript,
    OtherScript,
    Program,
    Html,
    Image,
    Audio,
    Video,
}

impl FileCategory {
    pub fn id(self) -> &'static str {
        match self {
            FileCategory::Batch => "batch",
            FileCategory::Powershell => "powershell",
            FileCategory::Shell => "shell",
            FileCategory::Fish => "fish",
            FileCategory::Python => "python",
            FileCategory::Node => "node",
            FileCategory::Vbscript => "vbscript",
            FileCategory::OtherScript => "other-script",
            FileCategory::Program => "program",
            FileCategory::Html => "html",
            FileCategory::Image => "image",
            FileCategory::Audio => "audio",
            FileCategory::Video => "video",
        }
    }

    pub fn from_id(id: &str) -> Option<FileCategory> {
        FILE_FILTERS
            .iter()
            .find(|filter| filter.id.id() == id)
            .map(|filter| filter.id)
    }
}

pub struct FileFilter {
    pub id: FileCategory,
    pub label: &'static str,
    /// Marcado de fábrica en el panel. Los recursos (imágenes, vídeo...) no lo
    /// están: la carpeta de scripts se usa para scripts.
    pub default: bool,
}

#[rustfmt::skip]
pub static FILE_FILTERS: &[FileFilter] = &[
    FileFilter { id: FileCategory::Batch,       label: "CMD / BAT",                   default: true },
    FileFilter { id: FileCategory::Powershell,  label: "PowerShell",                  default: true },
    FileFilter { id: FileCategory::Shell,       label: "SH / Bash / Zsh",             default: true },
    FileFilter { id: FileCategory::Fish,        label: "Fish",                        default: true },
    FileFilter { id: FileCategory::Python,      label: "Python",                      default: true },
    FileFilter { id: FileCategory::Node,        label: "Node.js",                     default: true },
    FileFilter { id: FileCategory::Vbscript,    label: "VBScript",                    default: true },
    FileFilter { id: FileCategory::OtherScript, label: "Ruby / PHP / Perl / Lua / R", default: true },
    FileFilter { id: FileCategory::Program,     label: "Programas",                   default: false },
    FileFilter { id: FileCategory::Html,        label: "HTML",                        default: false },
    FileFilter { id: FileCategory::Image,       label: "Imágenes",                    default: false },
    FileFilter { id: FileCategory::Audio,       label: "Audio",                       default: false },
    FileFilter { id: FileCategory::Video,       label: "Vídeo",                       default: false },
];

/// Todas las categorías conocidas. Lo usan los scripts anclados: un anclado no
/// debe desaparecer porque el filtro activo del panel no incluya su tipo.
pub fn all_categories() -> Vec<FileCategory> {
    FILE_FILTERS.iter().map(|filter| filter.id).collect()
}

pub fn default_categories() -> Vec<FileCategory> {
    FILE_FILTERS
        .iter()
        .filter(|filter| filter.default)
        .map(|filter| filter.id)
        .collect()
}

/// Convierte lo que mande el frontend en una lista de categorías válidas. Una
/// entrada que no sea una lista cae a las de fábrica; dentro de una lista, los
/// identificadores desconocidos se descartan sin más.
pub fn normalize_categories(raw: Option<&[String]>) -> Vec<FileCategory> {
    match raw {
        None => default_categories(),
        Some(values) => values
            .iter()
            .filter_map(|value| FileCategory::from_id(value))
            .collect(),
    }
}

/// Extensión -> tipo declarado. Es el primer criterio; el shebang solo manda
/// cuando la extensión no dice nada.
#[rustfmt::skip]
pub static SCRIPT_TYPES: &[(&str, ScriptType)] = &[
    (".ps1", ScriptType::Powershell),
    (".bat", ScriptType::Batch),
    (".cmd", ScriptType::Batch),
    (".sh", ScriptType::Shell),
    (".bash", ScriptType::Shell),
    (".zsh", ScriptType::Shell),
    (".ksh", ScriptType::Shell),
    (".fish", ScriptType::Fish),
    (".py", ScriptType::Python),
    (".js", ScriptType::Node),
    (".mjs", ScriptType::Node),
    (".vbs", ScriptType::Vbscript),
    (".rb", ScriptType::Ruby),
    (".php", ScriptType::Php),
    (".pl", ScriptType::Perl),
    (".lua", ScriptType::Lua),
    (".r", ScriptType::Rscript),
    (".groovy", ScriptType::Groovy),
];

/// Extensión -> intérprete por defecto, cuando el archivo no trae shebang.
#[rustfmt::skip]
pub static EXT_INTERPRETERS: &[(&str, &str)] = &[
    (".sh", "sh"), (".bash", "bash"), (".zsh", "zsh"), (".ksh", "ksh"),
    (".fish", "fish"), (".py", "python"), (".js", "node"), (".mjs", "node"),
    (".ps1", "powershell"), (".rb", "ruby"), (".php", "php"), (".pl", "perl"),
    (".lua", "lua"), (".r", "Rscript"), (".groovy", "groovy"),
];

pub fn script_type_for_ext(ext: &str) -> Option<ScriptType> {
    SCRIPT_TYPES
        .iter()
        .find(|(candidate, _)| *candidate == ext)
        .map(|(_, kind)| *kind)
}

pub fn interpreter_for_ext(ext: &str) -> Option<&'static str> {
    EXT_INTERPRETERS
        .iter()
        .find(|(candidate, _)| *candidate == ext)
        .map(|(_, bin)| *bin)
}

impl ScriptType {
    pub fn category(self) -> FileCategory {
        match self {
            ScriptType::Powershell => FileCategory::Powershell,
            ScriptType::Batch => FileCategory::Batch,
            ScriptType::Shell => FileCategory::Shell,
            ScriptType::Fish => FileCategory::Fish,
            ScriptType::Python => FileCategory::Python,
            ScriptType::Node => FileCategory::Node,
            ScriptType::Vbscript => FileCategory::Vbscript,
            ScriptType::Ruby
            | ScriptType::Php
            | ScriptType::Perl
            | ScriptType::Lua
            | ScriptType::Rscript
            | ScriptType::Groovy => FileCategory::OtherScript,
            ScriptType::Program | ScriptType::Java => FileCategory::Program,
            ScriptType::Html => FileCategory::Html,
            ScriptType::Image => FileCategory::Image,
            ScriptType::Audio => FileCategory::Audio,
            ScriptType::Video => FileCategory::Video,
        }
    }

    /// Qué se le dice al usuario sobre cómo se va a lanzar.
    pub fn instruction(self) -> &'static str {
        match self {
            ScriptType::Powershell => "PowerShell con -NoProfile y ExecutionPolicy Bypass.",
            ScriptType::Batch => "CMD/BAT mediante la shell de Windows.",
            ScriptType::Shell => "Intérprete tomado de la extensión o del shebang.",
            ScriptType::Fish => "Se ejecuta con Fish.",
            ScriptType::Python => "Python en Windows; python3 en WSL/Linux.",
            ScriptType::Node => "Se ejecuta con Node.js.",
            ScriptType::Vbscript => "VBScript mediante wscript.exe.",
            ScriptType::Ruby => "Requiere Ruby.",
            ScriptType::Php => "Requiere PHP CLI.",
            ScriptType::Perl => "Requiere Perl.",
            ScriptType::Lua => "Requiere Lua.",
            ScriptType::Rscript => "Requiere Rscript.",
            ScriptType::Groovy => "Requiere Groovy.",
            ScriptType::Java => "Requiere Java; se ejecuta con java -jar.",
            ScriptType::Program => "Se ejecuta en la terminal activa.",
            ScriptType::Html => "Se abre con el navegador predeterminado.",
            ScriptType::Image => "Se abre con el visor de imágenes predeterminado.",
            ScriptType::Audio => "Se abre con el reproductor de audio predeterminado.",
            ScriptType::Video => "Se abre con el reproductor de vídeo predeterminado.",
        }
    }

    /// Se lanza escribiendo un comando en la terminal.
    pub fn runnable(self) -> bool {
        !matches!(
            self,
            ScriptType::Html | ScriptType::Image | ScriptType::Audio | ScriptType::Video
        )
    }

    /// Se abre con la aplicación que el sistema tenga asociada.
    pub fn openable(self) -> bool {
        !self.runnable()
    }
}

/// Archivos que no son scripts pero que el panel puede ofrecer: programas y
/// contenido que el sistema sabe abrir.
#[rustfmt::skip]
pub static RESOURCE_TYPES: &[(&str, ScriptType)] = &[
    (".exe", ScriptType::Program), (".com", ScriptType::Program), (".appimage", ScriptType::Program),
    (".jar", ScriptType::Java),
    (".html", ScriptType::Html), (".htm", ScriptType::Html),
    (".png", ScriptType::Image), (".jpg", ScriptType::Image), (".jpeg", ScriptType::Image),
    (".gif", ScriptType::Image), (".webp", ScriptType::Image), (".bmp", ScriptType::Image),
    (".svg", ScriptType::Image), (".ico", ScriptType::Image),
    (".mp3", ScriptType::Audio), (".wav", ScriptType::Audio), (".flac", ScriptType::Audio),
    (".ogg", ScriptType::Audio), (".m4a", ScriptType::Audio), (".aac", ScriptType::Audio),
    (".opus", ScriptType::Audio),
    (".mp4", ScriptType::Video), (".mkv", ScriptType::Video), (".webm", ScriptType::Video),
    (".avi", ScriptType::Video), (".mov", ScriptType::Video), (".m4v", ScriptType::Video),
    (".wmv", ScriptType::Video),
];

pub fn resource_type_for_ext(ext: &str) -> Option<ScriptType> {
    RESOURCE_TYPES
        .iter()
        .find(|(candidate, _)| *candidate == ext)
        .map(|(_, kind)| *kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_extension_conocida_tiene_su_tipo() {
        assert_eq!(script_type_for_ext(".ps1"), Some(ScriptType::Powershell));
        assert_eq!(script_type_for_ext(".cmd"), Some(ScriptType::Batch));
        assert_eq!(script_type_for_ext(".mjs"), Some(ScriptType::Node));
        assert_eq!(script_type_for_ext(".txt"), None);
    }

    #[test]
    fn los_lenguajes_menos_comunes_comparten_categoria() {
        for kind in [
            ScriptType::Ruby,
            ScriptType::Php,
            ScriptType::Perl,
            ScriptType::Lua,
            ScriptType::Rscript,
            ScriptType::Groovy,
        ] {
            assert_eq!(kind.category(), FileCategory::OtherScript);
        }
    }

    #[test]
    fn lo_que_se_abre_no_se_ejecuta_y_al_reves() {
        assert!(ScriptType::Powershell.runnable());
        assert!(!ScriptType::Powershell.openable());
        assert!(ScriptType::Image.openable());
        assert!(!ScriptType::Image.runnable());
    }

    #[test]
    fn los_recursos_se_reconocen_por_extension() {
        assert_eq!(resource_type_for_ext(".exe"), Some(ScriptType::Program));
        assert_eq!(resource_type_for_ext(".jar"), Some(ScriptType::Java));
        assert_eq!(resource_type_for_ext(".mkv"), Some(ScriptType::Video));
        assert_eq!(resource_type_for_ext(".rs"), None);
    }

    #[test]
    fn de_fabrica_se_ofrecen_los_scripts_y_no_los_recursos() {
        let defaults = default_categories();
        assert!(defaults.contains(&FileCategory::Powershell));
        assert!(defaults.contains(&FileCategory::OtherScript));
        assert!(!defaults.contains(&FileCategory::Image));
        assert!(!defaults.contains(&FileCategory::Program));
    }

    #[test]
    fn una_categoria_desconocida_se_descarta_sin_tirar_las_demas() {
        let raw = vec!["shell".to_string(), "inventada".to_string()];
        assert_eq!(normalize_categories(Some(&raw)), vec![FileCategory::Shell]);
    }

    #[test]
    fn sin_lista_se_usan_las_de_fabrica() {
        assert_eq!(normalize_categories(None), default_categories());
        // Una lista vacía es una elección explícita: no se ofrece nada.
        assert!(normalize_categories(Some(&[])).is_empty());
    }

    #[test]
    fn los_identificadores_viajan_como_en_la_version_electron() {
        assert_eq!(FileCategory::OtherScript.id(), "other-script");
        assert_eq!(
            serde_json::to_value(FileCategory::OtherScript).unwrap(),
            serde_json::json!("other-script")
        );
        assert_eq!(
            serde_json::to_value(ScriptType::Powershell).unwrap(),
            serde_json::json!("powershell")
        );
    }
}
