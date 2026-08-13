//! Con qué directorio se lanza el proceso de una pestaña nueva.
//!
//! Port de `electron/main/spawnCwd.js`.
//!
//! Cada shell traduce sola el directorio del proceso a su propia convención
//! (cmd y PowerShell lo usan tal cual, Git Bash lo ve como `/c/...`, WSL como
//! `/mnt/c/...`), así que heredar la carpeta es simplemente lanzar el pty ahí.
//! No hace falta escribir ningún `cd` en la terminal ni usar `wsl --cd`.

use std::path::{Path, PathBuf};

use crate::environments::{Environment, Transport};

/// Devuelve el directorio heredado si de verdad sirve para este entorno, o
/// `None` para que el llamante caiga al home:
///   - los contenedores y los dispositivos ADB no comparten el sistema de
///     archivos del host (Docker monta una carpeta fija en `/workspace`),
///   - las rutas UNC (`\\wsl$\...`, unidades de red) no valen como directorio
///     actual: cmd.exe no las admite y CreateProcess puede fallar,
///   - y la carpeta tiene que existir todavía.
pub fn usable_spawn_cwd(candidate: Option<&Path>, env: &Environment) -> Option<PathBuf> {
    let candidate = candidate?;
    if candidate.as_os_str().is_empty() {
        return None;
    }
    if matches!(env.transport, Transport::Docker | Transport::Android) {
        return None;
    }
    if candidate.to_string_lossy().starts_with("\\\\") {
        return None;
    }
    if candidate.is_dir() {
        Some(candidate.to_path_buf())
    } else {
        None
    }
}

/// Directorio definitivo: el heredado si sirve, el propio del entorno (Docker
/// monta el home del usuario) y, como último recurso, la carpeta personal.
pub fn resolve_spawn_cwd(candidate: Option<&Path>, env: &Environment, home_cwd: &Path) -> PathBuf {
    usable_spawn_cwd(candidate, env)
        .or_else(|| env.initial_host_cwd.as_ref().map(PathBuf::from))
        .unwrap_or_else(|| home_cwd.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environments::ShellKind;

    fn env_with(transport: Transport) -> Environment {
        Environment {
            transport,
            exe: "/bin/sh".into(),
            ..Environment::new("x", "x", ShellKind::Bash, "/bin/sh", &[])
        }
    }

    #[test]
    fn una_carpeta_existente_se_hereda() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_with(Transport::Native);
        assert_eq!(
            usable_spawn_cwd(Some(dir.path()), &env).as_deref(),
            Some(dir.path())
        );
    }

    #[test]
    fn una_carpeta_que_ya_no_existe_no_se_hereda() {
        let env = env_with(Transport::Native);
        let inexistente = std::env::temp_dir().join("carpeta-que-no-existe-lterminal");
        assert_eq!(usable_spawn_cwd(Some(&inexistente), &env), None);
    }

    #[test]
    fn los_contenedores_y_los_dispositivos_no_heredan_el_host() {
        let dir = tempfile::tempdir().unwrap();
        for transport in [Transport::Docker, Transport::Android] {
            assert_eq!(
                usable_spawn_cwd(Some(dir.path()), &env_with(transport)),
                None
            );
        }
    }

    #[test]
    fn una_ruta_unc_no_vale_como_directorio_actual() {
        let env = env_with(Transport::Native);
        assert_eq!(
            usable_spawn_cwd(Some(Path::new(r"\\wsl$\Ubuntu\home")), &env),
            None
        );
    }

    #[test]
    fn sin_candidato_util_manda_el_directorio_propio_del_entorno() {
        let mut env = env_with(Transport::Docker);
        env.initial_host_cwd = Some("/workspace".into());
        let home = Path::new("/home/usuario");
        assert_eq!(
            resolve_spawn_cwd(Some(Path::new("/tmp")), &env, home),
            PathBuf::from("/workspace")
        );
    }

    #[test]
    fn sin_nada_util_se_cae_al_home() {
        let env = env_with(Transport::Native);
        let home = std::env::temp_dir();
        assert_eq!(resolve_spawn_cwd(None, &env, &home), home);
    }
}
