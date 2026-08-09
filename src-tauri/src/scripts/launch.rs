//! Construye el comando que lanza un script desde el entorno activo.
//!
//! Port de `buildLaunchCommand`, `buildCdCommand`, `environmentKindsForScript`
//! y `resolveScriptAliases` de `electron/main/scriptLauncher.js`.
//!
//! El comando resultante SIEMPRE se escribe en la terminal visible (igual que
//! el resto de acciones de la app): nunca se ejecuta nada oculto ni con
//! permisos elevados a espaldas del usuario.

use std::collections::HashMap;

use crate::environments::{ShellKind, Transport};
use crate::shell_paths::{to_msys_path, unix_path_for};

use super::scan::ScriptEntry;
use super::types::ScriptType;

/// Contexto de la pestaña desde la que se lanza.
#[derive(Debug, Clone, Default)]
pub struct LaunchContext {
    pub transport: Option<Transport>,
    /// Los dos extremos de la carpeta que Docker monta: qué se ve desde el host
    /// y en qué punto del contenedor aparece.
    pub host_root: Option<String>,
    pub container_root: Option<String>,
    /// El sistema donde corre la APLICACIÓN. `None` es el de la compilación,
    /// que es lo que quiere producción.
    ///
    /// Se puede fijar porque `cfg!(windows)` se resuelve al compilar: sin esto,
    /// el comportamiento de LTerminal solo se puede comprobar compilando en
    /// Linux, y justamente los casos que se equivocaban —un `.vbs` o un `.exe`
    /// ofrecidos donde no existe con qué abrirlos— son los del otro sistema.
    pub windows_host: Option<bool>,
}

impl LaunchContext {
    fn transport(&self) -> Transport {
        self.transport.unwrap_or(Transport::Native)
    }

    fn is_docker(&self) -> bool {
        self.transport() == Transport::Docker
    }

    fn is_wsl(&self) -> bool {
        self.transport() == Transport::Wsl
    }

    fn on_windows_host(&self) -> bool {
        self.windows_host.unwrap_or(cfg!(windows))
    }
}

fn is_windows_family(kind: ShellKind) -> bool {
    matches!(kind, ShellKind::Cmd | ShellKind::Powershell)
}

/// Comillas al estilo Windows (cmd/PowerShell): dobles. El carácter `"` no
/// puede aparecer en un nombre de archivo de Windows, así que este escapado es
/// solo defensa en profundidad, nunca debería activarse en la práctica.
fn q_win(path: &str) -> String {
    format!("\"{}\"", path.replace('"', "\"\""))
}

/// Cadena literal de PowerShell entre comillas simples (sin expansión de
/// variables ni subexpresiones): la forma más segura de pasar una ruta como
/// argumento de un cmdlet como `Start-Process`.
fn q_ps(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
}

/// Comillas al estilo POSIX (bash/zsh/sh/fish/WSL): simples, que neutralizan
/// cualquier metacaracter de shell salvo una comilla simple literal (rara en
/// nombres de archivo reales). Es componible: escapar dos veces (para anidar
/// dentro de otra cadena de comillas simples) sigue produciendo algo válido.
fn q_unix(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn is_windows_path(value: &str) -> bool {
    if value.starts_with("\\\\") {
        return true;
    }
    let mut chars = value.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), Some('\\' | '/')) if letter.is_ascii_alphabetic()
    )
}

/// Trocea una cadena de argumentos respetando las comillas dobles, para poder
/// pasarlos uno a uno en `-ArgumentList` (donde una sola cadena con espacios
/// llegaría al script como un único argumento). Fuera de ahí los argumentos se
/// anexan tal cual: el comando se ve en la terminal antes de ejecutarse, así
/// que el usuario controla lo que se manda.
fn split_args(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in raw.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
                if !in_quotes {
                    out.push(std::mem::take(&mut current));
                }
            }
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Los argumentos ya entrecomillados al estilo de PowerShell, listos para
/// encadenarse detrás de la ruta del script en `-ArgumentList`.
fn ps_arg_list(args: &str) -> String {
    split_args(args)
        .into_iter()
        .map(|arg| format!(",{}", q_ps(arg.trim_matches('"'))))
        .collect()
}

/// Relativiza una ruta contra una raíz, con las convenciones del sistema al
/// que pertenezca la raíz. Devuelve `None` si la ruta se sale de la raíz.
fn relative_inside(root: &str, target: &str) -> Option<String> {
    let windows = is_windows_path(root) || is_windows_path(target);
    let normalize = |value: &str| {
        let replaced = if windows {
            value.replace('/', "\\")
        } else {
            value.to_string()
        };
        let trimmed = replaced.trim_end_matches(if windows { '\\' } else { '/' });
        if windows {
            trimmed.to_lowercase()
        } else {
            trimmed.to_string()
        }
    };
    let root_key = normalize(root);
    let target_key = normalize(target);
    if target_key == root_key {
        return Some(String::new());
    }
    let separator = if windows { '\\' } else { '/' };
    let prefix = format!("{root_key}{separator}");
    let rest_start = target_key.strip_prefix(&prefix)?.len();
    let original = if windows {
        target.replace('/', "\\")
    } else {
        target.to_string()
    };
    let trimmed = original.trim_end_matches(separator);
    Some(trimmed[trimmed.len() - rest_start..].to_string())
}

/// En los entornos Docker creados por la app, `/workspace` representa una
/// carpeta concreta del host. Los scripts se validan y se descubren desde el
/// host, pero dentro del contenedor deben ejecutarse con su ruta montada.
fn path_for_execution(raw_path: &str, context: &LaunchContext) -> String {
    if !context.is_docker() {
        return raw_path.to_string();
    }
    let (Some(host_root), Some(container_root)) = (
        context.host_root.as_deref(),
        context.container_root.as_deref(),
    ) else {
        return raw_path.to_string();
    };
    match relative_inside(host_root, raw_path) {
        Some(relative) if relative.is_empty() => container_root.to_string(),
        Some(relative) => format!(
            "{}/{}",
            container_root.trim_end_matches('/'),
            relative.replace('\\', "/")
        ),
        None => raw_path.to_string(),
    }
}

struct Names {
    /// Cómo se invoca PowerShell desde esta shell.
    powershell: String,
    /// Cómo se invoca cmd.exe desde esta shell.
    cmd: String,
}

/// Shells unix corriendo SOBRE Windows (Git Bash/MSYS, o WSL con
/// interoperabilidad): pueden invocar binarios de Windows, pero WSL exige el
/// sufijo `.exe` explícito para distinguirlos de comandos Linux.
fn binary_names(kind: ShellKind, context: &LaunchContext, on_windows_host: bool) -> Names {
    let exe_suffix = if context.is_wsl() { ".exe" } else { "" };
    let powershell = if on_windows_host {
        if is_windows_family(kind) {
            "powershell".to_string()
        } else {
            format!("powershell{exe_suffix}")
        }
    } else {
        "pwsh".to_string()
    };
    let cmd = if kind == ShellKind::Cmd {
        "cmd".to_string()
    } else if exe_suffix.is_empty() {
        "cmd.exe".to_string()
    } else {
        format!("cmd{exe_suffix}")
    };
    Names { powershell, cmd }
}

/// Envuelve un comando de PowerShell (que solo debe usar comillas simples,
/// nunca dobles) para poder escribirlo desde cmd/bash/WSL vía
/// `powershell -Command "..."` sin que las comillas choquen entre sí.
fn elevate_via_powershell(kind: ShellKind, names: &Names, inner: &str) -> String {
    if kind == ShellKind::Powershell {
        inner.to_string()
    } else {
        format!("{} -Command \"{inner}\"", names.powershell)
    }
}

/// El comando a escribir en la terminal para lanzar `script` desde una shell de
/// tipo `kind`, con la opción de pedir elevación a administrador.
///
/// Devuelve `None` cuando ese script no se puede lanzar desde ahí: un `.ps1` o
/// un `.exe` dentro de un contenedor Linux, por ejemplo.
pub fn build_launch_command(
    script: &ScriptEntry,
    kind: ShellKind,
    as_admin: bool,
    raw_args: &str,
    context: &LaunchContext,
) -> Option<String> {
    let on_windows_host = context.on_windows_host();
    // Ojo: esto es la FAMILIA DE SINTAXIS de la shell (comillas dobles, `&`,
    // `Start-Process`), no el sistema. En Linux se puede abrir una pestaña de
    // pwsh, y ahí la sintaxis es de PowerShell pero los binarios son los de
    // Linux. Confundir las dos cosas es lo que hacía que en LTerminal, dentro
    // de pwsh, un `.py` se lanzara con `python` en vez de `python3`.
    let windows_side = is_windows_family(kind);
    let args = raw_args.trim();
    let suffix = if args.is_empty() {
        String::new()
    } else {
        format!(" {args}")
    };
    let ps_args = ps_arg_list(args);
    let names = binary_names(kind, context, on_windows_host);
    let script_path = path_for_execution(&script.path, context);
    let transport = context.transport();

    match script.kind {
        ScriptType::Powershell => {
            if context.is_docker() {
                return None;
            }
            if as_admin {
                if !on_windows_host {
                    return Some(format!(
                        "sudo {} -NoProfile -File {}{suffix}",
                        names.powershell,
                        q_unix(&script_path)
                    ));
                }
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',{}{ps_args}",
                        q_ps(&script_path)
                    ),
                ));
            }
            Some(format!(
                "{} -NoProfile -ExecutionPolicy Bypass -File {}{suffix}",
                names.powershell,
                q_win(&script_path)
            ))
        }

        ScriptType::Batch => {
            if context.is_docker() {
                return None;
            }
            // Igual que el VBS: `cmd.exe` no existe en Linux ni en macOS, pero
            // el `cmd` de Wine sí, y es lo que el panel ofrece instalar.
            if !on_windows_host {
                let path = q_unix(&unix_path_for(&script_path, transport));
                return Some(format!("wine cmd /c \"$(winepath -w {path})\"{suffix}"));
            }
            if as_admin {
                let arg_list = if ps_args.is_empty() {
                    String::new()
                } else {
                    format!(" -ArgumentList {}", &ps_args[1..])
                };
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process -FilePath {}{arg_list} -Verb RunAs",
                        q_ps(&script_path)
                    ),
                ));
            }
            match kind {
                ShellKind::Powershell => Some(format!("& {}{suffix}", q_win(&script_path))),
                ShellKind::Cmd => Some(format!("call {}{suffix}", q_win(&script_path))),
                // bash/zsh/fish/WSL: "call" es un builtin de cmd.exe, ahí no
                // existe. Hay que delegar el .bat al propio cmd.exe (accesible
                // desde Git Bash y desde WSL vía interop), con la ruta en
                // formato Windows.
                _ => Some(format!("{} /c {}{suffix}", names.cmd, q_win(&script_path))),
            }
        }

        ScriptType::Vbscript => {
            if context.is_docker() {
                return None;
            }
            // Fuera de Windows no hay `wscript.exe`. Lo que sí puede haberlo es
            // Wine, que es justo lo que el panel de dependencias ofrece en
            // Linux bajo «Compatibilidad Windows · Wine · cmd.exe y VBS». La
            // ruta se convierte con `winepath`, que viene con Wine: su
            // `wscript` espera una ruta de Windows, no la de Linux.
            if !on_windows_host {
                let path = q_unix(&unix_path_for(&script_path, transport));
                return Some(format!("wine wscript \"$(winepath -w {path})\"{suffix}"));
            }
            // wscript.exe es el host de VBS sin consola (a diferencia de
            // cscript.exe). La ruta se mantiene en formato Windows aunque la
            // shell activa sea Git Bash/WSL: wscript.exe es un binario de
            // Windows y espera una ruta de Windows, no una traducida.
            if as_admin {
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process wscript.exe -ArgumentList {}{ps_args} -Verb RunAs",
                        q_ps(&script_path)
                    ),
                ));
            }
            Some(format!("wscript.exe {}{suffix}", q_win(&script_path)))
        }

        ScriptType::Shell | ScriptType::Fish => {
            const ALLOWED: [&str; 5] = ["sh", "bash", "zsh", "ksh", "fish"];
            let interpreter = script.interpreter.as_deref().unwrap_or("");
            let bin = if ALLOWED.contains(&interpreter) {
                interpreter
            } else if script.kind == ScriptType::Fish {
                "fish"
            } else {
                "bash"
            };
            // Desde cmd/PowerShell se delega explícitamente al intérprete; no
            // se pueden usar chmod, comillas POSIX ni ejecutar el .sh
            // directamente.
            if windows_side {
                let translated = to_msys_path(&script_path);
                if !as_admin {
                    return Some(format!("{bin} {}{suffix}", q_win(&translated)));
                }
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process {bin} -ArgumentList {}{ps_args} -Verb RunAs",
                        q_ps(&translated)
                    ),
                ));
            }
            let run = format!(
                "{bin} {}{suffix}",
                q_unix(&unix_path_for(&script_path, transport))
            );
            Some(if as_admin { format!("sudo {run}") } else { run })
        }

        ScriptType::Java => {
            if windows_side {
                if !as_admin {
                    return Some(format!("java -jar {}{suffix}", q_win(&script_path)));
                }
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process java -ArgumentList '-jar',{}{ps_args} -Verb RunAs",
                        q_ps(&script_path)
                    ),
                ));
            }
            let run = format!(
                "java -jar {}{suffix}",
                q_unix(&unix_path_for(&script_path, transport))
            );
            Some(if as_admin { format!("sudo {run}") } else { run })
        }

        ScriptType::Program => {
            let ext = script.ext.to_lowercase();
            let windows_program = ext == ".exe" || ext == ".com";
            if context.is_docker() && windows_program {
                return None;
            }
            if on_windows_host && ext == ".appimage" && !context.is_wsl() && !context.is_docker() {
                return None;
            }
            if windows_program && on_windows_host && as_admin {
                let arg_list = if ps_args.is_empty() {
                    String::new()
                } else {
                    format!(" -ArgumentList {}", &ps_args[1..])
                };
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process -FilePath {}{arg_list} -Verb RunAs",
                        q_ps(&script_path)
                    ),
                ));
            }
            // Solo en una shell de Windows SOBRE Windows: una pestaña de pwsh
            // en Linux tiene sintaxis de PowerShell, pero ahí un `.exe` no se
            // lanza escribiendo su ruta.
            if windows_side && on_windows_host {
                return Some(if kind == ShellKind::Powershell {
                    format!("& {}{suffix}", q_win(&script_path))
                } else {
                    format!("{}{suffix}", q_win(&script_path))
                });
            }
            let path = q_unix(&unix_path_for(&script_path, transport));
            // Un `.exe` en un host que no es Windows no se ejecuta solo: sin
            // esto se escribía la ruta a pelo y la shell respondía «cannot
            // execute binary file».
            if windows_program {
                let run = format!("wine {path}{suffix}");
                return Some(if as_admin { format!("sudo {run}") } else { run });
            }
            if ext == ".appimage" {
                // Un AppImage recién descargado no suele traer permiso de
                // ejecución; darlo forma parte de lanzarlo.
                return Some(if as_admin {
                    format!("chmod +x -- {path} && sudo {path}{suffix}")
                } else {
                    format!("chmod +x -- {path} && {path}{suffix}")
                });
            }
            let run = format!("{path}{suffix}");
            Some(if as_admin { format!("sudo {run}") } else { run })
        }

        // Los intérpretes de runtime: python, node, ruby, php, perl, lua, R y
        // groovy.
        kind_of_runtime => {
            let bin = match kind_of_runtime {
                ScriptType::Python => "python",
                ScriptType::Node => "node",
                ScriptType::Ruby => "ruby",
                ScriptType::Php => "php",
                ScriptType::Perl => "perl",
                ScriptType::Lua => "lua",
                ScriptType::Rscript => "Rscript",
                ScriptType::Groovy => "groovy",
                // Los recursos (html, imagen, audio, vídeo) no se lanzan: se
                // abren con la aplicación del sistema.
                _ => return None,
            };
            // En Linux y macOS el binario es `python3`: `python` a secas no
            // existe en Debian ni en Fedora desde hace años. Se decide por el
            // SISTEMA, no por la shell, porque una pestaña de pwsh en LTerminal
            // caía por la rama de Windows y proponía `python`.
            let use_windows_python = on_windows_host && !context.is_wsl() && !context.is_docker();
            let bin = if bin == "python" && !use_windows_python {
                "python3"
            } else {
                bin
            };
            if windows_side && on_windows_host {
                if !as_admin {
                    return Some(format!("{bin} {}{suffix}", q_win(&script_path)));
                }
                return Some(elevate_via_powershell(
                    kind,
                    &names,
                    &format!(
                        "Start-Process {bin} -ArgumentList {}{ps_args} -Verb RunAs",
                        q_ps(&script_path)
                    ),
                ));
            }
            let path = q_unix(&unix_path_for(&script_path, transport));
            Some(if as_admin {
                format!("sudo {bin} {path}{suffix}")
            } else {
                format!("{bin} {path}{suffix}")
            })
        }
    }
}

/// Cambia la pestaña activa a una carpeta. La ruta se traduce con las mismas
/// reglas que los scripts (WSL, Git Bash y Docker).
///
/// Con `is_directory` en falso, `target` es un ARCHIVO y se navega a la carpeta
/// que lo contiene.
pub fn build_cd_command(
    target: &str,
    kind: ShellKind,
    is_directory: bool,
    context: &LaunchContext,
) -> Option<String> {
    let mut dir = if is_directory {
        target.to_string()
    } else {
        parent_of(target)
    };

    if context.is_docker() {
        let (host_root, container_root) = (
            context.host_root.as_deref()?,
            context.container_root.as_deref()?,
        );
        let relative = relative_inside(host_root, &dir)?;
        dir = if relative.is_empty() {
            container_root.to_string()
        } else {
            format!(
                "{}/{}",
                container_root.trim_end_matches('/'),
                relative.replace('\\', "/")
            )
        };
    }

    match kind {
        ShellKind::Cmd => Some(format!("cd /d {}", q_win(&dir))),
        ShellKind::Powershell => Some(format!("Set-Location -LiteralPath {}", q_ps(&dir))),
        _ => Some(format!(
            "cd {}",
            q_unix(&unix_path_for(&dir, context.transport()))
        )),
    }
}

fn parent_of(target: &str) -> String {
    let separator = if is_windows_path(target) { '\\' } else { '/' };
    let trimmed = target.trim_end_matches(separator);
    match trimmed.rfind(separator) {
        Some(0) => separator.to_string(),
        Some(index) => trimmed[..index].to_string(),
        None => trimmed.to_string(),
    }
}

/// Con qué shells conviene abrir (o reutilizar una pestaña) para ejecutar este
/// script. Los runtimes como Python/Node se quedan en la terminal actual: no
/// son shells interactivas de la app.
pub fn environment_kinds_for_script(script: &ScriptEntry) -> Vec<ShellKind> {
    match script.kind {
        ScriptType::Powershell => vec![ShellKind::Powershell],
        ScriptType::Batch | ScriptType::Vbscript => vec![ShellKind::Cmd, ShellKind::Powershell],
        ScriptType::Fish => vec![ShellKind::Fish],
        ScriptType::Shell => match script.interpreter.as_deref().unwrap_or("bash") {
            "zsh" => vec![ShellKind::Zsh],
            // ksh no es una familia propia en el selector: cae a bash y sh.
            "ksh" => vec![ShellKind::Bash, ShellKind::Sh],
            "sh" => vec![ShellKind::Sh, ShellKind::Bash, ShellKind::Zsh],
            _ => vec![ShellKind::Bash, ShellKind::Sh, ShellKind::Zsh],
        },
        ScriptType::Program => match script.ext.to_lowercase().as_str() {
            ".exe" | ".com" => vec![ShellKind::Cmd, ShellKind::Powershell],
            ".appimage" => vec![ShellKind::Bash, ShellKind::Sh, ShellKind::Zsh],
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn sanitize_alias_name(raw: &str) -> String {
    let mut name: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        name.insert(0, '_');
    }
    name
}

/// Tipo de script "nativo" por familia de shell, usado para desempatar cuando
/// dos scripts distintos generarían el mismo nombre de alias (p. ej.
/// `deploy.ps1` y `deploy.sh`): gana el que coincide con la shell activa.
fn native_type_for(kind: ShellKind) -> Option<ScriptType> {
    match kind {
        ShellKind::Cmd => Some(ScriptType::Batch),
        ShellKind::Powershell => Some(ScriptType::Powershell),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => Some(ScriptType::Shell),
        ShellKind::Fish => Some(ScriptType::Fish),
        ShellKind::Repl | ShellKind::Android => None,
    }
}

/// Agrupa los scripts por su nombre de alias (nombre de archivo sin ruta ni
/// extensión, saneado a caracteres válidos) y resuelve las colisiones
/// prefiriendo el tipo nativo de `kind`.
pub fn resolve_script_aliases(
    scripts: &[ScriptEntry],
    kind: ShellKind,
) -> Vec<(String, &ScriptEntry)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&ScriptEntry>> = HashMap::new();

    for script in scripts {
        let base = script
            .name
            .strip_suffix(&script.ext)
            .unwrap_or(&script.name);
        let alias = sanitize_alias_name(base);
        if alias.is_empty() {
            continue;
        }
        if !groups.contains_key(&alias) {
            order.push(alias.clone());
        }
        groups.entry(alias).or_default().push(script);
    }

    let native = native_type_for(kind);
    order
        .into_iter()
        .filter_map(|alias| {
            let candidates = groups.get(&alias)?;
            let chosen = match native {
                Some(native) if candidates.len() > 1 => candidates
                    .iter()
                    .find(|script| script.kind == native)
                    .copied()
                    .unwrap_or(candidates[0]),
                _ => candidates[0],
            };
            Some((alias, chosen))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripts::types::FileCategory;

    fn script(name: &str, kind: ScriptType, path: &str) -> ScriptEntry {
        let ext = name
            .rfind('.')
            .map(|i| name[i..].to_string())
            .unwrap_or_default();
        ScriptEntry {
            name: name.to_string(),
            ext,
            kind,
            category: kind.category(),
            interpreter: None,
            runnable: kind.runnable(),
            openable: kind.openable(),
            instruction: kind.instruction(),
            path: path.to_string(),
            rel_dir: String::new(),
            source: "scripts".into(),
            hint: None,
        }
    }

    fn native() -> LaunchContext {
        LaunchContext::default()
    }

    /// LTerminal: la app corriendo en Linux o macOS. Fijar el host permite
    /// comprobar aquí lo que si no habría que compilar en Linux para ver.
    fn lterminal() -> LaunchContext {
        LaunchContext {
            windows_host: Some(false),
            ..Default::default()
        }
    }

    /// WinSlim Terminal: la app corriendo en Windows.
    fn winslim() -> LaunchContext {
        LaunchContext {
            windows_host: Some(true),
            ..Default::default()
        }
    }

    // ---- Cada sistema con lo suyo ----

    /// En LTerminal un `.vbs` o un `.bat` no se lanzan con `wscript.exe` ni con
    /// `cmd.exe`: ahí no existen. Se pasan por Wine, que es lo que el panel de
    /// dependencias ofrece instalar bajo «Compatibilidad Windows».
    #[test]
    fn en_lterminal_los_scripts_de_windows_van_por_wine() {
        let vbs = script("a.vbs", ScriptType::Vbscript, "/home/ana/a.vbs");
        let cmd = build_launch_command(&vbs, ShellKind::Bash, false, "", &lterminal()).unwrap();
        assert!(cmd.starts_with("wine wscript "), "{cmd}");
        assert!(!cmd.contains("wscript.exe"), "{cmd}");

        let bat = script("a.bat", ScriptType::Batch, "/home/ana/a.bat");
        let cmd = build_launch_command(&bat, ShellKind::Bash, false, "", &lterminal()).unwrap();
        assert!(cmd.starts_with("wine cmd /c "), "{cmd}");
        assert!(!cmd.contains("cmd.exe"), "{cmd}");

        let exe = script("app.exe", ScriptType::Program, "/home/ana/app.exe");
        let cmd = build_launch_command(&exe, ShellKind::Bash, false, "", &lterminal()).unwrap();
        assert_eq!(cmd, "wine '/home/ana/app.exe'");
    }

    /// Y en Windows siguen yendo con lo del sistema, sin rastro de Wine.
    #[test]
    fn en_winslim_los_scripts_de_windows_van_con_lo_del_sistema() {
        let vbs = script("a.vbs", ScriptType::Vbscript, "C:\\s\\a.vbs");
        let cmd = build_launch_command(&vbs, ShellKind::Cmd, false, "", &winslim()).unwrap();
        assert!(cmd.starts_with("wscript.exe "), "{cmd}");
        assert!(!cmd.contains("wine"), "{cmd}");

        let exe = script("app.exe", ScriptType::Program, "C:\\s\\app.exe");
        let cmd = build_launch_command(&exe, ShellKind::Cmd, false, "", &winslim()).unwrap();
        assert!(!cmd.contains("wine"), "{cmd}");
    }

    /// Una pestaña de pwsh en Linux tiene sintaxis de PowerShell pero binarios
    /// de Linux. Antes caía por la rama de Windows y proponía `python`, que en
    /// Debian y Fedora no existe desde hace años.
    #[test]
    fn en_lterminal_pwsh_usa_los_binarios_de_linux() {
        let py = script("a.py", ScriptType::Python, "/home/ana/a.py");
        let cmd =
            build_launch_command(&py, ShellKind::Powershell, false, "", &lterminal()).unwrap();
        assert!(cmd.starts_with("python3 "), "{cmd}");

        let exe = script("app.exe", ScriptType::Program, "/home/ana/app.exe");
        let cmd =
            build_launch_command(&exe, ShellKind::Powershell, false, "", &lterminal()).unwrap();
        assert!(cmd.starts_with("wine "), "{cmd}");
    }

    /// En Windows, Git Bash sigue usando el Python de Windows (`python`), que
    /// es el que instala el propio panel.
    #[test]
    fn en_winslim_git_bash_usa_el_python_de_windows() {
        let py = script("a.py", ScriptType::Python, "C:\\s\\a.py");
        let cmd = build_launch_command(&py, ShellKind::Bash, false, "", &winslim()).unwrap();
        assert!(cmd.starts_with("python "), "{cmd}");
        assert!(!cmd.starts_with("python3 "), "{cmd}");
    }

    // ---- Comillas ----

    #[test]
    fn cada_familia_entrecomilla_a_su_manera() {
        assert_eq!(
            q_win("C:\\Mis Scripts\\a.ps1"),
            "\"C:\\Mis Scripts\\a.ps1\""
        );
        assert_eq!(q_ps("no'obvio"), "'no''obvio'");
        assert_eq!(q_unix("no'obvio"), "'no'\\''obvio'");
    }

    // ---- PowerShell · solo Windows ----
    // Los .ps1 y la elevación con Start-Process son propios de Windows. En Linux
    // el equivalente es lanzar un .sh con bash y elevar con sudo.

    #[cfg(windows)]
    mod windows_only {
        use super::*;

        #[test]
        fn un_ps1_se_lanza_saltandose_la_politica_de_ejecucion() {
            let s = script("a.ps1", ScriptType::Powershell, "C:\\s\\a.ps1");
            let cmd =
                build_launch_command(&s, ShellKind::Powershell, false, "", &native()).unwrap();
            assert_eq!(
                cmd,
                "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\s\\a.ps1\""
            );
        }

        #[test]
        fn como_administrador_se_usa_start_process_con_runas() {
            let s = script("a.ps1", ScriptType::Powershell, "C:\\s\\a.ps1");
            let cmd = build_launch_command(&s, ShellKind::Powershell, true, "", &native()).unwrap();
            assert!(cmd.starts_with("Start-Process powershell -Verb RunAs"));
            assert!(cmd.contains("'C:\\s\\a.ps1'"));
        }

        #[test]
        fn desde_cmd_la_elevacion_se_envuelve_en_un_command() {
            let s = script("a.ps1", ScriptType::Powershell, "C:\\s\\a.ps1");
            let cmd = build_launch_command(&s, ShellKind::Cmd, true, "", &native()).unwrap();
            assert!(cmd.starts_with("powershell -Command \""));
            assert!(cmd.ends_with('"'));
        }

        #[test]
        fn un_bat_usa_call_en_cmd_y_el_operador_de_llamada_en_powershell() {
            let s = script("a.bat", ScriptType::Batch, "C:\\s\\a.bat");
            assert_eq!(
                build_launch_command(&s, ShellKind::Cmd, false, "", &native()).unwrap(),
                "call \"C:\\s\\a.bat\""
            );
            assert_eq!(
                build_launch_command(&s, ShellKind::Powershell, false, "", &native()).unwrap(),
                "& \"C:\\s\\a.bat\""
            );
        }

        #[test]
        fn desde_una_shell_unix_un_bat_se_delega_a_cmd_exe() {
            let s = script("a.bat", ScriptType::Batch, "C:\\s\\a.bat");
            let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &native()).unwrap();
            assert_eq!(cmd, "cmd.exe /c \"C:\\s\\a.bat\"");
        }

        #[test]
        fn dentro_de_wsl_los_binarios_de_windows_llevan_exe() {
            let s = script("a.bat", ScriptType::Batch, "C:\\s\\a.bat");
            let context = LaunchContext {
                transport: Some(Transport::Wsl),
                ..Default::default()
            };
            let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &context).unwrap();
            assert!(cmd.starts_with("cmd.exe /c "));
        }
    }

    // ---- Equivalentes Linux ----
    // Las mismas responsabilidades (lanzar script, elevar, wrapper de shell)
    // pero con las herramientas de Linux: bash, sudo y rutas POSIX.

    #[cfg(not(windows))]
    mod linux_equivalent {
        use super::*;

        #[test]
        fn un_sh_se_lanza_con_bash() {
            let s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
            let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &native()).unwrap();
            assert_eq!(cmd, "bash '/home/ana/a.sh'");
        }

        #[test]
        fn como_administrador_se_usa_sudo() {
            let s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
            let cmd = build_launch_command(&s, ShellKind::Bash, true, "", &native()).unwrap();
            assert_eq!(cmd, "sudo bash '/home/ana/a.sh'");
        }

        #[test]
        fn como_administrador_en_fish_se_usa_sudo() {
            let s = script("a.fish", ScriptType::Fish, "/home/ana/a.fish");
            let cmd = build_launch_command(&s, ShellKind::Fish, true, "", &native()).unwrap();
            assert_eq!(cmd, "sudo fish '/home/ana/a.fish'");
        }

        #[test]
        fn un_sh_desde_bash_y_desde_fish_usa_bash() {
            // Un .sh se lanza con bash tanto desde bash como desde fish: el
            // intérpreto lo marca el tipo de script, no la shell que lo invoca.
            let s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
            assert_eq!(
                build_launch_command(&s, ShellKind::Bash, false, "", &native()).unwrap(),
                "bash '/home/ana/a.sh'"
            );
            assert_eq!(
                build_launch_command(&s, ShellKind::Fish, false, "", &native()).unwrap(),
                "bash '/home/ana/a.sh'"
            );
        }

        #[test]
        fn en_ruta_unix_no_hay_exe_de_windows() {
            let s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
            let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &native()).unwrap();
            assert!(!cmd.contains("cmd.exe"), "{cmd}");
            assert!(cmd.contains("/home/ana/a.sh"), "{cmd}");
        }
    }

    // ---- Shell ----

    #[test]
    fn un_sh_usa_el_interprete_de_su_shebang() {
        let mut s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
        s.interpreter = Some("zsh".into());
        let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &native()).unwrap();
        assert!(cmd.starts_with("zsh '"));
    }

    #[test]
    fn un_interprete_desconocido_cae_a_bash() {
        let mut s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
        s.interpreter = Some("intruso; rm -rf /".into());
        let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &native()).unwrap();
        assert!(cmd.starts_with("bash '"), "{cmd}");
    }

    #[test]
    fn desde_cmd_un_sh_se_delega_al_interprete_con_ruta_msys() {
        let s = script("a.sh", ScriptType::Shell, "C:\\s\\a.sh");
        let cmd = build_launch_command(&s, ShellKind::Cmd, false, "", &native()).unwrap();
        assert_eq!(cmd, "bash \"/c/s/a.sh\"");
    }

    #[test]
    fn en_unix_la_elevacion_es_sudo() {
        let s = script("a.sh", ScriptType::Shell, "/home/ana/a.sh");
        let cmd = build_launch_command(&s, ShellKind::Bash, true, "", &native()).unwrap();
        assert!(cmd.starts_with("sudo bash '"));
    }

    // ---- Runtimes ----

    #[test]
    fn python_es_python3_en_wsl_y_python_en_git_bash() {
        let s = script("a.py", ScriptType::Python, "C:\\s\\a.py");
        let wsl = LaunchContext {
            transport: Some(Transport::Wsl),
            ..Default::default()
        };
        assert!(build_launch_command(&s, ShellKind::Bash, false, "", &wsl)
            .unwrap()
            .starts_with("python3 "));

        let msys = LaunchContext {
            transport: Some(Transport::Msys),
            ..Default::default()
        };
        let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &msys).unwrap();
        if cfg!(windows) {
            assert!(cmd.starts_with("python "), "{cmd}");
        } else {
            assert!(cmd.starts_with("python3 "), "{cmd}");
        }
    }

    #[test]
    fn los_argumentos_se_anexan_tal_cual() {
        let s = script("a.py", ScriptType::Python, "/s/a.py");
        let cmd =
            build_launch_command(&s, ShellKind::Bash, false, "  --verbose x  ", &native()).unwrap();
        assert!(cmd.ends_with(" --verbose x"));
    }

    #[test]
    fn en_argumentlist_cada_argumento_va_por_separado() {
        assert_eq!(ps_arg_list("uno dos"), ",'uno','dos'");
        // Lo entrecomillado cuenta como un solo argumento, y las comillas no
        // llegan a PowerShell.
        assert_eq!(
            ps_arg_list("\"con espacios\" otro"),
            ",'con espacios','otro'"
        );
        assert_eq!(ps_arg_list(""), "");
    }

    // ---- Docker ----

    #[test]
    fn en_un_contenedor_no_se_lanzan_scripts_de_windows() {
        let context = LaunchContext {
            transport: Some(Transport::Docker),
            windows_host: None,
            host_root: Some("C:\\Users\\Ana".into()),
            container_root: Some("/workspace".into()),
        };
        for kind in [
            ScriptType::Powershell,
            ScriptType::Batch,
            ScriptType::Vbscript,
        ] {
            let s = script("a.x", kind, "C:\\Users\\Ana\\a.x");
            assert_eq!(
                build_launch_command(&s, ShellKind::Bash, false, "", &context),
                None
            );
        }
    }

    #[test]
    fn en_un_contenedor_la_ruta_se_traduce_a_la_carpeta_montada() {
        let context = LaunchContext {
            transport: Some(Transport::Docker),
            windows_host: None,
            host_root: Some("C:\\Users\\Ana".into()),
            container_root: Some("/workspace".into()),
        };
        let s = script("a.sh", ScriptType::Shell, "C:\\Users\\Ana\\proyecto\\a.sh");
        let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &context).unwrap();
        assert_eq!(cmd, "bash '/workspace/proyecto/a.sh'");
    }

    #[test]
    fn una_ruta_fuera_de_la_carpeta_montada_no_se_traduce() {
        let context = LaunchContext {
            transport: Some(Transport::Docker),
            windows_host: None,
            host_root: Some("C:\\Users\\Ana".into()),
            container_root: Some("/workspace".into()),
        };
        assert_eq!(
            path_for_execution("C:\\Otra\\a.sh", &context),
            "C:\\Otra\\a.sh"
        );
    }

    // ---- Programas ----

    #[test]
    fn un_appimage_se_hace_ejecutable_antes_de_lanzarlo() {
        let s = script(
            "app.AppImage",
            ScriptType::Program,
            "/home/ana/app.AppImage",
        );
        // Dentro de WSL tiene sentido también desde un host Windows; en una
        // shell del propio Windows no, y ahí no se ofrece (ver el test
        // siguiente).
        let context = LaunchContext {
            transport: Some(Transport::Wsl),
            ..Default::default()
        };
        let cmd = build_launch_command(&s, ShellKind::Bash, false, "", &context).unwrap();
        assert!(cmd.starts_with("chmod +x -- '/home/ana/app.AppImage' && "));
    }

    #[test]
    fn un_appimage_no_se_ofrece_en_una_shell_del_propio_windows() {
        if !cfg!(windows) {
            return;
        }
        let s = script("app.AppImage", ScriptType::Program, "C:\\x\\app.AppImage");
        assert_eq!(
            build_launch_command(&s, ShellKind::Bash, false, "", &native()),
            None
        );
    }

    #[test]
    fn un_exe_no_se_ofrece_dentro_de_un_contenedor() {
        let context = LaunchContext {
            transport: Some(Transport::Docker),
            windows_host: None,
            host_root: Some("C:\\x".into()),
            container_root: Some("/workspace".into()),
        };
        let s = script("app.exe", ScriptType::Program, "C:\\x\\app.exe");
        assert_eq!(
            build_launch_command(&s, ShellKind::Bash, false, "", &context),
            None
        );
    }

    #[test]
    fn un_recurso_no_tiene_comando_de_lanzamiento() {
        let s = script("foto.png", ScriptType::Image, "/x/foto.png");
        assert_eq!(
            build_launch_command(&s, ShellKind::Bash, false, "", &native()),
            None
        );
    }

    // ---- cd ----

    #[test]
    fn cd_sobre_un_archivo_va_a_su_carpeta() {
        assert_eq!(
            build_cd_command("C:\\s\\a.ps1", ShellKind::Cmd, false, &native()).unwrap(),
            "cd /d \"C:\\s\""
        );
    }

    #[test]
    fn cd_sobre_una_carpeta_no_sube_un_nivel() {
        assert_eq!(
            build_cd_command("C:\\s\\sub", ShellKind::Cmd, true, &native()).unwrap(),
            "cd /d \"C:\\s\\sub\""
        );
    }

    #[test]
    fn cada_shell_tiene_su_forma_de_cambiar_de_carpeta() {
        assert!(
            build_cd_command("/home/ana/x.sh", ShellKind::Bash, false, &native())
                .unwrap()
                .starts_with("cd '")
        );
        assert!(
            build_cd_command("C:\\s\\a.ps1", ShellKind::Powershell, false, &native())
                .unwrap()
                .starts_with("Set-Location -LiteralPath ")
        );
    }

    // ---- Alias ----

    #[test]
    fn el_nombre_del_alias_se_sanea() {
        assert_eq!(sanitize_alias_name("mi script"), "mi_script");
        assert_eq!(sanitize_alias_name("2fast"), "_2fast");
        assert_eq!(sanitize_alias_name("ok-nombre_1"), "ok-nombre_1");
    }

    #[test]
    fn ante_una_colision_gana_el_tipo_nativo_de_la_shell() {
        let scripts = vec![
            script("deploy.sh", ScriptType::Shell, "/s/deploy.sh"),
            script("deploy.ps1", ScriptType::Powershell, "/s/deploy.ps1"),
        ];
        let en_powershell = resolve_script_aliases(&scripts, ShellKind::Powershell);
        assert_eq!(en_powershell.len(), 1);
        assert_eq!(en_powershell[0].0, "deploy");
        assert_eq!(en_powershell[0].1.kind, ScriptType::Powershell);

        let en_bash = resolve_script_aliases(&scripts, ShellKind::Bash);
        assert_eq!(en_bash[0].1.kind, ScriptType::Shell);
    }

    #[test]
    fn sin_colision_cada_script_conserva_su_nombre() {
        let scripts = vec![
            script("uno.sh", ScriptType::Shell, "/s/uno.sh"),
            script("dos.py", ScriptType::Python, "/s/dos.py"),
        ];
        let alias: Vec<String> = resolve_script_aliases(&scripts, ShellKind::Bash)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(alias, vec!["uno".to_string(), "dos".to_string()]);
    }

    // ---- Entornos preferidos ----

    #[test]
    fn cada_script_prefiere_las_shells_que_lo_entienden() {
        assert_eq!(
            environment_kinds_for_script(&script("a.ps1", ScriptType::Powershell, "/a.ps1")),
            vec![ShellKind::Powershell]
        );
        assert_eq!(
            environment_kinds_for_script(&script("a.bat", ScriptType::Batch, "/a.bat")),
            vec![ShellKind::Cmd, ShellKind::Powershell]
        );
        // Un runtime se queda donde esté: no necesita una shell concreta.
        assert!(
            environment_kinds_for_script(&script("a.py", ScriptType::Python, "/a.py")).is_empty()
        );
    }

    #[test]
    fn un_sh_prefiere_su_interprete_y_luego_los_compatibles() {
        let mut s = script("a.sh", ScriptType::Shell, "/a.sh");
        s.interpreter = Some("sh".into());
        assert_eq!(
            environment_kinds_for_script(&s),
            vec![ShellKind::Sh, ShellKind::Bash, ShellKind::Zsh]
        );
    }

    #[test]
    fn la_categoria_del_script_viaja_al_frontend() {
        let s = script("a.rb", ScriptType::Ruby, "/a.rb");
        assert_eq!(s.category, FileCategory::OtherScript);
    }
}
