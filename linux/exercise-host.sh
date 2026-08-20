#!/usr/bin/env bash
set -Eeuo pipefail

# Prueba las shells y herramientas que YA existen en el host sin modificar
# perfiles ni instalar paquetes. `--strict` convierte en error la ausencia de
# herramientas; sin él, una herramienta opcional ausente se informa como
# omitida, no como un falso fallo.
strict=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --strict) strict=1 ;;
        -h|--help)
            echo "Uso: $0 [--strict]"
            exit 0
            ;;
        *)
            echo "Argumento desconocido: $1" >&2
            exit 2
            ;;
    esac
    shift
done

failures=0
tested=0
skipped=0

probe() {
    local name="$1" executable="$2"; shift 2
    if ! command -v "$executable" >/dev/null 2>&1; then
        skipped=$((skipped + 1))
        echo "OMITIDO: $name no está instalado"
        return 0
    fi
    tested=$((tested + 1))
    if timeout 8 "$executable" "$@" >/dev/null 2>&1; then
        echo "OK: $name"
    else
        echo "ERROR: $name no completó su prueba" >&2
        failures=$((failures + 1))
    fi
}

probe_output() {
    local name="$1" executable="$2" expected="$3"; shift 3
    if ! command -v "$executable" >/dev/null 2>&1; then
        skipped=$((skipped + 1))
        echo "OMITIDO: $name no está instalado"
        return 0
    fi
    tested=$((tested + 1))
    local output
    if output="$(timeout 8 "$executable" "$@" 2>&1)" && printf '%s' "$output" | grep -Fq "$expected"; then
        echo "OK: $name"
    else
        echo "ERROR: $name no produjo la respuesta esperada" >&2
        failures=$((failures + 1))
    fi
}

probe_path() {
    local name="$1" executable="$2"
    if command -v "$executable" >/dev/null 2>&1; then
        tested=$((tested + 1))
        echo "OK: $name ($(command -v "$executable"))"
    else
        skipped=$((skipped + 1))
        echo "OMITIDO: $name no está instalado"
    fi
}

probe_output Bash bash LTERMINAL_SHELL_OK --noprofile --norc -c 'printf LTERMINAL_SHELL_OK'
probe_output Zsh zsh LTERMINAL_SHELL_OK -f -c 'printf LTERMINAL_SHELL_OK'
probe_output Fish fish LTERMINAL_SHELL_OK --no-config -c 'printf LTERMINAL_SHELL_OK'
probe_output Dash dash LTERMINAL_SHELL_OK -c 'printf LTERMINAL_SHELL_OK'
probe_output PowerShell pwsh LTERMINAL_SHELL_OK -NoProfile -NonInteractive -Command 'Write-Output LTERMINAL_SHELL_OK'
probe_output Nushell nu LTERMINAL_SHELL_OK --no-config-file -c 'print LTERMINAL_SHELL_OK'
probe_output Python python3 LTERMINAL_REPL_OK -I -c 'print("LTERMINAL_REPL_OK")'
probe_output Node node LTERMINAL_REPL_OK --input-type=module -e 'console.log("LTERMINAL_REPL_OK")'
probe_output Ruby ruby LTERMINAL_REPL_OK --disable-gems -e 'puts "LTERMINAL_REPL_OK"'
probe_output PHP php LTERMINAL_REPL_OK -r 'echo "LTERMINAL_REPL_OK";'

probe Cargo cargo --version
probe Rust rustc --version
probe NPM npm --version
probe Git git --version
probe SQLite sqlite3 --version
probe MariaDB mariadb --version
probe MySQL mysql --version
probe PostgreSQL psql --version
probe GCC gcc --version
probe Clang clang --version
probe CMake cmake --version
probe NASM nasm -version
probe YASM yasm --version
probe Fortran gfortran --version
probe Dotnet dotnet --info
probe Java java -version
probe Go go version
probe Perl perl -v
probe Lua lua -v
probe Julia julia --version
probe R R --version
probe Erlang erl -noshell -eval 'halt().'
probe Elixir elixir --version
probe OCaml ocaml -version
probe Racket racket --version
probe Haskell ghc --version
probe Docker docker --version
probe Kubernetes kubectl version --client=true
probe Helm helm version --short
probe ADB adb version
probe Wine wine --version
probe Winetricks winetricks --version
probe QEMU qemu-system-x86_64 --version
probe Libvirt virsh --version
probe cabextract cabextract --version
probe msiinfo msiinfo --version
probe MinGW x86_64-w64-mingw32-gcc --version
probe_path Bottles bottles
probe_path Lutris lutris
probe_path Steam steam
probe_path ProtonUp protonup-qt
probe_path virt-manager virt-manager
probe_path 'GNOME Boxes' gnome-boxes

# La comprobación de comandos internos y alias reales vive en Rust y E2E:
# aquí no se escribe en perfiles del usuario ni se simula una sesión falsa.
probe_output 'Shell segura' bash LTERMINAL_COMMAND_OK --noprofile --norc -c 'printf LTERMINAL_COMMAND_OK'

echo "Resultado: $tested pruebas ejecutadas, $skipped herramientas no instaladas, $failures fallos."
if [ "$strict" -eq 1 ] && [ "$skipped" -gt 0 ]; then
    echo "ERROR: --strict no permite herramientas ausentes." >&2
    failures=$((failures + 1))
fi
[ "$failures" -eq 0 ]
