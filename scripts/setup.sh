#!/usr/bin/env bash
# Writes HOST_UID, HOST_GID, and LITELLM_CONFIG to .env (git-ignored), keeping any other lines, then runs gen-masks.sh.
# Run before the first `docker compose` command: compose refuses to parse the project without these values.
#
#   bash scripts/setup.sh                       # MEMORY_BACKEND=lemond (default)
#   MEMORY_BACKEND=ollama bash scripts/setup.sh # laptop: config/litellm.ollama.yaml
#   bash scripts/setup.sh --migrate-env         # point an existing hindsight.env at the LiteLLM proxy
#
# LiteLLM config: ~/.config/hindsight/litellm.yaml wins when it exists, else config/litellm.$MEMORY_BACKEND.yaml.
# LiteLLM env: ~/.config/hindsight/litellm.env (LITELLM_MASTER_KEY, LEMOND_API_KEY), created with mode 600 if missing.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo}/.env"
tmp="${env_file}.tmp"
hindsight_env="${HINDSIGHT_ENV_FILE:-${HOME}/.config/hindsight/hindsight.env}"
litellm_env="${LITELLM_ENV_FILE:-${HOME}/.config/hindsight/litellm.env}"
override_config="${HOME}/.config/hindsight/litellm.yaml"
backend="${MEMORY_BACKEND:-lemond}"
migrate=0
[ "${1:-}" = "--migrate-env" ] && migrate=1

case "${backend}" in
    lemond|ollama) ;;
    *) echo "MEMORY_BACKEND must be lemond or ollama (got: ${backend})" >&2; exit 1 ;;
esac

mkdir -p "${HOME}/.config/hindsight"
chmod 700 "${HOME}/.config/hindsight"

# LiteLLM env: generate the master key once. Never print it.
if [ ! -f "${litellm_env}" ]; then
    umask 077
    {
        echo "# LiteLLM proxy secrets. Read by the litellm compose service. Do not commit."
        echo "LITELLM_MASTER_KEY=sk-$(python3 -c 'import secrets;print(secrets.token_hex(24))')"
        echo "# lemond ignores the key; any non-empty value works."
        echo "LEMOND_API_KEY=placeholder"
        echo "# Hosted models: add the provider key here, e.g. ANTHROPIC_API_KEY=..., and reference it as os.environ/ANTHROPIC_API_KEY."
    } > "${litellm_env}"
    chmod 600 "${litellm_env}"
    echo "created ${litellm_env} (mode 600)"
fi

if [ -f "${override_config}" ]; then
    litellm_config="${override_config}"
else
    litellm_config="${repo}/config/litellm.${backend}.yaml"
fi

{
    if [ -f "${env_file}" ]; then
        grep -v -E '^(HOST_UID|HOST_GID|LITELLM_CONFIG)=' "${env_file}" || true
    fi
    echo "HOST_UID=$(id -u)"
    echo "HOST_GID=$(id -g)"
    echo "LITELLM_CONFIG=${litellm_config}"
} > "${tmp}"
chmod 0644 "${tmp}"
mv "${tmp}" "${env_file}"

echo "wrote ${env_file}: HOST_UID=$(id -u) HOST_GID=$(id -g) LITELLM_CONFIG=${litellm_config}"
bash "${repo}/scripts/gen-masks.sh"

if [ "${migrate}" -eq 1 ]; then
    # Rewrites only the LLM lines. The key is read into a shell variable and printed by printf, never echoed.
    [ -f "${hindsight_env}" ] || { echo "no ${hindsight_env} to migrate" >&2; exit 1; }
    key="$(grep -E '^LITELLM_MASTER_KEY=' "${litellm_env}" | cut -d= -f2-)"
    [ -n "${key}" ] || { echo "LITELLM_MASTER_KEY missing from ${litellm_env}" >&2; exit 1; }
    backup="${hindsight_env}.bak-$(date +%Y%m%d%H%M%S)"
    cp -p "${hindsight_env}" "${backup}"
    keys='^HINDSIGHT_API_(LLM_BASE_URL|LLM_MODEL|LLM_API_KEY|RETAIN_LLM_MODEL|REFLECT_LLM_MODEL|CONSOLIDATION_LLM_MODEL|MENTAL_MODEL_REFRESH_LLM_MODEL)='
    new="${hindsight_env}.tmp"
    umask 077
    {
        grep -v -E "${keys}" "${hindsight_env}" || true
        printf '%s\n' \
            'HINDSIGHT_API_LLM_PROVIDER=openai' \
            'HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1' \
            'HINDSIGHT_API_LLM_MODEL=memory-reflect' \
            "HINDSIGHT_API_LLM_API_KEY=${key}" \
            'HINDSIGHT_API_RETAIN_LLM_MODEL=memory-retain' \
            'HINDSIGHT_API_REFLECT_LLM_MODEL=memory-reflect' \
            'HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=memory-consolidate' \
            'HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_MODEL=memory-reflect'
    } > "${new}"
    chmod 600 "${new}"
    mv "${new}" "${hindsight_env}"
    echo "migrated ${hindsight_env} to the LiteLLM proxy (backup: ${backup}). Values not printed."
    echo "Next: docker compose up -d   (recreates hindsight with the new env)"
    exit 0
fi

if grep -q -E '^HINDSIGHT_API_LLM_BASE_URL=http://host\.docker\.internal:' "${hindsight_env}" 2>/dev/null; then
    echo "NOTE: ${hindsight_env} still calls the model server directly."
    echo "      Run: bash scripts/setup.sh --migrate-env   (backs up the file, rewrites only LLM lines)"
fi
