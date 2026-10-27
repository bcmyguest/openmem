#!/usr/bin/env bash
# Non-interactive checkout bootstrap (CI, remote shells without a TTY).
# Prefer: npx openmem  or  cd checkout && npx . setup
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO}"

npm install --no-fund --no-audit

if [ -f "${HOME}/.config/hindsight/wizard.conf" ]; then
  exec npx . setup --yes --no-smoke "$@"
fi

if [ -t 0 ] && [ -t 1 ]; then
  exec npx . setup --no-smoke "$@"
fi

cat <<EOF
openmem checkout: ${REPO}

Run the wizard on a terminal (Docker, provider, indexing):

  cd ${REPO}
  mkdir -p ~/.config/personal-memory
  cp config/openmem.toml.example ~/.config/personal-memory/config.toml
  npx . setup

Or from npm (no clone): npx openmem
EOF
exit 0
