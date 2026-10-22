//! Preferencias editables desde la UI.
//!
//! Port de `electron/main/preferences.js`. Igual que allí, este módulo no
//! depende de Tauri: la validación se puede probar en cualquier plataforma y
//! en CI sin arrancar la ventana.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const DEFAULT_SETTINGS: &str = include_str!("../../default_settings.toml");

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
/// Familias de color del catálogo, en el orden en que se muestran. Cada tema
/// pertenece a una y cada familia tiene al menos dos variantes (un tono más
/// técnico y otro más suave); el total es múltiplo de cinco para que la
/// cuadrícula de Ajustes quede completa.
pub const THEME_FAMILIES: &[(&str, &[&str])] = &[
    ("neutral", &["silver", "slate"]),
    ("blue", &["winslim", "ocean", "nordic"]),
    ("teal", &["teal", "mint"]),
    ("green", &["forest", "matrix"]),
    ("yellow", &["amber", "contrast"]),
    ("red", &["crimson", "ruby"]),
    ("violet", &["violet", "plum"]),
];

pub static THEME_PRESETS: Lazy<Vec<ThemePreset>> = Lazy::new(|| {
    vec![
        theme!(
            "silver",
            "Negro y plata",
            "Negro profundo, grises metálicos y contraste neutro.",
            "#080808",
            "#191919",
            "#111111",
            "#3b3d40",
            "#d7d7d7",
            "#8b8e92",
            "#b8bec6",
            "#34383d",
            "#080808",
            "#d7d7d7",
            "#4b5056"
        ),
        theme!(
            "slate",
            "Pizarra",
            "Gris azulado neutro, sin tinte dominante.",
            "#101418",
            "#1c2228",
            "#151a1f",
            "#39424c",
            "#dbe1e8",
            "#8b96a3",
            "#7aa2c4",
            "#2b3a48",
            "#0e1216",
            "#dbe1e8",
            "#3c4a58"
        ),
        theme!(
            "winslim",
            "Cian técnico",
            "Cian técnico y superficies neutras.",
            "#0d0d0d",
            "#1e1e1e",
            "#161616",
            "#333333",
            "#d4d4d4",
            "#888888",
            "#0078d4",
            "#0d3553",
            "#0d0d0d",
            "#d4d4d4",
            "#264f78"
        ),
        theme!(
            "ocean",
            "Océano",
            "Azules profundos con contraste frío.",
            "#081018",
            "#111d29",
            "#0c1721",
            "#284055",
            "#d7e7f4",
            "#7890a4",
            "#2f9bff",
            "#123a5d",
            "#071019",
            "#d7e7f4",
            "#214d70"
        ),
        theme!(
            "nordic",
            "Nórdico",
            "Azul grisáceo de baja saturación, poco cansado.",
            "#2e3440",
            "#3b4252",
            "#343b48",
            "#4c566a",
            "#e5e9f0",
            "#9aa5b8",
            "#88c0d0",
            "#3c5766",
            "#2b303b",
            "#e5e9f0",
            "#4c566a"
        ),
        theme!(
            "teal",
            "Turquesa",
            "Verde azulado frío, alto contraste sin ser duro.",
            "#08120f",
            "#12211d",
            "#0d1815",
            "#2a4640",
            "#d3ebe4",
            "#7d9c94",
            "#2fbfa0",
            "#124038",
            "#06100d",
            "#d3ebe4",
            "#1d564b"
        ),
        theme!(
            "mint",
            "Menta",
            "Verde agua luminoso, fresco y de baja fatiga.",
            "#0a1310",
            "#15231e",
            "#0f1a16",
            "#2c4a40",
            "#d8f0e8",
            "#82a397",
            "#5be3b0",
            "#174a3a",
            "#08110e",
            "#d8f0e8",
            "#1f5a47"
        ),
        theme!(
            "forest",
            "Bosque",
            "Verdes sobrios para sesiones largas.",
            "#0b120e",
            "#17221b",
            "#111a14",
            "#304237",
            "#d7e5da",
            "#7f9485",
            "#45b96b",
            "#173d24",
            "#09110c",
            "#d7e5da",
            "#245334"
        ),
        theme!(
            "matrix",
            "Fósforo verde",
            "Verde sobre negro, como las terminales de fósforo.",
            "#000000",
            "#0c150c",
            "#080f08",
            "#1f3a1f",
            "#9df79d",
            "#5f9c5f",
            "#3ddc45",
            "#123d16",
            "#000000",
            "#8ef78e",
            "#1f5424"
        ),
        theme!(
            "amber",
            "Ámbar",
            "Cálido, inspirado en terminales clásicas.",
            "#120f0a",
            "#241e15",
            "#1a160f",
            "#4a3b27",
            "#eee2cd",
            "#9b8a70",
            "#d99732",
            "#4d3514",
            "#100d08",
            "#f0dfbe",
            "#5b421d"
        ),
        theme!(
            "contrast",
            "Alto contraste",
            "Blanco puro sobre negro, pensado para baja visión.",
            "#000000",
            "#101010",
            "#080808",
            "#6f6f6f",
            "#ffffff",
            "#c4c4c4",
            "#ffd400",
            "#4a3b00",
            "#000000",
            "#ffffff",
            "#6f6f6f"
        ),
        theme!(
            "crimson",
            "Carmesí",
            "Rojo intenso sobre grafito, para destacar el foco.",
            "#120b0c",
            "#241618",
            "#1a1011",
            "#4a2b2f",
            "#f0dcdd",
            "#a4848a",
            "#e05561",
            "#4d1b22",
            "#100a0b",
            "#f0dcdd",
            "#5b2830"
        ),
        theme!(
            "ruby",
            "Rubí",
            "Rojo rosado sobre negro cálido, más suave que el carmesí.",
            "#130a0e",
            "#26151b",
            "#1b0f14",
            "#4d2833",
            "#f2dbe2",
            "#a8848f",
            "#f0507a",
            "#4f1a2b",
            "#11090c",
            "#f2dbe2",
            "#5e2638"
        ),
        theme!(
            "violet",
            "Violeta",
            "Contraste moderno con acento púrpura.",
            "#0f0c16",
            "#211a2d",
            "#171220",
            "#403451",
            "#e5dcf0",
            "#9383a7",
            "#9a6ee8",
            "#352451",
            "#0e0b14",
            "#e5dcf0",
            "#493568"
        ),
        theme!(
            "plum",
            "Ciruela",
            "Magenta apagado sobre un fondo muy oscuro.",
            "#120d13",
            "#231827",
            "#1a121d",
            "#463149",
            "#ecdcee",
            "#a288a6",
            "#c774d4",
            "#472151",
            "#100b11",
            "#ecdcee",
            "#54305c"
        ),
    ]
});

/// El tema cuya base neutra (fondo negro, superficies grises) comparten todos
/// los demás mientras no se pida recolorear toda la interfaz.
pub const NEUTRAL_THEME_ID: &str = "winslim";

/// Temas que conservan su paleta completa también en modo neutro: el de alto
/// contraste existe por su texto blanco puro, no por su acento.
const FULL_PALETTE_THEMES: [&str; 1] = ["contrast"];

/// La paleta que aplica un tema de fábrica. De fábrica solo cambian el acento,
/// su versión suave y la selección sobre la base de «Cian técnico»; con
/// `recolor_all` (opción voluntaria) el tema lo recolorea todo.
pub fn effective_palette(theme: &ThemePreset, recolor_all: bool) -> Palette {
    if recolor_all || theme.id == NEUTRAL_THEME_ID || FULL_PALETTE_THEMES.contains(&theme.id) {
        return theme.palette.clone();
    }
    let base = &theme_by_id(NEUTRAL_THEME_ID).palette;
    Palette {
        accent: theme.palette.accent,
        accent_soft: theme.palette.accent_soft,
        selection: theme.palette.selection,
        ..base.clone()
    }
}

/// Un tema guardado por el usuario: los mismos colores que un tema de fábrica
/// y, si se definió, su paleta ANSI de 16 colores. Viaja con las preferencias,
/// así que también sale en «Exportar perfil».
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub label: String,
    pub palette: CustomPalette,
    #[serde(default)]
    pub ansi: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPalette {
    pub background: String,
    pub surface: String,
    pub surface_alt: String,
    pub border: String,
    pub text: String,
    pub muted: String,
    pub accent: String,
    pub accent_soft: String,
    pub terminal_background: String,
    pub terminal_foreground: String,
    pub selection: String,
}

const MAX_CUSTOM_THEMES: usize = 24;

#[derive(Debug, Clone, Serialize)]
pub struct FontFamily {
    pub id: &'static str,
    pub label: &'static str,
    pub css: String,
}

/// Respaldo común de todas las fuentes, antes del `monospace` genérico: los
/// iconos Nerd Font que pintan fastfetch, starship u oh-my-posh (la fuente de
/// símbolos que incluye la app y la oficial si está instalada) y los emoji y
/// símbolos del sistema. Sin él, esos glifos salen como cuadros vacíos.
pub const SYMBOL_FALLBACKS: &str = "'WTerminal Symbols', 'Symbols Nerd Font Mono', \
    'Segoe UI Symbol', 'Segoe UI Emoji', 'Noto Color Emoji', 'Apple Color Emoji'";

fn font_stack(primary: &str) -> String {
    if primary.is_empty() {
        format!("{SYMBOL_FALLBACKS}, monospace")
    } else {
        format!("{primary}, {SYMBOL_FALLBACKS}, monospace")
    }
}

/// Cada familia prueba primero su variante Nerd Font (mismas métricas, con
/// iconos) por si está instalada.
#[rustfmt::skip]
pub static FONT_FAMILIES: Lazy<Vec<FontFamily>> = Lazy::new(|| {
    [
        ("system-mono", "Cascadia / Consolas", "'Cascadia Code NF', 'Cascadia Mono NF', 'Cascadia Code', Consolas, 'Courier New'"),
        ("jetbrains", "JetBrains Mono", "'JetBrainsMono Nerd Font Mono', 'JetBrainsMono NFM', 'JetBrains Mono', 'Cascadia Code', Consolas"),
        ("fira", "Fira Code", "'FiraCode Nerd Font Mono', 'FiraCode NFM', 'Fira Code', 'Cascadia Code', Consolas"),
        ("hack", "Hack", "'Hack Nerd Font Mono', 'Hack NFM', 'Hack', 'Fira Code', 'Cascadia Code', Consolas"),
        ("source-code-pro", "Source Code Pro", "'SauceCodePro Nerd Font Mono', 'Source Code Pro', 'Fira Code', 'Cascadia Code', Consolas"),
        ("ibm-plex-mono", "IBM Plex Mono", "'BlexMono Nerd Font Mono', 'IBM Plex Mono', 'Fira Code', 'Cascadia Code', Consolas"),
        ("iosevka", "Iosevka", "'Iosevka Nerd Font Mono', 'Iosevka', 'JetBrains Mono', 'Cascadia Code', Consolas"),
        ("victor-mono", "Victor Mono", "'VictorMono Nerd Font Mono', 'Victor Mono', 'JetBrains Mono', 'Cascadia Code', Consolas"),
        ("ubuntu-mono", "Ubuntu Mono", "'UbuntuMono Nerd Font Mono', 'Ubuntu Mono', 'Cascadia Code', Consolas"),
        ("inconsolata", "Inconsolata", "'Inconsolata Nerd Font Mono', 'Inconsolata', 'Cascadia Code', Consolas"),
        ("monaspace", "Monaspace Neon", "'MonaspiceNe Nerd Font Mono', 'Monaspace Neon', 'JetBrains Mono', 'Cascadia Code', Consolas"),
        ("meslo", "Meslo (Nerd Font)", "'MesloLGS NF', 'MesloLGS Nerd Font Mono', 'Meslo LG S', 'Cascadia Code', Consolas"),
        ("monospace", "Monoespaciada del sistema", ""),
    ]
    .into_iter()
    .map(|(id, label, primary)| FontFamily { id, label, css: font_stack(primary) })
    .collect()
});

const CURSOR_STYLES: [&str; 5] = ["block", "underline", "bar", "beam", "underline-thick"];
const FONT_WEIGHTS: [&str; 5] = ["light", "normal", "medium", "semibold", "bold"];
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
    /// Si `clear`/`cls` debe volver a imprimir el fastfetch de la pestaña.
    pub clear_reprint_banner: bool,
    /// Identificadores del banner que no se muestran, separados por comas.
    /// Vacío representa el perfil completo cuando se solicita explícitamente;
    /// los valores de fábrica usan el preset esencial definido en TOML.
    pub banner_hidden_items: String,
    /// Imagen a la izquierda del banner (el logo de la app si no se elige
    /// otra). El backend deja el margen y el frontend la pinta encima.
    pub banner_image: bool,
    /// Columnas que ocupa la imagen, sin contar las dos de separación.
    pub banner_image_columns: i64,
    /// Imagen propia (ruta absoluta); vacío = el logo de la app.
    pub banner_image_path: String,
    pub show_dependencies_panel: bool,
    pub show_projects_panel: bool,
    pub show_scripts_panel: bool,
    pub show_quick_actions: bool,
    /// Integración experimental de LTools. No se descubre ni se ofrece para
    /// instalar mientras permanece desactivada.
    pub ltools_enabled: bool,
    pub show_explorer_panel: bool,
    pub show_tab_bar: bool,
    pub show_environment_selector: bool,
    pub show_refresh_button: bool,
    pub show_language_button: bool,
    pub terminal_only_mode: bool,
    pub show_terminal_only_guide: bool,
    pub start_maximized: bool,
    /// Windows: al arrancar sin permisos de administrador, relanzarse con UAC.
    /// No toca la compatibilidad del ejecutable; si se cancela el aviso, la
    /// app sigue abierta sin elevar.
    pub start_as_admin: bool,
    pub manual_aliases_text: String,
    pub favorite_repl_ids: String,
    pub hidden_environment_ids: String,
    pub shortcut_command_palette: String,
    pub shortcut_new_tab: String,
    pub shortcut_next_tab: String,
    pub shortcut_previous_tab: String,
    pub shortcut_cycle_panes: String,
    pub shortcut_toggle_explorer: String,
    pub shortcut_toggle_terminal_only: String,
    pub shortcut_pane_left: String,
    pub shortcut_pane_right: String,
    pub shortcut_pane_up: String,
    pub shortcut_pane_down: String,
    pub shortcut_open_settings: String,
    pub shortcut_open_projects: String,
    pub shortcut_open_scripts: String,
    pub shortcut_open_dependencies: String,
    pub shortcut_close_panel: String,
    pub shortcut_refresh_environments: String,
    pub shortcut_explorer_follow: String,
    pub shortcut_explorer_cd: String,
    pub shortcut_clear_terminal: String,
    pub shortcut_search_terminal: String,
    pub shortcut_open_system_explorer: String,
    pub theme_id: String,
    pub accent_color: String,
    pub ui_background_color: String,
    pub ui_surface_color: String,
    pub ui_surface_alt_color: String,
    pub ui_border_color: String,
    pub ui_text_color: String,
    pub ui_muted_color: String,
    pub terminal_selection_color: String,
    pub fastfetch_color: String,
    pub terminal_cursor_color: String,
    pub terminal_background: String,
    pub terminal_foreground: String,
    /// Aplicar el tema a toda la interfaz (fondos, superficies y texto) y no
    /// solo al acento. Desactivado de fábrica: los temas comparten la base
    /// negra de «Cian técnico».
    pub theme_recolor_all: bool,
    /// Temas guardados por el usuario. `themeId` puede apuntar a uno de ellos.
    pub custom_themes: Vec<CustomTheme>,
    /// Los 16 colores ANSI de la terminal (negro… blanco brillante). Vacío =
    /// la paleta de xterm.
    pub terminal_ansi_colors: Vec<String>,
    /// Una fuente instalada escrita a mano. Va delante de la familia elegida,
    /// que queda como respaldo si no existe.
    pub terminal_font_custom: String,
    pub terminal_font_family: String,
    pub terminal_font_size: i64,
    pub terminal_line_height: f64,
    pub terminal_letter_spacing: f64,
    pub terminal_cursor_style: String,
    pub terminal_font_weight: String,
    pub terminal_padding: i64,
    pub terminal_scrollback: i64,
    pub terminal_cursor_blink: bool,
    /// Enlaces clicables en la salida: URL http/https, `file:` y OSC 8 se
    /// abren con Ctrl+clic tras validarlos en `terminal::links`.
    pub terminal_links: bool,
    /// Pedir confirmación, con el destino a la vista, antes de abrir uno.
    pub terminal_links_confirm: bool,
    /// Cuántas líneas avanza una muesca de la rueda. xterm usa 1 de fábrica,
    /// que en un historial largo obliga a girar sin parar.
    pub terminal_scroll_sensitivity: i64,
    /// Copiar al seleccionar, como en las terminales de Linux. Desactivado de
    /// fábrica porque en Windows sorprende: la gente selecciona para leer.
    pub copy_on_select: bool,
    pub ui_density: String,
    pub default_environment_id: String,
    /// Solicita elevación UAC al iniciar WTerminal para que las shells,
    /// intérpretes y herramientas hereden un token administrativo.
    pub terminal_admin_by_default: bool,
    /// Guarda las cachés de lenguajes y gestores de paquetes (npm, pip, Go…)
    /// que se descargan desde WTerminal en una carpeta propia. Ver
    /// `config::toolchain_store`.
    pub toolchain_store_enabled: bool,
    /// Categorías de la carpeta propia además de las cachés (ver
    /// `config::toolchain_store::Category`). Herramientas e historial van
    /// apagados de fábrica: cambian dónde se instalan cosas nuevas.
    pub toolchain_store_downloads: bool,
    pub toolchain_store_ai_models: bool,
    pub toolchain_store_tools: bool,
    pub toolchain_store_repl_history: bool,
    /// Sugerencias del historial en gris y colores para órdenes y argumentos
    /// en la línea de órdenes de cada shell, con las herramientas propias de
    /// cada una (Clink en cmd, PSReadLine en PowerShell, ble.sh o los plugins
    /// de zsh). Solo actúa si esa herramienta está instalada. Ver
    /// `terminal::shell_assist`.
    pub shell_assist: bool,
    /// Lo mismo, shell por shell: con `shell_assist` activo, cada una se
    /// puede desactivar sin tocar las demás.
    pub shell_assist_cmd: bool,
    pub shell_assist_powershell: bool,
    pub shell_assist_bash: bool,
    pub shell_assist_zsh: bool,
    /// Aspecto de las sugerencias y del coloreado, común a todas las shells
    /// (ver `terminal::shell_assist::AssistStyle`). Un color vacío deja el de
    /// la herramienta de cada shell.
    pub shell_assist_suggestion_color: String,
    pub shell_assist_suggestion_italic: bool,
    pub shell_assist_syntax: bool,
    pub shell_assist_command_color: String,
    pub shell_assist_argument_color: String,
    pub shell_assist_error_color: String,
    /// PowerShell: predicciones en lista bajo la línea.
    pub shell_assist_list_view: bool,
    /// Carpeta de esas cachés. Vacía o relativa = la de fábrica
    /// (`%LOCALAPPDATA%\WTerminal\entornos`).
    pub toolchain_store_dir: String,
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
    /// Entorno preferido para ejecutar scripts shell (bash, sh, zsh...). Vacío =
    /// automático: prefiere WSL sobre Git Bash. Solo afecta a Windows, donde
    /// Git Bash sería la opción por defecto; así una distro WSL lo adelanta.
    pub default_script_environment_id: String,
}

impl Default for Preferences {
    fn default() -> Self {
        default_preferences()
    }
}

fn default_preferences() -> Preferences {
    let preferences: Preferences = toml::from_str(DEFAULT_SETTINGS)
        .expect("src-tauri/default_settings.toml debe contener todas las preferencias válidas");
    preferences
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

/// Una cadena vacía (o solo espacios) es «sin asignar» y se conserva: es lo
/// que guarda el botón «×» de Ajustes, y sin esto un atajo con valor de
/// fábrica volvía a aparecer al guardar. Una clave ausente, que no sea texto o
/// que no forme un atajo válido sí recibe `fallback`.
fn safe_shortcut(value: Option<&Value>, fallback: &str) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return fallback.to_string();
    };
    if text.trim().is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = text.split('+').map(str::trim).collect();
    if parts.len() < 2 || parts.len() > 4 || parts.iter().any(|part| part.is_empty()) {
        return fallback.to_string();
    }
    let key = parts[parts.len() - 1];
    let modifiers = &parts[..parts.len() - 1];
    let valid_modifier = |part: &&str| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "ctrl" | "alt" | "shift" | "meta"
        )
    };
    let modifiers_are_unique = modifiers.iter().enumerate().all(|(index, part)| {
        valid_modifier(part)
            && !modifiers[..index]
                .iter()
                .any(|previous| previous.eq_ignore_ascii_case(part))
    });
    let lower_key = key.to_ascii_lowercase();
    let valid_key = key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric())
        || matches!(
            lower_key.as_str(),
            "tab"
                | "backslash"
                | "enter"
                | "space"
                | "escape"
                | "arrowleft"
                | "arrowright"
                | "arrowup"
                | "arrowdown"
                | "home"
                | "end"
                | "pageup"
                | "pagedown"
                | "insert"
                | "minus"
                | "equal"
                | "bracketleft"
                | "bracketright"
                | "semicolon"
                | "quote"
                | "backquote"
                | "comma"
                | "period"
                | "slash"
                | "f1"
                | "f2"
                | "f3"
                | "f4"
                | "f5"
                | "f6"
                | "f7"
                | "f8"
                | "f9"
                | "f10"
                | "f11"
                | "f12"
        );
    if modifiers_are_unique && valid_key && text.len() <= 64 {
        let mut canonical: Vec<String> = ["ctrl", "alt", "shift", "meta"]
            .iter()
            .filter(|modifier| {
                modifiers
                    .iter()
                    .any(|part| part.eq_ignore_ascii_case(modifier))
            })
            .map(|modifier| (*modifier).to_string())
            .collect();
        let canonical_key = match lower_key.as_str() {
            "esc" => "escape",
            "return" => "enter",
            "del" => "delete",
            "left" => "arrowleft",
            "right" => "arrowright",
            "up" => "arrowup",
            "down" => "arrowdown",
            other => other,
        };
        canonical.push(canonical_key.to_string());
        canonical.join("+")
    } else {
        fallback.to_string()
    }
}

fn sanitize_id_list(text: &str, limit: usize) -> String {
    let mut seen = std::collections::HashSet::new();
    text.split(',')
        .map(str::trim)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 100
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_'))
                && seen.insert((*id).to_string())
        })
        .take(limit)
        .collect::<Vec<_>>()
        .join(",")
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

/// Respeta el valor de fábrica declarado en TOML cuando no hay booleano
/// explícito. Antes algunos interruptores tenían su valor codificado en el
/// validador, con lo que cambiar `default_settings.toml` no surtía efecto.
fn bool_or_default(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

/// Carpeta absoluta elegida por el usuario. Cualquier otra cosa (relativa,
/// con caracteres de control o desmesurada) vuelve a la de fábrica: vacía.
fn safe_absolute_dir(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str).map(str::trim) else {
        return String::new();
    };
    if text.len() > 260
        || text.chars().any(char::is_control)
        || !std::path::Path::new(text).is_absolute()
    {
        return String::new();
    }
    text.to_string()
}

const BANNER_ITEMS: [&str; 11] = [
    "system",
    "host",
    "kernel",
    "environment",
    "motherboard",
    "cpu",
    "gpu",
    "memory",
    "storage",
    "uptime",
    "datetime",
];

fn sanitize_banner_hidden_items(value: Option<&Value>, fallback: &str) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return fallback.to_string();
    };
    let mut seen = std::collections::HashSet::new();
    text.split(',')
        .map(str::trim)
        .filter(|item| BANNER_ITEMS.contains(item) && seen.insert(*item))
        .collect::<Vec<_>>()
        .join(",")
}

pub fn theme_by_id(id: &str) -> &'static ThemePreset {
    THEME_PRESETS
        .iter()
        .find(|theme| theme.id == id)
        .unwrap_or(&THEME_PRESETS[0])
}

/// Exactamente 16 colores `#rrggbb`, o nada (la paleta de xterm).
fn sanitize_ansi_colors(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let colors: Vec<String> = items
        .iter()
        .map(|item| safe_hex_color(Some(item), ""))
        .collect();
    if colors.len() == 16 && colors.iter().all(|color| !color.is_empty()) {
        colors
    } else {
        Vec::new()
    }
}

/// Nombre de una fuente instalada: letras, números, espacios y `-_.`, sin
/// comillas ni comas (no se puede colar otra declaración CSS).
fn sanitize_font_name(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let trimmed: String = text.trim().chars().take(64).collect();
    if trimmed
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
    {
        trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        String::new()
    }
}

/// Temas del usuario: como mucho 24, con nombre visible, identificador
/// `custom-…` único y todos los colores válidos (los que falten salen de la
/// base neutra).
fn sanitize_custom_themes(value: Option<&Value>) -> Vec<CustomTheme> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let base = &theme_by_id(NEUTRAL_THEME_ID).palette;
    let mut seen = std::collections::HashSet::new();
    let mut themes = Vec::new();
    for item in items {
        if themes.len() >= MAX_CUSTOM_THEMES {
            break;
        }
        let Some(object) = item.as_object() else {
            continue;
        };
        let label: String = object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(40)
            .collect();
        if label.is_empty() {
            continue;
        }
        let requested = object.get("id").and_then(Value::as_str).unwrap_or_default();
        let valid_id = requested.len() <= 48
            && requested.strip_prefix("custom-").is_some_and(|rest| {
                !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
        let mut id = if valid_id {
            requested.to_string()
        } else {
            format!("custom-{}", themes.len() + 1)
        };
        let mut suffix = 2;
        while !seen.insert(id.clone()) {
            id = format!("custom-{}-{suffix}", themes.len() + 1);
            suffix += 1;
        }
        let empty = Map::new();
        let palette = object
            .get("palette")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let color = |key: &str, fallback: &str| safe_hex_color(palette.get(key), fallback);
        themes.push(CustomTheme {
            id,
            label,
            palette: CustomPalette {
                background: color("background", base.background),
                surface: color("surface", base.surface),
                surface_alt: color("surfaceAlt", base.surface_alt),
                border: color("border", base.border),
                text: color("text", base.text),
                muted: color("muted", base.muted),
                accent: color("accent", base.accent),
                accent_soft: color("accentSoft", base.accent_soft),
                terminal_background: color("terminalBackground", base.terminal_background),
                terminal_foreground: color("terminalForeground", base.terminal_foreground),
                selection: color("selection", base.selection),
            },
            ansi: sanitize_ansi_colors(object.get("ansi")),
        });
    }
    themes
}

/// Convierte cualquier entrada — el JSON del disco, lo que mande el renderer,
/// nada en absoluto — en unas preferencias completas y dentro de rango.
pub fn sanitize_preferences(raw: &Value) -> Preferences {
    let defaults = Preferences::default();
    sanitize_preferences_with_defaults(raw, &defaults)
}

fn sanitize_preferences_with_defaults(raw: &Value, defaults: &Preferences) -> Preferences {
    let empty = Map::new();
    let source = raw.as_object().unwrap_or(&empty);
    let get = |key: &str| source.get(key);
    let custom_themes = sanitize_custom_themes(get("customThemes"));
    let theme_recolor_all = bool_or_default(get("themeRecolorAll"), defaults.theme_recolor_all);
    let mut theme_ids: Vec<&str> = THEME_PRESETS.iter().map(|theme| theme.id).collect();
    theme_ids.extend(custom_themes.iter().map(|theme| theme.id.as_str()));
    let theme_id = one_of(get("themeId"), &theme_ids, &defaults.theme_id);
    // Los colores que falten salen del tema elegido: del guardado por el
    // usuario tal cual, y de uno de fábrica según el modo (neutro o completo).
    let palette = match custom_themes.iter().find(|theme| theme.id == theme_id) {
        Some(custom) => custom.palette.clone(),
        None => {
            let preset = effective_palette(theme_by_id(&theme_id), theme_recolor_all);
            CustomPalette {
                background: preset.background.to_string(),
                surface: preset.surface.to_string(),
                surface_alt: preset.surface_alt.to_string(),
                border: preset.border.to_string(),
                text: preset.text.to_string(),
                muted: preset.muted.to_string(),
                accent: preset.accent.to_string(),
                accent_soft: preset.accent_soft.to_string(),
                terminal_background: preset.terminal_background.to_string(),
                terminal_foreground: preset.terminal_foreground.to_string(),
                selection: preset.selection.to_string(),
            }
        }
    };
    let font_ids: Vec<&str> = FONT_FAMILIES.iter().map(|font| font.id).collect();
    let language_ids: Vec<&str> = crate::i18n::LANGUAGES.iter().map(|lang| lang.id).collect();
    // Las primeras versiones usaban Alt+flechas. Esos cuatro valores exactos
    // interceptan la edición de línea en muchas shells y, al estar guardados,
    // impedían que los nuevos valores por defecto llegasen a perfiles
    // existentes. Solo migramos el conjunto heredado completo para conservar
    // cualquier asignación personalizada o parcial del usuario; un atajo
    // desasignado (`""`) nunca coincide con el conjunto y se respeta.
    let legacy_pane_shortcuts = [
        ("shortcutPaneLeft", "alt+arrowleft"),
        ("shortcutPaneRight", "alt+arrowright"),
        ("shortcutPaneUp", "alt+arrowup"),
        ("shortcutPaneDown", "alt+arrowdown"),
    ]
    .iter()
    .all(|(key, legacy)| safe_shortcut(get(key), "") == *legacy);
    // Una versión intermedia cambió la navegación a Ctrl+Alt+H/J/K/L. Si el
    // perfil conserva exactamente ese conjunto generado por la aplicación, se
    // devuelve al atajo original Ctrl+W/A/S/D sin pisar configuraciones
    // personalizadas o parciales.
    let mnemonic_pane_shortcuts = [
        ("shortcutPaneLeft", "ctrl+alt+h"),
        ("shortcutPaneRight", "ctrl+alt+l"),
        ("shortcutPaneUp", "ctrl+alt+k"),
        ("shortcutPaneDown", "ctrl+alt+j"),
    ]
    .iter()
    .all(|(key, mnemonic)| safe_shortcut(get(key), "") == *mnemonic);
    let shortcut_pane_left = if legacy_pane_shortcuts || mnemonic_pane_shortcuts {
        defaults.shortcut_pane_left.clone()
    } else {
        safe_shortcut(get("shortcutPaneLeft"), &defaults.shortcut_pane_left)
    };
    let shortcut_pane_right = if legacy_pane_shortcuts || mnemonic_pane_shortcuts {
        defaults.shortcut_pane_right.clone()
    } else {
        safe_shortcut(get("shortcutPaneRight"), &defaults.shortcut_pane_right)
    };
    let shortcut_pane_up = if legacy_pane_shortcuts || mnemonic_pane_shortcuts {
        defaults.shortcut_pane_up.clone()
    } else {
        safe_shortcut(get("shortcutPaneUp"), &defaults.shortcut_pane_up)
    };
    let shortcut_pane_down = if legacy_pane_shortcuts || mnemonic_pane_shortcuts {
        defaults.shortcut_pane_down.clone()
    } else {
        safe_shortcut(get("shortcutPaneDown"), &defaults.shortcut_pane_down)
    };

    Preferences {
        language: one_of(get("language"), &language_ids, &defaults.language),
        scripts_here_depth: integer_in_range(
            get("scriptsHereDepth"),
            0,
            10,
            defaults.scripts_here_depth,
        ),
        auto_start_docker: bool_or_default(get("autoStartDocker"), defaults.auto_start_docker),
        exclusive_accordion_groups: bool_or_default(
            get("exclusiveAccordionGroups"),
            defaults.exclusive_accordion_groups,
        ),
        auto_open_first_group: bool_or_default(
            get("autoOpenFirstGroup"),
            defaults.auto_open_first_group,
        ),
        show_system_banner: bool_or_default(get("showSystemBanner"), defaults.show_system_banner),
        clear_reprint_banner: bool_or_default(
            get("clearReprintBanner"),
            defaults.clear_reprint_banner,
        ),
        banner_hidden_items: sanitize_banner_hidden_items(
            get("bannerHiddenItems"),
            &defaults.banner_hidden_items,
        ),
        banner_image: bool_or_default(get("bannerImage"), defaults.banner_image),
        banner_image_columns: integer_in_range(
            get("bannerImageColumns"),
            8,
            40,
            defaults.banner_image_columns,
        ),
        // Las mismas reglas que una carpeta: absoluta, corta y sin controles.
        banner_image_path: safe_absolute_dir(get("bannerImagePath")),
        show_dependencies_panel: bool_or_default(
            get("showDependenciesPanel"),
            defaults.show_dependencies_panel,
        ),
        show_projects_panel: bool_or_default(
            get("showProjectsPanel"),
            defaults.show_projects_panel,
        ),
        show_scripts_panel: bool_or_default(get("showScriptsPanel"), defaults.show_scripts_panel),
        show_quick_actions: bool_or_default(get("showQuickActions"), defaults.show_quick_actions),
        ltools_enabled: bool_or_default(get("ltoolsEnabled"), defaults.ltools_enabled),
        show_explorer_panel: bool_or_default(
            get("showExplorerPanel"),
            defaults.show_explorer_panel,
        ),
        show_tab_bar: bool_or_default(get("showTabBar"), defaults.show_tab_bar),
        show_environment_selector: bool_or_default(
            get("showEnvironmentSelector"),
            defaults.show_environment_selector,
        ),
        show_refresh_button: bool_or_default(
            get("showRefreshButton"),
            defaults.show_refresh_button,
        ),
        show_language_button: bool_or_default(
            get("showLanguageButton"),
            defaults.show_language_button,
        ),
        terminal_only_mode: bool_or_default(get("terminalOnlyMode"), defaults.terminal_only_mode),
        show_terminal_only_guide: bool_or_default(
            get("showTerminalOnlyGuide"),
            defaults.show_terminal_only_guide,
        ),
        start_maximized: bool_or_default(get("startMaximized"), defaults.start_maximized),
        start_as_admin: bool_or_default(get("startAsAdmin"), defaults.start_as_admin),
        manual_aliases_text: get("manualAliasesText")
            .and_then(Value::as_str)
            .map(|text| text.chars().take(16_384).collect())
            .unwrap_or_else(|| defaults.manual_aliases_text.clone()),
        favorite_repl_ids: get("favoriteReplIds")
            .and_then(Value::as_str)
            .map(|text| {
                let mut seen = std::collections::HashSet::new();
                text.split(',')
                    .map(str::trim)
                    .filter(|id| {
                        !id.is_empty()
                            && id.len() <= 100
                            && id
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_'))
                            && seen.insert((*id).to_string())
                    })
                    .take(24)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_else(|| defaults.favorite_repl_ids.clone()),
        hidden_environment_ids: get("hiddenEnvironmentIds")
            .and_then(Value::as_str)
            .map(|text| sanitize_id_list(text, 256))
            .unwrap_or_else(|| defaults.hidden_environment_ids.clone()),
        shortcut_command_palette: safe_shortcut(
            get("shortcutCommandPalette"),
            &defaults.shortcut_command_palette,
        ),
        shortcut_new_tab: safe_shortcut(get("shortcutNewTab"), &defaults.shortcut_new_tab),
        shortcut_next_tab: safe_shortcut(get("shortcutNextTab"), &defaults.shortcut_next_tab),
        shortcut_previous_tab: safe_shortcut(
            get("shortcutPreviousTab"),
            &defaults.shortcut_previous_tab,
        ),
        shortcut_cycle_panes: safe_shortcut(
            get("shortcutCyclePanes"),
            &defaults.shortcut_cycle_panes,
        ),
        shortcut_toggle_explorer: safe_shortcut(
            get("shortcutToggleExplorer"),
            &defaults.shortcut_toggle_explorer,
        ),
        shortcut_toggle_terminal_only: safe_shortcut(
            get("shortcutToggleTerminalOnly"),
            &defaults.shortcut_toggle_terminal_only,
        ),
        shortcut_pane_left,
        shortcut_pane_right,
        shortcut_pane_up,
        shortcut_pane_down,
        shortcut_open_settings: safe_shortcut(
            get("shortcutOpenSettings"),
            &defaults.shortcut_open_settings,
        ),
        shortcut_open_projects: safe_shortcut(
            get("shortcutOpenProjects"),
            &defaults.shortcut_open_projects,
        ),
        shortcut_open_scripts: safe_shortcut(
            get("shortcutOpenScripts"),
            &defaults.shortcut_open_scripts,
        ),
        shortcut_open_dependencies: safe_shortcut(
            get("shortcutOpenDependencies"),
            &defaults.shortcut_open_dependencies,
        ),
        shortcut_close_panel: safe_shortcut(
            get("shortcutClosePanel"),
            &defaults.shortcut_close_panel,
        ),
        shortcut_refresh_environments: safe_shortcut(
            get("shortcutRefreshEnvironments"),
            &defaults.shortcut_refresh_environments,
        ),
        shortcut_explorer_follow: safe_shortcut(
            get("shortcutExplorerFollow"),
            &defaults.shortcut_explorer_follow,
        ),
        shortcut_explorer_cd: safe_shortcut(
            get("shortcutExplorerCd"),
            &defaults.shortcut_explorer_cd,
        ),
        shortcut_clear_terminal: safe_shortcut(
            get("shortcutClearTerminal"),
            &defaults.shortcut_clear_terminal,
        ),
        shortcut_search_terminal: safe_shortcut(
            get("shortcutSearchTerminal"),
            &defaults.shortcut_search_terminal,
        ),
        shortcut_open_system_explorer: safe_shortcut(
            get("shortcutOpenSystemExplorer"),
            &defaults.shortcut_open_system_explorer,
        ),
        accent_color: safe_hex_color(get("accentColor"), &palette.accent),
        ui_background_color: safe_hex_color(get("uiBackgroundColor"), &palette.background),
        ui_surface_color: safe_hex_color(get("uiSurfaceColor"), &palette.surface),
        ui_surface_alt_color: safe_hex_color(get("uiSurfaceAltColor"), &palette.surface_alt),
        ui_border_color: safe_hex_color(get("uiBorderColor"), &palette.border),
        ui_text_color: safe_hex_color(get("uiTextColor"), &palette.text),
        ui_muted_color: safe_hex_color(get("uiMutedColor"), &palette.muted),
        terminal_selection_color: safe_hex_color(get("terminalSelectionColor"), &palette.selection),
        fastfetch_color: safe_hex_color(get("fastfetchColor"), &palette.accent),
        terminal_cursor_color: safe_hex_color(get("terminalCursorColor"), &palette.accent),
        terminal_background: safe_hex_color(
            get("terminalBackground"),
            &palette.terminal_background,
        ),
        terminal_foreground: safe_hex_color(
            get("terminalForeground"),
            &palette.terminal_foreground,
        ),
        theme_id,
        theme_recolor_all,
        custom_themes,
        terminal_ansi_colors: sanitize_ansi_colors(get("terminalAnsiColors")),
        terminal_font_custom: sanitize_font_name(get("terminalFontCustom")),
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
            5.0,
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
        terminal_cursor_blink: bool_or_default(
            get("terminalCursorBlink"),
            defaults.terminal_cursor_blink,
        ),
        terminal_links: bool_or_default(get("terminalLinks"), defaults.terminal_links),
        terminal_links_confirm: bool_or_default(
            get("terminalLinksConfirm"),
            defaults.terminal_links_confirm,
        ),
        terminal_scroll_sensitivity: integer_in_range(
            get("terminalScrollSensitivity"),
            1,
            10,
            defaults.terminal_scroll_sensitivity,
        ),
        copy_on_select: bool_or_default(get("copyOnSelect"), defaults.copy_on_select),
        ui_density: one_of(get("uiDensity"), &UI_DENSITIES, &defaults.ui_density),
        default_environment_id: safe_environment_id(get("defaultEnvironmentId")),
        terminal_admin_by_default: bool_or_default(
            get("terminalAdminByDefault"),
            defaults.terminal_admin_by_default,
        ),
        toolchain_store_enabled: bool_or_default(
            get("toolchainStoreEnabled"),
            defaults.toolchain_store_enabled,
        ),
        toolchain_store_downloads: bool_or_default(
            get("toolchainStoreDownloads"),
            defaults.toolchain_store_downloads,
        ),
        toolchain_store_ai_models: bool_or_default(
            get("toolchainStoreAiModels"),
            defaults.toolchain_store_ai_models,
        ),
        toolchain_store_tools: bool_or_default(
            get("toolchainStoreTools"),
            defaults.toolchain_store_tools,
        ),
        toolchain_store_repl_history: bool_or_default(
            get("toolchainStoreReplHistory"),
            defaults.toolchain_store_repl_history,
        ),
        shell_assist: bool_or_default(get("shellAssist"), defaults.shell_assist),
        shell_assist_cmd: bool_or_default(get("shellAssistCmd"), defaults.shell_assist_cmd),
        shell_assist_powershell: bool_or_default(
            get("shellAssistPowershell"),
            defaults.shell_assist_powershell,
        ),
        shell_assist_bash: bool_or_default(get("shellAssistBash"), defaults.shell_assist_bash),
        shell_assist_zsh: bool_or_default(get("shellAssistZsh"), defaults.shell_assist_zsh),
        shell_assist_suggestion_color: safe_hex_color(get("shellAssistSuggestionColor"), ""),
        shell_assist_suggestion_italic: bool_or_default(
            get("shellAssistSuggestionItalic"),
            defaults.shell_assist_suggestion_italic,
        ),
        shell_assist_syntax: bool_or_default(
            get("shellAssistSyntax"),
            defaults.shell_assist_syntax,
        ),
        shell_assist_command_color: safe_hex_color(get("shellAssistCommandColor"), ""),
        shell_assist_argument_color: safe_hex_color(get("shellAssistArgumentColor"), ""),
        shell_assist_error_color: safe_hex_color(get("shellAssistErrorColor"), ""),
        shell_assist_list_view: bool_or_default(
            get("shellAssistListView"),
            defaults.shell_assist_list_view,
        ),
        toolchain_store_dir: safe_absolute_dir(get("toolchainStoreDir")),
        default_script_environment_id: safe_environment_id(get("defaultScriptEnvironmentId")),
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

    #[test]
    fn el_catalogo_de_temas_va_por_familias_de_al_menos_dos() {
        let ids: Vec<&str> = THEME_PRESETS.iter().map(|theme| theme.id).collect();
        assert_eq!(ids.len() % 5, 0, "{ids:?}");
        assert_eq!(ids[0], "silver", "el primero es el de respaldo");
        let mut listed: Vec<&str> = Vec::new();
        for (family, members) in THEME_FAMILIES {
            assert!(members.len() >= 2, "{family}");
            listed.extend(members.iter().copied());
        }
        // Cada tema en exactamente una familia y en el mismo orden.
        assert_eq!(listed, ids);
    }
    use serde_json::json;

    #[test]
    fn una_entrada_vacia_da_los_valores_de_fabrica() {
        assert_eq!(sanitize_preferences(&json!({})), Preferences::default());
        assert_eq!(sanitize_preferences(&Value::Null), Preferences::default());
    }

    #[test]
    fn toda_fuente_cae_en_iconos_y_emoji_antes_del_monospace_generico() {
        let mut ids = std::collections::HashSet::new();
        for font in FONT_FAMILIES.iter() {
            assert!(ids.insert(font.id), "id repetido: {}", font.id);
            assert!(
                font.css
                    .ends_with(&format!("{SYMBOL_FALLBACKS}, monospace")),
                "{} no termina en el respaldo de símbolos: {}",
                font.id,
                font.css
            );
            assert_eq!(font.css.matches("monospace").count(), 1, "{}", font.id);
        }
        // La fuente por defecto sigue existiendo y las Nerd Font se prueban
        // antes que la familia normal.
        assert!(FONT_FAMILIES
            .iter()
            .any(|font| font.id == Preferences::default().terminal_font_family));
        let jetbrains = FONT_FAMILIES
            .iter()
            .find(|font| font.id == "jetbrains")
            .unwrap();
        assert!(
            jetbrains.css.find("Nerd Font").unwrap()
                < jetbrains.css.find("'JetBrains Mono'").unwrap()
        );
    }

    #[test]
    fn la_elevacion_por_defecto_es_desactivada_y_se_puede_activar() {
        assert!(!Preferences::default().terminal_admin_by_default);
        let enabled = sanitize_preferences(&json!({ "terminalAdminByDefault": true }));
        assert!(enabled.terminal_admin_by_default);
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
    fn la_altura_de_linea_admite_hasta_cinco() {
        let prefs = sanitize_preferences(&json!({
            "terminalLineHeight": 9.0
        }));
        assert_eq!(prefs.terminal_line_height, 5.0);
    }

    #[test]
    fn los_elementos_del_banner_se_validan_sin_duplicados_ni_valores_desconocidos() {
        let prefs = sanitize_preferences(&json!({
            "bannerHiddenItems": "gpu, cpu, gpu, inventado,storage"
        }));
        assert_eq!(prefs.banner_hidden_items, "gpu,cpu,storage");
    }

    #[test]
    fn un_id_desconocido_cae_al_valor_por_defecto() {
        let prefs = sanitize_preferences(&json!({
            "themeId": "no-existe",
            "terminalFontFamily": "comic-sans",
            "uiDensity": "gigante",
            "language": "xx"
        }));
        assert_eq!(prefs.theme_id, "silver");
        assert_eq!(prefs.terminal_font_family, "ubuntu-mono");
        assert_eq!(prefs.ui_density, "comfortable");
        assert_eq!(prefs.language, "auto");
    }

    #[test]
    fn los_colores_del_tema_rellenan_los_que_faltan() {
        // De fábrica, el tema solo aporta el acento: fondo y texto son los
        // de la base neutra de «Cian técnico».
        let prefs = sanitize_preferences(&json!({ "themeId": "matrix" }));
        assert_eq!(prefs.accent_color, "#3ddc45");
        assert_eq!(prefs.fastfetch_color, "#3ddc45");
        assert_eq!(prefs.terminal_cursor_color, "#3ddc45");
        assert_eq!(prefs.terminal_background, "#0d0d0d");
        assert_eq!(prefs.terminal_foreground, "#d4d4d4");
        assert_eq!(prefs.ui_background_color, "#0d0d0d");
        // Recolorear todo es voluntario y entonces manda la paleta completa.
        let full = sanitize_preferences(&json!({ "themeId": "matrix", "themeRecolorAll": true }));
        assert_eq!(full.terminal_background, "#000000");
        assert_eq!(full.terminal_foreground, "#8ef78e");
        // El alto contraste conserva su texto blanco aunque no se recoloree.
        let contrast = sanitize_preferences(&json!({ "themeId": "contrast" }));
        assert_eq!(contrast.terminal_foreground, "#ffffff");
    }

    #[test]
    fn los_temas_de_fabrica_comparten_la_base_neutra_salvo_el_acento() {
        let defaults = Preferences::default();
        assert!(!defaults.theme_recolor_all);
        let base = &theme_by_id(NEUTRAL_THEME_ID).palette;
        assert_eq!(defaults.ui_background_color, base.background);
        assert_eq!(defaults.terminal_background, base.terminal_background);
        for theme in THEME_PRESETS.iter() {
            let palette = effective_palette(theme, false);
            assert_eq!(palette.accent, theme.palette.accent, "{}", theme.id);
            if !FULL_PALETTE_THEMES.contains(&theme.id) {
                assert_eq!(palette.background, base.background, "{}", theme.id);
                assert_eq!(palette.text, base.text, "{}", theme.id);
            }
            assert_eq!(
                effective_palette(theme, true).background,
                theme.palette.background
            );
        }
    }

    #[test]
    fn los_temas_propios_se_validan_y_se_pueden_elegir() {
        let ansi: Vec<String> = (0..16).map(|index| format!("#0000{index:02x}")).collect();
        let prefs = sanitize_preferences(&json!({
            "themeId": "custom-mio",
            "customThemes": [
                { "id": "custom-mio", "label": "  Mío  ", "palette": { "background": "#101010", "accent": "#FF0000", "text": "rojo" }, "ansi": ansi },
                { "id": "custom-mio", "label": "Repetido", "palette": {} },
                { "id": "../malo", "label": "Sin id válido", "palette": {}, "ansi": ["#000000"] },
                { "id": "custom-x", "label": "", "palette": {} },
                "no es un objeto"
            ],
        }));
        assert_eq!(prefs.theme_id, "custom-mio");
        let ids: Vec<&str> = prefs
            .custom_themes
            .iter()
            .map(|theme| theme.id.as_str())
            .collect();
        assert_eq!(ids.len(), 3, "{ids:?}");
        assert_eq!(ids[0], "custom-mio");
        assert!(ids.iter().all(|id| id.starts_with("custom-")));
        assert_eq!(prefs.custom_themes[0].label, "Mío");
        assert_eq!(prefs.custom_themes[0].ansi.len(), 16);
        assert!(
            prefs.custom_themes[2].ansi.is_empty(),
            "una paleta ANSI incompleta se descarta"
        );
        // Los colores que faltan salen del tema propio elegido.
        assert_eq!(prefs.ui_background_color, "#101010");
        assert_eq!(prefs.accent_color, "#ff0000");
        assert_eq!(
            prefs.ui_text_color,
            theme_by_id(NEUTRAL_THEME_ID).palette.text
        );
        // Un tema propio que ya no existe vuelve al de fábrica.
        let gone = sanitize_preferences(&json!({ "themeId": "custom-borrado" }));
        assert_eq!(gone.theme_id, Preferences::default().theme_id);
        assert!(
            serde_json::to_value(&prefs).unwrap()["customThemes"][0]["palette"]["surfaceAlt"]
                .is_string()
        );
    }

    #[test]
    fn la_paleta_ansi_y_la_fuente_propia_se_validan() {
        let ansi: Vec<String> = (0..16).map(|_| "#ABCDEF".to_string()).collect();
        let prefs = sanitize_preferences(&json!({
            "terminalAnsiColors": ansi,
            "terminalFontCustom": "  Cascadia   Code PL ",
        }));
        assert_eq!(prefs.terminal_ansi_colors.len(), 16);
        assert_eq!(prefs.terminal_ansi_colors[0], "#abcdef");
        assert_eq!(prefs.terminal_font_custom, "Cascadia Code PL");
        let bad = sanitize_preferences(&json!({
            "terminalAnsiColors": ["#000000", "#ffffff"],
            "terminalFontCustom": "Arial', serif; x: url(y)",
        }));
        assert!(bad.terminal_ansi_colors.is_empty());
        assert!(bad.terminal_font_custom.is_empty());
    }

    #[test]
    fn solo_se_acepta_hexadecimal_de_seis_digitos() {
        let prefs = sanitize_preferences(&json!({
            "accentColor": "#ABCDEF",
            "fastfetchColor": "#123ABC",
            "terminalBackground": "rojo",
            "terminalForeground": "#fff"
        }));
        assert_eq!(prefs.accent_color, "#abcdef");
        assert_eq!(prefs.fastfetch_color, "#123abc");
        // Lo inválido cae en la base neutra del tema de fábrica.
        assert_eq!(prefs.terminal_background, "#0d0d0d");
        assert_eq!(prefs.terminal_foreground, "#d4d4d4");
    }

    #[test]
    fn los_booleanos_respetan_su_lado_por_defecto() {
        let prefs = sanitize_preferences(&json!({
            "autoStartDocker": "no",
            "copyOnSelect": "si",
            "showSystemBanner": false,
            "autoOpenFirstGroup": true
        }));
        // Una entrada que no sea booleana conserva el valor de fábrica...
        assert!(!prefs.auto_start_docker);
        assert!(!prefs.show_system_banner);
        assert!(!prefs.copy_on_select);
        assert!(prefs.auto_open_first_group);
    }

    #[test]
    fn los_enlaces_vienen_activados_y_con_confirmacion() {
        let defaults = Preferences::default();
        assert!(defaults.terminal_links && defaults.terminal_links_confirm);
        let prefs = sanitize_preferences(&json!({
            "terminalLinks": "no",
            "terminalLinksConfirm": false
        }));
        assert!(
            prefs.terminal_links,
            "un valor no booleano conserva el de fábrica"
        );
        assert!(!prefs.terminal_links_confirm);
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
        assert_eq!(parsed["terminalFontSize"], json!(12));
        assert_eq!(parsed["scriptsHereDepth"], json!(3));
        assert_eq!(parsed["viewportRows"], json!(24));
        assert_eq!(parsed["clearReprintBanner"], json!(true));
        assert_eq!(parsed["showDependenciesPanel"], json!(true));
        assert_eq!(parsed["showProjectsPanel"], json!(true));
        assert_eq!(parsed["showScriptsPanel"], json!(true));
        assert_eq!(parsed["showQuickActions"], json!(true));
        assert_eq!(parsed["ltoolsEnabled"], json!(false));
        assert_eq!(parsed["showExplorerPanel"], json!(true));
    }

    #[test]
    fn los_atajos_se_normalizan_para_todos_los_teclados() {
        let prefs = sanitize_preferences(&json!({
            "shortcutNewTab": " SHIFT + CTRL + T ",
            "shortcutCyclePanes": "ctrl+shift+backslash"
        }));
        assert_eq!(prefs.shortcut_new_tab, "ctrl+shift+t");
        assert_eq!(prefs.shortcut_cycle_panes, "ctrl+shift+backslash");
    }

    #[test]
    fn la_paleta_de_comandos_tiene_atajo_de_fabrica_editable() {
        assert_eq!(
            Preferences::default().shortcut_command_palette,
            "Ctrl+Shift+P"
        );
        let parsed: Value =
            serde_json::from_str(&serde_json::to_string(&Preferences::default()).unwrap()).unwrap();
        assert_eq!(parsed["shortcutCommandPalette"], json!("Ctrl+Shift+P"));
        assert_eq!(
            sanitize_preferences(&json!({ "shortcutCommandPalette": " alt + SHIFT + k " }))
                .shortcut_command_palette,
            "alt+shift+k"
        );
        // Un valor que no es un atajo vuelve al de fábrica en vez de dejar la
        // paleta sin forma de abrirse con el teclado.
        assert_eq!(
            sanitize_preferences(&json!({ "shortcutCommandPalette": "p" }))
                .shortcut_command_palette,
            "Ctrl+Shift+P"
        );
        // Vaciarlo con «×» sí la deja sin atajo: es una decisión explícita.
        assert_eq!(
            sanitize_preferences(&json!({ "shortcutCommandPalette": "" })).shortcut_command_palette,
            ""
        );
    }

    #[test]
    fn un_atajo_vacio_queda_sin_asignar_y_uno_invalido_vuelve_al_de_fabrica() {
        let defaults = Preferences::default();
        let prefs = sanitize_preferences(&json!({
            "shortcutNewTab": "",
            "shortcutSearchTerminal": "   ",
            "shortcutToggleTerminalOnly": "",
            "shortcutToggleExplorer": "p",
            "shortcutCyclePanes": "Ctrl+Shift+TeclaInventada",
            "shortcutNextTab": 5,
            "shortcutPreviousTab": null
        }));
        assert_eq!(prefs.shortcut_new_tab, "");
        assert_eq!(prefs.shortcut_search_terminal, "", "solo espacios = vacío");
        assert_eq!(prefs.shortcut_toggle_terminal_only, "");
        assert_eq!(
            prefs.shortcut_toggle_explorer,
            defaults.shortcut_toggle_explorer
        );
        assert_eq!(prefs.shortcut_cycle_panes, defaults.shortcut_cycle_panes);
        assert_eq!(prefs.shortcut_next_tab, defaults.shortcut_next_tab);
        assert_eq!(prefs.shortcut_previous_tab, defaults.shortcut_previous_tab);
        // Una clave ausente (perfil antiguo) recibe el de fábrica.
        assert_eq!(prefs.shortcut_command_palette, "Ctrl+Shift+P");

        // `settings:save` sanea, guarda el JSON y lo vuelve a sanear al
        // releerlo: el vacío tiene que sobrevivir a esa ida y vuelta.
        let reloaded = sanitize_preferences(&serde_json::to_value(&prefs).unwrap());
        assert_eq!(reloaded.shortcut_new_tab, "");
        assert_eq!(reloaded.shortcut_search_terminal, "");
        assert_eq!(reloaded.shortcut_toggle_terminal_only, "");
    }

    #[test]
    fn los_atajos_de_panel_vacios_no_disparan_la_migracion() {
        let cleared = sanitize_preferences(&json!({
            "shortcutPaneLeft": "",
            "shortcutPaneRight": "",
            "shortcutPaneUp": "",
            "shortcutPaneDown": ""
        }));
        assert_eq!(cleared.shortcut_pane_left, "");
        assert_eq!(cleared.shortcut_pane_right, "");
        assert_eq!(cleared.shortcut_pane_up, "");
        assert_eq!(cleared.shortcut_pane_down, "");

        // Un conjunto heredado al que el usuario quitó un atajo ya es
        // personal: no se migra y el hueco se conserva.
        let partial = sanitize_preferences(&json!({
            "shortcutPaneLeft": "Alt+ArrowLeft",
            "shortcutPaneRight": "Alt+ArrowRight",
            "shortcutPaneUp": "Alt+ArrowUp",
            "shortcutPaneDown": ""
        }));
        assert_eq!(partial.shortcut_pane_left, "alt+arrowleft");
        assert_eq!(partial.shortcut_pane_down, "");

        let partial_mnemonic = sanitize_preferences(&json!({
            "shortcutPaneLeft": "",
            "shortcutPaneRight": "Ctrl+Alt+L",
            "shortcutPaneUp": "Ctrl+Alt+K",
            "shortcutPaneDown": "Ctrl+Alt+J"
        }));
        assert_eq!(partial_mnemonic.shortcut_pane_left, "");
        assert_eq!(partial_mnemonic.shortcut_pane_right, "ctrl+alt+l");
    }

    #[test]
    fn migra_solo_el_conjunto_completo_de_atajos_de_flechas_heredado() {
        let migrated = sanitize_preferences(&json!({
            "shortcutPaneLeft": "Alt+ArrowLeft",
            "shortcutPaneRight": "Alt+ArrowRight",
            "shortcutPaneUp": "Alt+ArrowUp",
            "shortcutPaneDown": "Alt+ArrowDown"
        }));
        assert_eq!(migrated.shortcut_pane_left, "Ctrl+A");
        assert_eq!(migrated.shortcut_pane_right, "Ctrl+D");
        assert_eq!(migrated.shortcut_pane_up, "Ctrl+W");
        assert_eq!(migrated.shortcut_pane_down, "Ctrl+S");

        let restored = sanitize_preferences(&json!({
            "shortcutPaneLeft": "Ctrl+Alt+H",
            "shortcutPaneRight": "Ctrl+Alt+L",
            "shortcutPaneUp": "Ctrl+Alt+K",
            "shortcutPaneDown": "Ctrl+Alt+J"
        }));
        assert_eq!(restored.shortcut_pane_left, "Ctrl+A");
        assert_eq!(restored.shortcut_pane_right, "Ctrl+D");
        assert_eq!(restored.shortcut_pane_up, "Ctrl+W");
        assert_eq!(restored.shortcut_pane_down, "Ctrl+S");

        let custom = sanitize_preferences(&json!({
            "shortcutPaneLeft": "Alt+ArrowLeft",
            "shortcutPaneRight": "Alt+ArrowRight",
            "shortcutPaneUp": "Alt+ArrowUp",
            "shortcutPaneDown": "Ctrl+Alt+S"
        }));
        assert_eq!(custom.shortcut_pane_left, "alt+arrowleft");
        assert_eq!(custom.shortcut_pane_down, "ctrl+alt+s");
    }

    #[test]
    fn cada_panel_se_puede_desactivar_sin_afectar_a_los_demas() {
        let prefs = sanitize_preferences(&json!({
            "showDependenciesPanel": false,
            "showProjectsPanel": true,
            "showScriptsPanel": false,
            "showQuickActions": false,
            "ltoolsEnabled": true,
            "showExplorerPanel": false
        }));
        assert!(!prefs.show_dependencies_panel);
        assert!(prefs.show_projects_panel);
        assert!(!prefs.show_scripts_panel);
        assert!(!prefs.show_quick_actions);
        assert!(prefs.ltools_enabled);
        assert!(!prefs.show_explorer_panel);
    }

    #[test]
    fn los_ids_de_tema_y_fuente_son_unicos() {
        let mut ids: Vec<&str> = THEME_PRESETS.iter().map(|theme| theme.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
        assert_eq!(total, 15);
    }
}
