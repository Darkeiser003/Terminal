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

use once_cell::sync::Lazy;
use serde::Deserialize;

use crate::environments::{Environment, ShellKind, Transport};

struct LanguageDef {
    id: &'static str,
    label: &'static str,
    windows_exe: &'static str,
    unix_exe: &'static str,
    args: &'static [&'static str],
    note: Option<&'static str>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogDef {
    id: String,
    label: String,
    #[serde(rename = "category")]
    _category: String,
    windows_exe: String,
    unix_exe: String,
    #[serde(default)]
    args: Vec<String>,
    note: Option<String>,
}

static CATALOG_DEFS: Lazy<Vec<CatalogDef>> = Lazy::new(|| {
    match serde_json::from_str(include_str!("../../config/technology-catalog.json")) {
        Ok(definitions) => definitions,
        Err(error) => {
            log_error!(
                "Catálogo modular de tecnologías inválido",
                serde_json::json!({"error": error.to_string()})
            );
            Vec::new()
        }
    }
});

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
    LanguageDef { id: "bun", label: "Bun", windows_exe: "bun", unix_exe: "bun", args: &["repl"], note: None },
    // Perl no trae REPL propio: el modo depurador sobre una expresión vacía es
    // la forma habitual de obtener uno.
    LanguageDef { id: "perl", label: "Perl", windows_exe: "perl", unix_exe: "perl", args: &["-de1"],
        note: Some("Perl no incluye un REPL propio: se abre su depurador interactivo.") },
    LanguageDef { id: "julia", label: "Julia", windows_exe: "julia", unix_exe: "julia", args: &[], note: None },
    LanguageDef { id: "kotlin", label: "Kotlin", windows_exe: "kotlinc", unix_exe: "kotlinc", args: &[],
        note: Some("kotlinc sin archivo abre el intérprete interactivo.") },
    LanguageDef { id: "csharp", label: "C#", windows_exe: "csi", unix_exe: "csi", args: &[],
        note: Some("Requiere C# Interactive (csi), incluido con algunos SDK y herramientas .NET.") },
    LanguageDef { id: "fsharp", label: "F#", windows_exe: "dotnet", unix_exe: "dotnet", args: &["fsi"],
        note: Some("Requiere .NET SDK con F# Interactive.") },
    LanguageDef { id: "haskell", label: "Haskell", windows_exe: "ghci", unix_exe: "ghci", args: &[], note: None },
    // Arch empaqueta Scala 3 como `scala3`; en Windows el launcher habitual
    // sigue siendo `scala`.
    LanguageDef { id: "scala", label: "Scala", windows_exe: "scala", unix_exe: "scala3", args: &[], note: None },
    LanguageDef { id: "clojure", label: "Clojure", windows_exe: "clj", unix_exe: "clj", args: &[], note: None },
    LanguageDef { id: "elixir", label: "Elixir", windows_exe: "iex", unix_exe: "iex", args: &[], note: None },
    LanguageDef { id: "erlang", label: "Erlang", windows_exe: "erl", unix_exe: "erl", args: &[], note: None },
    LanguageDef { id: "ocaml", label: "OCaml", windows_exe: "ocaml", unix_exe: "ocaml", args: &[], note: None },
    LanguageDef { id: "racket", label: "Racket", windows_exe: "racket", unix_exe: "racket", args: &[], note: None },
    LanguageDef { id: "rust", label: "Rust", windows_exe: "evcxr", unix_exe: "evcxr", args: &[],
        note: Some("Requiere evcxr, el intérprete interactivo de Rust.") },
    LanguageDef { id: "ipython", label: "IPython", windows_exe: "ipython", unix_exe: "ipython", args: &[], note: None },
    LanguageDef { id: "typescript", label: "TypeScript", windows_exe: "ts-node", unix_exe: "ts-node", args: &[], note: None },
    LanguageDef { id: "luajit", label: "LuaJIT", windows_exe: "luajit", unix_exe: "luajit", args: &[], note: None },
    LanguageDef { id: "raku", label: "Raku", windows_exe: "raku", unix_exe: "raku", args: &[], note: None },
    LanguageDef { id: "tcl", label: "Tcl", windows_exe: "tclsh", unix_exe: "tclsh", args: &[], note: None },
    LanguageDef { id: "octave", label: "GNU Octave", windows_exe: "octave", unix_exe: "octave", args: &["--interactive"], note: None },
    LanguageDef { id: "maxima", label: "Maxima", windows_exe: "maxima", unix_exe: "maxima", args: &[], note: None },
    LanguageDef { id: "pari-gp", label: "PARI/GP", windows_exe: "gp", unix_exe: "gp", args: &[], note: None },
    LanguageDef { id: "gap", label: "GAP", windows_exe: "gap", unix_exe: "gap", args: &[], note: None },
    LanguageDef { id: "sage", label: "SageMath", windows_exe: "sage", unix_exe: "sage", args: &[], note: None },
    LanguageDef { id: "jupyter", label: "Jupyter", windows_exe: "jupyter", unix_exe: "jupyter", args: &["console"], note: None },
    LanguageDef { id: "go-gore", label: "Go · gore", windows_exe: "gore", unix_exe: "gore", args: &[], note: None },
    LanguageDef { id: "cling", label: "C/C++ · Cling", windows_exe: "cling", unix_exe: "cling", args: &[], note: None },
    LanguageDef { id: "lfortran", label: "Fortran · LFortran", windows_exe: "lfortran", unix_exe: "lfortran", args: &[], note: None },
    LanguageDef { id: "nim", label: "Nim", windows_exe: "nim", unix_exe: "nim", args: &["secret"], note: None },
    LanguageDef { id: "crystal", label: "Crystal", windows_exe: "crystal", unix_exe: "crystal", args: &[], note: None },
    LanguageDef { id: "v", label: "V", windows_exe: "v", unix_exe: "v", args: &["repl"], note: None },
    LanguageDef { id: "swift", label: "Swift", windows_exe: "swift", unix_exe: "swift", args: &[], note: None },
    LanguageDef { id: "dart", label: "Dart", windows_exe: "dart", unix_exe: "dart", args: &[], note: None },
    LanguageDef { id: "standard-ml", label: "Standard ML", windows_exe: "sml", unix_exe: "sml", args: &[], note: None },
    LanguageDef { id: "elm", label: "Elm", windows_exe: "elm", unix_exe: "elm", args: &["repl"], note: None },
    LanguageDef { id: "scheme-guile", label: "Scheme · Guile", windows_exe: "guile", unix_exe: "guile", args: &[], note: None },
    LanguageDef { id: "common-lisp-sbcl", label: "Common Lisp · SBCL", windows_exe: "sbcl", unix_exe: "sbcl", args: &[], note: None },
    LanguageDef { id: "idris2", label: "Idris 2", windows_exe: "idris2", unix_exe: "idris2", args: &[], note: None },
    LanguageDef { id: "coq", label: "Coq", windows_exe: "coqtop", unix_exe: "coqtop", args: &[], note: None },
    LanguageDef { id: "sqlite", label: "SQLite", windows_exe: "sqlite3", unix_exe: "sqlite3", args: &[], note: None },
    LanguageDef { id: "postgresql", label: "PostgreSQL", windows_exe: "psql", unix_exe: "psql", args: &[], note: None },
    LanguageDef { id: "mysql", label: "MySQL", windows_exe: "mysql", unix_exe: "mysql", args: &[], note: None },
    LanguageDef { id: "mariadb", label: "MariaDB", windows_exe: "mariadb", unix_exe: "mariadb", args: &[], note: None },
    LanguageDef { id: "duckdb", label: "DuckDB", windows_exe: "duckdb", unix_exe: "duckdb", args: &[], note: None },
    LanguageDef { id: "mongodb", label: "MongoDB", windows_exe: "mongosh", unix_exe: "mongosh", args: &[], note: None },
    LanguageDef { id: "redis", label: "Redis", windows_exe: "redis-cli", unix_exe: "redis-cli", args: &[], note: None },
    LanguageDef { id: "swi-prolog", label: "Prolog · SWI", windows_exe: "swipl", unix_exe: "swipl", args: &[], note: None },
    LanguageDef { id: "gnu-prolog", label: "Prolog · GNU", windows_exe: "gprolog", unix_exe: "gprolog", args: &[], note: None },
    LanguageDef { id: "forth", label: "Forth", windows_exe: "gforth", unix_exe: "gforth", args: &[], note: None },
    LanguageDef { id: "fennel", label: "Fennel", windows_exe: "fennel", unix_exe: "fennel", args: &[], note: None },
    LanguageDef { id: "janet", label: "Janet", windows_exe: "janet", unix_exe: "janet", args: &[], note: None },
    LanguageDef { id: "gjs", label: "JavaScript · GJS", windows_exe: "gjs", unix_exe: "gjs", args: &[], note: None },
    LanguageDef { id: "quickjs", label: "JavaScript · QuickJS", windows_exe: "qjs", unix_exe: "qjs", args: &[], note: None },
    LanguageDef { id: "v8-shell", label: "JavaScript · V8 shell", windows_exe: "d8", unix_exe: "d8", args: &[], note: None },
    LanguageDef { id: "yaegi", label: "Go · Yaegi", windows_exe: "yaegi", unix_exe: "yaegi", args: &[], note: None },
    LanguageDef { id: "utop", label: "OCaml · UTop", windows_exe: "utop", unix_exe: "utop", args: &[], note: None },
    LanguageDef { id: "clisp", label: "Common Lisp · CLISP", windows_exe: "clisp", unix_exe: "clisp", args: &[], note: None },
    LanguageDef { id: "ecl", label: "Common Lisp · ECL", windows_exe: "ecl", unix_exe: "ecl", args: &[], note: None },
    LanguageDef { id: "mit-scheme", label: "Scheme · MIT", windows_exe: "mit-scheme", unix_exe: "mit-scheme", args: &[], note: None },
    LanguageDef { id: "sqlserver", label: "SQL Server · sqlcmd", windows_exe: "sqlcmd", unix_exe: "sqlcmd", args: &[], note: None },
    LanguageDef { id: "oracle-sql", label: "Oracle SQL · SQL*Plus", windows_exe: "sqlplus", unix_exe: "sqlplus", args: &[], note: None },
    LanguageDef { id: "neo4j", label: "Neo4j · Cypher", windows_exe: "cypher-shell", unix_exe: "cypher-shell", args: &[], note: None },
    LanguageDef { id: "cassandra", label: "Cassandra · CQL", windows_exe: "cqlsh", unix_exe: "cqlsh", args: &[], note: None },
    LanguageDef { id: "smalltalk", label: "Smalltalk · GNU", windows_exe: "gst", unix_exe: "gst", args: &[], note: None },
    LanguageDef { id: "purescript", label: "PureScript", windows_exe: "purs", unix_exe: "purs", args: &["repl"], note: None },
    LanguageDef { id: "gambit-scheme", label: "Scheme · Gambit", windows_exe: "gsi", unix_exe: "gsi", args: &[], note: None },
    LanguageDef { id: "gauche", label: "Scheme · Gauche", windows_exe: "gosh", unix_exe: "gosh", args: &[], note: None },
    LanguageDef { id: "chez-scheme", label: "Scheme · Chez", windows_exe: "chez", unix_exe: "chez", args: &[], note: None },
    LanguageDef { id: "chibi-scheme", label: "Scheme · Chibi", windows_exe: "chibi-scheme", unix_exe: "chibi-scheme", args: &[], note: None },
    LanguageDef { id: "supercollider", label: "SuperCollider · sclang", windows_exe: "sclang", unix_exe: "sclang", args: &[], note: None },
    LanguageDef { id: "nix-repl", label: "Nix", windows_exe: "nix", unix_exe: "nix", args: &["repl"], note: Some("El REPL de Nix requiere el gestor de paquetes Nix.") },
    LanguageDef { id: "postscript", label: "PostScript · Ghostscript", windows_exe: "gswin64c", unix_exe: "gs", args: &["-q"], note: Some("Ghostscript es un intérprete de PostScript; escribe quit para salir.") },
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
    let mut detected: Vec<Environment> = LANGUAGE_DEFS
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
        .collect();
    for definition in CATALOG_DEFS.iter() {
        if detected
            .iter()
            .any(|env| env.language.as_deref() == Some(&definition.id))
        {
            continue;
        }
        let exe = if is_windows {
            &definition.windows_exe
        } else {
            &definition.unix_exe
        };
        if exe.is_empty() || !(probe.is_installed)(exe) {
            continue;
        }
        detected.push(Environment {
            id: format!("lang:{}", definition.id),
            label: format!("{} · REPL", definition.label),
            // La categoría sirve para ordenar/documentar el catálogo, no para
            // fragmentar el selector en muchos encabezados de un solo REPL.
            group: LANGUAGE_GROUP.to_string(),
            kind: ShellKind::Repl,
            transport: Transport::Native,
            exe: (probe.resolve_path)(exe).unwrap_or_else(|| exe.clone()),
            args: definition.args.clone(),
            note: definition.note.clone(),
            repl: true,
            language: Some(definition.id.clone()),
            ..Default::default()
        });
    }
    for definition in crate::config::plugins::enabled_technologies() {
        if detected
            .iter()
            .any(|env| env.language.as_deref() == Some(&definition.id))
        {
            continue;
        }
        let exe = if is_windows {
            &definition.windows_exe
        } else {
            &definition.unix_exe
        };
        if exe.is_empty() || !(probe.is_installed)(exe) {
            continue;
        }
        detected.push(Environment {
            id: format!("plugin:lang:{}", definition.id),
            label: format!("{} · REPL", definition.label),
            group: LANGUAGE_GROUP.to_string(),
            kind: ShellKind::Repl,
            transport: Transport::Native,
            exe: (probe.resolve_path)(exe).unwrap_or_else(|| exe.clone()),
            args: definition.args,
            note: definition.note,
            repl: true,
            language: Some(definition.id),
            ..Default::default()
        });
    }
    detected
}

/// Ejecutables Unix que puede ofrecer una distro WSL. Se deriva del mismo
/// catálogo que usa Linux para no mantener una lista paralela solo para WSL.
pub fn unix_language_executables() -> Vec<String> {
    let mut executables: Vec<String> = LANGUAGE_DEFS
        .iter()
        .map(|definition| definition.unix_exe.to_string())
        .chain(
            CATALOG_DEFS
                .iter()
                .map(|definition| definition.unix_exe.clone()),
        )
        .chain(
            crate::config::plugins::enabled_technologies()
                .into_iter()
                .map(|definition| definition.unix_exe),
        )
        .filter(|executable| !executable.is_empty())
        .collect();
    executables.sort_unstable();
    executables.dedup();
    executables
}

/// Detecta los mismos REPL que Linux, pero lanzándolos a través de `wsl.exe`.
/// `installed` procede de una única sonda de la distro; no se arranca un
/// proceso por cada lenguaje.
pub fn detect_wsl_language_environments(distro: &str, installed: &[String]) -> Vec<Environment> {
    let is_installed = |exe: &str| installed.iter().any(|candidate| candidate == exe);
    let mut detected = Vec::new();

    let mut push = |id: &str, label: &str, exe: &str, args: &[String], note: Option<&str>| {
        if !is_installed(exe) {
            return;
        }
        let mut command_args = vec!["-d".to_string(), distro.to_string(), "--".to_string()];
        command_args.push(exe.to_string());
        command_args.extend(args.iter().cloned());
        detected.push(Environment {
            id: format!("wsl:{distro}:lang:{id}"),
            label: format!("WSL {distro} · {label} · REPL"),
            group: LANGUAGE_GROUP.to_string(),
            kind: ShellKind::Repl,
            transport: Transport::Wsl,
            distro: Some(distro.to_string()),
            exe: "wsl.exe".to_string(),
            args: command_args,
            note: note.map(str::to_string),
            repl: true,
            language: Some(id.to_string()),
            ..Default::default()
        });
    };

    for definition in LANGUAGE_DEFS {
        let args: Vec<String> = definition
            .args
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        push(
            definition.id,
            definition.label,
            definition.unix_exe,
            &args,
            definition.note,
        );
    }
    for definition in CATALOG_DEFS.iter() {
        push(
            &definition.id,
            &definition.label,
            &definition.unix_exe,
            &definition.args,
            definition.note.as_deref(),
        );
    }
    for definition in crate::config::plugins::enabled_technologies() {
        let id = format!("plugin:{}", definition.id);
        push(
            &id,
            &definition.label,
            &definition.unix_exe,
            &definition.args,
            definition.note.as_deref(),
        );
    }
    detected
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
    fn scala_usa_el_launcher_real_de_arch_y_el_de_windows() {
        let (is_installed, resolve_path) = probe_with(&["scala3"]);
        let linux = detect_language_environments(
            "linux",
            &Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
        );
        assert_eq!(
            linux
                .iter()
                .find(|env| env.language.as_deref() == Some("scala"))
                .map(|env| env.exe.as_str()),
            Some("/usr/bin/scala3")
        );

        let (is_installed, resolve_path) = probe_with(&["scala"]);
        let windows = detect_language_environments(
            "windows",
            &Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
        );
        assert_eq!(
            windows
                .iter()
                .find(|env| env.language.as_deref() == Some("scala"))
                .map(|env| env.exe.as_str()),
            Some("/usr/bin/scala")
        );
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
    fn wsl_reutiliza_el_catalogo_linux_y_conserva_el_comando_completo() {
        let envs = detect_wsl_language_environments("Ubuntu", &["python3".to_string()]);
        let python = envs
            .iter()
            .find(|env| env.language.as_deref() == Some("python"))
            .expect("Python debe detectarse dentro de WSL");
        assert_eq!(python.transport, Transport::Wsl);
        assert_eq!(python.exe, "wsl.exe");
        assert_eq!(python.args, vec!["-d", "Ubuntu", "--", "python3"]);
        assert_eq!(python.id, "wsl:Ubuntu:lang:python");
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
    fn el_catalogo_modular_es_valido_y_no_repite_ids() {
        assert!(!CATALOG_DEFS.is_empty());
        let mut ids: Vec<&str> = CATALOG_DEFS.iter().map(|entry| entry.id.as_str()).collect();
        assert!(CATALOG_DEFS.iter().all(|entry| {
            !entry.id.is_empty()
                && !entry.label.is_empty()
                && !entry._category.is_empty()
                && !entry.windows_exe.is_empty()
                && !entry.unix_exe.is_empty()
        }));
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn el_catalogo_modular_respeta_ejecutables_por_plataforma() {
        let installed = |exe: &str| exe == "gs" || exe == "gswin64c";
        let resolve = |exe: &str| Some(format!("/bin/{exe}"));
        let probe = Probe {
            is_installed: &installed,
            resolve_path: &resolve,
        };
        let linux = detect_language_environments("linux", &probe);
        let windows = detect_language_environments("windows", &probe);
        assert_eq!(
            linux
                .iter()
                .find(|env| env.id == "lang:postscript")
                .unwrap()
                .exe,
            "/bin/gs"
        );
        assert_eq!(
            windows
                .iter()
                .find(|env| env.id == "lang:postscript")
                .unwrap()
                .exe,
            "/bin/gswin64c"
        );
    }

    #[test]
    fn todos_los_lenguajes_declarados_tienen_candidato_nativo_para_windows() {
        assert!(LANGUAGE_DEFS
            .iter()
            .all(|definition| { !definition.windows_exe.is_empty() }));
        assert!(CATALOG_DEFS
            .iter()
            .all(|definition| !definition.windows_exe.is_empty()));
        // 82 definiciones base + 28 del catálogo modular; los plugins pueden
        // ampliar esta cifra sin alterar la garantía de compatibilidad base.
        assert!(LANGUAGE_DEFS.len() + CATALOG_DEFS.len() >= 100);
    }

    #[test]
    fn el_catalogo_modular_no_fragmenta_el_selector_por_categoria() {
        let installed = |exe: &str| matches!(exe, "gs" | "clisp" | "cypher-shell");
        let resolve = |exe: &str| Some(format!("/bin/{exe}"));
        let envs = detect_language_environments(
            "linux",
            &Probe {
                is_installed: &installed,
                resolve_path: &resolve,
            },
        );
        assert!(envs.len() >= 3);
        assert!(envs.iter().all(|env| env.group == LANGUAGE_GROUP));
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
