#!/bin/sh
# openmem: test pack/install and optional GitHub release (clean subshell).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOG="${RUN_LOG:-/tmp/openmem-spin-$(date +%Y%m%d-%H%M%S).log}"

usage() {
  cat <<EOF
Usage: sh scripts/spin-up.sh <target>

  test           npm test (pack + install + coding-agent wiring)
  release        merge wip/revamp -> main if needed, run Prepare release workflow
  help

Log: \$RUN_LOG ($LOG)
EOF
}

run() {
  (cd "$ROOT" && "$@") 2>&1 | tee "$LOG"
  echo "log: $LOG"
}

target=${1:-help}
case $target in
  help|-h|--help) usage; exit 0 ;;
  test) run npm test ;;
  release)
    run git fetch origin main wip/revamp
    branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
    if [ "$branch" != main ]; then
      git -C "$ROOT" checkout main
      git -C "$ROOT" pull origin main
      git -C "$ROOT" merge --no-edit origin/wip/revamp
      git -C "$ROOT" push origin main
    fi
    gh workflow run "Prepare release" --repo bcmyguest/openmem -f dry_run=false
    echo "Prepare release dispatched; watch: gh run list --repo bcmyguest/openmem --workflow Release"
    ;;
  *)
    echo "unknown: $target" >&2
    usage >&2
    exit 2
    ;;
esac
