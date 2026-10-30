#!/usr/bin/env python3
"""Compact-Bench Task Preservation with Claude Code as the continuation agent, plus an `openmem` method.

Mirrors run.py task_track / harness.e1_xb, replacing only the model calls:
  * continuation (PRE and every POST): cc_continue.continue_session (claude -p --resume, Haiku 5.5)
    instead of e1_runner.episode;
  * summarizer: cc_continue.summarize (claude -p, one turn, no tools) instead of cb_common.summarize,
    on the same input: cb_common.build_transcript(H) + "\\n\\n" + cb_common.PROMPTS[prompt],
    max output cb_common.SUMMARIZER_MAX_TOKENS (16384, as e1_xb.compress_x).
Setup, frozen state, snapshot restore, force_state and the judge are the harness's functions.

Results use the scorer's file names, so scripts/score_e1.aggregate(out, "cbo") reports one row per
method: <iid>__baseline.json (PRE) and <iid>__xb-<method>.cbo[.r2|.r3].json (POST).

    python3 run_task.py --instance pylint-dev__pylint-6903 --methods claude,openmem --rounds 1
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
CB = Path(os.environ.get("CB_ROOT", HERE.parent / "compact-bench")).resolve()
OPENMEM_SHA = os.environ.get("OPENMEM_SHA", "cbe332a")
os.environ.setdefault("OPENMEM_REPO", str(HERE.parent / "repo-main"))
OPENMEM_REPO = os.environ["OPENMEM_REPO"]
NODE = os.environ.get("CBO_NODE", str(HERE.parent / "node24" / "bin" / "node"))
VARIANT = "cbo"
CONTINUE_TEXT = "继续完成任务：确保修复生效并通过相关测试。"  # run.py / e1_runner / e1_xb
SUMMARY_PREFIX = "The conversation so far has been compacted. What follows is the summary:\n\n"
SUMMARY_METHODS = ("claude", "codex", "opencode", "gemini", "kimi")
# openmem uses --openmem-budget; openmem-proxy always uses budget 0 (the proxy's cut rule unchanged).
OPENMEM_METHODS = ("openmem", "openmem-proxy")
EXCLUDE = {"pytest-dev__pytest-10051", "pytest-dev__pytest-7236"}  # scripts/score_e1.EXCLUDE
MAX_ATTEMPTS = 12  # per model call; waits from cc_continue.limit_wait (up to 30 min, or the usage-limit reset)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--instance", action="append")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--methods", default="claude,codex,openmem",
                    help="comma list of summary prompts and/or openmem; PRE always runs")
    ap.add_argument("--rounds", type=int, choices=(1, 3), default=3)
    ap.add_argument("--openmem-budget", default="match:claude",
                    help="kept phase-A step tokens: 0 (proxy rule), an integer, or match:<prompt> "
                         "(the size of that prompt's summary for the same instance and round)")
    ap.add_argument("--output", type=Path, default=HERE / "results")
    ap.add_argument("--work", type=Path, default=HERE / "work")
    ap.add_argument("--cleanup", action="store_true",
                    help="after an instance is scored, delete its venv, repository copies and archive")
    ap.add_argument("--no-report", action="store_true",
                    help="skip the scorer table and write errors-<pid>.json (for concurrent runs into one output)")
    ap.add_argument("--include-excluded", action="store_true",
                    help="also run the two instances the scorer excludes")
    return ap.parse_args(argv)


def setup_env(args):
    os.environ["CB_WORK_ROOT"] = str(args.work.resolve())
    os.environ["CB_VENV_ROOT"] = str((args.work / "venvs").resolve())
    os.environ["CB_RESULTS_ROOT"] = str(args.output.resolve())
    sys.path.insert(0, str(CB / "harness"))
    sys.path.insert(0, str(CB / "scripts"))
    sys.path.insert(0, str(HERE))


def cleanup(C, iid):
    """Delete an instance's venv, extracted repository, D3 working copy, snapshot and source archive."""
    work = Path(C.WORK_ROOT)
    for p in (Path(C.VENV_ROOT) / iid, work / "work" / iid, work / "work" / f"{iid}.D3",
              work / "work" / f"{iid}.D3snap", work / "work" / f"{iid}.test.patch",
              work / "archives" / f"{iid.split('__')[1]}.tgz"):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink()


def restore(D, snap):
    shutil.rmtree(D, ignore_errors=True)
    shutil.copytree(snap, D, symlinks=False)


def costs(*records):
    return round(sum((r or {}).get("cost_usd") or 0 for r in records), 6)


def with_retry(K, label, call):
    """call() -> (value, record); repeat while cc_continue.limit_wait says the call hit a limit or failed."""
    waited = []
    for attempt in range(MAX_ATTEMPTS):
        value, rec = call()
        wait = K.limit_wait(rec, attempt)
        if wait is None:
            rec["limit_waits"] = waited
            return value, rec
        print(f"[cbo] {label}: {rec.get('subtype')} {(rec.get('result_text') or '')[:120]!r}; retry in {wait}s",
              file=sys.stderr, flush=True)
        waited.append({"wait_s": wait, "subtype": rec.get("subtype"), "text": (rec.get("result_text") or "")[:200]})
        time.sleep(wait)
    raise RuntimeError(f"{label}: still failing after {MAX_ATTEMPTS} attempts: {waited[-1]}")


def run_arm(R, K, messages, final, D, snap, venv, f2p, work, openmem=None, label="arm"):
    """Restore the phase-A state, continue with Claude Code, judge. Returns (passed, record)."""
    def attempt():
        restore(D, snap)
        R.force_state(venv, D)
        if openmem:  # a retried attempt must start from a fresh MCP home; the session DB is read-only to it
            shutil.rmtree(os.path.join(str(work), "cc-config"), ignore_errors=True)
        return None, K.continue_session(messages, final, D, venv, str(CB / "harness"), str(work), openmem=openmem)
    _, rec = with_retry(K, label, attempt)
    R.force_state(venv, D)
    passed, err = R.run_tests(D, venv, f2p)
    return passed, {"tools": rec["harness_tools"], "test_err": err[:300], "cc": rec}


def summary_for(C, K, H, prompt, work, iid, rnd):
    """Summary S for (instance, prompt, round), cached like e1_xb's s_cache."""
    cache = work / "summaries" / f"{iid}.S.{prompt}.r{rnd}.json"
    if cache.is_file():
        return json.loads(cache.read_text(encoding="utf-8"))
    user = C.build_transcript(H) + "\n\n" + C.PROMPTS[prompt]
    text, rec = with_retry(K, f"{iid} summary {prompt} r{rnd}", lambda: K.summarize(
        user, str(work / "summaries" / f"{iid}.{prompt}.r{rnd}"), C.SUMMARIZER_MAX_TOKENS))
    out = {"S": text, "cc": rec}
    C.save_json(str(cache), out)
    return out


def post_method(C, R, K, V, ctx, method, rnd):
    """One POST cell. Returns the record saved under the scorer's xb file name."""
    iid, H = ctx["iid"], ctx["H"]
    work = ctx["work"] / f"{method}.r{rnd}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    final = {"role": "user", "content": CONTINUE_TEXT}
    extra, summary_cost = {}, 0
    if method in SUMMARY_METHODS:
        s = summary_for(C, K, H, method, ctx["work"], iid, rnd)
        messages = [{"role": "user", "content": SUMMARY_PREFIX + s["S"]}]
        extra = {"S": s["S"], "S_tokens": (len(s["S"]) + 3) // 4, "summarizer": s["cc"]}
        summary_cost = costs(s["cc"])
        om = None
    elif method in OPENMEM_METHODS:
        budget = ctx["budget"] if method == "openmem" else "0"
        if budget.startswith("match:"):
            # The reference summary is the summary method's own cell (same cache); its cost is counted there.
            ref = summary_for(C, K, H, budget.split(":", 1)[1], ctx["work"], iid, rnd)
            budget = (len(ref["S"]) + 3) // 4  # tokens.text_tokens, the measure openmem_view uses
        sid = str(uuid.uuid4())
        state = work / "openmem-state"
        view, info = V.compact(K.rename_tools(H), final, sid, str(state), int(budget))
        messages, final = view[:-1], view[-1]
        extra = {"openmem": {**info, "session_id": sid, "openmem_sha": OPENMEM_SHA, "openmem_repo": OPENMEM_REPO}}
        om = {"node": NODE, "repo": OPENMEM_REPO, "state_dir": str(state), "system": V.STANDING_INSTRUCTION,
              "session_id": sid}
    else:
        raise ValueError(f"unknown method {method}")
    passed, arm = run_arm(R, K, messages, final, ctx["D"], ctx["snap"], ctx["venv"], ctx["f2p"], work, om,
                          label=f"{iid} {method} r{rnd}")
    return {"instance_id": iid, "backbone": method, "variant": VARIANT, "proto": "v3-xb-cc",
            "f2p": ctx["f2p"], "post_pass": passed, "round": rnd, "agent": K.MODEL,
            "continuation_cost_usd": costs(arm["cc"]), "summary_cost_usd": summary_cost,
            **arm, **extra}


def main(argv=None):
    args = parse_args(argv)
    setup_env(args)
    import cb_common as C
    import e1_runner as R
    from cb_data import ensure_data
    from score_e1 import aggregate, write_report
    import cc_continue as K
    import openmem_view as V

    methods = [m.strip() for m in args.methods.split(",") if m.strip()]
    for m in methods:
        if m not in SUMMARY_METHODS and m not in OPENMEM_METHODS:
            raise SystemExit(f"unknown method {m}")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    C.RESULTS_ROOT, C.WORK_ROOT, C.VENV_ROOT = str(out), os.environ["CB_WORK_ROOT"], os.environ["CB_VENV_ROOT"]
    R.WORK = C.WORK_ROOT
    C.save_json(str(out / f"run-{os.getpid()}.json" if args.no_report else out / "run.json"), {
        "agent": K.MODEL, "summarizer": K.MODEL, "claude_code": K.claude_version(), "methods": methods,
        "rounds": args.rounds, "openmem_budget": args.openmem_budget, "openmem_sha": OPENMEM_SHA,
        "openmem_repo": OPENMEM_REPO, "compact_bench": CB.name, "cb_python": os.environ.get("CB_PYTHON")})
    instances = json.load(open(ensure_data("e1/instances.json"), encoding="utf-8"))
    if args.instance:
        instances = [x for x in instances if x["instance_id"] in set(args.instance)]
    if not args.include_excluded:
        instances = [x for x in instances if x["instance_id"] not in EXCLUDE]
    if args.limit:
        instances = instances[:args.limit]
    failures = []
    for inst in instances:
        iid = inst["instance_id"]
        try:
            t0 = time.time()
            root, venv = R.setup_instance(inst)
            f2p = R.resolve_f2p(inst, root)
            R.force_state(venv, root)
            if R.run_tests(root, venv, f2p)[0]:
                raise RuntimeError("Base repository unexpectedly passes FAIL_TO_PASS")
            H, _, D, snap = R.phase_a_state(inst, root, venv)
            ctx = {"iid": iid, "H": H, "D": D, "snap": snap, "venv": venv, "f2p": f2p,
                   "work": Path(C.WORK_ROOT) / "cbo" / iid, "budget": args.openmem_budget}
            base_path = out / f"{iid}__baseline.json"
            if base_path.is_file():
                base = json.loads(base_path.read_text(encoding="utf-8"))
            else:
                print(f"[cbo] PRE {iid}", flush=True)
                work = ctx["work"] / "pre"
                shutil.rmtree(work, ignore_errors=True)
                passed, arm = run_arm(R, K, list(H), {"role": "user", "content": CONTINUE_TEXT},
                                      D, snap, venv, f2p, work, label=f"{iid} PRE")
                base = {"instance_id": iid, "pre_pass": passed, "f2p": f2p, "agent": K.MODEL,
                        "continuation_cost_usd": costs(arm["cc"]), **arm}
                C.save_json(str(base_path), base)
            print(f"[cbo] {iid} PRE pass={base['pre_pass']}", flush=True)
            for m in methods:
                stem = f"{iid}__xb-{m}.{VARIANT}"
                rounds = [1] + ([2, 3] if args.rounds == 3 else [])
                for rnd in rounds:
                    path = out / (f"{stem}.json" if rnd == 1 else f"{stem}.r{rnd}.json")
                    if rnd > 1:
                        first = json.loads((out / f"{stem}.json").read_text(encoding="utf-8"))
                        if first["post_pass"] == base["pre_pass"]:
                            break
                    if not path.is_file():
                        print(f"[cbo] {iid} {m} r{rnd}", flush=True)
                        C.save_json(str(path), post_method(C, R, K, V, ctx, m, rnd))
                    row = json.loads(path.read_text(encoding="utf-8"))
                    print(f"[cbo] {iid} {m} r{rnd} POST pass={row['post_pass']} "
                          f"cost=${row['continuation_cost_usd'] + row['summary_cost_usd']:.4f}", flush=True)
            print(f"[cbo] {iid} done in {time.time() - t0:.0f}s", flush=True)
            if args.cleanup:
                cleanup(C, iid)
        except Exception as exc:
            failures.append({"instance_id": iid, "error": f"{type(exc).__name__}: {exc}"})
            print(f"[cbo] {iid}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    if args.no_report:
        C.save_json(str(out / f"errors-{os.getpid()}.json"), failures)
        return 0 if not failures else 1
    C.save_json(str(out / "errors.json"), failures)
    report = aggregate(str(out), VARIANT, [x["instance_id"] for x in instances])
    report["errors"] = failures
    write_report(str(out), report)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
