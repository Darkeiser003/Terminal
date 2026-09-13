#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="${1:-$(find "$ROOT/release" -maxdepth 1 -name 'LTerminal-*.AppImage' -print -quit)}"
LOG="$HOME/.config/lterminal/logs/main.log"
TOKEN="release-$$-$(date +%s)"
OUTPUT="$(mktemp)"
PID=""

cleanup() {
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
    rm -f "$OUTPUT"
}
trap cleanup EXIT INT TERM

[ -x "$APPIMAGE" ] || { echo "ERROR: AppImage no ejecutable: $APPIMAGE" >&2; exit 1; }
"$APPIMAGE" --appimage-version >/dev/null

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "ERROR: hace falta una sesión gráfica o xvfb-run." >&2
    exit 1
fi

LTERMINAL_SMOKE_TOKEN="$TOKEN" APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}" \
    "$APPIMAGE" >"$OUTPUT" 2>&1 &
PID=$!

SMOKE_READY_TIMEOUT="${LTERMINAL_SMOKE_READY_TIMEOUT:-45}"
if ! [[ "$SMOKE_READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
    SMOKE_READY_TIMEOUT=45
fi
for attempt in $(seq 1 "$SMOKE_READY_TIMEOUT"); do
    if grep -Fq "\"smokeToken\":\"$TOKEN\"" "$LOG" 2>/dev/null; then
        echo "OK: runtime, ventana, frontend, IPC, xterm y primera PTY operativos."
        exit 0
    fi
    # Con APPIMAGE_EXTRACT_AND_RUN el lanzador puede terminar después de
    # delegar en el binario nativo. El token del log es la confirmación de que
    # la aplicación ya alcanzó frontend, IPC y PTY; el PID del wrapper no lo es.
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "ERROR: LTerminal terminó antes de confirmar el arranque." >&2
        sed 's/^/  /' "$OUTPUT" >&2
        exit 1
    fi
    sleep 1
done

echo "ERROR: el proceso vive, pero el frontend no confirmó una terminal funcional." >&2
sed 's/^/  /' "$OUTPUT" >&2
tail -n 80 "$LOG" 2>/dev/null >&2 || true
exit 1
