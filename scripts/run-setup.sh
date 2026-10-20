#!/usr/bin/env bash
# Invoked by ansible after personal-memory is cloned. Runs ./setup when a TTY is
# available; otherwise prints what to run by hand.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO}"

if [ ! -d wizard/node_modules/@clack/prompts ]; then
    npm install --prefix wizard --no-fund --no-audit
fi

if [ ! -f config/machine.env ] && [ -f config/machine.env.example ]; then
    cp -n config/machine.env.example config/machine.env
    printf 'Created %s from example — edit for this machine, then rerun ./setup\n' config/machine.env
fi

if [ -f "${HOME}/.config/hindsight/wizard.conf" ]; then
    exec ./setup --yes --no-smoke "$@"
fi

if [ -t 0 ] && [ -t 1 ]; then
    exec ./setup --no-smoke "$@"
fi

cat <<EOF
personal-memory is at ${REPO}

Run the setup wizard on a terminal (configures Docker, the memory provider, indexing):

  cd ${REPO}
  cp -n config/machine.env.example config/machine.env   # once per machine
  \$EDITOR config/machine.env
  ./setup

Reconfigure later: cd ${REPO} && ./setup
EOF
exit 0
