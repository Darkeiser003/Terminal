#!/usr/bin/env bash
#
# Compila la carpeta desempaquetada de Windows desde Linux.
#
# Es una build de compatibilidad x86_64-pc-windows-gnu: sirve para validar la
# aplicación y ejecutar un smoke bajo Wine. La release oficial de Windows debe
# seguir produciéndose en Windows con windows/build.ps1, porque el toolchain
# MSVC y el empaquetado nativo no se pueden validar completamente desde Linux.
# El smoke headless no necesita WebView2 Runtime; el smoke GUI opcional localiza
# automáticamente un prefijo y, si no existe, prepara uno privado persistente
# en la caché del usuario. WINE_SMOKE_PREFIX sigue permitiendo fijarlo.
# También se admite Proton con LTERMINAL_WINE_RUNNER=proton y
# LTERMINAL_PROTON=/ruta/al/proton. Proton usa un compatdata aislado para no
# mezclar su wineserver con una sesión Wine normal.

if [ -z "${BASH_VERSION:-}" ]; then
    echo "ERROR: este script necesita bash. Ejecútalo con ./build-windows.sh." >&2
    exit 1
fi

set -Eeuo pipefail
export NPM_CONFIG_LOGLEVEL=error
export CARGO_TERM_QUIET="${CARGO_TERM_QUIET:-true}"
# LTO y la batería PE bajo Wine consumen mucha memoria por unidad de trabajo.
# Un único job es el valor seguro para equipos de 16 GiB; quien tenga margen
# puede elevarlo explícitamente sin perder la reproducibilidad del script.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TAURI_DIR="$PROJECT_ROOT/src-tauri"
TARGET="x86_64-pc-windows-gnu"
# Mantener la compilación cruzada en un target separado evita que Cargo espere
# por el lock de una build Linux que use el mismo target/release. También hace
# que dos builds de plataformas distintas no compartan artefactos parciales.
WINDOWS_TARGET_DIR="${LTERMINAL_WINDOWS_TARGET_DIR:-$TAURI_DIR/target/windows-cross}"
RELEASE_DIR="$WINDOWS_TARGET_DIR/$TARGET/release"
EXE="$RELEASE_DIR/wterminal.exe"

AUTO_INSTALL=1
RUN_WINE=0
RUN_WINE_TESTS=0
WINE_REPEATS=1
WINE_RUNNER="${LTERMINAL_WINE_RUNNER:-wine}"
WEBVIEW2_INSTALL_URL="https://go.microsoft.com/fwlink/p/?LinkId=2124703"
WEBVIEW2_CACHE_ROOT="${LTERMINAL_WEBVIEW2_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/lterminal/webview2}"
SKIP_CHECKS=0
ALLOW_OFFLINE_CHECKS=0
CLEAN=0
FAST_BUILD=0
NON_INTERACTIVE=0
VERSION_OVERRIDE=""
CURRENT_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT_ROOT/package.json" | head -n 1)"
CURRENT_VERSION="${CURRENT_VERSION:-1.0.0}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-install) AUTO_INSTALL=0 ;;
        --wine-smoke|--smoke) RUN_WINE=1 ;;
        --wine-rust-tests) RUN_WINE_TESTS=1 ;;
        --full-tests|--extended-tests)
            RUN_WINE=1
            RUN_WINE_TESTS=1
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
        --allow-offline-checks) ALLOW_OFFLINE_CHECKS=1 ;;
        --clean) CLEAN=1 ;;
        --fast) FAST_BUILD=1 ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        --version)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ] || [[ "$1" == -* ]]; then
                echo "--version necesita un valor SemVer, por ejemplo 1.0.0." >&2
                exit 2
            fi
            VERSION_OVERRIDE="$1"
            ;;
        --version=*)
            VERSION_OVERRIDE="${1#*=}"
            [ -n "$VERSION_OVERRIDE" ] || { echo "--version necesita un valor SemVer, por ejemplo 1.0.0." >&2; exit 2; }
            ;;
        -h|--help)
            echo "Uso: $0 [--version X.Y.Z] [--fast] [--wine-rust-tests|--wine-smoke|--smoke|--full-tests] [--wine-repeats N] [--skip-checks] [--allow-offline-checks] [--no-install] [--clean] [--non-interactive]"
            exit 0
            ;;
        *)
            echo "Argumento desconocido: $1" >&2
            exit 2
            ;;
    esac
    shift
done

# La versión se decide antes de comprobar o instalar dependencias. El cambio
# del package.json se aplica más abajo, cuando Node ya ha sido validado; así un
# --version erróneo no deja una edición parcial si el host carece del toolchain.
if [ -z "$VERSION_OVERRIDE" ]; then
    if [ "$NON_INTERACTIVE" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
        printf 'Versión de release [%s]: ' "$CURRENT_VERSION"
        IFS= read -r VERSION_OVERRIDE
        VERSION_OVERRIDE="${VERSION_OVERRIDE:-$CURRENT_VERSION}"
    else
        VERSION_OVERRIDE="$CURRENT_VERSION"
    fi
fi
printf 'Versión seleccionada: %s\n' "$VERSION_OVERRIDE"
if ! [[ "$VERSION_OVERRIDE" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
    echo "La versión indicada no es SemVer válida: $VERSION_OVERRIDE" >&2
    exit 2
fi

# Se mantiene --release para que la salida cruzada conserve su estructura y
# los verificadores de PE/runtime sigan encontrando el ejecutable. El perfil
# rápido solo cambia los ajustes de Cargo; no altera el target Windows ni el
# empaquetado de recursos.
configure_cargo_profile() {
    if [ "$FAST_BUILD" -eq 1 ]; then
        export CARGO_PROFILE_RELEASE_OPT_LEVEL=1
        export CARGO_PROFILE_RELEASE_LTO=false
        export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256
        export CARGO_PROFILE_RELEASE_STRIP=none
        export CARGO_PROFILE_RELEASE_DEBUG=1
        export CARGO_PROFILE_RELEASE_INCREMENTAL=true
        export CARGO_PROFILE_RELEASE_PANIC=unwind
        ok "Perfil de desarrollo rápido Windows: incremental, sin LTO y con símbolos"
    else
        export CARGO_PROFILE_RELEASE_OPT_LEVEL=s
        export CARGO_PROFILE_RELEASE_LTO=true
        export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
        export CARGO_PROFILE_RELEASE_STRIP=true
        export CARGO_PROFILE_RELEASE_DEBUG=0
        export CARGO_PROFILE_RELEASE_INCREMENTAL=false
        export CARGO_PROFILE_RELEASE_PANIC=abort
        ok "Perfil release Windows comprimido: LTO completo y símbolos eliminados"
    fi
}

step() { printf '\n==> %s\n' "$1"; }
ok() { printf '    OK: %s\n' "$1"; }
warn() { printf '    AVISO: %s\n' "$1" >&2; }
fail() { printf '    ERROR: %s\n' "$1" >&2; exit 1; }

VERSION_BACKUP_DIR=""
version_manifest_paths=(
    "$PROJECT_ROOT/package.json"
    "$PROJECT_ROOT/package-lock.json"
    "$TAURI_DIR/Cargo.toml"
    "$TAURI_DIR/Cargo.lock"
)

backup_version_manifests() {
    [ -n "$VERSION_BACKUP_DIR" ] && return 0
    VERSION_BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lterminal-version-backup.XXXXXX")"
    local path
    for path in "${version_manifest_paths[@]}"; do
        [ -f "$path" ] || fail "No existe el manifiesto de versión $path."
        cp -p "$path" "$VERSION_BACKUP_DIR/$(basename "$path")" || {
            rm -rf "$VERSION_BACKUP_DIR"
            VERSION_BACKUP_DIR=""
            fail "No se pudo guardar el manifiesto de versión $path."
        }
    done
}

restore_version_manifests() {
    [ -n "$VERSION_BACKUP_DIR" ] || return 0
    local path name restore_failed=0
    if [ ! -d "$VERSION_BACKUP_DIR" ]; then
        warn "No está disponible la copia de seguridad de los manifiestos: $VERSION_BACKUP_DIR"
        return 1
    fi
    for path in "${version_manifest_paths[@]}"; do
        name="$(basename "$path")"
        if [ ! -f "$VERSION_BACKUP_DIR/$name" ]; then
            warn "Falta la copia de seguridad del manifiesto de versión $path ($VERSION_BACKUP_DIR/$name)"
            restore_failed=1
            continue
        fi
        if ! cp -p "$VERSION_BACKUP_DIR/$name" "$path" ||
            ! cmp -s "$VERSION_BACKUP_DIR/$name" "$path"; then
            warn "No se pudo verificar la restauración del manifiesto de versión $path"
            restore_failed=1
        fi
    done
    if [ "$restore_failed" -ne 0 ]; then
        warn "La copia de seguridad queda disponible en $VERSION_BACKUP_DIR para recuperar los manifiestos."
        return 1
    fi
    rm -rf "$VERSION_BACKUP_DIR" || {
        warn "No se pudo eliminar la copia temporal de manifiestos: $VERSION_BACKUP_DIR"
        return 1
    }
    VERSION_BACKUP_DIR=""
}

on_exit() {
    local exit_code=$?
    if ! restore_version_manifests; then
        # Un trap EXIT ignora el valor retornado por su función si el proceso
        # iba a salir con 0; forzar el código evita anunciar éxito con cambios.
        exit 1
    fi
    return "$exit_code"
}
trap on_exit EXIT

if [ "$ALLOW_OFFLINE_CHECKS" -eq 1 ]; then
    export LTERMINAL_LINK_CHECK=warn
    export LTERMINAL_INSTALL_SOURCE_CHECK=warn
    export LTERMINAL_WINGET_CHECK=warn
    warn "Comprobaciones externas en modo aviso; se mantienen las comprobaciones locales."
fi

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

ensure_zip() {
    if ! command -v zip >/dev/null 2>&1; then
        [ "$AUTO_INSTALL" -eq 1 ] || fail "Falta la herramienta zip; instálala antes de generar la release portable Windows."
        local manager
        manager="$(package_manager)" || fail "Falta zip y no se reconoce cómo instalarlo automáticamente."
        warn "Falta zip; se instalará con $manager antes de compilar."
        case "$manager" in
            apt-get) run_as_root apt-get install -y zip ;;
            dnf) run_as_root dnf install -y zip ;;
            pacman) run_as_root pacman -S --needed --noconfirm zip ;;
            zypper) run_as_root zypper --non-interactive install -y zip ;;
            apk) run_as_root apk add zip ;;
            *) fail "No se sabe instalar zip con $manager." ;;
        esac
    fi
    command -v zip >/dev/null 2>&1 || fail "No se encontró zip después de comprobar/instalar las dependencias."
    zip -v >/dev/null 2>&1 || fail "La herramienta zip encontrada no se pudo ejecutar correctamente."
    ok "Herramienta zip disponible para empaquetar la release portable"
}

load_local_signing_material() {
    # Igual que linux/build.sh: CI usa únicamente secretos inyectados, mientras
    # las builds locales pueden reutilizar la clave privada fuera del checkout.
    [ -n "${CI:-}" ] && return 0
    local config_root="${XDG_CONFIG_HOME:-${HOME:-}}"
    local private_path="${LTERMINAL_SIGNING_PRIVATE_KEY_FILE:-}"
    local public_path="${LTERMINAL_UPDATE_PUBLIC_KEY_FILE:-}"
    if [ -z "$private_path" ] && [ -n "$config_root" ]; then
        private_path="$config_root/lterminal/release-signing-private.pem"
    fi
    if [ -z "$public_path" ] && [ -n "$config_root" ]; then
        public_path="$config_root/lterminal/release-signing-public.hex"
    fi
    if [ -z "${LTERMINAL_SIGNING_PRIVATE_KEY:-}" ] && [ -n "$private_path" ] && [ -r "$private_path" ]; then
        LTERMINAL_SIGNING_PRIVATE_KEY="$(< "$private_path")"
        export LTERMINAL_SIGNING_PRIVATE_KEY
    fi
    if [ -z "${LTERMINAL_UPDATE_PUBLIC_KEY:-}" ] && [ -n "$public_path" ] && [ -r "$public_path" ]; then
        LTERMINAL_UPDATE_PUBLIC_KEY="$(tr -d '[:space:]' < "$public_path")"
        export LTERMINAL_UPDATE_PUBLIC_KEY
    fi
}

validate_release_signing() {
    local required="${LTERMINAL_REQUIRE_SIGNING:-${CI:-0}}"
    if [ -n "${LTERMINAL_SIGNING_PRIVATE_KEY:-}" ]; then
        [ -n "${LTERMINAL_UPDATE_PUBLIC_KEY:-}" ] || fail "Hay clave privada configurada pero falta LTERMINAL_UPDATE_PUBLIC_KEY para verificar la firma."
    elif [[ "$required" =~ ^(1|true|yes)$ ]]; then
        fail "Falta LTERMINAL_SIGNING_PRIVATE_KEY: no se puede publicar una release oficial sin firma."
    fi
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

run_wine_rust_tests() {
    if ! command -v wine >/dev/null 2>&1; then
        install_wine || fail "Se pidieron tests Windows, pero Wine no está instalado."
    fi
    command -v wine >/dev/null 2>&1 || fail "No se encontró Wine para ejecutar los tests Windows."

    local runtime_dir wine_runtime_dir timeout_seconds wine_test_prefix
    runtime_dir="$WINDOWS_TARGET_DIR/$TARGET/release"
    wine_runtime_dir="Z:${runtime_dir//\//\\}"
    # La batería debía heredar WINEPREFIX del shell: si no estaba definido,
    # Wine usaba ~/.wine aunque el smoke de la misma build tuviera un prefijo
    # dedicado. Compartir la resolución evita tocar perfiles ajenos y garantiza
    # que los tests y el smoke parten de la misma instalación controlada.
    wine_test_prefix="${WINE_SMOKE_PREFIX:-${WINEPREFIX:-$HOME/.cache/lterminal/wine-smoke-prefix}}"
    mkdir -p "$wine_test_prefix"
    warn "Prefijo Wine para la batería Rust: $wine_test_prefix"
    # En un target release frío, compilar el ejecutable PE de tests puede tardar
    # bastante más que ejecutarlos; deja margen sin exigir ajuste manual.
    timeout_seconds="${LTERMINAL_WINE_TEST_TIMEOUT:-1800}"
    [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || fail "LTERMINAL_WINE_TEST_TIMEOUT debe ser un número positivo de segundos."
    if WINEPREFIX="$wine_test_prefix" \
        LTERMINAL_TEST_UNDER_WINE=1 \
        WINEDEBUG=-all \
        WINEPATH="$wine_runtime_dir" \
        CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER=wine \
        timeout --foreground "${timeout_seconds}s" \
        env CARGO_TERM_QUIET=false \
        cargo test --manifest-path "$TAURI_DIR/Cargo.toml" \
            --target "$TARGET" --release --features tauri/custom-protocol \
            -- --test-threads=1; then
        return 0
    else
        local test_status=$?
        if [ "$test_status" -eq 124 ]; then
            fail "La batería Rust Windows bajo Wine superó ${timeout_seconds}s, incluida la compilación del ejecutable de tests; ajusta LTERMINAL_WINE_TEST_TIMEOUT si el target está frío."
        fi
        return "$test_status"
    fi
}

webview2_registry_key() {
    local prefix="$1" candidate
    for candidate in \
        'HKLM\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
        'HKLM\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
        'HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; do
        if WINEPREFIX="$prefix" WINEDEBUG=-all \
            timeout --foreground 15s wine reg query "$candidate" /v pv >/dev/null 2>&1; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

prefix_has_webview2() {
    local prefix="$1" registry
    # Las colmenas de Wine son texto: evitamos arrancar un wineserver por cada
    # prefijo de Steam/Lutris que se inspecciona durante la autodetección.
    for registry in "$prefix/system.reg" "$prefix/user.reg"; do
        if [ -f "$registry" ] && grep -Eiq 'F3017226-FE2A-4295-8BDF-00C3A9A7E4C5' "$registry"; then
            return 0
        fi
    done
    return 1
}

download_webview2_installer() {
    local installer="$WEBVIEW2_CACHE_ROOT/MicrosoftEdgeWebview2Setup.exe"
    local temporary
    mkdir -p "$WEBVIEW2_CACHE_ROOT"
    if [ -s "$installer" ] && [ "$(stat -c '%s' "$installer" 2>/dev/null || echo 0)" -gt 100000 ]; then
        printf '%s\n' "$installer"
        return 0
    fi
    temporary="$(mktemp "$WEBVIEW2_CACHE_ROOT/.webview2-download.XXXXXX")"
    warn "WebView2 Runtime no encontrado; descargándolo desde Microsoft para el smoke Wine."
    if command -v curl >/dev/null 2>&1; then
        if ! curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
            "$WEBVIEW2_INSTALL_URL" -o "$temporary"; then
            rm -f "$temporary"
            fail "No se pudo descargar WebView2 Runtime desde Microsoft."
        fi
    elif command -v wget >/dev/null 2>&1; then
        if ! wget --tries=3 --timeout=20 -O "$temporary" "$WEBVIEW2_INSTALL_URL"; then
            rm -f "$temporary"
            fail "No se pudo descargar WebView2 Runtime desde Microsoft."
        fi
    else
        rm -f "$temporary"
        fail "Para instalar WebView2 automáticamente hace falta curl o wget."
    fi
    if [ "$(stat -c '%s' "$temporary" 2>/dev/null || echo 0)" -le 100000 ]; then
        rm -f "$temporary"
        fail "La descarga de WebView2 Runtime parece incompleta."
    fi
    mv -f "$temporary" "$installer"
    printf '%s\n' "$installer"
}

install_webview2_in_prefix() {
    local prefix="$1" installer
    [ "${LTERMINAL_WINE_WEBVIEW2_AUTO_INSTALL:-1}" != "0" ] || \
        fail "No hay WebView2 Runtime y su instalación automática está desactivada (LTERMINAL_WINE_WEBVIEW2_AUTO_INSTALL=0)."
    [ -n "$prefix" ] || fail "No se pudo determinar el prefijo Wine para instalar WebView2 Runtime."
    mkdir -p "$prefix"
    installer="$(download_webview2_installer)"
    warn "Inicializando el prefijo Wine para instalar WebView2 Runtime: $prefix"
    if [ -f "$prefix/system.reg" ]; then
        if ! WINEPREFIX="$prefix" WINEDEBUG=-all \
            timeout --foreground 120s wineboot -u >/dev/null 2>&1; then
            fail "Wine no pudo inicializar el prefijo para WebView2: $prefix"
        fi
    elif ! WINEPREFIX="$prefix" WINEARCH=win64 WINEDEBUG=-all \
        timeout --foreground 120s wineboot -u >/dev/null 2>&1; then
        fail "Wine no pudo inicializar el prefijo para WebView2: $prefix"
    fi
    warn "Instalando WebView2 Runtime en el prefijo Wine (puede tardar unos segundos)."
    if ! WINEPREFIX="$prefix" WINEDEBUG=-all \
        timeout --foreground 300s wine "$installer" /silent /install >/dev/null 2>&1; then
        fail "Wine no pudo instalar WebView2 Runtime en: $prefix"
    fi
    for _ in $(seq 1 30); do
        prefix_has_webview2 "$prefix" && {
            ok "WebView2 Runtime preparado automáticamente en $prefix" >&2
            return 0
        }
        sleep 1
    done
    fail "El instalador terminó, pero Wine no registró WebView2 Runtime en: $prefix"
}

prepare_wine_webview2_prefix() {
    local requested candidate
    requested="${WINE_SMOKE_PREFIX:-${WINEPREFIX:-}}"
    if [ -n "$requested" ]; then
        if prefix_has_webview2 "$requested"; then
            printf '%s\n' "$requested"
            return 0
        fi
        install_webview2_in_prefix "$requested"
        printf '%s\n' "$requested"
        return 0
    fi

    for candidate in \
        "$WEBVIEW2_CACHE_ROOT/prefix" \
        "$HOME/.wine" \
        "$HOME/.local/share/lutris/prefixes"/* \
        "$HOME/Games"/* \
        "$HOME/.steam/steam/steamapps/compatdata"/*/pfx \
        "$HOME/.local/share/Steam/steamapps/compatdata"/*/pfx; do
        [ -d "$candidate" ] || continue
        if prefix_has_webview2 "$candidate"; then
            warn "Prefijo Wine con WebView2 localizado automáticamente: $candidate"
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    candidate="$WEBVIEW2_CACHE_ROOT/prefix"
    install_webview2_in_prefix "$candidate"
    printf '%s\n' "$candidate"
}

run_wine_smoke() {
    local runner="$WINE_RUNNER"
    [ "$runner" = "auto" ] && runner=wine
    local proton_bin="${LTERMINAL_PROTON:-}"
    if [ "$runner" = "proton" ]; then
        if [ -z "$proton_bin" ]; then
            for candidate in \
                "$HOME/.local/share/Steam/steamapps/common/Proton 11.0/proton" \
                "$HOME/.local/share/lutris/runners/wine/proton-cachyos-11.0-x86_64/proton"; do
                [ -x "$candidate" ] && { proton_bin="$candidate"; break; }
            done
        fi
        [ -x "$proton_bin" ] || fail "No se encontró Proton; usa LTERMINAL_PROTON=/ruta/al/proton."
    elif [ "$runner" = "wine" ]; then
        if ! command -v wine >/dev/null 2>&1; then
            install_wine || fail "Se pidió --wine-smoke, pero Wine no está instalado."
        fi
        command -v wine >/dev/null 2>&1 || fail "No se encontró Wine para ejecutar el smoke."
    else
        fail "LTERMINAL_WINE_RUNNER debe ser wine, proton o auto."
    fi

    local prefix smoke_dir wine_log app_log app_log_win code webview_key smoke_token headless_smoke
    local wine_xvfb_args wine_xvfb_mode wine_gui_capture_dir wine_gui_capture wine_process_log
    local -a wine_command smoke_env wine_gui_prefix
    local runner_dir proton_compat proton_client
    headless_smoke=0
    [ "${LTERMINAL_WINE_GUI_SMOKE:-0}" = "1" ] || headless_smoke=1
    runner_dir="$(mktemp -d "${TMPDIR:-/tmp}/lterminal-wine-runner.XXXXXX")"
    if [ "$runner" = "wine" ]; then
        if [ "$headless_smoke" -eq 1 ]; then
            prefix="${WINE_SMOKE_PREFIX:-${WINEPREFIX:-$HOME/.cache/lterminal/wine-smoke-prefix}}"
            mkdir -p "$prefix"
        else
            prefix="$(prepare_wine_webview2_prefix)"
        fi
        smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/lterminal-wine-smoke.XXXXXX")"
        wine_log="$smoke_dir/wine.log"
        app_log="$smoke_dir/app.log"
    else
        if [ -n "${WINE_SMOKE_PREFIX:-}" ]; then
            prefix="$WINE_SMOKE_PREFIX"
            [ -d "$prefix" ] || fail "WINE_SMOKE_PREFIX no existe: $prefix"
        else
            smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/lterminal-wine-smoke.XXXXXX")"
            prefix="$smoke_dir/prefix"
            mkdir -p "$prefix"
        fi
    fi
    wine_log="${wine_log:-$(mktemp "${TMPDIR:-/tmp}/lterminal-wine-smoke-log.XXXXXX")}"
    app_log="${app_log:-$(mktemp "${TMPDIR:-/tmp}/lterminal-wine-smoke-app-log.XXXXXX")}"

    if [ "$runner" = "proton" ]; then
        proton_compat="$runner_dir/compatdata"
        proton_client="${STEAM_COMPAT_CLIENT_INSTALL_PATH:-$HOME/.local/share/Steam}"
        mkdir -p "$proton_compat"
        ln -s "$prefix" "$proton_compat/pfx"
        printf '11.0-100\n' > "$proton_compat/version"
        : > "$proton_compat/tracked_files"
    fi
    webview_key=''
    if [ "$headless_smoke" -eq 1 ]; then
        warn "Wine ejecutará un smoke headless: WebView2/Tao no presenta la interfaz con fiabilidad en este entorno; esta ruta no valida el renderizado gráfico."
    elif [ "$runner" = "wine" ]; then
        if webview_key="$(webview2_registry_key "$prefix")"; then
            :
        else
            webview_key=''
        fi
    else
        for candidate in \
            'HKLM\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
            'HKLM\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
            'HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; do
            if STEAM_COMPAT_DATA_PATH="$proton_compat" \
                STEAM_COMPAT_CLIENT_INSTALL_PATH="$proton_client" \
                WINEDEBUG=-all "$proton_bin" run reg query "$candidate" /v pv >/dev/null 2>&1; then
                webview_key="$candidate"
                break
            fi
        done
    fi
    if [ "$headless_smoke" -eq 0 ] && [ -z "$webview_key" ]; then
        [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
        rm -rf "$runner_dir"
        fail "El prefijo Wine no tiene WebView2 Runtime y no pudo prepararse automáticamente. WebView2Loader.dll no sustituye al runtime."
    fi

    if [ "$runner" = "wine" ] && [ "$headless_smoke" -eq 0 ]; then
        wine_command=(wine)
        # No basta con que DISPLAY esté definido: shells de escritorio/editor
        # pueden heredar un socket muerto. Se prueba xdpyinfo y, si no responde,
        # se usa Xvfb como hace la E2E GUI de Tools.
        wine_xvfb_mode="${LTERMINAL_WINE_XVFB:-auto}"
        case "$wine_xvfb_mode" in
            auto|0|1) ;;
            *) fail "LTERMINAL_WINE_XVFB debe ser auto, 0 o 1." ;;
        esac
        wine_gui_prefix=()
        if [ "$wine_xvfb_mode" = "1" ] || \
            { [ "$wine_xvfb_mode" = "auto" ] && \
              { [ -z "${DISPLAY:-}" ] || ! command -v xdpyinfo >/dev/null 2>&1 || ! timeout 5 xdpyinfo >/dev/null 2>&1; }; }; then
            command -v xvfb-run >/dev/null 2>&1 || fail "La prueba GUI requiere xvfb-run porque el display heredado no está disponible."
            command -v xdpyinfo >/dev/null 2>&1 || fail "La prueba GUI requiere xdpyinfo para validar el display aislado."
            wine_xvfb_args="${LTERMINAL_WINE_XVFB_ARGS:--screen 0 1280x800x24 -nolisten tcp}"
            timeout 10 xvfb-run -a -s "$wine_xvfb_args" xdpyinfo >/dev/null 2>&1 || \
                fail "Xvfb está instalado, pero no pudo iniciar un display aislado para la prueba GUI."
            wine_gui_prefix=(xvfb-run -a -s "$wine_xvfb_args" env -u WAYLAND_DISPLAY)
            warn "Wine usará un Xvfb validado; se ignoran DISPLAY/Wayland heredados para aislar la ventana."
        elif [ -z "${DISPLAY:-}" ] || ! command -v xdpyinfo >/dev/null 2>&1 || ! timeout 5 xdpyinfo >/dev/null 2>&1; then
            fail "No hay un display X accesible para el smoke GUI; instala xvfb-run o fija LTERMINAL_WINE_XVFB=1."
        fi
    fi

    smoke_token="windows-cross-$$-$(date +%s%N)"
    app_log_win="Z:${app_log//\//\\}"
    if [ "$headless_smoke" -eq 1 ]; then
        warn "Smoke headless Wine: ejecutará echo por stdin, validará el marcador recibido por stdout/stderr y el código de salida. No valida GUI ni ConPTY."
    else
        warn "Smoke GUI Wine: exigirá ventana visible, frontend/PTY preparados y captura con contenido; no sustituye Windows nativo ni ConPTY real."
    fi
    # Wine no implementa CreatePseudoConsole con la fidelidad necesaria para
    # portable-pty. La app activa un backend temporal de pipes solo en esta
    # ejecución de validación; Windows nativo continúa usando ConPTY real.
    set +e
    if [ "$runner" = "proton" ]; then
        smoke_env=(
            "LTERMINAL_SMOKE_TOKEN=$smoke_token"
            LTERMINAL_SMOKE_AUTO_EXIT=1
            LTERMINAL_TEST_UNDER_WINE=1
            LTERMINAL_WINE_SMOKE=1
            "LTERMINAL_LOG_FILE=$app_log_win"
        )
        [ "$headless_smoke" -eq 1 ] && smoke_env+=(LTERMINAL_WINE_HEADLESS_SMOKE=1)
        env "${smoke_env[@]}" \
            STEAM_COMPAT_DATA_PATH="$proton_compat" \
            STEAM_COMPAT_CLIENT_INSTALL_PATH="$proton_client" \
            PROTON_USE_WINED3D=1 PROTON_NO_ESYNC=1 PROTON_NO_FSYNC=1 \
            WINEDEBUG=-all timeout --foreground 60s "$proton_bin" run "Z:${EXE//\//\\}" >"$wine_log" 2>&1
    elif [ "$headless_smoke" -eq 1 ]; then
        LTERMINAL_SMOKE_TOKEN="$smoke_token" \
            LTERMINAL_TEST_UNDER_WINE=1 \
            LTERMINAL_WINE_HEADLESS_SMOKE=1 \
            LTERMINAL_LOG_FILE="$app_log_win" \
            WINEPREFIX="$prefix" WINEDEBUG=-all timeout --foreground 60s \
            wine "Z:${EXE//\//\\}" >"$wine_log" 2>&1
    elif [ "$runner" = "wine" ]; then
        for gui_tool in xdotool import identify; do
            command -v "$gui_tool" >/dev/null 2>&1 || fail "El smoke GUI visual requiere $gui_tool."
        done
        wine_gui_capture_dir="${LTERMINAL_WINE_GUI_CAPTURE_DIR:-$smoke_dir/gui-captures}"
        mkdir -p -- "$wine_gui_capture_dir"
        wine_gui_capture="$wine_gui_capture_dir/lterminal-windows-wine.png"
        wine_process_log="$smoke_dir/wine-process.log"
        rm -f -- "$wine_gui_capture"
        LTERMINAL_SMOKE_TOKEN="$smoke_token" \
            LTERMINAL_SMOKE_AUTO_EXIT=1 \
            LTERMINAL_TEST_UNDER_WINE=1 \
            LTERMINAL_WINE_SMOKE=1 \
            LTERMINAL_E2E_WEBDRIVER=1 \
            LTERMINAL_E2E_DISABLE_GPU=1 \
            LTERMINAL_LOG_FILE="$app_log_win" \
            LIBGL_ALWAYS_SOFTWARE=1 MESA_LOADER_DRIVER_OVERRIDE=llvmpipe \
            WEBKIT_DISABLE_DMABUF_RENDERER=1 \
            WINEPREFIX="$prefix" WINEDEBUG=-all timeout --foreground 75s \
            "${wine_gui_prefix[@]}" bash "$PROJECT_ROOT/scripts/wine-gui-smoke.sh" \
            "Z:${EXE//\//\\}" "$wine_gui_capture" "$app_log" "$wine_process_log" >"$wine_log" 2>&1
    else
        LTERMINAL_SMOKE_TOKEN="$smoke_token" \
            LTERMINAL_SMOKE_AUTO_EXIT=1 \
            LTERMINAL_TEST_UNDER_WINE=1 \
            LTERMINAL_WINE_SMOKE=1 \
            LTERMINAL_LOG_FILE="$app_log_win" \
            WINEPREFIX="$prefix" WINEDEBUG=-all timeout --foreground 60s \
            "${wine_command[@]}" "Z:${EXE//\//\\}" >"$wine_log" 2>&1
    fi
    code=$?
    set -e
    if [ "$code" -ne 0 ]; then
        sed 's/^/      /' "$wine_log" >&2 || true
        echo "      Log de la app:" >&2
        sed 's/^/        /' "$app_log" >&2 || true
        [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
        [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
        rm -rf "$runner_dir"
        fail "El smoke Windows bajo $runner no terminó limpiamente (código $code)."
    fi
    if [ "$headless_smoke" -eq 1 ]; then
        for marker in "\"smokeToken\":\"$smoke_token\"" 'pty spawneado' 'Smoke Wine headless comando ejecutado' '"stdoutTokenObserved":true' '"stderrTokenObserved":true' '"exitCode":0' 'Smoke Wine headless completado'; do
            if ! grep -Fq "$marker" "$app_log"; then
                echo "      Log de la app:" >&2
                sed 's/^/        /' "$app_log" >&2 || true
                [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
                [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
                rm -rf "$runner_dir"
                fail "El smoke Windows headless bajo $runner no registró el hito: $marker"
            fi
        done
        [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
        [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
        rm -rf "$runner_dir"
        ok "Smoke headless Wine bajo $runner: comando, salida capturada y cierre validados; GUI/ConPTY no probados."
        return
    fi
    if [ "$runner" = "wine" ]; then
        grep -Fq 'WINE_GUI_CAPTURE_OK=' "$wine_log" || {
            sed 's/^/      /' "$wine_log" >&2 || true
            fail "El smoke GUI bajo Wine no dejó una captura visual validada: $wine_gui_capture"
        }
        ok "Ventana WebView2 visible y con contenido; captura: $wine_gui_capture"
    fi
    if ! grep -Eiq 'WebView2Loader(\.dll)?' "$wine_log"; then
        sed 's/^/      /' "$wine_log" >&2 || true
        echo "      Log de la app:" >&2
        sed 's/^/        /' "$app_log" >&2 || true
        [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
        [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
        rm -rf "$runner_dir"
        fail "$runner mantuvo el proceso, pero no llegó a cargar WebView2Loader.dll."
    fi
    for marker in "\"smokeToken\":\"$smoke_token\"" 'Ventana inicial preparada' 'pty spawneado' 'Frontend y terminal preparados'; do
        if ! grep -Fq "$marker" "$app_log"; then
            echo "      Log de la app:" >&2
            sed 's/^/        /' "$app_log" >&2 || true
            [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
            [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
            rm -rf "$runner_dir"
            fail "El smoke Windows bajo $runner no registró el hito: $marker"
        fi
    done
    if grep -Fq '[ERROR]' "$app_log"; then
        echo "      Log de la app:" >&2
        sed 's/^/        /' "$app_log" >&2 || true
        [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
        [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
        rm -rf "$runner_dir"
        fail "El smoke Windows bajo $runner dejó errores en la sesión de arranque."
    fi
    [ -n "${smoke_dir:-}" ] && rm -rf "$smoke_dir"
    [ -z "${smoke_dir:-}" ] && rm -f "$wine_log" "$app_log"
    rm -rf "$runner_dir"
    ok "Smoke Wine bajo $runner: frontend, PTY y cierre validados; la presentación gráfica de WebView2 queda pendiente de Windows nativo."
}

cd "$PROJECT_ROOT"
step "Comprobando requisitos Windows desde Linux"
configure_cargo_profile
ensure_node_and_rust
ensure_zip
load_local_signing_material
validate_release_signing
step "Aplicando versión de release"
if [ "$VERSION_OVERRIDE" != "$CURRENT_VERSION" ]; then
    backup_version_manifests
    node "$PROJECT_ROOT/scripts/set-package-version.mjs" "$VERSION_OVERRIDE" || fail "No se pudo aplicar la versión $VERSION_OVERRIDE."
else
    ok "Se conserva la versión $CURRENT_VERSION sin modificar los manifiestos"
fi
if [ "${LTERMINAL_TEST_FAIL_AFTER_VERSION:-0}" = "1" ]; then
    fail "Fallo de prueba solicitado después de aplicar la versión."
fi
if [ -n "${LTERMINAL_TEST_REMOVE_VERSION_BACKUP:-}" ]; then
    case "$LTERMINAL_TEST_REMOVE_VERSION_BACKUP" in
        package.json|package-lock.json|Cargo.toml|Cargo.lock) ;;
        *) fail "El manifiesto solicitado para la prueba no está permitido." ;;
    esac
    rm -f -- "$VERSION_BACKUP_DIR/$LTERMINAL_TEST_REMOVE_VERSION_BACKUP" ||
        fail "No se pudo preparar el fallo de prueba de restauración."
fi
if [ "${LTERMINAL_TEST_EXIT_AFTER_VERSION:-0}" = "1" ]; then
    exit 0
fi
VERSION_OVERRIDE="$(node -p "require('./package.json').version")"
ok "Versión $VERSION_OVERRIDE aplicada"
step "Preparando recursos oficiales ConPTY"
node "$PROJECT_ROOT/scripts/prepare-conpty.mjs" || fail "No se pudieron descargar/verificar los recursos ConPTY oficiales."
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
    step "Ejecutando la auditoría mínima de workflows de GitHub"
    npm run check:github-security
    warn "Comprobaciones omitidas: el frontend se seguirá compilando, pero se omitirán las comprobaciones externas y svelte-check."
fi

# MinGW puede intentar exportar símbolos internos de Rust hasta superar el
# límite de ordinales PE. No cambia la interfaz del ejecutable: solo evita que
# el enlazador publique esos símbolos privados como exports.
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-D warnings -C link-arg=-Wl,--exclude-all-symbols"
export CARGO_TARGET_DIR="$WINDOWS_TARGET_DIR"

if [ "$SKIP_CHECKS" -eq 0 ]; then
    step "Validando tests y ramas exclusivas de Windows"
    # `npm run check` se ejecuta en el host Linux y no compila los bloques
    # `cfg(windows)`. Esta pasada evita que código Windows roto llegue al
    # empaquetado aunque la batería Linux esté completamente verde.
    cargo check --manifest-path "$TAURI_DIR/Cargo.toml" \
        --tests --target "$TARGET" \
        --features tauri/custom-protocol
    ok "Código y tests condicionados para Windows compilados sin avisos"
fi

step "Compilando WTerminal ($TARGET)"
# Esta ruta usa Cargo directamente en lugar de `tauri build`, por lo que debe
# reproducir explícitamente los dos pasos que el bundler hace por configuración:
# generar `dist` y activar `tauri/custom-protocol`. Sin esto el EXE arranca,
# pero intenta abrir localhost y la VM muestra una página de conexión rechazada.
npm run build
# Para esta validación no necesitamos el bundler de Tauri: Cargo ejecuta el
# build.rs, genera el PE y copia conpty/OpenConsole/WebView2Loader. Usar Cargo
# directamente evita que `tauri build --no-bundle` deje su proceso abierto
# después de que el ejecutable ya esté terminado.
cargo build --manifest-path "$TAURI_DIR/Cargo.toml" \
    --release --target "$TARGET" --bin winslim-terminal \
    --features tauri/custom-protocol

# Cargo conserva el nombre interno del crate por compatibilidad con el target
# compartido, pero el artefacto Windows publicado pertenece a WTerminal.
# Renombrarlo aquí evita que la build cruzada deje un `winslim-terminal.exe`
# que luego el empaquetador no puede encontrar.
CARGO_EXE="$RELEASE_DIR/winslim-terminal.exe"
if [ -f "$CARGO_EXE" ] && [ "$CARGO_EXE" != "$EXE" ]; then
    mv -f -- "$CARGO_EXE" "$EXE"
fi

[ -f "$EXE" ] || fail "No se generó $EXE."
for asset in conpty.dll OpenConsole.exe WebView2Loader.dll; do
    [ -f "$RELEASE_DIR/$asset" ] || fail "Falta el recurso Windows $asset junto al ejecutable."
done
# La build cruzada no usa el bundler NSIS, así que replica el árbol de recursos
# que la build nativa copia a la carpeta portable. La lista sale del manifiesto
# base, no de una copia paralela que pueda olvidar el siguiente script integrado.
while IFS=$'\t' read -r source destination; do
    [ -n "$source" ] && [ -n "$destination" ] || continue
    # Tauri resuelve los orígenes relativos desde src-tauri. Normalizar primero
    # permite, por ejemplo, ../THIRD-PARTY-NOTICES.txt (que vive en la raíz)
    # sin aceptar escapes reales del proyecto ni confiar en prefijos textuales.
    resource_source="$(realpath -e -- "$TAURI_DIR/$source")" || fail "Falta el recurso declarado por Tauri: $source"
    case "$resource_source" in
        "$PROJECT_ROOT"/*) resource="${resource_source#"$PROJECT_ROOT"/}" ;;
        *) fail "El recurso Windows del manifiesto sale de la carpeta del proyecto: $source" ;;
    esac
    [ -f "$resource_source" ] || fail "El recurso empaquetable no es un archivo: $resource_source"
    case "$destination" in
        ""|/*|..|../*|*/../*|*/..) fail "Destino de recurso Windows no válido: $destination" ;;
        *'\'*) fail "El destino de recurso Windows debe usar rutas relativas: $destination" ;;
    esac
    mkdir -p "$RELEASE_DIR/$(dirname "$destination")"
    cp "$resource_source" "$RELEASE_DIR/$destination"
done < <(node -e 'const fs=require("fs"); const resources=require("./src-tauri/tauri.conf.json").bundle?.resources ?? {}; for (const [source,destination] of Object.entries(resources)) process.stdout.write(`${source}\t${destination}\n`);')
if command -v file >/dev/null 2>&1; then
    file "$EXE" | grep -Eq 'PE32\+.*x86-64' || fail "$EXE no parece un ejecutable Windows x64."
fi
ok "Ejecutable Windows y recursos runtime verificados en $RELEASE_DIR"
node "$PROJECT_ROOT/scripts/verify-release-artifacts.mjs" \
    --windows "$EXE" \
    --windows-dir "$RELEASE_DIR"
ok "Estructura PE x64 y runtime Windows verificados"
if [ "$RUN_WINE_TESTS" -eq 1 ]; then
    step "Ejecutando la batería Rust Windows bajo Wine"
    run_wine_rust_tests
    ok "Batería Rust Windows ejecutada bajo Wine"
fi

if [ "$RUN_WINE" -eq 1 ]; then
    for attempt in $(seq 1 "$WINE_REPEATS"); do
        step "Ejecutando smoke Windows bajo Wine ($attempt/$WINE_REPEATS)"
        run_wine_smoke
    done
fi

step "Publicando carpeta portable Windows"
package_args=(
    --source "$RELEASE_DIR"
    --project "$PROJECT_ROOT"
    --release "${LTERMINAL_RELEASE_DIR:-$PROJECT_ROOT/release}"
    --version "$VERSION_OVERRIDE"
)
if [ "$FAST_BUILD" -eq 1 ]; then
    package_args+=(--fast)
fi
# La copia portable puede auto-instalar WebView2 si se distribuye el
# bootstrapper junto al ejecutable. `auto` solo usa una caché existente para no
# convertir una build offline en una descarga inesperada; `1` lo descarga y
# `0` conserva el portable mínimo/documentado.
include_webview2_bootstrapper="${LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER:-auto}"
case "$include_webview2_bootstrapper" in
    0) ;;
    auto|1)
        webview2_portable_installer="${LTERMINAL_WEBVIEW2_INSTALLER:-$WEBVIEW2_CACHE_ROOT/MicrosoftEdgeWebview2Setup.exe}"
        if [ ! -s "$webview2_portable_installer" ] && [ "$include_webview2_bootstrapper" = 1 ]; then
            webview2_portable_installer="$(download_webview2_installer)"
        fi
        if [ -s "$webview2_portable_installer" ]; then
            package_args+=(--webview2-installer "$webview2_portable_installer")
            ok "Bootstrapper WebView2 preparado para el portable"
        else
            warn "No se incluirá bootstrapper WebView2; usa LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER=1 para descargarlo."
        fi
        ;;
    *) fail "LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER debe ser 0, auto o 1." ;;
esac
node "$PROJECT_ROOT/scripts/package-windows-cross.mjs" "${package_args[@]}"

release_out="${LTERMINAL_RELEASE_DIR:-$PROJECT_ROOT/release}"
if [[ "$release_out" != /* ]]; then
    release_out="$PROJECT_ROOT/$release_out"
fi
release_suffix=""
if [ "$FAST_BUILD" -eq 1 ]; then
    release_out="$release_out/dev"
    release_suffix="-dev"
fi
portable_release="$release_out/WTerminal-$VERSION_OVERRIDE$release_suffix"
archive_release="$release_out/WTerminal-Unpacked-$VERSION_OVERRIDE$release_suffix.zip"
node "$PROJECT_ROOT/scripts/verify-release-artifacts.mjs" \
    --windows "$portable_release/wterminal.exe" \
    --windows-dir "$portable_release"
ok "Carpeta portable publicada y verificada: $portable_release"

if [ -n "${LTERMINAL_SIGNING_PRIVATE_KEY:-}" ]; then
    node "$PROJECT_ROOT/scripts/sign-release-manifest.mjs" \
        --manifest "$release_out/SHA256SUMS.txt" \
        --signature "$release_out/SHA256SUMS.txt.sig"
    node "$PROJECT_ROOT/scripts/sign-release-manifest.mjs" \
        --manifest "$release_out/SHA256SUMS.txt" \
        --signature "$release_out/SHA256SUMS.txt.sig" --verify
    ok "Manifiesto de la release Windows firmado y verificado"
else
    rm -f -- "$release_out/SHA256SUMS.txt.sig"
    warn "Release local sin firma Ed25519; el actualizador rechazará este artefacto."
fi

printf '\nBuild Windows cruzada completada.\n  Carpeta portable: %s\n  ZIP portable: %s\n  Ejecutable de trabajo: %s\n' \
    "$portable_release" "$archive_release" "$EXE"
