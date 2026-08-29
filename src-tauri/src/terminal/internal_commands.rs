//! Parser estricto de comandos de la aplicación. No interpreta sintaxis de la
//! shell: acepta líneas completas con `:` y los dos alias públicos de créditos.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalCommand {
    pub action: String,
    pub argument: Option<String>,
}

pub fn parse(line: &str) -> Option<InternalCommand> {
    let trimmed = line.trim();
    // Los comandos de control de la aplicación empiezan por `:`. Los dos
    // créditos de autoría son la excepción deliberada: funcionan como
    // easter-eggs escribiendo el alias directamente (también con `@`).
    // Al exigir una línea completa no secuestramos comandos reales de la shell
    // que simplemente contengan esos nombres como parte de una orden.
    let prefixed = trimmed.starts_with(':');
    let body = trimmed.strip_prefix(':').unwrap_or(trimmed);
    let mut parts = body.split_whitespace();
    let raw_name = parts.next()?;
    let name = raw_name
        .strip_prefix('@')
        .unwrap_or(raw_name)
        .to_ascii_lowercase();
    let argument = parts.collect::<Vec<_>>().join(" ");
    let argument = (!argument.is_empty()).then_some(argument);
    if !prefixed && !matches!(name.as_str(), "darkeiser003" | "christianlg97") {
        return None;
    }
    let action = match name.as_str() {
        "config" if argument.is_none() => "config",
        "reload" if argument.is_none() => "reload",
        "repl" if argument.is_some() => "repl",
        "alias" if argument.is_none() => "alias",
        "help" => "help",
        "banner" => "banner",
        "quick-actions" | "quickactions" => "quickActions",
        "darkeiser003" if argument.is_none() => "darkeiser003",
        "christianlg97" if argument.is_none() => "christianlg97",
        _ => return None,
    };
    Some(InternalCommand {
        action: action.into(),
        argument,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_el_vocabulario_y_normaliza_espacios() {
        assert_eq!(
            parse(" :REPL   python  ").unwrap().argument.as_deref(),
            Some("python")
        );
        assert_eq!(parse(":config").unwrap().action, "config");
        assert_eq!(parse(":reload").unwrap().action, "reload");
        assert_eq!(
            parse(":help paquetes").unwrap().argument.as_deref(),
            Some("paquetes")
        );
        assert_eq!(parse(":alias").unwrap().action, "alias");
        assert_eq!(
            parse(":quick-actions toggle").unwrap().action,
            "quickActions"
        );
        assert_eq!(
            parse(":quickactions off").unwrap().argument.as_deref(),
            Some("off")
        );
        assert_eq!(parse(":banner preset compact").unwrap().action, "banner");
        assert_eq!(
            parse(":banner preset compact").unwrap().argument.as_deref(),
            Some("preset compact")
        );
    }

    #[test]
    fn no_secuestra_comandos_de_shell_ni_ordenes_incompletas() {
        assert!(parse("echo :repl python").is_none());
        assert!(parse(":repl").is_none());
        assert!(parse(":alias algo").is_none());
        assert!(parse(":desconocido").is_none());
        assert!(parse("").is_none());
    }

    #[test]
    fn reconoce_los_creditos_como_easter_eggs_sin_distinguir_mayusculas_ni_arroba() {
        for (input, expected) in [
            ("Darkeiser003", "darkeiser003"),
            ("darkeiser003", "darkeiser003"),
            ("@darkeiser003", "darkeiser003"),
            ("@Darkeiser003", "darkeiser003"),
            ("Christianlg97", "christianlg97"),
            ("christianlg97", "christianlg97"),
            ("@christianlg97", "christianlg97"),
            ("@Christianlg97", "christianlg97"),
            ("@CHRISTIANLG97", "christianlg97"),
            (":darkeiser003", "darkeiser003"),
            (":christianlg97", "christianlg97"),
        ] {
            assert_eq!(parse(input).unwrap().action, expected, "entrada: {input}");
        }
        assert!(parse("@darkeiser003 extra").is_none());
        assert!(parse("@@darkeiser003").is_none());
        assert!(parse("echo darkeiser003").is_none());
    }
}
