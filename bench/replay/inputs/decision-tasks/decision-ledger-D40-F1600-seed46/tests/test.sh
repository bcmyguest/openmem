#!/usr/bin/env bash
# Grades the agent's own messages (context snapshots, else trajectory, else final
# report) with the ContextBench graders vendored next to this script. Runs after the
# agent has finished; writes /logs/verifier/reward.json.
set -u
PY=$(command -v python3 || command -v python) || {
  echo "ContextBench grading needs python3 in the image; or verify on the host with"        "contextbench.harbor.verifiers:ContextBenchVerifier" >&2
  exit 2
}
PYTHONPATH=/tests/_cb "$PY" -m contextbench.harbor.reward   --agent-dir /logs/agent --gold /tests/gold.json --out-dir /logs/verifier
