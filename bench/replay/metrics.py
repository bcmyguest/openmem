"""Replay trial metrics: tool calls, repeat reads, repeated identical calls, wall time, list-price $.

    python metrics.py trial <trial_dir> <usage.jsonl>      # JSON for one trial (replay.sh writes trial.json)
    python metrics.py over <usage.jsonl> <session> <usd>   # exit 0 when the session's spend passes <usd>
    python metrics.py report <results_dir>                 # markdown table + per-arm means

Main-loop tool calls come from ctx_metrics.steps_of (stream-json, deduplicated by assistant message id).
repeat_reads: per file path, (times read - 1) summed, over Read calls and Bash cat/head/tail/sed/nl/less on a
file (path resolved against the trial worktree, line ranges ignored). repeat_calls: per identical (tool, input),
(count - 1) summed. Spend: the proxy's usage rows for the session, priced by summarize.priced at Haiku 4.5 list
prices (platform.claude.com/docs/en/about-claude/pricing: $1 in, $1.25 5m write, $2 1h write, $0.10 read,
$5 out; no long-context tier).
"""
from __future__ import annotations

import json, os, re, shlex, sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import summarize  # noqa: E402
from ctx_metrics import steps_of  # noqa: E402
from cc_stream import parse_stream  # noqa: E402

HAIKU_45 = "claude-haiku-4-5-20251001"
summarize.FLAT_PRICE.setdefault(HAIKU_45, (1.00, 1.25, 2.00, 0.10, 5.00))
READERS = {"cat", "head", "tail", "sed", "nl", "less", "more", "bat"}
SPLIT_RE = re.compile(r"&&|\|\||;|\|")
TEST_RE = re.compile(r"(\d+) (passed|failed|error)")


def session_rows(usage: Path, sid: str) -> list[dict]:
    return summarize.priced([r for r in summarize._jsonl(usage) if r.get("session") == sid])


def bash_reads(cmd: str, cwd: str) -> list[str]:
    out = []
    for part in SPLIT_RE.split(cmd):
        try:
            words = shlex.split(part)
        except ValueError:
            continue
        if not words:
            continue
        if words[0] == "cd" and len(words) > 1:
            cwd = os.path.normpath(os.path.join(cwd, words[1]))
            continue
        if os.path.basename(words[0]) not in READERS:
            continue
        args = words[1:]
        if words[0] == "sed":  # sed -n 'RANGE' FILE...: drop the script
            args = [a for a in args if not a.startswith("-")][1:]
        for a in args:
            if a.startswith("-") or re.fullmatch(r"\d+", a) or a in (">", "<") or "*" in a:
                continue
            out.append(os.path.normpath(os.path.join(cwd, a)))
    return out


def tool_metrics(steps: list[dict], workdir: str) -> dict:
    calls = [t for s in steps for t in s["tools"]]
    reads: Counter = Counter()
    for t in calls:
        inp = t["input"] or {}
        if t["name"] == "Read" and inp.get("file_path"):
            reads[os.path.normpath(os.path.join(workdir, inp["file_path"]))] += 1
        elif t["name"] == "Bash":
            for p in bash_reads(str(inp.get("command") or ""), workdir):
                reads[p] += 1
    same = Counter((t["name"], json.dumps(t["input"], sort_keys=True)) for t in calls)
    return {"tool_calls": len(calls), "by_tool": dict(Counter(t["name"] for t in calls).most_common()),
            "files_read": len(reads), "reads": sum(reads.values()),
            "repeat_reads": sum(n - 1 for n in reads.values() if n > 1),
            "top_reread": [[p.replace(workdir + "/", ""), n] for p, n in reads.most_common(5) if n > 1],
            "repeat_calls": sum(n - 1 for n in same.values() if n > 1),
            "tool_errors": sum(1 for t in calls if t["is_error"])}


def trial(t: Path, usage: Path) -> dict:
    meta = json.loads((t / "meta.json").read_text())
    run = json.loads((t / "run.json").read_text())
    agent = t / "agent"
    log = parse_stream("\n".join(f.read_text(errors="replace") for f in sorted(agent.glob("cc-turn-*.jsonl"))))
    rows = session_rows(usage, meta["session"])
    tests = (t / "tests.log").read_text(errors="replace") if (t / "tests.log").is_file() else ""
    counts = Counter()
    for n, k in TEST_RE.findall(tests):
        counts[k] += int(n)
    res = log.result or {}
    out = {**meta, **run, "tests_pass": run["tests_rc"] == 0, "pytest_counts": dict(counts),
           **tool_metrics(steps_of(agent), meta["workdir"]),
           "requests": len(rows), "usd": round(sum(r["usd"] for r in rows), 4),
           "peak_prompt": max((r["prompt"] for r in rows), default=0),
           "trimmed_requests": sum(1 for r in rows if r.get("trimmed")),
           "compactions": len(log.compactions), "num_turns": res.get("num_turns"),
           "result_subtype": res.get("subtype"), "cc_cost_usd": res.get("total_cost_usd"),
           "watchdog": (agent / "watchdog.txt").read_text().strip() if (agent / "watchdog.txt").is_file() else None,
           "init_tools": log.init_tools, "init_mcp": log.init_mcp}
    return out


def report(results: Path) -> str:
    trials = [json.loads(p.read_text()) for p in sorted(results.glob("*/trials/*/trial.json"))]
    trials = [x for x in trials if not x.get("max_turns")]
    cols = ("task", "arm", "seed", "tests_pass", "tool_calls", "repeat_reads", "repeat_calls", "wall_s", "usd",
            "peak_prompt", "trimmed_requests", "compactions")
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for x in sorted(trials, key=lambda x: (x["task"], x["arm"], x["seed"])):
        lines.append("| " + " | ".join(
            f"{x[c]:.0f}" if c == "wall_s" else f"{x[c]:.2f}" if c == "usd" else str(x[c]) for c in cols) + " |")
    lines += ["", "| arm | n | tests_pass | tool_calls | repeat_reads | repeat_calls | wall_s | usd |", "|---|---|---|---|---|---|---|---|"]
    for arm in sorted({x["arm"] for x in trials}):
        xs = [x for x in trials if x["arm"] == arm]
        m = lambda k: sum(float(x[k]) for x in xs) / len(xs)  # noqa: E731
        lines.append(f"| {arm} | {len(xs)} | {sum(x['tests_pass'] for x in xs)}/{len(xs)} | {m('tool_calls'):.1f} | "
                     f"{m('repeat_reads'):.1f} | {m('repeat_calls'):.1f} | {m('wall_s'):.0f} | {m('usd'):.2f} |")
    lines.append(f"\ntotal usd {sum(x['usd'] for x in trials):.2f}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    match argv:
        case ["trial", t, usage]:
            print(json.dumps(trial(Path(t), Path(usage)), indent=1))
        case ["over", usage, sid, cap]:
            return 0 if sum(r["usd"] for r in session_rows(Path(usage), sid)) > float(cap) else 1
        case ["report", results]:
            print(report(Path(results)))
        case _:
            print(__doc__, file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
