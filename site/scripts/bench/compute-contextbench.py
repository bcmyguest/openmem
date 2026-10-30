"""Compute the published ContextBench and Compact-Bench numbers from raw result files.

    <bench>/.venv/bin/python site/scripts/bench/compute-contextbench.py <bench> [out.json]

<bench> is the benchmark working directory. The script imports its summarize.py (priced(), list
prices for Claude Haiku 5.5) and ctx_metrics.py (per-trial scores, reward_lenient, peak prompt,
run D trim requests), so it must run under the bench venv (ctx_metrics needs contextbench.graders).
Default output: site/src/data/contextbench.json. Every number in that file comes from here.

Inputs:
  results-B/{s1-none,s2-native}/trials/*      run B baselines (rate-limited/, harness-failed/,
                                               invalid/ are siblings of trials/ and never read)
  results-D/d-sqlite/trials/*                 run D, shipped design (invalid/ not read)
  results-*/<arm>/usage.jsonl                 per-request tokens and latency_s (bench proxy log)
  state-{B,D}/<arm>/context/sessions/         trim logs and session DBs (via ctx_metrics)
  compact-bench-openmem/results/full/          Compact-Bench; published only once task_report.json exists
"""
from __future__ import annotations

import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

SETTINGS = [  # (key, label, results dir, state dir, arm)
    ("s1", "Keep everything", "results-B", "state-B", "s1-none"),
    ("s2", "Native compaction", "results-B", "state-B", "s2-native"),
    ("smart", "OpenMem smart compaction", "results-D", "state-D", "d-sqlite"),
]
SIZES = {"kv": ["R1000", "R4000", "R16000"], "log": ["L1600", "L6400", "L12800"]}
# A native compaction is the request right before Claude Code's prompt drops: the next request of the
# session sends less than this share of its prompt (the post-compaction prompt is the summary plus a
# few preserved messages). The detected count is checked against cc_stream.json's compact_boundary list.
DROP_SHARE = 0.5
CB_METHODS = [("full", "Full history"), ("claude", "Claude Code summary"),
              ("codex", "Codex summary"), ("openmem", "OpenMem")]
OUT = Path(__file__).resolve().parents[2] / "src" / "data" / "contextbench.json"


def _ts(v):
    return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() if v else None


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.fmean(xs) if xs else None


def _dist(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    q = statistics.quantiles(xs, n=10, method="inclusive") if len(xs) > 1 else [xs[0]] * 9
    return {"n": len(xs), "mean": statistics.fmean(xs), "median": statistics.median(xs),
            "p10": q[0], "p90": q[8], "min": xs[0], "max": xs[-1]}


def _prompt(r):
    return int(r.get("input") or 0) + int(r.get("cache_read") or 0) + int(r.get("cache_write") or 0)


def trial_record(bench: Path, results: str, state: str, arm: str, name: str, ctx_metrics, summarize) -> dict:
    tdir = bench / results / arm / "trials" / name
    m = ctx_metrics.trial(bench / results, bench / state, arm, name)
    res = json.loads((tdir / "result.json").read_text())
    meta_p = tdir / "agent" / "cc_stream.json"
    meta = json.loads(meta_p.read_text()) if meta_p.is_file() else {}
    sid = meta.get("session_id")
    # the same rows ctx_metrics.trial uses (ok rows of this session, file order), priced
    rows = summarize.priced([r for r in summarize._jsonl(bench / results / arm / "usage.jsonl")
                             if sid and r.get("session") == sid and r.get("ok")])
    ex = res.get("agent_execution") or {}
    t0, t1 = _ts(ex.get("started_at")), _ts(ex.get("finished_at"))
    task = m["task"]
    fam = "kv" if task.startswith("kv-store") else "log"
    size = task.split("-")[2]
    rec = {"setting_arm": arm, "trial": name, "family": fam, "size": size, "seed": m["seed"],
           "reward": m["reward"], "reward_lenient": m["reward_lenient"], "tag_dropped": bool(m["format_fail"]),
           "lookup": m["r_lookup"], "count": m["r_count"], "terminated_by": m["terminated_by"],
           "exception": m["exception"], "peak_prompt": m["peak_prompt"], "requests": len(rows),
           "input": sum(r["input"] for r in rows), "cache_read": sum(r["cache_read"] for r in rows),
           "cache_write": sum(r["cache_write"] for r in rows), "output": sum(r["output"] for r in rows),
           "usd": sum(r["usd"] for r in rows), "agent_wall_s": (t1 - t0) if t0 and t1 else None,
           "latencies": [float(r["latency_s"]) for r in rows if r.get("latency_s") is not None],
           "native_compactions": len(meta.get("compactions") or []),
           "cc_compaction_ms": [c.get("duration_ms") for c in meta.get("compactions") or []],
           "trims": m["trim_events"]}
    rec["total_tokens"] = rec["input"] + rec["cache_read"] + rec["cache_write"] + rec["output"]
    # native summary requests: the prompt of the next request falls below DROP_SHARE of this one
    rec["summary_idx"] = [i for i in range(len(rows) - 1) if _prompt(rows[i + 1]) < DROP_SHARE * _prompt(rows[i])]
    rec["trim_idx"] = list(m.get("trim_reqs") or []) if arm.startswith("d-") else []
    rec["_lat"] = [float(r.get("latency_s") or 0) for r in rows]
    return rec


def cell_summary(trials: list[dict]) -> dict:
    out = {"n": len(trials), "seeds": sorted(t["seed"] for t in trials)}
    if not trials:
        return out
    out.update({
        "score": _mean(t["reward_lenient"] for t in trials),
        "reward_strict": _mean(t["reward"] for t in trials),
        "tag_dropped_seeds": sorted(t["seed"] for t in trials if t["tag_dropped"]),
        "peak_prompt_mean": _mean(t["peak_prompt"] for t in trials),
        "peak_prompt_max": max(t["peak_prompt"] for t in trials),
        "tokens": {k: _mean(t[k] for t in trials) for k in
                   ("input", "cache_read", "cache_write", "output", "total_tokens")},
        "usd": _mean(t["usd"] for t in trials),
        "agent_wall_s": _mean(t["agent_wall_s"] for t in trials),
        "requests": _mean(t["requests"] for t in trials),
        "native_compactions": _mean(t["native_compactions"] for t in trials),
        "trims": _mean(t["trims"] for t in trials),
        "terminated_by": sorted({str(t["terminated_by"]) for t in trials}),
    })
    if trials[0]["family"] == "log":
        out["lookup"] = _mean(t["lookup"] for t in trials)
        out["count"] = _mean(t["count"] for t in trials)
    return out


def compact_bench(bench: Path) -> dict:
    full = bench / "compact-bench-openmem" / "results" / "full"
    report = full / "task_report.json"
    base = {"source": "compact-bench-openmem/results/full", "methods": [{"key": k, "label": v} for k, v in CB_METHODS]}
    if not report.is_file():  # run not finished: publish no partial numbers
        return {**base, "status": "pending"}
    rep = json.loads(report.read_text())
    methods = []
    for key, label in CB_METHODS:
        if key == "full":  # PRE: the full frozen history, no compaction
            files = sorted(full.glob("*__baseline.json"))
            recs = [json.loads(f.read_text()) for f in files]
            row = {"key": key, "label": label, "n": len(recs), "pass": sum(1 for r in recs if r.get("pre_pass"))}
        else:
            got = (rep.get("models") or {}).get(key)
            if got is None:
                continue
            files = sorted(full.glob(f"*__xb-{key}.cbo*.json"))
            recs = [json.loads(f.read_text()) for f in files]
            row = {"key": key, "label": label,
                   **{k: got.get(k) for k in ("preserved", "damaged", "rescued", "unsolved", "pre_pass_n")}}
        cc = [r.get("cc") or {} for r in recs]
        row["cost_usd_mean"] = _mean([(r.get("continuation_cost_usd") or 0) + (r.get("summary_cost_usd") or 0)
                                      for r in recs])
        row["continuation_s_mean"] = _mean([c["duration_ms"] / 1000 for c in cc if c.get("duration_ms") is not None])
        row["files"] = len(recs)
        methods.append(row)
    return {**base, "status": "complete", "baseline_count": rep.get("baseline_count"), "methods": methods}


def main(argv: list[str]) -> int:
    bench = Path(argv[1]).resolve()
    out_path = Path(argv[2]) if len(argv) > 2 else OUT
    sys.path.insert(0, str(bench))
    import ctx_metrics  # noqa: E402
    import summarize  # noqa: E402

    data = {"source": "ContextBench in strict mode through Claude Code, Claude Haiku 5.5; "
                      "computed by site/scripts/bench/compute-contextbench.py",
            "score_metric": "reward_lenient (tag-insensitive)",
            "price_basis": "list price, Claude Haiku 5.5, summarize.priced() in the bench directory",
            "settings": [], "cells": {}, "excluded": [], "timing": {}, "headline": {}}
    all_trials: dict[str, list[dict]] = {}
    for key, label, results, state, arm in SETTINGS:
        data["settings"].append({"key": key, "label": label, "arm": arm, "run": results.split("-")[-1]})
        tdir = bench / results / arm / "trials"
        trials = []
        for p in sorted(tdir.iterdir()):
            if not (p / "result.json").is_file():
                data["excluded"].append({"setting": key, "trial": p.name, "reason": "no result.json"})
                continue
            rec = trial_record(bench, results, state, arm, p.name, ctx_metrics, summarize)
            if rec["reward"] is None:
                data["excluded"].append({"setting": key, "trial": p.name,
                                         "reason": f"no verifier reward (exception {rec['exception']})"})
                continue
            trials.append(rec)
        all_trials[key] = trials
        data["cells"][key] = {fam: {size: cell_summary([t for t in trials if t["family"] == fam and t["size"] == size])
                                    for size in sizes} for fam, sizes in SIZES.items()}

    # timing per setting
    for key, trials in all_trials.items():
        lat = [x for t in trials for x in t["latencies"]]
        tm = {"trials": len(trials), "requests": len(lat), "request_latency_s": _dist(lat),
              "agent_wall_s": _dist([t["agent_wall_s"] for t in trials])}
        if key == "s2":
            summ = [t["_lat"][i] for t in trials for i in t["summary_idx"]]
            other = [x for t in trials for i, x in enumerate(t["_lat"]) if i not in t["summary_idx"]]
            tm["native_summary_request_latency_s"] = _dist(summ)
            tm["native_other_request_latency_s"] = _dist(other)
            tm["native_cc_compaction_s"] = _dist([ms / 1000 for t in trials for ms in t["cc_compaction_ms"]
                                                  if ms is not None])
            tm["native_detected_vs_cc"] = {"detected": sum(len(t["summary_idx"]) for t in trials),
                                           "cc_compact_boundaries": sum(t["native_compactions"] for t in trials),
                                           "trials_matching": sum(1 for t in trials
                                                                  if len(t["summary_idx"]) == t["native_compactions"])}
        if key == "smart":
            trim = [t["_lat"][i] for t in trials for i in t["trim_idx"]]
            other = [x for t in trials for i, x in enumerate(t["_lat"]) if i not in t["trim_idx"]]
            tm["smart_trim_request_latency_s"] = _dist(trim)
            tm["smart_other_request_latency_s"] = _dist(other)
            tm["smart_trim_hook_timing"] = None  # not recorded by the proxy or in the session DBs
        data["timing"][key] = tm

    c = data["cells"]
    data["headline"] = {
        fam: {"size": sizes[-1], **{k: {"score": c[k][fam][sizes[-1]].get("score"), "n": c[k][fam][sizes[-1]]["n"],
                                        "peak_prompt_max": c[k][fam][sizes[-1]].get("peak_prompt_max")}
                                    for k in c}}
        for fam, sizes in SIZES.items()}
    data["headline"]["smart_peak_prompt_max_all"] = max(t["peak_prompt"] for t in all_trials["smart"])
    data["compact_bench"] = compact_bench(bench)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, indent=1) + "\n")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
