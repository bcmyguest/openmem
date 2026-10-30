"""TTL cleanup of session files (docs/context-store.md, "Retention"). Same rules as sweepContextStore in
cli/coding-agent/session-db.mjs."""

import os
import time
from pathlib import Path

DAY_S = 86400
STAMP = ".ttl-stamp"
# Longest first, so `x.trim.json` groups under `x`, not `x.trim`.
SESSION_SUFFIXES = (".log.jsonl", ".trim.json", ".db-wal", ".db-shm", ".force", ".json", ".db")


def session_of(name):
    """(sid, suffix) for a session file name, or None for anything else."""
    if name.startswith("."):
        return None
    for suffix in SESSION_SUFFIXES:
        if name.endswith(suffix) and len(name) > len(suffix):
            return name[: -len(suffix)], suffix
    return None


def sweep(root, ttl_days, now=None):
    """Delete every session whose newest file is older than ttl_days; returns the deleted sids, sorted."""
    if not ttl_days or ttl_days <= 0:
        return []
    now = time.time() if now is None else now
    sessions = Path(root) / "sessions"
    groups = {}
    try:
        entries = list(os.scandir(sessions))
    except OSError:
        return []
    for entry in entries:
        parsed = session_of(entry.name)
        if parsed is None or not entry.is_file(follow_symlinks=False):
            continue
        try:
            mtime = entry.stat(follow_symlinks=False).st_mtime
        except OSError:
            continue
        group = groups.setdefault(parsed[0], [0.0, []])
        group[0] = max(group[0], mtime)
        group[1].append(entry.path)
    cutoff = now - ttl_days * DAY_S
    deleted = []
    for sid, (newest, paths) in groups.items():
        if newest >= cutoff:
            continue
        for path in paths:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        deleted.append(sid)
    return sorted(deleted)


def maybe_sweep(root, ttl_days, now=None):
    """sweep() at most once a day, recorded by the mtime of <root>/.ttl-stamp; returns the deleted sids."""
    if not ttl_days or ttl_days <= 0:
        return []
    now = time.time() if now is None else now
    stamp = Path(root) / STAMP
    try:
        if now - stamp.stat().st_mtime < DAY_S:
            return []
    except FileNotFoundError:
        pass
    except OSError:
        return []
    if not Path(root).is_dir():
        return []
    fd = os.open(stamp, os.O_WRONLY | os.O_CREAT, 0o600)
    os.close(fd)
    os.utime(stamp, (now, now))
    return sweep(root, ttl_days, now)
