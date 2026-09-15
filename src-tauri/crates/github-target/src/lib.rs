//! Parser pequeño y sin dependencias para destinos públicos de GitHub.
//!
//! Se mantiene fuera del binario Tauri para poder ejecutarlo bajo tests y
//! fuzzing nativo sin compilar GTK, WebKit ni el resto de la aplicación.

/// Login de usuario u organización válido según las restricciones de GitHub.
pub fn is_github_owner(value: &str) -> bool {
    if value.is_empty() || value.len() > 39 {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// Nombre de repositorio aceptado por la interfaz de proyectos.
pub fn is_github_repo_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullName {
    pub owner: String,
    pub name: String,
    pub full_name: String,
}

pub fn parse_full_name(value: &str) -> Option<FullName> {
    let trimmed = value.trim();
    let without_git = trimmed
        .strip_suffix(".git")
        .or_else(|| trimmed.strip_suffix(".GIT"))
        .unwrap_or(trimmed);
    let parts: Vec<&str> = without_git.split('/').collect();
    if parts.len() != 2 || !is_github_owner(parts[0]) || !is_github_repo_name(parts[1]) {
        return None;
    }
    Some(FullName {
        owner: parts[0].to_string(),
        name: parts[1].to_string(),
        full_name: format!("{}/{}", parts[0], parts[1]),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Owner(String),
    Repo(FullName),
}

/// Acepta un login, `owner/repo` o una URL web normal. Rechaza SSH,
/// `git://`, hosts alternativos, credenciales, puertos y segmentos adicionales.
pub fn parse_github_target(raw: &str) -> Option<Target> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 300 {
        return None;
    }
    if is_github_owner(value) {
        return Some(Target::Owner(value.to_string()));
    }
    if let Some(full) = parse_full_name(value) {
        return Some(Target::Repo(full));
    }

    let rest = value.strip_prefix("https://")?;
    let (host, path) = match rest.split_once('/') {
        Some((host, path)) => (host, path),
        None => (rest, ""),
    };
    if !host.eq_ignore_ascii_case("github.com") || host.contains('@') || host.contains(':') {
        return None;
    }
    let path = path
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("");
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments: Vec<&str> = if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    };
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    match segments.len() {
        1 if is_github_owner(segments[0]) => Some(Target::Owner(segments[0].to_string())),
        2 => parse_full_name(&format!("{}/{}", segments[0], segments[1])).map(Target::Repo),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_github_owner, is_github_repo_name, parse_full_name, parse_github_target, FullName,
        Target,
    };

    #[test]
    fn acepta_nombres_validos_y_rechaza_limites_invalidos() {
        assert!(is_github_owner("torvalds"));
        assert!(is_github_owner("mi-org-1"));
        assert!(!is_github_owner("-empieza-mal"));
        assert!(!is_github_owner("acaba-mal-"));
        assert!(!is_github_owner(&"a".repeat(40)));
        assert!(is_github_repo_name("repo.name_1-test"));
        assert!(!is_github_repo_name("repo/name"));
        assert!(!is_github_repo_name(""));
    }

    #[test]
    fn normaliza_full_name_y_urls_web() {
        let expected = Target::Repo(FullName {
            owner: "torvalds".into(),
            name: "linux".into(),
            full_name: "torvalds/linux".into(),
        });
        assert_eq!(
            parse_full_name("torvalds/linux.git"),
            Some(match expected.clone() {
                Target::Repo(full) => full,
                Target::Owner(_) => unreachable!(),
            })
        );
        // A clone URL for a repository literally named `linux.git` ends in
        // `.git.git`; exactly one suffix is transport syntax, the other is
        // part of the repository's valid name.
        assert_eq!(parse_full_name("torvalds/linux.git.git").unwrap().name, "linux.git");
        assert_eq!(
            parse_github_target("https://github.com/torvalds/linux?tab=readme"), // link-check: ignore
            Some(expected)
        );
        assert_eq!(
            parse_github_target("https://github.com/torvalds"), // link-check: ignore
            Some(Target::Owner("torvalds".into()))
        );
    }

    #[test]
    fn rechaza_credenciales_hosts_alternativos_y_subcadenas_ambiguas() {
        for input in [
            "https://evilgithub.com/owner/repo",       // link-check: ignore
            "https://github.com.evil.test/owner/repo", // link-check: ignore
            "https://user@github.com/owner/repo",
            "https://github.com:443/owner/repo",
            "https://github.com/owner/repo/tree/main", // link-check: ignore
            "https://github.com/owner%2Frepo",         // link-check: ignore
            "http://github.com/owner/repo",            // link-check: ignore
            "git@github.com:owner/repo.git",
            "https://github.com//owner/repo", // link-check: ignore
        ] {
            assert_eq!(parse_github_target(input), None, "debe rechazar {input}");
        }
    }
}
