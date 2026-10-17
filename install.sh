#!/usr/bin/env bash
# Link live Hindsight files to this repository. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_DIR="$HOME/.config/hindsight"
ENV_FILE="$ENV_DIR/hindsight.env"

# repo-relative path, live absolute path
LINKS=(
  "bin/hindsight-project-index|$HOME/.local/bin/hindsight-project-index"
  "systemd/hindsight.service|$HOME/.config/systemd/user/hindsight.service"
  "systemd/hindsight-index.service|$HOME/.config/systemd/user/hindsight-index.service"
  "systemd/hindsight-index.timer|$HOME/.config/systemd/user/hindsight-index.timer"
  "config/coding-agent.json|$HOME/.hindsight/coding-agent.json"
)

link_one() {
  local src="$REPO/$1" live="$2"

  if [[ -L "$live" && "$(readlink -f "$live")" == "$(readlink -f "$src")" ]]; then
    echo "ok       $live (already linked)"
    return
  fi

  if [[ -f "$live" && ! -L "$live" ]]; then
    if ! cmp -s "$src" "$live"; then
      echo "error: $live differs from $src; refusing to overwrite. Reconcile by hand, then re-run." >&2
      exit 1
    fi
  elif [[ -e "$live" && ! -L "$live" ]]; then
    echo "error: $live exists and is not a regular file; refusing to replace." >&2
    exit 1
  fi

  mkdir -p "$(dirname "$live")"
  ln -sfn "$src" "$live"
  echo "linked   $live -> $src"
}

for entry in "${LINKS[@]}"; do
  link_one "${entry%%|*}" "${entry#*|}"
done

if [[ ! -e "$ENV_FILE" ]]; then
  mkdir -p "$ENV_DIR"
  install -m 600 "$REPO/config/hindsight.env.example" "$ENV_FILE"
  echo "created  $ENV_FILE from example"
  echo "note: set HINDSIGHT_API_LLM_API_KEY in $ENV_FILE (the example holds 'replace-me')."
else
  echo "ok       $ENV_FILE (kept as is)"
fi

systemctl --user daemon-reload
echo "daemon-reload done. Units were not enabled or restarted."
echo "On a fresh machine, enable them with:"
echo "  systemctl --user enable --now hindsight.service hindsight-index.timer"
