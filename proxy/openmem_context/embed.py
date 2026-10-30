"""Background embeddings for session databases, off the request path (docs/context-store.md, "Vectors").

The request path calls Embedder.notify(path) after it stores new rows; one daemon thread embeds rows that have no
vector for the configured model through an OpenAI-compatible POST <url>/embeddings and stores them. Errors are
logged (type and location only) and the session is retried after RETRY_S. Stdlib only.
"""

import json
import sqlite3
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request

from .sessiondb import BUSY_TIMEOUT_MS, pack_vector

BATCH = 32
# Characters of a row's text sent for embedding; long tool results are embedded by their start.
EMBED_MAX_CHARS = 8000
TIMEOUT_S = 30
RETRY_S = 60


def _log_error(exc):
    tb = traceback.extract_tb(exc.__traceback__)
    where = f"{tb[-1].filename.rsplit('/', 1)[-1]}:{tb[-1].lineno}" if tb else "?"
    print(f"openmem-context: embedding failed {type(exc).__name__} at {where}", file=sys.stderr, flush=True)


def urllib_embed(url, model, api_key, texts):
    """Vectors for texts from an OpenAI-compatible embeddings endpoint, in input order."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = json.dumps({"model": model, "input": texts}).encode("utf-8")
    req = urllib.request.Request(url.rstrip("/") + "/embeddings", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    data = sorted(payload["data"], key=lambda d: d.get("index", 0))
    vectors = [[float(x) for x in d["embedding"]] for d in data]
    if len(vectors) != len(texts):
        raise ValueError("embedding count mismatch")
    return vectors


def pending_rows(conn, model, limit):
    return conn.execute(
        "SELECT m.seq, m.text FROM messages m LEFT JOIN vectors v ON v.message_seq = m.seq AND v.model = ? "
        "WHERE v.message_seq IS NULL AND length(trim(m.text)) > 0 ORDER BY m.seq LIMIT ?", (model, limit)).fetchall()


def embed_pending(path, model, url, api_key="", embed=urllib_embed, batch=BATCH):
    """Embed every row of the database at path that lacks a `model` vector; returns the number stored."""
    # mode=rw: never create a database that TTL cleanup removed meanwhile.
    uri = "file:" + urllib.parse.quote(str(path)) + "?mode=rw"
    conn = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=BUSY_TIMEOUT_MS / 1000)
    stored = 0
    try:
        conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        while True:
            rows = pending_rows(conn, model, batch)
            if not rows:
                return stored
            vectors = embed(url, model, api_key, [text[:EMBED_MAX_CHARS] for _, text in rows])
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.executemany("INSERT OR IGNORE INTO vectors (message_seq, model, dim, blob) VALUES (?, ?, ?, ?)",
                                 [(seq, model, len(vec), pack_vector(vec)) for (seq, _), vec in zip(rows, vectors)])
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            stored += len(rows)
    finally:
        conn.close()


class Embedder:
    """One daemon thread; notify() queues a database path and never blocks on the network."""

    def __init__(self, embed=urllib_embed):
        self._embed = embed
        self._queue = {}
        self._retry_at = {}
        self._cond = threading.Condition()
        self._thread = None
        self._busy = False

    def notify(self, path, model, url, api_key=""):
        if not model or not url:
            return
        with self._cond:
            if time.monotonic() < self._retry_at.get(str(path), 0):
                return
            self._queue[str(path)] = (model, url, api_key)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="openmem-embed", daemon=True)
                self._thread.start()
            self._cond.notify()

    def drain(self, timeout=10):
        """Wait until the queue is empty (tests)."""
        end = time.monotonic() + timeout
        with self._cond:
            while (self._queue or self._busy) and time.monotonic() < end:
                self._cond.wait(0.05)

    def _run(self):
        while True:
            with self._cond:
                while not self._queue:
                    self._busy = False
                    self._cond.notify_all()
                    self._cond.wait()
                path, job = next(iter(self._queue.items()))
                del self._queue[path]
                self._busy = True
            try:
                embed_pending(path, *job, embed=self._embed)
            except Exception as exc:  # never let the thread die
                _log_error(exc)
                with self._cond:
                    self._retry_at[path] = time.monotonic() + RETRY_S


embedder = Embedder()
