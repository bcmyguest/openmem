"""summarize.py on a synthetic results tree (no model, no Docker)."""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import pytest

import summarize

FIX = Path(__file__).parent / "fixtures"
SID = "11111111-2222-4333-8444-555555555555"


def test_request_cost_tiers():
    # 100,000-token prompt stays on the low tier; one more token moves every token to the high tier
    low, is_long = summarize.request_cost(0, 100_000, 0, 1000)
    assert not is_long and low == pytest.approx((100_000 * 0.01 + 1000 * 0.50) / 1e6)
    high, is_long = summarize.request_cost(1, 100_000, 0, 1000)
    assert is_long and high == pytest.approx((1 * 0.50 + 100_000 * 0.05 + 1000 * 2.50) / 1e6)
    w, _ = summarize.request_cost(0, 0, 1000, 0, cw_1h=400)
    assert w == pytest.approx((600 * 0.125 + 400 * 0.20) / 1e6)


def _tree(tmp_path: Path) -> Path:
    results = tmp_path / "results"
    arm = results / "a3b-trim"
    agent = arm / "trials" / "a3b-trim.kv-store-R2000-seed42" / "agent"
    agent.mkdir(parents=True)
    shutil.copyfile(FIX / "turn_set.jsonl", agent / "cc-turn-0000.jsonl")
    (agent / "cc_stream.json").write_text(json.dumps({
        "session_id": SID, "claude_code_version": "2.1.300", "terminated_by": "stream_exhausted",
        "compactions": [{"trigger": "auto", "pre_tokens": 120345}]}))
    (agent.parent / "result.json").write_text(json.dumps({
        "task_name": "kv-store-R2000-seed42", "started_at": "2026-10-29T10:00:00Z",
        "finished_at": "2026-10-29T10:10:00Z",
        "agent_execution": {"started_at": "2026-10-29T10:01:00Z", "finished_at": "2026-10-29T10:09:00Z"},
        "verifier_result": {"rewards": {"reward": 0.75, "n_answered": 24.0}}}))
    rows = [
        {"ts": 1.0, "ok": True, "arm": "a3b-trim", "session": SID, "input": 10, "cache_read": 0,
         "cache_write": 9000, "output": 50, "trimmed": False, "n_compressed": 0},
        {"ts": 2.0, "ok": True, "arm": "a3b-trim", "session": SID, "input": 5, "cache_read": 110000,
         "cache_write": 100, "output": 20, "trimmed": True, "n_compressed": 2},
        {"ts": 3.0, "ok": False, "arm": "a3b-trim", "session": SID, "error": "boom"},
        {"ts": 4.0, "ok": True, "arm": "a3b-trim", "session": "other", "input": 1, "cache_read": 0,
         "cache_write": 0, "output": 1},
    ]
    (arm / "usage.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    log = tmp_path / "state" / "a3b-trim" / "context" / "sessions"
    log.mkdir(parents=True)
    (log / f"{SID}.log.jsonl").write_text(
        "".join(json.dumps({"seq": i, "ts": ts, "text": "x"}) + "\n"
                for i, ts in enumerate(["2026-10-29T10:03:00Z"] * 3 + ["2026-10-29T10:06:00Z"] * 2)))
    return results


def test_trial_rows(tmp_path):
    results = _tree(tmp_path)
    [row] = summarize.trial_rows(results)
    assert row["arm"] == "a3b-trim" and row["task"] == "kv-store-R2000-seed42" and row["reward"] == 0.75
    assert row["requests"] == 2 and row["errors"] == 1  # the "other" session is excluded
    assert (row["input"], row["cache_read"], row["cache_write"], row["output"]) == (15, 110000, 9100, 70)
    assert row["long_reqs"] == 1 and row["peak_prompt"] == 110105
    want = summarize.request_cost(10, 0, 9000, 50)[0] + summarize.request_cost(5, 110000, 100, 20)[0]
    assert row["usd"] == pytest.approx(want)
    assert row["agent_wall_s"] == 480 and row["trial_wall_s"] == 600
    assert row["compactions"] == 1 and row["compact_pre_tokens"] == [120345]
    assert row["trim_events"] == 2 and row["trimmed_reqs"] == 1 and row["compressed_reqs"] == 1
    assert row["cc_reqs"] == 3 and row["cc_out"] == 57 and row["cc_total_cost_usd"] == 0.0021
    with open(results / "a3b-trim" / "usage.csv") as fh:
        assert len(list(csv.DictReader(fh))) == 4
    md = summarize.markdown([row])
    assert md.splitlines()[0].startswith("| arm | task | reward | requests |")


def test_strict_columns_and_means(tmp_path):
    results = _tree(tmp_path)
    agent = results / "a3b-trim" / "trials" / "a3b-trim.kv-store-R2000-seed42" / "agent"
    meta = json.loads((agent / "cc_stream.json").read_text())
    meta.update({"tool_uses": {summarize.SEARCH_TOOL: 3, summarize.GET_TOOL: 1},
                 "retry_events": [{"subtype": "api_retry"}], "n_ops_delivered": 64, "n_ops_total": 64})
    meta["compactions"][0]["post_tokens"] = 8800
    (agent / "cc_stream.json").write_text(json.dumps(meta))
    with open(results / "a3b-trim" / "usage.jsonl", "a") as fh:
        fh.write(json.dumps({"ts": 5.0, "ok": False, "session": SID, "error": "RateLimitError: 429 Too Many"}) + "\n")
    [row] = summarize.trial_rows(results, tmp_path / "state")
    assert (row["sc_search"], row["sc_get"], row["other_tools"]) == (3, 1, 0)
    assert row["rate_limit_errors"] == 1 and row["errors"] == 2 and row["cc_retry_events"] == 1
    assert row["compact_post_tokens"] == [8800] and row["n_ops"] == "64/64"
    [m] = summarize.arm_means([row, {**row, "reward": 0.25, "usd": 1.0}])
    assert m["n"] == 2 and m["reward"] == pytest.approx(0.5) and m["usd_total"] == pytest.approx(row["usd"] + 1.0)
    assert "## Per-arm means" in summarize.strict_markdown([row])
