#!/usr/bin/env python3
"""Keep Hindsight current: watch Obsidian vaults with inotify, poll git repositories, re-list sources periodically.

inotify is not used for repositories: they hold hundreds of thousands of directories, which exceeds the host's
max_user_watches limit. Repositories are polled by fingerprint (HEAD plus tracked-file status) instead.
"""

import hashlib
import os
import subprocess
import sys
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import index_config


INDEXER = "hindsight-project-index"
MAX_BACKOFF_SECONDS = 600
IGNORED_DIRS = {"node_modules", "build", "dist", "target", "vendor", "__pycache__"}
DRY_RUN = os.environ.get("INDEXER_DRY_RUN") == "1"


def timings(settings: index_config.Config, environ: Mapping[str, str]) -> tuple[int, int, int]:
    """Return (poll, vault quiet, relist) seconds. Environment variables override index.yml."""
    return (
        int(environ.get("POLL_SECONDS", settings.poll_seconds)),
        int(environ.get("VAULT_QUIET_SECONDS", settings.vault_quiet_seconds)),
        int(environ.get("RELIST_SECONDS", settings.relist_seconds)),
    )


# Loaded at import, so an invalid config stops the watcher before it starts.
POLL_SECONDS, VAULT_QUIET_SECONDS, LIST_SECONDS = timings(index_config.load(), os.environ)


@dataclass(frozen=True)
class RepoWatch:
    indexed: str | None  # fingerprint at the last successful index
    seen: str | None  # fingerprint at the previous poll


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}", flush=True)


def git_fingerprint(repo: Path) -> str:
    """HEAD plus a digest of tracked-file changes. Untracked files are ignored, matching the indexer."""
    head = subprocess.run(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=repo, capture_output=True, text=True, check=False)
    head_id = head.stdout.strip() if head.returncode == 0 else "unborn"
    status = subprocess.run(["git", "status", "--porcelain=v1", "-uno"], cwd=repo, capture_output=True, check=True).stdout
    return f"{head_id}:{hashlib.sha256(status).hexdigest()}"


def step(state: RepoWatch, fingerprint: str) -> tuple[RepoWatch, bool]:
    """Advance one poll. Return the new state and whether to index now.

    A change indexes only after the fingerprint stays unchanged for one more poll.
    """
    new_state = RepoWatch(state.indexed, fingerprint)
    if fingerprint == state.indexed:
        return new_state, False
    return new_state, fingerprint == state.seen


def mark_indexed(state: RepoWatch, fingerprint: str) -> RepoWatch:
    return RepoWatch(fingerprint, state.seen)


def list_sources() -> dict[Path, str]:
    result = subprocess.run([INDEXER, "--list"], capture_output=True, text=True, check=True)
    sources: dict[Path, str] = {}
    for line in result.stdout.splitlines():
        kind, _, path = line.partition("\t")
        if kind and path:
            sources[Path(path)] = kind
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
        # Dot-prefixed paths cover .git, .obsidian, .trash, .codegraph, .venv, and dotfile caches.
        return not any(part.startswith(".") or part in IGNORED_DIRS for part in path.relative_to(root).parts)

    return keep


def run_indexer(kind: str, path: Path) -> int:
    command = [INDEXER, "--apply", "--vault" if kind == "vault" else "--repo", str(path)]
    log(f"index {kind} {path}")
    if DRY_RUN:
        log(f"dry run, not executed: {' '.join(command)}")
        return 0
    try:
        code = subprocess.run(command, check=False).returncode
    except OSError as error:
        log(f"index {kind} {path} could not start: {error}")
        return 1
    log(f"index {kind} {path} exited {code}")
    return code


def watch_vaults(vaults: list[Path], stop: threading.Event) -> None:
    """Index each vault after VAULT_QUIET_SECONDS without changes. Returns when stop is set."""
    from watchfiles import watch  # imported here so the pure helpers work without watchfiles

    pending: dict[Path, float] = {}
    for changes in watch(*vaults, watch_filter=make_filter(vaults), rust_timeout=1000, yield_on_timeout=True, stop_event=stop):
        for _change, raw_path in changes:
            root = root_for(Path(raw_path), vaults)
            if root is not None:
                pending[root] = time.monotonic()
        for root, last in list(pending.items()):
            if time.monotonic() - last >= VAULT_QUIET_SECONDS:
                del pending[root]
                run_indexer("vault", root)
                # Changes made during the run arrive in later batches and re-trigger the vault.


class VaultWatcher:
    def __init__(self, vaults: list[Path]):
        self.vaults = vaults
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, name="vault-watch", daemon=True)

    def start(self) -> "VaultWatcher":
        self.thread.start()
        return self

    def close(self) -> None:
        # Does not join: a running index may take minutes, and the poller must keep going.
        self.stop.set()

    def _run(self) -> None:
        backoff = 1
        while not self.stop.is_set():
            try:
                watch_vaults(self.vaults, self.stop)
                return
            except Exception as error:
                log(f"vault watcher failed: {type(error).__name__}: {error}; retrying in {backoff}s")
                self.stop.wait(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)


def index_repo(path: Path, repos: dict[Path, RepoWatch]) -> None:
    try:
        baseline: str | None = git_fingerprint(path)
    except Exception as error:
        log(f"{path}: fingerprint failed: {type(error).__name__}: {error}")
        baseline = None
    indexed = baseline if run_indexer("repo", path) == 0 else None
    repos[path] = RepoWatch(indexed, baseline)


def poll_repos(repos: dict[Path, RepoWatch]) -> None:
    for path, state in list(repos.items()):
        try:
            fingerprint = git_fingerprint(path)
        except Exception as error:
            log(f"{path}: fingerprint failed: {type(error).__name__}: {error}")
            continue
        repos[path], should_index = step(state, fingerprint)
        if should_index and run_indexer("repo", path) == 0:
            repos[path] = mark_indexed(repos[path], fingerprint)


def refresh(kinds: dict[Path, str], repos: dict[Path, RepoWatch], watcher: VaultWatcher | None) -> tuple[dict[Path, str], VaultWatcher | None]:
    try:
        found = list_sources()
    except Exception as error:
        log(f"listing sources failed, keeping {len(kinds)} known: {type(error).__name__}: {error}")
        return kinds, watcher
    if not found:
        log("no sources selected; nothing to index or watch")
    for path in set(kinds) - set(found):
        log(f"source removed: {path}")
        repos.pop(path, None)
    vaults = sorted(path for path, kind in found.items() if kind == "vault")
    if vaults != sorted(path for path, kind in kinds.items() if kind == "vault"):
        # Restart the watcher before indexing new vaults, so edits made meanwhile are queued, not lost.
        if watcher is not None:
            watcher.close()
        watcher = VaultWatcher(vaults).start() if vaults else None
    for path, kind in found.items():
        if path in kinds:
            continue
        log(f"new {kind} source: {path}")
        if kind == "vault":
            run_indexer("vault", path)
        else:
            index_repo(path, repos)
    return found, watcher


def main() -> int:
    log(f"poll {POLL_SECONDS}s, vault quiet {VAULT_QUIET_SECONDS}s, source listing {LIST_SECONDS}s" + (", dry run" if DRY_RUN else ""))
    kinds: dict[Path, str] = {}
    repos: dict[Path, RepoWatch] = {}
    watcher: VaultWatcher | None = None
    next_list = 0.0
    failures = 0
    while True:
        try:
            if time.monotonic() >= next_list:
                next_list = time.monotonic() + LIST_SECONDS
                kinds, watcher = refresh(kinds, repos, watcher)
            poll_repos(repos)
            failures = 0
            time.sleep(POLL_SECONDS)
        except Exception as error:
            failures += 1
            delay = min(POLL_SECONDS * 2**failures, MAX_BACKOFF_SECONDS)
            log(f"iteration failed: {type(error).__name__}: {error}; retrying in {delay}s")
            time.sleep(delay)


if __name__ == "__main__":
    sys.exit(main())
