#!/usr/bin/env python3
"""Index every source once at startup, then re-index a source after it stops changing."""

import subprocess
import sys
import time
from pathlib import Path

from watchfiles import watch


INDEXER = "hindsight-project-index"
QUIET_SECONDS = 30
IGNORED_DIRS = {"node_modules", "build", "dist", "target", "vendor", "__pycache__"}
POLL_SECONDS = 5


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}", flush=True)


def list_sources() -> list[tuple[str, Path]]:
    result = subprocess.run([INDEXER, "--list"], capture_output=True, text=True, check=True)
    sources = []
    for line in result.stdout.splitlines():
        kind, _, path = line.partition("\t")
        if kind and path:
            sources.append((kind, Path(path)))
    return sources


def root_for(path: Path, roots: list[Path]) -> Path | None:
    matches = [root for root in roots if path == root or root in path.parents]
    return max(matches, key=lambda root: len(root.parts), default=None)


def make_filter(roots: list[Path]):
    def keep(_change, raw_path: str) -> bool:
        path = Path(raw_path)
        root = root_for(path, roots)
        if root is None:
            return False
        # Dot-prefixed paths cover .git (including .git/objects), .codegraph, .venv, .obsidian, .trash, and dotfile caches.
        return not any(part.startswith(".") or part in IGNORED_DIRS for part in path.relative_to(root).parts)

    return keep


def run_indexer(kind: str, path: Path | None = None) -> None:
    command = [INDEXER, "--apply"]
    if path is not None:
        command += ["--vault" if kind == "vault" else "--repo", str(path)]
    log(f"index {kind} {path or 'all sources'}")
    code = subprocess.run(command, check=False).returncode
    log(f"index {kind} {path or 'all sources'} exited {code}")


def main() -> int:
    sources = list_sources()
    if not sources:
        log("no sources selected; nothing to watch")
        return 1
    kinds = {path: kind for kind, path in sources}
    roots = list(kinds)

    run_indexer("all", None)
    log(f"watching {len(roots)} sources; quiet period {QUIET_SECONDS}s")

    pending: dict[Path, float] = {}
    for changes in watch(*roots, watch_filter=make_filter(roots), rust_timeout=POLL_SECONDS * 1000, yield_on_timeout=True):
        now = time.monotonic()
        for _change, raw_path in changes:
            root = root_for(Path(raw_path), roots)
            if root is not None:
                pending[root] = now
        for root, last in list(pending.items()):
            if now - last >= QUIET_SECONDS:
                del pending[root]
                run_indexer(kinds[root], root)
                # Watcher events raised during the run stay queued and reach the next batch.
    return 0


if __name__ == "__main__":
    sys.exit(main())
