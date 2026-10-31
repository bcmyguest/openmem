#!/usr/bin/env bash
# Non-interactive checkout bootstrap (CI, remote shells without a TTY).
# Prefer: ./setup  or  npm run setup
# Do not use `npx . setup` here: a checkout does not link its own package bins
# into node_modules/.bin, so npx fails with "openmem: not found" (exit 127).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO}"

npm install --no-fund --no-audit

run_setup() {
  if [ -e "${REPO}/setup" ]; then
    exec "${REPO}/setup" "$@"
  fi
  exec npm run setup -- "$@"
}

if [ -f "${HOME}/.config/hindsight/wizard.conf" ]; then
  run_setup --yes --no-smoke "$@"
fi

if [ -t 0 ] && [ -t 1 ]; then
  run_setup --no-smoke "$@"
fi

cat <<EOF
openmem checkout: ${REPO}

Run the wizard on a terminal (Docker, provider, indexing):

  cd ${REPO}
  mkdir -p ~/.config/personal-memory
  cp config/openmem.toml.example ~/.config/personal-memory/config.toml
  ./setup

Or from npm (no clone): npx @bcmyguest/openmem
EOF
exit 0
