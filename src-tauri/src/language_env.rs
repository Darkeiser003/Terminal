//! Entornos de LENGUAJE: además de las shells del sistema, el selector ofrece
//! el intérprete interactivo (REPL) de los lenguajes instalados en la máquina.
//! Elegir uno abre el REPL real dentro de la pestaña, con su propio pty.
//!
//! Port de `electron/main/languageEnv.js`.
//!
//! Estos entornos se marcan con `repl: true` porque NO son shells:
//!   - no se les inyectan alias (un `doskey` o un `alias` escrito dentro de un
//!     intérprete de Python es un error de sintaxis),
//!   - las acciones que escriben comandos (lanzar un script, instalar una
//!     dependencia) se enrutan a una shell de verdad.
//!
//! La detección solo mira si el ejecutable existe; no se instala nada ni se
//! ejecuta el lenguaje durante el arranque.

use crate::environments::{Environment, ShellKind, Transport};

struct LanguageDef {
    id: &'static str,
    label: &'static str,
    windows_exe: &'static str,
    unix_exe: &'static str,
    args: &'static [&'static str],
    note: Option<&'static str>,
}

#[rustfmt::skip]
static LANGUAGE_DEFS: &[LanguageDef] = &[
    LanguageDef { id: "python", label: "Python", windows_exe: "python", unix_exe: "python3", args: &[], note: None },
    LanguageDef { id: "node", label: "Node.js", windows_exe: "node", unix_exe: "node", args: &[], note: None },
    // irb es el REPL de Ruby; el binario `ruby` sin argumentos se queda leyendo
    // un script de la entrada estándar, que no es lo que se busca.
    LanguageDef { id: "ruby", label: "Ruby", windows_exe: "irb", unix_exe: "irb", args: &[], note: None },
    // jshell viene con el JDK 9+. Un JRE suelto no lo trae.
    LanguageDef { id: "java", label: "Java", windows_exe: "jshell", unix_exe: "jshell", args: &[],
        note: Some("jshell forma parte del JDK 9 o superior.") },
    LanguageDef { id: "php", label: "PHP", windows_exe: "php", unix_exe: "php", args: &["-a"],
        note: Some("El modo interactivo de PHP requiere que la compilación incluya readline.") },
    LanguageDef { id: "lua", label: "Lua", windows_exe: "lua", unix_exe: "lua", args: &[], note: None },
    LanguageDef { id: "r", label: "R", windows_exe: "R", unix_exe: "R", args: &["--no-save"], note: None },
    LanguageDef { id: "groovy", label: "Groovy", windows_exe: "groovysh", unix_exe: "groovysh", args: &[], note: None },
    LanguageDef { id: "deno", label: "Deno", windows_exe: "deno", unix_exe: "deno", args: &["repl"], note: None },
    // Perl no trae REPL propio: el modo depurador sobre una expresión vacía es
    // la forma habitual de obtener uno.
    LanguageDef { id: "perl", label: "Perl", windows_exe: "perl", unix_exe: "perl", args: &["-de1"],
        note: Some("Perl no incluye un REPL propio: se abre su depurador interactivo.") },
];

pub const LANGUAGE_GROUP: &str = "Lenguajes · intérprete interactivo";

/// Cómo se comprueba y se localiza cada intérprete. Se inyecta para poder
/// probar la detección sin depender de lo que haya instalado en la máquina, y
/// porque quien llama ya conoce los casos especiales (el alias de Python de la
/// Microsoft Store, ver `path_env::is_tool_installed`).
pub struct Probe<'a> {
    pub is_installed: &'a dyn Fn(&str) -> bool,
    pub resolve_path: &'a dyn Fn(&str) -> Option<String>,
}

pub fn detect_language_environments(platform: &str, probe: &Probe<'_>) -> Vec<Environment> {
    let is_windows = platform == "windows" || platform == "win32";
    LANGUAGE_DEFS
        .iter()
        .filter_map(|definition| {
            let exe = if is_windows {
                definition.windows_exe
            } else {
                definition.unix_exe
            };
            if !(probe.is_installed)(exe) {
                return None;
            }
            Some(Environment {
                id: format!("lang:{}", definition.id),
                label: format!("{} · REPL", definition.label),
                group: LANGUAGE_GROUP.to_string(),
                kind: ShellKind::Repl,
                transport: Transport::Native,
                exe: (probe.resolve_path)(exe).unwrap_or_else(|| exe.to_string()),
                args: definition.args.iter().map(|arg| arg.to_string()).collect(),
                note: definition.note.map(str::to_string),
                repl: true,
                language: Some(definition.id.to_string()),
                ..Default::default()
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_with(
        installed: &'static [&'static str],
    ) -> (impl Fn(&str) -> bool, impl Fn(&str) -> Option<String>) {
        (
            move |exe: &str| installed.contains(&exe),
            |exe: &str| Some(format!("/usr/bin/{exe}")),
        )
    }

    #[test]
    fn solo_aparecen_los_interpretes_instalados() {
        let (is_installed, resolve_path) = probe_with(&["python3", "node"]);
        let envs = detect_language_environments(
            "linux",
            &Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
        );
        let ids: Vec<&str> = envs.iter().map(|env| env.id.as_str()).collect();
        assert_eq!(ids, vec!["lang:python", "lang:node"]);
    }

    #[test]
    fn windows_y_unix_buscan_binarios_distintos_para_python() {
        let (is_installed, resolve_path) = probe_with(&["python"]);
        let probe = Probe {
            is_installed: &is_installed,
            resolve_path: &resolve_path,
        };
        assert_eq!(detect_language_environments("windows", &probe).len(), 1);
        // En Unix el binario es python3: `python` a secas no cuenta.
        assert!(detect_language_environments("linux", &probe).is_empty());
    }

    #[test]
    fn un_repl_se_marca_como_tal_y_no_como_shell() {
        let (is_installed, resolve_path) = probe_with(&["node"]);
        let envs = detect_language_environments(
            "linux",
            &Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
        );
        let env = &envs[0];
        assert!(env.repl);
        assert_eq!(env.kind, ShellKind::Repl);
        assert_eq!(env.language.as_deref(), Some("node"));
        assert_eq!(env.group, LANGUAGE_GROUP);
        assert_eq!(env.exe, "/usr/bin/node");
    }

    #[test]
    fn se_conservan_los_argumentos_y_la_nota_de_cada_lenguaje() {
        let (is_installed, resolve_path) = probe_with(&["php", "perl", "lua"]);
        let envs = detect_language_environments(
            "linux",
            &Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
        );
        let php = envs.iter().find(|env| env.id == "lang:php").unwrap();
        assert_eq!(php.args, vec!["-a".to_string()]);
        assert!(php.note.is_some());

        let perl = envs.iter().find(|env| env.id == "lang:perl").unwrap();
        assert_eq!(perl.args, vec!["-de1".to_string()]);

        let lua = envs.iter().find(|env| env.id == "lang:lua").unwrap();
        assert!(lua.args.is_empty());
        assert_eq!(lua.note, None);
    }

    #[test]
    fn si_no_se_resuelve_la_ruta_se_usa_el_nombre_a_secas() {
        let is_installed = |_: &str| true;
        let resolve_path = |_: &str| None;
        let envs = detect_language_environments(
            "linux",
            &Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
        );
        let node = envs.iter().find(|env| env.id == "lang:node").unwrap();
        assert_eq!(node.exe, "node");
    }

    #[test]
    fn los_ids_de_lenguaje_son_unicos() {
        let mut ids: Vec<&str> = LANGUAGE_DEFS.iter().map(|def| def.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }
}
