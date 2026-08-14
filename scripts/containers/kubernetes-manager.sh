#!/usr/bin/env bash
# Gestor reutilizable y prudente de Kubernetes para LTerminal.

set -Eeuo pipefail

PROGRAM="${0##*/}"
NAMESPACE="default"
CONTEXT=""
KUBECONFIG_FILE=""
DRY_RUN=false
ASSUME_YES=false
FOLLOW=false
TAIL=100

usage() {
    cat <<EOF
Uso: $PROGRAM [opciones] [acción] [argumentos...]

Acciones:
  menu                         Menú interactivo (predeterminado)
  status [TIPO]                Estado de pods o del TIPO indicado
  apply ARCHIVO|DIRECTORIO     Aplicar manifiestos
  delete ARCHIVO|RECURSO       Eliminar un manifiesto o recurso
  logs POD [CONTENEDOR]        Mostrar logs
  restart DEPLOYMENT           Reiniciar un deployment
  scale DEPLOYMENT RÉPLICAS    Escalar un deployment
  exec POD COMANDO...          Ejecutar un comando en un pod
  contexts                     Listar contextos
  namespaces                   Listar namespaces

Opciones:
  -n, --namespace NOMBRE       Namespace (predeterminado: default)
      --context NOMBRE         Contexto de kubectl
      --kubeconfig ARCHIVO     Kubeconfig alternativo
      --follow                 Seguir logs
      --tail N                 Últimas N líneas de log
      --dry-run                Simulación del cliente cuando sea posible
  -y, --yes                    Omitir confirmaciones destructivas
  -h, --help                   Mostrar esta ayuda
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
run() { printf '+ '; printf '%q ' "$@"; printf '\n'; "$@"; }
confirm() {
    $ASSUME_YES && return 0
    [[ -t 0 ]] || die "la operación requiere confirmación; use --yes"
    local answer
    read -r -p "$1 [s/N] " answer
    [[ "$answer" =~ ^[sSyY]$ ]]
}

ACTION="menu"
ACTION_SET=false
ARGS=()
while (($#)); do
    case "$1" in
        -n|--namespace) (($# >= 2)) || die "$1 requiere un nombre"; NAMESPACE="$2"; shift 2 ;;
        --context) (($# >= 2)) || die "--context requiere un nombre"; CONTEXT="$2"; shift 2 ;;
        --kubeconfig) (($# >= 2)) || die "--kubeconfig requiere un archivo"; KUBECONFIG_FILE="$2"; shift 2 ;;
        --follow) FOLLOW=true; shift ;;
        --tail) (($# >= 2)) || die "--tail requiere un número"; [[ "$2" =~ ^[0-9]+$ ]] || die "tail no válido"; TAIL="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        -y|--yes) ASSUME_YES=true; shift ;;
        -h|--help) usage; exit 0 ;;
        menu|status|apply|delete|logs|restart|scale|exec|contexts|namespaces)
            if $ACTION_SET; then ARGS+=("$1"); else ACTION="$1"; ACTION_SET=true; fi
            shift
            ;;
        --) shift; ARGS+=("$@"); break ;;
        *)
            [[ "$ACTION" != "menu" ]] || die "opción o acción desconocida: $1"
            ARGS+=("$1"); shift
            ;;
    esac
done

command -v kubectl >/dev/null 2>&1 || die "kubectl no está instalado o no está en PATH"
K=(kubectl)
[[ -n "$KUBECONFIG_FILE" ]] && K+=(--kubeconfig "$KUBECONFIG_FILE")
[[ -n "$CONTEXT" ]] && K+=(--context "$CONTEXT")
KN=("${K[@]}" --namespace "$NAMESPACE")

interactive_menu() {
    local choice target replicas
    while :; do
        printf '\nKubernetes · contexto: %s · namespace: %s\n' "$("${K[@]}" config current-context 2>/dev/null || printf '?')" "$NAMESPACE"
        printf '  1) Pods  2) Recursos  3) Logs  4) Reiniciar deployment\n'
        printf '  5) Escalar deployment  6) Contextos  7) Namespaces  0) Salir\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) run "${KN[@]}" get pods -o wide ;;
            2) run "${KN[@]}" get all ;;
            3) read -r -p 'Pod: ' target; run "${KN[@]}" logs --tail "$TAIL" "$target" ;;
            4) read -r -p 'Deployment: ' target; run "${KN[@]}" rollout restart "deployment/$target" ;;
            5) read -r -p 'Deployment: ' target; read -r -p 'Réplicas: ' replicas; [[ "$replicas" =~ ^[0-9]+$ ]] || { printf 'Número no válido.\n'; continue; }; run "${KN[@]}" scale "deployment/$target" --replicas "$replicas" ;;
            6) run "${K[@]}" config get-contexts ;;
            7) run "${K[@]}" get namespaces ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

case "$ACTION" in
    menu) interactive_menu ;;
    status) run "${KN[@]}" get "${ARGS[0]:-pods}" -o wide ;;
    apply)
        ((${#ARGS[@]} == 1)) || die "apply requiere un archivo o directorio"
        CMD=("${KN[@]}" apply -f "${ARGS[0]}")
        $DRY_RUN && CMD+=(--dry-run=client)
        run "${CMD[@]}"
        ;;
    delete)
        ((${#ARGS[@]} >= 1)) || die "delete requiere un archivo o recurso"
        confirm "¿Eliminar ${ARGS[*]} del namespace $NAMESPACE?" || exit 0
        if [[ -e "${ARGS[0]}" ]]; then CMD=("${KN[@]}" delete -f "${ARGS[0]}"); else CMD=("${KN[@]}" delete "${ARGS[@]}"); fi
        $DRY_RUN && CMD+=(--dry-run=client)
        run "${CMD[@]}"
        ;;
    logs)
        ((${#ARGS[@]} >= 1)) || die "logs requiere un pod"
        CMD=("${KN[@]}" logs --tail "$TAIL")
        $FOLLOW && CMD+=(--follow)
        CMD+=("${ARGS[0]}")
        ((${#ARGS[@]} >= 2)) && CMD+=(-c "${ARGS[1]}")
        run "${CMD[@]}"
        ;;
    restart)
        ((${#ARGS[@]} == 1)) || die "restart requiere un deployment"
        CMD=("${KN[@]}" rollout restart "deployment/${ARGS[0]}")
        $DRY_RUN && CMD+=(--dry-run=client)
        run "${CMD[@]}"
        ;;
    scale)
        ((${#ARGS[@]} == 2)) || die "scale requiere DEPLOYMENT y RÉPLICAS"
        [[ "${ARGS[1]}" =~ ^[0-9]+$ ]] || die "réplicas debe ser un entero no negativo"
        CMD=("${KN[@]}" scale "deployment/${ARGS[0]}" --replicas "${ARGS[1]}")
        $DRY_RUN && CMD+=(--dry-run=client)
        run "${CMD[@]}"
        ;;
    exec)
        ((${#ARGS[@]} >= 2)) || die "exec requiere POD y COMANDO"
        run "${KN[@]}" exec -it "${ARGS[0]}" -- "${ARGS[@]:1}"
        ;;
    contexts) run "${K[@]}" config get-contexts ;;
    namespaces) run "${K[@]}" get namespaces ;;
esac
