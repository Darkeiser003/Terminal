#!/usr/bin/env bash
# Abre la GUI Windows dentro del display actual (normalmente un Xvfb privado),
# espera a que WebView2 y el PTY estén listos y valida una captura no vacía.
set -Eeuo pipefail

if (( $# != 4 )); then
    printf 'Uso interno: wine-gui-smoke.sh EJECUTABLE CAPTURA LOG_APP LOG_WINE\n' >&2
    exit 2
fi

executable="$1"
capture_path="$2"
app_log="$3"
wine_log="$4"
app_pid=''

for tool in xdpyinfo xdotool import identify; do
    command -v "$tool" >/dev/null 2>&1 || {
        printf 'Falta la herramienta gráfica requerida: %s\n' "$tool" >&2
        exit 1
    }
done
timeout 10 xdpyinfo >/dev/null 2>&1 || {
    printf 'El smoke GUI no recibió un display X accesible.\n' >&2
    exit 1
}

cleanup_app() {
    local status=$?
    trap - EXIT
    if (( status != 0 )) && [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
        kill "$app_pid" 2>/dev/null || true
        wait "$app_pid" 2>/dev/null || true
    fi
    exit "$status"
}
trap cleanup_app EXIT

wine "${executable}" >"$wine_log" 2>&1 &
app_pid=$!
window_id=''
for _ in {1..400}; do
    window_id="$(xdotool search --onlyvisible --name 'WTerminal' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$window_id" ]] && grep -Fq 'Frontend y terminal preparados' "$app_log"; then
        break
    fi
    if ! kill -0 "$app_pid" 2>/dev/null; then
        printf 'La aplicación Windows se cerró antes de mostrar la terminal.\n' >&2
        cat "$wine_log" >&2 || true
        exit 1
    fi
    sleep 0.1
done
if [[ -z "$window_id" ]]; then
    printf 'No apareció la ventana visible «WTerminal» bajo Wine.\n' >&2
    cat "$wine_log" >&2 || true
    exit 1
fi
geometry="$(xdotool getwindowgeometry --shell "$window_id")"
read -r x y width height < <(awk -F= '
    $1 == "X" { x = $2 }
    $1 == "Y" { y = $2 }
    $1 == "WIDTH" { width = $2 }
    $1 == "HEIGHT" { height = $2 }
    END { print x, y, width, height }
' <<<"$geometry")
if [[ ! "$x" =~ ^[0-9]+$ || ! "$y" =~ ^[0-9]+$ ||
    ! "$width" =~ ^[1-9][0-9]*$ || ! "$height" =~ ^[1-9][0-9]*$ ]]; then
    printf 'La ventana Windows no devolvió una geometría visible válida.\n' >&2
    exit 1
fi

mkdir -p -- "${capture_path%/*}"
entropy=''
for _ in {1..30}; do
    xdotool windowraise "$window_id" 2>/dev/null || true
    import -window root "$capture_path"
    entropy="$(LC_ALL=C identify -crop "${width}x${height}+${x}+${y}" -format '%[entropy]' \
        "$capture_path" 2>/dev/null || true)"
    if awk -v value="$entropy" 'BEGIN { exit !(value >= 0.10) }'; then
        break
    fi
    sleep 0.1
done
if ! awk -v value="$entropy" 'BEGIN { exit !(value >= 0.10) }'; then
    printf 'La ventana de Windows quedó vacía/negra (entropía %s); captura: %s\n' \
        "${entropy:-no disponible}" "$capture_path" >&2
    exit 1
fi
if ! grep -Fq 'Frontend y terminal preparados' "$app_log"; then
    printf 'WINE_GUI_CAPTURE_DIAGNOSTIC=%s ENTROPY=%s; la ventana se dibujó, pero WebView2/PTY no alcanzó su marcador.\n' \
        "$capture_path" "$entropy" >&2
    cat "$app_log" >&2 || true
    exit 1
fi

wait "$app_pid"
app_pid=''
cat "$wine_log"
printf 'WINE_GUI_CAPTURE_OK=%s ENTROPY=%s WINDOW=%sx%s\n' \
    "$capture_path" "$entropy" "$width" "$height"
