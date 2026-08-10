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

CLEAN=0
NO_RUN=0
SKIP_CHECKS=0
for arg in "$@"; do
    case "$arg" in
        --clean)       CLEAN=1 ;;
        --no-run)      NO_RUN=1 ;;
        --skip-checks) SKIP_CHECKS=1 ;;
        -h|--help)
            echo "Uso: $0 [--clean] [--skip-checks] [--no-run]"
            exit 0
            ;;
        *)
            echo "Argumento desconocido: $arg" >&2
            exit 2
            ;;
    esac
done

step() { CURRENT_STEP="$1"; printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mOK:\033[0m %s\n' "$1"; }
warn() { printf '    \033[33mAVISO:\033[0m %s\n' "$1"; }
err()  { printf '    \033[31mERROR:\033[0m %s\n' "$1" >&2; }

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
    /usr/local/node/bin || {
    err "Falta Node.js. Instálalo desde el gestor de tu distribución o desde https://nodejs.org (>= 22.12)."
    exit 1
}
NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    err "Node.js $NODE_VERSION es demasiado antiguo; hace falta 22.12 o superior."
    exit 1
fi
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
recover_tool cargo \
    "${CARGO_HOME:-$HOME/.cargo}/bin" \
    "$HOME/.cargo/bin" \
    /usr/local/cargo/bin \
    /opt/rust/bin || {
    err "Falta el toolchain de Rust. Instálalo desde https://rustup.rs y reabre la terminal."
    err "Si ya lo tienes instalado, carga su entorno con: source \"\$HOME/.cargo/env\""
    exit 1
}
ok "$(cargo --version)"

# El enlazador no lo trae cargo. Sin él la compilación llega hasta el final y
# muere en el último paso con "linker `cc` not found", que es el peor momento
# posible para descubrirlo.
if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
    err "Falta un compilador de C (cc/gcc), que es lo que Rust usa como enlazador."
    echo "    Debian/Ubuntu: sudo apt install build-essential" >&2
    echo "    Fedora:        sudo dnf groupinstall 'Development Tools'" >&2
    echo "    Arch:          sudo pacman -S base-devel" >&2
    exit 1
fi

# WebKitGTK es lo que Tauri usa como motor en Linux, y su ausencia se
# manifiesta como un error de enlazado de cientos de líneas a mitad de la
# compilación. Comprobarlo antes ahorra ese rato.
if command -v pkg-config >/dev/null 2>&1; then
    MISSING_LIBS=""
    for lib in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0; do
        pkg-config --exists "$lib" 2>/dev/null || MISSING_LIBS="$MISSING_LIBS $lib"
    done
    if [ -n "$MISSING_LIBS" ]; then
        err "Faltan bibliotecas de desarrollo:$MISSING_LIBS"
        echo "    Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev build-essential curl file libssl-dev libayatana-appindicator3-dev librsvg2-dev" >&2
        echo "    Fedora:        sudo dnf install webkit2gtk4.1-devel libsoup3-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel" >&2
        echo "    Arch:          sudo pacman -S webkit2gtk-4.1 libsoup3 base-devel curl wget file openssl libappindicator-gtk3 librsvg" >&2
        exit 1
    fi
    ok "WebKitGTK y sus dependencias presentes"
else
    warn "Sin pkg-config no se pueden comprobar las bibliotecas de WebKitGTK; se sigue igualmente."
fi

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
    mkdir -p "$HOME/.local/bin"
    DOWNLOAD_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
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
ICON_DIR="$(get_json_value "$TAURI_CONF" 'tauri.bundle.icon')"
if [ -z "$ICON_DIR" ] || [ "$ICON_DIR" = "''" ]; then
    ICON_DIR="icons"
fi
if [[ "$ICON_DIR" != /* ]]; then
    ICON_DIR="$PROJECT_ROOT/$ICON_DIR"
fi
if [ -d "$ICON_DIR" ]; then
    PNG_COUNT=$(find "$ICON_DIR" -maxdepth 1 -type f -name '*.png' 2>/dev/null | wc -l)
    if [ "$PNG_COUNT" -gt 0 ]; then
        ok "Iconos encontrados en $ICON_DIR ($PNG_COUNT PNGs)"
    else
        warn "No hay iconos PNG en $ICON_DIR. Se generará un icono por defecto."
        mkdir -p "$ICON_DIR"
        # Crear un icono simple de 128x128 usando convert si está disponible, o fallar con un aviso
        if command -v convert >/dev/null 2>&1; then
            convert -size 128x128 xc:red "$ICON_DIR/icon-128x128@2x.png" 2>/dev/null || true
        fi
    fi
else
    warn "La carpeta de iconos '$ICON_DIR' no existe. Se creará y se pondrá un icono genérico."
    mkdir -p "$ICON_DIR"
    if command -v convert >/dev/null 2>&1; then
        convert -size 128x128 xc:red "$ICON_DIR/icon-128x128@2x.png" 2>/dev/null || true
    fi
fi

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
    if [ -d "$BUNDLE_OUTPUT/appimage" ]; then
        warn "Eliminando restos de bundling anterior..."
        rm -rf "$BUNDLE_OUTPUT/appimage"
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

if pgrep -x lterminal >/dev/null 2>&1 || pgrep -f 'LTerminal-.*\.AppImage' >/dev/null 2>&1; then
    warn "LTerminal está abierto. La comprobación de humo del final puede confundirse con esa ventana."
    warn "Ciérralo para que el resultado sea fiable."
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
# linuxdeploy's embedded strip can fail on newer ELF sections such as .relr.dyn.
# Disable its internal binary stripping and keep the AppImage build compatible.
export NO_STRIP=1
# npm run tauri -- build
# Reemplázala por:
npm run tauri -- build --verbose

APPIMAGE="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
if [ -z "$APPIMAGE" ]; then
    err "La compilación terminó pero no hay ningún AppImage en $BUNDLE_DIR."
    exit 1
fi
chmod +x "$APPIMAGE"
APPIMAGE_MB="$(( $(stat -c '%s' "$APPIMAGE") / 1024 / 1024 ))"
ok "AppImage: $APPIMAGE (${APPIMAGE_MB} MB)"

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
    warn "No hay FUSE instalado: el AppImage se ejecutará descomprimiéndose (APPIMAGE_EXTRACT_AND_RUN)."
    warn "Quien lo descargue necesitará FUSE 2, o lanzarlo con --appimage-extract-and-run."
    export APPIMAGE_EXTRACT_AND_RUN=1
fi

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    warn "Sin servidor gráfico: no se puede comprobar que arranque. El AppImage sí se generó."
else
    SMOKE_LOG="$(mktemp)"
    "$APPIMAGE" >"$SMOKE_LOG" 2>&1 &
    SMOKE_PID=$!
    sleep 6
    if kill -0 "$SMOKE_PID" 2>/dev/null; then
        kill "$SMOKE_PID" 2>/dev/null || true
        ok "Arranca y se mantiene abierto"
        rm -f "$SMOKE_LOG"
    else
        err "La aplicación se cerró sola. Revisa el log en ~/.config/lterminal/logs."
        # Antes se mandaba su salida a /dev/null, así que la causa —que casi
        # siempre viene impresa aquí— se perdía justo cuando hacía falta.
        if [ -s "$SMOKE_LOG" ]; then
            echo "    Salida de la aplicación:" >&2
            sed 's/^/      /' "$SMOKE_LOG" >&2
        fi
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

if [ "$NO_RUN" -eq 0 ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    step "Lanzando LTerminal"
    "$RELEASE_DIR/$RELEASE_NAME" >/dev/null 2>&1 &
    disown
fi

echo
printf '\033[32mListo. LTerminal %s compilado y verificado.\033[0m\n' "$VERSION"
echo "  AppImage: $RELEASE_DIR/$RELEASE_NAME"
