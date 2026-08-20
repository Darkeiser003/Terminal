#!/usr/bin/env bash
#
# Build de LTerminal (Tauri 2 + Rust) para Linux.
#
# Produce UNA sola cosa: el AppImage. Sin .deb, sin .rpm, sin carpeta
# desempaquetada y sin accesos directos; el porqué está en src-tauri/BUNDLE.md.
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
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-1}"

CLEAN=0
NO_RUN=0
SKIP_CHECKS=0
AUTO_INSTALL=1
VERSION_OVERRIDE=""
EXTENDED_TESTS=-1
INSTALL_E2E_DRIVER=0
E2E_DRIVER_PATH="${TAURI_NATIVE_DRIVER:-}"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --clean)       CLEAN=1 ;;
        --no-run)      NO_RUN=1 ;;
        --skip-checks) SKIP_CHECKS=1 ;;
        --no-install)  AUTO_INSTALL=0 ;;
        --extended-tests) EXTENDED_TESTS=1 ;;
        --full-tests)     EXTENDED_TESTS=1 ;;
        --no-extended-tests) EXTENDED_TESTS=0 ;;
        --install-e2e-driver) INSTALL_E2E_DRIVER=1 ;;
        --e2e-driver)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ]; then
                echo "--e2e-driver necesita la ruta a WebKitWebDriver." >&2
                exit 2
            fi
            E2E_DRIVER_PATH="$1"
            ;;
        --e2e-driver=*) E2E_DRIVER_PATH="${1#*=}" ;;
        --version)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ]; then
                echo "--version necesita un valor SemVer, por ejemplo 1.4.4" >&2
                exit 2
            fi
            VERSION_OVERRIDE="$1"
            ;;
        -h|--help)
            echo "Uso: $0 [--clean] [--skip-checks] [--no-run] [--no-install] [--extended-tests|--full-tests|--no-extended-tests] [--install-e2e-driver] [--e2e-driver RUTA] [--version X.Y.Z]"
            exit 0
            ;;
        *)
            echo "Argumento desconocido: $1" >&2
            exit 2
            ;;
    esac
    shift
done

step() { CURRENT_STEP="$1"; printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mOK:\033[0m %s\n' "$1"; }
warn() { printf '    \033[33mAVISO:\033[0m %s\n' "$1"; }
err()  { printf '    \033[31mERROR:\033[0m %s\n' "$1" >&2; }

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
on_error() {
    local code=$?
    printf '\n\033[31mLa build falló en: %s (código %s)\033[0m\n' "$CURRENT_STEP" "$code" >&2
    echo "Revisa los mensajes de arriba." >&2
}
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
            # Arch/CachyOS no admite actualizaciones parciales: sincronizar sin
            # actualizar puede mezclar bibliotecas incompatibles.
            run_as_root pacman -Syu --needed --noconfirm \
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
            if apt-cache show webkit2gtk-driver >/dev/null 2>&1; then
                package="webkit2gtk-driver"
            elif apt-cache show webkitgtk-webdriver >/dev/null 2>&1; then
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TAURI_DIR="$PROJECT_ROOT/src-tauri"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle/appimage"

cd "$PROJECT_ROOT"

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

CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [ -n "$VERSION_OVERRIDE" ]; then
    VERSION="$VERSION_OVERRIDE"
elif [ -t 0 ]; then
    read -r -p "Versión a compilar [$CURRENT_VERSION]: " VERSION
    VERSION="${VERSION:-$CURRENT_VERSION}"
else
    VERSION="$CURRENT_VERSION"
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

step "Instalando dependencias del frontend (npm ci)"
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
# `npm ci` exige un package-lock.json coherente con package.json y aborta si no
# lo es. Es lo que se quiere en una release —instala exactamente lo fijado— pero
# no es motivo para no poder compilar: se avisa y se cae a `npm install`, que
# resuelve y actualiza el lock.
if [ ! -f "$PROJECT_ROOT/package-lock.json" ]; then
    warn "No hay package-lock.json; se usa npm install en vez de npm ci."
    npm install
elif ! npm ci; then
    warn "npm ci falló (lock desincronizado o red). Se reintenta con npm install."
    npm install
fi
ok "Dependencias instaladas"
npm audit --audit-level=high
ok "Dependencias sin vulnerabilidades altas o críticas conocidas"

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
# Disable its internal binary stripping and keep the AppImage build compatible.
export NO_STRIP=1
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
ARCH="${APPIMAGE_ARCH:-$(uname -m)}" "$APPIMAGETOOL" "$APPDIR" \
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
FRONTEND_BUNDLE="$(find "$PROJECT_ROOT/dist/assets" -maxdepth 1 -type f -name 'index-*.js' -print -quit 2>/dev/null || true)"
if [ -z "$FRONTEND_BUNDLE" ]; then
    err "No se encontró el bundle JavaScript del frontend en dist/assets."
    exit 1
fi
for FRONTEND_MARKER in ControlRight KeyW environment-controls; do
    if ! grep -Fq "$FRONTEND_MARKER" "$FRONTEND_BUNDLE"; then
        err "El frontend compilado no contiene '$FRONTEND_MARKER': parece una build desactualizada."
        exit 1
    fi
done
ok "Frontend compartido actualizado: controles de teclado y preferencias presentes"

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

# Esta comprobación no requiere servidor gráfico y verifica primero que el
# runtime AppImage es legible. Es una garantía reproducible incluso en CI o
# cuando ya hay otra ventana de LTerminal abierta.
if ! "$APPIMAGE" --appimage-version >/dev/null 2>&1; then
    err "El runtime del AppImage no responde; no se publicará un artefacto dañado."
    exit 1
fi
ok "Runtime AppImage verificable"

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

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    warn "Sin servidor gráfico: no se puede comprobar que arranque. El AppImage sí se generó."
else
    SMOKE_LOG="$(mktemp)"
    SMOKE_TOKEN="build-$$-$(date +%s)"
    # El smoke debe ser idéntico en máquinas con FUSE y sin FUSE. El montaje
    # directo puede heredar librerías/variables del host y producir un falso
    # fallo antes de crear la PTY; la extracción temporal es el camino
    # reproducible que también usa validate-release.sh.
    APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}" \
        WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}" \
        LTERMINAL_SMOKE_TOKEN="$SMOKE_TOKEN" "$APPIMAGE" >"$SMOKE_LOG" 2>&1 &
    SMOKE_PID=$!
    READY=0
    for _ in $(seq 1 20); do
        if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
        if grep -Fq "\"smokeToken\":\"$SMOKE_TOKEN\"" "$HOME/.config/lterminal/logs/main.log" 2>/dev/null; then
            READY=1
            break
        fi
        sleep 1
    done
    if [ "$READY" -eq 1 ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
        kill "$SMOKE_PID" 2>/dev/null || true
        ok "Backend, frontend, IPC, xterm y primera terminal preparados"
        rm -f "$SMOKE_LOG"
    else
        kill "$SMOKE_PID" 2>/dev/null || true
        err "El AppImage no completó el frontend y la primera terminal; no se publicará."
        if [ -s "$SMOKE_LOG" ]; then
            echo "    Salida de la aplicación:" >&2
            sed 's/^/      /' "$SMOKE_LOG" >&2
        fi
        echo "    Últimas líneas de $HOME/.config/lterminal/logs/main.log:" >&2
        tail -n 80 "$HOME/.config/lterminal/logs/main.log" 2>/dev/null | sed 's/^/      /' >&2 || true
        rm -f "$SMOKE_LOG"
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
RELEASE_NAME="LTerminal-$VERSION-$(uname -m).AppImage"
# Los de versiones anteriores se quedaban y SHA256SUMS acababa listando varias.
rm -f "$RELEASE_DIR"/LTerminal-*.AppImage
cp "$APPIMAGE" "$RELEASE_DIR/$RELEASE_NAME"
chmod +x "$RELEASE_DIR/$RELEASE_NAME"

( cd "$RELEASE_DIR" && sha256sum "$RELEASE_NAME" > SHA256SUMS.txt )
ok "Release: $RELEASE_DIR/$RELEASE_NAME"
ok "SHA256: $(cut -d' ' -f1 < "$RELEASE_DIR/SHA256SUMS.txt")"

if [ "$EXTENDED_TESTS" -lt 0 ]; then
    if [ -t 0 ]; then
        printf '¿Ejecutar también la batería completa de shells y REPL instalados? [s/N]: '
        read -r EXTENDED_REPLY
        case "$EXTENDED_REPLY" in
            s|S|si|SI|sí|Sí) EXTENDED_TESTS=1 ;;
            *) EXTENDED_TESTS=0 ;;
        esac
    else
        EXTENDED_TESTS=0
    fi
fi

if [ "$EXTENDED_TESTS" -eq 1 ]; then
    step "Pruebas ampliadas secuenciales (shells, herramientas y E2E)"
    if command -v ionice >/dev/null 2>&1; then
        nice -n 10 ionice -c 3 bash "$PROJECT_ROOT/linux/exercise-host.sh"
    else
        nice -n 10 bash "$PROJECT_ROOT/linux/exercise-host.sh"
    fi
    ok "Shells y REPL instalados respondieron correctamente"

    if ! graphical_session_available; then
        err "El test completo requiere una sesión gráfica accesible para ejecutar E2E."
        err "DISPLAY/WAYLAND_DISPLAY está ausente o no se puede abrir desde esta shell."
        exit 1
    fi
    if ! command -v tauri-driver >/dev/null 2>&1; then
        if [ "$INSTALL_E2E_DRIVER" -eq 1 ] && command -v cargo >/dev/null 2>&1; then
            warn "Falta tauri-driver; se instalará con cargo para completar E2E."
            cargo install tauri-driver --locked
            recover_tool tauri-driver "${CARGO_HOME:-$HOME/.cargo}/bin" "$HOME/.cargo/bin" || true
        fi
    fi
    if ! command -v tauri-driver >/dev/null 2>&1; then
        err "Falta tauri-driver. Reintenta con --install-e2e-driver o instálalo con cargo."
        exit 1
    fi
    E2E_DRIVER_PATH="$(find_native_e2e_driver || true)"
    if [ -z "$E2E_DRIVER_PATH" ] && [ "$INSTALL_E2E_DRIVER" -eq 1 ]; then
        install_e2e_driver
    fi
    if [ -z "$E2E_DRIVER_PATH" ]; then
        err "Falta WebKitWebDriver para E2E en Linux."
        err "Reintenta con --install-e2e-driver o indica --e2e-driver /ruta/WebKitWebDriver."
        exit 1
    fi
    TAURI_NATIVE_DRIVER="$E2E_DRIVER_PATH" E2E_BINARY="$RELEASE_DIR/$RELEASE_NAME" npm run e2e
    ok "E2E confirmó ventana, terminal, barra y Ajustes"
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
