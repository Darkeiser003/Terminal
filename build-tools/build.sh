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
  bash build-tools/build.sh --setup-git-signing

Abre submenús para desarrollo/preview, compilación, pruebas y limpieza.
La configuración de firma Git es explícita y no se ejecuta durante las builds.
Los compiladores detallados siguen disponibles para automatización en linux/.
HELP
    exit 0
fi
if [[ "${1:-}" == "--setup-git-signing" ]]; then
    shift
    exec bash "$ROOT/build-tools/configure-git-signing.sh" --repo "$ROOT" "$@"
fi
if [[ "$#" -gt 0 ]]; then
    printf 'Opción desconocida: %s\nUsa --help para ver el uso.\n' "$1" >&2
    exit 2
fi

cd "$ROOT" || exit 1

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
    elif [[ "$mode" == "without-tests" ]]; then
        args+=(--no-extended-tests)
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
    elif [[ "$mode" == "without-tests" ]]; then
        args+=(--no-extended-tests)
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
        printf '  6. Generar el preview web funcional (sin Tauri)\n'
        printf '  7. Ejecutar cualquier script npm/pnpm del proyecto\n'
        printf '  8. Pruebas dirigidas con la compilación rápida (las que elijas, N veces)\n'
        printf '  9. Repetir las que alguna vez fallaron (5 veces cada una)\n'
        printf '  0. Volver\n'
        read -r -p 'Elige una opción: ' choice || return
        case "$choice" in
            1) run_action 'Iniciando Vite en http://localhost:1420' node scripts/package-scripts.mjs run dev -- --host 127.0.0.1 ;;
            2) run_action 'Previsualizando dist/ en http://localhost:4173' node scripts/package-scripts.mjs run preview -- --host 127.0.0.1 ;;
            3) run_action 'Iniciando la aplicación Tauri en desarrollo' node scripts/package-scripts.mjs run start ;;
            4) run_action 'Compilando únicamente el frontend' node scripts/package-scripts.mjs run build ;;
            5) run_action 'Compilando únicamente el frontend en modo rápido' node scripts/package-scripts.mjs run build:fast ;;
            6) run_action 'Generando el preview web funcional en dist-preview/' node scripts/package-scripts.mjs run build:preview ;;
            7) run_action 'Abriendo el selector dinámico de scripts' node scripts/package-scripts.mjs menu ;;
            8) run_targeted_tests ;;
            9) run_action 'Repitiendo las pruebas que alguna vez fallaron' node scripts/dev-test.mjs --suite intermitentes ;;
            0) return ;;
            *) printf 'Opción no válida.\n' ;;
        esac
    done
}

# 22-11 (Romen: «usa y mejora mis scripts, con builds por pasos y opciones»).
# La versión de depuración sin pruebas: la más rápida para probar a mano.
run_debug_build() {
    run_action 'Compilando la versión de depuración sin pruebas' node scripts/dev-test.mjs --build debug --no-sign
}

# Pruebas dirigidas con la compilación rápida (scripts/dev-test.mjs).
run_targeted_tests() {
    node scripts/dev-test.mjs --list
    local only repeat build
    read -r -p 'Escenarios separados por comas: ' only || return
    if [[ -z "$only" ]]; then printf 'Sin escenarios no se lanza.\n'; return; fi
    read -r -p 'Cuántas veces cada uno [1]: ' repeat || return
    read -r -p 'Compilación: fast, debug o none (la última, sin compilar) [fast]: ' build || return
    run_action 'Ejecutando las pruebas dirigidas' node scripts/dev-test.mjs --only "$only" --repeat "${repeat:-1}" --build "${build:-fast}"
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
        printf '  9. Generar AppImage sin pruebas ampliadas (smoke básico)\n'
        printf ' 10. Generar Windows sin pruebas ampliadas\n'
        printf ' 11. Generar Linux y Windows sin pruebas ampliadas\n'
        printf ' 12. Abrir el asistente interactivo completo del builder Linux\n'
        printf ' 13. Versión de depuración sin pruebas (la más rápida, para probarla a mano)\n'
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
            8) run_action 'Compilando frontend y aplicación de escritorio Linux sin empaquetar' node scripts/package-scripts.mjs run tauri -- build --config src-tauri/tauri.linux.conf.json --no-bundle ;;
            9) run_linux_build without-tests ;;
            10) run_windows_cross_build without-tests ;;
            11)
                local args=(--no-run --non-interactive --no-extended-tests --cross-windows)
                if ! ask_yes_no '¿Permitir instalar automáticamente dependencias Linux/MinGW/Wine si faltan?'; then
                    args+=(--no-install)
                fi
                run_action 'Generando Linux y Windows sin pruebas ampliadas' bash linux/build.sh "${args[@]}"
                ;;
            12) run_action 'Asistente interactivo del builder Linux' bash linux/build.sh ;;
            13) run_debug_build ;;
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
        printf '  7. Ejecutar cualquier script npm/pnpm del proyecto\n'
        printf '  0. Volver\n'
        read -r -p 'Elige una opción: ' choice || return
        case "$choice" in
            1) run_action 'Ejecutando validaciones locales' node scripts/package-scripts.mjs run check:local ;;
            2) run_action 'Ejecutando validaciones completas' node scripts/package-scripts.mjs run check ;;
            3) run_action 'Ejecutando pruebas Rust' cargo test --manifest-path src-tauri/Cargo.toml ;;
            4) run_action 'Validando la aplicación ya empaquetada' bash linux/validate-release.sh ;;
            5)
                local default_binary="${E2E_BINARY:-$ROOT/src-tauri/target/release/lterminal}"
                case "$(uname -s 2>/dev/null || true)" in
                    MINGW*|MSYS*|CYGWIN*) default_binary="${E2E_BINARY:-$ROOT/src-tauri/target/release/wterminal.exe}" ;;
                esac
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
                        E2E_BINARY="$binary" TAURI_NATIVE_DRIVER="$driver_path" run_action 'Ejecutando la batería E2E sin recompilar la app' node scripts/package-scripts.mjs run e2e
                    else
                        E2E_BINARY="$binary" run_action 'Ejecutando la batería E2E sin recompilar la app' node scripts/package-scripts.mjs run e2e
                    fi
                fi
                ;;
            6) run_action 'Probando las herramientas del host' bash linux/exercise-host.sh ;;
            7) run_action 'Abriendo el selector dinámico de scripts' node scripts/package-scripts.mjs menu ;;
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


# ===================================================================
# Menú por pasos (22-11, Romen: «modularizar: builds de este sistema, del
# otro, test y firma; al compilar, elegir el tipo de build, las pruebas,
# si se firma y con qué claves, y si se quiere una copia y dónde»).
# ===================================================================

read_default() {
    local prompt="$1" default="$2" answer
    read -r -p "$prompt [$default]: " answer || answer=''
    printf '%s' "${answer:-$default}"
}

# read_option «título» opción1 opción2… → número elegido (1 por defecto).
read_option() {
    local title="$1"
    shift
    local options=("$@") index answer
    printf '\n%s\n' "$title" >&2
    for index in "${!options[@]}"; do printf '  %d. %s\n' "$((index + 1))" "${options[$index]}" >&2; done
    while true; do
        read -r -p 'Elige [1]: ' answer || { printf '1'; return; }
        answer="${answer:-1}"
        if [[ "$answer" =~ ^[0-9]+$ ]] && (( answer >= 1 && answer <= ${#options[@]} )); then
            printf '%s' "$answer"
            return
        fi
        printf 'Opción no válida.\n' >&2
    done
}

build_memory_dir() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/lterminal-build"; }

get_build_memory() {
    local file
    file="$(build_memory_dir)/$1.txt"
    if [[ -s "$file" ]]; then cat "$file"; else printf '%s' "$2"; fi
}

set_build_memory() {
    mkdir -p "$(build_memory_dir)" && printf '%s' "$2" > "$(build_memory_dir)/$1.txt"
}

# Paso «firma»: deja en SIGN_KEYS la carpeta de claves o vacío.
read_signing_choice() {
    SIGN_KEYS=''
    ask_yes_no '¿Firmar la build (SHA256SUMS con Ed25519 y SSH)?' || return 0
    local default
    default="$(get_build_memory keys-dir "$HOME/Escritorio/Claves SSH")"
    while true; do
        SIGN_KEYS="$(read_default 'Carpeta de las claves de firma' "$default")"
        if [[ -d "$SIGN_KEYS" ]]; then set_build_memory keys-dir "$SIGN_KEYS"; return 0; fi
        printf 'No existe la carpeta: %s\n' "$SIGN_KEYS"
    done
}

# Paso «copia»: deja en COPY_DIR la carpeta destino o vacío.
read_copy_choice() {
    COPY_DIR=''
    ask_yes_no '¿Guardar además una copia de la build en otra carpeta?' || return 0
    local base name
    base="$(read_default 'Carpeta donde guardar las copias' "$(get_build_memory copy-dir "$HOME/Builds LTerminal")")"
    set_build_memory copy-dir "$base"
    name="$(read_default 'Nombre de la subcarpeta de esta copia' "$1")"
    COPY_DIR="$base/$name"
}

copy_build_output() {
    [[ -n "$COPY_DIR" ]] || return 0
    mkdir -p "$COPY_DIR"
    local source
    for source in "$@"; do [[ -e "$source" ]] && cp -a "$source" "$COPY_DIR/"; done
    printf 'Copia guardada en %s\n' "$COPY_DIR"
}

# Pruebas tras compilar con dev-test: deja los argumentos en DEVTEST_TESTS.
read_devtest_tests() {
    DEVTEST_TESTS=()
    local choice only repeat
    choice="$(read_option 'Pruebas después de compilar' 'Ninguna (solo compilar)' 'Algunas: las que elijas, N veces' 'Suites enteras (focused, intermitentes, nuevas…)')"
    case "$choice" in
        2)
            node scripts/dev-test.mjs --list
            read -r -p 'Escenarios separados por comas: ' only || return 0
            [[ -n "$only" ]] || return 0
            repeat="$(read_default 'Cuántas veces cada uno' 1)"
            DEVTEST_TESTS=(--only "$only" --repeat "$repeat")
            ;;
        3)
            node scripts/run-e2e-suite.mjs --list | grep -E '^\S'
            DEVTEST_TESTS=(--suite "$(read_default 'Suites separadas por comas' focused)")
            ;;
    esac
}

native_build_wizard() {
    local type label args
    type="$(read_option 'Paso 1 · Tipo de build' \
        'Depuración: la más rápida, sin empaquetar (para probar a mano)' \
        'Rápida: optimizada sin LTO, sin empaquetar' \
        'AppImage rápida (iteración)' \
        'AppImage sin pruebas ampliadas' \
        'AppImage completa (release)')"
    label="$(read_default 'Etiqueta de esta build' "$(date +%Y%m%d-%H%M)")"
    if (( type <= 2 )); then
        local profile=debug
        (( type == 2 )) && profile=fast
        read_devtest_tests
        read_signing_choice
        read_copy_choice "$label"
        args=(scripts/dev-test.mjs --build "$profile" "${DEVTEST_TESTS[@]}")
        if [[ -n "$SIGN_KEYS" ]]; then args+=(--keys-dir "$SIGN_KEYS"); else args+=(--no-sign); fi
        printf '\nResumen: build %s, etiqueta %s, %s%s.\n' "$profile" "$label" "${SIGN_KEYS:+firmada con $SIGN_KEYS}" "${COPY_DIR:+, copia en $COPY_DIR}"
        ask_yes_no '¿Empezar?' || return 0
        run_action "Build $profile $label" node "${args[@]}"
        if [[ "${RUN_ACTION_STATUS:-1}" -eq 0 ]]; then
            printf 'Ejecutable: %s\n' "$ROOT/src-tauri/target/$profile/lterminal"
            copy_build_output "$ROOT/src-tauri/target/$profile/lterminal"
        fi
        return 0
    fi
    args=(--no-run --non-interactive)
    case "$type" in
        3) args+=(--fast --no-extended-tests --skip-checks) ;;
        4) args+=(--no-extended-tests) ;;
        5) args+=(--full-tests) ;;
    esac
    ask_yes_no '¿Permitir instalar automáticamente dependencias del sistema si faltan?' || args+=(--no-install)
    read_signing_choice
    [[ -n "$SIGN_KEYS" ]] && args+=(--keys-dir "$SIGN_KEYS")
    read_copy_choice "$label"
    ask_yes_no '¿Empezar?' || return 0
    run_action "Build $label" bash linux/build.sh "${args[@]}"
    [[ "${RUN_ACTION_STATUS:-1}" -eq 0 ]] && copy_build_output "$ROOT"/release/*
    return 0
}

cross_build_menu() {
    local choice
    choice="$(read_option 'Builds de Windows desde Linux' \
        'Portable Windows (GNU x64)' 'Portable Windows rápida' 'Windows sin pruebas ampliadas' \
        'Compilar Windows y pasar la suite Rust bajo Wine' 'AppImage y además validar Windows bajo Wine')"
    case "$choice" in
        1) run_windows_cross_build full ;;
        2) run_windows_cross_build fast ;;
        3) run_windows_cross_build without-tests ;;
        4) run_windows_cross_build wine-tests ;;
        5)
            local args=(--no-run --non-interactive --full-tests --cross-windows)
            ask_yes_no '¿Permitir instalar automáticamente dependencias Linux/MinGW/Wine si faltan?' || args+=(--no-install)
            run_action 'Generando AppImage y validando Windows bajo Wine' bash linux/build.sh "${args[@]}"
            ;;
    esac
}

test_build_menu() {
    local candidates=() names=() path choice binary what suite only repeat
    for path in "$ROOT/src-tauri/target/debug/lterminal" "$ROOT/src-tauri/target/fast/lterminal" "$ROOT/src-tauri/target/release/lterminal"; do
        [[ -f "$path" ]] && candidates+=("$path") && names+=("$path ($(date -r "$path" '+%d/%m %H:%M'))")
    done
    names+=('Otra ruta…')
    choice="$(read_option 'Paso 1 · Qué build probar' "${names[@]}")"
    if (( choice <= ${#candidates[@]} )); then binary="${candidates[$((choice - 1))]}"; else read -r -p 'Ruta al ejecutable: ' binary || return 0; fi
    [[ -f "$binary" ]] || { printf 'No existe: %s\n' "$binary"; pause_menu; return 0; }
    what="$(read_option 'Paso 2 · Qué pruebas' \
        'Regresiones enfocadas (focused)' 'Recorrido completo (full)' \
        'Las que alguna vez fallaron, 5 veces (intermitentes)' 'Pruebas nuevas en rodaje (nuevas)' \
        'Escenarios concretos, N veces')"
    case "$what" in
        5)
            node scripts/dev-test.mjs --list
            read -r -p 'Escenarios separados por comas: ' only || return 0
            [[ -n "$only" ]] || return 0
            repeat="$(read_default 'Cuántas veces cada uno' 1)"
            run_action 'Escenarios concretos' node scripts/dev-test.mjs --binary "$binary" --only "$only" --repeat "$repeat"
            ;;
        *)
            suite=(focused full intermitentes nuevas)
            run_action "Suite ${suite[$((what - 1))]}" node scripts/run-e2e-suite.mjs --binary "$binary" --suite "${suite[$((what - 1))]}"
            ;;
    esac
}

sign_menu() {
    local choice dir files out
    choice="$(read_option 'Qué firmar' 'La release de release/ (todos sus paquetes)' 'Otra carpeta (sus AppImage, .exe, .zip…)' 'Archivos concretos')"
    read_signing_choice
    [[ -n "$SIGN_KEYS" ]] || { printf 'Sin claves no se firma.\n'; pause_menu; return 0; }
    case "$choice" in
        1) run_action 'Firmando la build' node scripts/sign-build.mjs --dir "$ROOT/release" --keys-dir "$SIGN_KEYS" ;;
        2) read -r -p 'Carpeta: ' dir || return 0; run_action 'Firmando la build' node scripts/sign-build.mjs --dir "$dir" --keys-dir "$SIGN_KEYS" ;;
        3)
            read -r -p 'Archivos separados por comas: ' files || return 0
            out="$(read_default 'Dónde dejar SHA256SUMS y las firmas' "$(dirname "${files%%,*}")")"
            run_action 'Firmando la build' node scripts/sign-build.mjs --files "$files" --out "$out" --keys-dir "$SIGN_KEYS"
            ;;
    esac
}

while true; do
    printf '\nLTerminal — desarrollo y compilación\n'
    printf '  1. Compilar para Linux (paso a paso: tipo, pruebas, firma y copia)\n'
    printf '  2. Compilar para Windows\n'
    printf '  3. Probar una build ya compilada (sin recompilar)\n'
    printf '  4. Firmar una build ya compilada\n'
    printf '  5. Pruebas del código (comprobaciones, Rust, lógica) y otras\n'
    printf '  6. Desarrollo y preview\n'
    printf '  7. Limpiar cachés y builds temporales\n'
    printf '  8. Todas las opciones de compilar de antes\n'
    printf '  9. Configurar firma SSH de commits para GitHub\n'
    printf '  0. Salir\n'
    read -r -p 'Elige una opción: ' choice || break
    case "$choice" in
        1) native_build_wizard; pause_menu ;;
        2) cross_build_menu ;;
        3) test_build_menu ;;
        4) sign_menu ;;
        5) tests_menu ;;
        6) development_menu ;;
        7) clean_menu ;;
        8) build_menu ;;
        9) run_action 'Configurando la firma de commits en este repositorio' bash "$ROOT/build-tools/configure-git-signing.sh" --repo "$ROOT" ;;
        0) break ;;
        *) printf 'Opción no válida.\n' ;;
    esac
done
