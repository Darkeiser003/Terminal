//! Preparación del host PowerShell para una shell interactiva.
//!
//! PSReadLine consulta la posición del cursor al arrancar. Si el backend ya
//! escribió el inicializador por el PTY antes de que esa consulta termine, la
//! línea puede ser consumida por PSReadLine en vez de ejecutarse. El comando
//! de arranque lee primero una única línea por stdin y la evalúa antes de que
//! PowerShell entre en su prompt interactivo.

use crate::environments::ShellKind;

const BOOTSTRAP_COMMAND: &str =
    "$line = [Console]::In.ReadLine(); if ($line) { Invoke-Expression $line }";

/// Añade un lector de una línea antes de activar el prompt de PowerShell.
///
/// Devuelve `true` cuando el proceso espera que LTerminal le entregue una
/// primera línea; si no se genera un script de sesión, el backend debe enviar
/// una línea vacía para liberar el prompt. Los comandos explícitos (`-Command`,
/// `-File`, etc.) conservan su semántica y no reciben este envoltorio.
pub fn prepare_spawn_args(kind: ShellKind, args: &[String]) -> (Vec<String>, bool) {
    let mut prepared = args.to_vec();
    if kind != ShellKind::Powershell || has_explicit_startup_command(args) {
        return (prepared, false);
    }

    if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-NoExit")) {
        prepared.push("-NoExit".into());
    }
    prepared.push("-Command".into());
    prepared.push(BOOTSTRAP_COMMAND.into());
    (prepared, true)
}

fn has_explicit_startup_command(args: &[String]) -> bool {
    args.iter().any(|arg| {
        [
            "-command",
            "-c",
            "-commandwithargs",
            "-cwa",
            "-file",
            "-f",
            "-encodedcommand",
            "-enc",
            "-encodedarguments",
            "-ea",
            "-noninteractive",
            "-noni",
        ]
        .iter()
        .any(|switch| arg.eq_ignore_ascii_case(switch))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn powershell_lee_el_inicializador_antes_de_abrir_el_prompt() {
        let (prepared, awaits_line) =
            prepare_spawn_args(ShellKind::Powershell, &args(&["-NoLogo"]));

        assert!(awaits_line);
        assert_eq!(
            prepared,
            args(&["-NoLogo", "-NoExit", "-Command", BOOTSTRAP_COMMAND,])
        );
    }

    #[test]
    fn conserva_noexit_y_no_envuelve_comandos_o_scripts_explicitos() {
        let (prepared, awaits_line) = prepare_spawn_args(
            ShellKind::Powershell,
            &args(&["-NoExit", "-ExecutionPolicy", "Bypass"]),
        );
        assert!(awaits_line);
        assert_eq!(
            prepared
                .iter()
                .filter(|arg| arg.eq_ignore_ascii_case("-NoExit"))
                .count(),
            1
        );

        for switch in [
            "-Command",
            "-c",
            "-File",
            "-f",
            "-EncodedCommand",
            "-NonInteractive",
        ] {
            let original = args(&["-NoLogo", switch, "contenido"]);
            let (prepared, awaits_line) = prepare_spawn_args(ShellKind::Powershell, &original);
            assert!(!awaits_line, "no debe alterar {switch}");
            assert_eq!(prepared, original);
        }
    }

    #[test]
    fn no_altera_los_argumentos_de_otros_tipos_de_shell() {
        let original = args(&["-i"]);
        let (prepared, awaits_line) = prepare_spawn_args(ShellKind::Bash, &original);
        assert!(!awaits_line);
        assert_eq!(prepared, original);
    }
}
