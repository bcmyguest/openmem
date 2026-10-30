"""Checks for run_strict.sh.

    python strict_check.py smoke <smoke_dir> <results_dir>   # per arm: tools list, MCP status, proxy rows
    python strict_check.py no-model-calls <results_dir>      # "<arm> <task> <trial dir name>" per trial to retry

A trial "failed before any model call" when Harbor recorded an exception and the arm's usage.jsonl has no
row for the trial's Claude Code session (or the adapter never wrote cc_stream.json).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cc_stream import parse_stream  # noqa: E402

INTENDED_S3 = ["mcp__openmem__smart_compact_search", "mcp__openmem__smart_compact_get"]


def _jsonl(path: Path) -> list[dict]:
    out = []
    if path.is_file():
        for line in path.read_text(errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def _trials(trials_dir: Path):
    if trials_dir.is_dir():
        for t in sorted(p for p in trials_dir.iterdir() if (p / "result.json").is_file()):
            yield t


def smoke(out: Path, results: Path) -> int:
    bad = 0
    for arm_dir in sorted(p for p in out.iterdir() if p.is_dir()):
        arm = arm_dir.name
        for t in _trials(arm_dir):
            res = json.loads((t / "result.json").read_text())
            meta_p = t / "agent" / "cc_stream.json"
            meta = json.loads(meta_p.read_text()) if meta_p.is_file() else {}
            sid = meta.get("session_id")
            rows = [r for r in _jsonl(results / arm / "usage.jsonl") if r.get("session") == sid]
            tags = sorted({(r.get("arm"), r.get("arm_header")) for r in rows}, key=str)
            turns = sorted((t / "agent").glob("cc-turn-*.jsonl"))
            first = parse_stream(turns[0].read_text(errors="replace")) if turns else None
            tools = first.init_tools if first else None
            mcp = first.init_mcp if first else None
            want = INTENDED_S3 if arm.startswith("s3") else []
            ok = (sorted(tools or []) == sorted(want) and bool(rows)
                  and all(a == arm and h == arm for a, h in tags))
            if want:
                ok = ok and any(m.get("name") == "openmem" and m.get("status") == "connected" for m in mcp or [])
            bad += not ok
            print(json.dumps({
                "arm": arm, "ok": ok, "trial": t.name, "session": sid, "turns": len(turns),
                "init_tools": tools, "init_mcp_servers": mcp, "proxy_rows": len(rows),
                "proxy_ok_rows": sum(1 for r in rows if r.get("ok")), "arm_tags": tags,
                "ops_delivered": meta.get("n_ops_delivered"), "terminated_by": meta.get("terminated_by"),
                "tool_uses": meta.get("tool_uses"),
                "exception": (res.get("exception_info") or {}).get("exception_type"),
                "reply_tail": (first.reply[-120:] if first else None),
            }))
    return 1 if bad else 0


def no_model_calls(results: Path) -> int:
    for arm_dir in sorted(p for p in results.iterdir() if p.is_dir()):
        usage = _jsonl(arm_dir / "usage.jsonl")
        sessions = {r.get("session") for r in usage}
        for t in _trials(arm_dir / "trials"):
            res = json.loads((t / "result.json").read_text())
            if not res.get("exception_info"):
                continue
            meta_p = t / "agent" / "cc_stream.json"
            sid = json.loads(meta_p.read_text()).get("session_id") if meta_p.is_file() else None
            if sid is None or sid not in sessions:
                if t.name.endswith(".retry1"):
                    continue  # retried once already
                task = res.get("task_name") or t.name.split("__")[0]
                print(arm_dir.name, task, t.name)
    return 0


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "smoke":
        sys.exit(smoke(Path(sys.argv[2]), Path(sys.argv[3])))
    if mode == "no-model-calls":
        sys.exit(no_model_calls(Path(sys.argv[2])))
    sys.exit(f"unknown mode {mode}")
