//! Catálogo de traducciones de la aplicación.
//!
//! Port de `electron/main/i18n.js`. No depende de Tauri a propósito: el
//! backend lo usa para las etiquetas que genera (panel de dependencias,
//! banner, errores que viajan por IPC), el frontend recibe su propio catálogo
//! ya resuelto, y las pruebas pueden comprobarlo entero sin arrancar nada.
//!
//! Reglas del catálogo:
//!   - la clave es estable y en inglés; el idioma de referencia es el español,
//!     que es en el que se escribió la aplicación;
//!   - los parámetros van entre llaves: `t("tabs.closed", &[("code", "1")])`;
//!   - lo que NO se traduce: nombres propios (Docker, PowerShell, Nautilus),
//!     rutas, comandos y salida de la terminal. Traducir un comando lo rompe.
//!
//! Añadir un idioma es añadir un JSON a `locales/` con las mismas claves: las
//! que falten caen al español, así que un idioma incompleto degrada a texto
//! entendible en vez de a una clave cruda en pantalla.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use serde::Serialize;

pub const FALLBACK_LANGUAGE: &str = "es";

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Language {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(rename = "englishLabel")]
    pub english_label: &'static str,
}

/// Idiomas que se ofrecen en Ajustes. `auto` no es un catálogo: es "el del
/// sistema", que se resuelve al arrancar y cuando cambian las preferencias.
#[rustfmt::skip]
pub static LANGUAGES: Lazy<Vec<Language>> = Lazy::new(|| {
    vec![
        Language { id: "auto", label: "Automático (sistema)", english_label: "Automatic (system)" },
        Language { id: "en", label: "English", english_label: "English" },
        Language { id: "es", label: "Español", english_label: "Spanish" },
        Language { id: "fr", label: "Français", english_label: "French" },
        Language { id: "de", label: "Deutsch", english_label: "German" },
        Language { id: "it", label: "Italiano", english_label: "Italian" },
        Language { id: "pt", label: "Português", english_label: "Portuguese" },
        Language { id: "ru", label: "Русский", english_label: "Russian" },
        Language { id: "zh", label: "中文", english_label: "Chinese" },
        Language { id: "ja", label: "日本語", english_label: "Japanese" },
        Language { id: "ko", label: "한국어", english_label: "Korean" },
        Language { id: "uk", label: "Українська", english_label: "Ukrainian" },
        Language { id: "pl", label: "Polski", english_label: "Polish" },
        Language { id: "ro", label: "Română", english_label: "Romanian" },
        Language { id: "ar", label: "العربية", english_label: "Arabic" },
        Language { id: "hi", label: "हिन्दी", english_label: "Hindi" },
    ]
});

// Los catálogos viven en JSON junto al código en vez de incrustados en él: son
// datos, cambian sin tocar lógica, y así se pueden validar con un script.
const ES_CATALOG: &str = include_str!("../../locales/es.json");
const EN_CATALOG: &str = include_str!("../../locales/en.json");
const FR_CATALOG: &str = include_str!("../../locales/fr.json");
const DE_CATALOG: &str = include_str!("../../locales/de.json");
const IT_CATALOG: &str = include_str!("../../locales/it.json");
const PT_CATALOG: &str = include_str!("../../locales/pt.json");
const RU_CATALOG: &str = include_str!("../../locales/ru.json");
const ZH_CATALOG: &str = include_str!("../../locales/zh.json");
const JA_CATALOG: &str = include_str!("../../locales/ja.json");
const KO_CATALOG: &str = include_str!("../../locales/ko.json");
const UK_CATALOG: &str = include_str!("../../locales/uk.json");
const PL_CATALOG: &str = include_str!("../../locales/pl.json");
const RO_CATALOG: &str = include_str!("../../locales/ro.json");
const AR_CATALOG: &str = include_str!("../../locales/ar.json");
const HI_CATALOG: &str = include_str!("../../locales/hi.json");

type Catalog = HashMap<String, String>;

static CATALOGS: Lazy<HashMap<&'static str, Catalog>> = Lazy::new(|| {
    let mut catalogs = HashMap::new();
    catalogs.insert("es", parse_catalog("es", ES_CATALOG));
    catalogs.insert("en", parse_catalog("en", EN_CATALOG));
    catalogs.insert("fr", parse_catalog("fr", FR_CATALOG));
    catalogs.insert("de", parse_catalog("de", DE_CATALOG));
    catalogs.insert("it", parse_catalog("it", IT_CATALOG));
    catalogs.insert("pt", parse_catalog("pt", PT_CATALOG));
    catalogs.insert("ru", parse_catalog("ru", RU_CATALOG));
    catalogs.insert("zh", parse_catalog("zh", ZH_CATALOG));
    catalogs.insert("ja", parse_catalog("ja", JA_CATALOG));
    catalogs.insert("ko", parse_catalog("ko", KO_CATALOG));
    catalogs.insert("uk", parse_catalog("uk", UK_CATALOG));
    catalogs.insert("pl", parse_catalog("pl", PL_CATALOG));
    catalogs.insert("ro", parse_catalog("ro", RO_CATALOG));
    catalogs.insert("ar", parse_catalog("ar", AR_CATALOG));
    catalogs.insert("hi", parse_catalog("hi", HI_CATALOG));
    catalogs
});

fn parse_catalog(language: &str, raw: &str) -> Catalog {
    serde_json::from_str(raw).unwrap_or_else(|error| {
        // Un catálogo roto no debe impedir arrancar: se degrada al español
        // escrito en el código, que es el respaldo de translate().
        eprintln!("Catálogo de idioma '{language}' ilegible: {error}");
        Catalog::new()
    })
}

fn has_catalog(language: &str) -> bool {
    CATALOGS.contains_key(language)
}

/// Qué idioma se usa de verdad: el elegido en Ajustes si existe, y si la
/// preferencia es `auto`, el del sistema reducido a su parte base
/// (`es-ES` -> `es`).
pub fn resolve_language(preference: &str, system_locale: &str) -> String {
    if !preference.is_empty() && preference != "auto" {
        return if has_catalog(preference) {
            preference.to_string()
        } else {
            FALLBACK_LANGUAGE.to_string()
        };
    }
    let base = system_locale
        .to_lowercase()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_string();
    if has_catalog(&base) {
        base
    } else {
        FALLBACK_LANGUAGE.to_string()
    }
}

/// Sustituye `{nombre}` por su valor. Un parámetro que no se pasa se queda tal
/// cual, que es más fácil de detectar que una cadena vacía.
pub fn interpolate(text: &str, params: &[(&str, String)]) -> String {
    if params.is_empty() || !text.contains('{') {
        return text.to_string();
    }
    let mut out = text.to_string();
    for (name, value) in params {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

/// `fallback` es el texto en español que está escrito en el propio código: así
/// el idioma de referencia no necesita catálogo completo y una clave sin
/// traducir se ve en español, nunca como "settings.language".
pub fn translate(language: &str, key: &str, params: &[(&str, String)], fallback: &str) -> String {
    let catalog = CATALOGS
        .get(language)
        .or_else(|| CATALOGS.get(FALLBACK_LANGUAGE));
    let text = catalog
        .and_then(|entries| entries.get(key))
        .or_else(|| CATALOGS.get(FALLBACK_LANGUAGE).and_then(|es| es.get(key)))
        .map(String::as_str)
        .unwrap_or(if fallback.is_empty() { key } else { fallback });
    interpolate(text, params)
}

/// Traductor atado a un idioma, equivalente a `createTranslator`.
#[derive(Debug, Clone)]
pub struct Translator {
    pub language: String,
}

impl Translator {
    pub fn new(language: &str) -> Translator {
        Translator {
            language: if has_catalog(language) {
                language.to_string()
            } else {
                FALLBACK_LANGUAGE.to_string()
            },
        }
    }

    /// Clave con respaldo en español y sin parámetros.
    pub fn t(&self, key: &str, fallback: &str) -> String {
        translate(&self.language, key, &[], fallback)
    }

    /// Clave con respaldo en español y parámetros `{nombre}`.
    pub fn tp(&self, key: &str, params: &[(&str, String)], fallback: &str) -> String {
        translate(&self.language, key, params, fallback)
    }
}

impl Default for Translator {
    fn default() -> Self {
        Translator::new(FALLBACK_LANGUAGE)
    }
}

/// Los apartados del panel de dependencias y los grupos del selector de entorno
/// se generan en español en los módulos que los producen (`install_actions`,
/// `environments`, `docker_env`...) y se usan además como clave de ordenación.
/// En vez de obligar a esos módulos a conocer el catálogo, se les añade aquí su
/// clave antes de mandarlos al frontend.
#[rustfmt::skip]
static GROUP_KEYS: &[(&str, &str)] = &[
    // Panel de entorno y dependencias
    ("Actualizaciones",                      "group.updates"),
    ("Shells",                               "group.shells"),
    ("Sistema y herramientas",               "group.tools"),
    ("Lenguajes",                            "group.languages"),
    ("Frameworks",                            "group.frameworks"),
    ("Visores de archivos",                  "group.viewers"),
    ("Virtualización",                        "group.virt"),
    ("Compatibilidad Windows",               "group.windowsCompat"),
    ("WSL",                                  "group.wsl"),
    ("Docker",                               "group.docker"),
    ("Android · ADB",                        "group.android"),
    ("Red y acceso remoto",                  "group.network"),
    // Selector de entorno
    ("Shells del sistema",                   "env.groupShells"),
    ("Lenguajes · intérprete interactivo",   "env.groupLanguages"),
    ("Docker · contenedores en ejecución",   "env.groupDockerContainers"),
    ("Android (ADB)",                        "env.groupAndroid"),
];

pub fn group_key_for(name: &str) -> Option<&'static str> {
    GROUP_KEYS
        .iter()
        .find(|(group, _)| *group == name)
        .map(|(_, key)| *key)
}

/// Los verbos de las acciones son un vocabulario cerrado que genera la propia
/// aplicación (`install_actions`), no texto libre: se traducen en la frontera,
/// al mandar el catálogo al frontend, sin que ese módulo tenga que conocer los
/// idiomas. Lo que no esté aquí se queda como está.
#[rustfmt::skip]
static VERB_KEYS: &[(&str, &str)] = &[
    ("Instalar",    "verb.install"),
    ("Actualizar",  "verb.update"),
    ("Desinstalar", "verb.uninstall"),
    ("Versión",     "verb.version"),
    ("Verificar",   "verb.verify"),
    ("Ver",         "verb.view"),
    ("Iniciar",     "verb.start"),
    ("Reiniciar",   "verb.restart"),
    ("Abrir",       "verb.open"),
];

pub fn verb_key_for(verb: &str) -> Option<&'static str> {
    VERB_KEYS
        .iter()
        .find(|(name, _)| *name == verb)
        .map(|(_, key)| *key)
}

/// El idioma en el que hay que hablarle al usuario ahora mismo: su preferencia,
/// resuelta contra el catálogo y contra el idioma del sistema.
pub fn active_language() -> String {
    let preference = crate::preferences::current().language;
    resolve_language(&preference, &system_locale())
}

/// Catálogo que se le pasa al frontend: solo el idioma activo, ya resuelto. El
/// frontend no decide el idioma ni ve los demás catálogos.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogPayload {
    pub language: String,
    pub strings: Catalog,
}

pub fn catalog_for(language: &str) -> CatalogPayload {
    let resolved = if has_catalog(language) {
        language.to_string()
    } else {
        FALLBACK_LANGUAGE.to_string()
    };
    let mut strings = CATALOGS.get(FALLBACK_LANGUAGE).cloned().unwrap_or_default();
    if resolved != FALLBACK_LANGUAGE {
        if let Some(target) = CATALOGS.get(resolved.as_str()) {
            for (k, v) in target {
                strings.insert(k.clone(), v.clone());
            }
        }
    }
    CatalogPayload {
        language: resolved,
        strings,
    }
}

/// El idioma del sistema, en el formato que devolvía `app.getLocale()`
/// (`es-ES`, `en-US`). Se lee de las variables de entorno POSIX y, en Windows,
/// del idioma de interfaz del usuario.
pub fn system_locale() -> String {
    #[cfg(not(windows))]
    {
        for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(value) = std::env::var(key) {
                let cleaned = value.split('.').next().unwrap_or("").trim().to_string();
                if !cleaned.is_empty() && cleaned != "C" && cleaned != "POSIX" {
                    return cleaned.replace('_', "-");
                }
            }
        }
        String::new()
    }
    #[cfg(windows)]
    {
        // No hay API de Tauri para esto y no merece una dependencia nueva:
        // PowerShell ya expone la cultura de la interfaz del usuario.
        std::env::var("LTERMINAL_LOCALE").unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_preferencia_explicita_manda_sobre_el_sistema() {
        assert_eq!(resolve_language("en", "es-ES"), "en");
        assert_eq!(resolve_language("es", "en-US"), "es");
    }

    #[test]
    fn auto_toma_la_base_del_idioma_del_sistema() {
        assert_eq!(resolve_language("auto", "en-US"), "en");
        assert_eq!(resolve_language("auto", "es_ES.UTF-8"), "es");
        assert_eq!(resolve_language("", "EN-gb"), "en");
    }

    #[test]
    fn un_idioma_sin_catalogo_cae_al_espanol() {
        assert_eq!(resolve_language("xx", "xx-XX"), "es");
        assert_eq!(resolve_language("auto", "sw-KE"), "es");
        assert_eq!(resolve_language("auto", ""), "es");
    }

    #[test]
    fn una_clave_sin_traducir_se_ve_con_su_respaldo_en_espanol() {
        let t = Translator::new("en");
        assert_eq!(
            t.t("clave.que.no.existe", "Texto de respaldo"),
            "Texto de respaldo"
        );
    }

    #[test]
    fn una_clave_sin_traducir_y_sin_respaldo_se_ve_como_la_clave() {
        let t = Translator::new("es");
        assert_eq!(t.t("clave.que.no.existe", ""), "clave.que.no.existe");
    }

    #[test]
    fn los_parametros_se_sustituyen_por_nombre() {
        assert_eq!(
            interpolate(
                "La shell terminó con código {code}",
                &[("code", "130".into())]
            ),
            "La shell terminó con código 130"
        );
    }

    #[test]
    fn un_parametro_que_no_se_pasa_se_queda_visible() {
        assert_eq!(
            interpolate("Hola {nombre}", &[("otro", "x".into())]),
            "Hola {nombre}"
        );
    }

    #[test]
    fn el_traductor_normaliza_un_idioma_desconocido() {
        assert_eq!(Translator::new("xx").language, "es");
        assert_eq!(Translator::new("en").language, "en");
    }

    #[test]
    fn el_catalogo_del_frontend_solo_lleva_el_idioma_activo() {
        let payload = catalog_for("xx");
        assert_eq!(payload.language, "es");
    }

    #[test]
    fn cada_apartado_del_panel_y_del_selector_lleva_su_clave_de_traduccion() {
        assert_eq!(group_key_for("Docker"), Some("group.docker"));
        assert_eq!(group_key_for("Shells del sistema"), Some("env.groupShells"));
        // Un apartado que nadie ha declarado se queda en español, que es el
        // idioma en el que lo escribe el módulo que lo produce.
        assert_eq!(group_key_for("Apartado inventado"), None);
    }

    #[test]
    fn todo_apartado_declarado_existe_de_verdad_en_el_catalogo_ingles() {
        let en = CATALOGS.get("en").expect("catálogo inglés");
        for (grupo, clave) in GROUP_KEYS {
            assert!(
                en.contains_key(*clave),
                "'{grupo}' apunta a '{clave}', que no está traducida"
            );
        }
        for (verbo, clave) in VERB_KEYS {
            assert!(
                en.contains_key(*clave),
                "'{verbo}' apunta a '{clave}', que no está traducida"
            );
        }
    }

    #[test]
    fn todos_los_idiomas_tienen_las_mismas_claves_que_el_espanol() {
        let spanish = CATALOGS.get(FALLBACK_LANGUAGE).expect("catálogo español");
        let mut expected: Vec<&str> = spanish.keys().map(String::as_str).collect();
        expected.sort_unstable();

        for (language, catalog) in CATALOGS.iter() {
            let mut actual: Vec<&str> = catalog.keys().map(String::as_str).collect();
            actual.sort_unstable();
            assert_eq!(
                actual, expected,
                "el catálogo '{language}' no tiene exactamente las claves del español"
            );
        }
    }

    #[test]
    fn los_verbos_de_las_acciones_son_un_vocabulario_cerrado() {
        assert_eq!(verb_key_for("Desinstalar"), Some("verb.uninstall"));
        assert_eq!(
            translate("en", verb_key_for("Versión").unwrap(), &[], "Versión"),
            "Version"
        );
        // Un verbo fuera del vocabulario no se traduce en vez de inventarse.
        assert_eq!(verb_key_for("Catapultar"), None);
    }
}
