#!/usr/bin/env bash
# Vista previa por defecto; usa --apply para borrar las salidas conocidas y
# informes Markdown generados, sin tocar documentación mantenida.
set -euo pipefail

script_dir="${BASH_SOURCE[0]%/*}"
if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then
  script_dir='.'
fi
script_dir="$(cd -- "$script_dir" && pwd -P)"
project_root="$(cd -- "$script_dir/.." && pwd -P)"
release_root="$project_root/release"
temp_root="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
apply=false

case "${1:-}" in
  '') ;;
  --apply) apply=true ;;
  -h|--help)
    printf '%s\n' 'Uso: scripts/clean-repository.sh [--apply]'
    printf '%s\n' 'Sin --apply solo muestra las rutas; con --apply borra salidas, temporales E2E, logs y cachés privadas.'
    printf '%s\n' 'release/ y la configuración de usuario se conservan.'
    exit 0
    ;;
  *)
    printf 'Argumento no válido: %s\n' "$1" >&2
    exit 2
    ;;
esac

generated_directories=(
  node_modules dist artifacts
  .cache .parcel-cache .turbo .svelte-kit .scala-build
  coverage .nyc_output test-results playwright-report allure-results
  AppDir target build tmp temp
  src-tauri/target src-tauri/gen
)

assert_project_target() {
  local path="$1"
  case "$path" in
    "$project_root"/*) ;;
    *) printf 'Ruta fuera del repositorio: %s\n' "$path" >&2; return 1 ;;
  esac
  case "$path" in
    "$release_root"|"$release_root"/*)
      printf 'Ruta protegida (release/): %s\n' "$path" >&2
      return 1
      ;;
  esac
}

assert_external_target() {
  local path="$1"
  case "$path" in
    "$temp_root"/*|"$config_root"/*|"$cache_root"/*) ;;
    *) printf 'Ruta externa no permitida: %s\n' "$path" >&2; return 1 ;;
  esac
  [[ "$path" != "$temp_root" && "$path" != "$config_root" && "$path" != "$cache_root" ]]
}

external_target_has_symlink_parent() {
  local path="$1" root ancestor
  for root in "$temp_root" "$config_root" "$cache_root"; do
    case "$path" in
      "$root"/*)
        ancestor="${path%/*}"
        while [[ "$ancestor" != "$root" && "$ancestor" == "$root"/* ]]; do
          [[ -L "$ancestor" ]] && return 0
          ancestor="${ancestor%/*}"
        done
        return 1
        ;;
    esac
  done
  return 1
}

directory_targets=()
add_project_directory() {
  local candidate="$1" resolved existing
  [[ -d "$candidate" ]] || return 0
  local relative="${candidate#"$project_root/"}" ancestor="$project_root" part
  IFS='/' read -r -a path_parts <<< "$relative"
  for part in "${path_parts[@]}"; do
    ancestor="$ancestor/$part"
    if [[ -L "$ancestor" ]]; then
      printf '  Se conserva la salida bajo un enlace simbólico: %s\n' "$relative"
      return 0
    fi
  done
  # Canonicalizar antes de aceptar la ruta impide que un symlink de salida
  # conocido convierta --apply en un borrado fuera del repositorio.
  resolved="$(cd -- "$candidate" && pwd -P)"
  assert_project_target "$resolved" || exit 1
  for existing in "${directory_targets[@]}"; do
    [[ "$existing" == "$resolved" ]] && return 0
  done
  directory_targets+=("$resolved")
}

for relative in "${generated_directories[@]}"; do
  candidate="$project_root/$relative"
  # `cd … && pwd -P` también funciona en Bash mínimos sin depender de realpath.
  add_project_directory "$candidate"
done

# La build Linux aparta node_modules de Windows mientras restaura dependencias
# nativas. Son restos locales del checkout (no rutas de tmp) y pertenecen a la
# misma categoría de salidas generadas que node_modules.
shopt -s nullglob
for candidate in "$project_root"/.node_modules.windows.*; do
  add_project_directory "$candidate"
done
shopt -u nullglob

is_generated_directory() {
  local path="$1"
  [[ "$path" == "$release_root" ]] && return 0
  local target
  for target in "${directory_targets[@]}"; do
    [[ "$path" == "$target" ]] && return 0
  done
  return 1
}

markdown_targets=()
shopt -s globstar nullglob
for markdown in "$project_root"/**/*.md; do
  [[ -f "$markdown" ]] || continue
  case "${markdown##*/}" in
    AUDIT-*.md|audit-*.md|build-*.md|*-audit.md|*-report.md) ;;
    *) continue ;;
  esac
  parent="$markdown"
  skip=false
  while [[ "$parent" != "$project_root" ]]; do
    parent="${parent%/*}"
    if is_generated_directory "$parent"; then
      skip=true
      break
    fi
  done
  "$skip" || markdown_targets+=("$markdown")
done
shopt -u globstar nullglob

# Rastros de smoke/E2E, logs de build y cachés privadas de LTerminal fuera del
# repositorio. No se toca la configuración de usuario ni la caché global de
# Tauri; release/ queda siempre fuera de los objetivos.
external_targets=()
add_external_target() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  assert_external_target "$target" || exit 1
  if external_target_has_symlink_parent "$target"; then
    printf '  Se conserva la ruta bajo un enlace simbólico: %s\n' "$target"
    return 0
  fi
  local existing
  for existing in "${external_targets[@]}"; do
    [[ "$existing" == "$target" ]] && return 0
  done
  external_targets+=("$target")
}

shopt -s nullglob
for target in \
  "$temp_root"/winslim-terminal-e2e-*.json \
  "$temp_root"/winslim-terminal-e2e-captures-* \
  "$temp_root"/winslim-terminal-webview2-e2e-* \
  "$temp_root"/winslim-terminal-smoke-* \
  "$temp_root"/lterminal-smoke-* \
  "$temp_root"/lterminal-e2e-report.* \
  "$temp_root"/lterminal-e2e-* \
  "$temp_root"/lterminal-wine-smoke* \
  "$temp_root"/lterminal-appimage-*; do
  add_external_target "$target"
done
shopt -u nullglob

for data_root in "$config_root/winslim-terminal" "$config_root/WinSlim Terminal" "$config_root/lterminal"; do
  [[ -d "$data_root/logs" ]] && add_external_target "$data_root/logs"
done
for cache_path in "$cache_root/lterminal/cache" "$cache_root/lterminal/e2e" "$cache_root/lterminal/appimage"; do
  [[ -e "$cache_path" ]] && add_external_target "$cache_path"
done

# La app crea sesiones temporales por PID. Se limpian las antiguas, pero se
# conservan las que pertenecen a un proceso lterminal vivo.
for session_root in "$temp_root/lterminal" "$temp_root/winslim-terminal"; do
  [[ -d "$session_root" ]] || continue
  for session_dir in "$session_root"/*; do
    [[ -d "$session_dir" && "${session_dir##*/}" =~ ^[0-9]+$ ]] || continue
    if kill -0 "${session_dir##*/}" 2>/dev/null; then
      printf '  Se conserva sesión activa: %s\n' "$session_dir"
    else
      add_external_target "$session_dir"
    fi
  done
done

targets=("${directory_targets[@]}" "${markdown_targets[@]}" "${external_targets[@]}")
if (( ${#targets[@]} == 0 )); then
  printf '%s\n' 'Repositorio ya limpio: no hay salidas generadas ni informes Markdown.'
  exit 0
fi

if ! "$apply"; then
  printf 'VISTA PREVIA — %d ruta(s) bajo %s\n' "${#targets[@]}" "$project_root"
else
  printf 'LIMPIEZA — %d ruta(s) bajo %s\n' "${#targets[@]}" "$project_root"
fi
for target in "${targets[@]}"; do
  if [[ "$target" == "$project_root"/* ]]; then
    printf '  %s\n' "${target#"$project_root/"}"
  else
    printf '  %s\n' "$target"
  fi
done

if ! "$apply"; then
  printf '%s\n' 'No se ha borrado nada. Ejecuta: scripts/clean-repository.sh --apply'
  exit 0
fi

failed_targets=()
for target in "${directory_targets[@]}"; do
  assert_project_target "$target"
  rm -rf -- "$target" || failed_targets+=("$target")
done
for target in "${markdown_targets[@]}"; do
  assert_project_target "$target"
  rm -f -- "$target" || failed_targets+=("$target")
done
for target in "${external_targets[@]}"; do
  assert_external_target "$target"
  if external_target_has_symlink_parent "$target"; then
    failed_targets+=("$target")
    continue
  fi
  rm -rf -- "$target" || failed_targets+=("$target")
done
if (( ${#failed_targets[@]} > 0 )); then
  printf 'Limpieza incompleta: %d ruta(s) sigue(n) bloqueada(s).\n' "${#failed_targets[@]}" >&2
  exit 1
fi
printf 'Limpieza terminada: %d directorio(s), %d Markdown y %d rastro(s) externo(s) eliminados. release/ se conservó.\n' "${#directory_targets[@]}" "${#markdown_targets[@]}" "${#external_targets[@]}"
