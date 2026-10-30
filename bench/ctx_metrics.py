"""Per-trial metrics for runs A and B (search rate, line_matches use, rewards, peak prompt).

    python ctx_metrics.py trial <results> <state> <arm> <trial_dir_name>   # JSON + "LINE: ..." message
    python ctx_metrics.py run <results> <state> [sub]                     # JSON list for every trial

Requests map to stream steps by order (deduplicated assistant message ids == proxy usage rows of the
session). A trim event (distinct ts in the OpenMem handoff log) belongs to the first trimmed request
that ended at or after it. An answer (ANSWER block) is post-trim when its request comes at or after the
first trim. "searched_in_turn": a smart_compact_search call earlier in the same `claude -p` turn.
"searched_since_trim": a search at or after the request carrying the latest trim before the answer.

Run D (arms d-*, SQLite store sessions/<sid>.db, no handoff log): a trim request is a request that carries the
pointer and either follows an untrimmed one or sends fewer messages than the one before (a new cut). Extra D
fields (d_metrics): smart_compact_search calls by the mode the response reports (lexical / hybrid) and
embedding_error, smart_compact_sql calls and errors, real prompt tokens of the request before each trim and
whether it lies within 10% of the run's TRIM_AT (D 120000, Dsmoke 20000; env CTX_TRIM_AT overrides), DB row,
trimmed-row and vector counts, and turns where the openmem MCP failed to start.
"""
from __future__ import annotations

import json, os, re, sqlite3, sys
from datetime import datetime
from pathlib import Path

B = Path(__file__).parent
sys.path.insert(0, str(B))
from summarize import answer_check, _jsonl  # noqa: E402

SEARCH = "mcp__openmem__smart_compact_search"
SQL = "mcp__openmem__smart_compact_sql"  # run D
GET = "mcp__openmem__smart_compact_get"
D_TOOLS = (SEARCH, GET, SQL)
TRIM_AT = {"D": 95000, "Dsmoke": 20000}  # D: the proxy's Haiku threshold (run with TRIM_AT= empty)
RECALL = "mcp__openmem__memory_recall"  # run C arm s3d-recall: its lookup tool in place of SEARCH
KV_RE = re.compile(r"<<<\s*ANSWER\s+key\s*=\s*([^\s>]+)\s*>>>(.*?)<<<\s*ANSWER\s+END\s*>>>", re.S | re.I)
LOG_RE = re.compile(r"<<<\s*ANSWER\s+qid\s*=\s*([0-9]+)\s*>>>(.*?)<<<\s*ANSWER\s+END\s*>>>", re.S | re.I)
NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")
LM_RE = re.compile(r'"?line_matches"?\s*[:=]\s*(\d+)')


def steps_of(agent: Path) -> list[dict]:
    steps, by_id, results = [], {}, {}
    for f in sorted(agent.glob("cc-turn-*.jsonl")):
        turn = int(f.stem.split("-")[-1])
        for line in f.read_text(errors="replace").splitlines():
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("parent_tool_use_id"):
                continue
            msg = ev.get("message") or {}
            content = msg.get("content") if isinstance(msg.get("content"), list) else []
            if ev.get("type") == "assistant":
                mid = msg.get("id")
                if mid not in by_id:
                    by_id[mid] = {"turn": turn, "texts": [], "tools": [], "usage": msg.get("usage")}
                    steps.append(by_id[mid])
                s = by_id[mid]
                for b in content:
                    if b.get("type") == "text":
                        s["texts"].append(b.get("text") or "")
                    elif b.get("type") == "tool_use":
                        s["tools"].append({"id": b.get("id"), "name": b.get("name"), "input": b.get("input")})
            elif ev.get("type") == "user":
                for b in content:
                    if b.get("type") == "tool_result":
                        c = b.get("content")
                        if isinstance(c, list):
                            c = "\n".join(str(x.get("text") or "") for x in c if isinstance(x, dict))
                        results[b.get("tool_use_id")] = (str(c or ""), bool(b.get("is_error")))
    for s in steps:
        for t in s["tools"]:
            t["result"], t["is_error"] = results.get(t["id"], ("", False))
    return steps


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def trial(results: Path, state: Path, arm: str, name: str, sub: str = "trials") -> dict:
    tdir = results / arm / sub / name
    res = json.loads((tdir / "result.json").read_text())
    meta_p = tdir / "agent" / "cc_stream.json"
    meta = json.loads(meta_p.read_text()) if meta_p.is_file() else {}
    sid = meta.get("session_id")
    task = res.get("task_name") or name.split(".", 1)[-1]
    rw = (res.get("verifier_result") or {}).get("rewards") or {}
    rows = [r for r in _jsonl(results / arm / "usage.jsonl") if sid and r.get("session") == sid and r.get("ok")]
    steps = steps_of(tdir / "agent")
    out = {"run": results.name.split("-")[-1], "arm": arm, "task": task, "trial": name,
           "seed": int(task.rsplit("seed", 1)[-1]) if "seed" in task else None,
           "reward": rw.get("reward"), "r_lookup": rw.get("reward_lookup"), "r_count": rw.get("reward_count"),
           "answered": rw.get("n_answered"), "total": rw.get("total"),
           "terminated_by": meta.get("terminated_by"),
           "n_ops": f"{meta.get('n_ops_delivered')}/{meta.get('n_ops_total')}",
           "exception": (res.get("exception_info") or {}).get("exception_type"),
           "requests": len(rows), "steps": len(steps), "map_ok": len(rows) == len(steps),
           "peak_prompt": max((int(r.get("input") or 0) + int(r.get("cache_read") or 0)
                               + int(r.get("cache_write") or 0) for r in rows), default=0),
           "compactions": len(meta.get("compactions") or [])}
    ac = answer_check(tdir / "agent", task)
    out.update(ac)
    if ac and out["total"]:
        out["reward_lenient"] = max(ac["kv_exact"], ac["kv_notag"]) / out["total"]
        out["format_fail"] = ac["kv_notag"] > ac["kv_exact"]
    else:
        out["reward_lenient"], out["format_fail"] = out["reward"], False
    # trims -> request index
    is_d = arm.startswith("d-")
    log = _jsonl(state / arm / "context" / "sessions" / f"{sid}.log.jsonl") if sid and not is_d else []
    trims = []
    for T in sorted({_epoch(r["ts"]) for r in log if r.get("ts")}):
        idx = next((i for i, r in enumerate(rows) if r.get("trimmed") and float(r["ts"]) >= T), None)
        if idx is not None and idx not in trims:
            trims.append(idx)
    if is_d:
        trims = d_trims(state / arm / "context" / "sessions" / f"{sid}.db", rows) if sid else []
    out["trim_events"] = len(trims) if is_d else len({r.get("ts") for r in log})
    out["trim_reqs"] = trims
    first_trim = trims[0] if trims else None
    # searches per step
    look = RECALL if arm.startswith("s3d") else SEARCH
    sql_steps = [i for i, s in enumerate(steps) for t in s["tools"] if t["name"] in (SEARCH, SQL)]
    search_steps = [i for i, s in enumerate(steps) for t in s["tools"] if t["name"] == look]
    out["sc_search"] = len(search_steps)
    out["sc_search_post_trim"] = sum(1 for i in search_steps if first_trim is not None and i >= first_trim)
    gold = json.loads((B / "cb" / "tasks" / task / "tests" / "gold.json").read_text())["queries"]
    is_log = task.startswith("log-triage")
    qtype = {str(q["qid"]): q.get("type") for q in gold} if is_log else {}
    want = {str(q["qid"]): str(q["answer"]) for q in gold} if is_log else {}
    seen, answers = set(), []
    for i, s in enumerate(steps):
        for qk, val in (LOG_RE if is_log else KV_RE).findall("\n".join(s["texts"])):
            qk = qk.strip()
            if qk in seen:
                continue
            seen.add(qk)
            last_trim = max((t for t in trims if t <= i), default=None)
            in_turn = [j for j in search_steps if j <= i and steps[j]["turn"] == s["turn"]]
            a = {"q": qk, "req": i, "turn": s["turn"], "post_trim": first_trim is not None and i >= first_trim,
                 "searched_in_turn": bool(in_turn),
                 "searched_since_trim": last_trim is not None and any(last_trim <= j <= i for j in search_steps)}
            if is_d:  # search or sql
                a["looked_up_since_trim"] = last_trim is not None and any(last_trim <= j <= i for j in sql_steps)
            if is_log and qtype.get(qk) == "count":
                nums = NUM_RE.findall(val)
                lms = [int(m) for j in in_turn for t in steps[j]["tools"] if t["name"] == look
                       for m in LM_RE.findall(t["result"])]
                a.update({"count": True, "answer": nums, "gold": want[qk], "line_matches_seen": lms,
                          "used_line_matches": bool(nums) and len(nums) == 1 and int(float(nums[0])) in lms,
                          "correct": nums == [want[qk]]})
                if is_d:  # a number from a smart_compact_sql result earlier in the same turn
                    in_turn_sql = [t for j, st in enumerate(steps) if j <= i and st["turn"] == s["turn"]
                                   for t in st["tools"] if t["name"] == SQL and not t["is_error"]]
                    sql_nums = {int(float(x)) for t in in_turn_sql for x in NUM_RE.findall(
                        json.dumps((_json(t["result"]) or {}).get("rows") or []))}
                    a.update({"sql_in_turn": bool(in_turn_sql),
                              "used_sql": bool(nums) and len(nums) == 1 and int(float(nums[0])) in sql_nums})
            answers.append(a)
    post = [a for a in answers if a["post_trim"]]
    out["n_answers"] = len(answers)
    out["post_trim_q"] = len(post)
    out["post_trim_nosearch_turn"] = sum(1 for a in post if not a["searched_in_turn"])
    out["post_trim_nosearch_since_trim"] = sum(1 for a in post if not a["searched_since_trim"])
    cnt = [a for a in answers if a.get("count")]
    out["count_q"] = len(cnt)
    out["count_searched"] = sum(1 for a in cnt if a["searched_in_turn"])
    out["count_saw_line_matches"] = sum(1 for a in cnt if a["line_matches_seen"])
    out["count_used_line_matches"] = sum(1 for a in cnt if a["used_line_matches"])
    out["count_correct"] = sum(1 for a in cnt if a["correct"])
    out["answers"] = answers
    if is_d:
        out["post_trim_nolookup_since_trim"] = sum(1 for a in post if not a["looked_up_since_trim"])
        out["count_sql_in_turn"] = sum(1 for a in cnt if a["sql_in_turn"])
        out["count_used_sql"] = sum(1 for a in cnt if a["used_sql"])
        out.update(d_metrics(results, state, arm, sid, rows, steps, tdir / "agent", trims, meta))
    if arm.startswith(("s3c", "s3d")):
        out.update(c_metrics(arm, steps, tdir / "agent", first_trim))
    return out


def _json(text: str) -> dict:
    try:
        v = json.loads(text)
        return v if isinstance(v, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def c_metrics(arm: str, steps: list[dict], agent: Path, first_trim: int | None) -> dict:
    """Run C extras. s3c: smart_compact_search calls by mode, semantic results that were pending / empty.
    s3d: memory_recall calls (and those with hits), attempts at the denied smart_compact tools, Stop hook stderr."""
    calls = [(i, t) for i, s in enumerate(steps) for t in s["tools"]]
    post = lambda i: first_trim is not None and i >= first_trim  # noqa: E731
    if arm.startswith("s3c"):
        sc = [(i, t) for i, t in calls if t["name"] == SEARCH]
        sem = [(i, t, _json(t["result"])) for i, t in sc if (t["input"] or {}).get("mode") == "semantic"]
        return {"sc_semantic": len(sem), "sc_lexical": len(sc) - len(sem),
                "sc_semantic_post_trim": sum(1 for i, _, _ in sem if post(i)),
                "sc_semantic_pending": sum(1 for _, _, r in sem if r.get("pending")),
                "sc_semantic_empty": sum(1 for _, _, r in sem if not r.get("results")),
                "sc_semantic_error": sum(1 for _, _, r in sem if not r)}
    rc = [(i, t, _json(t["result"])) for i, t in calls if t["name"] == RECALL]
    err = agent / "stop-hook.err"
    return {"recall": len(rc), "recall_post_trim": sum(1 for i, _, _ in rc if post(i)),
            "recall_empty": sum(1 for _, _, r in rc if not ((r.get("result") or {}).get("results"))),
            "recall_wrong_bank": sum(1 for _, t, _ in rc if not str((t["input"] or {}).get("bank", "")).startswith("cbench-s3d-")),
            "denied_sc_calls": sum(1 for _, t in calls if t["name"] in (SEARCH, "mcp__openmem__smart_compact_get")),
            "hook_err_lines": len(err.read_text(errors="replace").splitlines()) if err.is_file() else 0}


def d_cuts(db: Path) -> list[float]:
    """One epoch per cut (distinct messages.trimmed_at_seq): the earliest trimmed_at of its rows (second resolution)."""
    if not db.is_file():
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        got = con.execute("SELECT min(trimmed_at) FROM messages WHERE trimmed_at_seq IS NOT NULL "
                          "GROUP BY trimmed_at_seq ORDER BY trimmed_at_seq").fetchall()
    finally:
        con.close()
    return [_epoch(t) for (t,) in got if t]


def d_trims(db: Path, rows: list[dict]) -> list[int]:
    """Cut -> request index. The proxy trims and stamps trimmed_at (floored to the second) in the pre-call hook, so
    the trimming request started in [T, T + 1); fall back to the first unused pointer request that ended at or after T."""
    trims: list[int] = []
    for T in d_cuts(db):
        free = [i for i, r in enumerate(rows) if r.get("trimmed") and i not in trims and (not trims or i > trims[-1])]
        start = [i for i in free if T - 0.5 <= float(rows[i]["ts"]) - float(rows[i].get("latency_s") or 0) < T + 1.5]
        idx = start[0] if start else next((i for i in free if float(rows[i]["ts"]) >= T), None)
        if idx is not None:
            trims.append(idx)
    return trims


def _real(r: dict) -> int:
    return int(r.get("input") or 0) + int(r.get("cache_read") or 0) + int(r.get("cache_write") or 0)


def d_metrics(results: Path, state: Path, arm: str, sid: str | None, rows: list[dict], steps: list[dict],
              agent: Path, trims: list[int], meta: dict) -> dict:
    run = results.name.split("-", 1)[-1]
    trim_at = int(os.environ.get("CTX_TRIM_AT") or TRIM_AT.get(run, 120000))
    calls = [(i, t) for i, s in enumerate(steps) for t in s["tools"]]
    sc = [(t, _json(t["result"])) for _, t in calls if t["name"] == SEARCH]
    sq = [t for _, t in calls if t["name"] == SQL]
    pre = [_real(rows[i - 1]) for i in trims if i > 0]
    out = {"trim_at": trim_at, "pre_trim_tokens": pre, "post_trim_tokens": [_real(rows[i]) for i in trims],
           # the last untrimmed request (before the first trim) within 10% of TRIM_AT
           "trim_near_threshold": bool(pre) and abs(pre[0] - trim_at) <= 0.1 * trim_at,
           "peak_over_trim_at": round(max((_real(r) for r in rows), default=0) / trim_at, 3),
           "sc_lexical": sum(1 for _, r in sc if r.get("mode") == "lexical"),
           "sc_hybrid": sum(1 for _, r in sc if r.get("mode") == "hybrid"),
           "sc_pattern": sum(1 for t, _ in sc if (t["input"] or {}).get("pattern")),
           "sc_embedding_error": sum(1 for _, r in sc if r.get("embedding_error")),
           "sc_error": sum(1 for t, r in sc if t["is_error"] or not r),
           "sc_sql": len(sq), "sc_sql_error": sum(1 for t in sq if t["is_error"] or not _json(t["result"])),
           "sc_get": sum(1 for _, t in calls if t["name"] == GET)}
    out["sc_sql_errors"] = [t["result"][:200] for t in sq if t["is_error"] or not _json(t["result"])]
    failed = 0
    for f in sorted(agent.glob("cc-turn-*.jsonl")):
        if '"name":"openmem","status":"failed"' in f.read_text(errors="replace"):
            failed += 1
    out["mcp_failed_turns"] = failed
    tools = meta.get("init_tools") or []
    out["tools_ok"] = all(t in tools for t in D_TOOLS)
    db = state / arm / "context" / "sessions" / f"{sid}.db"
    out.update({"db_rows": None, "db_out_of_context": None, "db_cuts": None, "db_vectors": None})
    if sid and db.is_file():
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            q = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
            out.update({"db_rows": q("SELECT count(*) FROM messages"),
                        "db_out_of_context": q("SELECT count(*) FROM messages WHERE in_context = 0"),
                        "db_cuts": q("SELECT count(DISTINCT trimmed_at_seq) FROM messages"),
                        "db_vectors": q("SELECT count(*) FROM vectors")})
        finally:
            con.close()
    return out


def line(m: dict) -> str:
    s = (f"{m['run']} {m['arm']} {m['task'].rsplit('-seed', 1)[0]} seed{m['seed']}: reward={m['reward']:.3f} "
         f"lenient={m['reward_lenient']:.3f}" if m["reward"] is not None else
         f"{m['run']} {m['arm']} {m['task']}: NO REWARD exc={m['exception']}")
    if m["task"].startswith("log-triage") and m["reward"] is not None:
        s += f" lookup={m['r_lookup']:.3f} count={m['r_count']:.3f}"
    if m["arm"].startswith("s3d"):
        s += (f" recall={m['recall']} (post-trim {m['recall_post_trim']}, empty {m['recall_empty']}, "
              f"wrong_bank {m['recall_wrong_bank']}) denied_sc={m['denied_sc_calls']} hook_err={m['hook_err_lines']}"
              f" post-trim q={m['post_trim_q']} norecall_since_trim={m['post_trim_nosearch_since_trim']}"
              f" norecall_in_turn={m['post_trim_nosearch_turn']}")
        if m["task"].startswith("log-triage"):
            s += f" line_matches used={m['count_used_line_matches']}/{m['count_q']}"
    elif m["arm"].startswith("s3"):
        s += (f" sc_search={m['sc_search']} post-trim q={m['post_trim_q']} nosearch_since_trim="
              f"{m['post_trim_nosearch_since_trim']} nosearch_in_turn={m['post_trim_nosearch_turn']}")
        if m["task"].startswith("log-triage"):
            s += f" line_matches used={m['count_used_line_matches']}/{m['count_q']}"
        if m["arm"].startswith("s3c"):
            s += (f" semantic={m['sc_semantic']}/{m['sc_semantic'] + m['sc_lexical']} (post-trim "
                  f"{m['sc_semantic_post_trim']}, pending {m['sc_semantic_pending']}, empty {m['sc_semantic_empty']}, "
                  f"error {m['sc_semantic_error']})")
    if m["arm"].startswith("d-"):
        s += (f" search={m['sc_search']} (lexical {m['sc_lexical']}, hybrid {m['sc_hybrid']}, emb_err "
              f"{m['sc_embedding_error']}, err {m['sc_error']}) sql={m['sc_sql']} (err {m['sc_sql_error']}) get={m['sc_get']}"
              f" post-trim q={m['post_trim_q']} nosearch_since_trim={m['post_trim_nosearch_since_trim']}"
              f" nosearch_in_turn={m['post_trim_nosearch_turn']} nolookup_since_trim={m['post_trim_nolookup_since_trim']}")
        if m["task"].startswith("log-triage"):
            s += (f" count: line_matches used={m['count_used_line_matches']}/{m['count_q']} sql used="
                  f"{m['count_used_sql']}/{m['count_q']} correct={m['count_correct']}/{m['count_q']}")
        s += (f" pre-trim={','.join(str(x) for x in m['pre_trim_tokens']) or '-'} near{m['trim_at'] // 1000}k="
              f"{'yes' if m['trim_near_threshold'] else 'NO'} db={m['db_rows']}/{m['db_out_of_context']}out"
              f"/{m['db_vectors']}vec")
        if not m["tools_ok"]:
            s += " TOOLS-MISSING"
        if m["mcp_failed_turns"]:
            s += f" MCP-FAILED-TURNS={m['mcp_failed_turns']}"
    s += f" peak={m['peak_prompt']} trims={m['trim_events']} {m['terminated_by']}"
    if m["format_fail"]:
        s += " FORMAT-FAIL(#tag dropped)"
    if m.get("answered") is not None and m.get("total") and m["answered"] < m["total"]:
        s += f" answered={int(m['answered'])}/{int(m['total'])}"
    if not m["map_ok"]:
        s += f" [map {m['steps']}/{m['requests']}]"
    return s


if __name__ == "__main__":
    mode, results, state = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    if mode == "trial":
        m = trial(results, state, sys.argv[4], sys.argv[5])
        (results / sys.argv[4] / "metrics").mkdir(exist_ok=True)
        (results / sys.argv[4] / "metrics" / f"{sys.argv[5]}.json").write_text(json.dumps(m, indent=1))
        print("LINE:", line(m))
    else:
        sub = sys.argv[4] if len(sys.argv) > 4 else "trials"
        ms = []
        for arm in sorted(p for p in results.iterdir() if (p / sub).is_dir()):
            for t in sorted(p for p in (arm / sub).iterdir() if (p / "result.json").is_file()):
                ms.append(trial(results, state, arm.name, t.name, sub))
        print(json.dumps(ms, indent=1))
