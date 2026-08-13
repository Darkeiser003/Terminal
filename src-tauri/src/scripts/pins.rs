//! Scripts anclados al panel.
//!
//! Módulo nuevo, con el mismo trato que los repositorios anclados de Proyectos:
//! una lista de rutas en `settings.json`, fuera de `Preferences` porque no es un
//! ajuste con rango que validar sino una colección que crece.
//!
//! Lo que aporta sobre la lista normal: un script anclado se ve SIEMPRE, esté
//! donde esté el panel. La biblioteca puede tener cientos de archivos y el modo
//! «Aquí» enseña los de la carpeta de la pestaña; sin anclar, llegar a los
//! cuatro que uno usa a diario obliga a filtrar cada vez.
//!
//! Un anclado conserva su carpeta (`rel_dir`), su tipo y su origen, así que el
//! panel puede seguir agrupándolos igual que a los demás.

use std::path::Path;

use serde_json::{Map, Value};

use crate::platform::traits::HostPlatform;

use super::scan::ScriptEntry;

/// La clave de `settings.json`. El nombre sigue el de `githubPinnedRepos`.
const SETTINGS_KEY: &str = "pinnedScripts";

/// Tope de anclados. No es una limitación técnica: un panel con doscientos
/// "anclados" ya no destaca nada, que es justo lo que se busca al anclar.
pub const MAX_PINNED: usize = 50;

/// Las rutas ancladas, tal y como están guardadas. No se comprueba aquí que
/// existan: eso lo hace `resolve`, que es quien va a tocar el disco.
pub fn load(settings: &Map<String, Value>) -> Vec<String> {
    settings
        .get(SETTINGS_KEY)
        .and_then(Value::as_array)
        .map(|lista| {
            lista
                .iter()
                .filter_map(|valor| valor.as_str())
                .filter(|ruta| !ruta.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Añade o quita una ruta y devuelve la lista resultante.
///
/// Sin duplicados y respetando el orden de anclaje: lo último anclado va al
/// final, que es donde el usuario espera encontrarlo.
pub fn toggle(current: &[String], path: &str, pinned: bool) -> Vec<String> {
    let mut lista: Vec<String> = current
        .iter()
        .filter(|existente| !same_path(existente, path))
        .cloned()
        .collect();
    if pinned {
        lista.push(path.to_string());
    }
    // Si se pasa del tope, cae lo más antiguo: anclar algo nuevo no puede
    // fallar en silencio por una lista llena de hace meses.
    if lista.len() > MAX_PINNED {
        lista.drain(..lista.len() - MAX_PINNED);
    }
    lista
}

/// Windows no distingue mayúsculas ni el sentido de las barras en las rutas.
/// Sin esto, el mismo script anclado desde dos vistas distintas se guardaría dos
/// veces y "desanclar" solo quitaría una.
pub fn same_path(a: &str, b: &str) -> bool {
    fn normalizar(ruta: &str) -> String {
        let plana = ruta.replace('\\', "/");
        if crate::platform::host().is_windows() {
            plana.to_lowercase()
        } else {
            plana
        }
    }
    normalizar(a) == normalizar(b)
}

pub fn contains(list: &[String], path: &str) -> bool {
    list.iter().any(|anclado| same_path(anclado, path))
}

/// El patch que hay que guardar en `settings.json`.
pub fn patch(list: &[String]) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert(SETTINGS_KEY.to_string(), serde_json::json!(list));
    patch
}

/// Convierte las rutas ancladas en entradas completas del panel.
///
/// `describe` es quien sabe leer un archivo y decir qué es; se inyecta para
/// poder probar esto sin depender de lo que haya en el disco de la máquina.
///
/// Lo que ya no existe se cae de la lista en silencio: un script borrado o una
/// unidad desconectada no son un error que merezca un aviso, y el panel se
/// quedaría enseñando algo que no se puede lanzar.
pub fn resolve(
    paths: &[String],
    describe: &dyn Fn(&Path) -> Option<ScriptEntry>,
) -> (Vec<ScriptEntry>, Vec<String>) {
    let mut entradas = Vec::new();
    let mut vivas = Vec::new();
    for ruta in paths {
        if let Some(entrada) = describe(Path::new(ruta)) {
            vivas.push(ruta.clone());
            entradas.push(entrada);
        }
    }
    (entradas, vivas)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::types::{FileCategory, ScriptType};

    fn entrada(path: &str) -> ScriptEntry {
        ScriptEntry {
            name: Path::new(path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            ext: ".ps1".to_string(),
            kind: ScriptType::Powershell,
            category: FileCategory::Powershell,
            interpreter: None,
            runnable: true,
            openable: true,
            instruction: "",
            path: path.to_string(),
            rel_dir: String::new(),
            source: "Scripts".to_string(),
            hint: None,
        }
    }

    fn ajustes(rutas: &[&str]) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("pinnedScripts".to_string(), serde_json::json!(rutas));
        map
    }

    #[test]
    fn sin_nada_guardado_no_hay_anclados_y_no_es_un_error() {
        assert!(load(&Map::new()).is_empty());
        // Un valor del tipo equivocado tampoco revienta: se ignora.
        let mut roto = Map::new();
        roto.insert(
            "pinnedScripts".to_string(),
            serde_json::json!("no es lista"),
        );
        assert!(load(&roto).is_empty());
    }

    #[test]
    fn anclar_dos_veces_el_mismo_script_no_lo_duplica() {
        let lista = toggle(&[], "C:/s/a.ps1", true);
        let otra_vez = toggle(&lista, "C:/s/a.ps1", true);
        assert_eq!(otra_vez.len(), 1);
    }

    #[test]
    fn lo_ultimo_anclado_queda_al_final() {
        let lista = toggle(&toggle(&[], "a.ps1", true), "b.ps1", true);
        assert_eq!(lista, vec!["a.ps1".to_string(), "b.ps1".to_string()]);
    }

    #[test]
    fn desanclar_quita_solo_ese() {
        let lista = toggle(&toggle(&[], "a.ps1", true), "b.ps1", true);
        assert_eq!(toggle(&lista, "a.ps1", false), vec!["b.ps1".to_string()]);
    }

    #[test]
    #[cfg(windows)]
    fn en_windows_la_misma_ruta_escrita_distinto_es_la_misma() {
        // El explorador y el escaneo pueden dar la ruta con barras distintas o
        // con otra caja: sin normalizar, el mismo script se anclaria dos veces y
        // desanclarlo solo quitaria una.
        let lista = toggle(&[], r"C:\Scripts\Build.ps1", true);
        assert!(contains(&lista, "c:/scripts/build.ps1"));
        assert!(toggle(&lista, "c:/scripts/build.ps1", false).is_empty());
    }

    #[test]
    fn al_pasarse_del_tope_cae_lo_mas_antiguo() {
        let mut lista = Vec::new();
        for indice in 0..MAX_PINNED + 5 {
            lista = toggle(&lista, &format!("s{indice}.ps1"), true);
        }
        assert_eq!(lista.len(), MAX_PINNED);
        // Los cinco primeros son los que se han caido.
        assert!(!contains(&lista, "s0.ps1"));
        assert!(contains(&lista, &format!("s{}.ps1", MAX_PINNED + 4)));
    }

    #[test]
    fn un_anclado_que_ya_no_existe_se_cae_de_la_lista_sin_avisar() {
        let guardadas = load(&ajustes(&["vivo.ps1", "borrado.ps1"]));
        let (entradas, vivas) = resolve(&guardadas, &|ruta| {
            (ruta.to_string_lossy() == "vivo.ps1").then(|| entrada("vivo.ps1"))
        });
        assert_eq!(entradas.len(), 1);
        assert_eq!(vivas, vec!["vivo.ps1".to_string()]);
    }

    #[test]
    fn un_anclado_conserva_su_carpeta_su_tipo_y_su_origen() {
        // Es lo que permite al panel seguir agrupandolos como a los demas.
        let (entradas, _) = resolve(&["C:/s/build.ps1".to_string()], &|ruta| {
            let mut entrada = entrada(&ruta.to_string_lossy());
            entrada.rel_dir = "ci".to_string();
            entrada.source = "WinSlim Toolbox".to_string();
            Some(entrada)
        });
        assert_eq!(entradas[0].rel_dir, "ci");
        assert_eq!(entradas[0].source, "WinSlim Toolbox");
        assert_eq!(entradas[0].category, FileCategory::Powershell);
    }

    #[test]
    fn el_patch_guarda_la_lista_bajo_la_clave_de_ajustes() {
        let patch = patch(&["a.ps1".to_string()]);
        assert_eq!(patch["pinnedScripts"], serde_json::json!(["a.ps1"]));
    }
}
