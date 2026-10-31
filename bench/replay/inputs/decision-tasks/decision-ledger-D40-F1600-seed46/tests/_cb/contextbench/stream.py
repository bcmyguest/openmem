"""The ContextBench turn protocol: op rendering, readiness detection, refusals.

Pure Python. This module is the single definition of how an operation reaches the
agent and how the agent asks for the next one, so the Python runner and (phase 2)
the Harbor adapters cannot drift apart.

Readiness has two equivalent forms:

* ``READY_FOR_NEXT_OP`` as a **standalone line** of the reply -- for chat agents
  driven by :mod:`contextbench.runner`, which have no shell;
* ``echo READY_FOR_NEXT_OP`` as a **standalone shell statement** -- for agents
  with a bash tool, where the marker is a command the harness executes.

Both are deliberately strict about "standalone": the marker must not count when it
merely appears as an argument (``grep READY_FOR_NEXT_OP file``) or inside answer
data, because a spurious advance consumes an operation that is then lost forever.
A command that failed (non-zero exit) never advances either: the step did not
finish, so the op must not be handed over.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

__all__ = [
    "ADVANCE_MARKER",
    "SUBMIT_MARKER",
    "TERMINATED_BY",
    "Op",
    "render_op",
    "is_ready_line",
    "is_ready_command",
    "mentions_advance_marker",
    "is_submit_line",
    "is_submit_command",
    "mentions_submit_marker",
    "REFUSE_SUBMIT_TEXT",
    "EXPLAIN_NON_STANDALONE_TEXT",
    "NO_MARKER_TEXT",
    "SUBMIT_PARAGRAPH",
    "MARKER_PARAGRAPH",
    "MARKER_PARAGRAPH_REPLY",
]

ADVANCE_MARKER = "READY_FOR_NEXT_OP"
SUBMIT_MARKER = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"

#: Every way a ContextBench run can end. ``timeout`` is produced by wall-clock
#: enforcement in the container runners; the pure-Python runner produces the
#: other four.
TERMINATED_BY = (
    "submit",
    "stream_exhausted",
    "budget_wall",
    "timeout",
    "max_steps",
)


def _standalone_line_re(marker: str) -> re.Pattern[str]:
    """The marker alone on a line, tolerating whitespace and code-fence quoting."""
    return re.compile(
        rf"^[ \t]*(?:`{{1,3}})?{re.escape(marker)}(?:`{{1,3}})?[ \t]*\.?[ \t]*$",
        re.MULTILINE,
    )


def _standalone_command_re(marker: str) -> re.Pattern[str]:
    """``echo MARKER`` as a whole shell statement (quotes optional)."""
    return re.compile(
        rf"""^\s*(?:/bin/)?echo\s+(?:['"])?{re.escape(marker)}(?:['"])?\s*$"""
    )


_READY_LINE_RE = _standalone_line_re(ADVANCE_MARKER)
_READY_SEGMENT_RE = _standalone_command_re(ADVANCE_MARKER)
_SUBMIT_LINE_RE = _standalone_line_re(SUBMIT_MARKER)
_SUBMIT_SEGMENT_RE = _standalone_command_re(SUBMIT_MARKER)

#: Statements are split on ``;``, newline, ``&&`` and ``||`` outside quotes (see
#: :func:`_split_unquoted`). A bundled command such as
#: ``printf '<<<ANSWER ...>>>'; echo READY_FOR_NEXT_OP`` advances, because its
#: last statement is a clean echo.
_HEREDOC_OPEN = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")


def _strip_heredoc_bodies(command: str) -> str:
    """Drop the body lines of every here-document; keep the line that opens it.

    A here-document body is data fed to a program, not shell statements, so an
    ``echo READY_FOR_NEXT_OP`` line inside it never runs and must not count.
    """
    lines = command.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        pending = _HEREDOC_OPEN.findall(line)
        i += 1
        for dash, _quote, word in pending:
            while i < len(lines):
                body_line = lines[i]
                i += 1
                if (body_line.lstrip("\t") if dash else body_line) == word:
                    break
    return "\n".join(out)


def _split_unquoted(text: str) -> list[str]:
    """Split on ``;``, newline, ``&&`` and ``||`` outside quotes.

    Single quotes are literal to the closing quote; double quotes honour backslash
    escapes; a backslash outside quotes escapes the next character. A separator inside
    quotes is data (``printf '%s' 'a;echo READY_FOR_NEXT_OP;b'`` is one statement).
    An unterminated quote keeps the rest of the text in the current statement.
    """
    segments: list[str] = []
    buf: list[str] = []
    quote: str | None = None
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if quote == "'":
            buf.append(c)
            if c == "'":
                quote = None
            i += 1
            continue
        if quote == '"':
            buf.append(c)
            if c == "\\" and i + 1 < n:
                buf.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                quote = None
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            buf.append(text[i:i + 2])
            i += 2
            continue
        if c in "'\"":
            quote = c
            buf.append(c)
            i += 1
            continue
        if c in ";\n":
            segments.append("".join(buf))
            buf = []
            i += 1
            continue
        if text.startswith("&&", i) or text.startswith("||", i):
            segments.append("".join(buf))
            buf = []
            i += 2
            continue
        buf.append(c)
        i += 1
    segments.append("".join(buf))
    return segments


def _statements(command: str) -> list[str]:
    """Split a shell command into statements, ignoring here-document bodies and
    separators inside quoted strings (both are data, not statements)."""
    return _split_unquoted(_strip_heredoc_bodies(command))


@dataclass(frozen=True)
class Op:
    """One streamed operation, as it is stored in ``chunks.jsonl``."""

    index: int
    header: str
    body: str

    @classmethod
    def from_dict(cls, obj: dict, *, fallback_index: int = 0) -> "Op":
        return cls(
            index=int(obj.get("index", fallback_index)),
            header=str(obj.get("header", "")),
            body=str(obj.get("body", "")),
        )


def render_op(op: Op, *, remaining: int) -> str:
    """The exact user-turn text for one operation.

    ``remaining`` is the number of operations that follow this one.
    """
    return f"=== {op.header} ({remaining} op(s) remaining after this) ===\n{op.body}"


def load_ops(lines: Iterable[str]) -> list[Op]:
    """Parse ``chunks.jsonl`` lines into :class:`Op` objects."""
    import json

    ops: list[Op] = []
    for line in lines:
        if line.strip():
            ops.append(Op.from_dict(json.loads(line), fallback_index=len(ops)))
    return ops


# --------------------------------------------------------------------- matching
def is_ready_line(reply: str) -> bool:
    """True when the reply carries the advance marker on a line of its own."""
    return bool(reply) and bool(_READY_LINE_RE.search(reply))


def is_ready_command(command: str, exit_code: int = 0) -> bool:
    """True when ``command`` runs ``echo READY_FOR_NEXT_OP`` as a whole statement.

    A failed command means the step did not finish, so it never advances.
    """
    if not command or exit_code != 0:
        return False
    return any(_READY_SEGMENT_RE.match(seg) for seg in _statements(command))


def mentions_advance_marker(text: str) -> bool:
    return bool(text) and ADVANCE_MARKER in text


def is_submit_line(reply: str) -> bool:
    return bool(reply) and bool(_SUBMIT_LINE_RE.search(reply))


def is_submit_command(command: str, exit_code: int = 0) -> bool:
    if not command or exit_code != 0:
        return False
    return any(_SUBMIT_SEGMENT_RE.match(seg) for seg in _statements(command))


def mentions_submit_marker(text: str) -> bool:
    return bool(text) and SUBMIT_MARKER in text


# ----------------------------------------------------------- texts sent back
#: Sent when the agent submits while operations are still undelivered.
REFUSE_SUBMIT_TEXT = (
    "There is nothing to submit in this task and the run did NOT end. "
    "Operations are still being delivered one at a time: run the "
    f"standalone command `echo {ADVANCE_MARKER}` to receive the "
    "next one, and keep doing that until you are told none remain."
)

#: Sent when the marker appeared but not as a standalone statement. Without this
#: the agent sees its command succeed, believes it advanced, and then stalls in
#: empty turns with no error signal anywhere.
EXPLAIN_NON_STANDALONE_TEXT = (
    f"[{ADVANCE_MARKER} did NOT advance: it must be a STANDALONE "
    f"command -- `echo {ADVANCE_MARKER}` on its own, or as the last "
    f"statement after a `;`. It does not count when passed as an "
    f"argument to printf/cat/grep. Your command ran normally; run the "
    f"marker as its own statement to receive the next operation.]"
)

#: Sent when a reply neither handled the op nor asked for the next one.
NO_MARKER_TEXT = (
    f"[No {ADVANCE_MARKER} in your reply, so the stream did not advance. "
    f"Finish the current operation, then put {ADVANCE_MARKER} on a line of "
    f"its own to receive the next one.]"
)

#: The two closing paragraphs a system prompt can carry. The submit contract is
#: wrong for a streamed task: an agent that submits before the stream is drained
#: loses every operation it has not seen.
SUBMIT_PARAGRAPH = (
    "When you are finished, submit by running the standalone command\n"
    f"`echo {SUBMIT_MARKER}` (with nothing else in that command).\n"
    "After it runs you cannot continue."
)

MARKER_PARAGRAPH = (
    "This task is delivered to you one operation at a time. You do NOT submit and\n"
    "you do NOT decide when it is over: after handling each operation, run the\n"
    f"standalone command `echo {ADVANCE_MARKER}` (with nothing else in that\n"
    "command) to receive the next one. Do this for EVERY operation, including the\n"
    "one that says none remain -- that final marker is what ends the run, and the\n"
    "harness stops you. Submitting early discards the work you just did."
)

MARKER_PARAGRAPH_REPLY = (
    "This task is delivered to you one operation at a time. You do NOT decide when\n"
    "it is over: after handling each operation, end your reply with\n"
    f"{ADVANCE_MARKER} on a line of its own to receive the next one. Do this for\n"
    "EVERY operation, including the one that says none remain. Submitting early\n"
    "discards the work you just did."
)
