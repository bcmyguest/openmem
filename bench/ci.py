"""Per-cell means with 95% bootstrap CIs, and paired-by-seed differences against a reference arm.

    python ci.py RESULTS [STATE] [--ref ARM] [--metric reward_lenient,usd,agent_wall_s]

Reads the same trial rows as summarize.py (trial_rows). A cell is (arm, task size); the seed is the task name's
trailing -seedNN. Trials flagged "exception" or with rate-limit errors are excluded and listed. Paired differences
use only seeds both arms completed in that cell; a seed with several trials contributes their mean.
"""
import argparse
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

from summarize import trial_rows

SEED_RE = re.compile(r"-seed(\d+)$")
N_BOOT = 10000
METRICS = ("reward_lenient", "usd", "agent_wall_s")


def cell_of(task: str) -> tuple[str, str | None]:
    m = SEED_RE.search(task)
    return (task[: m.start()], m.group(1)) if m else (task, None)


def excluded(row: dict) -> str | None:
    if row.get("exception"):
        return f"exception {row['exception']}"
    if row.get("rate_limit_errors"):
        return f"{row['rate_limit_errors']} rate-limit errors"
    return None


def boot_ci(vals: list[float], rng: random.Random) -> tuple[float, float]:
    if len(vals) < 2:
        return (float("nan"), float("nan"))
    means = sorted(sum(rng.choices(vals, k=len(vals))) / len(vals) for _ in range(N_BOOT))
    return means[int(0.025 * N_BOOT)], means[int(0.975 * N_BOOT) - 1]


def by_seed(rows: list[dict], metric: str) -> dict[str, float]:
    acc = defaultdict(list)
    for r in rows:
        if isinstance(r.get(metric), (int, float)):
            acc[cell_of(r["task"])[1]].append(float(r[metric]))
    return {s: sum(v) / len(v) for s, v in acc.items()}


def fmt(x: float) -> str:
    return "-" if x != x else f"{x:.3f}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", type=Path)
    ap.add_argument("state", type=Path, nargs="?")
    ap.add_argument("--ref", default="e-none")
    ap.add_argument("--metric", default=",".join(METRICS))
    a = ap.parse_args(argv[1:])
    rng = random.Random(0)
    rows = trial_rows(a.results, a.state)
    kept, dropped = [], []
    for r in rows:
        (dropped if excluded(r) else kept).append(r)
    cells = defaultdict(list)
    for r in kept:
        cells[(cell_of(r["task"])[0], r["arm"])].append(r)
    for metric in a.metric.split(","):
        print(f"## {metric}\n\n| task | arm | n | mean | 95% CI | diff vs {a.ref} | 95% CI | seeds |\n|---|---|---|---|---|---|---|---|")
        for (task, arm), mine in sorted(cells.items()):
            seeds = by_seed(mine, metric)
            vals = list(seeds.values())
            if not vals:
                continue
            lo, hi = boot_ci(vals, rng)
            ref = by_seed(cells.get((task, a.ref), []), metric)
            common = sorted(set(seeds) & set(ref))
            diffs = [seeds[s] - ref[s] for s in common]
            d = sum(diffs) / len(diffs) if diffs and arm != a.ref else float("nan")
            dlo, dhi = boot_ci(diffs, rng) if arm != a.ref else (float("nan"), float("nan"))
            print(f"| {task} | {arm} | {len(vals)} | {fmt(sum(vals) / len(vals))} | {fmt(lo)}–{fmt(hi)} "
                  f"| {fmt(d)} | {fmt(dlo)}–{fmt(dhi)} | {','.join(common) if arm != a.ref else '-'} |")
        print()
    if dropped:
        print("## Excluded trials\n")
        for r in dropped:
            print(f"- {r['arm']} {r['trial']}: {excluded(r)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
