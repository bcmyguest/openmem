#!/usr/bin/env bash
# Run run_task.py with the subscription OAuth token, Python 3.9 task venvs and the pinned OpenMem export.
# OPENMEM_SHA / OPENMEM_REPO are the only things to change for a newer OpenMem commit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
B=$(dirname "$HERE")
export OPENMEM_SHA=${OPENMEM_SHA:-cbe332a}
export OPENMEM_REPO=${OPENMEM_REPO:-$B/repo-main}
export CB_PYTHON=${CB_PYTHON:-$B/uvpy/cpython-3.9.25-linux-x86_64-gnu/bin/python3.9}
export CBO_NODE=${CBO_NODE:-$B/node24/bin/node}
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(head -n1 "$B/state/oauth-token")"; export CLAUDE_CODE_OAUTH_TOKEN
fi
exec python3 "$HERE/run_task.py" "$@"
