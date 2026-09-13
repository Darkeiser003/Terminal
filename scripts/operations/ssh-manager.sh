#!/usr/bin/env bash
# Acciones rápidas para el cliente OpenSSH.

set -Eeuo pipefail

PROGRAM="${0##*/}"
ACTION="${1:-menu}"
shift || true

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

require_ssh() {
    command -v ssh >/dev/null 2>&1 || die "SSH no está instalado o no está en PATH. Instálalo desde Entorno y dependencias."
}

hosts() {
    local config="${SSH_CONFIG:-$HOME/.ssh/config}"
    [[ -f "$config" ]] || { printf 'No existe todavía %s\n' "$config"; return 0; }
    awk '
        /^[[:space:]]*Host[[:space:]]+/ {
            for (i = 2; i <= NF; i++)
                if ($i !~ /[*?!]/) print $i
        }
    ' "$config" | sort -u
}

choose_host() {
    local host="${1:-}" choice
    if [[ -n "$host" ]]; then
        printf '%s\n' "$host"
        return
    fi
    mapfile -t known < <(hosts)
    if ((${#known[@]})); then
        printf 'Hosts guardados:\n'
        for i in "${!known[@]}"; do printf '  %d) %s\n' "$((i + 1))" "${known[$i]}"; done
        read -r -p 'Host o número (0 para cancelar): ' choice
        [[ "$choice" == "0" ]] && return 1
        if [[ "$choice" =~ ^[0-9]+$ ]] && ((choice >= 1 && choice <= ${#known[@]})); then
            printf '%s\n' "${known[$((choice - 1))]}"
        else
            printf '%s\n' "$choice"
        fi
    else
        read -r -p 'Host, usuario@host o alias SSH: ' host
        [[ -n "$host" ]] && printf '%s\n' "$host"
    fi
}

connect() {
    require_ssh
    local host
    host="$(choose_host "${1:-}")" || return 0
    [[ -n "$host" ]] || die "No se indicó ningún host."
    shift || true
    ssh "$host" "$@"
}

network() {
    printf 'Direcciones de red:\n'
    if command -v ip >/dev/null 2>&1; then ip -brief address; else hostname -I 2>/dev/null || true; fi
    if command -v tailscale >/dev/null 2>&1; then
        printf '\nTailscale:\n'
        tailscale ip 2>/dev/null || tailscale status 2>/dev/null || true
    fi
    if command -v wg >/dev/null 2>&1; then
        printf '\nWireGuard:\n'
        wg show interfaces 2>/dev/null || true
    fi
    if command -v nmcli >/dev/null 2>&1; then
        printf '\nConexiones activas:\n'
        nmcli --fields NAME,TYPE,DEVICE connection show --active 2>/dev/null || true
    fi
}

menu() {
    local choice
    while :; do
        printf '\nSSH y acceso remoto\n'
        printf '  1) Conectar a un host\n  2) Ver hosts guardados\n  3) Ver IPs y VPN\n  0) Salir\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) connect ;;
            2) hosts ;;
            3) network ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

case "$ACTION" in
    menu) menu ;;
    connect) connect "${1:-}" "${@:2}" ;;
    hosts|config) hosts ;;
    network|ip|vpn) network ;;
    --help|-h)
        printf 'Uso: %s [menu|connect [HOST]|hosts|network]\n' "$PROGRAM"
        ;;
    *) die "Acción desconocida: $ACTION" ;;
esac
