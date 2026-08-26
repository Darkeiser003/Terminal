//! Parser estricto de comandos de la aplicación. No interpreta sintaxis de la
//! shell: solo acepta una línea completa que empiece por `:`.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalCommand {
    pub action: String,
    pub argument: Option<String>,
}

pub fn parse(line: &str) -> Option<InternalCommand> {
    let trimmed = line.trim();
    let body = trimmed.strip_prefix(':')?;
    let mut parts = body.split_whitespace();
    let name = parts.next()?.to_ascii_lowercase();
    let argument = parts.collect::<Vec<_>>().join(" ");
    let argument = (!argument.is_empty()).then_some(argument);
    let action = match name.as_str() {
        "config" if argument.is_none() => "config",
        "reload" if argument.is_none() => "reload",
        "repl" if argument.is_some() => "repl",
        "alias" if argument.is_none() => "alias",
        "help" => "help",
        "banner" => "banner",
        "quick-actions" | "quickactions" => "quickActions",
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
}
