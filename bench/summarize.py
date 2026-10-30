"""Summarize ContextBench pilot results: one row per (arm, task), Markdown to stdout.

    python summarize.py results/            # also writes results/<arm>/usage.csv
    python summarize.py results-strict/ state-strict/   # state root other than <results>/../state

Sources per arm directory results/<arm>/:
  usage.jsonl                      bench proxy rows (usage_logger.py), one per upstream request: primary
                                   token source; it also sees Claude Code's compaction-summary requests
  trials/<arm>.<task>/result.json  Harbor TrialResult: verifier rewards, agent_execution timing
  trials/.../agent/cc_stream.json  session id, compact_boundary list, terminated_by (cc_stream.py)
  trials/.../agent/cc-turn-*.jsonl stream-json per `claude -p`: cross-check (main-loop requests only)
  ../../state/<arm>/context/sessions/<sid>.log.jsonl  OpenMem trim log: one distinct ts per trim event

Prices: pricing.md (platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-29), Claude Haiku 5.5,
$/MTok (input, 5m cache write, 1h cache write, cache read, output). A request whose prompt
(input + cache reads + cache writes) is over 100,000 tokens pays the higher row for all its tokens.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

TIER_AT = 100_000
RATE_LIMIT_RE = re.compile(r"\b429\b|rate.?limit|overloaded|\b529\b", re.I)
SEARCH_TOOL, GET_TOOL = "mcp__openmem__smart_compact_search", "mcp__openmem__smart_compact_get"
PRICE = {False: (0.10, 0.125, 0.20, 0.01, 0.50), True: (0.50, 0.625, 1.00, 0.05, 2.50)}
CSV_FIELDS = ("ts", "arm", "arm_header", "session", "model", "ok", "input", "cache_read", "cache_write",
              "cache_write_1h", "output", "prompt", "long_tier", "usd", "trimmed", "n_compressed",
              "n_messages", "latency_s", "source")


def request_cost(inp: int, cr: int, cw: int, out: int, cw_1h: int = 0) -> tuple[float, bool]:
    prompt = inp + cr + cw
    long = prompt > TIER_AT
    p_in, p_w5, p_w1, p_cr, p_out = PRICE[long]
    cw_1h = min(cw_1h, cw)
    usd = (inp * p_in + (cw - cw_1h) * p_w5 + cw_1h * p_w1 + cr * p_cr + out * p_out) / 1e6
    return usd, long


def _jsonl(path: Path) -> list[dict]:
    rows = []
    if path.is_file():
        for line in path.read_text(errors="replace").splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def _ts(value) -> float | None:
    if not value:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()


def priced(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        if not r.get("ok"):
            out.append({**r, "usd": 0.0, "prompt": 0, "long_tier": False})
            continue
        n = {k: int(r.get(k) or 0) for k in ("input", "cache_read", "cache_write", "cache_write_1h", "output")}
        usd, long = request_cost(n["input"], n["cache_read"], n["cache_write"], n["output"], n["cache_write_1h"])
        out.append({**r, **n, "usd": usd, "long_tier": long,
                    "prompt": n["input"] + n["cache_read"] + n["cache_write"]})
    return out


def stream_crosscheck(agent_dir: Path) -> dict:
    """Main-loop requests seen in stream-json (deduplicated message ids) and their list-price cost."""
    sys.path.insert(0, str(Path(__file__).parent))
    from cc_stream import parse_stream

    reqs, usd, out_tokens, cost_cc = 0, 0.0, 0, None
    for f in sorted(agent_dir.glob("cc-turn-*.jsonl")):
        log = parse_stream(f.read_text(errors="replace"))
        turn_out = int(((log.result or {}).get("usage") or {}).get("output_tokens") or 0)
        out_tokens += turn_out
        for s in log.steps:
            reqs += 1
            c, _ = request_cost(int(s.get("input_tokens") or 0), int(s.get("cache_read_input_tokens") or 0),
                                int(s.get("cache_creation_input_tokens") or 0), 0)
            usd += c
        if log.result and log.result.get("total_cost_usd") is not None:
            cost_cc = float(log.result["total_cost_usd"])  # cumulative across resumes (v2.1.277+)
    return {"cc_reqs": reqs, "cc_usd_in": usd, "cc_out": out_tokens, "cc_total_cost_usd": cost_cc}


def trim_events(state_dir: Path, sid: str | None) -> int | None:
    if not sid:
        return None
    rows = _jsonl(state_dir / "context" / "sessions" / f"{sid}.log.jsonl")
    return len({r.get("ts") for r in rows})


def _tool_uses(agent_dir: Path, meta: dict) -> dict:
    if meta.get("tool_uses") is not None:
        return dict(meta["tool_uses"])
    from cc_stream import parse_stream

    out: dict = {}
    for f in sorted(agent_dir.glob("cc-turn-*.jsonl")):
        for t in parse_stream(f.read_text(errors="replace")).tool_uses:
            out[t] = out.get(t, 0) + 1
    return out


TASKS_DIR = Path(__file__).parent / "cb" / "tasks"
TAG_RE = re.compile(r"\s+#[0-9a-f]+$")


def answer_check(agent_dir: Path, task: str) -> dict:
    """kv-store only: exact matches vs matches once the trailing `#<hex>` tag is dropped from gold.

    A trial with exact < notag answered from memory but not verbatim (format failure, not a recall
    failure). Other families: {}.
    """
    gold_p = TASKS_DIR / task / "tests" / "gold.json"
    if not task.startswith("kv-store") or not gold_p.is_file():
        return {}
    from cc_stream import parse_stream
    from contextbench.graders.kv import ANSWER_RE

    gold = {q["key"]: q["value"] for q in json.loads(gold_p.read_text())["queries"]}
    text = "\n".join(parse_stream(f.read_text(errors="replace")).reply
                     for f in sorted(agent_dir.glob("cc-turn-*.jsonl")))
    ans = {k: v.strip() for k, v in ANSWER_RE.findall(text)}
    return {"kv_exact": sum(ans.get(k) == v for k, v in gold.items()),
            "kv_notag": sum(ans.get(k) == TAG_RE.sub("", v) for k, v in gold.items())}


def flag(row: dict) -> str | None:
    total, answered = row.get("total"), row.get("answered")
    if row.get("kv_notag") is not None and row["kv_notag"] > (row.get("kv_exact") or 0):
        return f"format: #tag dropped ({row['kv_notag']}/{int(total or 0)} right without it)"
    if answered is not None and total and answered < total:
        zero = "reward 0, " if row.get("reward") == 0 else ""
        return f"{zero}only {int(answered)}/{int(total)} answered (rest declined or missing)"
    if row.get("exception"):
        return "exception"
    return None


def trial_rows(results: Path, state_root: Path | None = None, sub: str = "trials") -> list[dict]:
    out = []
    for arm_dir in sorted(p for p in results.iterdir() if p.is_dir() and (p / sub).is_dir()):
        arm = arm_dir.name
        usage = priced(_jsonl(arm_dir / "usage.jsonl"))
        if sub == "trials":
            with open(arm_dir / "usage.csv", "w", newline="") as fh:
                w = csv.DictWriter(fh, CSV_FIELDS, extrasaction="ignore")
                w.writeheader()
                w.writerows(usage)
        state_dir = (state_root or results.parent / "state") / arm
        for tdir in sorted(p for p in (arm_dir / sub).iterdir() if (p / "result.json").is_file()):
            res = json.loads((tdir / "result.json").read_text())
            meta_path = tdir / "agent" / "cc_stream.json"
            meta = json.loads(meta_path.read_text()) if meta_path.is_file() else {}
            sid = meta.get("session_id")
            ex = res.get("agent_execution") or {}
            t0, t1 = _ts(ex.get("started_at")), _ts(ex.get("finished_at"))
            mine = [r for r in usage if sid and r.get("session") == sid]
            if not mine and t0 and t1:  # header missing: fall back to the agent's time window
                mine = [r for r in usage if t0 <= float(r.get("ts") or 0) <= t1]
            ok = [r for r in mine if r.get("ok")]
            rewards = ((res.get("verifier_result") or {}).get("rewards") or {})
            total_t0, total_t1 = _ts(res.get("started_at")), _ts(res.get("finished_at"))
            tools = _tool_uses(tdir / "agent", meta)
            failed = [r for r in mine if not r.get("ok")]
            row = {
                "arm": arm, "task": res.get("task_name") or tdir.name.split(".", 1)[-1],
                "reward": rewards.get("reward"), "answered": rewards.get("n_answered"),
                "matched": rewards.get("matched"), "total": rewards.get("total"),
                "r_lookup": rewards.get("reward_lookup"), "r_count": rewards.get("reward_count"),
                "n_ops": f"{meta.get('n_ops_delivered')}/{meta.get('n_ops_total')}",
                "terminated_by": meta.get("terminated_by"),
                "requests": len(ok), "errors": len(mine) - len(ok),
                "input": sum(r["input"] for r in ok), "cache_read": sum(r["cache_read"] for r in ok),
                "cache_write": sum(r["cache_write"] for r in ok), "output": sum(r["output"] for r in ok),
                "long_reqs": sum(1 for r in ok if r["long_tier"]),
                "peak_prompt": max((r["prompt"] for r in ok), default=0),
                "mean_latency_s": (sum(float(r.get("latency_s") or 0) for r in ok) / len(ok)) if ok else None,
                "usd": sum(r["usd"] for r in ok),
                "agent_wall_s": (t1 - t0) if t0 and t1 else None,
                "trial_wall_s": (total_t1 - total_t0) if total_t0 and total_t1 else None,
                "compactions": len(meta.get("compactions") or []),
                "compact_pre_tokens": [c.get("pre_tokens") for c in meta.get("compactions") or []],
                "compact_post_tokens": [c.get("post_tokens") for c in meta.get("compactions") or []],
                "trim_events": trim_events(state_dir, sid),
                "trimmed_reqs": sum(1 for r in ok if r.get("trimmed")),
                "compressed_reqs": sum(1 for r in ok if r.get("n_compressed")),
                "max_compressed": max((int(r.get("n_compressed") or 0) for r in ok), default=0),
                "sc_search": tools.get(SEARCH_TOOL, 0), "sc_get": tools.get(GET_TOOL, 0),
                "other_tools": sum(v for k, v in tools.items() if k not in (SEARCH_TOOL, GET_TOOL)),
                "rate_limit_errors": sum(1 for r in failed if RATE_LIMIT_RE.search(str(r.get("error") or ""))),
                "cc_retry_events": len(meta.get("retry_events") or []),
                "cc_version": meta.get("claude_code_version"),
                "exception": (res.get("exception_info") or {}).get("exception_type"),
                **stream_crosscheck(tdir / "agent"),
            }
            row.update(answer_check(tdir / "agent", row["task"]))
            row["trial"] = tdir.name
            row["flag"] = flag(row)
            # tag-insensitive score: kv answers count when right except the dropped `#<hex>` tag
            if row.get("kv_notag") is not None and row.get("total"):
                row["reward_lenient"] = max(row["kv_exact"], row["kv_notag"]) / row["total"]
            else:
                row["reward_lenient"] = row.get("reward")
            out.append(row)
    return out


def _fmt(v, nd=0):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    if isinstance(v, list):
        return ",".join(str(x) for x in v) or "-"
    return str(v)


MEAN_COLS = ("reward", "reward_lenient", "matched", "total", "requests", "input", "cache_read", "cache_write", "output",
             "long_reqs", "peak_prompt", "usd", "agent_wall_s", "mean_latency_s", "compactions", "trim_events", "compressed_reqs",
             "sc_search", "sc_get", "rate_limit_errors", "cc_retry_events", "errors")


def arm_means(rows: list[dict]) -> list[dict]:
    out = []
    for arm in sorted({r["arm"] for r in rows}):
        mine = [r for r in rows if r["arm"] == arm]
        m = {"arm": arm, "n": len(mine), "exceptions": sum(1 for r in mine if r.get("exception"))}
        for c in MEAN_COLS:
            vals = [float(r[c]) for r in mine if isinstance(r.get(c), (int, float))]
            m[c] = sum(vals) / len(vals) if vals else None
        m["usd_total"] = sum(float(r.get("usd") or 0) for r in mine)
        n_req = sum(int(r.get("requests") or 0) for r in mine if r.get("mean_latency_s") is not None)
        m["mean_latency_s"] = (sum(float(r["mean_latency_s"]) * int(r.get("requests") or 0) for r in mine
                                   if r.get("mean_latency_s") is not None) / n_req) if n_req else None
        out.append(m)
    return out


def _table(rows: list[dict], cols: list[tuple]) -> str:
    lines = ["| " + " | ".join(c for c, _ in cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        lines.append("| " + " | ".join(_fmt(r.get(c), nd or 0) for c, nd in cols) + " |")
    return "\n".join(lines)


STRICT_COLS = [("arm", None), ("task", None), ("reward", 3), ("reward_lenient", 3), ("matched", 0), ("total", 0), ("answered", 0),
               ("kv_notag", None), ("r_lookup", 3), ("r_count", 3), ("n_ops", None),
               ("requests", None), ("input", None), ("cache_read", None), ("cache_write", None), ("output", None),
               ("long_reqs", None), ("peak_prompt", None), ("usd", 4), ("agent_wall_s", 0), ("mean_latency_s", 2),
               ("compactions", None), ("compact_pre_tokens", None), ("compact_post_tokens", None), ("trim_events", None),
               ("trimmed_reqs", None), ("compressed_reqs", None), ("sc_search", None), ("sc_get", None),
               ("other_tools", None), ("rate_limit_errors", None), ("cc_retry_events", None), ("errors", None),
               ("terminated_by", None), ("exception", None), ("flag", None)]
MEAN_TABLE_COLS = [("arm", None), ("n", None), ("reward", 3), ("reward_lenient", 3), ("matched", 1), ("total", 1), ("requests", 1),
                   ("input", 0), ("cache_read", 0), ("cache_write", 0), ("output", 0), ("long_reqs", 1),
                   ("peak_prompt", 0), ("usd", 4), ("usd_total", 4), ("agent_wall_s", 0), ("mean_latency_s", 2), ("compactions", 2),
                   ("trim_events", 2), ("compressed_reqs", 2), ("sc_search", 2), ("sc_get", 2),
                   ("rate_limit_errors", 2), ("cc_retry_events", 2), ("exceptions", None)]


def strict_markdown(rows: list[dict], invalid: list[dict] | None = None) -> str:
    md = ("## Per-arm means (per trial)\n\n" + _table(arm_means(rows), MEAN_TABLE_COLS)
          + "\n\n## Per task\n\n" + _table(rows, STRICT_COLS))
    if invalid:
        md += ("\n\n## Invalidated trials (excluded from the means; see flag)\n\n"
               + _table(invalid, STRICT_COLS))
    return md


def markdown(rows: list[dict]) -> str:
    cols = [("arm", None), ("task", None), ("reward", 3), ("requests", None), ("input", None),
            ("cache_read", None), ("cache_write", None), ("output", None), ("long_reqs", None),
            ("peak_prompt", None), ("usd", 4), ("agent_wall_s", 0), ("compactions", None),
            ("compact_pre_tokens", None), ("trim_events", None), ("compressed_reqs", None),
            ("terminated_by", None), ("cc_reqs", None), ("cc_total_cost_usd", 4), ("exception", None)]
    lines = ["| " + " | ".join(c for c, _ in cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        lines.append("| " + " | ".join(_fmt(r.get(c), nd or 0) for c, nd in cols) + " |")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    results = Path(argv[1] if len(argv) > 1 else Path(__file__).parent / "results")
    if not results.is_dir():
        print(f"no results directory {results}", file=sys.stderr)
        return 1
    state_root = Path(argv[2]) if len(argv) > 2 else None
    rows = trial_rows(results, state_root)
    invalid = trial_rows(results, state_root, sub="invalid") if state_root else []
    print(strict_markdown(rows, invalid) if state_root else markdown(rows))
    print("\nusd: list price from proxy usage rows, per-request Haiku 5.5 tier (>100k prompt). "
          "cc_reqs / cc_total_cost_usd: Claude Code's own stream-json view (main loop only; "
          "cost is Claude Code's client-side estimate).")
    (results / "summary.json").write_text(json.dumps(rows, indent=2, default=str) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
