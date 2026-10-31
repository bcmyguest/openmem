"""Grader for *Needle Retention*: what is still in the context at the end.

The reward is the fraction of gold needle lines present verbatim in the agent's
final retained context. Two modes, and which one ran is recorded as ``mode`` and
``graded_from``:

* ``final_context`` (the paper metric) -- the last per-turn snapshot, or an ATIF
  ``trajectory.json``, is the retained context: context edits mutate that message
  list in place, so the final state is exactly what the agent kept.
* ``final_report`` -- for an agent that cannot expose its context at all, the kept
  lines are read from between ``<<<NEEDLES BEGIN>>>`` and ``<<<NEEDLES END>>>`` in
  its closing report. A report is a weaker witness than a context: the agent could
  in principle re-read the lines from somewhere else, so the two modes are not
  interchangeable and are never averaged together.

Rewards: ``reward``, ``matched``, ``total``, ``mode``, ``graded_from``.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import (
    Grader,
    messages_text,
    normalize,
    read_final_report,
    read_snapshots,
    read_trajectory,
)

__all__ = ["NeedleRetentionGrader", "NEEDLES_BLOCK_RE", "extract_reported_needles"]

#: The block an agent without context access prints instead.
NEEDLES_BLOCK_RE = re.compile(
    r"<<<\s*NEEDLES\s+BEGIN\s*>>>(.*?)<<<\s*NEEDLES\s+END\s*>>>",
    re.DOTALL | re.IGNORECASE,
)


def extract_reported_needles(text: str) -> set[str]:
    """The normalized lines inside every ``NEEDLES`` block of ``text``."""
    lines: set[str] = set()
    for block in NEEDLES_BLOCK_RE.findall(text or ""):
        for line in block.splitlines():
            if line.strip():
                lines.add(normalize(line))
    return lines


class NeedleRetentionGrader(Grader):
    family = "needle_retention"

    def grade(self, run_dir: Path | str, gold: dict) -> dict:
        gold_lines = {normalize(s) for s in gold.get("answer_lines") or []}
        total = len(gold_lines)

        snapshots = read_snapshots(run_dir)
        if snapshots is not None:
            present = self._context_lines(messages_text(snapshots.final_frame))
            return self._result(
                gold_lines, present, total, "final_context", "snapshots",
                snapshots.n_snapshots, snapshots.tokens,
            )

        trajectory = read_trajectory(run_dir)
        if trajectory is not None:
            present = self._context_lines(messages_text(trajectory.final_frame))
            return self._result(
                gold_lines, present, total, "final_context", "trajectory", 0, []
            )

        report = read_final_report(run_dir)
        if report:
            return self._result(
                gold_lines, extract_reported_needles(report), total,
                "final_report", "final_report", 0, [],
            )
        return self._invalid("none", "no context snapshots, trajectory or report")

    @staticmethod
    def _context_lines(text: str) -> set[str]:
        return {normalize(line) for line in text.splitlines() if line.strip()}

    def _result(
        self,
        gold_lines: set[str],
        present: set[str],
        total: int,
        mode: str,
        graded_from: str,
        n_snapshots: int,
        tokens: list[int],
    ) -> dict:
        if total == 0:
            return self._invalid(graded_from, "gold has no answer_lines")
        matched = gold_lines & present
        result = {
            "reward": len(matched) / total,
            "matched": float(len(matched)),
            "total": float(total),
            "mode": mode,
            "n_snapshots": float(n_snapshots),
            "graded_from": graded_from,
            "grader_valid": 1.0,
        }
        result.update(self._token_stats(tokens))
        return result
