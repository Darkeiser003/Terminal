//! Valores por defecto para las IA de terminal que se lanzan desde WTerminal.
//!
//! Gemini CLI y Qwen Code buscan actualizaciones al arrancar y, si hay una,
//! lanzan `npm install -g …` con `detached: true`. En Windows eso crea una
//! consola nueva, que la terminal predeterminada (Windows Terminal) abre en
//! otra ventana o pestaña, fuera de WTerminal. Las dos aceptan un archivo de
//! valores por defecto de sistema por variable de entorno, con la prioridad
//! más baja: aquí se desactiva solo la actualización automática (siguen
//! avisando de que hay versión nueva, y Dependencias ofrece actualizar). Si el
//! usuario fija `general.enableAutoUpdate` en sus ajustes, manda el suyo; y si
//! ya define estas variables, no se pisan (`process::child_environment`).

use std::path::Path;

/// Variables de cada CLI que apuntan a su archivo de valores por defecto.
pub const DEFAULTS_VARIABLES: [&str; 2] = [
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
];

/// El contenido: el mismo esquema (`general.enableAutoUpdate`) en las dos.
pub const DEFAULTS_JSON: &str = "{\n  \"general\": {\n    \"enableAutoUpdate\": false\n  }\n}\n";

const FILE_NAME: &str = "ai-cli-defaults.json";

/// Escribe el archivo en `dir` (si cambió) y devuelve las variables que lo
/// señalan. Sin archivo no se publica nada: mejor la actualización de
/// siempre que una ruta rota.
pub fn prepare_in(dir: &Path) -> Vec<(String, String)> {
    let path = dir.join(FILE_NAME);
    let current = std::fs::read_to_string(&path).ok();
    if current.as_deref() != Some(DEFAULTS_JSON) {
        let _ = std::fs::create_dir_all(dir);
        if std::fs::write(&path, DEFAULTS_JSON).is_err() {
            return Vec::new();
        }
    }
    DEFAULTS_VARIABLES
        .iter()
        .map(|variable| (variable.to_string(), path.to_string_lossy().into_owned()))
        .collect()
}

/// Al arrancar: en la carpeta de datos de la app.
pub fn install() {
    crate::process::set_base_environment(prepare_in(&crate::paths::user_data_dir()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_y_qwen_no_abren_una_consola_aparte_para_actualizarse() {
        let dir = tempfile::tempdir().unwrap();
        let variables = prepare_in(dir.path());
        assert_eq!(
            variables
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            DEFAULTS_VARIABLES
        );
        let written = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(json["general"]["enableAutoUpdate"], false);
        // Una segunda vez no reescribe nada y devuelve lo mismo.
        assert_eq!(prepare_in(dir.path()), variables);
    }
}
