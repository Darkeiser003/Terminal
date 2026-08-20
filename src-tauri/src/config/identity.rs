//! Identidad visible y rutas propias por plataforma. Mantener esta decisión en
//! un solo módulo evita que una build Linux herede accidentalmente la marca de
//! Windows o que aparezcan nombres distintos en ventana, banner, logs y PTY.
//!
//! Port de `electron/main/appIdentity.js`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pub name: &'static str,
    pub slug: &'static str,
    pub user_agent: &'static str,
    pub projects_folder_name: &'static str,
    pub desktop_file: Option<&'static str>,
}

pub const WINDOWS: Identity = Identity {
    name: "WinSlim Terminal",
    // Se conserva únicamente para migrar perfiles de versiones antiguas.
    slug: "winslim-terminal",
    user_agent: "WinSlim-Terminal",
    projects_folder_name: "WinSlim Projects",
    desktop_file: None,
};

pub const LINUX: Identity = Identity {
    name: "LTerminal",
    slug: "lterminal",
    user_agent: "LTerminal",
    projects_folder_name: "LTerminal Projects",
    desktop_file: Some("LTerminal.desktop"),
};

pub const MACOS: Identity = Identity {
    name: "LTerminal",
    slug: "lterminal",
    user_agent: "LTerminal",
    projects_folder_name: "LTerminal Projects",
    desktop_file: None,
};

/// Igual que `identityForPlatform`: cualquier plataforma desconocida cae en la
/// identidad de Linux, no en la de Windows.
pub fn identity_for_platform(platform: &str) -> Identity {
    match platform {
        "win32" | "windows" => WINDOWS,
        "darwin" | "macos" => MACOS,
        _ => LINUX,
    }
}

/// La identidad de la plataforma en la que se ha compilado el binario.
pub fn current() -> Identity {
    identity_for_platform(std::env::consts::OS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_plataforma_tiene_su_marca() {
        assert_eq!(identity_for_platform("win32").name, "WinSlim Terminal");
        assert_eq!(identity_for_platform("linux").name, "LTerminal");
        assert_eq!(identity_for_platform("win32").slug, "winslim-terminal");
        assert_eq!(identity_for_platform("linux").slug, "lterminal");
        assert_eq!(identity_for_platform("darwin").slug, "lterminal");
    }

    #[test]
    fn una_plataforma_desconocida_no_hereda_la_marca_de_windows() {
        assert_eq!(identity_for_platform("freebsd"), LINUX);
    }

    #[test]
    fn solo_linux_declara_archivo_desktop() {
        assert!(identity_for_platform("linux").desktop_file.is_some());
        assert!(identity_for_platform("win32").desktop_file.is_none());
        assert!(identity_for_platform("darwin").desktop_file.is_none());
    }
}
