#!/usr/bin/env bash
# Install prek git hooks for OpenMem (reads ./.pre-commit-config.yaml).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "OpenMem — prek setup"

if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required (https://docs.astral.sh/uv/)"
  exit 1
fi
echo "✓ uv: $(uv --version)"

echo ""
echo "📥 Installing prek (uv tool, stable path for git hook shims)..."
uv tool install --force "prek>=0.5,<0.6"

if ! command -v prek >/dev/null 2>&1; then
  echo "Error: prek not on PATH — add: export PATH=\"$(uv tool dir --bin 2>/dev/null || echo "$HOME/.local/bin"):\$PATH\""
  exit 1
fi
echo "✓ prek: $(prek --version)"

echo ""
echo "📦 Node dev deps (eslint, …)..."
npm ci

echo ""
echo "📦 Site deps (astro check)..."
pnpm --dir site install --frozen-lockfile

echo ""
echo "📦 Python dev deps (pytest, …)..."
uv sync --group dev

echo ""
echo "🔧 Installing git hooks (pre-commit, commit-msg)..."
prek install --prepare-hooks --hook-type pre-commit --hook-type commit-msg -f

echo ""
echo "🚀 Running prek on all files (may auto-fix whitespace)..."
if prek run --all-files; then
  echo "✅ prek checks passed."
else
  echo "⚠️  Some checks failed or auto-fixed files — review and commit."
  exit 1
fi

echo ""
echo "Useful: prek run | prek run --all-files | prek update --freeze"
