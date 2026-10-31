"""Grader plumbing: the three ways a run's context is read back.

Every ContextBench reward is computed out of the agent's own messages, never off
disk. Three readers supply those messages, in order of preference:

1. **snapshots** -- ``context_snapshots/turn-*.json``, one per turn. This is the
   paper metric: an agent that parks content outside its context and surfaces a
   value only transiently still has that value captured in the snapshot of the turn
   where it appeared.
2. **trajectory** -- an ATIF ``trajectory.json``: a flat list of chat messages that
   context edits mutate in place, so the final file is exactly the retained
   context. One frame, not a per-turn series.
3. **final report** -- the closing text of a run whose agent cannot expose its
   context at all.

Which reader ran is recorded as ``graded_from`` in every reward dict, so a number
is never comparable by accident across sources.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..tokens import SNAPSHOT_DIRNAME, snapshot_paths

__all__ = [
    "ContextSource",
    "atif_messages",
    "Grader",
    "find_snapshots_dir",
    "find_trajectory",
    "messages_text",
    "normalize",
    "read_context",
    "read_final_report",
    "read_snapshots",
    "read_trajectory",
]

#: Filenames a run may use for its closing report, most specific first.
FINAL_REPORT_NAMES = (
    "final_report.txt",
    "final_report.md",
    "final_report.json",
    "report.txt",
    "report.md",
)


def normalize(text: str) -> str:
    """Collapse whitespace, so a reward never turns on reflow or indentation."""
    return re.sub(r"\s+", " ", text.strip())


def _decoded_tool_json(content: str) -> str | None:
    """The string fields of a tool result that is one JSON object, else ``None``.

    Some harnesses render a command's output as a JSON object (``{"returncode": 0,
    "output": "..."}``), which escapes ``<`` and ``>`` and turns newlines into
    ``\\n``. The model reads the decoded text; so does the grader.
    """
    text = content.strip()
    if not (text.startswith("{") and text.endswith("}")):
        return None
    try:
        obj = json.loads(text)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    parts = [v for v in obj.values() if isinstance(v, str)]
    return "\n".join(parts) if parts else None


def messages_text(messages: Sequence[Any] | None) -> str:
    """Flatten a message list into the text the grader scans."""
    texts: list[str] = []
    for msg in messages or []:
        content = msg.get("content") if isinstance(msg, dict) else msg
        if isinstance(content, str):
            if isinstance(msg, dict) and msg.get("role") == "tool":
                decoded = _decoded_tool_json(content)
                if decoded is not None:
                    content = decoded
            texts.append(content)
        elif isinstance(content, list):
            for item in content:
                texts.append(
                    str(item.get("text") or item.get("content") or "")
                    if isinstance(item, dict)
                    else str(item)
                )
    return "\n".join(texts)


# ----------------------------------------------------------------- locating files
def _candidate_dirs(run_dir: Path) -> list[Path]:
    """``run_dir`` itself and the usual agent subdirectories, in preference order."""
    return [run_dir, run_dir / "agent", run_dir / "logs", run_dir / "logs" / "agent"]


def find_snapshots_dir(run_dir: Path | str) -> Path | None:
    """The run's ``context_snapshots`` directory, if it has one."""
    run_dir = Path(run_dir)
    for cand in _candidate_dirs(run_dir):
        if (cand / SNAPSHOT_DIRNAME).is_dir():
            return cand / SNAPSHOT_DIRNAME
    hits = sorted(run_dir.glob(f"**/{SNAPSHOT_DIRNAME}"))
    return hits[0] if hits else None


def find_trajectory(run_dir: Path | str) -> Path | None:
    """The run's ATIF ``trajectory.json``, if it has one."""
    run_dir = Path(run_dir)
    for cand in _candidate_dirs(run_dir):
        if (cand / "trajectory.json").is_file():
            return cand / "trajectory.json"
    hits = sorted(run_dir.glob("**/trajectory.json"))
    return hits[0] if hits else None


# ------------------------------------------------------------------- the readers
@dataclass
class ContextSource:
    """The messages a grader scores, and where they came from."""

    graded_from: str
    #: One message list per turn. A trajectory or a report yields a single frame.
    frames: list[list[Any]] = field(default_factory=list)
    #: Per-turn context size, when the source records it.
    tokens: list[int] = field(default_factory=list)
    n_snapshots: int = 0

    @property
    def final_frame(self) -> list[Any]:
        return self.frames[-1] if self.frames else []

    def texts(self) -> list[str]:
        return [messages_text(frame) for frame in self.frames]

    def all_text(self) -> str:
        return "\n".join(self.texts())


def read_snapshots(run_dir: Path | str) -> ContextSource | None:
    """Read ``context_snapshots/turn-*.json`` as one frame per turn."""
    snap_dir = find_snapshots_dir(run_dir)
    if snap_dir is None:
        return None
    frames: list[list[Any]] = []
    tokens: list[int] = []
    n = 0
    for path in snapshot_paths(snap_dir.parent):
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        n += 1
        if isinstance(obj.get("tokens"), (int, float)):
            tokens.append(int(obj["tokens"]))
        frames.append(obj.get("messages") or [])
    if n == 0:
        return None
    return ContextSource("snapshots", frames, tokens, n)


def read_trajectory(run_dir: Path | str) -> ContextSource | None:
    """Read an ATIF ``trajectory.json`` as a single frame."""
    path = find_trajectory(run_dir)
    if path is None:
        return None
    try:
        messages = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if isinstance(messages, dict):
        if isinstance(messages.get("steps"), list):
            messages = atif_messages(messages["steps"])
        else:
            messages = messages.get("messages") or messages.get("trajectory") or []
    if not isinstance(messages, list):
        return None
    return ContextSource("trajectory", [messages], [], 0)


def _part_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(p.get("text") or "") if isinstance(p, dict) else str(p) for p in content
        )
    return "" if content is None else str(content)


def atif_messages(steps: Sequence[Any]) -> list[dict[str, Any]]:
    """Flatten ATIF ``steps`` into chat messages.

    ``user`` and ``system`` steps become messages of that role; an ``agent`` step
    becomes an ``assistant`` message followed by one ``tool`` message per
    observation result. The flattening is the full history the harness recorded,
    which for a harness that compacts is more than it retained.
    """
    out: list[dict[str, Any]] = []
    for step in steps or []:
        if not isinstance(step, dict):
            continue
        source = step.get("source")
        text = _part_text(step.get("message"))
        if source in ("user", "system"):
            out.append({"role": source, "content": text})
            continue
        out.append({"role": "assistant", "content": text})
        observation = step.get("observation") or {}
        for result in observation.get("results") or []:
            if isinstance(result, dict) and result.get("content") is not None:
                out.append({"role": "tool", "content": _part_text(result["content"])})
    return out


def read_final_report(run_dir: Path | str) -> str:
    """The run's closing report text.

    A file named like ``final_report.txt`` wins; otherwise the assistant messages
    of a trajectory are concatenated, which is what an agent that only talks leaves
    behind.
    """
    run_dir = Path(run_dir)
    for cand in _candidate_dirs(run_dir):
        for name in FINAL_REPORT_NAMES:
            path = cand / name
            if path.is_file():
                return path.read_text(encoding="utf-8")
    source = read_trajectory(run_dir)
    if source is None:
        return ""
    assistant = [
        m
        for m in source.final_frame
        if isinstance(m, dict) and m.get("role") == "assistant"
    ]
    return messages_text(assistant or source.final_frame)


def read_context(run_dir: Path | str) -> ContextSource:
    """The best available source for ``run_dir``.

    Snapshots first (the paper metric), then the ATIF trajectory, then the final
    report. An empty :class:`ContextSource` with ``graded_from="none"`` means the
    run left nothing gradeable behind, which a grader reports as invalid rather
    than as a zero.
    """
    for reader in (read_snapshots, read_trajectory):
        source = reader(run_dir)
        if source is not None:
            return source
    report = read_final_report(run_dir)
    if report:
        return ContextSource(
            "final_report", [[{"role": "assistant", "content": report}]], [], 0
        )
    return ContextSource("none", [], [], 0)


# ---------------------------------------------------------------------- base class
class Grader:
    """A ContextBench grader.

    Subclasses implement :meth:`grade`, which takes a run directory and the parsed
    ``gold.json`` and returns a reward dict. Every returned dict carries
    ``graded_from`` and ``grader_valid``.
    """

    family: str = ""
    #: The reward name a caller should read as "the score".
    primary: str = "reward"

    def grade(self, run_dir: Path | str, gold: dict) -> dict:
        raise NotImplementedError

    def grade_path(self, run_dir: Path | str, gold_path: Path | str) -> dict:
        gold = json.loads(Path(gold_path).read_text(encoding="utf-8"))
        return self.grade(run_dir, gold)

    # -- helpers shared by the concrete graders --------------------------------
    @staticmethod
    def _token_stats(tokens: list[int]) -> dict[str, float]:
        return {
            "agent_peak_tokens": float(max(tokens)) if tokens else 0.0,
            "agent_mean_tokens": float(sum(tokens) / len(tokens)) if tokens else 0.0,
        }

    @staticmethod
    def _invalid(graded_from: str, why: str) -> dict:
        """A grade that could not be computed: never reported as a zero score."""
        return {
            "reward": 0.0,
            "grader_valid": 0.0,
            "graded_from": graded_from,
            "grader_note": why,
        }
