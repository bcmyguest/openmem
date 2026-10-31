"""``CBStreamMixin``: ContextBench support for any Python agent loop under Harbor.

Add the mixin to your Harbor agent and three calls to its loop::

    class MyAgent(CBStreamMixin, BaseAgent):
        async def run(self, instruction, environment, context):
            await self.cb_setup(environment)                               # 1
            messages = [system, {"role": "user", "content": instruction}]
            messages += self.cb_user_turns(self.cb_initial_turns())
            while not self.cb_done:
                ...                                                        # model call
                messages.append(tool_result_message)
                messages += self.cb_user_turns(                            # 2
                    self.cb_pending(command, exit_code))
                if self.cb_over_budget(messages):                          # 3
                    break

The mixin owns everything else: loading and verifying the stream (and removing it
from the container), the readiness rule, the early-submit refusal, the terminal
reason, ``interactive_stream.json`` and the ``context_snapshots/turn-NNNN.json`` the
graders read. ``cb_over_budget`` both snapshots the context you are about to send
and enforces the budget wall on it; call it right before every model call (or where
your loop sends), and call :meth:`cb_finish` in a ``finally``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..tokens import count_tokens, record_snapshot
from .turn_source import TurnSource

__all__ = ["CBStreamMixin"]


class CBStreamMixin:
    """Stream delivery, snapshots and the budget wall for a Harbor agent loop."""

    logs_dir: Path

    #: Budget of record; override per instance with ``cb_setup(budget=...)``.
    cb_budget: int = 32768
    cb_reserve: int = 2048

    # ------------------------------------------------------------------ setup
    async def cb_setup(self, environment: Any, *, budget: int | None = None,
                       reserve: int | None = None, **load_kwargs: Any) -> TurnSource:
        """Load the task's stream (verified, then removed from the container)."""
        if budget is not None:
            self.cb_budget = int(budget)
        if reserve is not None:
            self.cb_reserve = int(reserve)
        self.cb_source = await TurnSource.load(
            environment, logs_dir=self.logs_dir, **load_kwargs)
        self._cb_snap_step = 0
        self.cb_peak_tokens = 0
        return self.cb_source

    @property
    def cb_turn_source(self) -> TurnSource | None:
        return getattr(self, "cb_source", None)

    # --------------------------------------------------------------- delivery
    def cb_initial_turns(self) -> list[str]:
        """The user turns to append after the instruction: op 0."""
        first = self.cb_source.first_turn(turn=0)
        return [first] if first is not None else []

    def cb_pending(self, last_command: str | None, last_exit: int | None = 0, *,
                   turn: int | None = None) -> list[str]:
        """The user turns to append right after the tool result of ``last_command``."""
        return self.cb_source.pending(last_command, last_exit, turn=turn)

    def cb_submit(self, *, trigger: str = "<submit>") -> list[str]:
        """The harness's own finish signal: refused (texts returned) until the drain."""
        return self.cb_source.on_submit(trigger=trigger)

    @property
    def cb_done(self) -> bool:
        src = self.cb_turn_source
        return bool(src and src.done)

    @staticmethod
    def cb_user_turns(texts: list[str]) -> list[dict[str, str]]:
        return [{"role": "user", "content": t} for t in texts]

    # ------------------------------------------------------ snapshots and wall
    def cb_snapshot(self, messages: list[Any], kind: str = "sent",
                    extra: dict[str, Any] | None = None) -> int:
        """Write ``context_snapshots/turn-NNNN.json``; returns its token count."""
        src = self.cb_turn_source
        tokens, _ = count_tokens(messages)
        self.cb_peak_tokens = max(getattr(self, "cb_peak_tokens", 0), tokens)
        step = getattr(self, "_cb_snap_step", 0)
        record_snapshot(
            self.logs_dir, step, list(messages),
            {"kind": kind, "n_ops_delivered": src.n_delivered if src else 0,
             "n_ops_total": src.n_total if src else 0,
             "budget": self.cb_budget, "reserve": self.cb_reserve, **(extra or {})},
        )
        self._cb_snap_step = step + 1
        return tokens

    def cb_over_budget(self, messages: list[Any]) -> bool:
        """Snapshot what is about to be sent; True (and ``budget_wall``) if it is over."""
        if self.cb_snapshot(messages, "sent") > self.cb_budget - self.cb_reserve:
            self.cb_source.terminate("budget_wall")
            return True
        return False

    def cb_finish(self, reason: str | None = None,
                  messages: list[Any] | None = None) -> None:
        """Record a terminal reason if none was set, snapshot the final context."""
        src = self.cb_turn_source
        if src is None:
            return
        if reason and not src.done:
            src.terminate(reason)
        if messages is not None:
            self.cb_snapshot(messages, "final")
        src.write()
