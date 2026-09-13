#!/usr/bin/env bash
# Operaciones frecuentes de Android Debug Bridge.

set -Eeuo pipefail

ACTION="${1:-menu}"
shift || true

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
command -v adb >/dev/null 2>&1 || die "ADB no está instalado o no está en PATH. Instálalo desde Entorno y dependencias."

devices() { adb devices -l; }

restart_server() {
    adb kill-server || true
    adb start-server
    adb devices -l
}

shell_device() {
    local serial="${1:-}"
    [[ -n "$serial" ]] || read -r -p 'Serie del dispositivo (vacío para el primero): ' serial
    if [[ -n "$serial" ]]; then adb -s "$serial" shell; else adb shell; fi
}

menu() {
    local choice
    while :; do
        printf '\nAndroid Debug Bridge\n'
        printf '  1) Ver dispositivos\n  2) Reiniciar servidor ADB\n  3) Abrir shell del dispositivo\n  0) Salir\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) devices ;;
            2) restart_server ;;
            3) shell_device ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

case "$ACTION" in
    menu) menu ;;
    devices|status) devices ;;
    restart) restart_server ;;
    shell) shell_device "${1:-}" ;;
    --help|-h) printf 'Uso: adb-manager.sh [menu|devices|restart|shell [SERIE]]\n' ;;
    *) die "Acción desconocida: $ACTION" ;;
esac
