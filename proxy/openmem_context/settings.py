"""Runtime settings for the context proxy, read from environment variables."""

import math
import os
from dataclasses import dataclass
from pathlib import Path

from .store import ASCII_WHITESPACE
from .tokens import DEFAULT_CHARS_PER_TOKEN

DEFAULT_TRIM_AT_TOKENS = 120000
DEFAULT_COMPRESS_OVER_TOKENS = 4000
DEFAULT_COMPACTION_MAX_CHARS = 12000
DEFAULT_RECALL_TIMEOUT_S = 5.0
DEFAULT_HINDSIGHT_URL = "http://127.0.0.1:8888"
DEFAULT_TTL_DAYS = 30
# OpenAI-compatible embeddings base URL (POST <url>/embeddings): Ollama on the host. compose.yaml sets the
# container's view (host.docker.internal).
DEFAULT_EMBEDDING_URL = "http://127.0.0.1:11434/v1"
# Seconds per row of an embeddings call, and characters of a row's head sent (docs/context-store.md, "Vectors").
DEFAULT_EMBEDDING_TIMEOUT_S = 30.0
DEFAULT_EMBEDDING_MAX_CHARS = 4000


def _int(env, name, default):
    raw = str(env.get(name, "")).strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(env, name, default):
    raw = str(env.get(name, "")).strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _positive_float(env, name, default):
    value = _float(env, name, default)
    return value if math.isfinite(value) and value > 0 else default


def _positive_int(env, name, default):
    value = _int(env, name, default)
    return value if value > 0 else default


def _flag(env, name):
    """True unless the variable is 0, false, no or off."""
    return str(env.get(name, "1")).strip().lower() not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class Settings:
    enabled: bool = True
    # STANDING_INSTRUCTION in every request's system prompt (CONTEXT_STANDING_INSTRUCTION=0 turns it off).
    standing_instruction: bool = True
    trim_at_tokens: int = DEFAULT_TRIM_AT_TOKENS
    compress_over_tokens: int = DEFAULT_COMPRESS_OVER_TOKENS
    # Characters per token for the trim estimate until the session reports usage (CONTEXT_CHARS_PER_TOKEN).
    chars_per_token: float = DEFAULT_CHARS_PER_TOKEN
    compaction_max_chars: int = DEFAULT_COMPACTION_MAX_CHARS
    # Bounded provider recall in the trim pointer (CONTEXT_COMPACTION_RECALL=0 turns it off).
    compaction_recall: bool = True
    recall_timeout_s: float = DEFAULT_RECALL_TIMEOUT_S
    hindsight_url: str = DEFAULT_HINDSIGHT_URL
    context_dir: Path = Path.home() / ".local" / "share" / "openmem" / "context"
    # Session files older than this are deleted at start, at most once a day; 0 keeps them (CONTEXT_STORE_TTL_DAYS).
    ttl_days: int = DEFAULT_TTL_DAYS
    # Embedding model for the session databases' vectors; empty turns vectors off (CONTEXT_EMBEDDING_MODEL).
    embedding_model: str = ""
    embedding_url: str = DEFAULT_EMBEDDING_URL
    embedding_api_key: str = ""
    # An embeddings call of n rows times out after n times this (CONTEXT_EMBEDDING_TIMEOUT_S).
    embedding_timeout_s: float = DEFAULT_EMBEDDING_TIMEOUT_S
    # Each row's first this many characters are embedded (CONTEXT_EMBEDDING_MAX_CHARS).
    embedding_max_chars: int = DEFAULT_EMBEDDING_MAX_CHARS

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        state_dir = str(env.get("OPENMEM_STATE_DIR", "")).strip(ASCII_WHITESPACE)
        root = Path(state_dir) if state_dir else Path.home() / ".local" / "share" / "openmem"
        return cls(
            enabled=_flag(env, "CONTEXT_PROXY_ENABLED"),
            standing_instruction=_flag(env, "CONTEXT_STANDING_INSTRUCTION"),
            trim_at_tokens=_int(env, "CONTEXT_TRIM_AT_TOKENS", DEFAULT_TRIM_AT_TOKENS),
            compress_over_tokens=_int(env, "CONTEXT_COMPRESS_OVER_TOKENS", DEFAULT_COMPRESS_OVER_TOKENS),
            chars_per_token=_positive_float(env, "CONTEXT_CHARS_PER_TOKEN", DEFAULT_CHARS_PER_TOKEN),
            compaction_max_chars=_int(env, "CONTEXT_COMPACTION_MAX_CHARS", DEFAULT_COMPACTION_MAX_CHARS),
            compaction_recall=_flag(env, "CONTEXT_COMPACTION_RECALL"),
            recall_timeout_s=_float(env, "CONTEXT_RECALL_TIMEOUT_S", DEFAULT_RECALL_TIMEOUT_S),
            hindsight_url=(str(env.get("HINDSIGHT_URL", "")).strip() or DEFAULT_HINDSIGHT_URL).rstrip("/"),
            context_dir=root / "context",
            ttl_days=_int(env, "CONTEXT_STORE_TTL_DAYS", DEFAULT_TTL_DAYS),
            embedding_model=str(env.get("CONTEXT_EMBEDDING_MODEL", "")).strip(),
            embedding_url=(str(env.get("CONTEXT_EMBEDDING_URL", "")).strip() or DEFAULT_EMBEDDING_URL).rstrip("/"),
            embedding_api_key=str(env.get("CONTEXT_EMBEDDING_API_KEY", "")).strip(),
            embedding_timeout_s=_positive_float(env, "CONTEXT_EMBEDDING_TIMEOUT_S", DEFAULT_EMBEDDING_TIMEOUT_S),
            embedding_max_chars=_positive_int(env, "CONTEXT_EMBEDDING_MAX_CHARS", DEFAULT_EMBEDDING_MAX_CHARS),
        )
