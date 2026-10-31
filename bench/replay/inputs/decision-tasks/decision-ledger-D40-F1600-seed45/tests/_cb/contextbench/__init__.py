"""ContextBench: benchmarking what an agent keeps, updates, and offloads.

Four task families stream more input than fits in an agent's context window and
grade what survived. Everything the agent has to do is expressed as ordinary user
turns, so any chat agent can be evaluated.

Quickstart::

    from contextbench import run
    from contextbench.oracle import OracleAgent  # task self-check only, not a baseline

    result = run(OracleAgent(instance_dir), instance_dir, budget=32768,
                 reserve=2048, out_dir="runs/kv-R1000-seed42")
    print(result["reward"], result["terminated_by"])

The core imports nothing outside the standard library: ``tiktoken`` and
``harbor`` are optional extras and never required to generate, run or grade.
"""

from __future__ import annotations

from .graders import grade_run, grader_for
from .runner import (
    DEFAULT_SYSTEM_PROMPT,
    ContextAgent,
    Instance,
    instruction_for,
    load_instance,
    run,
)
from .stream import ADVANCE_MARKER, SUBMIT_MARKER, TERMINATED_BY, Op, render_op
from .tokens import count_tokens, record_snapshot

__version__ = "0.1.0"

FAMILIES = ("kv_store", "log_triage", "needle_retention", "sudoku_sketchpad")

__all__ = [
    "ADVANCE_MARKER",
    "ContextAgent",
    "DEFAULT_SYSTEM_PROMPT",
    "FAMILIES",
    "Instance",
    "Op",
    "SUBMIT_MARKER",
    "TERMINATED_BY",
    "__version__",
    "count_tokens",
    "grade_run",
    "grader_for",
    "instruction_for",
    "load_instance",
    "record_snapshot",
    "render_op",
    "run",
]
