#!/usr/bin/env python3
"""Run run.sh once per instance, at most --jobs at a time, with --cleanup; print one summary line per task.

Stops launching new instances when free space on / falls below --min-free-gb. Each instance's log is
<output>/logs/<iid>.log. Summary lines start with "TASK " (for a log monitor); the final scorer table
comes from scripts/score_e1 over the whole output directory.

    python3 drive.py --output results/full --methods claude,codex,openmem,openmem-proxy
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CB = HERE.parent / "compact-bench"
sys.path.insert(0, str(CB / "harness"))
sys.path.insert(0, str(CB / "scripts"))
from cb_data import ensure_data  # noqa: E402

EXCLUDE = {"pytest-dev__pytest-10051", "pytest-dev__pytest-7236"}


def summary(out, iid, methods):
    parts = []
    base = out / f"{iid}__baseline.json"
    if base.is_file():
        b = json.loads(base.read_text())
        parts.append(f"PRE {'pass' if b['pre_pass'] else 'FAIL'} ${b['cc']['cost_usd']:.4f}")
    total = sum(json.loads(base.read_text())["cc"]["cost_usd"] for _ in [0] if base.is_file())
    for m in methods:
        rounds, cost, om = [], 0.0, []
        for suffix in ("", ".r2", ".r3"):
            p = out / f"{iid}__xb-{m}.cbo{suffix}.json"
            if not p.is_file():
                continue
            x = json.loads(p.read_text())
            rounds.append("pass" if x["post_pass"] else "FAIL")
            cost += x["continuation_cost_usd"] + x["summary_cost_usd"]
            om.append(sum("smart_compact" in t for t in x["cc"]["tool_uses"]))
        total += cost
        extra = f" smart_compact={om}" if m.startswith("openmem") else ""
        parts.append(f"{m} {'/'.join(rounds) or 'missing'}{extra} ${cost:.4f}")
    return f"TASK {iid}: " + "; ".join(parts) + f" | task ${total:.4f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--methods", default="claude,codex,openmem,openmem-proxy")
    ap.add_argument("--rounds", default="3")
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("--min-free-gb", type=float, default=4.0)
    ap.add_argument("--instance", action="append")
    args = ap.parse_args()
    out = args.output.resolve()
    (out / "logs").mkdir(parents=True, exist_ok=True)
    methods = args.methods.split(",")
    todo = [x["instance_id"] for x in json.load(open(ensure_data("e1/instances.json"), encoding="utf-8"))
            if x["instance_id"] not in EXCLUDE]
    if args.instance:
        todo = [i for i in todo if i in set(args.instance)]
    running, stopped = {}, False
    t0 = time.time()
    while todo or running:
        while todo and len(running) < args.jobs and not stopped:
            free = shutil.disk_usage("/").free / 1e9
            if free < args.min_free_gb:
                print(f"STOP free space {free:.1f} GB < {args.min_free_gb} GB; {len(todo)} not started", flush=True)
                stopped = True
                break
            iid = todo.pop(0)
            log = open(out / "logs" / f"{iid}.log", "w")
            running[iid] = (subprocess.Popen(
                [str(HERE / "run.sh"), "--instance", iid, "--methods", args.methods, "--rounds", args.rounds,
                 "--output", str(out), "--cleanup", "--no-report"], stdout=log, stderr=subprocess.STDOUT), log, time.time())
        if stopped and not running:
            break
        if stopped:
            todo = []
        time.sleep(5)
        for iid, (proc, log, start) in list(running.items()):
            if proc.poll() is None:
                continue
            log.close()
            del running[iid]
            line = summary(out, iid, methods)
            if proc.returncode:
                tail = (out / "logs" / f"{iid}.log").read_text(errors="replace").strip().splitlines()[-3:]
                line += f" | EXIT {proc.returncode}: {' / '.join(tail)[:300]}"
            print(f"{line} | {time.time() - start:.0f}s, free {shutil.disk_usage('/').free / 1e9:.1f} GB", flush=True)
    from score_e1 import aggregate, write_report
    report = aggregate(str(out), "cbo")
    write_report(str(out), report)
    print(f"DONE in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
