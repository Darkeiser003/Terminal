use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub(super) fn find_executable(command: &str, path_value: &str) -> Option<PathBuf> {
    if command.is_empty() || command.contains(['\0', '\r', '\n']) {
        return None;
    }
    let candidates: Vec<PathBuf> = if command.contains('/') {
        vec![std::fs::canonicalize(command).unwrap_or_else(|_| PathBuf::from(command))]
    } else {
        path_value
            .split(':')
            .filter(|dir| !dir.is_empty())
            .map(|dir| Path::new(dir).join(command))
            .collect()
    };
    candidates.into_iter().find(|candidate| {
        std::fs::metadata(candidate)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rechaza_comandos_con_caracteres_de_control() {
        assert!(find_executable("ba\nsh", "/usr/bin").is_none());
        assert!(find_executable("", "/usr/bin").is_none());
    }

    #[test]
    fn encuentra_un_archivo_ejecutable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("miherramienta");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            find_executable("miherramienta", dir.path().to_str().unwrap()),
            Some(file)
        );
    }
}
