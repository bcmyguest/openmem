"""Grade a Harbor trial's agent directory and write Harbor's reward files.

Shared by the two ways a ContextBench task is verified:

* in the container, by the task's own ``tests/test.sh`` (Harbor's default verifier:
  no flag needed), which runs ``python3 -m contextbench.harbor.reward`` against a
  copy of the graders vendored into ``tests/_cb/``;
* on the host, by ``contextbench.harbor.verifiers:ContextBenchVerifier``, for images
  without ``python3``.

Harbor's reward dict must be numeric (its job-level mean sums every key), so the
string fields are encoded: ``graded_from_code`` (3 snapshots, 2 trajectory,
1 final_report, 0 none) and ``terminated_by_code`` (index into
``contextbench.stream.TERMINATED_BY``, -1 unknown). The unencoded result goes to
``contextbench_result.json`` next to ``reward.json``.

Pure standard library: this module runs inside task containers.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ..graders import grade_run
from ..stream import TERMINATED_BY

__all__ = ["GRADED_FROM_CODES", "harbor_rewards", "write_rewards", "main"]

GRADED_FROM_CODES = {"snapshots": 3, "trajectory": 2, "final_report": 1, "none": 0}

STREAM_RECORD_NAME = "interactive_stream.json"


def harbor_rewards(agent_dir: Path | str, gold: dict) -> tuple[dict, dict]:
    """``(numeric reward dict, full result dict)`` for one agent directory."""
    agent_dir = Path(agent_dir)
    rewards = grade_run(agent_dir, gold)
    stream: dict[str, Any] = {}
    record = agent_dir / STREAM_RECORD_NAME
    if record.is_file():
        try:
            stream = json.loads(record.read_text(encoding="utf-8"))
        except Exception:
            stream = {}
    numeric: dict[str, float | int] = {
        k: v for k, v in rewards.items()
        if isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    numeric["graded_from_code"] = GRADED_FROM_CODES.get(str(rewards.get("graded_from")), 0)
    terminated_by = stream.get("terminated_by")
    numeric["terminated_by_code"] = (
        TERMINATED_BY.index(terminated_by) if terminated_by in TERMINATED_BY else -1
    )
    for key in ("n_ops_delivered", "n_ops_total", "n_refusals"):
        if isinstance(stream.get(key), int):
            numeric[key] = stream[key]
    full = {
        "rewards": rewards,
        "graded_from": rewards.get("graded_from"),
        "terminated_by": terminated_by,
        "agent_dir": str(agent_dir),
        "stream": {k: v for k, v in stream.items() if k != "log"},
    }
    return numeric, full


def write_rewards(agent_dir: Path | str, gold: dict | Path | str,
                  out_dir: Path | str) -> dict:
    """Grade and write ``reward.json`` + ``contextbench_result.json``; return numeric."""
    if not isinstance(gold, dict):
        gold = json.loads(Path(gold).read_text(encoding="utf-8"))
    numeric, full = harbor_rewards(agent_dir, gold)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "contextbench_result.json").write_text(
        json.dumps(full, indent=2, default=str) + "\n", encoding="utf-8")
    (out / "reward.json").write_text(json.dumps(numeric, indent=2) + "\n",
                                     encoding="utf-8")
    return numeric


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--agent-dir", type=Path, default=Path("/logs/agent"))
    ap.add_argument("--gold", type=Path, default=Path("/tests/gold.json"))
    ap.add_argument("--out-dir", type=Path, default=Path("/logs/verifier"))
    a = ap.parse_args(argv)
    numeric = write_rewards(a.agent_dir, a.gold, a.out_dir)
    print(json.dumps(numeric))
    return 0


if __name__ == "__main__":
    sys.exit(main())
