#!/usr/bin/env bash
#
# Build de LTerminal (Tauri 2 + Rust) para Linux.
#
# Produce UNA sola cosa: el AppImage. Sin .deb, sin .rpm, sin carpeta
# desempaquetada y sin accesos directos; la descripción mantenida está en README.md.
#
# Requisitos: Node.js >= 22.12, el toolchain de Rust y las bibliotecas de
# desarrollo de WebKitGTK. Los nombres de los paquetes cambian según la
# distribución, así que si falta algo se dice cuál es y cómo se llama aquí.
#
# Antes de dar por ausente una herramienta se busca donde la deja su instalador
# (rustup en ~/.cargo, nvm/fnm/volta/asdf para node): "no está en el PATH" y "no
# está instalado" son cosas distintas, y la primera se arregla sola.

# El script usa `${BASH_SOURCE[0]}`, arrays y `set -o pipefail`: con `sh
# build.sh` (dash en Debian/Ubuntu) muere con un error de sintaxis que no dice
# que el problema sea el intérprete. Mejor decirlo.
if [ -z "${BASH_VERSION:-}" ]; then
    echo "ERROR: este script necesita bash. Ejecútalo como ./build.sh o bash build.sh." >&2
    exit 1
fi

# -E propaga el trap ERR a las funciones: sin él, un fallo dentro de una de
# ellas cortaba el script sin pasar por el aviso de qué paso se rompió.
set -Eeuo pipefail

# Si este script se lanzó desde la propia AppImage, sus bibliotecas privadas
# viven en `/tmp/.mount_*`. No pueden heredarse por npm, git, cargo ni sus
# herramientas auxiliares: de hacerlo, programas del sistema terminan
# cargando una libpcre2 incompatible del montaje temporal.
if [ -n "${APPIMAGE:-}" ] || [[ "${LD_LIBRARY_PATH:-}" == *"/tmp/.mount_"* ]]; then
    unset APPDIR APPIMAGE ARGV0 LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD
fi

# El paquete npm conserva su identificador técnico compartido con Windows,
# pero sus mensajes de ciclo de vida lo imprimen aunque no aporten información
# a una build Linux (por ejemplo, "npm notice run …"). Mantener el nivel en
# `error` deja visibles los fallos reales sin filtrar la identidad LTerminal en
# la salida de este script.
export NPM_CONFIG_LOGLEVEL=error

# Cargo también etiqueta sus barras de progreso con el nombre técnico del
# paquete compartido. El modo silencioso solo oculta progreso; los diagnósticos
# y los fallos continúan apareciendo completos. Así la build Linux conserva una
# salida limpia de LTerminal sin cambiar la identidad de la distribución
# Windows.
export CARGO_TERM_QUIET=true
# La batería es deliberadamente secuencial y Cargo queda limitado para que una
# validación larga no congele el escritorio ni agote la RAM de una VM pequeña.
# La batería completa compila también los tests en perfil debug; en WSL/VM el
# enlazado de una sola biblioteca puede superar varios GiB. Un trabajo por
# defecto evita OOM no deterministas; quien tenga margen puede subirlo con
# CARGO_BUILD_JOBS=2 (o más) explícitamente.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-1}"

CLEAN=0
NO_RUN=0
SKIP_CHECKS=0
ALLOW_OFFLINE_CHECKS=0
AUTO_INSTALL=1
VERSION_OVERRIDE=""
EXTENDED_TESTS=1
EXTENDED_MODE=""
# La ruta predeterminada es una release verificable: si falta el driver, se
# intenta instalar automáticamente para no publicar un AppImage sin E2E.
INSTALL_E2E_DRIVER=1
E2E_DRIVER_PATH="${TAURI_NATIVE_DRIVER:-}"
CROSS_WINDOWS=0
NON_INTERACTIVE=0
FAST_BUILD=0
EXPLICIT_OPTIONS=0
POST_BUILD_FAILURE=0
POST_BUILD_ISSUES=()
post_build_issue() {
    local message="$1"
    POST_BUILD_FAILURE=1
    POST_BUILD_ISSUES+=("$message")
    err "$message"
}
while [ "$#" -gt 0 ]; do
    EXPLICIT_OPTIONS=1
    case "$1" in
        --clean)       CLEAN=1 ;;
        --no-run)      NO_RUN=1 ;;
        --skip-checks) SKIP_CHECKS=1 ;;
        --allow-offline-checks) ALLOW_OFFLINE_CHECKS=1 ;;
        --no-install)  AUTO_INSTALL=0 ;;
        --extended-tests|--full-tests)
            if [ "$EXTENDED_MODE" = "off" ]; then
                echo "--full-tests/--extended-tests no se puede combinar con --no-extended-tests." >&2
                exit 2
            fi
            EXTENDED_MODE="on"
            EXTENDED_TESTS=1
            ;;
        --no-extended-tests)
            if [ "$EXTENDED_MODE" = "on" ]; then
                echo "--no-extended-tests no se puede combinar con --full-tests/--extended-tests." >&2
                exit 2
            fi
            EXTENDED_MODE="off"
            EXTENDED_TESTS=0
            ;;
        --cross-windows|--windows-tests)
            CROSS_WINDOWS=1
            ;;
        --non-interactive) NON_INTERACTIVE=1 ;;
        --fast)         FAST_BUILD=1 ;;
        --install-e2e-driver) INSTALL_E2E_DRIVER=1 ;;
        --e2e-driver)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ] || [[ "$1" == -* ]]; then
                echo "--e2e-driver necesita la ruta a WebKitWebDriver." >&2
                exit 2
            fi
            E2E_DRIVER_PATH="$1"
            ;;
        --e2e-driver=*)
            E2E_DRIVER_PATH="${1#*=}"
            [ -n "$E2E_DRIVER_PATH" ] || { echo "--e2e-driver necesita la ruta a WebKitWebDriver." >&2; exit 2; }
            ;;
        --version)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ] || [[ "$1" == -* ]]; then
                echo "--version necesita un valor SemVer, por ejemplo 1.4.4" >&2
                exit 2
            fi
            VERSION_OVERRIDE="$1"
            ;;
        --version=*)
            VERSION_OVERRIDE="${1#*=}"
            [ -n "$VERSION_OVERRIDE" ] || { echo "--version necesita un valor SemVer, por ejemplo 1.4.4" >&2; exit 2; }
            ;;
        -h|--help)
            echo "Uso: $0 [--fast] [--clean] [--skip-checks] [--allow-offline-checks] [--no-run] [--no-install] [--non-interactive] [--extended-tests|--full-tests|--no-extended-tests] [--cross-windows|--windows-tests] [--install-e2e-driver] [--e2e-driver RUTA] [--version X.Y.Z]"
            echo "Sin opciones: release completa AppImage + checks estrictos + smoke + bateria ampliada + E2E."
            echo "En modo interactivo, la versión se pide al principio junto al resto de opciones."
            echo "Los fallos de E2E se informan al final sin impedir publicar el AppImage."
            exit 0
            ;;
        *)
            echo "Argumento desconocido: $1" >&2
            exit 2
            ;;
    esac
    shift
done

ask_build_choice() {
    local prompt="$1"
    local default="$2"
    local answer
    local hint='s/N'
    [ "$default" -eq 1 ] && hint='S/n'
    while true; do
        if ! read -r -p "$prompt [$hint] " answer; then
            printf '\n'
            [ "$default" -eq 1 ]
            return $?
        fi
        answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
        case "$answer" in
            '')
                [ "$default" -eq 1 ]
                return $?
                ;;
            s|si|sí|y|yes) return 0 ;;
            n|no) return 1 ;;
            *) warn "Responde s/sí o n/no; Enter conserva el valor predeterminado." ;;
        esac
    done
}

configure_interactive_options() {
    # Una ejecución interactiva permite escoger el perfil sin romper las
    # builds automatizadas: --non-interactive, CI o una entrada/salida
    # redirigida no intentan leer del usuario. Con flags explícitos solo se
    # solicita la versión si falta; el resto ya está determinado.
    local can_prompt=1
    local printed_config=0
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ "${CI:-}" = '1' ] || [ "${CI:-}" = 'true' ] || [ "${CI:-}" = 'yes' ] || \
        [ ! -t 0 ] || [ ! -t 1 ]; then
        can_prompt=0
    fi

    if [ "$can_prompt" -eq 1 ] && [ "$EXPLICIT_OPTIONS" -eq 0 ]; then
        printf '\n\033[36mConfiguración de build (Enter conserva el valor actual):\033[0m\n'
        printed_config=1
    fi

    # La versión forma parte de la configuración inicial y se solicita antes
    # de las demás opciones. Incluso con flags explícitos se pide aquí si la
    # terminal es interactiva; así nunca aparece después de los checks.
    if [ "$can_prompt" -eq 1 ] && [ -z "$VERSION_OVERRIDE" ]; then
        read -r -p "Versión de release [$CURRENT_VERSION]: " VERSION_OVERRIDE
        VERSION_OVERRIDE="${VERSION_OVERRIDE:-$CURRENT_VERSION}"
    elif [ -z "$VERSION_OVERRIDE" ]; then
        VERSION_OVERRIDE="$CURRENT_VERSION"
    fi

    # Con opciones explícitas solo se pregunta la versión; el resto de valores
    # ya vienen determinados por los flags.
    if [ "$can_prompt" -eq 0 ] || [ "$EXPLICIT_OPTIONS" -eq 1 ]; then
        return 0
    fi
    if [ "$printed_config" -eq 0 ]; then
        printf '\n\033[36mConfiguración de build (Enter conserva el valor actual):\033[0m\n'
    fi
    printf '  Versión seleccionada: %s\n' "$VERSION_OVERRIDE"
    if ask_build_choice 'Limpiar dependencias y target antes de compilar' "$CLEAN"; then CLEAN=1; else CLEAN=0; fi
    if ask_build_choice 'Usar perfil rápido de desarrollo' "$FAST_BUILD"; then FAST_BUILD=1; else FAST_BUILD=0; fi
    if ask_build_choice 'Instalar automáticamente dependencias faltantes' "$AUTO_INSTALL"; then AUTO_INSTALL=1; else AUTO_INSTALL=0; fi
    if ask_build_choice 'Saltar comprobaciones locales' "$SKIP_CHECKS"; then SKIP_CHECKS=1; else SKIP_CHECKS=0; fi
    if ask_build_choice 'Convertir comprobaciones externas en avisos' "$ALLOW_OFFLINE_CHECKS"; then ALLOW_OFFLINE_CHECKS=1; else ALLOW_OFFLINE_CHECKS=0; fi
    if ask_build_choice 'Ejecutar pruebas ampliadas y E2E' "$EXTENDED_TESTS"; then EXTENDED_TESTS=1; else EXTENDED_TESTS=0; fi
    if [ "$EXTENDED_TESTS" -eq 1 ]; then
        if ask_build_choice 'Instalar tauri-driver/WebKitWebDriver si faltan' "$INSTALL_E2E_DRIVER"; then INSTALL_E2E_DRIVER=1; else INSTALL_E2E_DRIVER=0; fi
    fi
    if ask_build_choice 'Ejecutar también la build Windows cruzada' "$CROSS_WINDOWS"; then CROSS_WINDOWS=1; else CROSS_WINDOWS=0; fi
    if ask_build_choice 'Lanzar la aplicación al terminar' "$((1 - NO_RUN))"; then NO_RUN=0; else NO_RUN=1; fi
    printf '  Opciones seleccionadas. La build comenzará ahora.\n'
}

# Tauri invoca Cargo internamente y necesita seguir viendo el perfil release
# para conservar sus rutas de bundling. Cargo permite ajustar ese perfil por
# entorno, así que el modo rápido no necesita una segunda configuración Tauri
# ni crea un target/release alternativo que luego el empaquetador no encuentre.
#
# El perfil normal es deliberadamente caro: LTO completo, una unidad de
# generación y símbolos eliminados. El perfil rápido prioriza iteraciones de
# desarrollo: compilación incremental, menos optimización, más unidades de
# generación y símbolos de depuración. Ambos producen el mismo AppImage y
# pasan las mismas validaciones; --no-extended-tests/--skip-checks son opciones
# independientes y explícitas.
configure_cargo_profile() {
    if [ "$FAST_BUILD" -eq 1 ]; then
        export CARGO_PROFILE_RELEASE_OPT_LEVEL=1
        export CARGO_PROFILE_RELEASE_LTO=false
        export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256
        export CARGO_PROFILE_RELEASE_STRIP=none
        export CARGO_PROFILE_RELEASE_DEBUG=1
        export CARGO_PROFILE_RELEASE_INCREMENTAL=true
        export CARGO_PROFILE_RELEASE_PANIC=unwind
        ok "Perfil de desarrollo rápido: incremental, sin LTO y con símbolos de depuración"
    else
        export CARGO_PROFILE_RELEASE_OPT_LEVEL=s
        export CARGO_PROFILE_RELEASE_LTO=true
        export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
        export CARGO_PROFILE_RELEASE_STRIP=true
        export CARGO_PROFILE_RELEASE_DEBUG=0
        export CARGO_PROFILE_RELEASE_INCREMENTAL=false
        export CARGO_PROFILE_RELEASE_PANIC=abort
        ok "Perfil release comprimido: LTO completo, símbolos eliminados y optimización máxima"
    fi
}

BUILD_STARTED_SECONDS=$SECONDS
STEP_STARTED_SECONDS=$SECONDS
step() {
    local now=$SECONDS
    local elapsed=$((now - STEP_STARTED_SECONDS))
    if [ "$elapsed" -gt 0 ]; then
        printf '    Tiempo del paso anterior: %ss\n' "$elapsed"
    fi
    CURRENT_STEP="$1"
    STEP_STARTED_SECONDS=$now
    printf '\n\033[36m==> %s\033[0m\n' "$1"
}
ok()   { printf '    \033[32mOK:\033[0m %s\n' "$1"; }
warn() { printf '    \033[33mAVISO:\033[0m %s\n' "$1"; }
err()  { printf '    \033[31mERROR:\033[0m %s\n' "$1" >&2; }

# Las builds locales cargan automáticamente el material de firma fuera del
# repositorio. CI conserva la precedencia de sus secretos y no usa el HOME del
# runner como fallback. Las rutas se pueden cambiar explícitamente para una
# máquina que guarde las claves en otra ubicación.
load_local_signing_material() {
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

    if [ -n "${LTERMINAL_SIGNING_PRIVATE_KEY:-}" ] || [ -n "${LTERMINAL_UPDATE_PUBLIC_KEY:-}" ]; then
        ok "Material de firma local cargado automáticamente"
    fi
}

# Resolver la ruta y la versión antes de cualquier comprobación o instalación
# permite que toda la configuración inicial quede agrupada al principio.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TAURI_DIR="$PROJECT_ROOT/src-tauri"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle/appimage"
CURRENT_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT_ROOT/package.json" | head -n 1)"
CURRENT_VERSION="${CURRENT_VERSION:-1.0.0}"

load_local_signing_material

configure_interactive_options

if ! [[ "$VERSION_OVERRIDE" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
    echo "La versión indicada no es SemVer válida: $VERSION_OVERRIDE" >&2
    exit 2
fi

if [ "$ALLOW_OFFLINE_CHECKS" -eq 1 ]; then
    export LTERMINAL_LINK_CHECK=warn
    export LTERMINAL_INSTALL_SOURCE_CHECK=warn
    export LTERMINAL_WINGET_CHECK=warn
    warn "Comprobaciones externas en modo aviso; se mantienen las comprobaciones locales."
fi

# Tener DISPLAY o WAYLAND_DISPLAY definido no garantiza que esta shell pueda
# hablar con el servidor gráfico. En contenedores y sesiones remotas las
# variables suelen heredarse, pero GTK falla después con un panic poco útil.
# Cuando hay una sonda disponible, valida el acceso antes de arrancar la app o
# el E2E y deja un diagnóstico accionable.
graphical_session_available() {
    if [ -n "${DISPLAY:-}" ]; then
        if command -v xdpyinfo >/dev/null 2>&1; then
            timeout 5 xdpyinfo >/dev/null 2>&1
            return $?
        fi
        if command -v xdotool >/dev/null 2>&1; then
            timeout 5 xdotool getdisplaygeometry >/dev/null 2>&1
            return $?
        fi
        return 0
    fi
    if [ -n "${WAYLAND_DISPLAY:-}" ]; then
        local wayland_socket="$WAYLAND_DISPLAY"
        if [[ "$wayland_socket" != /* ]]; then
            wayland_socket="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$wayland_socket"
        fi
        # Una variable Wayland puede quedar heredada por una shell aislada o
        # por un terminal del editor aunque el socket ya no exista. En ese
        # caso GTK solo devuelve un panic genérico; no se debe llamar a eso un
        # fallo del AppImage ni bloquear la publicación.
        [ -S "$wayland_socket" ] || return 1
        if command -v wayland-info >/dev/null 2>&1; then
            timeout 5 wayland-info >/dev/null 2>&1
            return $?
        fi
        return 0
    fi
    return 1
}

# Con `set -e` un fallo a mitad corta el script sin decir nada más, y en una
# build de varios minutos no queda claro qué paso se quedó a medias. El
# equivalente del "La build fallo con codigo N" de build.bat.
CURRENT_STEP="inicio"
SMOKE_PID=""
NODE_MODULES_RESTORE=""

# Linux y Windows comparten el checkout cuando la build se ejecuta desde WSL,
# pero npm solo instala la dependencia nativa de Tauri correspondiente al
# sistema actual. Un `npm ci` Linux puede por tanto borrar el CLI Windows del
# árbol que usa la siguiente build nativa. Si detectamos ese caso, apartamos
# temporalmente el árbol existente y lo restauramos al salir (también ante un
# error); la build Linux trabaja con un node_modules limpio y el host conserva
# sus binarios.
restore_node_modules() {
    local backup="${NODE_MODULES_RESTORE:-}"
    [ -n "$backup" ] || return 0
    if [ -d "$PROJECT_ROOT/node_modules" ]; then
        rm -rf "$PROJECT_ROOT/node_modules"
    fi
    if [ -d "$backup" ]; then
        mv "$backup" "$PROJECT_ROOT/node_modules"
    fi
    NODE_MODULES_RESTORE=""
}

# El smoke de arranque crea una aplicación real para verificar WebKit, IPC y la
# primera PTY. AppImage puede delegar en un proceso nativo después de extraer
# sus archivos, por lo que matar solo el PID del lanzador deja una ventana
# huérfana abierta. Se ejecuta en una sesión/proceso propio y se limpia siempre
# al salir de la build, incluso si falla una comprobación posterior.
cleanup_smoke_process() {
    local pid="${SMOKE_PID:-}"
    [ -n "$pid" ] || return 0
    kill -TERM -- "-$pid" >/dev/null 2>&1 || true
    kill -TERM "$pid" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do
        kill -0 "$pid" >/dev/null 2>&1 || break
        sleep 1
    done
    kill -KILL -- "-$pid" >/dev/null 2>&1 || true
    kill -KILL "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
    SMOKE_PID=""
}

smoke_log_ready() {
    local path="$1"
    local token="$2"
    [ -f "$path" ] || return 1
    grep -Fq "\"smokeToken\":\"$token\"" "$path" || return 1
    # Un token también se escribe en el error de frontend sin PTY. Exigir los
    # hitos de la misma ejecución evita que el build pase solo porque WebView
    # llegó a pintar una ventana o porque quedó un log antiguo.
    grep -Fq "Ventana inicial preparada" "$path" || return 1
    grep -Fq "pty spawneado" "$path" || return 1
    grep -Fq "Frontend y terminal preparados" "$path" || return 1
    ! grep -Fq "Frontend preparado pero sin sesión PTY" "$path"
}

on_error() {
    local code=$?
    printf '\n\033[31mLa build falló en: %s (código %s)\033[0m\n' "$CURRENT_STEP" "$code" >&2
    echo "Revisa los mensajes de arriba." >&2
}
# Cerrar primero cualquier AppImage/WebKit de smoke o E2E. En WSL el checkout
# vive en /mnt/c y un proceso hijo mantiene abiertos ficheros de node_modules;
# intentar restaurarlo antes de liberar esos handles produce EACCES y oculta
# el resultado real de la prueba.
trap 'cleanup_smoke_process; restore_node_modules' EXIT
trap on_error ERR

# rustup, nvm y compañía instalan en el HOME y dejan el PATH preparado en un
# perfil de shell. Eso no sirve en una terminal que ya estaba abierta antes de
# instalarlos, ni en un script lanzado desde el gestor de archivos: el comando
# está en el disco pero `command -v` no lo ve. Antes de dar por ausente una
# herramienta se mira donde su instalador la deja.
add_to_path() {
    local dir="$1"
    case ":$PATH:" in
        *":$dir:"*) return 0 ;;
    esac
    [ -d "$dir" ] || return 1
    PATH="$dir:$PATH"
    export PATH
}

recover_tool() {
    local tool="$1"
    shift
    command -v "$tool" >/dev/null 2>&1 && return 0
    local dir
    for dir in "$@"; do
        if [ -x "$dir/$tool" ] && add_to_path "$dir"; then
            warn "$tool no estaba en el PATH; se ha añadido $dir."
            return 0
        fi
    done
    return 1
}

run_as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        err "Hace falta permiso de administrador para instalar dependencias y no existe sudo."
        return 1
    fi
}

# Evita que una actualización de la distribución o una instalación iniciada
# desde la app compitan con esta build. Nunca elimina el lock: si no hay un
# proceso que lo posea, el usuario debe revisar y retirar el resto manualmente.
wait_for_pacman_lock() {
    local lock_file=/var/lib/pacman/db.lck
    local attempt=0
    while [ -e "$lock_file" ] && [ "$attempt" -lt 30 ]; do
        if ps -eo comm= 2>/dev/null | grep -Eq '^(pacman|yay|paru|pamac)$'; then
            warn "pacman está ocupado; esperando a que termine (intento $((attempt + 1))/30)..."
            sleep 2
            attempt=$((attempt + 1))
        else
            err "Existe un bloqueo huérfano en $lock_file y no se encontró ningún gestor de paquetes activo. No se eliminará automáticamente; comprueba que no haya otra instalación y retíralo manualmente antes de continuar."
            return 1
        fi
    done
    if [ -e "$lock_file" ]; then
        err "pacman sigue bloqueado tras 60 segundos ($lock_file)."
        return 1
    fi
}

# Una build no debe convertir la instalación de tres herramientas de prueba en
# una actualización completa de CachyOS/Arch. `-Syu` puede descargar y revisar
# cientos de paquetes y dejar la build aparentemente detenida durante mucho
# tiempo. Por defecto se instalan solo los objetivos solicitados; quien quiera
# actualizar todo el sistema antes puede hacerlo fuera de la build o habilitar
# explícitamente esta ruta con LTERMINAL_ALLOW_SYSTEM_UPGRADE=1.
pacman_install() {
    wait_for_pacman_lock || return 1
    if [ "${LTERMINAL_ALLOW_SYSTEM_UPGRADE:-0}" = "1" ]; then
        run_as_root pacman -Syu --needed --noconfirm "$@"
    else
        run_as_root pacman -S --needed --noconfirm "$@"
    fi
}

package_manager() {
    local manager
    for manager in apt-get dnf pacman zypper apk; do
        command -v "$manager" >/dev/null 2>&1 && { echo "$manager"; return 0; }
    done
    return 1
}

install_system_dependencies() {
    [ "$AUTO_INSTALL" -eq 1 ] || return 1
    local manager
    manager="$(package_manager)" || {
        err "No se reconoce el gestor de paquetes de esta distribución."
        return 1
    }
    warn "Faltan dependencias nativas; se instalarán automáticamente con $manager."
    case "$manager" in
        apt-get)
            run_as_root apt-get update
            run_as_root apt-get install -y --no-install-recommends \
                build-essential curl wget file pkg-config ca-certificates xz-utils \
                libwebkit2gtk-4.1-dev libsoup-3.0-dev libxdo-dev libssl-dev \
                libayatana-appindicator3-dev librsvg2-dev ibus
            ;;
        dnf)
            run_as_root dnf install -y \
                gcc gcc-c++ make curl wget file pkgconf-pkg-config ca-certificates xz \
                webkit2gtk4.1-devel libsoup3-devel openssl-devel \
                libappindicator-gtk3-devel librsvg2-devel libxdo-devel ibus
            ;;
        pacman)
            # No se actualiza el sistema completo desde una build. La vía
            # explícita sigue disponible con LTERMINAL_ALLOW_SYSTEM_UPGRADE=1.
            pacman_install \
                base-devel curl wget file pkgconf ca-certificates xz \
                webkit2gtk-4.1 libsoup3 openssl appmenu-gtk-module \
                libappindicator-gtk3 librsvg xdotool ibus
            ;;
        zypper)
            run_as_root zypper --non-interactive install -y \
                -t pattern devel_basis
            run_as_root zypper --non-interactive install -y \
                curl wget file pkg-config ca-certificates xz \
                webkit2gtk3-devel libopenssl-devel libappindicator3-1 librsvg-devel ibus
            ;;
        apk)
            run_as_root apk add \
                build-base curl wget file pkgconf ca-certificates xz \
                webkit2gtk-4.1-dev libsoup3-dev openssl-dev \
                libayatana-appindicator-dev librsvg-dev xdotool-dev font-dejavu ibus
            ;;
    esac
    ok "Dependencias nativas instaladas"
}

flatpak_app_installed() {
    local app_id="$1"
    command -v flatpak >/dev/null 2>&1 || return 1
    flatpak info --user "$app_id" >/dev/null 2>&1 || flatpak info "$app_id" >/dev/null 2>&1
}

# Herramientas mínimas de la batería ampliada. No intenta instalar los cientos
# de lenguajes y frameworks del catálogo: solo prepara lo que exercise-host.sh
# prueba de forma determinista y que no forma parte del toolchain de Tauri.
install_extended_test_tools() {
    [ "$AUTO_INSTALL" -eq 1 ] || {
        warn "La instalación automática está desactivada; se conservarán las herramientas de test ausentes."
        return 0
    }

    local manager
    manager="$(package_manager)" || {
        err "No se reconoce el gestor de paquetes para preparar la batería ampliada."
        return 1
    }

    local packages=()
    local flatpak_needed=0
    case "$manager" in
        apt-get)
            command -v dash >/dev/null 2>&1 || packages+=(dash)
            command -v psql >/dev/null 2>&1 || packages+=(postgresql-client)
            command -v gfortran >/dev/null 2>&1 || packages+=(gfortran)
            flatpak_app_installed com.usebottles.bottles || flatpak_needed=1
            [ "$flatpak_needed" -eq 0 ] || command -v flatpak >/dev/null 2>&1 || packages+=(flatpak)
            ;;
        dnf)
            command -v dash >/dev/null 2>&1 || packages+=(dash)
            command -v psql >/dev/null 2>&1 || packages+=(postgresql)
            command -v gfortran >/dev/null 2>&1 || packages+=(gcc-gfortran)
            flatpak_app_installed com.usebottles.bottles || flatpak_needed=1
            [ "$flatpak_needed" -eq 0 ] || command -v flatpak >/dev/null 2>&1 || packages+=(flatpak)
            ;;
        pacman)
            command -v dash >/dev/null 2>&1 || packages+=(dash)
            command -v psql >/dev/null 2>&1 || packages+=(postgresql)
            # En Arch/CachyOS el ejecutable gfortran lo proporciona gcc-fortran,
            # no un paquete llamado gfortran.
            command -v gfortran >/dev/null 2>&1 || packages+=(gcc-fortran)
            flatpak_app_installed com.usebottles.bottles || flatpak_needed=1
            [ "$flatpak_needed" -eq 0 ] || command -v flatpak >/dev/null 2>&1 || packages+=(flatpak)
            ;;
        zypper)
            command -v dash >/dev/null 2>&1 || packages+=(dash)
            command -v psql >/dev/null 2>&1 || packages+=(postgresql)
            command -v gfortran >/dev/null 2>&1 || packages+=(gcc-fortran)
            flatpak_app_installed com.usebottles.bottles || flatpak_needed=1
            [ "$flatpak_needed" -eq 0 ] || command -v flatpak >/dev/null 2>&1 || packages+=(flatpak)
            ;;
        apk)
            command -v dash >/dev/null 2>&1 || packages+=(dash)
            command -v psql >/dev/null 2>&1 || packages+=(postgresql-client)
            command -v gfortran >/dev/null 2>&1 || packages+=(gfortran)
            flatpak_app_installed com.usebottles.bottles || flatpak_needed=1
            [ "$flatpak_needed" -eq 0 ] || command -v flatpak >/dev/null 2>&1 || packages+=(flatpak)
            ;;
    esac

    if [ "${#packages[@]}" -gt 0 ]; then
        warn "Faltan herramientas para la batería ampliada: ${packages[*]}."
        case "$manager" in
            apt-get)
                run_as_root apt-get update
                run_as_root apt-get install -y --no-install-recommends "${packages[@]}"
                ;;
            dnf) run_as_root dnf install -y "${packages[@]}" ;;
            pacman) pacman_install "${packages[@]}" ;;
            zypper) run_as_root zypper --non-interactive install -y "${packages[@]}" ;;
            apk) run_as_root apk add "${packages[@]}" ;;
        esac
    fi

    if ! flatpak_app_installed com.usebottles.bottles; then
        command -v flatpak >/dev/null 2>&1 || {
            err "No se pudo instalar Flatpak para preparar Bottles."
            return 1
        }
        warn "Bottles no está instalado; se instalará desde Flathub para la prueba de compatibilidad Windows."
        flatpak remote-add --if-not-exists --user flathub \
            https://dl.flathub.org/repo/flathub.flatpakrepo
        flatpak install --user -y flathub com.usebottles.bottles
    fi

    local missing=""
    command -v dash >/dev/null 2>&1 || missing="$missing dash"
    command -v psql >/dev/null 2>&1 || missing="$missing psql"
    command -v gfortran >/dev/null 2>&1 || missing="$missing gfortran"
    flatpak_app_installed com.usebottles.bottles || missing="$missing bottles-flatpak"
    if [ -n "$missing" ]; then
        err "Siguen faltando herramientas de la batería ampliada después de instalarlas:$missing"
        return 1
    fi
    ok "Herramientas de batería ampliada disponibles: dash, PostgreSQL, Fortran y Bottles"
}

# WebKitGTK y WebKitWebDriver son paquetes distintos. En algunas distribuciones
# el paquete de desarrollo trae la biblioteca pero elimina el ejecutable del
# driver, así que no basta con comprobar que WebKitGTK esté instalado. La ruta
# explícita permite usar un driver compatible descargado por el administrador
# del sistema o generado desde el mismo WebKitGTK, sin copiar binarios ajenos
# silenciosamente a la release.
find_native_e2e_driver() {
    local candidate
    if [ -n "${E2E_DRIVER_PATH:-}" ] && [ -x "$E2E_DRIVER_PATH" ]; then
        printf '%s\n' "$E2E_DRIVER_PATH"
        return 0
    fi
    for candidate in WebKitWebDriver webkit2gtk-driver; do
        if command -v "$candidate" >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    for candidate in \
        "$HOME/.local/bin/WebKitWebDriver" \
        "$HOME/.cache/lterminal/e2e/WebKitWebDriver"; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

install_e2e_driver() {
    local manager package
    manager="$(package_manager)" || {
        err "No se reconoce el gestor de paquetes para instalar WebKitWebDriver."
        return 1
    }
    warn "Falta WebKitWebDriver; se intentará instalar el paquete nativo del driver con $manager."
    case "$manager" in
        apt-get)
            package=""
            # `apt-cache show` también devuelve 0 para paquetes virtuales o
            # referencias sin candidato instalable. Comprobamos el campo
            # Candidate para evitar seleccionar un nombre que apt no puede
            # resolver (p. ej. Ubuntu 24.10 ofrece webkitgtk-webdriver).
            apt_package_available() {
                local candidate
                candidate="$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2; exit}')"
                [ -n "$candidate" ] && [ "$candidate" != "(none)" ]
            }
            if apt_package_available webkit2gtk-driver; then
                package="webkit2gtk-driver"
            elif apt_package_available webkitgtk-webdriver; then
                package="webkitgtk-webdriver"
            fi
            [ -n "$package" ] || {
                err "Los repositorios apt no ofrecen webkit2gtk-driver ni webkitgtk-webdriver."
                return 1
            }
            run_as_root apt-get update
            run_as_root apt-get install -y --no-install-recommends "$package"
            ;;
        dnf)
            run_as_root dnf install -y webkit2gtk-driver
            ;;
        pacman)
            wait_for_pacman_lock || return 1
            # En Arch/CachyOS WebKitGTK y WebKitWebDriver suelen vivir en
            # paquetes distintos. Primero se consulta el repositorio oficial;
            # solo si no existe allí se ofrece el helper AUR que el usuario
            # haya elegido al pedir explícitamente --install-e2e-driver.
            if pacman -Si webkit2gtk-driver >/dev/null 2>&1; then
                run_as_root pacman -S --needed --noconfirm webkit2gtk-driver
            elif pacman -Si webkitgtk-webdriver >/dev/null 2>&1; then
                run_as_root pacman -S --needed --noconfirm webkitgtk-webdriver
            elif command -v paru >/dev/null 2>&1; then
                warn "No hay driver oficial; se usará paru para instalar webkit2gtk-driver desde AUR."
                paru -S --needed webkit2gtk-driver
            elif command -v yay >/dev/null 2>&1; then
                warn "No hay driver oficial; se usará yay para instalar webkit2gtk-driver desde AUR."
                yay -S --needed webkit2gtk-driver
            else
                err "Arch no ofrece un driver oficial y no hay paru/yay disponible."
                return 1
            fi
            ;;
        zypper)
            run_as_root zypper --non-interactive install -y webkit2gtk-driver || \
                run_as_root zypper --non-interactive install -y webkit2gtk
            ;;
        apk)
            run_as_root apk add webkit2gtk-webdriver || run_as_root apk add webkit2gtk
            ;;
    esac
    E2E_DRIVER_PATH="$(find_native_e2e_driver || true)"
    if [ -n "$E2E_DRIVER_PATH" ]; then
        ok "WebKitWebDriver disponible en $E2E_DRIVER_PATH"
        return 0
    fi
    err "WebKitGTK está instalado, pero no se encontró WebKitWebDriver."
    err "Usa --e2e-driver /ruta/WebKitWebDriver o instala el paquete webdriver de tu distribución."
    return 1
}

ensure_download_tools() {
    if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 \
        && command -v xz >/dev/null 2>&1; then
        return 0
    fi
    install_system_dependencies
}

install_node_22() {
    [ "$AUTO_INSTALL" -eq 1 ] || return 1
    ensure_download_tools || return 1
    local machine node_arch sums archive tmp install_root current
    machine="$(uname -m)"
    case "$machine" in
        x86_64|amd64) node_arch="x64" ;;
        aarch64|arm64) node_arch="arm64" ;;
        armv7l) node_arch="armv7l" ;;
        *) err "Node.js no ofrece un binario automático para la arquitectura $machine."; return 1 ;;
    esac
    warn "Se instalará Node.js 22 para el usuario actual desde nodejs.org."
    tmp="$(mktemp -d)"
    sums="$tmp/SHASUMS256.txt"
    curl --proto '=https' --tlsv1.2 -fsSL \
        https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$sums"
    archive="$(awk -v suffix="linux-$node_arch.tar.xz" '$2 ~ suffix "$" { print $2; exit }' "$sums")"
    if [ -z "$archive" ]; then
        err "No se encontró el archivo de Node.js 22 para $node_arch."
        return 1
    fi
    curl --proto '=https' --tlsv1.2 -fL --progress-bar \
        "https://nodejs.org/dist/latest-v22.x/$archive" -o "$tmp/$archive"
    (cd "$tmp" && grep "  $archive\$" SHASUMS256.txt | sha256sum -c -)
    install_root="$HOME/.local/lib"
    mkdir -p "$install_root" "$HOME/.local/bin"
    tar -xJf "$tmp/$archive" -C "$install_root"
    current="$install_root/${archive%.tar.xz}"
    local tool
    for tool in node npm npx corepack; do
        ln -sfn "$current/bin/$tool" "$HOME/.local/bin/$tool"
    done
    rm -rf "$tmp"
    # Debe quedar por delante de un Node del sistema que pueda ser demasiado
    # antiguo, incluso si ~/.local/bin ya aparecía al final del PATH.
    PATH="$HOME/.local/bin:$PATH"
    export PATH
    ok "Node.js instalado en $current"
}

install_rust_toolchain() {
    [ "$AUTO_INSTALL" -eq 1 ] || return 1
    command -v curl >/dev/null 2>&1 || install_system_dependencies || return 1
    recover_tool rustup "${CARGO_HOME:-$HOME/.cargo}/bin" "$HOME/.cargo/bin" || true
    if command -v rustup >/dev/null 2>&1; then
        warn "rustup existe pero falta Cargo; se instalará el toolchain estable."
        rustup toolchain install stable --profile minimal
        rustup default stable
    else
        local installer
        installer="$(mktemp)"
        warn "Falta Rust; se descargará el instalador oficial rustup."
        curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$installer"
        sh "$installer" -y --profile minimal --default-toolchain stable
        rm -f "$installer"
    fi
    local cargo_env
    cargo_env="${CARGO_HOME:-$HOME/.cargo}/env"
    if [ -s "$cargo_env" ]; then
        # shellcheck disable=SC1090
        . "$cargo_env"
    fi
    recover_tool cargo "${CARGO_HOME:-$HOME/.cargo}/bin" "$HOME/.cargo/bin"
}

ensure_rust_components() {
    if cargo fmt --version >/dev/null 2>&1 && cargo clippy --version >/dev/null 2>&1; then
        return 0
    fi
    [ "$AUTO_INSTALL" -eq 1 ] || {
        err "Faltan rustfmt o clippy y la instalación automática está desactivada."
        return 1
    }
    recover_tool rustup "${CARGO_HOME:-$HOME/.cargo}/bin" "$HOME/.cargo/bin" || \
        install_rust_toolchain || return 1
    warn "Se instalarán los componentes rustfmt y clippy requeridos por npm run check."
    rustup component add rustfmt clippy
    cargo fmt --version >/dev/null 2>&1 && cargo clippy --version >/dev/null 2>&1
}

cd "$PROJECT_ROOT"
configure_cargo_profile

# ---------------------------------------------------------------------------
# 1. Requisitos
# ---------------------------------------------------------------------------
step "Comprobando requisitos"

# nvm es una función de shell, no un binario: en un script no existe salvo que se
# cargue a mano. fnm, volta y asdf sí dejan binarios, pero en rutas del HOME.
if ! command -v node >/dev/null 2>&1; then
    NVM_SCRIPT="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [ -s "$NVM_SCRIPT" ]; then
        # shellcheck disable=SC1090
        . "$NVM_SCRIPT" >/dev/null 2>&1 || true
        nvm use --silent default >/dev/null 2>&1 || true
        command -v node >/dev/null 2>&1 && warn "node no estaba en el PATH; se ha cargado el de nvm."
    fi
fi
recover_tool node \
    "$HOME/.volta/bin" \
    "$HOME/.local/share/fnm/aliases/default/bin" \
    "$HOME/.asdf/shims" \
    /usr/local/bin \
    /usr/local/node/bin || install_node_22 || {
        err "No se pudo instalar Node.js 22 automáticamente."
        exit 1
    }
NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    warn "Node.js $NODE_VERSION es demasiado antiguo; se instalará una versión 22 compatible."
    install_node_22 || {
        err "No se pudo actualizar Node.js; hace falta 22.12 o superior."
        exit 1
    }
    NODE_VERSION="$(node -p 'process.versions.node')"
fi
command -v npm >/dev/null 2>&1 || install_node_22 || {
    err "Node.js está presente, pero falta npm y no se pudo instalar automáticamente."
    exit 1
}
ok "Node.js $NODE_VERSION"

# Este es el caso que más veces se da: rustup recién instalado y la terminal sin
# reabrir. `~/.cargo/env` es justo el archivo que rustup pide cargar, así que se
# usa el suyo antes de inventar rutas.
if ! command -v cargo >/dev/null 2>&1; then
    CARGO_ENV="${CARGO_HOME:-$HOME/.cargo}/env"
    if [ -s "$CARGO_ENV" ]; then
        # shellcheck disable=SC1090
        . "$CARGO_ENV" >/dev/null 2>&1 || true
        command -v cargo >/dev/null 2>&1 && warn "cargo no estaba en el PATH; se ha cargado $CARGO_ENV."
    fi
fi
if ! recover_tool cargo \
    "${CARGO_HOME:-$HOME/.cargo}/bin" \
    "$HOME/.cargo/bin" \
    /usr/local/cargo/bin \
    /opt/rust/bin || ! cargo --version >/dev/null 2>&1; then
    install_rust_toolchain || {
        err "No se pudo instalar automáticamente el toolchain estable de Rust."
        err "Reinténtalo manualmente desde https://rustup.rs"
        exit 1
    }
fi
ok "$(cargo --version)"
ensure_rust_components || {
    err "No se pudieron instalar rustfmt y clippy para el toolchain activo."
    exit 1
}
ok "rustfmt y clippy presentes"

# El enlazador no lo trae cargo. Sin él la compilación llega hasta el final y
# muere en el último paso con "linker `cc` not found", que es el peor momento
# posible para descubrirlo.
if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
    install_system_dependencies || {
        err "Falta un compilador de C (cc/gcc) y no se pudo instalar."
        exit 1
    }
fi

# WebKitGTK es lo que Tauri usa como motor en Linux, y su ausencia se
# manifiesta como un error de enlazado de cientos de líneas a mitad de la
# compilación. Comprobarlo antes ahorra ese rato.
if ! command -v pkg-config >/dev/null 2>&1; then
    install_system_dependencies || {
        err "Falta pkg-config y no se pudo instalar automáticamente."
        exit 1
    }
fi
if command -v pkg-config >/dev/null 2>&1; then
    MISSING_LIBS=""
    for lib in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0; do
        pkg-config --exists "$lib" 2>/dev/null || MISSING_LIBS="$MISSING_LIBS $lib"
    done
    if [ -n "$MISSING_LIBS" ]; then
        warn "Faltan bibliotecas de desarrollo:$MISSING_LIBS"
        install_system_dependencies || {
            err "No se pudieron instalar las bibliotecas nativas de Tauri."
            exit 1
        }
        MISSING_LIBS=""
        for lib in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0; do
            pkg-config --exists "$lib" 2>/dev/null || MISSING_LIBS="$MISSING_LIBS $lib"
        done
        if [ -n "$MISSING_LIBS" ]; then
            err "Siguen faltando bibliotecas después de instalar:$MISSING_LIBS"
            exit 1
        fi
    fi
    ok "WebKitGTK y sus dependencias presentes"
fi

# El plugin GTK de linuxdeploy analiza los módulos de entrada de GTK para
# incluirlos en el AppImage. Si IBus está instalado parcialmente (o falta su
# biblioteca de ejecución), linuxdeploy llega a compilar todo Rust y falla en
# el último paso con `im-ibus.so: libibus-1.0.so.5: cannot open`. Detectarlo
# aquí permite instalar el paquete correcto antes de gastar varios minutos de
# compilación.
has_ibus_runtime() {
    ldconfig -p 2>/dev/null | grep -q 'libibus-1\.0\.so\.5' \
        || [ -e /usr/lib/libibus-1.0.so.5 ] \
        || [ -e /usr/lib64/libibus-1.0.so.5 ]
}

if ! has_ibus_runtime; then
    warn "Falta libibus-1.0.so.5, necesaria para empaquetar AppImage con linuxdeploy."
    install_system_dependencies || {
        err "Instala el paquete 'ibus' y vuelve a ejecutar la build."
        exit 1
    }
    if ! has_ibus_runtime; then
        err "La biblioteca libibus-1.0.so.5 sigue sin estar disponible tras instalar dependencias."
        exit 1
    fi
fi
ok "IBus disponible para linuxdeploy"

if [ -n "$VERSION_OVERRIDE" ]; then
    VERSION="$VERSION_OVERRIDE"
else
    VERSION="$CURRENT_VERSION"
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ] || [ ! -t 1 ]; then
        warn "Modo no interactivo: se conserva la versión $VERSION."
    fi
fi

node scripts/set-package-version.mjs "$VERSION" || {
    err "La versión indicada no es válida o no se pudo guardar en todos los manifiestos."
    exit 1
}
VERSION="$(node -p "require('./package.json').version")"
ok "Versión a compilar: $VERSION"

# ---------------------------------------------------------------------------
# 1.5 Recursos para el AppImage
# ---------------------------------------------------------------------------
step "Comprobando recursos para el AppImage"

# --- 1.5.1 appimagetool ---
APPIMAGETOOL="appimagetool"
if ! command -v "$APPIMAGETOOL" >/dev/null 2>&1; then
    warn "$APPIMAGETOOL no está en el PATH. Se intenta descargar automáticamente..."
    command -v curl >/dev/null 2>&1 || install_system_dependencies || {
        err "Hace falta curl para descargar appimagetool."
        exit 1
    }
    mkdir -p "$HOME/.local/bin"
    case "$(uname -m)" in
        x86_64|amd64) APPIMAGE_ARCH="x86_64" ;;
        aarch64|arm64) APPIMAGE_ARCH="aarch64" ;;
        *)
            err "No hay appimagetool automático para la arquitectura $(uname -m)."
            exit 1
            ;;
    esac
    DOWNLOAD_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-$APPIMAGE_ARCH.AppImage"
    TARGET="$HOME/.local/bin/appimagetool"
    if curl -L --fail --progress-bar "$DOWNLOAD_URL" -o "$TARGET" && chmod +x "$TARGET"; then
        add_to_path "$HOME/.local/bin"
        ok "appimagetool descargado en $TARGET"
    else
        err "No se pudo descargar appimagetool automáticamente."
        echo "    Descárgalo manualmente desde:" >&2
        echo "    $DOWNLOAD_URL" >&2
        echo "    y ponlo en una carpeta del PATH (por ejemplo, /usr/local/bin)." >&2
        exit 1
    fi
else
    ok "appimagetool presente"
fi

# appimagetool puede traer su propio runtime AppImage, pero las versiones
# recientes intentan descargarlo de GitHub si no se les pasa explícitamente.
# Eso hace que una build offline falle al final, después de haber compilado
# todo. Reutilizamos el runtime embebido en el propio appimagetool y lo
# guardamos en caché; también se admite una ruta explícita para CI o mirrors.
case "$(uname -m)" in
    x86_64|amd64) APPIMAGE_ARCH="x86_64" ;;
    aarch64|arm64) APPIMAGE_ARCH="aarch64" ;;
    *) APPIMAGE_ARCH="$(uname -m)" ;;
esac
# El plugin AppImage de linuxdeploy usa Zstandard en sus versiones actuales.
# Se puede sobrescribir para un toolchain antiguo que soporte otra compresión.
# El plugin de Tauri/linuxdeploy actual solo genera Zstandard con el
# mksquashfs que trae integrado. El appimagetool antiguo que suele estar en el
# PATH puede no entender Zstandard; aun así, XZ no es compatible con el runtime
# AppImage extraído que usan el smoke y los entornos sin FUSE. La compresión
# final se mantiene en Zstandard con la herramienta moderna y usa gzip (zlib)
# con la antigua, salvo que el usuario la fuerce explícitamente.
APPIMAGE_COMP="${LTERMINAL_APPIMAGE_COMP:-zstd}"
# El appimagetool que distribuye Tauri es moderno y trae el mksquashfs que
# necesita. Preferirlo evita que una versión antigua del PATH intente montar
# su propio AppImage (fallando sin FUSE) o rechace Zstandard.
BUNDLED_APPIMAGETOOL="${XDG_CACHE_HOME:-$HOME/.cache}/tauri/squashfs-root/plugins/linuxdeploy-plugin-appimage/appimagetool-prefix/usr/bin/appimagetool"
BUNDLED_APPIMAGE_BIN_DIR="$(dirname "$BUNDLED_APPIMAGETOOL")"
if [ -x "$BUNDLED_APPIMAGETOOL" ] && [ -x "$BUNDLED_APPIMAGE_BIN_DIR/mksquashfs" ]; then
    APPIMAGETOOL="$BUNDLED_APPIMAGETOOL"
    export PATH="$BUNDLED_APPIMAGE_BIN_DIR:$PATH"
    APPIMAGE_POST_COMP="${LTERMINAL_APPIMAGE_POST_COMP:-zstd}"
    ok "appimagetool moderno de Tauri seleccionado"
else
    APPIMAGE_POST_COMP="${LTERMINAL_APPIMAGE_POST_COMP:-gzip}"
fi
APPIMAGE_RUNTIME_FILE="${LTERMINAL_APPIMAGE_RUNTIME:-}"
if [ -n "$APPIMAGE_RUNTIME_FILE" ]; then
    if [ ! -f "$APPIMAGE_RUNTIME_FILE" ] || [ ! -s "$APPIMAGE_RUNTIME_FILE" ]; then
        err "LTERMINAL_APPIMAGE_RUNTIME no apunta a un runtime válido: $APPIMAGE_RUNTIME_FILE"
        exit 1
    fi
    ok "Runtime AppImage explícito: $APPIMAGE_RUNTIME_FILE"
else
    APPIMAGE_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/lterminal/appimage"
    if ! mkdir -p "$APPIMAGE_CACHE_DIR" 2>/dev/null; then
        warn "No se puede escribir en la caché de usuario; se usará una caché temporal para esta build."
        APPIMAGE_CACHE_DIR="${TMPDIR:-/tmp}/lterminal-appimage-cache"
        if ! mkdir -p "$APPIMAGE_CACHE_DIR" 2>/dev/null; then
            warn "No se pudo crear una caché local del runtime AppImage; se continuará sin caché."
            APPIMAGE_CACHE_DIR=""
        fi
    fi
    APPIMAGE_RUNTIME_CACHE="${APPIMAGE_CACHE_DIR:+$APPIMAGE_CACHE_DIR/runtime-$APPIMAGE_ARCH-$APPIMAGE_COMP}"
    if [ -n "$APPIMAGE_RUNTIME_CACHE" ] && [ -s "$APPIMAGE_RUNTIME_CACHE" ]; then
        APPIMAGE_RUNTIME_FILE="$APPIMAGE_RUNTIME_CACHE"
        ok "Runtime AppImage reutilizado desde caché"
    else
        # El runtime embebido en algunas versiones antiguas de appimagetool no
        # entiende Zstandard. Primero se intenta el runtime oficial actual,
        # que es pequeño y se conserva para las siguientes builds.
        RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-$APPIMAGE_ARCH"
        RUNTIME_DOWNLOAD_TARGET="${APPIMAGE_RUNTIME_CACHE:-${TMPDIR:-/tmp}/lterminal-appimage-runtime-$APPIMAGE_ARCH-$APPIMAGE_COMP}"
        RUNTIME_DOWNLOAD_TMP="$RUNTIME_DOWNLOAD_TARGET.tmp.$$"
        if command -v curl >/dev/null 2>&1 && \
            curl -L --fail --silent --show-error --retry 2 --connect-timeout 8 --max-time 60 \
                "$RUNTIME_URL" -o "$RUNTIME_DOWNLOAD_TMP"; then
            chmod +x "$RUNTIME_DOWNLOAD_TMP"
            if [ -n "$APPIMAGE_RUNTIME_CACHE" ]; then
                mv -f "$RUNTIME_DOWNLOAD_TMP" "$APPIMAGE_RUNTIME_CACHE"
                APPIMAGE_RUNTIME_FILE="$APPIMAGE_RUNTIME_CACHE"
            else
                APPIMAGE_RUNTIME_FILE="$RUNTIME_DOWNLOAD_TMP"
            fi
            ok "Runtime AppImage oficial descargado y listo para el bundler"
        else
            rm -f "$RUNTIME_DOWNLOAD_TMP"
        fi
    fi
    if [ -z "$APPIMAGE_RUNTIME_FILE" ]; then
        if [ "$APPIMAGE_COMP" = "zstd" ]; then
            err "No hay un runtime AppImage moderno disponible para la compresión Zstandard."
            echo "    Con red se descarga automáticamente; sin red, usa LTERMINAL_APPIMAGE_RUNTIME=/ruta/runtime-$APPIMAGE_ARCH." >&2
            exit 1
        fi
        APPIMAGETOOL_BIN="$(command -v "$APPIMAGETOOL" 2>/dev/null || true)"
        RUNTIME_OFFSET=""
        if [ -n "$APPIMAGETOOL_BIN" ] && [ -x "$APPIMAGETOOL_BIN" ]; then
            RUNTIME_OFFSET="$(APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL_BIN" --appimage-offset 2>/dev/null || true)"
        fi
        if [[ "$RUNTIME_OFFSET" =~ ^[0-9]+$ ]] && [ "$RUNTIME_OFFSET" -ge 65536 ]; then
            RUNTIME_TMP="${APPIMAGE_RUNTIME_CACHE:+$APPIMAGE_RUNTIME_CACHE.tmp.$$}"
            if [ -n "$RUNTIME_TMP" ] && \
                dd if="$APPIMAGETOOL_BIN" of="$RUNTIME_TMP" bs=1 count="$RUNTIME_OFFSET" status=none && \
                chmod +x "$RUNTIME_TMP" && mv -f "$RUNTIME_TMP" "$APPIMAGE_RUNTIME_CACHE"; then
                APPIMAGE_RUNTIME_FILE="$APPIMAGE_RUNTIME_CACHE"
                ok "Runtime AppImage extraído del appimagetool y guardado en caché"
            else
                [ -z "$RUNTIME_TMP" ] || rm -f "$RUNTIME_TMP"
                warn "No se pudo extraer el runtime embebido de appimagetool; se intentará el mecanismo remoto."
            fi
        else
            warn "appimagetool no expone un runtime local; se intentará descargarlo si no hay caché."
        fi
    fi
fi

# Las versiones antiguas de linuxdeploy traen un `strip` que no reconoce
# `.relr.dyn`, una sección ELF legítima que producen las distribuciones
# modernas. No se debe compensar desactivando el stripping permanentemente:
# se refresca el binario cacheado desde el release oficial cuando su build es
# anterior a la que ya soporta RELR. La descarga es atómica para no dejar un
# AppImage parcial si se interrumpe.
LINUXDEPLOY_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-x86_64.AppImage"
if [ "${APPIMAGE_ARCH:-x86_64}" = "x86_64" ] && [ -x "$LINUXDEPLOY_CACHE" ]; then
    LINUXDEPLOY_VERSION="$(APPIMAGE_EXTRACT_AND_RUN=1 "$LINUXDEPLOY_CACHE" --version 2>/dev/null || true)"
    LINUXDEPLOY_BUILD="$(printf '%s\n' "$LINUXDEPLOY_VERSION" | sed -n 's/.*build \([0-9][0-9]*\).*/\1/p')"
    if [ -z "$LINUXDEPLOY_BUILD" ] || [ "$LINUXDEPLOY_BUILD" -lt 368 ]; then
        LINUXDEPLOY_URL="https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage"
        LINUXDEPLOY_TMP="$LINUXDEPLOY_CACHE.tmp.$$"
        if command -v curl >/dev/null 2>&1 && \
            curl -L --fail --silent --show-error --retry 2 --connect-timeout 8 --max-time 60 \
                "$LINUXDEPLOY_URL" -o "$LINUXDEPLOY_TMP"; then
            chmod +x "$LINUXDEPLOY_TMP"
            if APPIMAGE_EXTRACT_AND_RUN=1 "$LINUXDEPLOY_TMP" --version >/dev/null 2>&1; then
                mv -f "$LINUXDEPLOY_TMP" "$LINUXDEPLOY_CACHE"
                ok "linuxdeploy actualizado para soportar ELF RELR"
            else
                rm -f "$LINUXDEPLOY_TMP"
                err "La descarga de linuxdeploy no supera su comprobación de ejecución."
                exit 1
            fi
        else
            rm -f "$LINUXDEPLOY_TMP"
            if [ "${LTERMINAL_APPIMAGE_NO_STRIP:-0}" != "1" ]; then
                err "linuxdeploy antiguo y no se pudo actualizar; no se desactiva stripping automáticamente."
                echo "    Revisa la red o usa LTERMINAL_APPIMAGE_NO_STRIP=1 como fallback consciente." >&2
                exit 1
            fi
        fi
    fi
fi

# --- 1.5.2 Verificar todas las rutas de configuración ---
TAURI_CONF="$TAURI_DIR/tauri.conf.json"
LINUX_CONF="$TAURI_DIR/tauri.linux.conf.json"

# Función para extraer valores JSON con node
get_json_value() {
    local file="$1"
    local key="$2"
    node -p "try { require('$file').$key } catch(e) { '' }" 2>/dev/null || echo ""
}

if [ ! -f "$TAURI_CONF" ]; then
    err "No se encontró $TAURI_CONF"
    exit 1
fi

# Función para verificar que una ruta (relativa o absoluta) existe
check_path() {
    local path="$1"
    local desc="$2"
    if [[ "$path" != /* ]]; then
        path="$PROJECT_ROOT/$path"
    fi
    if [ -e "$path" ]; then
        ok "$desc: $path"
        return 0
    else
        warn "$desc: $path no existe"
        return 1
    fi
}

# --- Iconos ---
# Las rutas de `tauri.conf.json` son relativas a `src-tauri/`, no a la raíz.
# Crear un icono rojo de reserva ocultaba una configuración rota y dejaba una
# carpeta `icons/` ajena en la raíz; para empaquetar se exigen los recursos
# reales que Tauri va a incluir.
ICON_DIR="$TAURI_DIR/icons"
MISSING_ICONS=""
for icon in 32x32.png 128x128.png 128x128@2x.png icon.ico icon.icns; do
    [ -f "$ICON_DIR/$icon" ] || MISSING_ICONS="$MISSING_ICONS $icon"
done
if [ -n "$MISSING_ICONS" ]; then
    err "Faltan iconos obligatorios en $ICON_DIR:$MISSING_ICONS"
    exit 1
fi
ok "Iconos de Tauri encontrados en $ICON_DIR"

# --- Archivo .desktop ---
DESKTOP_FILE=""
if [ -f "$LINUX_CONF" ]; then
    DESKTOP_FILE="$(get_json_value "$LINUX_CONF" 'tauri.bundle.linux.desktop')"
fi
if [ -z "$DESKTOP_FILE" ] || [ "$DESKTOP_FILE" = "''" ]; then
    DESKTOP_FILE="$(get_json_value "$TAURI_CONF" 'tauri.bundle.linux.desktop')"
fi
if [ -z "$DESKTOP_FILE" ] || [ "$DESKTOP_FILE" = "''" ]; then
    warn "No se especifica archivo .desktop; Tauri lo generará automáticamente."
else
    if [[ "$DESKTOP_FILE" != /* ]]; then
        DESKTOP_FILE="$PROJECT_ROOT/$DESKTOP_FILE"
    fi
    if [ -f "$DESKTOP_FILE" ]; then
        ok "Archivo .desktop encontrado: $DESKTOP_FILE"
    else
        warn "El archivo .desktop especificado no existe: $DESKTOP_FILE. Tauri lo generará por defecto."
    fi
fi

# --- Otras rutas (appimage, etc.) ---
# No hay muchas más rutas en la configuración estándar, pero podemos buscar cualquier otra referencia a archivos en tauri.bundle
# Por ejemplo, si hay "appimage" con "template" o "bundle" con "resources"
# Nos limitamos a las más comunes.

# --- Verificar permisos y existencia del directorio de salida ---
BUNDLE_OUTPUT="$TAURI_DIR/target/release/bundle"
mkdir -p "$BUNDLE_OUTPUT" 2>/dev/null || true
if [ -d "$BUNDLE_OUTPUT" ]; then
    ok "Directorio de salida del bundle: $BUNDLE_OUTPUT"
    # Limpiar para evitar residuos de builds anteriores
    if [ -d "$BUNDLE_OUTPUT/appimage" ] || [ -d "$BUNDLE_OUTPUT/appimage_deb" ]; then
        warn "Eliminando restos de bundling anterior..."
        rm -rf "$BUNDLE_OUTPUT/appimage"
        # Tauri usa esta carpeta como staging aunque solo se solicite AppImage.
        # Si se conserva, linuxdeploy puede volver a copiar un binario de otra
        # plataforma en el AppDir recién creado.
        rm -rf "$BUNDLE_OUTPUT/appimage_deb"
    fi
else
    err "No se puede crear el directorio $BUNDLE_OUTPUT. Revisa permisos."
    exit 1
fi

# --- Aseguramos que el binario compilado (aún no existe) será ejecutable, pero eso lo hará Tauri ---

# ---------------------------------------------------------------------------
# 2. Nada en marcha que estorbe
# ---------------------------------------------------------------------------
# El equivalente del bloque de build.ps1. En Linux borrar un archivo en uso sí
# se puede, así que no es fatal, pero las dos situaciones siguen dando
# resultados raros: `npm ci` vacía node_modules debajo de un Vite en marcha, y
# la comprobación de humo del final no distingue su propia ventana de una que ya
# estaba abierta.
step "Comprobando que no haya nada en marcha"

# Sin ss ni lsof: bash abre el socket él mismo. Un timeout corto para que un
# puerto filtrado no cuelgue la build.
if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1420' 2>/dev/null; then
    warn "Hay algo escuchando en el puerto 1420 (¿npm start / npm run dev?)."
    warn "npm ci vaciará node_modules debajo de ese proceso; ciérralo si la build falla raro."
else
    ok "El puerto 1420 está libre"
fi

is_lterminal_running() {
    # La L entre corchetes evita que pgrep encuentre la propia línea de orden
    # que contiene este patrón. `comm` está limitado a 15 caracteres, por eso
    # el binario Linux se comprueba por su nombre corto y el AppImage por argv.
    pgrep -x lterminal >/dev/null 2>&1 || \
        pgrep -f '[/][L]Terminal[_-][^/[:space:]]*\.AppImage([[:space:]]|$)' >/dev/null 2>&1
}

if is_lterminal_running; then
    warn "Hay una instancia abierta; el smoke usará un token único y no la confundirá con esta build."
else
    ok "Nada bloqueando los archivos"
fi

# ---------------------------------------------------------------------------
# 3. Dependencias
# ---------------------------------------------------------------------------
if [ "$CLEAN" -eq 1 ]; then
    step "Limpiando (node_modules y target)"
    rm -rf "$PROJECT_ROOT/node_modules"
    cargo clean --manifest-path "$TAURI_DIR/Cargo.toml" || warn "cargo clean falló; se sigue igualmente."
fi

if [ "$EXTENDED_TESTS" -eq 1 ]; then
    step "Preparando herramientas de la batería ampliada"
    install_extended_test_tools || {
        err "No se pudieron preparar todas las herramientas mínimas de la batería ampliada."
        exit 1
    }
fi

step "Verificando dependencias del frontend"
# `npm ci` borra y recrea enlaces en `.bin`. Comprobar la escritura antes da
# una solución clara cuando una ejecución anterior con sudo dejó esos enlaces
# a nombre de root/nobody, en vez de caer al genérico error EACCES de npm.
assert_writable_directory() {
    local directory="$1"
    [ -e "$directory" ] || return 0
    [ -d "$directory" ] || {
        err "$directory existe pero no es una carpeta."
        return 1
    }
    local probe="$directory/.lterminal-permission-$$"
    if ! (umask 077; : > "$probe") 2>/dev/null; then
        err "No se puede escribir en $directory. Corrige solo esa caché con:"
        echo "    sudo chown -R $(id -un):$(id -gn) $PROJECT_ROOT/node_modules" >&2
        return 1
    fi
    rm -f "$probe"
}

assert_writable_directory "$PROJECT_ROOT/node_modules" || exit 1
assert_writable_directory "$PROJECT_ROOT/node_modules/.bin" || exit 1

if [ -d "$PROJECT_ROOT/node_modules" ] &&
    [ ! -e "$PROJECT_ROOT/node_modules/@tauri-apps/cli-linux-x64-gnu" ] &&
    [ -e "$PROJECT_ROOT/node_modules/@tauri-apps/cli-win32-x64-msvc" ]; then
    NODE_MODULES_RESTORE="$PROJECT_ROOT/.node_modules.windows.$$"
    if mv "$PROJECT_ROOT/node_modules" "$NODE_MODULES_RESTORE"; then
        warn "Aislando node_modules Windows durante la build Linux; se restaurará al terminar."
    else
        NODE_MODULES_RESTORE=""
        err "No se pudo apartar node_modules Windows para evitar mezclar binarios nativos."
        exit 1
    fi
fi

# No destruir un árbol sano: `npm ci` borra node_modules antes de reconstruirlo
# y puede dejar un binario nativo de esbuild a medio instalar si la build se
# interrumpe o el sistema de archivos rechaza el reemplazo. Si faltan las
# piezas mínimas sí se instala de forma reproducible desde el lock.
dependencies_ready() {
    [ "$CLEAN" -eq 0 ] \
        && [ -x "$PROJECT_ROOT/node_modules/.bin/vite" ] \
        && [ -x "$PROJECT_ROOT/node_modules/esbuild/bin/esbuild" ] \
        && node -e "require('./node_modules/vite/package.json'); require('./node_modules/esbuild/package.json')" >/dev/null 2>&1 \
        && linux_native_dependencies_ready
}

# `node_modules` puede haberse creado en Windows y reutilizarse desde WSL
# (ambos comparten el árbol del proyecto). Los ejecutables JS parecen sanos,
# pero Rollup y esbuild cargan paquetes opcionales específicos de la plataforma;
# si faltan, svelte-check solo revela el problema bastante más tarde. Detectar
# aquí la pareja nativa obliga a `npm ci` a reconstruirla antes de empezar los
# checks o Cargo.
linux_native_dependencies_ready() {
    case "$(uname -m)" in
        x86_64)
            node -e "require('@rollup/rollup-linux-x64-gnu'); require('@esbuild/linux-x64')" >/dev/null 2>&1
            ;;
        aarch64|arm64)
            node -e "require('@rollup/rollup-linux-arm64-gnu'); require('@esbuild/linux-arm64')" >/dev/null 2>&1
            ;;
        *)
            # Para arquitecturas nuevas no inventamos un nombre opcional: el
            # propio bundler emitirá un diagnóstico accionable si el lockfile
            # aún no las incluye.
            return 0
            ;;
    esac
}
if dependencies_ready; then
    ok "Dependencias ya presentes; se conserva node_modules y se evita reinstalarlo"
elif [ ! -f "$PROJECT_ROOT/package-lock.json" ]; then
    warn "No hay package-lock.json; se usa npm install."
    npm install
elif ! npm ci; then
    warn "npm ci falló (lock desincronizado, red o binario nativo bloqueado). Se reintenta con npm install."
    npm install
fi
ok "Dependencias instaladas"
if [ "$SKIP_CHECKS" -eq 0 ]; then
    AUDIT_LOG="$(mktemp "${TMPDIR:-/tmp}/lterminal-npm-audit.XXXXXX")"
    if npm audit --audit-level=high >"$AUDIT_LOG" 2>&1; then
        ok "Dependencias sin vulnerabilidades altas o críticas conocidas"
    else
        AUDIT_CODE=$?
        if grep -Eiq 'audit endpoint|EAI_AGAIN|ENETUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network' "$AUDIT_LOG"; then
            if [ "${LTERMINAL_LINK_CHECK:-fail}" = "warn" ]; then
                warn "No se pudo consultar npm audit por un problema de red; se continúa en modo warn."
            else
                cat "$AUDIT_LOG" >&2
                err "npm audit no pudo consultar el registro. Reintenta con red o usa LTERMINAL_LINK_CHECK=warn solo si aceptas una auditoría diferida."
                rm -f "$AUDIT_LOG"
                exit "$AUDIT_CODE"
            fi
        else
            cat "$AUDIT_LOG" >&2
            rm -f "$AUDIT_LOG"
            err "npm audit detectó vulnerabilidades altas/críticas o un error no relacionado con red."
            exit "$AUDIT_CODE"
        fi
    fi
    rm -f "$AUDIT_LOG"
else
    warn "Auditoría npm omitida por --skip-checks."
fi

# ---------------------------------------------------------------------------
# 4. Comprobaciones
# ---------------------------------------------------------------------------
# Compilar una release que no pasa sus propias pruebas no tiene sentido: se
# tarda más en descubrirlo después que en comprobarlo aquí.
if [ "$SKIP_CHECKS" -eq 0 ]; then
    step "Comprobando tipos, formato, clippy y pruebas"
    npm run check
    ok "Todo verde"
else
    warn "Comprobaciones saltadas por petición (--skip-checks)"
fi

# ---------------------------------------------------------------------------
# 5. Compilación
# ---------------------------------------------------------------------------
step "Compilando el AppImage"
# Tauri compila el binario Linux en el mismo `target/release` que puede haber
# usado antes una build de Windows. Si queda un ejecutable antiguo con el
# identificador de Windows, linuxdeploy lo considera otro binario de la
# aplicación y lo copia dentro del AppImage. Solo se eliminan estos dos
# nombres conocidos; nunca se borra el directorio release completo.
for stale_binary in "$TAURI_DIR/target/release/com.winslim.terminal" \
    "$TAURI_DIR/target/release/winslim-terminal"; do
    if [ -e "$stale_binary" ]; then
        warn "Eliminando artefacto cruzado de Windows antes de empaquetar: $stale_binary"
        rm -f "$stale_binary"
    fi
done
# El AppDir también sobrevive entre builds. Eliminar los restos conocidos aquí
# evita que linuxdeploy los vuelva a detectar como binarios o metadata de una
# build de Windows anterior. No se toca ningún archivo fuente ni el resto del
# caché de Cargo.
STALE_APPDIR="$BUNDLE_DIR/LTerminal.AppDir"
for stale_appdir_file in \
    "$STALE_APPDIR/usr/bin/com.winslim.terminal" \
    "$STALE_APPDIR/usr/bin/winslim-terminal" \
    "$STALE_APPDIR/usr/share/metainfo/com.winslim.terminal.metainfo.xml"; do
    if [ -e "$stale_appdir_file" ]; then
        warn "Eliminando resto de Windows del AppDir Linux: $stale_appdir_file"
        rm -f "$stale_appdir_file"
    fi
done
# linuxdeploy's embedded strip can fail on newer ELF sections such as .relr.dyn.
# Prefer stripping (it keeps the release smaller and avoids linuxdeploy's
# `$NO_STRIP` warning). A caller can opt into the compatibility fallback on a
# host whose linuxdeploy cannot handle its system linker with
# LTERMINAL_APPIMAGE_NO_STRIP=1.
if [ "${LTERMINAL_APPIMAGE_NO_STRIP:-0}" = "1" ]; then
    export NO_STRIP=1
    warn "AppImage: stripping desactivado por LTERMINAL_APPIMAGE_NO_STRIP=1."
else
    unset NO_STRIP
fi
# El build hook de Tauri vuelve a invocar `npm run build`. Propagar esta marca
# evita que `--skip-checks` se cumpla en el script exterior pero falle dentro
# del hook por enlaces o fuentes externas sin red.
if [ "$SKIP_CHECKS" -eq 1 ]; then
    export LTERMINAL_SKIP_CHECKS=1
else
    unset LTERMINAL_SKIP_CHECKS
fi
# linuxdeploy-plugin-appimage no recibe los argumentos del appimagetool que
# ejecutamos después: los toma de LDAI_RUNTIME_FILE durante la pasada de Tauri.
# Mantener la misma ruta en ambos caminos evita que el primer bundling vuelva a
# intentar descargar runtime-x86_64 desde GitHub.
if [ -n "${APPIMAGE_RUNTIME_FILE:-}" ]; then
    export LDAI_RUNTIME_FILE="$APPIMAGE_RUNTIME_FILE"
else
    unset LDAI_RUNTIME_FILE
fi
# El runtime AppImage moderno se usa durante la pasada de linuxdeploy, que
# necesita Zstandard. El repaquetado final puede usar XZ para seguir siendo
# compatible con un appimagetool antiguo instalado en el PATH.
export APPIMAGE_COMP
export LDAI_COMP="$APPIMAGE_COMP"
# Tauri's bundled AppImage plugin only recognizes product-style metadata
# filenames and reports a false filename/Component-ID mismatch for our valid
# reverse-DNS component. We validate the XML ourselves below and disable only
# that duplicate heuristic in both plugin and final appimagetool passes.
export LDAI_NO_APPSTREAM=1
# Las herramientas de AppImage también son AppImages. En WSL, contenedores y
# sistemas sin FUSE deben poder ejecutarse mediante extracción desde el propio
# paso de bundling, no solo durante la comprobación de humo posterior.
if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then
    export APPIMAGE_EXTRACT_AND_RUN=1
    warn "Sin FUSE: las herramientas AppImage usarán extracción temporal durante el bundling."
fi
# Esta limpieza también se aplica al proceso que ejecuta Tauri. Así funciona
# incluso si el script se inició desde una AppImage antigua que dejó variables
# privadas de montaje en el entorno del terminal.
if ! env -u APPDIR -u APPIMAGE -u ARGV0 -u LD_AUDIT -u LD_LIBRARY_PATH -u LD_PRELOAD \
    npm run tauri -- build --config "$LINUX_CONF" --verbose; then
    # Tauri 2/linuxdeploy duplica el metadato proporcionado con el nombre del
    # producto (LTerminal.appdata.xml). Su ID sigue siendo el identificador
    # estable com.lterminal.terminal y appimagetool rechaza esa copia por no
    # coincidir el nombre del archivo. El metadato canónico ya está incluido;
    # retiramos únicamente la copia generada y reintentamos el empaquetado.
    APPDIR_RECOVERY="$BUNDLE_DIR/LTerminal.AppDir"
    GENERATED_APPDATA="$APPDIR_RECOVERY/usr/share/metainfo/LTerminal.appdata.xml"
    CANONICAL_APPDATA="$APPDIR_RECOVERY/usr/share/metainfo/com.lterminal.terminal.metainfo.xml"
    if [ ! -d "$APPDIR_RECOVERY" ] || [ ! -f "$GENERATED_APPDATA" ] || \
        [ ! -f "$CANONICAL_APPDATA" ]; then
        err "Tauri falló antes de crear un AppDir recuperable."
        exit 1
    fi
    warn "Corrigiendo el nombre duplicado de AppStream generado por Tauri..."
    rm -f "$GENERATED_APPDATA"
    # Si se cambió mainBinaryName entre builds, linuxdeploy puede conservar el
    # ejecutable previo dentro del AppDir aunque ya no sea el destino de Exec.
    rm -f "$APPDIR_RECOVERY/usr/bin/com.lterminal.terminal"
    rm -f "$APPDIR_RECOVERY/usr/bin/com.winslim.terminal"
    rm -f "$APPDIR_RECOVERY/usr/bin/winslim-terminal"
    rm -f "$APPDIR_RECOVERY/usr/share/metainfo/com.winslim.terminal.metainfo.xml"
    # linuxdeploy puede empaquetar el backend TLS de GIO junto con su propia
    # pila GnuTLS/nettle. En distribuciones rolling esa mezcla se carga además
    # de los módulos del sistema y puede segfaultar antes de mostrar la ventana.
    # GIO conserva su búsqueda normal de módulos del host; retiramos solo la
    # copia privada conflictiva, no el soporte HTTPS de la aplicación.
    rm -f "$APPDIR_RECOVERY/usr/lib/gio/modules/libgiognutls.so"
    if command -v appstreamcli >/dev/null 2>&1; then
        appstreamcli validate --no-net "$CANONICAL_APPDATA"
    fi
fi

# El hook de GTK forma parte del runtime que el usuario ejecuta, no solo de la
# comprobación de humo. WebKitGTK intenta usar DMA-BUF en combinaciones de
# NVIDIA/Wayland que pueden dejar una ventana gris o una PTY sin pintar; se
# desactiva por defecto y se permite recuperar el comportamiento original con
# WEBKIT_DISABLE_DMABUF_RENDERER=0. Reempaquetar aquí hace que el resultado sea
# idéntico tanto si Tauri terminó en su primera pasada como si usó recovery.
APPDIR="$BUNDLE_DIR/LTerminal.AppDir"
GTK_HOOK="$APPDIR/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if [ ! -f "$GTK_HOOK" ]; then
    err "El AppDir no contiene el hook GTK esperado: $GTK_HOOK"
    exit 1
fi
# linuxdeploy puede copiar el módulo TLS de GIO junto con su propia pila
# GnuTLS/nettle. En distribuciones rolling esa copia se carga antes que los
# módulos del sistema y puede cerrar la aplicación durante el arranque. GIO
# conserva su soporte HTTPS normal usando el módulo del host.
rm -f "$APPDIR/usr/lib/gio/modules/libgiognutls.so"
if ! grep -q 'WEBKIT_DISABLE_DMABUF_RENDERER' "$GTK_HOOK"; then
    printf '\nexport WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"\n' \
        >> "$GTK_HOOK"
fi
# WebKitGTK puede consultar GStreamer durante el arranque aunque LTerminal no
# reproduzca multimedia. linuxdeploy copia la biblioteca libgstapp, pero no
# siempre su plugin appsink; incluirlo evita el aviso y mantiene ese soporte
# autocontenido cuando el AppImage se ejecuta en otro sistema.
GSTREAMER_PLUGIN_DIR="$(pkg-config --variable=pluginsdir gstreamer-1.0 2>/dev/null || true)"
if [ -n "$GSTREAMER_PLUGIN_DIR" ] && [ -f "$GSTREAMER_PLUGIN_DIR/libgstapp.so" ]; then
    mkdir -p "$APPDIR/usr/lib/gstreamer-1.0"
    cp -f "$GSTREAMER_PLUGIN_DIR/libgstapp.so" "$APPDIR/usr/lib/gstreamer-1.0/libgstapp.so"
fi
GSTREAMER_SCANNER="$(command -v gst-plugin-scanner 2>/dev/null || true)"
if [ -z "$GSTREAMER_SCANNER" ] && [ -x /usr/lib/gstreamer-1.0/gst-plugin-scanner ]; then
    GSTREAMER_SCANNER=/usr/lib/gstreamer-1.0/gst-plugin-scanner
fi
if [ -n "$GSTREAMER_SCANNER" ] && [ -x "$GSTREAMER_SCANNER" ]; then
    mkdir -p "$APPDIR/usr/lib/gstreamer-1.0"
    cp -f "$GSTREAMER_SCANNER" "$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner"
fi
if [ -x "$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner" ] && \
    ! grep -q 'GST_PLUGIN_SCANNER' "$GTK_HOOK"; then
    printf '\nexport GST_PLUGIN_SCANNER="${GST_PLUGIN_SCANNER:-$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner}"\n' \
        >> "$GTK_HOOK"
fi
# Tauri usa el nombre técnico del binario en `Icon=`, mientras que algunas
# versiones del bundler dejan en la raíz el nombre del producto. Mantener
# ambos nombres hace que el icono funcione en AppStream y en appimagetool.
if [ -f "$APPDIR/LTerminal.png" ] && [ ! -e "$APPDIR/lterminal.png" ]; then
    ln -s LTerminal.png "$APPDIR/lterminal.png"
fi
# appimagetool autodetects application metadata by looking for the product
# named `LTerminal.appdata.xml`. Tauri also stages the same valid component
# under its reverse-DNS filename; keep one component and use the conventional
# product filename in the final AppDir so appimagetool does not emit its
# external metadata advisory.
APPSTREAM_DIR="$APPDIR/usr/share/metainfo"
CANONICAL_APPSTREAM="$APPSTREAM_DIR/com.lterminal.terminal.metainfo.xml"
PRODUCT_APPSTREAM="$APPSTREAM_DIR/LTerminal.appdata.xml"
if [ -f "$CANONICAL_APPSTREAM" ] && command -v appstreamcli >/dev/null 2>&1; then
    appstreamcli validate --no-net "$CANONICAL_APPSTREAM"
fi
if [ -f "$CANONICAL_APPSTREAM" ] && [ ! -e "$PRODUCT_APPSTREAM" ]; then
    mv "$CANONICAL_APPSTREAM" "$PRODUCT_APPSTREAM"
fi
if [ ! -f "$PRODUCT_APPSTREAM" ]; then
    err "Falta metadata AppStream final: $PRODUCT_APPSTREAM"
    exit 1
fi
# appimagetool's name heuristic is disabled, but the XML was validated under
# its canonical reverse-DNS filename immediately above.
APPIMAGETOOL_ARGS=(--no-appstream --comp "$APPIMAGE_POST_COMP")
if [ -n "$APPIMAGE_RUNTIME_FILE" ]; then
    APPIMAGETOOL_ARGS+=(--runtime-file "$APPIMAGE_RUNTIME_FILE")
fi
ARCH="${APPIMAGE_ARCH:-$(uname -m)}" APPIMAGE_EXTRACT_AND_RUN=1 \
    "$APPIMAGETOOL" "${APPIMAGETOOL_ARGS[@]}" "$APPDIR" \
    "$BUNDLE_DIR/LTerminal_${VERSION}_amd64.AppImage"

APPIMAGE="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
if [ -z "$APPIMAGE" ]; then
    err "La compilación terminó pero no hay ningún AppImage en $BUNDLE_DIR."
    exit 1
fi
chmod +x "$APPIMAGE"
APPIMAGE_MB="$(( $(stat -c '%s' "$APPIMAGE") / 1024 / 1024 ))"
ok "AppImage: $APPIMAGE (${APPIMAGE_MB} MB)"

# Una release Linux debe tener un único ejecutable nativo y el desktop file
# debe apuntar a él. Esta comprobación evita que un binario Windows arrastrado
# de una build anterior quede oculto dentro del AppImage.
if [ ! -x "$APPDIR/usr/bin/lterminal" ]; then
    err "El AppDir no contiene el ejecutable Linux esperado: $APPDIR/usr/bin/lterminal"
    exit 1
fi
for forbidden_binary in "$APPDIR/usr/bin/com.winslim.terminal" \
    "$APPDIR/usr/bin/winslim-terminal"; do
    if [ -e "$forbidden_binary" ]; then
        err "El AppDir contiene un ejecutable cruzado de Windows: $forbidden_binary"
        exit 1
    fi
done
if [ ! -f "$APPDIR/LTerminal.desktop" ] || ! grep -Fxq 'Exec=lterminal' "$APPDIR/LTerminal.desktop"; then
    err "El AppDir no tiene un desktop file Linux coherente con lterminal."
    exit 1
fi
ok "AppDir Linux coherente: solo lterminal y LTerminal.desktop"

# Tauri vuelve a construir el frontend mediante beforeBuildCommand. Verificar
# el bundle que acaba de entrar en el AppImage evita publicar por accidente un
# frontend viejo si una configuración de Tauri deja de ejecutar ese paso.
#
# No se buscan nombres de funciones TypeScript como `shortcutFromEvent`: Vite
# puede minificarlos o renombrarlos aunque la lógica esté presente. Los
# marcadores deben ser claves de preferencias/eventos que sobreviven al bundle
# de producción y forman parte del contrato runtime.
FRONTEND_BUNDLE="$(find "$PROJECT_ROOT/dist/assets" -maxdepth 1 -type f -name 'index-*.js' -print -quit 2>/dev/null || true)"
if [ -z "$FRONTEND_BUNDLE" ]; then
    err "No se encontró el bundle JavaScript del frontend en dist/assets."
    exit 1
fi
for FRONTEND_MARKER in shortcutPaneLeft shortcutOpenSystemExplorer environment-controls; do
    if ! grep -Fq "$FRONTEND_MARKER" "$FRONTEND_BUNDLE"; then
        err "El frontend compilado no contiene '$FRONTEND_MARKER': parece una build desactualizada."
        exit 1
    fi
done
ok "Frontend compartido actualizado: atajos configurables y preferencias presentes"

# Que la build produzca SOLO el AppImage no es un detalle estético: un .deb o un
# .rpm que se cuelen acabarían publicados en la release sin que nadie los haya
# pedido ni probado.
UNEXPECTED="$(find "$TAURI_DIR/target/release/bundle" -maxdepth 2 \
    \( -name '*.deb' -o -name '*.rpm' \) -print 2>/dev/null || true)"
if [ -n "$UNEXPECTED" ]; then
    err "La build ha generado artefactos que no debía:"
    echo "$UNEXPECTED" >&2
    echo "    Revisa bundle.targets en src-tauri/tauri.linux.conf.json." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 6. Comprobación de humo
# ---------------------------------------------------------------------------
# Que compile no significa que arranque. Sin servidor gráfico no se puede
# comprobar, y eso no es un fallo de la build: se avisa y se sigue.
step "Comprobación de humo"

# Un AppImage se monta con FUSE 2, que las distribuciones recientes ya no
# instalan de serie. Sin él no arranca ni el «hola mundo», y el error
# ("dlopen(): error loading libfuse.so.2") parece un fallo de la app cuando no
# lo es. El propio runtime sabe descomprimirse en /tmp y ejecutarse desde ahí:
# es lo mismo que hace `--appimage-extract-and-run`.
if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then
    warn "No hay FUSE instalado: el AppImage se comprobará mediante extracción temporal."
    warn "Quien lo descargue necesitará FUSE 2, o lanzarlo con --appimage-extract-and-run."
    export APPIMAGE_EXTRACT_AND_RUN=1
fi

# Esta comprobación no requiere servidor gráfico y verifica primero que el
# runtime AppImage es legible. Debe ejecutarse DESPUÉS de activar el modo de
# extracción: en CI, WSL y escritorios donde FUSE no está disponible, el
# runtime sigue siendo perfectamente válido y puede comprobarse sin montar.
if ! APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}" \
    "$APPIMAGE" --appimage-version >/dev/null 2>&1; then
    err "El runtime del AppImage no responde; no se publicará un artefacto dañado."
    exit 1
fi
ok "Runtime AppImage verificable"

if ! graphical_session_available; then
    warn "La sesión gráfica no es accesible desde esta shell: no se ejecuta el smoke visual. El AppImage sí se generó."
else
    SMOKE_LOG="$(mktemp)"
    SMOKE_APP_LOG="$(mktemp)"
    SMOKE_TOKEN="build-$$-$(date +%s%N)"
    # El smoke debe ser idéntico en máquinas con FUSE y sin FUSE. El montaje
    # directo puede heredar librerías/variables del host y producir un falso
    # fallo antes de crear la PTY; la extracción temporal es el camino
    # reproducible que también usa validate-release.sh.
    # `setsid` hace que también se pueda cerrar el binario nativo que el
    # AppImage lanza internamente; matar solo este wrapper no es suficiente.
    setsid env \
        APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}" \
        WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}" \
        LTERMINAL_SMOKE_TOKEN="$SMOKE_TOKEN" \
        LTERMINAL_LOG_FILE="$SMOKE_APP_LOG" "$APPIMAGE" >"$SMOKE_LOG" 2>&1 &
    SMOKE_PID=$!
    READY=0
    # El smoke puede esperar más que el usuario: una primera sonda de hardware
    # en frío no debe convertir un AppImage válido en un falso fallo de build.
    # La aplicación, en cambio, ya muestra el banner mínimo sin esperar esas
    # sondas y lo completa progresivamente.
    SMOKE_READY_TIMEOUT="${LTERMINAL_SMOKE_READY_TIMEOUT:-45}"
    if ! [[ "$SMOKE_READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
        SMOKE_READY_TIMEOUT=45
    fi
    for attempt in $(seq 1 "$SMOKE_READY_TIMEOUT"); do
        if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
        if smoke_log_ready "$SMOKE_APP_LOG" "$SMOKE_TOKEN"; then
            READY=1
            break
        fi
        if [ $((attempt % 5)) -eq 0 ]; then
            warn "Smoke de arranque sigue esperando ($attempt/$(printf '%s' "$SMOKE_READY_TIMEOUT") s)..."
        fi
        sleep 1
    done
    # El lanzador AppImage puede terminar después de extraer el runtime y
    # delegar en el binario nativo. En ese caso `SMOKE_PID` ya no representa a
    # la aplicación, aunque el token confirma que frontend, IPC y PTY sí
    # llegaron a estar preparados. Exigir que siga vivo daba falsos negativos
    # justo en builds con APPIMAGE_EXTRACT_AND_RUN=1.
    if [ "$READY" -eq 1 ]; then
        cleanup_smoke_process
        ok "Backend, frontend, IPC, xterm y primera terminal preparados"
        rm -f "$SMOKE_LOG"
        rm -f "$SMOKE_APP_LOG"
    else
        cleanup_smoke_process
        err "El AppImage no completó el frontend y la primera terminal; no se publicará."
        if [ -s "$SMOKE_LOG" ]; then
            echo "    Salida de la aplicación:" >&2
            sed 's/^/      /' "$SMOKE_LOG" >&2
        fi
        echo "    Últimas líneas del log de esta ejecución ($SMOKE_APP_LOG):" >&2
        tail -n 80 "$SMOKE_APP_LOG" 2>/dev/null | sed 's/^/      /' >&2 || true
        rm -f "$SMOKE_LOG"
        rm -f "$SMOKE_APP_LOG"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# 7. Release
# ---------------------------------------------------------------------------
# El nombre importa: es el que busca el actualizador de la propia app al elegir
# el adjunto de la release (ver self_update::asset_for_platform, que se queda
# con el .AppImage que no mencione otra plataforma).
step "Publicando la release y su huella"
# NO en dist/: ahi escribe Vite el frontend compilado y lo vacia en cada build.
RELEASE_DIR="$PROJECT_ROOT/release"
mkdir -p "$RELEASE_DIR"
if [ "$FAST_BUILD" -eq 1 ]; then
    RELEASE_DIR="$RELEASE_DIR/dev"
    RELEASE_NAME="LTerminal-$VERSION-$(uname -m)-dev.AppImage"
    mkdir -p "$RELEASE_DIR"
else
    RELEASE_NAME="LTerminal-$VERSION-$(uname -m).AppImage"
fi
# No borres AppImage ni SHA256SUMS anteriores: una misma release puede incluir
# varias arquitecturas, perfiles o plataformas. El manifiesto se actualiza de
# forma incremental y solo sustituye la entrada del artefacto actual.
cp "$APPIMAGE" "$RELEASE_DIR/$RELEASE_NAME"
chmod +x "$RELEASE_DIR/$RELEASE_NAME"

RELEASE_HASH="$(sha256sum "$RELEASE_DIR/$RELEASE_NAME" | awk '{print $1}')"
node "$PROJECT_ROOT/scripts/update-release-hash.mjs" \
    --manifest "$RELEASE_DIR/SHA256SUMS.txt" \
    --artifact "$RELEASE_NAME" \
    --hash "$RELEASE_HASH"
SIGNING_REQUIRED="${LTERMINAL_REQUIRE_SIGNING:-${CI:-0}}"
if [ -n "${LTERMINAL_SIGNING_PRIVATE_KEY:-}" ]; then
    if [ -z "${LTERMINAL_UPDATE_PUBLIC_KEY:-}" ]; then
        rm -f "$RELEASE_DIR/SHA256SUMS.txt.sig"
        err "Falta LTERMINAL_UPDATE_PUBLIC_KEY: no se puede verificar la firma del manifiesto."
        exit 1
    fi
    node "$PROJECT_ROOT/scripts/sign-release-manifest.mjs" \
        --manifest "$RELEASE_DIR/SHA256SUMS.txt" \
        --signature "$RELEASE_DIR/SHA256SUMS.txt.sig"
    node "$PROJECT_ROOT/scripts/sign-release-manifest.mjs" \
        --manifest "$RELEASE_DIR/SHA256SUMS.txt" \
        --signature "$RELEASE_DIR/SHA256SUMS.txt.sig" --verify
    ok "Firma Ed25519 del manifiesto verificada"
elif [[ "$SIGNING_REQUIRED" =~ ^(1|true|yes)$ ]]; then
    err "Falta LTERMINAL_SIGNING_PRIVATE_KEY: una release oficial no puede publicarse sin firma."
    exit 1
else
    # Evita que una firma de una ejecución anterior acompañe accidentalmente
    # a un manifiesto nuevo cuando la build local no tiene material de firma.
    rm -f "$RELEASE_DIR/SHA256SUMS.txt.sig"
    warn "Release local sin firma Ed25519; el actualizador rechazará este artefacto."
fi
ok "Release: $RELEASE_DIR/$RELEASE_NAME"
ok "SHA256: $RELEASE_HASH"
node "$PROJECT_ROOT/scripts/verify-release-artifacts.mjs" \
    --linux "$RELEASE_DIR/$RELEASE_NAME" \
    --appdir "$APPDIR"
ok "Estructura ELF/AppImage y AppDir Linux verificadas"

if [ "$EXTENDED_TESTS" -eq 1 ]; then
    step "Pruebas ampliadas secuenciales (shells, herramientas y E2E)"
    if command -v ionice >/dev/null 2>&1; then
        if ! nice -n 10 ionice -c 3 bash "$PROJECT_ROOT/linux/exercise-host.sh"; then
            post_build_issue "Las sondas de shells/herramientas fallaron; revisa la salida de exercise-host.sh."
        fi
    else
        if ! nice -n 10 bash "$PROJECT_ROOT/linux/exercise-host.sh"; then
            post_build_issue "Las sondas de shells/herramientas fallaron; revisa la salida de exercise-host.sh."
        fi
    fi
    [ "$POST_BUILD_FAILURE" -eq 0 ] && ok "Shells y REPL instalados respondieron correctamente"

    if ! graphical_session_available; then
        post_build_issue "E2E omitido: no hay una sesión gráfica accesible (DISPLAY/WAYLAND_DISPLAY)."
    else
        if ! command -v tauri-driver >/dev/null 2>&1; then
            if [ "$INSTALL_E2E_DRIVER" -eq 1 ] && command -v cargo >/dev/null 2>&1; then
                warn "Falta tauri-driver; se instalará con cargo para completar E2E."
                if cargo install tauri-driver --locked; then
                    recover_tool tauri-driver "${CARGO_HOME:-$HOME/.cargo}/bin" "$HOME/.cargo/bin" || true
                else
                    post_build_issue "No se pudo instalar tauri-driver; el AppImage ya está publicado."
                fi
            fi
        fi
        if ! command -v tauri-driver >/dev/null 2>&1; then
            post_build_issue "E2E omitido: falta tauri-driver. Reintenta con --install-e2e-driver."
        else
            E2E_DRIVER_PATH="$(find_native_e2e_driver || true)"
            if [ -z "$E2E_DRIVER_PATH" ] && [ "$INSTALL_E2E_DRIVER" -eq 1 ]; then
                if ! install_e2e_driver; then
                    post_build_issue "E2E omitido: no se pudo preparar WebKitWebDriver."
                fi
            fi
            if [ -z "$E2E_DRIVER_PATH" ]; then
                post_build_issue "E2E omitido: falta WebKitWebDriver (--e2e-driver /ruta/WebKitWebDriver)."
            else
                E2E_REPORT="$(mktemp "${TMPDIR:-/tmp}/lterminal-e2e-report.XXXXXX.json")"
                if ! TAURI_NATIVE_DRIVER="$E2E_DRIVER_PATH" \
                    E2E_BINARY="$RELEASE_DIR/$RELEASE_NAME" \
                    LTERMINAL_SMOKE_REPORT="$E2E_REPORT" npm run e2e; then
                    post_build_issue "E2E falló. Se conserva el informe para diagnóstico: $E2E_REPORT"
                elif ! node "$PROJECT_ROOT/scripts/verify-e2e-report.mjs" "$E2E_REPORT"; then
                    post_build_issue "El informe E2E está incompleto: $E2E_REPORT"
                else
                    rm -f "$E2E_REPORT"
                    ok "E2E confirmó todas las fases: ventana, terminal, paneles, comandos, preferencias y redimensionado"
                fi
            fi
        fi
    fi
fi

if [ "$CROSS_WINDOWS" -eq 1 ]; then
    step "Pruebas cruzadas Windows mediante MinGW y Wine"
    cross_args=(--full-tests --wine-repeats 3 --non-interactive)
    [ "$FAST_BUILD" -eq 1 ] && cross_args+=(--fast)
    [ "$SKIP_CHECKS" -eq 1 ] && cross_args+=(--skip-checks)
    [ "$ALLOW_OFFLINE_CHECKS" -eq 1 ] && cross_args+=(--allow-offline-checks)
    [ "$AUTO_INSTALL" -eq 0 ] && cross_args+=(--no-install)
    if bash "$PROJECT_ROOT/linux/build-windows.sh" "${cross_args[@]}"; then
        ok "Release Windows x64 compilada y ejecutada repetidamente bajo Wine"
    else
        post_build_issue "Build/pruebas cruzadas Windows bajo Wine fallaron; la release Linux ya está publicada."
    fi
fi

if [ "$NO_RUN" -eq 0 ] && graphical_session_available; then
    step "Lanzando LTerminal"
    "$RELEASE_DIR/$RELEASE_NAME" >/dev/null 2>&1 &
    disown
elif [ "$NO_RUN" -eq 0 ]; then
    warn "No se lanza la aplicación: la sesión gráfica no es accesible desde esta shell."
fi

echo
printf '\033[32mListo. LTerminal %s compilado y verificado.\033[0m\n' "$VERSION"
echo "  AppImage: $RELEASE_DIR/$RELEASE_NAME"
printf '  Tiempo total: %ss\n' "$((SECONDS - BUILD_STARTED_SECONDS))"
if [ "$POST_BUILD_FAILURE" -ne 0 ]; then
    echo
    printf '\033[33mLa build terminó y publicó el AppImage, pero quedaron validaciones pendientes:\033[0m\n'
    for issue in "${POST_BUILD_ISSUES[@]}"; do
        printf '  - %s\n' "$issue"
    done
    printf '\033[33mEl código de salida es 1 para que CI no ignore estos diagnósticos.\033[0m\n'
    exit 1
fi
