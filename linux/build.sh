#!/usr/bin/env bash
# linux/build.sh - LTerminal
# Equivalente a windows/build.ps1 para usuarios de WSL/Linux nativo:
# comprueba dependencias, instala lo que falte (con confirmación), compila
# y genera un AppImage distribuible (npm run dist:linux), y lo lanza.
#
# Uso:
#   ./linux/build.sh              # pide confirmación antes de instalar algo
#   ./linux/build.sh --yes        # responde "sí" automáticamente a todo
#   ./linux/build.sh --no-run     # no lanza el AppImage al terminar
#   ./linux/build.sh --reinstall  # borra node_modules y reinstala desde cero

set -euo pipefail

YES=0
NO_RUN=0
REINSTALL=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y) YES=1 ;;
        --no-run) NO_RUN=1 ;;
        --reinstall) REINSTALL=1 ;;
        *) echo "Argumento desconocido: $arg" >&2; exit 1 ;;
    esac
done

step() { echo; echo -e "\033[36m==> $*\033[0m"; }
ok()   { echo -e "    \033[32mOK:\033[0m $*"; }
warn() { echo -e "    \033[33mAVISO:\033[0m $*"; }
err()  { echo -e "    \033[31mERROR:\033[0m $*" >&2; }

# Pide confirmacion antes de instalar algo (salvo --yes). Nunca se instala
# nada de forma silenciosa: el usuario ve el comando y decide, igual que
# windows/build.ps1 y el resto de la app.
confirm() {
    if [ "$YES" -eq 1 ]; then return 0; fi
    read -r -p "    $1 (s/N) " resp
    case "$resp" in
        [sSyY]*) return 0 ;;
        *) return 1 ;;
    esac
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ELECTRON_DIR="$PROJECT_ROOT/electron"

echo "=================================================="
echo "  LTerminal - build automatico (AppImage)"
echo "=================================================="

if [ ! -d "$ELECTRON_DIR" ]; then
    err "No se encontro la carpeta 'electron' en: $ELECTRON_DIR"
    exit 1
fi
ok "Proyecto: $PROJECT_ROOT"
ok "App Electron: $ELECTRON_DIR"

if grep -qi microsoft /proc/version 2>/dev/null; then
    warn "Detectado WSL. El AppImage resultante es una app grafica (Electron):"
    warn "necesitaras WSLg (Windows 11 / WSL con soporte GUI) o un servidor X para poder EJECUTARLA, no solo compilarla."
fi

# ------------------------------------------------------------------
# 0. Detectar gestor de paquetes
# ------------------------------------------------------------------
PKG_MANAGER=""
for candidate in apt dnf pacman zypper; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PKG_MANAGER="$candidate"
        break
    fi
done

if [ -z "$PKG_MANAGER" ]; then
    warn "No se detecto un gestor de paquetes conocido (apt/dnf/pacman/zypper)."
    warn "Este script no podra instalar nada automaticamente; instala Node.js/build tools a mano si faltan."
fi

pkg_install() {
    case "$PKG_MANAGER" in
        apt) sudo apt update && sudo apt install -y "$@" ;;
        dnf) sudo dnf install -y "$@" ;;
        pacman) sudo pacman -S --noconfirm "$@" ;;
        zypper) sudo zypper install -y "$@" ;;
        *) return 1 ;;
    esac
}

install_electron_runtime() {
    case "$PKG_MANAGER" in
        apt)
            local gtk_pkg="libgtk-3-0"
            local asound_pkg="libasound2"
            apt-cache show libgtk-3-0t64 >/dev/null 2>&1 && gtk_pkg="libgtk-3-0t64"
            apt-cache show libasound2t64 >/dev/null 2>&1 && asound_pkg="libasound2t64"
            pkg_install libnspr4 libnss3 "$gtk_pkg" "$asound_pkg" libxss1 libgbm1 libdrm2 libxkbcommon0 libatspi2.0-0
            ;;
        dnf) pkg_install nspr nss gtk3 alsa-lib libXScrnSaver mesa-libgbm libdrm libxkbcommon at-spi2-core ;;
        pacman) pkg_install nspr nss gtk3 alsa-lib libxss mesa libdrm libxkbcommon at-spi2-core ;;
        zypper) pkg_install mozilla-nspr mozilla-nss libgtk-3-0 libasound2 libXss1 libgbm1 libdrm2 libxkbcommon0 at-spi2-core ;;
        *) return 1 ;;
    esac
}

missing_runtime_libraries() {
    local executable="$1"
    if ! command -v ldd >/dev/null 2>&1; then return 0; fi
    ldd "$executable" 2>/dev/null | awk '/not found/{print $1}' | sort -u
}

# ------------------------------------------------------------------
# 1. Node.js / npm
# ------------------------------------------------------------------
step "Comprobando Node.js y npm"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    warn "No se encontro Node.js/npm en el PATH."
    if [ -n "$PKG_MANAGER" ] && confirm "Instalar Node.js ahora con $PKG_MANAGER?"; then
        step "Instalando Node.js ($PKG_MANAGER)"
        case "$PKG_MANAGER" in
            apt) pkg_install nodejs npm ;;
            dnf) pkg_install nodejs ;;
            pacman) pkg_install nodejs npm ;;
            zypper) pkg_install nodejs npm ;;
        esac
        if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
            err "Node.js se intento instalar pero sigue sin detectarse. Instalalo manualmente (considera nvm/NodeSource si tu distro trae una version muy antigua)."
            exit 1
        fi
        ok "Node.js instalado correctamente"
    else
        err "Node.js/npm son necesarios para continuar."
        echo "    Instalalo manualmente, o vuelve a ejecutar este script con --yes."
        exit 1
    fi
fi
MIN_NODE_VERSION="22.12.0"
node_version_supported() {
    node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && (b>12 || (b===12 && c>=0))) ? 0 : 1)' >/dev/null 2>&1
}

if ! node_version_supported; then
    warn "Node.js $(node -v) es demasiado antiguo; Electron 43 requiere Node.js >= $MIN_NODE_VERSION para compilar."
    if [ -n "$PKG_MANAGER" ] && confirm "Intentar actualizar Node.js con $PKG_MANAGER?"; then
        case "$PKG_MANAGER" in
            apt) pkg_install nodejs npm ;;
            dnf) pkg_install nodejs ;;
            pacman) pkg_install nodejs npm ;;
            zypper) pkg_install nodejs npm ;;
        esac
    fi
fi

if ! node_version_supported; then
    err "Se necesita Node.js >= $MIN_NODE_VERSION y se detectó $(node -v)."
    echo "    Actualiza Node.js con el método oficial de tu distribución y vuelve a ejecutar build.sh."
    exit 1
fi
ok "Node.js $(node -v) / npm $(npm -v)"

# ------------------------------------------------------------------
# 2. Instalar dependencias y generar el AppImage
# node-pty incluye prebuilds Linux; las herramientas C++ solo se ofrecen si
# npm comunica que no puede usar el binario y cae a node-gyp.
# ------------------------------------------------------------------
cd "$ELECTRON_DIR"

if [ "$REINSTALL" -eq 1 ] && [ -d node_modules ]; then
    step "Reinstalacion limpia solicitada: borrando node_modules"
    rm -rf node_modules
fi

step "Instalando dependencias reproducibles (npm ci)"
NPM_LOG="${TMPDIR:-/tmp}/lterminal-npm-install.log"
if ! npm ci 2>&1 | tee "$NPM_LOG"; then
    if grep -Eqi 'node-gyp|gyp ERR|prebuild|Python|make:|g\+\+' "$NPM_LOG"; then
        warn "node-pty no pudo usar su binario precompilado; esta plataforma necesita compilacion nativa."
        if [ -n "$PKG_MANAGER" ] && confirm "Instalar solo ahora Python y las herramientas C/C++ con $PKG_MANAGER?"; then
            case "$PKG_MANAGER" in
                apt) pkg_install build-essential python3 ;;
                dnf) pkg_install gcc gcc-c++ make python3 ;;
                pacman) pkg_install base-devel python ;;
                zypper) pkg_install gcc gcc-c++ make python3 ;;
            esac
            npm ci
        else
            err "Faltan los requisitos de compilacion nativa; instalalos y vuelve a intentarlo."
            exit 1
        fi
    else
        err "npm ci termino con errores no relacionados con compilacion nativa."
        exit 1
    fi
fi
ok "Dependencias instaladas"

# npm puede dejar sin ejecutar los scripts de instalacion de las dependencias
# (las versiones recientes los ponen tras una aprobacion explicita). Cuando eso
# le toca a Electron, node_modules parece completo pero no hay binario, y el
# fallo aparece mucho despues, al empaquetar o al arrancar.
step "Comprobando el binario de Electron y el modulo node-pty"
if [ ! -x "$ELECTRON_DIR/node_modules/electron/dist/electron" ]; then
    warn "npm no dejo instalado el binario de Electron; se descarga ahora."
    if [ ! -f "$ELECTRON_DIR/node_modules/electron/install.js" ]; then
        err "Falta node_modules/electron: repite npm ci."
        exit 1
    fi
    node "$ELECTRON_DIR/node_modules/electron/install.js"
    if [ ! -x "$ELECTRON_DIR/node_modules/electron/dist/electron" ]; then
        err "No se pudo descargar el binario de Electron. Revisa la conexion y repite el build."
        exit 1
    fi
fi
if [ ! -f "$ELECTRON_DIR/node_modules/node-pty/build/Release/pty.node" ]; then
    err "Falta node_modules/node-pty/build/Release/pty.node: node-pty no llego a compilarse."
    echo "    Borra node_modules/node-pty y repite el build." >&2
    exit 1
fi
ok "Electron y node-pty listos"

step "Ejecutando pruebas y comprobacion de sintaxis"
npm run check

step "Generando el AppImage (npm run dist:linux)"
if ! npm run dist:linux; then
    err "electron-builder termino con errores. Revisa los mensajes de arriba."
    exit 1
fi

# ------------------------------------------------------------------
# 4. Localizar el AppImage generado
# ------------------------------------------------------------------
step "Buscando el AppImage generado"

VERSION="$(node -p "require('$ELECTRON_DIR/package.json').version")"

# Se busca POR VERSION, no el primer .AppImage que aparezca. Tras subir de
# version, dist/ conserva el AppImage anterior y el orden que devuelve find no
# esta definido: se llego a empaquetar y firmar el binario viejo.
APPIMAGE_MATCHES="$(find "$ELECTRON_DIR/dist" -maxdepth 1 -name "LTerminal-$VERSION-*.AppImage" | sort)"
APPIMAGE_COUNT="$(printf '%s' "$APPIMAGE_MATCHES" | grep -c . || true)"

if [ "$APPIMAGE_COUNT" -eq 0 ]; then
    err "No se encontro LTerminal-$VERSION-*.AppImage en: $ELECTRON_DIR/dist"
    echo "    Revisa los mensajes de 'electron-builder' mas arriba."
    exit 1
fi
if [ "$APPIMAGE_COUNT" -gt 1 ]; then
    err "Hay varios AppImage de la version $VERSION; no se puede decidir cual publicar:"
    printf '    %s\n' $APPIMAGE_MATCHES >&2
    exit 1
fi
APPIMAGE_PATH="$APPIMAGE_MATCHES"
chmod +x "$APPIMAGE_PATH"
ok "AppImage: $APPIMAGE_PATH"

# Peso del AppImage. Tope generoso pero real: la mayor parte es el runtime de
# Electron, que no se puede adelgazar. Lo que este check detecta es una
# REGRESION: una exclusion que se cae de package.json y devuelve al paquete los
# prebuilds duplicados, los .pdb o node_modules entero.
MAX_APPIMAGE_MB=260
step "Midiendo el peso del AppImage"
APPIMAGE_MB="$(( $(stat -c%s "$APPIMAGE_PATH") / 1048576 ))"
echo "    $(basename "$APPIMAGE_PATH"): ${APPIMAGE_MB} MB (tope ${MAX_APPIMAGE_MB} MB)"
if [ "$APPIMAGE_MB" -gt "$MAX_APPIMAGE_MB" ]; then
    err "El AppImage pesa ${APPIMAGE_MB} MB y el tope es ${MAX_APPIMAGE_MB} MB. Revisa build.files en package.json."
    exit 1
fi
ok "Peso dentro del tope"

# Un formato por sistema: si alguien reintroduce deb/rpm/snap en la
# configuracion, aparece aqui y el build falla en vez de publicarlo callando.
STRAY_PACKAGES="$(find "$ELECTRON_DIR/dist" -maxdepth 1 \( -name '*.deb' -o -name '*.rpm' -o -name '*.snap' -o -name '*.pacman' \) | sort)"
if [ -n "$STRAY_PACKAGES" ]; then
    err "La build de Linux solo debe producir el AppImage. Artefactos inesperados:"
    printf '    %s\n' $STRAY_PACKAGES >&2
    echo "    Revisa build.linux.target en package.json y electron-builder.linux.js." >&2
    exit 1
fi

# linux-unpacked NO se publica: es el directorio intermedio que
# electron-builder deja al construir el AppImage, y aqui solo se usa para
# arrancar la app y comprobar que funciona. Lo que se distribuye es el
# AppImage.
UNPACKED_DIR="$ELECTRON_DIR/dist/linux-unpacked"
if [ ! -d "$UNPACKED_DIR" ]; then
    err "No se encontro el directorio intermedio de electron-builder en: $UNPACKED_DIR"
    exit 1
fi

# Smoke test solo si existe un servidor gráfico o xvfb. No se instala ningún
# entorno auxiliar únicamente para probar: en servidores headless se omite.
UNPACKED_EXE="$UNPACKED_DIR/lterminal"
if [ -x "$UNPACKED_EXE" ]; then
    MISSING_RUNTIME_LIBS="$(missing_runtime_libraries "$UNPACKED_EXE")"
    if [ -n "$MISSING_RUNTIME_LIBS" ]; then
        warn "La build está completa, pero este Linux mínimo no puede ejecutarla todavía. Faltan: $(echo "$MISSING_RUNTIME_LIBS" | tr '\n' ' ')"
        if [ "$NO_RUN" -eq 0 ] && [ -n "$PKG_MANAGER" ] && confirm "Instalar solo las bibliotecas gráficas que Electron necesita para ejecutar LTerminal aquí?"; then
            install_electron_runtime
            MISSING_RUNTIME_LIBS="$(missing_runtime_libraries "$UNPACKED_EXE")"
        fi
    fi

    if [ -n "$MISSING_RUNTIME_LIBS" ]; then
        warn "Se omite el smoke test local. El AppImage no necesita FUSE 2, pero Electron sí requiere las bibliotecas base de un escritorio Linux."
    elif command -v xvfb-run >/dev/null 2>&1 && command -v xauth >/dev/null 2>&1; then
        step "Validando la app empaquetada con xvfb"
        xvfb-run -a "$UNPACKED_EXE" --smoke-test
        ok "Electron, renderer y PTY arrancan correctamente"
    elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        step "Validando la app empaquetada"
        "$UNPACKED_EXE" --smoke-test
        ok "Electron, renderer y PTY arrancan correctamente"
    else
        warn "Sin DISPLAY/WAYLAND o sin el par xvfb-run+xauth: se omite el smoke test gráfico."
    fi
fi

# ------------------------------------------------------------------
# 5. Releases versionadas (.tar.gz)
# ------------------------------------------------------------------
step "Creando releases TAR.GZ"
RELEASE_DIR="$ELECTRON_DIR/dist/release"
mkdir -p "$RELEASE_DIR"

if command -v tar >/dev/null 2>&1; then
    APPIMAGE_RELEASE="$RELEASE_DIR/LTerminal-AppImage-$VERSION-$(uname -m).tar.gz"
    # Los .tar.gz de versiones anteriores seguian en release/ y, como el
    # archivo existia, su huella sobrevivia a la fusion de mas abajo:
    # SHA256SUMS.txt acababa describiendo varias versiones a la vez.
    for stale in "$RELEASE_DIR"/LTerminal-AppImage-*.tar.gz; do
        [ -f "$stale" ] || continue
        [ "$stale" = "$APPIMAGE_RELEASE" ] && continue
        rm -f "$stale"
        warn "Release anterior retirada: $(basename "$stale")"
    done
    tar -czf "$APPIMAGE_RELEASE" -C "$ELECTRON_DIR/dist" "$(basename "$APPIMAGE_PATH")"
    ok "Release AppImage: $APPIMAGE_RELEASE"
    if command -v sha256sum >/dev/null 2>&1; then
        # Linux y Windows publican en la MISMA carpeta release. Truncar el
        # archivo borraba las huellas de la otra plataforma: se conservan las
        # lineas ajenas cuyo archivo sigue existiendo y solo se regeneran las
        # propias.
        (
            cd "$RELEASE_DIR"
            own_appimage="$(basename "$APPIMAGE_RELEASE")"
            merged="$(mktemp)"
            if [ -f SHA256SUMS.txt ]; then
                while IFS= read -r line; do
                    [ -n "$line" ] || continue
                    # "<hash> *nombre" (binario) o "<hash>  nombre" (texto).
                    name="${line#* }"
                    name="${name# }"
                    name="${name#\*}"
                    case "$name" in
                        "$own_appimage") continue ;;
                    esac
                    if [ -f "$name" ]; then printf '%s\n' "$line"; fi
                done < SHA256SUMS.txt > "$merged"
            fi
            sha256sum "$own_appimage" >> "$merged"
            sort -k2 "$merged" > SHA256SUMS.txt
            rm -f "$merged"
        )
        ok "Huellas SHA-256: $RELEASE_DIR/SHA256SUMS.txt"

        # Publicar una huella sin comprobarla es publicar una promesa. Se
        # verifica exactamente igual que hara quien descargue la release.
        step "Verificando SHA256SUMS.txt contra los archivos publicados"
        if ! (cd "$RELEASE_DIR" && sha256sum -c --strict SHA256SUMS.txt); then
            err "Las huellas no coinciden con los archivos publicados."
            exit 1
        fi
        ok "Huellas verificadas"
    else
        warn "No se encontró sha256sum; los TAR.GZ se crearon sin fichero de huellas."
    fi
else
    warn "No se encontro tar; la app se genero, pero no se pudieron crear los archivos .tar.gz."
fi

# ------------------------------------------------------------------
# 6. Acceso directo al AppImage
# ------------------------------------------------------------------
create_desktop_entry() {
    local target="$1"
    local file="$2"
    {
        echo '[Desktop Entry]'
        echo 'Type=Application'
        echo 'Name=LTerminal'
        echo 'GenericName=Terminal Emulator'
        echo 'Comment=Terminal multipestaña y centro local de herramientas'
        printf 'Exec="%s"\n' "$target"
        printf 'TryExec=%s\n' "$target"
        echo "Icon=$ELECTRON_DIR/build/icon.png"
        echo 'Terminal=false'
        echo 'Categories=Utility;TerminalEmulator;Development;'
        echo 'StartupWMClass=lterminal'
    } > "$file"
    chmod +x "$file"
}

step "Creando acceso directo"
create_desktop_entry "$APPIMAGE_PATH" "$PROJECT_ROOT/LTerminal.desktop"

DESKTOP_DIR=""
if command -v xdg-user-dir >/dev/null 2>&1; then
    DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
elif [ -d "$HOME/Desktop" ]; then
    DESKTOP_DIR="$HOME/Desktop"
fi
if [ -n "$DESKTOP_DIR" ] && [ -d "$DESKTOP_DIR" ]; then
    create_desktop_entry "$APPIMAGE_PATH" "$DESKTOP_DIR/LTerminal.desktop"
fi
ok "Acceso directo creado"

# ------------------------------------------------------------------
# 7. Ejecutar la app
# ------------------------------------------------------------------
if [ "$NO_RUN" -eq 0 ]; then
    if [ -n "${MISSING_RUNTIME_LIBS:-}" ]; then
        warn "LTerminal no se inicia en este host porque aún faltan bibliotecas de escritorio; la distribución sí se generó correctamente."
    else
        step "Lanzando LTerminal"
        "$APPIMAGE_PATH" >/dev/null 2>&1 &
        disown
    fi
fi

echo
echo -e "\033[32mListo. LTerminal AppImage generado en: $APPIMAGE_PATH\033[0m"
