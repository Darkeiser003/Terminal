#!/usr/bin/env bash
# Información rápida de interfaces, VPN y rutas.

set -Eeuo pipefail

ACTION="${1:-menu}"

show_interfaces() {
    printf 'Interfaces y direcciones:\n'
    if command -v ip >/dev/null 2>&1; then ip -brief address; else hostname -I 2>/dev/null || true; fi
    printf '\nRutas:\n'
    command -v ip >/dev/null 2>&1 && ip route 2>/dev/null || true
}

show_vpn() {
    printf 'VPN y túneles detectados:\n'
    if command -v tailscale >/dev/null 2>&1; then
        printf '\n[Tailscale]\n'
        tailscale status 2>/dev/null || true
        tailscale ip 2>/dev/null || true
    fi
    if command -v wg >/dev/null 2>&1; then
        printf '\n[WireGuard]\n'
        wg show 2>/dev/null || true
    fi
    if command -v nmcli >/dev/null 2>&1; then
        printf '\n[NetworkManager]\n'
        nmcli --fields NAME,TYPE,DEVICE connection show --active 2>/dev/null || true
    fi
    if command -v openvpn3 >/dev/null 2>&1; then
        printf '\n[OpenVPN 3]\n'
        openvpn3 sessions-list 2>/dev/null || true
    fi
}

menu() {
    local choice
    while :; do
        printf '\nRed y VPN\n'
        printf '  1) Interfaces y rutas\n  2) Estado de VPN y túneles\n  0) Salir\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) show_interfaces ;;
            2) show_vpn ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

case "$ACTION" in
    menu) menu ;;
    interfaces|ip|routes) show_interfaces ;;
    vpn|tunnels) show_vpn ;;
    --help|-h) printf 'Uso: network-manager.sh [menu|interfaces|vpn]\n' ;;
    *) printf 'Acción desconocida: %s\n' "$ACTION" >&2; exit 1 ;;
esac
