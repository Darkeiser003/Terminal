//! Parser estricto de comandos de la aplicación. No interpreta sintaxis de la
//! shell: acepta líneas completas con `:` y el alias público del desarrollador.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalCommand {
    pub action: String,
    pub argument: Option<String>,
}

pub fn parse(line: &str) -> Option<InternalCommand> {
    let trimmed = line.trim();
    // Los comandos de control de la aplicación empiezan por `:`. El crédito
    // del desarrollador es la única excepción deliberada: funciona como
    // easter-egg escribiendo el alias directamente (también con `@`).
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
    let windows_collaborator_credit = cfg!(windows) && name == "christianlg97";
    if !prefixed && name != "darkeiser003" && !windows_collaborator_credit {
        return None;
    }
    let action = match name.as_str() {
        "config" | "settings" if argument.is_none() => "config",
        "reload" if argument.is_none() => "reload",
        "repl" if argument.is_some() => "repl",
        "shell" | "env" | "environment" => "shell",
        "alias" if argument.is_none() => "alias",
        "help" => "help",
        "banner" => "banner",
        "quick-actions" | "quickactions" => "quickActions",
        "ltools" | "tools" => "ltools",
        "panel" | "open" => "panel",
        "theme" => "theme",
        "font" | "fuente" => "font",
        "language" | "lang" | "idioma" => "language",
        "terminal" | "term" => "terminal",
        // Cualquier ajuste por su nombre: `:set` los lista, `:set clave` lo
        // enseña y `:set clave valor` lo cambia (lo valida el backend).
        "set" | "ajuste" | "pref" => "set",
        // El chat lateral con los agentes de IA: lo muestra u oculta.
        "chat" | "agentes" | "agents" if argument.is_none() => "chat",
        // Fijar o desfijar un chat del historial (24-11): `:chat pin help`,
        // `:chat unpin <id>`. También lo puede pedir una IA con `--ctl`.
        "chat" | "agentes" | "agents" if chat_pin_argument(argument.as_deref()) => "chatPin",
        "panes" | "layout" | "grid" => "panes",
        "explorer-here" => "openDirectory",
        "explorerhere" => "openDirectory",
        "open-here" => "openDirectory",
        "openhere" => "openDirectory",
        "reveal-here" => "openDirectory",
        "darkeiser003" if argument.is_none() => "darkeiser003",
        "christianlg97" if cfg!(windows) && !prefixed && argument.is_none() => "christianlg97",
        _ => return None,
    };
    if action == "openDirectory" && argument.is_some() {
        return None;
    }
    Some(InternalCommand {
        action: action.into(),
        argument,
    })
}

/// `pin <help|id>` o `unpin <help|id>`: el id, solo letras, números y guiones.
fn chat_pin_argument(argument: Option<&str>) -> bool {
    let mut words = argument.unwrap_or_default().split_whitespace();
    let verb = words.next().unwrap_or_default().to_ascii_lowercase();
    let target = words.next().unwrap_or_default();
    matches!(verb.as_str(), "pin" | "unpin" | "fijar" | "desfijar")
        && !target.is_empty()
        && target.len() <= 64
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && words.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fijar_y_desfijar_chats() {
        let pin = parse(":chat unpin help").unwrap();
        assert_eq!(pin.action, "chatPin");
        assert_eq!(pin.argument.as_deref(), Some("unpin help"));
        assert_eq!(parse(":chat pin c-abc-123").unwrap().action, "chatPin");
        assert!(parse(":chat pin ../x").is_none());
        assert!(parse(":chat borrar todo").is_none());
        assert_eq!(parse(":chat").unwrap().action, "chat");
    }

    #[test]
    fn reconoce_el_vocabulario_y_normaliza_espacios() {
        assert_eq!(
            parse(" :REPL   python  ").unwrap().argument.as_deref(),
            Some("python")
        );
        assert_eq!(parse(":config").unwrap().action, "config");
        assert_eq!(parse(":settings").unwrap().action, "config");
        assert_eq!(parse(":reload").unwrap().action, "reload");
        assert_eq!(parse(":shell powershell").unwrap().action, "shell");
        assert_eq!(parse(":env list").unwrap().action, "shell");
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
        assert_eq!(parse(":ltools").unwrap().action, "ltools");
        assert_eq!(parse(":tools").unwrap().action, "ltools");
        assert_eq!(parse(":open deps").unwrap().action, "panel");
        assert_eq!(parse(":theme list").unwrap().action, "theme");
        assert_eq!(parse(":font jetbrains").unwrap().action, "font");
        assert_eq!(parse(":lang es").unwrap().action, "language");
        assert_eq!(parse(":terminal fontsize 14").unwrap().action, "terminal");
        assert_eq!(parse(":layout 4").unwrap().action, "panes");
        assert_eq!(parse(":set").unwrap().action, "set");
        assert_eq!(
            parse(":ajuste actionCommandsAtOnce on")
                .unwrap()
                .argument
                .as_deref(),
            Some("actionCommandsAtOnce on")
        );
        assert_eq!(parse(":pref list python").unwrap().action, "set");
        assert_eq!(parse(":chat").unwrap().action, "chat");
        assert_eq!(parse(":agentes").unwrap().action, "chat");
        assert_eq!(parse(":banner preset compact").unwrap().action, "banner");
        assert_eq!(
            parse(":banner preset compact").unwrap().argument.as_deref(),
            Some("preset compact")
        );
        assert_eq!(parse(":explorer-here").unwrap().action, "openDirectory");
        assert_eq!(parse(":open-here").unwrap().action, "openDirectory");
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
    fn reconoce_el_credito_del_desarrollador_sin_distinguir_mayusculas_ni_arroba() {
        for (input, expected) in [
            ("Darkeiser003", "darkeiser003"),
            ("darkeiser003", "darkeiser003"),
            ("@darkeiser003", "darkeiser003"),
            ("@Darkeiser003", "darkeiser003"),
            (":darkeiser003", "darkeiser003"),
        ] {
            assert_eq!(parse(input).unwrap().action, expected, "entrada: {input}");
        }
        assert!(parse("@darkeiser003 extra").is_none());
        assert!(parse("@@darkeiser003").is_none());
        assert_eq!(
            parse("christianlg97").map(|command| command.action),
            cfg!(windows).then(|| "christianlg97".to_string())
        );
        assert!(parse(":christianlg97").is_none());
        assert!(parse("echo darkeiser003").is_none());
    }

    #[test]
    fn el_credito_de_colaborador_solo_se_acepta_en_windows() {
        assert_eq!(
            parse("@Christianlg97").map(|command| command.action),
            cfg!(windows).then(|| "christianlg97".to_string())
        );
    }
}
