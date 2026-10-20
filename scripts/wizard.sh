#!/usr/bin/env bash
# Deprecated: use ./setup or node wizard/bin/setup.mjs. Kept for scripts that still invoke wizard.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/../wizard/bin/setup.mjs" "$@"
