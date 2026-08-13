#!/usr/bin/env bash
set -Eeuo pipefail

# Prueba las shells que YA existen en el host sin modificar perfiles ni
# instalar paquetes. Para instalación real debe usarse una VM desechable y la
# UI de LTerminal, donde cada orden y su progreso permanecen visibles.
failures=0
tested=0

probe() {
    local name="$1" executable="$2"; shift 2
    command -v "$executable" >/dev/null 2>&1 || return 0
    tested=$((tested + 1))
    if timeout 8 "$executable" "$@" >/dev/null 2>&1; then
        echo "OK: $name"
    else
        echo "ERROR: $name no completó su prueba" >&2
        failures=$((failures + 1))
    fi
}

probe Bash bash --noprofile --norc -c 'printf LTERMINAL_SHELL_OK'
probe Zsh zsh -f -c 'printf LTERMINAL_SHELL_OK'
probe Fish fish --no-config -c 'printf LTERMINAL_SHELL_OK'
probe Dash dash -c 'printf LTERMINAL_SHELL_OK'
probe PowerShell pwsh -NoProfile -NonInteractive -Command 'Write-Output LTERMINAL_SHELL_OK'
probe Nushell nu --no-config-file -c 'print LTERMINAL_SHELL_OK'
probe Python python3 -I -c 'print("LTERMINAL_REPL_OK")'
probe Node node --input-type=module -e 'console.log("LTERMINAL_REPL_OK")'
probe Ruby ruby --disable-gems -e 'puts "LTERMINAL_REPL_OK"'
probe PHP php -r 'echo "LTERMINAL_REPL_OK";'

echo "Resultado: $tested intérpretes probados, $failures fallos."
[ "$failures" -eq 0 ]
