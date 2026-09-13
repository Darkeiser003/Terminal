#!/usr/bin/env bash
set -uo pipefail

usage() {
    cat <<'HELP'
Configura la firma SSH de commits de Git para un repositorio local.

Uso:
  bash build-tools/configure-git-signing.sh [--repo RUTA] [--key CLAVE_PRIVADA]

Sin --key, busca parejas clave_privada/clave_privada.pub en ~/.ssh y permite
elegir una. Solo modifica la configuración local del repositorio; no sube
claves ni cambia la cuenta de GitHub.
HELP
}

repo_path="."
key_path=""
while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --repo)
            if [[ "$#" -lt 2 || "$2" == -* ]]; then
                printf '%s\n' 'ERROR: --repo requiere una ruta.' >&2
                exit 2
            fi
            repo_path="$2"
            shift 2
            ;;
        --key)
            if [[ "$#" -lt 2 || "$2" == -* ]]; then
                printf '%s\n' 'ERROR: --key requiere la ruta de una clave privada.' >&2
                exit 2
            fi
            key_path="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            printf 'Opción desconocida: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if ! repo_root="$(git -C "$repo_path" rev-parse --show-toplevel 2>/dev/null)"; then
    printf 'ERROR: %s no pertenece a un repositorio Git.\n' "$repo_path" >&2
    exit 1
fi

declare -a private_keys=()
declare -a public_keys=()

add_key_pair() {
    local private_path="$1" public_path="$2"
    [[ -f "$private_path" && -r "$private_path" && -f "$public_path" && -r "$public_path" ]] || return 1
    ssh-keygen -lf "$public_path" >/dev/null 2>&1 || return 1
    private_keys+=("$(cd -- "$(dirname -- "$private_path")" && pwd -P)/$(basename -- "$private_path")")
    public_keys+=("$(cd -- "$(dirname -- "$public_path")" && pwd -P)/$(basename -- "$public_path")")
}

if [[ -n "$key_path" ]]; then
    if [[ "$key_path" == *.pub ]]; then
        add_key_pair "${key_path%.pub}" "$key_path" || {
            printf 'ERROR: no se encontró una pareja privada/pública válida para %s.\n' "$key_path" >&2
            exit 1
        }
    else
        add_key_pair "$key_path" "$key_path.pub" || {
            printf 'ERROR: no se encontró una pareja privada/pública válida para %s.\n' "$key_path" >&2
            exit 1
        }
    fi
else
    if [[ -z "${HOME:-}" || ! -d "$HOME/.ssh" ]]; then
        printf '%s\n' 'ERROR: no se encontró ~/.ssh. Indica una clave con --key.' >&2
        exit 1
    fi
    shopt -s nullglob
    for public_path in "$HOME"/.ssh/*.pub; do
        add_key_pair "${public_path%.pub}" "$public_path" || true
    done
    shopt -u nullglob
fi

if [[ "${#private_keys[@]}" -eq 0 ]]; then
    printf '%s\n' 'No encontré una pareja de claves SSH legible.' >&2
    printf '%s\n' 'gh auth login --git-protocol ssh puede ofrecer generar/subir una clave de acceso; después vuelve a ejecutar este asistente.' >&2
    printf '%s\n' 'También puedes indicar la clave privada con --key. La pública debe registrarse aparte en GitHub como Signing key.' >&2
    exit 1
fi

selected=0
if [[ "${#private_keys[@]}" -gt 1 ]]; then
    printf 'Claves disponibles para firmar en %s:\n' "$repo_root"
    for index in "${!private_keys[@]}"; do
        fingerprint="$(ssh-keygen -lf "${public_keys[$index]}" 2>/dev/null | awk '{print $2}')"
        printf '  %d. %s (%s)\n' "$((index + 1))" "${private_keys[$index]}" "$fingerprint"
    done
    read -r -p 'Elige una clave (número): ' choice || exit 1
    if [[ ! "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#private_keys[@]} )); then
        printf '%s\n' 'Selección no válida; no se modificó la configuración.' >&2
        exit 2
    fi
    selected=$((choice - 1))
else
    fingerprint="$(ssh-keygen -lf "${public_keys[0]}" 2>/dev/null | awk '{print $2}')"
    printf 'Clave detectada: %s (%s)\n' "${private_keys[0]}" "$fingerprint"
fi

printf 'Se habilitará la firma automática solo en %s.\n' "$repo_root"
read -r -p '¿Continuar? [s/N]: ' answer || exit 1
case "${answer,,}" in
    s|si|sí|y|yes) ;;
    *) printf '%s\n' 'Sin cambios.'; exit 0 ;;
esac

cd -- "$repo_root" || exit 1

declare -A old_values=()
declare -A old_present=()
for setting in gpg.format user.signingkey commit.gpgsign; do
    if old_value="$(git config --local --get "$setting" 2>/dev/null)"; then
        old_present["$setting"]=1
        old_values["$setting"]="$old_value"
    else
        old_present["$setting"]=0
        old_values["$setting"]=""
    fi
done

restore_setting() {
    local setting="$1"
    if [[ "${old_present[$setting]}" == 1 ]]; then
        git config --local --replace-all "$setting" "${old_values[$setting]}" || true
    else
        git config --local --unset-all "$setting" >/dev/null 2>&1 || true
    fi
}

if ! git config --local --replace-all gpg.format ssh \
    || ! git config --local --replace-all user.signingkey "${private_keys[$selected]}" \
    || ! git config --local --replace-all commit.gpgsign true; then
    restore_setting gpg.format
    restore_setting user.signingkey
    restore_setting commit.gpgsign
    printf '%s\n' 'ERROR: no se pudo completar la configuración; se restauraron los valores anteriores.' >&2
    exit 1
fi

printf '\nFirma SSH configurada para los commits de este repositorio.\n'
printf 'Clave pública que debes registrar en GitHub como “Signing key”:\n'
if ! cat -- "${public_keys[$selected]}"; then
    printf 'ERROR: no se pudo leer la clave pública %s.\n' "${public_keys[$selected]}" >&2
    exit 1
fi
printf '\nEn GitHub: Settings → SSH and GPG keys → New SSH key → Key type: Signing key.\n'
printf 'Esto no cambia la firma Ed25519 de los manifiestos de release ni solicita claves al compilar.\n'
