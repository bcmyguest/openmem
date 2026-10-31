"""``TurnSource``: the one place a Harbor agent gets its next ContextBench operation.

Every Harbor path (the shipped ``ContextBenchAgent``, ``Terminus2Stream``, and any
method adapter built outside this package) consumes the stream through this class,
so the delivery rules cannot drift between harnesses:

* the operations are read **once** from the container, from the
  ``stream/chunks.jsonl`` file Harbor uploads into the work directory, and checked
  against the op count and canonical body sha recorded in ``task.toml``;
* the file is then **removed** from the container, so the agent cannot read ahead
  with its shell (the only route an op has into the context is the user turn the
  harness appends);
* the next op is released only when the agent's last command was the standalone
  ``echo READY_FOR_NEXT_OP`` (see :func:`contextbench.stream.is_ready_command`);
* a submit before the stream is drained is refused with
  :data:`contextbench.stream.REFUSE_SUBMIT_TEXT`;
* ``terminated_by`` and the delivery log are written to
  ``<logs_dir>/interactive_stream.json`` after every change, so a run that is
  killed still leaves an accurate record.

The class is harness-agnostic: it never touches the message list. A harness asks
:meth:`TurnSource.pending` what to append after a tool result and appends the
returned texts as ``role="user"`` messages itself.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import posixpath
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from .. import stream as proto
from ..stream import Op, render_op

__all__ = [
    "ENV_STREAM_COUNT",
    "ENV_STREAM_PATH",
    "ENV_STREAM_SHA256",
    "STREAM_RECORD_NAME",
    "STREAM_RELPATH",
    "Delivery",
    "StreamIdentityError",
    "TurnSource",
    "canonical_sha256",
]

#: Where the stream lives relative to the task's ``environment/`` directory, and
#: therefore relative to the container work directory after Harbor's upload.
STREAM_RELPATH = "stream/chunks.jsonl"
#: Reads of the stream before giving up; each must parse and match the task identity.
READ_ATTEMPTS = 4
#: Seconds of back-off per retry (linear).
READ_BACKOFF_SEC = 2.0

#: ``[environment.env]`` keys that ``contextbench package`` writes into task.toml.
ENV_STREAM_COUNT = "CONTEXTBENCH_STREAM_COUNT"
ENV_STREAM_SHA256 = "CONTEXTBENCH_STREAM_SHA256"
ENV_STREAM_PATH = "CONTEXTBENCH_STREAM_PATH"

STREAM_RECORD_NAME = "interactive_stream.json"


class StreamIdentityError(RuntimeError):
    """The stream read from the container is not the one the task was built with."""


def canonical_sha256(records: Iterable[Mapping[str, Any]]) -> str:
    """sha256 over the ops as sorted-key JSON, one per line.

    Canonical rather than byte-level, so re-serializing ``chunks.jsonl`` (key order,
    trailing newline) does not change the identity, while any change to an op does.
    """
    canon = "\n".join(json.dumps(dict(r), sort_keys=True) for r in records)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _parse_records(text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


@dataclass
class Delivery:
    """One entry of the delivery log."""

    #: What was handed to the agent: ``op``, ``refuse_submit`` or ``explain``.
    kind: str
    #: The op index for ``kind == "op"``, else ``None``.
    index: int | None
    #: The command that triggered it (head and tail when long), or ``"<start>"``.
    trigger: str
    #: The harness's own turn counter at the time, when it passes one.
    turn: int | None = None
    #: Why it was handed over: ``start``, ``ready`` (standalone readiness command),
    #: ``submit`` (a submit before the drain), ``mention`` (non-standalone marker).
    via: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "index": self.index, "via": self.via,
                "trigger": self.trigger, "turn": self.turn}


def _excerpt(command: str, limit: int = 240) -> str:
    """The command as logged: whole when short, else head and tail."""
    cmd = (command or "").strip()
    if len(cmd) <= limit:
        return cmd
    half = limit // 2
    return cmd[:half] + " [...] " + cmd[-half:]


@dataclass
class TurnSource:
    """The operation stream of one trial, and its delivery bookkeeping."""

    ops: list[Op]
    logs_dir: Path | None = None
    #: How the stream was verified: ``{"count", "sha256", "path", "removed"}``.
    identity: dict[str, Any] = field(default_factory=dict)

    n_delivered: int = 0
    terminated_by: str | None = None
    n_refusals: int = 0
    n_explains: int = 0
    log: list[Delivery] = field(default_factory=list)

    # ---------------------------------------------------------------- building
    @classmethod
    def from_records(
        cls,
        records: list[Mapping[str, Any]],
        *,
        logs_dir: Path | str | None = None,
        expect_count: int | str | None = None,
        expect_sha256: str | None = None,
        identity: dict[str, Any] | None = None,
    ) -> "TurnSource":
        """Build from parsed ``chunks.jsonl`` records, verifying count and sha."""
        got_sha = canonical_sha256(records)
        if expect_count is not None and str(expect_count).strip() != "":
            if len(records) != int(str(expect_count).strip()):
                raise StreamIdentityError(
                    f"stream op count mismatch: read {len(records)}, task expects "
                    f"{str(expect_count).strip()}"
                )
        if expect_sha256 and got_sha != str(expect_sha256).strip():
            raise StreamIdentityError(
                f"stream sha256 mismatch: read {got_sha[:16]}, task expects "
                f"{str(expect_sha256).strip()[:16]}"
            )
        ops = [Op.from_dict(dict(r), fallback_index=i) for i, r in enumerate(records)]
        ident = {"count": len(records), "sha256": got_sha,
                 "verified": bool(expect_count is not None or expect_sha256)}
        ident.update(identity or {})
        src = cls(ops=ops, logs_dir=Path(logs_dir) if logs_dir else None,
                  identity=ident)
        src.write()
        return src

    @classmethod
    def from_jsonl(cls, text: str, **kwargs: Any) -> "TurnSource":
        return cls.from_records(_parse_records(text), **kwargs)

    @classmethod
    async def load(
        cls,
        environment: Any,
        *,
        logs_dir: Path | str | None = None,
        path: str | None = None,
        expect_count: int | str | None = None,
        expect_sha256: str | None = None,
        remove_after_load: bool = True,
        require_identity: bool = True,
    ) -> "TurnSource":
        """Read the stream out of a running Harbor environment.

        ``path``, ``expect_count`` and ``expect_sha256`` default to the
        ``CONTEXTBENCH_STREAM_*`` values in the task's ``[environment.env]``, then
        to the host process environment. Without a path, the stream is looked up
        at ``<workdir>/stream/chunks.jsonl``. With ``require_identity`` (the
        default) a task that records no count or sha is refused: an unverified
        stream could be another task's.
        """
        env_cfg = _task_env(environment)

        def _setting(name: str, given: Any) -> Any:
            if given is not None:
                return given
            return env_cfg.get(name) or os.environ.get(name)

        expect_count = _setting(ENV_STREAM_COUNT, expect_count)
        expect_sha256 = _setting(ENV_STREAM_SHA256, expect_sha256)
        path = _setting(ENV_STREAM_PATH, path)
        if require_identity and not (expect_count or expect_sha256):
            raise StreamIdentityError(
                f"the task records no {ENV_STREAM_COUNT} / {ENV_STREAM_SHA256}; "
                "refusing to deliver an unverifiable stream (rebuild the task with "
                "`contextbench package`)"
            )
        if not path:
            workdir = getattr(getattr(environment, "task_env_config", None),
                              "workdir", None)
            if not workdir:
                res = await environment.exec("pwd", timeout_sec=30)
                workdir = (getattr(res, "stdout", "") or "/").strip() or "/"
            path = posixpath.join(workdir, STREAM_RELPATH)

        # Read, parse and verify before removing anything. Under concurrent exec
        # load the captured stdout can come back truncated; a verified retry
        # recovers it, and the file is only deleted once a read has matched.
        last_err: Exception | None = None
        records: list[dict[str, Any]] = []
        for attempt in range(READ_ATTEMPTS):
            if attempt:
                await asyncio.sleep(READ_BACKOFF_SEC * attempt)
            res = await environment.exec(f"cat {shlex.quote(path)}", timeout_sec=120)
            if getattr(res, "return_code", 1) != 0:
                last_err = RuntimeError(
                    f"could not read the stream at {path} in the container: "
                    f"{(getattr(res, 'stderr', '') or getattr(res, 'stdout', ''))[:300]}"
                )
                continue
            try:
                records = _parse_records(getattr(res, "stdout", "") or "")
                if not records:
                    raise RuntimeError(f"the stream at {path} is empty")
                cls.from_records(records, expect_count=expect_count,
                                 expect_sha256=expect_sha256)
            except (json.JSONDecodeError, StreamIdentityError, RuntimeError) as err:
                last_err = err
                records = []
                continue
            break
        if not records:
            raise StreamIdentityError(
                f"stream at {path} failed verification after {READ_ATTEMPTS} reads: "
                f"{last_err}"
            ) from last_err

        removed = False
        if remove_after_load:
            stream_dir = posixpath.dirname(path)
            await environment.exec(f"rm -rf {shlex.quote(stream_dir)}", timeout_sec=60)
            check = await environment.exec(
                f"test -e {shlex.quote(path)}", timeout_sec=30
            )
            removed = getattr(check, "return_code", 0) != 0
            if not removed:
                raise RuntimeError(
                    f"could not remove {path} after loading it: the agent could read "
                    "ahead in the stream"
                )
        return cls.from_records(
            records,
            logs_dir=logs_dir,
            expect_count=expect_count,
            expect_sha256=expect_sha256,
            identity={"path": path, "removed": removed},
        )

    # -------------------------------------------------------------- properties
    @property
    def n_total(self) -> int:
        return len(self.ops)

    @property
    def drained(self) -> bool:
        """True once every op has been delivered."""
        return self.n_delivered >= self.n_total

    @property
    def done(self) -> bool:
        """True once the run has a terminal reason; the harness should stop."""
        return self.terminated_by is not None

    # ----------------------------------------------------------------- delivery
    def _deliver(self, trigger: str, turn: int | None) -> str:
        index = self.n_delivered
        text = render_op(self.ops[index], remaining=self.n_total - (index + 1))
        self.n_delivered += 1
        self.log.append(Delivery("op", index, trigger, turn,
                                 "start" if trigger == "<start>" else "ready"))
        self.write()
        return text

    def first_turn(self, *, turn: int | None = None) -> str | None:
        """Op 0, delivered with the instruction. ``None`` for an empty stream."""
        if self.n_delivered:
            raise RuntimeError("first_turn() called after delivery started")
        if not self.ops:
            self.terminate("stream_exhausted")
            return None
        return self._deliver("<start>", turn)

    def pending(
        self, last_command: str | None, last_exit: int | None = 0, *,
        turn: int | None = None,
    ) -> list[str]:
        """The user turns to append after the tool result of ``last_command``.

        * standalone readiness, ops left: ``[next op]``;
        * standalone readiness, stream drained: ``[]`` and ``terminated_by =
          "stream_exhausted"`` (the harness must stop);
        * standalone submit, ops left: ``[REFUSE_SUBMIT_TEXT]``;
        * standalone submit, drained: ``[]`` and ``terminated_by = "submit"``;
        * the marker mentioned but not standalone: ``[EXPLAIN_NON_STANDALONE_TEXT]``;
        * anything else: ``[]``.

        ``last_exit`` is the command's exit code; ``None`` means the harness cannot
        observe it (a terminal multiplexer), which is treated as success.
        """
        if self.done:
            return []
        cmd = last_command or ""
        code = 0 if last_exit is None else int(last_exit)
        trigger = _excerpt(cmd)
        if proto.is_ready_command(cmd, code):
            if self.drained:
                self.terminate("stream_exhausted")
                return []
            return [self._deliver(trigger, turn)]
        if proto.is_submit_command(cmd, code):
            return self.on_submit(trigger=trigger, turn=turn)
        if proto.mentions_advance_marker(cmd):
            self.n_explains += 1
            self.log.append(Delivery("explain", None, trigger, turn, "mention"))
            self.write()
            return [proto.EXPLAIN_NON_STANDALONE_TEXT]
        return []

    def on_submit(self, *, trigger: str = "<submit>", turn: int | None = None) -> list[str]:
        """The agent asked to finish (by command or by the harness's own signal).

        Before the stream is drained this is refused, and the refusal text is
        returned for the harness to deliver; afterwards the run ends as ``submit``.
        """
        if self.done:
            return []
        if not self.drained:
            self.n_refusals += 1
            self.log.append(Delivery("refuse_submit", None, _excerpt(trigger), turn,
                                     "submit"))
            self.write()
            return [proto.REFUSE_SUBMIT_TEXT]
        self.terminate("submit")
        return []

    def terminate(self, reason: str) -> None:
        """Record the terminal reason once; later calls do not overwrite it."""
        if reason not in proto.TERMINATED_BY:
            raise ValueError(f"unknown terminated_by {reason!r}")
        if self.terminated_by is None:
            self.terminated_by = reason
            self.write()

    # ------------------------------------------------------------------ record
    def record(self) -> dict[str, Any]:
        return {
            "n_ops_delivered": self.n_delivered,
            "n_ops_total": self.n_total,
            "terminated_by": self.terminated_by,
            "n_refusals": self.n_refusals,
            "n_explains": self.n_explains,
            "stream": self.identity,
            "log": [d.to_dict() for d in self.log],
        }

    def write(self, logs_dir: Path | str | None = None) -> Path | None:
        """Write ``interactive_stream.json``. Best effort: never raises."""
        target = Path(logs_dir) if logs_dir else self.logs_dir
        if target is None:
            return None
        try:
            target.mkdir(parents=True, exist_ok=True)
            out = target / STREAM_RECORD_NAME
            out.write_text(json.dumps(self.record(), indent=2) + "\n", encoding="utf-8")
            return out
        except Exception:
            return None


def _task_env(environment: Any) -> dict[str, str]:
    cfg = getattr(environment, "task_env_config", None)
    env = getattr(cfg, "env", None) or {}
    try:
        return {str(k): str(v) for k, v in dict(env).items()}
    except Exception:
        return {}
