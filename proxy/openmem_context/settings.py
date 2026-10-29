"""Runtime settings for the context proxy, read from environment variables."""

import os
from dataclasses import dataclass
from pathlib import Path

from .store import ASCII_WHITESPACE

DEFAULT_TRIM_AT_TOKENS = 120000
DEFAULT_COMPRESS_OVER_TOKENS = 4000
DEFAULT_COMPACTION_MAX_CHARS = 12000
DEFAULT_RECALL_TIMEOUT_S = 5.0
DEFAULT_HINDSIGHT_URL = "http://127.0.0.1:8888"


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
    compaction_max_chars: int = DEFAULT_COMPACTION_MAX_CHARS
    recall_timeout_s: float = DEFAULT_RECALL_TIMEOUT_S
    hindsight_url: str = DEFAULT_HINDSIGHT_URL
    context_dir: Path = Path.home() / ".local" / "share" / "openmem" / "context"
    # context_dir as the agent sees it; differs when the proxy runs in a container. None means context_dir.
    host_context_dir: Path | None = None

    @property
    def pointer_context_dir(self):
        return self.host_context_dir or self.context_dir

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        state_dir = str(env.get("OPENMEM_STATE_DIR", "")).strip(ASCII_WHITESPACE)
        root = Path(state_dir) if state_dir else Path.home() / ".local" / "share" / "openmem"
        host_state_dir = str(env.get("OPENMEM_HOST_STATE_DIR", "")).strip(ASCII_WHITESPACE)
        return cls(
            enabled=_flag(env, "CONTEXT_PROXY_ENABLED"),
            standing_instruction=_flag(env, "CONTEXT_STANDING_INSTRUCTION"),
            trim_at_tokens=_int(env, "CONTEXT_TRIM_AT_TOKENS", DEFAULT_TRIM_AT_TOKENS),
            compress_over_tokens=_int(env, "CONTEXT_COMPRESS_OVER_TOKENS", DEFAULT_COMPRESS_OVER_TOKENS),
            compaction_max_chars=_int(env, "CONTEXT_COMPACTION_MAX_CHARS", DEFAULT_COMPACTION_MAX_CHARS),
            recall_timeout_s=_float(env, "CONTEXT_RECALL_TIMEOUT_S", DEFAULT_RECALL_TIMEOUT_S),
            hindsight_url=(str(env.get("HINDSIGHT_URL", "")).strip() or DEFAULT_HINDSIGHT_URL).rstrip("/"),
            context_dir=root / "context",
            host_context_dir=Path(host_state_dir) / "context" if host_state_dir else None,
        )
