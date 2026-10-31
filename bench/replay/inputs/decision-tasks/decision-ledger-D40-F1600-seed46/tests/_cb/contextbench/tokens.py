"""Token counting and per-turn context snapshots.

Every part of ContextBench that asks "how big is this context right now?" goes
through :func:`count_tokens`: exact ``o200k_base`` counts when ``tiktoken`` can be
imported, and a ``len // 3`` character estimate otherwise, so the package works
with no optional dependency and no network.

:func:`record_snapshot` persists the full retained context after each turn. The
snapshots are the paper metric's source of truth: an agent that offloads content
to disk and reads a value back only transiently still has that value captured in
the snapshot of the turn where it surfaced.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterator

__all__ = [
    "SNAPSHOT_DIRNAME",
    "count_text",
    "count_tokens",
    "get_encoder",
    "iter_text",
    "record_snapshot",
    "snapshot_paths",
]

SNAPSHOT_DIRNAME = "context_snapshots"

#: The character-per-token divisor used when tiktoken is unavailable.
FALLBACK_CHARS_PER_TOKEN = 3

_ENCODER: Any = None
_ENCODER_NAME: str | None = None


def get_encoder() -> Any:
    """A cached ``tiktoken`` encoder, or ``None`` when tiktoken is unavailable.

    Defaults to ``o200k_base``; ``TIKTOKEN_ENCODING`` overrides it and
    ``cl100k_base`` is the second choice (its vocabulary may be cached when
    ``o200k_base`` is not).
    """
    global _ENCODER, _ENCODER_NAME
    if _ENCODER is not None or _ENCODER_NAME == "_failed":
        return _ENCODER
    try:
        import tiktoken
    except Exception:
        _ENCODER_NAME = "_failed"
        return None
    for name in (os.environ.get("TIKTOKEN_ENCODING") or "o200k_base", "cl100k_base"):
        try:
            _ENCODER = tiktoken.get_encoding(name)
            _ENCODER_NAME = name
            return _ENCODER
        except Exception:
            continue  # e.g. the vocabulary download is blocked offline
    _ENCODER_NAME = "_failed"
    return None


def encoder_name() -> str:
    """The method label that :func:`count_tokens` reports."""
    get_encoder()
    if _ENCODER_NAME in (None, "_failed"):
        return f"approx_chars{FALLBACK_CHARS_PER_TOKEN}"
    return f"tiktoken:{_ENCODER_NAME}"


def iter_text(messages: list[Any] | None) -> Iterator[str]:
    """Yield every text piece of ``messages`` that reaches the model.

    This includes ``tool_calls[*].function.arguments``, where a shell command
    lives: a tool-heavy agent keeps most of its bytes there, so counting only
    ``content`` would undercount the real prompt by roughly a factor of two.
    """
    for msg in messages or []:
        content: Any
        if isinstance(msg, dict):
            reasoning = msg.get("reasoning_content")
            if isinstance(reasoning, str):
                yield reasoning
            content = msg.get("content")
            for call in msg.get("tool_calls") or []:
                fn = call.get("function") if isinstance(call, dict) else None
                if isinstance(fn, dict):
                    if fn.get("name"):
                        yield str(fn["name"])
                    if fn.get("arguments"):
                        yield str(fn["arguments"])
        else:
            content = msg
        if isinstance(content, str):
            yield content
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    yield str(item.get("text") or item.get("content") or "")
                else:
                    yield str(item)


def count_text(text: str) -> int:
    """Token count of one string (exact with tiktoken, else ``len // 3``)."""
    if not text:
        return 0
    enc = get_encoder()
    if enc is None:
        return max(1, len(text) // FALLBACK_CHARS_PER_TOKEN)
    return len(enc.encode(text, disallowed_special=()))


def count_tokens(messages: list[Any] | None) -> tuple[int, str]:
    """Token count over a message list. Returns ``(tokens, method)``."""
    total = sum(count_text(piece) for piece in iter_text(messages))
    return total, encoder_name()


def snapshot_paths(logs_dir: Path | str) -> list[Path]:
    """Every ``context_snapshots/turn-*.json`` under ``logs_dir``, in turn order."""
    import re

    d = Path(logs_dir) / SNAPSHOT_DIRNAME
    if not d.is_dir():
        return []

    def _turn(path: Path) -> int:
        m = re.search(r"turn-(\d+)", path.name)
        return int(m.group(1)) if m else -1

    return sorted(d.glob("turn-*.json"), key=_turn)


def record_snapshot(
    logs_dir: Path | str,
    step: int,
    messages: list[Any],
    extra: dict[str, Any] | None = None,
) -> Path | None:
    """Persist one per-turn snapshot of the full retained context.

    Writes ``<logs_dir>/context_snapshots/turn-NNNN.json`` holding ``step``,
    ``tokens``, ``token_method``, ``n_messages``, anything in ``extra``, and the
    ``messages`` themselves (last, so a human reading the file sees the
    accounting first). Best effort: snapshotting is a logging side effect and
    never raises into the run.
    """
    try:
        d = Path(logs_dir) / SNAPSHOT_DIRNAME
        d.mkdir(parents=True, exist_ok=True)
        tokens, method = count_tokens(messages)
        payload: dict[str, Any] = {
            "step": step,
            "tokens": tokens,
            "token_method": method,
            "n_messages": len(messages or []),
        }
        if extra:
            payload.update(extra)
        payload["messages"] = messages
        out = d / f"turn-{step:04d}.json"
        out.write_text(
            json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8"
        )
        return out
    except Exception:
        return None
