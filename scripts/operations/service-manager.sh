#!/usr/bin/env bash
# Consulta y gestión prudente de servicios systemd.

set -Eeuo pipefail

ACTION="${1:-menu}"
shift || true

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
require_systemd() {
    command -v systemctl >/dev/null 2>&1 || die "systemctl no está disponible en este sistema."
}

status() {
    require_systemd
    systemctl list-units --type=service --state=running,failed --no-pager
    printf '\nServicios fallidos:\n'
    systemctl --failed --no-pager || true
}

pick_service() {
    local service="${1:-}"
    if [[ -z "$service" ]]; then
        read -r -p 'Nombre del servicio (ej. docker.service): ' service
    fi
    [[ -n "$service" ]] || die "No se indicó ningún servicio."
    printf '%s\n' "$service"
}

restart() {
    require_systemd
    local service
    service="$(pick_service "${1:-}")"
    sudo systemctl restart "$service"
    systemctl --no-pager --full status "$service" || true
}

logs() {
    require_systemd
    local service
    service="$(pick_service "${1:-}")"
    journalctl --unit "$service" --no-pager --lines 100
}

menu() {
    local choice
    while :; do
        printf '\nServicios del sistema\n'
        printf '  1) Estado de servicios activos y fallidos\n  2) Reiniciar un servicio\n  3) Ver últimos logs de un servicio\n  0) Salir\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) status ;;
            2) restart ;;
            3) logs ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

case "$ACTION" in
    menu) menu ;;
    status) status ;;
    restart) restart "${1:-}" ;;
    logs) logs "${1:-}" ;;
    --help|-h) printf 'Uso: service-manager.sh [menu|status|restart [SERVICIO]|logs [SERVICIO]]\n' ;;
    *) die "Acción desconocida: $ACTION" ;;
esac
