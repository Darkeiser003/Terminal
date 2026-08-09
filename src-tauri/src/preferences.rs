//! Preferencias editables desde la UI.
//!
//! Port de `electron/main/preferences.js`. Igual que allí, este módulo no
//! depende de Tauri: la validación se puede probar en cualquier plataforma y
//! en CI sin arrancar la ventana.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Palette {
    pub background: &'static str,
    pub surface: &'static str,
    #[serde(rename = "surfaceAlt")]
    pub surface_alt: &'static str,
    pub border: &'static str,
    pub text: &'static str,
    pub muted: &'static str,
    pub accent: &'static str,
    #[serde(rename = "accentSoft")]
    pub accent_soft: &'static str,
    #[serde(rename = "terminalBackground")]
    pub terminal_background: &'static str,
    #[serde(rename = "terminalForeground")]
    pub terminal_foreground: &'static str,
    pub selection: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThemePreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub palette: Palette,
}

macro_rules! theme {
    ($id:literal, $label:literal, $description:literal,
     $background:literal, $surface:literal, $surface_alt:literal, $border:literal,
     $text:literal, $muted:literal, $accent:literal, $accent_soft:literal,
     $terminal_background:literal, $terminal_foreground:literal, $selection:literal) => {
        ThemePreset {
            id: $id,
            label: $label,
            description: $description,
            palette: Palette {
                background: $background,
                surface: $surface,
                surface_alt: $surface_alt,
                border: $border,
                text: $text,
                muted: $muted,
                accent: $accent,
                accent_soft: $accent_soft,
                terminal_background: $terminal_background,
                terminal_foreground: $terminal_foreground,
                selection: $selection,
            },
        }
    };
}

// Todo el catálogo es oscuro a propósito. Un tema claro obliga a revisar cada
// color que la interfaz da por hecho (bordes de xterm, sombras de los paneles,
// el degradado de las tarjetas de tema) y sin eso se ve roto.
// Una línea por tema, con las columnas alineadas: así se comparan de un
// vistazo y se ve enseguida si a uno le falta un color.
#[rustfmt::skip]
pub static THEME_PRESETS: Lazy<Vec<ThemePreset>> = Lazy::new(|| {
    vec![
        theme!("silver", "Negro y plata", "Negro profundo, grises metálicos y contraste neutro.",
            "#080808", "#191919", "#111111", "#3b3d40", "#d7d7d7", "#8b8e92", "#b8bec6", "#34383d", "#080808", "#d7d7d7", "#4b5056"),
        theme!("winslim", "Cian técnico", "Cian técnico y superficies neutras.",
            "#0d0d0d", "#1e1e1e", "#161616", "#333333", "#d4d4d4", "#888888", "#0078d4", "#0d3553", "#0d0d0d", "#d4d4d4", "#264f78"),
        theme!("ocean", "Océano", "Azules profundos con contraste frío.",
            "#081018", "#111d29", "#0c1721", "#284055", "#d7e7f4", "#7890a4", "#2f9bff", "#123a5d", "#071019", "#d7e7f4", "#214d70"),
        theme!("forest", "Bosque", "Verdes sobrios para sesiones largas.",
            "#0b120e", "#17221b", "#111a14", "#304237", "#d7e5da", "#7f9485", "#45b96b", "#173d24", "#09110c", "#d7e5da", "#245334"),
        theme!("amber", "Ámbar", "Cálido, inspirado en terminales clásicas.",
            "#120f0a", "#241e15", "#1a160f", "#4a3b27", "#eee2cd", "#9b8a70", "#d99732", "#4d3514", "#100d08", "#f0dfbe", "#5b421d"),
        theme!("violet", "Violeta", "Contraste moderno con acento púrpura.",
            "#0f0c16", "#211a2d", "#171220", "#403451", "#e5dcf0", "#9383a7", "#9a6ee8", "#352451", "#0e0b14", "#e5dcf0", "#493568"),
        theme!("nordic", "Nórdico", "Azul grisáceo de baja saturación, poco cansado.",
            "#2e3440", "#3b4252", "#343b48", "#4c566a", "#e5e9f0", "#9aa5b8", "#88c0d0", "#3c5766", "#2b303b", "#e5e9f0", "#4c566a"),
        theme!("crimson", "Carmesí", "Rojo intenso sobre grafito, para destacar el foco.",
            "#120b0c", "#241618", "#1a1011", "#4a2b2f", "#f0dcdd", "#a4848a", "#e05561", "#4d1b22", "#100a0b", "#f0dcdd", "#5b2830"),
        theme!("matrix", "Fósforo verde", "Verde sobre negro, como las terminales de fósforo.",
            "#000000", "#0c150c", "#080f08", "#1f3a1f", "#9df79d", "#5f9c5f", "#3ddc45", "#123d16", "#000000", "#8ef78e", "#1f5424"),
        theme!("contrast", "Alto contraste", "Blanco puro sobre negro, pensado para baja visión.",
            "#000000", "#101010", "#080808", "#6f6f6f", "#ffffff", "#c4c4c4", "#ffd400", "#4a3b00", "#000000", "#ffffff", "#6f6f6f"),
        theme!("slate", "Pizarra", "Gris azulado neutro, sin tinte dominante.",
            "#101418", "#1c2228", "#151a1f", "#39424c", "#dbe1e8", "#8b96a3", "#7aa2c4", "#2b3a48", "#0e1216", "#dbe1e8", "#3c4a58"),
        theme!("plum", "Ciruela", "Magenta apagado sobre un fondo muy oscuro.",
            "#120d13", "#231827", "#1a121d", "#463149", "#ecdcee", "#a288a6", "#c774d4", "#472151", "#100b11", "#ecdcee", "#54305c"),
        theme!("teal", "Turquesa", "Verde azulado frío, alto contraste sin ser duro.",
            "#08120f", "#12211d", "#0d1815", "#2a4640", "#d3ebe4", "#7d9c94", "#2fbfa0", "#124038", "#06100d", "#d3ebe4", "#1d564b"),
    ]
});

#[derive(Debug, Clone, Serialize)]
pub struct FontFamily {
    pub id: &'static str,
    pub label: &'static str,
    pub css: &'static str,
}

#[rustfmt::skip]
pub static FONT_FAMILIES: Lazy<Vec<FontFamily>> = Lazy::new(|| {
    vec![
        FontFamily { id: "system-mono", label: "Cascadia / Consolas", css: "'Cascadia Code', Consolas, 'Courier New', monospace" },
        FontFamily { id: "jetbrains", label: "JetBrains Mono", css: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace" },
        FontFamily { id: "fira", label: "Fira Code", css: "'Fira Code', 'Cascadia Code', Consolas, monospace" },
        FontFamily { id: "hack", label: "Hack", css: "'Hack', 'Fira Code', 'Cascadia Code', Consolas, monospace" },
        FontFamily { id: "source-code-pro", label: "Source Code Pro", css: "'Source Code Pro', 'Fira Code', 'Cascadia Code', Consolas, monospace" },
        FontFamily { id: "ibm-plex-mono", label: "IBM Plex Mono", css: "'IBM Plex Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace" },
        FontFamily { id: "monospace", label: "Monoespaciada del sistema", css: "monospace" },
    ]
});

const CURSOR_STYLES: [&str; 5] = ["block", "underline", "bar", "beam", "underline-thick"];
const FONT_WEIGHTS: [&str; 2] = ["normal", "bold"];
const UI_DENSITIES: [&str; 2] = ["compact", "comfortable"];

/// Las preferencias tal y como viajan al renderer y se guardan en disco. Los
/// nombres son los mismos que en la versión Electron, así que un
/// `settings.json` existente se lee sin conversión.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// `auto` = el idioma del sistema. Ver `resolve_language` en i18n.
    pub language: String,
    pub scripts_here_depth: i64,
    pub auto_start_docker: bool,
    pub exclusive_accordion_groups: bool,
    pub auto_open_first_group: bool,
    pub show_system_banner: bool,
    pub theme_id: String,
    pub accent_color: String,
    pub terminal_background: String,
    pub terminal_foreground: String,
    pub terminal_font_family: String,
    pub terminal_font_size: i64,
    pub terminal_line_height: f64,
    pub terminal_letter_spacing: f64,
    pub terminal_cursor_style: String,
    pub terminal_font_weight: String,
    pub terminal_padding: i64,
    pub terminal_scrollback: i64,
    pub terminal_cursor_blink: bool,
    /// Cuántas líneas avanza una muesca de la rueda. xterm usa 1 de fábrica,
    /// que en un historial largo obliga a girar sin parar.
    pub terminal_scroll_sensitivity: i64,
    /// Copiar al seleccionar, como en las terminales de Linux. Desactivado de
    /// fábrica porque en Windows sorprende: la gente selecciona para leer.
    pub copy_on_select: bool,
    pub ui_density: String,
    pub default_environment_id: String,
    /// Gestor de archivos con el que abrir carpetas. Vacío = el que decida el
    /// sistema. Solo se rellena cuando el usuario elige uno a mano porque el
    /// sistema no supo abrirla.
    pub file_manager_id: String,
    /// Últimas dimensiones medidas de la terminal. No se editan desde Ajustes:
    /// las guarda la aplicación para que la primera sesión de la próxima
    /// ejecución nazca ya con el tamaño de la ventana, en vez de escribir su
    /// banner y su prompt a 80x24 y tener que reflujarlo todo al medir.
    pub viewport_cols: i64,
    pub viewport_rows: i64,
}

impl Default for Preferences {
    fn default() -> Self {
        Preferences {
            language: "auto".into(),
            scripts_here_depth: 3,
            auto_start_docker: true,
            exclusive_accordion_groups: true,
            auto_open_first_group: false,
            show_system_banner: true,
            theme_id: "silver".into(),
            accent_color: "#b8bec6".into(),
            terminal_background: "#080808".into(),
            terminal_foreground: "#d7d7d7".into(),
            terminal_font_family: "system-mono".into(),
            terminal_font_size: 14,
            terminal_line_height: 1.1,
            terminal_letter_spacing: 0.0,
            terminal_cursor_style: "block".into(),
            terminal_font_weight: "normal".into(),
            terminal_padding: 10,
            terminal_scrollback: 5000,
            terminal_cursor_blink: true,
            terminal_scroll_sensitivity: 3,
            copy_on_select: false,
            ui_density: "comfortable".into(),
            default_environment_id: String::new(),
            file_manager_id: String::new(),
            viewport_cols: 80,
            viewport_rows: 24,
        }
    }
}

// ---- Validadores ----
// Réplicas exactas de los de preferences.js. Cada uno acepta el `Value` crudo
// que venga del renderer o del disco, sin dar por hecho su tipo.

/// Los identificadores válidos los define el catálogo de visores; aquí basta
/// con que sea un nombre corto y sin sorpresas, porque quien lo usa lo busca en
/// su tabla antes de ejecutar nada.
fn safe_identifier(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let trimmed: String = text.trim().chars().take(40).collect();
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        trimmed
    } else {
        String::new()
    }
}

fn safe_environment_id(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let trimmed: String = text.trim().chars().take(200).collect();
    if trimmed.chars().any(|c| c.is_control() || c == '\u{7f}') {
        String::new()
    } else {
        trimmed
    }
}

/// Acepta tanto números como cadenas numéricas, igual que `Number(value)`.
fn as_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.is_finite()),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn integer_in_range(value: Option<&Value>, minimum: i64, maximum: i64, fallback: i64) -> i64 {
    let Some(parsed) = as_number(value) else {
        return fallback;
    };
    // JS redondea con Math.round: los .5 suben, también en negativo.
    let rounded = (parsed + 0.5).floor() as i64;
    rounded.clamp(minimum, maximum)
}

fn number_in_range(
    value: Option<&Value>,
    minimum: f64,
    maximum: f64,
    fallback: f64,
    decimals: u32,
) -> f64 {
    let Some(parsed) = as_number(value) else {
        return fallback;
    };
    let limited = parsed.clamp(minimum, maximum);
    let factor = 10f64.powi(decimals as i32);
    (limited * factor + 0.5).floor() / factor
}

fn one_of(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if allowed.contains(&text) => text.to_string(),
        _ => fallback.to_string(),
    }
}

fn safe_hex_color(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text)
            if text.len() == 7
                && text.starts_with('#')
                && text[1..].chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            text.to_lowercase()
        }
        _ => fallback.to_string(),
    }
}

/// Un booleano que solo es falso si viene explícitamente a `false`
/// (`source.x !== false` en el original).
fn default_true(value: Option<&Value>) -> bool {
    value != Some(&Value::Bool(false))
}

/// Un booleano que solo es cierto si viene explícitamente a `true`
/// (`source.x === true` en el original).
fn default_false(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

pub fn theme_by_id(id: &str) -> &'static ThemePreset {
    THEME_PRESETS
        .iter()
        .find(|theme| theme.id == id)
        .unwrap_or(&THEME_PRESETS[0])
}

/// Convierte cualquier entrada — el JSON del disco, lo que mande el renderer,
/// nada en absoluto — en unas preferencias completas y dentro de rango.
pub fn sanitize_preferences(raw: &Value) -> Preferences {
    let empty = Map::new();
    let source = raw.as_object().unwrap_or(&empty);
    let get = |key: &str| source.get(key);
    let defaults = Preferences::default();

    let theme_ids: Vec<&str> = THEME_PRESETS.iter().map(|theme| theme.id).collect();
    let theme_id = one_of(get("themeId"), &theme_ids, &defaults.theme_id);
    let theme = theme_by_id(&theme_id);
    let font_ids: Vec<&str> = FONT_FAMILIES.iter().map(|font| font.id).collect();
    let language_ids: Vec<&str> = crate::i18n::LANGUAGES.iter().map(|lang| lang.id).collect();

    Preferences {
        language: one_of(get("language"), &language_ids, &defaults.language),
        scripts_here_depth: integer_in_range(
            get("scriptsHereDepth"),
            0,
            10,
            defaults.scripts_here_depth,
        ),
        auto_start_docker: default_true(get("autoStartDocker")),
        exclusive_accordion_groups: default_true(get("exclusiveAccordionGroups")),
        auto_open_first_group: default_false(get("autoOpenFirstGroup")),
        show_system_banner: default_true(get("showSystemBanner")),
        accent_color: safe_hex_color(get("accentColor"), theme.palette.accent),
        terminal_background: safe_hex_color(
            get("terminalBackground"),
            theme.palette.terminal_background,
        ),
        terminal_foreground: safe_hex_color(
            get("terminalForeground"),
            theme.palette.terminal_foreground,
        ),
        theme_id,
        terminal_font_family: one_of(
            get("terminalFontFamily"),
            &font_ids,
            &defaults.terminal_font_family,
        ),
        terminal_font_size: integer_in_range(
            get("terminalFontSize"),
            10,
            24,
            defaults.terminal_font_size,
        ),
        terminal_line_height: number_in_range(
            get("terminalLineHeight"),
            0.9,
            1.8,
            defaults.terminal_line_height,
            2,
        ),
        terminal_letter_spacing: number_in_range(
            get("terminalLetterSpacing"),
            -1.0,
            3.0,
            defaults.terminal_letter_spacing,
            1,
        ),
        terminal_cursor_style: one_of(
            get("terminalCursorStyle"),
            &CURSOR_STYLES,
            &defaults.terminal_cursor_style,
        ),
        terminal_font_weight: one_of(
            get("terminalFontWeight"),
            &FONT_WEIGHTS,
            &defaults.terminal_font_weight,
        ),
        terminal_padding: integer_in_range(
            get("terminalPadding"),
            4,
            24,
            defaults.terminal_padding,
        ),
        terminal_scrollback: integer_in_range(
            get("terminalScrollback"),
            1000,
            100_000,
            defaults.terminal_scrollback,
        ),
        terminal_cursor_blink: default_true(get("terminalCursorBlink")),
        terminal_scroll_sensitivity: integer_in_range(
            get("terminalScrollSensitivity"),
            1,
            10,
            defaults.terminal_scroll_sensitivity,
        ),
        copy_on_select: default_false(get("copyOnSelect")),
        ui_density: one_of(get("uiDensity"), &UI_DENSITIES, &defaults.ui_density),
        default_environment_id: safe_environment_id(get("defaultEnvironmentId")),
        file_manager_id: safe_identifier(get("fileManagerId")),
        viewport_cols: integer_in_range(get("viewportCols"), 20, 1000, defaults.viewport_cols),
        viewport_rows: integer_in_range(get("viewportRows"), 5, 500, defaults.viewport_rows),
    }
}

/// Las preferencias guardadas en disco, ya validadas.
pub fn current() -> Preferences {
    sanitize_preferences(&Value::Object(crate::settings::load_settings()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn una_entrada_vacia_da_los_valores_de_fabrica() {
        assert_eq!(sanitize_preferences(&json!({})), Preferences::default());
        assert_eq!(sanitize_preferences(&Value::Null), Preferences::default());
    }

    #[test]
    fn los_numeros_se_recortan_al_rango() {
        let prefs = sanitize_preferences(&json!({
            "terminalFontSize": 99,
            "terminalScrollback": 10,
            "scriptsHereDepth": -4,
            "viewportCols": 5000
        }));
        assert_eq!(prefs.terminal_font_size, 24);
        assert_eq!(prefs.terminal_scrollback, 1000);
        assert_eq!(prefs.scripts_here_depth, 0);
        assert_eq!(prefs.viewport_cols, 1000);
    }

    #[test]
    fn los_decimales_se_redondean_como_en_javascript() {
        let prefs = sanitize_preferences(&json!({
            "terminalLineHeight": 1.2345,
            "terminalLetterSpacing": 0.46
        }));
        assert_eq!(prefs.terminal_line_height, 1.23);
        assert_eq!(prefs.terminal_letter_spacing, 0.5);
    }

    #[test]
    fn un_id_desconocido_cae_al_valor_por_defecto() {
        let prefs = sanitize_preferences(&json!({
            "themeId": "no-existe",
            "terminalFontFamily": "comic-sans",
            "uiDensity": "gigante",
            "language": "fr"
        }));
        assert_eq!(prefs.theme_id, "silver");
        assert_eq!(prefs.terminal_font_family, "system-mono");
        assert_eq!(prefs.ui_density, "comfortable");
        assert_eq!(prefs.language, "auto");
    }

    #[test]
    fn los_colores_del_tema_rellenan_los_que_faltan() {
        let prefs = sanitize_preferences(&json!({ "themeId": "matrix" }));
        assert_eq!(prefs.accent_color, "#3ddc45");
        assert_eq!(prefs.terminal_background, "#000000");
        assert_eq!(prefs.terminal_foreground, "#8ef78e");
    }

    #[test]
    fn solo_se_acepta_hexadecimal_de_seis_digitos() {
        let prefs = sanitize_preferences(&json!({
            "accentColor": "#ABCDEF",
            "terminalBackground": "rojo",
            "terminalForeground": "#fff"
        }));
        assert_eq!(prefs.accent_color, "#abcdef");
        assert_eq!(prefs.terminal_background, "#080808");
        assert_eq!(prefs.terminal_foreground, "#d7d7d7");
    }

    #[test]
    fn los_booleanos_respetan_su_lado_por_defecto() {
        let prefs = sanitize_preferences(&json!({
            "autoStartDocker": "no",
            "copyOnSelect": "si",
            "showSystemBanner": false,
            "autoOpenFirstGroup": true
        }));
        // Cualquier cosa que no sea `false` deja activo lo que viene activo...
        assert!(prefs.auto_start_docker);
        assert!(!prefs.show_system_banner);
        // ...y cualquier cosa que no sea `true` deja apagado lo que viene apagado.
        assert!(!prefs.copy_on_select);
        assert!(prefs.auto_open_first_group);
    }

    #[test]
    fn el_id_de_entorno_rechaza_caracteres_de_control() {
        let prefs = sanitize_preferences(&json!({ "defaultEnvironmentId": "wsl\u{7}Ubuntu" }));
        assert_eq!(prefs.default_environment_id, "");

        let prefs = sanitize_preferences(&json!({ "defaultEnvironmentId": "  wsl:Ubuntu  " }));
        assert_eq!(prefs.default_environment_id, "wsl:Ubuntu");
    }

    #[test]
    fn el_id_de_gestor_solo_admite_letras_numeros_y_guiones() {
        assert_eq!(
            sanitize_preferences(&json!({ "fileManagerId": "nautilus" })).file_manager_id,
            "nautilus"
        );
        assert_eq!(
            sanitize_preferences(&json!({ "fileManagerId": "../../bin/sh" })).file_manager_id,
            ""
        );
    }

    #[test]
    fn el_json_conserva_los_nombres_de_la_version_electron() {
        let text = serde_json::to_string(&Preferences::default()).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["terminalFontSize"], json!(14));
        assert_eq!(parsed["scriptsHereDepth"], json!(3));
        assert_eq!(parsed["viewportRows"], json!(24));
    }

    #[test]
    fn los_ids_de_tema_y_fuente_son_unicos() {
        let mut ids: Vec<&str> = THEME_PRESETS.iter().map(|theme| theme.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
        assert_eq!(total, 13);
    }
}
