"""ContextBench graders: one per task family, plus the shared context readers.

Every grader takes a run directory and the parsed ``gold.json`` and returns a
reward dict carrying ``graded_from`` -- the context source it actually read.
"""

from __future__ import annotations

import json
from pathlib import Path

from .base import (
    ContextSource,
    Grader,
    read_context,
    read_final_report,
    read_snapshots,
    read_trajectory,
)
from .decision import DecisionLedgerGrader
from .kv import KVStoreGrader
from .log import LogTriageGrader
from .needle import NeedleRetentionGrader
from .sudoku import SudokuSketchpadGrader

__all__ = [
    "ContextSource",
    "DecisionLedgerGrader",
    "Grader",
    "GRADERS",
    "KVStoreGrader",
    "LogTriageGrader",
    "NeedleRetentionGrader",
    "SudokuSketchpadGrader",
    "grade_run",
    "grader_for",
    "read_context",
    "read_final_report",
    "read_snapshots",
    "read_trajectory",
]

GRADERS: dict[str, type[Grader]] = {
    "kv_store": KVStoreGrader,
    "log_triage": LogTriageGrader,
    "needle_retention": NeedleRetentionGrader,
    "sudoku_sketchpad": SudokuSketchpadGrader,
    "decision_ledger": DecisionLedgerGrader,
}


def grader_for(family: str) -> Grader:
    """The grader instance for one family."""
    try:
        return GRADERS[family]()
    except KeyError:
        raise KeyError(
            f"no grader for family {family!r}; known: {', '.join(sorted(GRADERS))}"
        ) from None


def grade_run(run_dir: Path | str, gold: dict | Path | str) -> dict:
    """Grade a run directory against a gold object or a ``gold.json`` path.

    The family comes from ``gold["meta"]["task_family"]``, so a grader can never be
    pointed at the wrong family's instance by accident.
    """
    if not isinstance(gold, dict):
        gold = json.loads(Path(gold).read_text(encoding="utf-8"))
    family = (gold.get("meta") or {}).get("task_family")
    if not family:
        raise ValueError("gold.meta['task_family'] is missing: cannot pick a grader")
    return grader_for(family).grade(run_dir, gold)
