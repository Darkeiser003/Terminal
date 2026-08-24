#!/usr/bin/env bash
#
# Compila la carpeta desempaquetada de Windows desde Linux.
#
# Es una build de compatibilidad x86_64-pc-windows-gnu: sirve para validar la
# aplicación y ejecutar un smoke bajo Wine. La release oficial de Windows debe
# seguir produciéndose en Windows con windows/build.ps1, porque el toolchain
# MSVC y el empaquetado nativo no se pueden validar completamente desde Linux.
# El smoke bajo Wine necesita un prefijo que ya tenga WebView2 Runtime. Se puede
# indicar con WINE_SMOKE_PREFIX=/ruta/al/prefijo; crear un prefijo temporal no
# instala WebView2 y no es una prueba válida de la interfaz.

if [ -z "${BASH_VERSION:-}" ]; then
    echo "ERROR: este script necesita bash. Ejecútalo con ./build-windows.sh." >&2
    exit 1
fi

set -Eeuo pipefail
export NPM_CONFIG_LOGLEVEL=error
export CARGO_TERM_QUIET="${CARGO_TERM_QUIET:-true}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TAURI_DIR="$PROJECT_ROOT/src-tauri"
TARGET="x86_64-pc-windows-gnu"
# Mantener la compilación cruzada en un target separado evita que Cargo espere
# por el lock de una build Linux que use el mismo target/release. También hace
# que dos builds de plataformas distintas no compartan artefactos parciales.
WINDOWS_TARGET_DIR="${LTERMINAL_WINDOWS_TARGET_DIR:-$TAURI_DIR/target/windows-cross}"
RELEASE_DIR="$WINDOWS_TARGET_DIR/$TARGET/release"
EXE="$RELEASE_DIR/winslim-terminal.exe"

AUTO_INSTALL=1
RUN_WINE=0
WINE_REPEATS=1
SKIP_CHECKS=0
CLEAN=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-install) AUTO_INSTALL=0 ;;
        --wine-smoke|--smoke) RUN_WINE=1 ;;
        --full-tests|--extended-tests)
            RUN_WINE=1
            WINE_REPEATS=3
            ;;
        --wine-repeats)
            shift
            if [ "$#" -eq 0 ] || ! [[ "$1" =~ ^[1-9][0-9]*$ ]] || [ "$1" -gt 10 ]; then
                echo "--wine-repeats necesita un número entre 1 y 10." >&2
                exit 2
            fi
            WINE_REPEATS="$1"
            RUN_WINE=1
            ;;
        --wine-repeats=*)
            WINE_REPEATS="${1#*=}"
            if ! [[ "$WINE_REPEATS" =~ ^[1-9][0-9]*$ ]] || [ "$WINE_REPEATS" -gt 10 ]; then
                echo "--wine-repeats necesita un número entre 1 y 10." >&2
                exit 2
            fi
            RUN_WINE=1
            ;;
        --skip-checks) SKIP_CHECKS=1 ;;
        --clean) CLEAN=1 ;;
        -h|--help)
            echo "Uso: $0 [--wine-smoke|--smoke|--full-tests] [--wine-repeats N] [--skip-checks] [--no-install] [--clean]"
            exit 0
            ;;
        *)
            echo "Argumento desconocido: $1" >&2
            exit 2
            ;;
    esac
    shift
done

step() { printf '\n==> %s\n' "$1"; }
ok() { printf '    OK: %s\n' "$1"; }
warn() { printf '    AVISO: %s\n' "$1" >&2; }
fail() { printf '    ERROR: %s\n' "$1" >&2; exit 1; }

package_manager() {
    local manager
    for manager in apt-get dnf pacman zypper apk; do
        command -v "$manager" >/dev/null 2>&1 && { echo "$manager"; return 0; }
    done
    return 1
}

run_as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        fail "Hace falta sudo para instalar dependencias del sistema."
    fi
}

install_cross_tools() {
    [ "$AUTO_INSTALL" -eq 1 ] || return 1
    local manager
    manager="$(package_manager)" || return 1
    warn "Falta el toolchain MinGW; se instalará con $manager."
    case "$manager" in
        apt-get)
            run_as_root apt-get update
            run_as_root apt-get install -y --no-install-recommends \
                gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 \
                binutils-mingw-w64-x86-64
            ;;
        dnf)
            run_as_root dnf install -y mingw64-gcc mingw64-gcc-c++ mingw64-binutils
            ;;
        pacman)
            # No actualiza todo el sistema durante una build: es innecesario
            # para MinGW y puede cambiar la ABI mientras Cargo enlaza.
            run_as_root pacman -S --needed --noconfirm mingw-w64-gcc
            ;;
        zypper)
            run_as_root zypper --non-interactive install -y \
                mingw64-cross-gcc mingw64-cross-binutils
            ;;
        apk)
            run_as_root apk add mingw-w64-gcc mingw-w64-binutils
            ;;
    esac
}

install_wine() {
    [ "$AUTO_INSTALL" -eq 1 ] || return 1
    local manager
    manager="$(package_manager)" || return 1
    warn "Falta Wine; se instalará para el smoke de Windows."
    case "$manager" in
        apt-get) run_as_root apt-get update; run_as_root apt-get install -y wine64 ;;
        dnf) run_as_root dnf install -y wine ;;
        pacman) run_as_root pacman -S --needed --noconfirm wine ;;
        zypper) run_as_root zypper --non-interactive install -y wine ;;
        apk) run_as_root apk add wine ;;
    esac
}

ensure_node_and_rust() {
    command -v node >/dev/null 2>&1 || fail "Falta Node.js >= 22.12. Ejecuta linux/build.sh para instalar el toolchain base."
    command -v npm >/dev/null 2>&1 || fail "Falta npm junto a Node.js."
    command -v cargo >/dev/null 2>&1 || fail "Falta Cargo. Ejecuta linux/build.sh para instalar el toolchain base."
    local node_version node_major node_minor
    node_version="$(node -p 'process.versions.node')"
    node_major="${node_version%%.*}"
    node_minor="${node_version#*.}"; node_minor="${node_minor%%.*}"
    if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
        fail "Node.js $node_version es demasiado antiguo; hace falta >= 22.12."
    fi
    ok "Node.js $node_version y $(cargo --version)"
}

ensure_mingw() {
    if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
        install_cross_tools || fail "Falta x86_64-w64-mingw32-gcc y no se pudo instalar automáticamente."
    fi
    command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || fail "No se encontró x86_64-w64-mingw32-gcc."
    ok "MinGW disponible"
}

ensure_target() {
    if ! rustup target list --installed 2>/dev/null | grep -Fxq "$TARGET"; then
        command -v rustup >/dev/null 2>&1 || fail "Falta rustup para instalar el target $TARGET."
        [ "$AUTO_INSTALL" -eq 1 ] || fail "Falta el target $TARGET; reintenta sin --no-install."
        rustup target add "$TARGET"
    fi
    ok "Target Rust $TARGET disponible"
}

run_wine_smoke() {
    if ! command -v wine >/dev/null 2>&1; then
        install_wine || fail "Se pidió --wine-smoke, pero Wine no está instalado."
    fi
    command -v wine >/dev/null 2>&1 || fail "No se encontró Wine para ejecutar el smoke."

    local prefix smoke_dir smoke_log code owns_prefix webview_key
    owns_prefix=0
    if [ -n "${WINE_SMOKE_PREFIX:-}" ]; then
        prefix="$WINE_SMOKE_PREFIX"
        [ -d "$prefix" ] || fail "WINE_SMOKE_PREFIX no existe: $prefix"
    else
        smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/lterminal-wine-smoke.XXXXXX")"
        prefix="$smoke_dir/prefix"
        smoke_log="$smoke_dir/wine.log"
        mkdir -p "$prefix"
        owns_prefix=1
    fi
    smoke_log="${smoke_log:-$(mktemp "${TMPDIR:-/tmp}/lterminal-wine-smoke-log.XXXXXX")}"

    webview_key=''
    for candidate in \
        'HKLM\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
        'HKLM\\Software\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
        'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; do
        if WINEPREFIX="$prefix" WINEDEBUG=-all wine reg query "$candidate" /v pv >/dev/null 2>&1; then
            webview_key="$candidate"
            break
        fi
    done
    if [ -z "$webview_key" ]; then
        [ "$owns_prefix" -eq 1 ] && rm -rf "$smoke_dir"
        [ "$owns_prefix" -eq 0 ] && rm -f "$smoke_log"
        fail "El prefijo Wine no tiene WebView2 Runtime. Instálalo en el mismo prefijo y reintenta con WINE_SMOKE_PREFIX=/ruta/al/prefijo; WebView2Loader.dll no sustituye al runtime."
    fi

    warn "Smoke Windows bajo Wine: el proceso se mantiene abierto hasta el timeout si la ventana carga correctamente."
    set +e
    WINEPREFIX="$prefix" WINEDEBUG=+loaddll timeout --foreground 20s wine "Z:${EXE//\//\\}" >"$smoke_log" 2>&1
    code=$?
    set -e
    if [ "$code" -ne 0 ] && [ "$code" -ne 124 ]; then
        sed 's/^/      /' "$smoke_log" >&2 || true
        [ "$owns_prefix" -eq 1 ] && rm -rf "$smoke_dir"
        [ "$owns_prefix" -eq 0 ] && rm -f "$smoke_log"
        fail "El ejecutable Windows terminó bajo Wine con código $code."
    fi
    if ! grep -Eiq 'WebView2Loader(\.dll)?' "$smoke_log"; then
        sed 's/^/      /' "$smoke_log" >&2 || true
        [ "$owns_prefix" -eq 1 ] && rm -rf "$smoke_dir"
        [ "$owns_prefix" -eq 0 ] && rm -f "$smoke_log"
        fail "Wine mantuvo el proceso, pero no llegó a cargar WebView2Loader.dll."
    fi
    [ "$owns_prefix" -eq 1 ] && rm -rf "$smoke_dir"
    [ "$owns_prefix" -eq 0 ] && rm -f "$smoke_log"
    ok "Smoke Windows bajo Wine completado (código $code)"
}

cd "$PROJECT_ROOT"
step "Comprobando requisitos Windows desde Linux"
ensure_node_and_rust
ensure_mingw
ensure_target

if [ "$CLEAN" -eq 1 ]; then
    step "Limpiando solo la salida Windows"
    rm -rf "$WINDOWS_TARGET_DIR"
fi

if [ "$SKIP_CHECKS" -eq 0 ]; then
    unset LTERMINAL_SKIP_CHECKS
    step "Ejecutando comprobaciones del proyecto"
    npm run check
else
    export LTERMINAL_SKIP_CHECKS=1
    warn "Comprobaciones omitidas: el frontend se seguirá compilando, pero se omitirán las comprobaciones externas y svelte-check."
fi

step "Compilando WinSlim Terminal ($TARGET)"
# Esta ruta usa Cargo directamente en lugar de `tauri build`, por lo que debe
# reproducir explícitamente los dos pasos que el bundler hace por configuración:
# generar `dist` y activar `tauri/custom-protocol`. Sin esto el EXE arranca,
# pero intenta abrir localhost y la VM muestra una página de conexión rechazada.
npm run build
# MinGW puede intentar exportar símbolos internos de Rust hasta superar el
# límite de ordinales PE. No cambia la interfaz del ejecutable: solo evita que
# el enlazador publique esos símbolos privados como exports.
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=-Wl,--exclude-all-symbols"
export CARGO_TARGET_DIR="$WINDOWS_TARGET_DIR"
# Para esta validación no necesitamos el bundler de Tauri: Cargo ejecuta el
# build.rs, genera el PE y copia conpty/OpenConsole/WebView2Loader. Usar Cargo
# directamente evita que `tauri build --no-bundle` deje su proceso abierto
# después de que el ejecutable ya esté terminado.
cargo build --manifest-path "$TAURI_DIR/Cargo.toml" \
    --release --target "$TARGET" --bin winslim-terminal \
    --features tauri/custom-protocol

[ -f "$EXE" ] || fail "No se generó $EXE."
for asset in conpty.dll OpenConsole.exe WebView2Loader.dll; do
    [ -f "$RELEASE_DIR/$asset" ] || fail "Falta el recurso Windows $asset junto al ejecutable."
done
# La build cruzada no usa el bundler NSIS, así que replica el árbol de recursos
# que la build nativa copia a la carpeta portable. Sin esto el ejecutable abre,
# pero la Biblioteca no encuentra los scripts integrados bajo resource_dir/scripts.
for resource in \
    scripts/containers/docker-manager.sh \
    scripts/containers/kubernetes-manager.sh \
    scripts/operations/docker-manager.ps1 \
    scripts/operations/kubernetes-manager.ps1 \
    scripts/operations/ssh-manager.sh \
    scripts/operations/service-manager.sh \
    scripts/operations/network-manager.sh \
    scripts/operations/adb-manager.sh \
    scripts/operations/ssh-manager.ps1 \
    scripts/operations/service-manager.ps1 \
    scripts/operations/network-manager.ps1 \
    scripts/operations/adb-manager.ps1; do
    [ -f "$PROJECT_ROOT/$resource" ] || fail "Falta el recurso empaquetable $resource."
    mkdir -p "$RELEASE_DIR/$(dirname "$resource")"
    cp "$PROJECT_ROOT/$resource" "$RELEASE_DIR/$resource"
done
if command -v file >/dev/null 2>&1; then
    file "$EXE" | grep -Eq 'PE32\+.*x86-64' || fail "$EXE no parece un ejecutable Windows x64."
fi
ok "Ejecutable Windows y recursos runtime verificados en $RELEASE_DIR"
node "$PROJECT_ROOT/scripts/verify-release-artifacts.mjs" \
    --windows "$EXE" \
    --windows-dir "$RELEASE_DIR"
ok "Estructura PE x64 y runtime Windows verificados"

if [ "$RUN_WINE" -eq 1 ]; then
    for attempt in $(seq 1 "$WINE_REPEATS"); do
        step "Ejecutando smoke Windows bajo Wine ($attempt/$WINE_REPEATS)"
        run_wine_smoke
    done
fi

printf '\nBuild Windows cruzada completada: %s\n' "$EXE"
