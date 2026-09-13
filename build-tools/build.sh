#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OS="$(uname -s 2>/dev/null || true)"

case "$OS" in
    MINGW*|MSYS*|CYGWIN*)
        printf '%s\n' 'Este menú Bash necesita Linux (incluido WSL). En Windows nativo ejecuta:' \
            '  powershell -ExecutionPolicy Bypass -File build-tools/build.ps1'
        exit 2
        ;;
esac

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
Menú de desarrollo y compilación de LTerminal

Uso:
  bash build-tools/build.sh

Abre submenús para desarrollo/preview, compilación, pruebas y limpieza.
Los compiladores detallados siguen disponibles para automatización en linux/.
HELP
    exit 0
fi
if [[ "$#" -gt 0 ]]; then
    printf 'Opción desconocida: %s\nUsa --help para ver el uso.\n' "$1" >&2
    exit 2
fi

cd "$ROOT"

pause_menu() {
    printf '\nPulsa Enter para volver al menú…'
    IFS= read -r _ || true
}

run_action() {
    local label="$1"
    shift
    printf '\n==> %s\n' "$label"
    "$@"
    local status=$?
    RUN_ACTION_STATUS=$status
    if [[ "$status" -eq 0 ]]; then
        printf '\nCompletado.\n'
    else
        printf '\nLa acción terminó con código %s. Revisa el mensaje anterior.\n' "$status" >&2
    fi
    pause_menu
    return 0
}

ask_yes_no() {
    local prompt="$1" answer
    while true; do
        read -r -p "$prompt [s/N]: " answer || return 1
        case "${answer,,}" in
            s|si|sí|y|yes) return 0 ;;
            n|no|'') return 1 ;;
            *) printf 'Responde sí o no.\n' ;;
        esac
    done
}

run_linux_build() {
    local mode="$1"
    local args=(--no-run --non-interactive)
    if [[ "$mode" == "fast" ]]; then
        args+=(--fast --no-extended-tests --skip-checks)
    fi
    if ! ask_yes_no '¿Permitir instalar automáticamente dependencias del sistema si faltan?'; then
        args+=(--no-install)
    fi
    run_action 'Compilando el AppImage Linux' bash linux/build.sh "${args[@]}"
}

run_windows_cross_build() {
    local mode="$1"
    local args=(--non-interactive)
    if [[ "$mode" == "fast" ]]; then
        args+=(--fast --skip-checks)
    elif [[ "$mode" == "wine-tests" ]]; then
        args+=(--full-tests --wine-repeats 3)
    fi
    if ! ask_yes_no '¿Permitir instalar automáticamente MinGW/Wine si faltan?'; then
        args+=(--no-install)
    fi
    run_action 'Compilando la aplicación portable Windows (GNU x64)' bash linux/build-windows.sh "${args[@]}"
}

development_menu() {
    while true; do
        printf '\nDesarrollo y preview\n'
        printf '  1. Abrir servidor web de desarrollo (Vite + recarga)\n'
        printf '  2. Previsualizar el último frontend compilado\n'
        printf '  3. Ejecutar la app de escritorio en desarrollo\n'
        printf '  4. Compilar solo el frontend\n'
        printf '  5. Compilar solo el frontend (rápido)\n'
        printf '  0. Volver\n'
        read -r -p 'Elige una opción: ' choice || return
        case "$choice" in
            1) run_action 'Iniciando Vite en http://localhost:1420' npm run dev -- --host 127.0.0.1 ;;
            2) run_action 'Previsualizando dist/ en http://localhost:4173' npm run preview -- --host 127.0.0.1 ;;
            3) run_action 'Iniciando la aplicación Tauri en desarrollo' npm start ;;
            4) run_action 'Compilando únicamente el frontend' npm run build ;;
            5) run_action 'Compilando únicamente el frontend en modo rápido' npm run build:fast ;;
            0) return ;;
            *) printf 'Opción no válida.\n' ;;
        esac
    done
}

build_menu() {
    while true; do
        printf '\nCompilar\n'
        printf '  1. Comprobar/compilar backend Rust (sin empaquetar)\n'
        printf '  2. Generar AppImage Linux (release completa)\n'
        printf '  3. Generar AppImage Linux (iteración rápida)\n'
        printf '  4. Generar aplicación portable Windows desde Linux\n'
        printf '  5. Generar aplicación portable Windows (rápida)\n'
        printf '  6. Compilar y probar Windows con la suite Rust bajo Wine\n'
        printf '  7. Generar AppImage y validar también Windows bajo Wine\n'
        printf '  8. Compilar frontend y backend juntos sin empaquetar\n'
        printf '  0. Volver\n'
        read -r -p 'Elige una opción: ' choice || return
        case "$choice" in
            1)
                printf '\n  1. Revisar el backend sin generar ejecutable\n  2. Compilar ejecutable de desarrollo\n  0. Volver\n'
                read -r -p 'Elige una opción: ' backend_choice || return
                case "$backend_choice" in
                    1) run_action 'Revisando el backend Rust' cargo check --manifest-path src-tauri/Cargo.toml --bin winslim-terminal ;;
                    2) run_action 'Compilando el backend Rust en modo desarrollo' cargo build --manifest-path src-tauri/Cargo.toml --bin winslim-terminal ;;
                    0) ;;
                    *) printf 'Opción no válida.\n' ;;
                esac
                ;;
            2) run_linux_build full ;;
            3) run_linux_build fast ;;
            4) run_windows_cross_build full ;;
            5) run_windows_cross_build fast ;;
            6) run_windows_cross_build wine-tests ;;
            7)
                local args=(--no-run --non-interactive --full-tests --cross-windows)
                if ! ask_yes_no '¿Permitir instalar automáticamente dependencias Linux/MinGW/Wine si faltan?'; then
                    args+=(--no-install)
                fi
                run_action 'Generando AppImage y validando Windows de forma cruzada con Wine' bash linux/build.sh "${args[@]}"
                ;;
            8) run_action 'Compilando frontend y aplicación de escritorio Linux sin empaquetar' npm run tauri -- build --config src-tauri/tauri.linux.conf.json --no-bundle ;;
            0) return ;;
            *) printf 'Opción no válida.\n' ;;
        esac
    done
}

tests_menu() {
    while true; do
        printf '\nPruebas y smoke sin recompilar la aplicación\n'
        printf '  1. Pruebas locales, contratos y lógica frontend\n'
        printf '  2. Suite completa de validación del proyecto\n'
        printf '  3. Pruebas unitarias Rust\n'
        printf '  4. Smoke de un AppImage existente\n'
        printf '  5. Batería E2E sobre un ejecutable ya compilado\n'
        printf '  6. Comprobar herramientas/shells disponibles en el host\n'
        printf '  0. Volver\n'
        read -r -p 'Elige una opción: ' choice || return
        case "$choice" in
            1) run_action 'Ejecutando validaciones locales' npm run check:local ;;
            2) run_action 'Ejecutando validaciones completas' npm run check ;;
            3) run_action 'Ejecutando pruebas Rust' cargo test --manifest-path src-tauri/Cargo.toml ;;
            4) run_action 'Validando la aplicación ya empaquetada' bash linux/validate-release.sh ;;
            5)
                local default_binary="${E2E_BINARY:-$ROOT/src-tauri/target/release/winslim-terminal}"
                local binary
                read -r -p "Ruta al ejecutable compilado [$default_binary]: " binary || return
                binary="${binary:-$default_binary}"
                if [[ ! -f "$binary" ]]; then
                    printf 'No se encontró el ejecutable: %s\nCompila la app primero o introduce otra ruta.\n' "$binary" >&2
                    pause_menu
                else
                    local driver_path
                    read -r -p 'Ruta a WebKitWebDriver/EdgeDriver (Enter para autodetectar o usar la variable actual): ' driver_path || return
                    if [[ -n "$driver_path" ]]; then
                        E2E_BINARY="$binary" TAURI_NATIVE_DRIVER="$driver_path" run_action 'Ejecutando la batería E2E sin recompilar la app' npm run e2e
                    else
                        E2E_BINARY="$binary" run_action 'Ejecutando la batería E2E sin recompilar la app' npm run e2e
                    fi
                fi
                ;;
            6) run_action 'Probando las herramientas del host' bash linux/exercise-host.sh ;;
            0) return ;;
            *) printf 'Opción no válida.\n' ;;
        esac
    done
}

clean_menu() {
    local preview_status
    printf '\nLimpieza segura: release/ se conserva. Primero se muestra la vista previa.\n'
    run_action 'Revisando qué cachés y salidas temporales se podrían limpiar' bash scripts/clean-repository.sh
    preview_status="$RUN_ACTION_STATUS"
    if [[ "$preview_status" -ne 0 ]]; then
        printf 'La vista previa falló; se cancela la limpieza y no se ofrecerá aplicar borrados.\n' >&2
        return
    fi
    if ask_yes_no '¿Aplicar esta limpieza ahora?'; then
        run_action 'Eliminando cachés y salidas temporales conocidas' bash scripts/clean-repository.sh --apply
    fi
}

while true; do
    printf '\nLTerminal — desarrollo y compilación\n'
    printf '  1. Desarrollo y preview\n'
    printf '  2. Compilar\n'
    printf '  3. Pruebas y smoke sin recompilar\n'
    printf '  4. Limpiar cachés y builds temporales\n'
    printf '  0. Salir\n'
    read -r -p 'Elige una opción: ' choice || break
    case "$choice" in
        1) development_menu ;;
        2) build_menu ;;
        3) tests_menu ;;
        4) clean_menu ;;
        0) break ;;
        *) printf 'Opción no válida.\n' ;;
    esac
done
