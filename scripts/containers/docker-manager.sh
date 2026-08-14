#!/usr/bin/env bash
# Gestor global de Docker con soporte opcional para proyectos Compose.

set -Eeuo pipefail

PROGRAM="${0##*/}"
DRY_RUN=false
ASSUME_YES=false
PROJECT_DIR=""
COMPOSE_FILE=""
TAIL=100
FOLLOW=false

usage() {
    cat <<EOF
Uso: $PROGRAM [opciones] [acción] [argumentos...]

Motor Docker (no necesita docker-compose.yml):
  menu                         Menú interactivo (predeterminado)
  status                       Resumen del motor
  containers                   Listar todos los contenedores
  start CONTENEDOR...          Iniciar contenedores existentes
  stop CONTENEDOR...           Detener contenedores
  restart CONTENEDOR...        Reiniciar contenedores
  logs CONTENEDOR              Mostrar logs
  exec CONTENEDOR COMANDO...   Ejecutar un comando en un contenedor
  stats [CONTENEDOR...]        Estadísticas de recursos
  images                       Listar imágenes
  networks                     Listar redes
  volumes                      Listar volúmenes
  inspect OBJETO               Inspeccionar un objeto Docker
  doctor                       Comprobar motor y soporte Compose
  prune TIPO                   Limpiar: containers, images, networks,
                               volumes o system

Docker Compose (opcional):
  compose status               Estado del proyecto
  compose up [SERVICIOS...]    Iniciar servicios
  compose down                 Detener el proyecto
  compose restart [SERVICIOS]  Reiniciar servicios
  compose logs [SERVICIOS...]  Mostrar logs
  compose pull [SERVICIOS...]  Descargar imágenes
  compose build [SERVICIOS...] Construir imágenes
  compose config               Validar la configuración
  compose exec SERVICIO CMD... Ejecutar un comando

Opciones:
  -p, --project DIR       Raíz del proyecto Compose
  -f, --file ARCHIVO      Archivo Compose concreto
      --build             Construir al ejecutar «compose up»
      --pull              Descargar al ejecutar «compose up»
      --follow            Seguir logs o estadísticas
      --tail N            Últimas N líneas de log (predeterminado: 100)
      --volumes           Incluir volúmenes con «compose down»
  -n, --dry-run           Mostrar el comando sin ejecutarlo
  -y, --yes               Omitir confirmaciones destructivas
  -h, --help              Mostrar esta ayuda

Ejemplos:
  $PROGRAM containers
  $PROGRAM logs --follow mi-contenedor
  $PROGRAM restart api redis
  $PROGRAM prune images
  $PROGRAM compose up --build api
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

run() {
    if $DRY_RUN; then printf '[simulación] '; else printf '+ '; fi
    printf '%q ' "$@"
    printf '\n'
    $DRY_RUN || "$@"
}

menu_run() {
    if ! run "$@"; then
        printf 'La operación falló; el menú continúa disponible.\n' >&2
    fi
}

confirm() {
    $ASSUME_YES && return 0
    [[ -t 0 ]] || die "la operación requiere confirmación; use --yes"
    local answer
    read -r -p "$1 [s/N] " answer
    [[ "$answer" =~ ^[sSyY]$ ]]
}

require_args() {
    local minimum="$1" message="$2"
    shift 2
    (($# >= minimum)) || die "$message"
}

require_exact_args() {
    local expected="$1" message="$2"
    shift 2
    (($# == expected)) || die "$message"
}

container_names() {
    docker ps -a --format '{{.Names}}'
}

choose_containers() {
    local names choice index
    mapfile -t names < <(container_names)
    ((${#names[@]})) || { printf 'No hay contenedores.\n' >&2; return 1; }
    printf 'Contenedores:\n'
    for index in "${!names[@]}"; do printf '  %d) %s\n' "$((index + 1))" "${names[$index]}"; done
    read -r -p 'Selección (números separados por espacios, 0 para cancelar): ' choice
    SELECTED=()
    [[ -z "$choice" || "$choice" == "0" ]] && return 1
    for index in $choice; do
        [[ "$index" =~ ^[0-9]+$ ]] || { printf 'Selección no válida: %s\n' "$index" >&2; return 1; }
        ((index >= 1 && index <= ${#names[@]})) || { printf 'Selección fuera de rango: %s\n' "$index" >&2; return 1; }
        SELECTED+=("${names[$((index - 1))]}")
    done
}

engine_status() {
    local context server running stopped images volumes
    context="$(docker context show 2>/dev/null || printf 'desconocido')"
    server="$(docker version --format '{{.Server.Version}}' 2>/dev/null || printf 'desconocida')"
    running="$(docker ps -q | wc -l)"
    stopped="$(docker ps -aq --filter status=exited | wc -l)"
    images="$(docker images -q | sort -u | wc -l)"
    volumes="$(docker volume ls -q | wc -l)"
    printf 'Docker Engine\n'
    printf '  Contexto     : %s\n' "$context"
    printf '  Versión      : %s\n' "$server"
    printf '  En ejecución : %s\n' "$running"
    printf '  Detenidos    : %s\n' "$stopped"
    printf '  Imágenes     : %s\n' "$images"
    printf '  Volúmenes    : %s\n' "$volumes"
    printf '\n'
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
}

find_compose_file() {
    local dir="$1" candidate
    while :; do
        for candidate in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
            [[ -f "$dir/$candidate" ]] && { printf '%s\n' "$dir/$candidate"; return 0; }
        done
        [[ "$dir" == "/" ]] && return 1
        dir="$(dirname "$dir")"
    done
}

prepare_compose() {
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_BASE=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_BASE=(docker-compose)
    else
        printf 'Error: no se encontró Docker Compose v2 ni docker-compose v1.\n' >&2
        return 1
    fi
    if [[ -n "$COMPOSE_FILE" ]]; then
        [[ -f "$COMPOSE_FILE" ]] || { printf 'Error: no existe el archivo Compose: %s\n' "$COMPOSE_FILE" >&2; return 1; }
        COMPOSE_FILE="$(realpath "$COMPOSE_FILE")"
    else
        local start="${PROJECT_DIR:-$PWD}"
        [[ -d "$start" ]] || { printf 'Error: no existe el directorio de proyecto: %s\n' "$start" >&2; return 1; }
        COMPOSE_FILE="$(find_compose_file "$(realpath "$start")")" || \
            { printf 'Error: no se encontró un archivo Compose desde %s; use --project o --file.\n' "$start" >&2; return 1; }
    fi
    PROJECT_DIR="$(dirname "$COMPOSE_FILE")"
    COMPOSE=("${COMPOSE_BASE[@]}" --project-directory "$PROJECT_DIR" -f "$COMPOSE_FILE")
    info "Proyecto Compose: $PROJECT_DIR"
}

compose_action() {
    local action="${1:-status}"
    (($#)) && shift
    prepare_compose || return 1
    case "$action" in
        status|ps) run "${COMPOSE[@]}" ps ;;
        up)
            $PULL && run "${COMPOSE[@]}" pull "$@"
            local command=("${COMPOSE[@]}" up -d)
            $BUILD && command+=(--build)
            run "${command[@]}" "$@"
            ;;
        down)
            local command=("${COMPOSE[@]}" down)
            if $VOLUMES; then
                confirm '¿Detener el proyecto y eliminar sus volúmenes?' || return 0
                command+=(--volumes)
            fi
            run "${command[@]}"
            ;;
        restart) run "${COMPOSE[@]}" restart "$@" ;;
        logs)
            local command=("${COMPOSE[@]}" logs --tail "$TAIL")
            $FOLLOW && command+=(--follow)
            run "${command[@]}" "$@"
            ;;
        pull) run "${COMPOSE[@]}" pull "$@" ;;
        build) run "${COMPOSE[@]}" build "$@" ;;
        config) run "${COMPOSE[@]}" config ;;
        exec)
            require_args 2 "compose exec requiere SERVICIO y COMANDO" "$@"
            run "${COMPOSE[@]}" exec "$@"
            ;;
        *) die "acción Compose desconocida: $action" ;;
    esac
}

interactive_menu() {
    local choice target
    while :; do
        printf '\nDOCKER MANAGER\n'
        printf '  1) Resumen       2) Contenedores  3) Iniciar\n'
        printf '  4) Detener       5) Reiniciar     6) Logs\n'
        printf '  7) Estadísticas  8) Imágenes      9) Redes\n'
        printf ' 10) Volúmenes    11) Docker Compose 0) Salir\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) engine_status ;;
            2) menu_run docker ps -a ;;
            3) choose_containers && menu_run docker start "${SELECTED[@]}" ;;
            4) choose_containers && menu_run docker stop "${SELECTED[@]}" ;;
            5) choose_containers && menu_run docker restart "${SELECTED[@]}" ;;
            6) read -r -p 'Contenedor: ' target; [[ -n "$target" ]] && menu_run docker logs --tail "$TAIL" "$target" ;;
            7) menu_run docker stats --no-stream ;;
            8) menu_run docker images ;;
            9) menu_run docker network ls ;;
            10) menu_run docker volume ls ;;
            11) compose_menu ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

compose_menu() {
    prepare_compose || { printf 'Compose no está disponible para la ruta actual.\n' >&2; return 0; }
    local choice
    while :; do
        printf '\nDOCKER COMPOSE · %s\n' "$PROJECT_DIR"
        printf '  1) Estado  2) Iniciar  3) Detener  4) Reiniciar\n'
        printf '  5) Logs    6) Pull     7) Build    8) Config\n'
        printf '  0) Volver\n'
        read -r -p 'Opción: ' choice
        case "$choice" in
            1) menu_run "${COMPOSE[@]}" ps ;;
            2) menu_run "${COMPOSE[@]}" up -d ;;
            3) menu_run "${COMPOSE[@]}" down ;;
            4) menu_run "${COMPOSE[@]}" restart ;;
            5) menu_run "${COMPOSE[@]}" logs --tail "$TAIL" ;;
            6) menu_run "${COMPOSE[@]}" pull ;;
            7) menu_run "${COMPOSE[@]}" build ;;
            8) menu_run "${COMPOSE[@]}" config ;;
            0) return ;;
            *) printf 'Opción no válida.\n' >&2 ;;
        esac
    done
}

ACTION="menu"
ACTION_SET=false
BUILD=false
PULL=false
VOLUMES=false
ARGS=()

while (($#)); do
    case "$1" in
        -p|--project) (($# >= 2)) || die "$1 requiere un directorio"; PROJECT_DIR="$2"; shift 2 ;;
        -f|--file) (($# >= 2)) || die "$1 requiere un archivo"; COMPOSE_FILE="$2"; shift 2 ;;
        --build) BUILD=true; shift ;;
        --pull) PULL=true; shift ;;
        --follow) FOLLOW=true; shift ;;
        --tail) (($# >= 2)) || die "--tail requiere un número"; [[ "$2" =~ ^[0-9]+$ ]] || die "tail no válido"; TAIL="$2"; shift 2 ;;
        --volumes) VOLUMES=true; shift ;;
        -n|--dry-run) DRY_RUN=true; shift ;;
        -y|--yes) ASSUME_YES=true; shift ;;
        -h|--help) usage; exit 0 ;;
        menu|status|containers|start|stop|restart|logs|exec|stats|images|networks|volumes|inspect|prune|compose|doctor)
            if $ACTION_SET; then ARGS+=("$1"); else ACTION="$1"; ACTION_SET=true; fi
            shift
            ;;
        --) shift; ARGS+=("$@"); break ;;
        *)
            $ACTION_SET || die "opción o acción desconocida: $1"
            ARGS+=("$1"); shift
            ;;
    esac
done

command -v docker >/dev/null 2>&1 || die "Docker no está instalado o no está en PATH"
docker info >/dev/null 2>&1 || die "Docker está instalado, pero el motor no responde"

if [[ "$ACTION" != "compose" && ( -n "$PROJECT_DIR" || -n "$COMPOSE_FILE" || "$BUILD" == true || "$PULL" == true || "$VOLUMES" == true ) ]]; then
    die "--project, --file, --build, --pull y --volumes solo se usan con la acción compose"
fi

case "$ACTION" in
    menu) interactive_menu ;;
    status) engine_status ;;
    containers) run docker ps -a ;;
    start|stop|restart)
        require_args 1 "$ACTION requiere al menos un contenedor" "${ARGS[@]}"
        run docker "$ACTION" "${ARGS[@]}"
        ;;
    logs)
        require_exact_args 1 "logs requiere exactamente un contenedor" "${ARGS[@]}"
        COMMAND=(docker logs --tail "$TAIL")
        $FOLLOW && COMMAND+=(--follow)
        run "${COMMAND[@]}" "${ARGS[0]}"
        ;;
    exec)
        require_args 2 "exec requiere CONTENEDOR y COMANDO" "${ARGS[@]}"
        run docker exec -it "${ARGS[0]}" "${ARGS[@]:1}"
        ;;
    stats)
        COMMAND=(docker stats)
        $FOLLOW || COMMAND+=(--no-stream)
        run "${COMMAND[@]}" "${ARGS[@]}"
        ;;
    images) run docker images ;;
    networks) run docker network ls ;;
    volumes) run docker volume ls ;;
    inspect)
        require_args 1 "inspect requiere un contenedor, imagen, red o volumen" "${ARGS[@]}"
        run docker inspect "${ARGS[@]}"
        ;;
    prune)
        require_exact_args 1 "prune requiere exactamente uno de: containers, images, networks, volumes o system" "${ARGS[@]}"
        case "${ARGS[0]}" in
            containers) COMMAND=(docker container prune) ;;
            images) COMMAND=(docker image prune) ;;
            networks) COMMAND=(docker network prune) ;;
            volumes) COMMAND=(docker volume prune) ;;
            system) COMMAND=(docker system prune) ;;
            *) die "tipo de limpieza desconocido: ${ARGS[0]}" ;;
        esac
        confirm "¿Ejecutar docker ${ARGS[0]} prune?" || exit 0
        COMMAND+=(--force)
        run "${COMMAND[@]}"
        ;;
    compose) compose_action "${ARGS[@]}" ;;
    doctor)
        printf 'Docker CLI   : %s\n' "$(docker version --format '{{.Client.Version}}')"
        printf 'Docker Engine: %s\n' "$(docker version --format '{{.Server.Version}}')"
        if docker compose version >/dev/null 2>&1; then
            printf 'Compose      : v2 (%s)\n' "$(docker compose version --short 2>/dev/null || docker compose version)"
        elif command -v docker-compose >/dev/null 2>&1; then
            printf 'Compose      : v1 (%s)\n' "$(docker-compose version --short 2>/dev/null || docker-compose version)"
        else
            printf 'Compose      : no instalado (las funciones globales sí están disponibles)\n'
        fi
        ;;
esac
