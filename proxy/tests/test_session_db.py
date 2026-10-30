"""Session database (sessions/<sid>.db), TTL cleanup and background embeddings. Run: python3 -m unittest discover -s proxy/tests"""

import copy
import io
import os
import sqlite3
import stat
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openmem_context import Settings, process_request  # noqa: E402
from openmem_context import embed as embed_mod  # noqa: E402
from openmem_context import sessiondb, ttl  # noqa: E402
from openmem_context.core import startup  # noqa: E402

SID = "db-1"
BIG = 10_000_000


def req(msgs, sid=SID):
    return {"model": "claude", "system": [{"type": "text", "text": "SYSTEM"}],
            "messages": copy.deepcopy(msgs), "proxy_server_request": {"headers": {"x-claude-code-session-id": sid}}}


def history(turns):
    msgs = []
    for t in range(turns):
        msgs.append({"role": "user", "content": [{"type": "text", "text": f"question {t}\nsecond line {t}"}]})
        msgs.append({"role": "assistant", "content": [
            {"type": "tool_use", "id": f"tu{t}", "name": "Bash", "input": {"command": f"echo {t}"}}]})
        msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"tu{t}", "content": f"out {t}"}]})
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": "ok"}]})
    return msgs


class DbBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ctx = Path(self.tmp.name) / "context"
        self.addCleanup(lambda: [sessiondb.drop_session(p) for p in list(sessiondb._open)])

    def run_req(self, msgs, sid=SID, **kw):
        base = dict(trim_at_tokens=BIG, compress_over_tokens=0, context_dir=self.ctx, standing_instruction=False)
        base.update(kw)
        return process_request(req(msgs, sid), "anthropic_messages", Settings(**base), http=lambda *a: (200, {}))

    def path(self, sid=SID):
        return self.ctx / "sessions" / f"{sid}.db"

    def query(self, sql, params=(), sid=SID):
        conn = sqlite3.connect(self.path(sid))
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()


class StoreEveryMessageTests(DbBase):
    def test_every_message_stored_once_across_resends(self):
        msgs = history(2)
        self.run_req(msgs)
        self.assertEqual(self.query("SELECT count(*) FROM messages")[0][0], 8)
        self.assertEqual(self.query("SELECT DISTINCT in_context FROM messages"), [(1,)])
        # The same history again, with Claude Code's moving cache_control marker and string/block change.
        again = copy.deepcopy(msgs)
        again[-1]["content"][0]["cache_control"] = {"type": "ephemeral"}
        again[0]["content"] = again[0]["content"][0]["text"]
        self.run_req(again)
        self.assertEqual(self.query("SELECT count(*) FROM messages")[0][0], 8)
        msgs.append({"role": "user", "content": "next"})
        self.run_req(msgs)
        self.assertEqual(self.query("SELECT count(*) FROM messages")[0][0], 9)
        self.assertEqual(self.query("SELECT text FROM messages ORDER BY seq DESC LIMIT 1"), [("next",)])

    def test_same_text_twice_is_two_rows_one_thread(self):
        self.run_req(history(2))
        self.assertEqual(self.query("SELECT count(*) FROM messages WHERE text = 'ok'")[0][0], 2)
        self.assertEqual(self.query("SELECT count(DISTINCT thread) FROM messages")[0][0], 1)
        self.run_req([{"role": "user", "content": "subagent task"}])
        self.assertEqual(self.query("SELECT count(DISTINCT thread) FROM messages")[0][0], 2)

    def test_lines_fts_schema_and_wal(self):
        self.run_req(history(1))
        self.assertEqual(self.query("PRAGMA user_version")[0][0], sessiondb.SCHEMA_VERSION)
        self.assertEqual(self.query("PRAGMA journal_mode")[0][0], "wal")
        self.assertEqual(self.query("SELECT line_no, text FROM lines WHERE message_seq = 1 ORDER BY line_no"),
                         [(1, "question 0"), (2, "second line 0")])
        self.assertEqual(self.query("SELECT count(*) FROM lines_fts WHERE lines_fts MATCH 'second'")[0][0], 1)
        self.assertEqual(self.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'echo'")[0][0], 2)
        self.assertEqual(stat.S_IMODE(os.stat(self.path()).st_mode), 0o600)
        shadow = ("_data", "_idx", "_docsize", "_config")
        names = [r[0] for r in self.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name")
                 if not r[0].endswith(shadow)]
        self.assertEqual(names, ["lines", "lines_fts", "lines_fts_insert", "messages", "messages_fts",
                                 "messages_fts_insert", "vectors"])

    def test_trim_marks_rows_out_of_context_with_cut_seq(self):
        msgs = history(3)
        self.run_req(msgs, trim_at_tokens=1)
        rows = self.query("SELECT seq, text, in_context, trimmed_at_seq FROM messages ORDER BY seq")
        cut_seq = next(seq for seq, text, _, _ in rows if text.startswith("question 2"))
        out = [r for r in rows if r[2] == 0]
        # Everything before the cut leaves context except the pinned first user turn (seq 1).
        self.assertEqual([r[0] for r in out], list(range(2, cut_seq)))
        self.assertTrue(all(r[3] == cut_seq for r in out))
        self.assertEqual(rows[0][2], 1)
        self.assertTrue(all(r[2] == 1 and r[3] is None for r in rows if r[0] >= cut_seq))

    def test_cut_reset_brings_rows_back(self):
        msgs = history(3)
        self.run_req(msgs, trim_at_tokens=1)
        self.assertGreater(self.query("SELECT count(*) FROM messages WHERE in_context = 0")[0][0], 0)
        # The client rewrote the history: the stored cut message is gone, so the thread resets and nothing is cut.
        changed = copy.deepcopy(msgs)
        changed[8]["content"][0]["text"] = "edited"
        self.run_req(changed[:8] + [changed[8]])
        old = self.query("SELECT in_context, trimmed_at_seq, trimmed_at FROM messages WHERE seq < 9")
        self.assertTrue(all(r == (1, None, None) for r in old), old)

    def test_compressed_result_stored_in_full(self):
        big = "\n".join(str(i) for i in range(20000))
        msgs = history(1)
        msgs[2]["content"][0]["content"] = big
        out = self.run_req(msgs, compress_over_tokens=100)
        self.assertTrue(out["messages"][2]["content"][0]["content"].startswith("[openmem: tool result compressed"))
        text, blob = self.query("SELECT text, blob_id FROM messages WHERE kind = 'tool_result'")[0]
        self.assertEqual(text, big)
        self.assertRegex(blob, r"^[0-9a-f]{16}$")
        self.assertEqual(self.query("SELECT count(*) FROM lines WHERE message_seq = 3")[0][0], 20000)

    def test_external_writer_refreshes_cache(self):
        self.run_req(history(1))
        conn = sqlite3.connect(self.path())
        conn.execute("UPDATE messages SET in_context = 0 WHERE seq = 2")
        conn.commit()
        conn.close()
        self.run_req(history(1))
        self.assertEqual(self.query("SELECT in_context FROM messages WHERE seq = 2"), [(1,)])

    def test_deleted_database_is_recreated(self):
        self.run_req(history(1))
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(f"{self.path()}{suffix}")
            except FileNotFoundError:
                pass
        self.run_req(history(1))
        self.assertEqual(self.query("SELECT count(*) FROM messages")[0][0], 4)


class FailOpenTests(DbBase):
    def test_database_error_logs_and_request_still_trims(self):
        (self.ctx / "sessions" / f"{SID}.db").mkdir(parents=True)
        err = io.StringIO()
        with redirect_stderr(err):
            out = self.run_req(history(3), trim_at_tokens=1)
        self.assertTrue(out["messages"][1]["content"][0]["text"].startswith("[openmem: continuing session"))
        self.assertEqual(err.getvalue().count("openmem-context: fail-open"), 1)
        self.assertNotIn("question", err.getvalue())

    def test_newer_schema_is_left_alone(self):
        (self.ctx / "sessions").mkdir(parents=True)
        conn = sqlite3.connect(self.path())
        conn.execute("PRAGMA user_version = 99")
        conn.close()
        err = io.StringIO()
        with redirect_stderr(err):
            out = self.run_req(history(1))
        self.assertEqual(len(out["messages"]), 4)
        self.assertIn("UnsupportedSchema", err.getvalue())
        self.assertEqual(self.query("PRAGMA user_version")[0][0], 99)


class TtlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "context"
        (self.root / "sessions").mkdir(parents=True)

    def touch(self, name, age_days):
        path = self.root / "sessions" / name
        path.write_text("x")
        t = time.time() - age_days * 86400
        os.utime(path, (t, t))
        return path

    def test_sweep_groups_by_session_and_keeps_recent(self):
        for name in ("old.db", "old.db-wal", "old.db-shm", "old.json", "old.trim.json", "old.log.jsonl", "old.force"):
            self.touch(name, 40)
        self.touch("mixed.db", 40)
        self.touch("mixed.db-wal", 1)
        self.touch("new.json", 2)
        self.touch(".hidden.tmp", 90)
        self.touch("notes.txt", 90)
        self.assertEqual(ttl.sweep(self.root, 30), ["old"])
        left = sorted(p.name for p in (self.root / "sessions").iterdir())
        self.assertEqual(left, [".hidden.tmp", "mixed.db", "mixed.db-wal", "new.json", "notes.txt"])

    def test_zero_keeps_everything_and_stamp_limits_to_daily(self):
        self.touch("a.db", 40)
        self.assertEqual(ttl.maybe_sweep(self.root, 0), [])
        self.assertTrue((self.root / "sessions" / "a.db").exists())
        self.assertEqual(ttl.maybe_sweep(self.root, 30), ["a"])
        self.touch("b.db", 40)
        self.assertEqual(ttl.maybe_sweep(self.root, 30), [])
        self.assertTrue((self.root / "sessions" / "b.db").exists())
        self.assertEqual(ttl.maybe_sweep(self.root, 30, now=time.time() + 86401), ["b"])

    def test_startup_runs_in_background(self):
        self.touch("a.db", 40)
        startup(Settings(context_dir=self.root, ttl_days=30)).join(5)
        self.assertFalse((self.root / "sessions" / "a.db").exists())

    def test_settings_from_env(self):
        s = Settings.from_env({})
        self.assertEqual((s.ttl_days, s.embedding_model, s.embedding_url), (30, "", "http://127.0.0.1:11434/v1"))
        s = Settings.from_env({"CONTEXT_STORE_TTL_DAYS": "0", "CONTEXT_EMBEDDING_MODEL": " nomic-embed-text ",
                               "CONTEXT_EMBEDDING_URL": "http://x:1/v1/", "CONTEXT_EMBEDDING_API_KEY": "k"})
        self.assertEqual((s.ttl_days, s.embedding_model, s.embedding_url, s.embedding_api_key),
                         (0, "nomic-embed-text", "http://x:1/v1", "k"))


def fake_embed(url, model, key, texts):
    # Deterministic 3-d vectors: counts of "a", "b" and other characters.
    return [[float(t.count("a")), float(t.count("b")), float(len(t) - t.count("a") - t.count("b"))] for t in texts]


class EmbeddingTests(DbBase):
    def test_vectors_stored_off_request_path_and_nearest(self):
        embedder = embed_mod.Embedder(embed=fake_embed)
        original = embed_mod.embedder
        embed_mod.embedder = embedder
        self.addCleanup(setattr, embed_mod, "embedder", original)
        msgs = [{"role": "user", "content": "aaaa"}, {"role": "assistant", "content": "bbbb"},
                {"role": "user", "content": "aab"}]
        self.run_req(msgs, embedding_model="fake", embedding_url="http://unused")
        embedder.drain()
        rows = self.query("SELECT message_seq, model, dim FROM vectors ORDER BY message_seq")
        self.assertEqual(rows, [(1, "fake", 3), (2, "fake", 3), (3, "fake", 3)])
        conn = sqlite3.connect(self.path())
        try:
            near = sessiondb.nearest(conn, [1.0, 0.0, 0.0], "fake", 2)
        finally:
            conn.close()
        self.assertEqual([seq for seq, _ in near], [1, 3])
        self.assertAlmostEqual(near[0][1], 1.0, places=5)

    def test_embedding_failure_is_logged_and_retried_later(self):
        calls = []

        def broken(*a):
            calls.append(a)
            raise OSError("down")
        embedder = embed_mod.Embedder(embed=broken)
        self.run_req(history(1))
        err = io.StringIO()
        with redirect_stderr(err):
            embedder.notify(self.path(), "m", "http://x")
            embedder.drain()
            embedder.notify(self.path(), "m", "http://x")
            embedder.drain()
        self.assertEqual(len(calls), 1)
        self.assertIn("openmem-context: embedding failed OSError", err.getvalue())
        self.assertEqual(self.query("SELECT count(*) FROM vectors")[0][0], 0)

    def test_embedding_off_by_default(self):
        self.assertEqual(Settings().embedding_model, "")
        self.run_req(history(1))
        self.assertEqual(self.query("SELECT count(*) FROM vectors")[0][0], 0)


if __name__ == "__main__":
    unittest.main()
