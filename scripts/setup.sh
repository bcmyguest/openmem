#!/usr/bin/env bash
# Cross-platform wrapper; logic lives in scripts/setup.mjs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/setup.mjs" "$@"
