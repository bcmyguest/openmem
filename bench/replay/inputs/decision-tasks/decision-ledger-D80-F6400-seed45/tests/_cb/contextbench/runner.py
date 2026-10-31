"""The pure-Python ContextBench runner.

The runner owns the turn protocol so an agent does not have to. It delivers one
operation per user turn, advances only on a standalone readiness marker, refuses an
early submit, enforces the budget wall on the agent's own reported context,
snapshots that context after every turn, and grades the run at the end.

The invariant the runner exists to hold: an operation enters the agent's context as
a user message appended by the runner, before the agent can act on it. The agent
controls only *when* the next operation arrives, never its content or its route
into the context.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from . import stream as proto
from .graders import grade_run
from .stream import Op, render_op
from .tokens import count_tokens, record_snapshot

__all__ = [
    "ContextAgent",
    "Instance",
    "DEFAULT_SYSTEM_PROMPT",
    "load_instance",
    "run",
]

DEFAULT_SYSTEM_PROMPT = (
    "You are a careful assistant working through a long stream of operations that "
    "does not fit in your context window. Handle each operation as it arrives, keep "
    "in your context exactly what later operations will need, and let go of the "
    "rest.\n\n" + proto.MARKER_PARAGRAPH_REPLY
)


@runtime_checkable
class ContextAgent(Protocol):
    """What the runner needs from an agent.

    ``reset`` starts a fresh episode with the system prompt and the family
    instruction. ``on_user_turn`` receives one user message -- an operation, or a
    protocol message from the runner -- and returns the reply text. ``context``
    returns the agent's current message list, which the runner snapshots and
    measures against the budget: an agent that hides its context from the runner
    cannot be graded on the paper metric.
    """

    def reset(self, system: str, instruction: str) -> None: ...

    def on_user_turn(self, text: str) -> str: ...

    def context(self) -> list[dict]: ...


@dataclass(frozen=True)
class Instance:
    """One generated instance on disk."""

    path: Path
    family: str
    ops: list[Op]
    gold: dict
    meta: dict

    @property
    def n_ops(self) -> int:
        return len(self.ops)


def load_instance(instance_dir: Path | str) -> Instance:
    """Read ``chunks.jsonl``, ``gold.json`` and ``meta.json`` from a directory."""
    d = Path(instance_dir)
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    gold = json.loads((d / "gold.json").read_text(encoding="utf-8"))
    ops = proto.load_ops((d / "chunks.jsonl").read_text(encoding="utf-8").splitlines())
    family = meta.get("task_family") or (gold.get("meta") or {}).get("task_family")
    if not family:
        raise ValueError(f"{d}: meta.json has no task_family")
    return Instance(path=d, family=family, ops=ops, gold=gold, meta=meta)


def instruction_for(instance: Instance, *, delivery: str = "reply") -> str:
    """The instruction text for an instance's family."""
    import importlib

    module = importlib.import_module(
        f"contextbench.tasks.{instance.family}.generate"
    )
    return module.instruction(instance.gold, delivery=delivery)


def run(
    agent: ContextAgent,
    instance_dir: Path | str,
    *,
    budget: int = 32768,
    reserve: int = 2048,
    out_dir: Path | str = "runs/latest",
    max_turns: int | None = None,
    system_prompt: str | None = None,
    delivery: str = "reply",
    overwrite: bool = False,
) -> dict:
    """Run one instance end to end and return the result dict.

    ``budget`` and ``reserve`` set the wall: a turn whose snapshot exceeds
    ``budget - reserve`` tokens ends the run with ``terminated_by="budget_wall"``,
    because a real serving stack would have refused the next request. ``max_turns``
    is a safety stop, not part of the task: leave it unset for a full horizon.

    Writes ``context_snapshots/turn-NNNN.json`` per turn, ``interactive_stream.json``
    and ``result.json`` into ``out_dir``, and returns the same result dict.

    ``out_dir`` must be empty or absent: the graders read every snapshot in it, so
    files from an earlier run would be credited to this one. ``overwrite=True``
    deletes an existing ``out_dir`` first.
    """
    instance = load_instance(instance_dir)
    out = Path(out_dir)
    if out.exists() and any(out.iterdir()):
        if not overwrite:
            raise FileExistsError(
                f"{out} is not empty; the graders would read its old snapshots as part "
                "of this run. Use a fresh directory or pass overwrite=True."
            )
        import shutil

        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    usable = budget - reserve

    instruction = instruction_for(instance, delivery=delivery)
    agent.reset(system_prompt or DEFAULT_SYSTEM_PROMPT, instruction)

    total_ops = instance.n_ops
    delivered = 0
    step = 0
    terminated_by: str | None = None
    peak_tokens = 0

    def _deliver_op(index: int) -> str:
        return render_op(instance.ops[index], remaining=total_ops - (index + 1))

    if total_ops == 0:
        terminated_by = "stream_exhausted"
        pending: str | None = None
    else:
        pending = _deliver_op(0)
        delivered = 1

    while pending is not None and terminated_by is None:
        reply = agent.on_user_turn(pending) or ""
        step += 1

        messages = list(agent.context() or [])
        tokens, _ = count_tokens(messages)
        peak_tokens = max(peak_tokens, tokens)
        record_snapshot(
            out,
            step,
            messages,
            {
                "n_ops_delivered": delivered,
                "n_ops_total": total_ops,
                "budget": budget,
                "reserve": reserve,
            },
        )

        if tokens > usable:
            terminated_by = "budget_wall"
            break

        if proto.is_submit_line(reply) or proto.is_submit_command(reply):
            if delivered < total_ops:
                pending = proto.REFUSE_SUBMIT_TEXT
            else:
                terminated_by = "submit"
                break
        elif proto.is_ready_line(reply) or proto.is_ready_command(reply):
            if delivered < total_ops:
                pending = _deliver_op(delivered)
                delivered += 1
            else:
                terminated_by = "stream_exhausted"
                break
        elif proto.mentions_advance_marker(reply):
            pending = proto.EXPLAIN_NON_STANDALONE_TEXT
        else:
            pending = proto.NO_MARKER_TEXT

        if max_turns is not None and step >= max_turns:
            terminated_by = "max_steps"
            break

    if terminated_by is None:
        terminated_by = "stream_exhausted"

    stream_record = {
        "n_ops_delivered": delivered,
        "n_ops_total": total_ops,
        "terminated_by": terminated_by,
    }
    (out / "interactive_stream.json").write_text(
        json.dumps(stream_record, indent=2) + "\n", encoding="utf-8"
    )

    rewards = grade_run(out, instance.gold)
    result: dict[str, Any] = {
        "task_family": instance.family,
        "instance_dir": str(instance.path),
        "out_dir": str(out),
        "budget": budget,
        "reserve": reserve,
        "n_turns": step,
        "peak_tokens": peak_tokens,
        "reward": rewards.get("reward", 0.0),
        "rewards": rewards,
        **stream_record,
    }
    (out / "result.json").write_text(
        json.dumps(result, indent=2, default=str) + "\n", encoding="utf-8"
    )
    return result
