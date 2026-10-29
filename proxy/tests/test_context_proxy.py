"""Unit tests for the dependency-free context-proxy core. Run: python3 -m unittest discover -s proxy/tests"""

import copy
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openmem_context import Settings, process_request  # noqa: E402
from openmem_context.compress import blob_id, compress_text  # noqa: E402
from openmem_context.core import pointer_text  # noqa: E402

SID = "sess-1"
BIG = 10_000_000  # threshold no request reaches


def headers(sid=SID):
    return {"proxy_server_request": {"headers": {"X-Claude-Code-Session-Id": sid}}}


def anth_history(turns, filler=200):
    """Anthropic history: each turn = user text, assistant tool_use, user tool_result, assistant text."""
    msgs = []
    for t in range(turns):
        msgs.append({"role": "user", "content": [{"type": "text", "text": f"question {t} " + "q" * filler}]})
        msgs.append({"role": "assistant", "content": [
            {"type": "thinking", "thinking": f"think {t}", "signature": f"SIG{t}=="},
            {"type": "tool_use", "id": f"tu{t}", "name": "Bash", "input": {"command": f"echo {t}"}},
        ]})
        msgs.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"tu{t}", "content": f"out {t} " + "o" * filler},
            {"type": "text", "text": "<system-reminder>note</system-reminder>"},
        ]})
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": f"answer {t}"}]})
    return msgs


def anth_request(msgs, sid=SID):
    return {"model": "claude", "system": [{"type": "text", "text": "SYSTEM"}], "tools": [{"name": "Bash"}],
            "messages": msgs, **headers(sid)}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ctx = Path(self.tmp.name) / "context"
        self.calls = []

    def settings(self, **kw):
        base = dict(trim_at_tokens=BIG, compress_over_tokens=0, compaction_max_chars=12000,
                    hindsight_url="http://hs.test", context_dir=self.ctx)
        base.update(kw)
        return Settings(**base)

    def http(self, method, url, body, timeout):
        self.calls.append((method, url, body))
        if url.endswith("/memories/recall"):
            return 200, {"results": [{"text": "remembered fact"}]}
        if "status=pending" in url:
            return 200, {"total": 1}
        return 200, {"total": 0}

    def ptr(self, dropped, sid=SID):
        return pointer_text(sid, dropped, self.ctx / "sessions" / f"{sid}.log.jsonl")

    def run_req(self, data, call_type="anthropic_messages", **kw):
        return process_request(data, call_type, self.settings(**kw), http=self.http)

    def log_rows(self, sid=SID):
        path = self.ctx / "sessions" / f"{sid}.log.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def force(self, sid=SID):
        (self.ctx / "sessions").mkdir(parents=True, exist_ok=True)
        (self.ctx / "sessions" / f"{sid}.force").write_text("")


class AnthropicTrimTests(Base):
    def test_below_threshold_unchanged(self):
        msgs = anth_history(3)
        data = anth_request(copy.deepcopy(msgs))
        out = self.run_req(data)
        self.assertEqual(out["messages"], msgs)
        self.assertFalse((self.ctx / "sessions" / f"{SID}.log.jsonl").exists())

    def test_cut_at_last_real_user_turn_and_pairs_kept(self):
        msgs = anth_history(3)
        # In-flight turn: user prompt + a tool loop still running.
        msgs += [{"role": "user", "content": "now this"},
                 {"role": "assistant", "content": [{"type": "tool_use", "id": "tuX", "name": "Read", "input": {}}]},
                 {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tuX", "content": "x"},
                                              {"type": "text", "text": "extra text beside a result"}]}]
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)
        kept = out["messages"]
        self.assertEqual(len(kept), 4)
        self.assertEqual(kept[0], msgs[0])
        self.assertEqual(kept[1]["content"], [{"type": "text", "text": self.ptr(11)},
                                              {"type": "text", "text": "now this"}])
        self.assertEqual(kept[2:], msgs[13:])
        self.assertEqual(out["system"], [{"type": "text", "text": "SYSTEM"}])
        self.assertEqual(out["tools"], [{"name": "Bash"}])

    def test_pointer_prepended_as_block_for_list_content(self):
        msgs = anth_history(3)
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)
        kept = out["messages"]
        self.assertEqual(kept[0], msgs[0])
        self.assertEqual(kept[1]["content"][0], {"type": "text", "text": self.ptr(7)})
        self.assertEqual(kept[1]["content"][1:], msgs[8]["content"])
        self.assertEqual(kept[2:], msgs[9:])

    def test_signed_thinking_kept_byte_identical(self):
        msgs = anth_history(2)
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)
        self.assertEqual(json.dumps(out["messages"][2:]), json.dumps(msgs[5:]))

    def test_single_turn_tool_loop_not_trimmed(self):
        msgs = anth_history(1)
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)
        self.assertEqual(out["messages"], msgs)

    def test_log_rows_shape_and_seq(self):
        self.run_req(anth_request(anth_history(3)), trim_at_tokens=1)
        rows = self.log_rows()
        self.assertEqual([r["seq"] for r in rows], list(range(len(rows))))
        self.assertEqual(set(rows[0]), {"seq", "ts", "role", "kind", "name", "text"})
        self.assertRegex(rows[0]["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        kinds = [(r["role"], r["kind"], r["name"]) for r in rows[:5]]
        # The first user turn is pinned, so the log starts with the reply to it.
        self.assertEqual(kinds, [("assistant", "thinking", None), ("assistant", "tool_use", "Bash"),
                                 ("tool", "tool_result", "Bash"), ("user", "text", None),
                                 ("assistant", "text", None)])
        self.assertEqual(rows[1]["text"], '{"command":"echo 0"}')
        self.assertNotIn("question 0", json.dumps(rows))
        self.assertNotIn("SIG", json.dumps(rows))
        mode = stat.S_IMODE(os.stat(self.ctx / "sessions" / f"{SID}.log.jsonl").st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.ctx / "sessions").st_mode), 0o700)

    def test_sticky_cut_byte_identical_and_grows_at_end(self):
        msgs = anth_history(3)
        first = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        n_rows = len(self.log_rows())
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": "more"}]})
        second = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=BIG)["messages"]
        self.assertEqual(json.dumps(second[:len(first)]), json.dumps(first))
        self.assertEqual(second[len(first):], msgs[-1:])
        # Still over the threshold but no newer user turn: the cut stays put.
        third = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(json.dumps(third), json.dumps(second))
        self.assertEqual(len(self.log_rows()), n_rows)

    def test_sticky_cut_survives_moving_cache_control(self):
        # Claude Code marks the newest message with cache_control; the marker moves on the next request.
        msgs = anth_history(3)
        msgs[0]["content"][0]["cache_control"] = {"type": "ephemeral"}
        msgs[8]["content"][0]["cache_control"] = {"type": "ephemeral"}
        self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)
        n_rows = len(self.log_rows())
        del msgs[0]["content"][0]["cache_control"]
        del msgs[8]["content"][0]["cache_control"]
        msgs[-1]["content"][0]["cache_control"] = {"type": "ephemeral"}
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(len(self.log_rows()), n_rows)
        self.assertEqual(out[0], msgs[0])
        self.assertEqual(out[1]["content"][0]["text"], self.ptr(7))
        self.assertEqual(out[2:], msgs[9:])

    def test_sticky_cut_survives_text_block_to_string_change(self):
        # Observed from Claude Code 2.1: the newest user turn is a cached text block, later a plain string.
        msgs = anth_history(2)
        msgs.append({"role": "user", "content": [
            {"type": "text", "text": "run it", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]})
        first = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        n_rows = len(self.log_rows())
        msgs[-1]["content"] = "run it"
        msgs += [{"role": "assistant", "content": [{"type": "tool_use", "id": "tuZ", "name": "Bash", "input": {}}]},
                 {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tuZ", "content": "ok"}]}]
        second = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(len(self.log_rows()), n_rows)
        self.assertEqual(first[1]["content"][0], second[1]["content"][0])
        self.assertEqual(second[1]["content"][1], {"type": "text", "text": "run it"})
        self.assertEqual(second[2:], msgs[-2:])

    def test_cut_moves_on_next_crossing_and_seq_continues(self):
        msgs = anth_history(3)
        self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)
        first_rows = self.log_rows()
        msgs += [{"role": "user", "content": "brand new question"},
                 {"role": "assistant", "content": [{"type": "text", "text": "reply"}]}]
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        rows = self.log_rows()
        self.assertEqual([r["seq"] for r in rows], list(range(len(rows))))
        self.assertEqual(rows[:len(first_rows)], first_rows)
        # Turn 2 moved out: user text, thinking, tool_use, tool_result, reminder text, answer text.
        self.assertEqual(len(rows) - len(first_rows), 6)
        self.assertEqual(rows[len(first_rows)]["text"], "question 2 " + "q" * 200)
        self.assertEqual(len(out), 3)
        self.assertEqual(out[0], msgs[0])
        self.assertEqual(out[1]["content"], [{"type": "text", "text": self.ptr(11)},
                                             {"type": "text", "text": "brand new question"}])

    def test_force_flag_trims_and_is_deleted(self):
        self.force()
        msgs = anth_history(2)
        out = self.run_req(anth_request(copy.deepcopy(msgs)))
        self.assertEqual(len(out["messages"]), 5)
        self.assertFalse((self.ctx / "sessions" / f"{SID}.force").exists())

    def test_force_flag_kept_when_nothing_to_trim(self):
        self.force()
        out = self.run_req(anth_request([{"role": "user", "content": "title please"}]))
        self.assertEqual(out["messages"], [{"role": "user", "content": "title please"}])
        self.assertTrue((self.ctx / "sessions" / f"{SID}.force").exists())

    def test_side_thread_does_not_reset_main_cut(self):
        main = anth_history(3)
        first = self.run_req(anth_request(copy.deepcopy(main)), trim_at_tokens=1)["messages"]
        self.run_req(anth_request([{"role": "user", "content": "subagent task"}]))
        again = self.run_req(anth_request(copy.deepcopy(main)))["messages"]
        self.assertEqual(json.dumps(again), json.dumps(first))

    def test_recall_once_per_cut_with_pending_line(self):
        reg = self.ctx / "sessions"
        reg.mkdir(parents=True)
        (reg / f"{SID}.json").write_text(json.dumps({"session_id": SID, "bank": "coding-agent::x"}))
        msgs = anth_history(3)
        first = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        note = first[1]["content"][0]["text"]
        self.assertIn("\n[openmem recall]\nremembered fact", note)
        self.assertIn("may not be in memory yet", note)
        recall_calls = [c for c in self.calls if c[1].endswith("/memories/recall")]
        self.assertEqual(len(recall_calls), 1)
        self.assertEqual(recall_calls[0][1], "http://hs.test/v1/default/banks/coding-agent%3A%3Ax/memories/recall")
        self.assertEqual(recall_calls[0][2]["budget"], "low")
        self.assertTrue(recall_calls[0][2]["query"].startswith("question 2"))
        self.calls.clear()
        again = self.run_req(anth_request(copy.deepcopy(msgs)))["messages"]
        self.assertEqual(self.calls, [])
        self.assertEqual(json.dumps(again), json.dumps(first))

    def test_recall_failure_still_trims(self):
        reg = self.ctx / "sessions"
        reg.mkdir(parents=True)
        (reg / f"{SID}.json").write_text(json.dumps({"bank": "b"}))

        def broken(*a):
            raise OSError("down")
        with redirect_stderr(io.StringIO()):
            out = process_request(anth_request(anth_history(3)), "anthropic_messages",
                                  self.settings(trim_at_tokens=1), http=broken)
        self.assertEqual(out["messages"][1]["content"][0]["text"], self.ptr(7))

    def test_recall_respects_max_chars(self):
        reg = self.ctx / "sessions"
        reg.mkdir(parents=True)
        (reg / f"{SID}.json").write_text(json.dumps({"bank": "b"}))
        out = process_request(anth_request(anth_history(3)), "anthropic_messages",
                              self.settings(trim_at_tokens=1, compaction_max_chars=5),
                              http=lambda m, u, b, t: (200, {"results": [{"text": "abcdefghij"}], "total": 0}))
        self.assertTrue(out["messages"][1]["content"][0]["text"].endswith("[openmem recall]\nabcde"))


class SessionIdTests(Base):
    def test_openmem_header_wins(self):
        data = {"messages": anth_history(2), "metadata": {"user_id": json.dumps({"session_id": "meta"})},
                "proxy_server_request": {"headers": {"X-OpenMem-Session-Id": "oc:1",
                                                     "x-claude-code-session-id": "cc"}}}
        self.run_req(data, trim_at_tokens=1)
        self.assertEqual([p.name for p in (self.ctx / "sessions").glob("*.log.jsonl")], ["oc_1.log.jsonl"])

    def test_claude_header_before_metadata(self):
        data = {"messages": anth_history(2), "metadata": {"user_id": json.dumps({"session_id": "meta"})},
                "proxy_server_request": {"headers": {"x-claude-code-session-id": "cc"}}}
        self.run_req(data, trim_at_tokens=1)
        self.assertEqual([p.name for p in (self.ctx / "sessions").glob("*.log.jsonl")], ["cc.log.jsonl"])

    def test_metadata_user_id_json(self):
        data = {"messages": anth_history(2), "metadata": {"user_id": json.dumps({"session_id": "a/b c"})}}
        self.run_req(data, trim_at_tokens=1)
        self.assertTrue((self.ctx / "sessions" / "a_b_c.log.jsonl").exists())

    def test_prompt_cache_key(self):
        data = {"input": [{"role": "user", "content": "x"}, {"role": "user", "content": "y"},
                          {"role": "user", "content": "z"}],
                "prompt_cache_key": "codex-1"}
        self.run_req(data, "aresponses", trim_at_tokens=1)
        self.assertTrue((self.ctx / "sessions" / "codex-1.log.jsonl").exists())

    def test_fingerprint_fallback(self):
        data = {"system": "S", "messages": anth_history(2)}
        out = self.run_req(data, trim_at_tokens=1)
        logs = list((self.ctx / "sessions").glob("fp-*.log.jsonl"))
        self.assertEqual(len(logs), 1)
        self.assertRegex(logs[0].name, r"^fp-[0-9a-f]{16}\.log\.jsonl$")
        self.assertIn("continuing session fp-", out["messages"][1]["content"][0]["text"])


def chat_history():
    return [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "ls", "arguments": "{\"a\": 1}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "files"},
        {"role": "assistant", "content": "done"},
        {"role": "user", "content": "second"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "cat", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c2", "content": "body"},
    ]


class ChatTests(Base):
    def test_cut_keeps_system_and_pairs(self):
        msgs = chat_history()
        out = self.run_req({"messages": copy.deepcopy(msgs), **headers()}, "acompletion", trim_at_tokens=1)
        kept = out["messages"]
        self.assertEqual(kept[:2], msgs[:2])
        self.assertEqual(kept[2]["content"], self.ptr(3) + "\n\nsecond")
        self.assertEqual(kept[3:], msgs[6:])
        rows = self.log_rows()
        self.assertEqual([(r["role"], r["kind"], r["name"], r["text"]) for r in rows], [
            ("assistant", "tool_use", "ls", '{"a":1}'),
            ("tool", "tool_result", "ls", "files"), ("assistant", "text", None, "done")])

    def test_compress_tool_message(self):
        msgs = chat_history()
        msgs[7]["content"] = "\n".join(str(i) for i in range(5000))
        out = self.run_req({"messages": msgs, **headers()}, "acompletion", compress_over_tokens=100)
        self.assertTrue(out["messages"][7]["content"].startswith("[openmem: tool result compressed,"))


def responses_history():
    return [
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "DEV"}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "first"}]},
        {"type": "reasoning", "id": "r1", "summary": [{"type": "summary_text", "text": "plan"}],
         "encrypted_content": "ENC"},
        {"type": "function_call", "call_id": "f1", "name": "shell", "arguments": "{\"cmd\":[\"ls\"]}"},
        {"type": "function_call_output", "call_id": "f1", "output": "a.txt"},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]},
        {"role": "user", "content": "second"},
        {"type": "function_call", "call_id": "f2", "name": "shell", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "f2", "output": "b.txt"},
    ]


class ResponsesTests(Base):
    def test_cut_keeps_developer_and_pairs(self):
        items = responses_history()
        out = self.run_req({"input": copy.deepcopy(items), "instructions": "I", **headers()}, "aresponses",
                           trim_at_tokens=1)
        kept = out["input"]
        self.assertEqual(kept[:2], items[:2])
        self.assertEqual(kept[2]["content"], self.ptr(4) + "\n\nsecond")
        self.assertEqual(kept[3:], items[7:])
        rows = self.log_rows()
        self.assertEqual([(r["role"], r["kind"], r["name"]) for r in rows], [
            ("assistant", "thinking", None), ("assistant", "tool_use", "shell"),
            ("tool", "tool_result", "shell"), ("assistant", "text", None)])
        self.assertNotIn("ENC", json.dumps(rows))

    def test_cut_skips_user_turn_that_splits_a_pair(self):
        items = responses_history()
        # A user message wedged between a call and its output must not become the cut.
        items.insert(8, {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "wedge"}]})
        out = self.run_req({"input": copy.deepcopy(items), **headers()}, "aresponses", trim_at_tokens=1)
        self.assertEqual(out["input"][2]["content"], self.ptr(4) + "\n\nsecond")

    def test_list_content_gets_input_text_block(self):
        items = responses_history()
        items[6] = {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "second"}]}
        out = self.run_req({"input": items, **headers()}, "aresponses", trim_at_tokens=1)
        self.assertEqual(out["input"][2]["content"][0], {"type": "input_text", "text": self.ptr(4)})

    def test_string_input_untouched(self):
        data = {"input": "hello", **headers()}
        self.assertEqual(self.run_req(data, "aresponses", trim_at_tokens=1)["input"], "hello")


class CompressionTests(Base):
    def test_pure_and_blob_id(self):
        text = "\n".join(f"line {i}" for i in range(10000))
        a = compress_text(text, 100)
        b = compress_text(text, 100)
        self.assertEqual(a, b)
        out, bid = a
        self.assertEqual(bid, blob_id(text))
        self.assertRegex(bid, r"^[0-9a-f]{16}$")
        first = out.split("\n", 1)[0]
        self.assertEqual(first, f'[openmem: tool result compressed, {(len(text) + 3) // 4} tokens — '
                                f'smart_compact_get(id="{bid}") returns the full text]')
        body = out.split("\n")[1:]
        self.assertEqual(body[:40], [f"line {i}" for i in range(40)])
        self.assertEqual(body[40], "…")
        self.assertEqual(body[41:], [f"line {i}" for i in range(9980, 10000)])

    def test_single_long_line_capped_by_chars(self):
        text = "x" * 50000
        out, _ = compress_text(text, 100)
        self.assertLess(len(out), 6200)

    def test_below_threshold_and_disabled(self):
        self.assertIsNone(compress_text("short", 100))
        self.assertIsNone(compress_text("x" * 50000, 0))

    def test_request_compression_writes_blob_and_is_stable(self):
        big = "\n".join(str(i) for i in range(20000))
        msgs = anth_history(1)
        msgs[2]["content"][0]["content"] = big
        out1 = self.run_req(anth_request(copy.deepcopy(msgs)), compress_over_tokens=4000)
        out2 = self.run_req(anth_request(copy.deepcopy(msgs)), compress_over_tokens=4000)
        self.assertEqual(json.dumps(out1["messages"]), json.dumps(out2["messages"]))
        res = out1["messages"][2]["content"][0]["content"]
        bid = blob_id(big)
        self.assertIn(f'smart_compact_get(id="{bid}")', res)
        blob = self.ctx / "blobs" / f"{bid}.txt"
        self.assertEqual(blob.read_text(), big)
        self.assertEqual(stat.S_IMODE(os.stat(blob).st_mode), 0o600)
        # User-authored text and the system prompt are never compressed.
        self.assertEqual(out1["messages"][0], msgs[0])

    def test_list_result_keeps_cache_control_and_skips_images(self):
        big = "y\n" * 40000
        msgs = [{"role": "user", "content": "hi"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "R", "input": {}}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t",
                     "content": [{"type": "text", "text": big, "cache_control": {"type": "ephemeral"}}]},
                    {"type": "tool_result", "tool_use_id": "t2",
                     "content": [{"type": "text", "text": big}, {"type": "image", "source": {}}]}]}]
        out = self.run_req(anth_request(copy.deepcopy(msgs)), compress_over_tokens=100)
        blocks = out["messages"][2]["content"]
        self.assertEqual(blocks[0]["content"][0]["cache_control"], {"type": "ephemeral"})
        self.assertTrue(blocks[0]["content"][0]["text"].startswith("[openmem: tool result compressed,"))
        self.assertEqual(blocks[1], msgs[2]["content"][1])

    def test_trimmed_compressed_result_logs_blob_reference(self):
        big = "\n".join(str(i) for i in range(20000))
        msgs = anth_history(2)
        msgs[2]["content"][0]["content"] = big
        self.run_req(anth_request(msgs), compress_over_tokens=100, trim_at_tokens=1)
        result_rows = [r for r in self.log_rows() if r["kind"] == "tool_result"]
        self.assertTrue(result_rows[0]["text"].startswith(f"[blob:{blob_id(big)}]\n0\n1\n"))

    def test_responses_output_compressed(self):
        items = responses_history()
        items[8]["output"] = "z" * 40000
        out = self.run_req({"input": items, **headers()}, "aresponses", compress_over_tokens=100)
        self.assertTrue(out["input"][8]["output"].startswith("[openmem: tool result compressed,"))


class FirstUserPinTests(Base):
    """T1: the first real user turn survives every trim verbatim, before the pointer, and is never logged."""

    def test_anthropic_first_user_pinned_and_sticky(self):
        msgs = anth_history(3)
        first = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(first[0], msgs[0])
        self.assertTrue(first[1]["content"][0]["text"].startswith("[openmem: continuing session"))
        rows = self.log_rows()
        self.assertFalse(any(r["text"].startswith("question 0") for r in rows))
        # Later requests: the same bytes for the pinned turn, the pointer turn and everything after.
        msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "nope", "content": "x"}]})
        later = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=BIG)["messages"]
        self.assertEqual(json.dumps(later[:len(first)]), json.dumps(first))
        # The cut moves; the first turn stays pinned and is still never logged.
        msgs[-1] = {"role": "user", "content": "follow-up"}
        moved = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(moved[0], msgs[0])
        self.assertEqual(moved[1]["content"][0]["text"], self.ptr(11))
        self.assertEqual(moved[1]["content"][1], {"type": "text", "text": "follow-up"})
        self.assertFalse(any(r["text"].startswith("question 0") for r in self.log_rows()))
        self.assertEqual([r["seq"] for r in self.log_rows()], list(range(len(self.log_rows()))))

    def test_anthropic_first_user_with_reminder_blocks_is_pinned(self):
        msgs = anth_history(2)
        msgs[0]["content"].insert(0, {"type": "text", "text": "<system-reminder>ctx</system-reminder>"})
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(out[0], msgs[0])

    def test_anthropic_first_user_is_in_flight_turn_unchanged(self):
        msgs = anth_history(1)
        msgs += [{"role": "assistant", "content": [{"type": "tool_use", "id": "tuY", "name": "Read", "input": {}}]},
                 {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tuY", "content": "y"}]}]
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(out, msgs)
        self.assertEqual(self.log_rows(), [])

    def test_anthropic_cut_still_never_splits_pairs(self):
        msgs = anth_history(2)
        # A steer message wedged between tool_use and tool_result must not become the cut.
        msgs += [{"role": "user", "content": "new task"},
                 {"role": "assistant", "content": [{"type": "tool_use", "id": "tuW", "name": "Read", "input": {}}]},
                 {"role": "user", "content": "steer"},
                 {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tuW", "content": "w"}]}]
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(out[0], msgs[0])
        self.assertEqual(out[1]["content"][1], {"type": "text", "text": "new task"})
        self.assertEqual(out[2:], msgs[9:])

    def test_nothing_droppable_besides_first_means_no_trim(self):
        msgs = [{"role": "user", "content": "task"}, {"role": "user", "content": "more"}]
        out = self.run_req(anth_request(copy.deepcopy(msgs)), trim_at_tokens=1)["messages"]
        self.assertEqual(out, msgs)

    def test_chat_first_user_pinned(self):
        msgs = chat_history()
        msgs += [{"role": "assistant", "content": "ok"}, {"role": "user", "content": "third"}]
        out = self.run_req({"messages": copy.deepcopy(msgs), **headers()}, "acompletion", trim_at_tokens=1)["messages"]
        self.assertEqual(out[:2], msgs[:2])
        self.assertEqual(out[2]["content"], self.ptr(7) + "\n\nthird")
        self.assertNotIn("first", [r["text"] for r in self.log_rows()])
        again = self.run_req({"messages": copy.deepcopy(msgs) + [{"role": "assistant", "content": "x"}], **headers()},
                             "acompletion", trim_at_tokens=BIG)["messages"]
        self.assertEqual(json.dumps(again[:len(out)]), json.dumps(out))

    def test_chat_first_user_after_assistant_greeting(self):
        msgs = [{"role": "system", "content": "SYS"}, {"role": "assistant", "content": "hello"},
                {"role": "user", "content": "task"}, {"role": "assistant", "content": "a"},
                {"role": "user", "content": "next"}]
        out = self.run_req({"messages": copy.deepcopy(msgs), **headers()}, "acompletion", trim_at_tokens=1)["messages"]
        self.assertEqual(out[:2], [msgs[0], msgs[2]])
        self.assertEqual(out[2]["content"], self.ptr(2) + "\n\nnext")
        self.assertEqual([r["text"] for r in self.log_rows()], ["hello", "a"])

    def test_chat_first_user_is_in_flight_unchanged(self):
        msgs = chat_history()[:5]
        out = self.run_req({"messages": copy.deepcopy(msgs), **headers()}, "acompletion", trim_at_tokens=1)["messages"]
        self.assertEqual(out, msgs)

    def test_responses_first_user_pinned(self):
        items = responses_history()
        out = self.run_req({"input": copy.deepcopy(items), **headers()}, "aresponses", trim_at_tokens=1)["input"]
        self.assertEqual(out[1], items[1])
        self.assertTrue(out[2]["content"].startswith(self.ptr(4)))
        self.assertNotIn("first", [r["text"] for r in self.log_rows()])
        self.assertEqual(self.run_req({"input": copy.deepcopy(items), **headers()}, "aresponses")["input"], out)

    def test_responses_first_user_is_in_flight_unchanged(self):
        items = responses_history()[:6]
        out = self.run_req({"input": copy.deepcopy(items), **headers()}, "aresponses", trim_at_tokens=1)["input"]
        self.assertEqual(out, items)


class ContractTests(Base):
    def test_sanitize_sid_contract(self):
        from openmem_context.store import InvalidSessionId, sanitize_sid
        self.assertEqual(sanitize_sid("  abc\n"), "abc")
        self.assertEqual(sanitize_sid("a/b c"), "a_b_c")
        self.assertEqual(sanitize_sid("ses/../x"), "ses_.._x")
        self.assertEqual(sanitize_sid(".."), "..")
        self.assertEqual(sanitize_sid("\u00a0x"), "_x")
        for bad in ("", "   ", "\t\n"):
            with self.assertRaises(InvalidSessionId):
                sanitize_sid(bad)

    def test_blank_header_falls_through_to_next_source(self):
        data = {"messages": anth_history(2),
                "proxy_server_request": {"headers": {"x-openmem-session-id": "  ", "x-claude-code-session-id": " cc "}}}
        self.run_req(data, trim_at_tokens=1)
        self.assertEqual([p.name for p in (self.ctx / "sessions").glob("*.log.jsonl")], ["cc.log.jsonl"])

    def test_registration_missing_raises(self):
        from openmem_context.store import RegistrationNotFound, Store
        store = Store(self.ctx)
        with self.assertRaises(RegistrationNotFound):
            store.registration("nobody")
        (self.ctx / "sessions").mkdir(parents=True)
        (self.ctx / "sessions" / "list.json").write_text("[]")
        with self.assertRaises(RegistrationNotFound):
            store.registration("list")

    def test_adapter_for_unknown_raises(self):
        from openmem_context.adapters import UnsupportedCallType, adapter_for
        with self.assertRaises(UnsupportedCallType):
            adapter_for("aembedding")

    def test_pointer_names_host_log_path(self):
        s = Settings.from_env({"OPENMEM_STATE_DIR": "/state", "OPENMEM_HOST_STATE_DIR": " /home/u/.local/share/openmem "})
        self.assertEqual(s.context_dir, Path("/state/context"))
        self.assertEqual(s.pointer_context_dir, Path("/home/u/.local/share/openmem/context"))
        self.assertEqual(Settings.from_env({"OPENMEM_STATE_DIR": " /state "}).pointer_context_dir, Path("/state/context"))
        out = process_request(anth_request(anth_history(2)), "anthropic_messages",
                              self.settings(trim_at_tokens=1, host_context_dir=Path("/host/context")), http=self.http)
        self.assertIn("the handoff log is /host/context/sessions/sess-1.log.jsonl (JSONL, one row per block).]",
                      out["messages"][1]["content"][0]["text"])


class SafetyTests(Base):
    def test_disabled_switch(self):
        msgs = anth_history(3)
        data = anth_request(copy.deepcopy(msgs))
        out = process_request(data, "anthropic_messages",
                              Settings(enabled=False, trim_at_tokens=1, compress_over_tokens=1, context_dir=self.ctx))
        self.assertEqual(out["messages"], msgs)
        self.assertFalse(self.ctx.exists())

    def test_disabled_from_env(self):
        self.assertFalse(Settings.from_env({"CONTEXT_PROXY_ENABLED": "0"}).enabled)
        s = Settings.from_env({"OPENMEM_STATE_DIR": "/state"})
        self.assertEqual(s.context_dir, Path("/state/context"))
        self.assertEqual((s.trim_at_tokens, s.compress_over_tokens, s.compaction_max_chars), (120000, 4000, 12000))

    def test_fail_open_on_error_returns_unmodified(self):
        blocker = Path(self.tmp.name) / "file"
        blocker.write_text("not a dir")
        msgs = anth_history(3)
        data = anth_request(copy.deepcopy(msgs))
        err = io.StringIO()
        with redirect_stderr(err):
            out = process_request(data, "anthropic_messages",
                                  Settings(trim_at_tokens=1, compress_over_tokens=0, context_dir=blocker / "ctx"))
        self.assertIs(out, data)
        self.assertEqual(out["messages"], msgs)
        line = err.getvalue()
        self.assertEqual(line.count("\n"), 1)
        self.assertIn("openmem-context: fail-open", line)
        self.assertNotIn("question", line)

    def test_unknown_call_type_untouched(self):
        data = anth_request(anth_history(3))
        before = copy.deepcopy(data)
        self.assertEqual(self.run_req(data, "aembedding", trim_at_tokens=1), before)


if __name__ == "__main__":
    unittest.main()
