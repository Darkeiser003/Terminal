//! Lanzador de scripts: qué archivos reconoce, cómo los busca y con qué
//! comando los lanza en cada shell.
//!
//! Port de `electron/main/scriptLauncher.js`, repartido en tres piezas porque
//! son tres responsabilidades distintas: el catálogo de tipos, el recorrido del
//! disco y la construcción del comando.

pub mod launch;
pub mod pins;
pub mod scan;
pub mod types;

pub use launch::{
    build_cd_command, build_launch_command, environment_kinds_for_script, resolve_script_aliases,
    LaunchContext,
};
pub use scan::{
    list_all_scripts, list_scripts, normalize_here_depth, nsudo_available, ScanOptions, ScanResult,
    Scope, ScriptEntry, DEFAULT_HERE_DEPTH, MAX_HERE_DEPTH, MAX_HERE_SCRIPTS, MIN_HERE_DEPTH,
    NSUDO_PATH,
};
pub use types::{normalize_categories, FileCategory, ScriptType, FILE_FILTERS};
