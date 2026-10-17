#!/usr/bin/env bash
# Writes HOST_UID and HOST_GID to .env (git-ignored), keeping any other lines, then runs gen-masks.sh.
# Run before the first `docker compose` command: compose refuses to parse the project without these values.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo}/.env"
tmp="${env_file}.tmp"

{
    if [ -f "${env_file}" ]; then
        grep -v -E '^(HOST_UID|HOST_GID)=' "${env_file}" || true
    fi
    echo "HOST_UID=$(id -u)"
    echo "HOST_GID=$(id -g)"
} > "${tmp}"
chmod 0644 "${tmp}"
mv "${tmp}" "${env_file}"

echo "wrote ${env_file}: HOST_UID=$(id -u) HOST_GID=$(id -g)"
bash "${repo}/scripts/gen-masks.sh"
