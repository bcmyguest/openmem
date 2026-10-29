"""Runtime settings for the context proxy, read from environment variables."""

import os
from dataclasses import dataclass
from pathlib import Path

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


@dataclass(frozen=True)
class Settings:
    enabled: bool = True
    trim_at_tokens: int = DEFAULT_TRIM_AT_TOKENS
    compress_over_tokens: int = DEFAULT_COMPRESS_OVER_TOKENS
    compaction_max_chars: int = DEFAULT_COMPACTION_MAX_CHARS
    recall_timeout_s: float = DEFAULT_RECALL_TIMEOUT_S
    hindsight_url: str = DEFAULT_HINDSIGHT_URL
    context_dir: Path = Path.home() / ".local" / "share" / "openmem" / "context"

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        state_dir = str(env.get("OPENMEM_STATE_DIR", "")).strip()
        root = Path(state_dir) if state_dir else Path.home() / ".local" / "share" / "openmem"
        return cls(
            enabled=str(env.get("CONTEXT_PROXY_ENABLED", "1")).strip().lower() not in ("0", "false", "no", "off"),
            trim_at_tokens=_int(env, "CONTEXT_TRIM_AT_TOKENS", DEFAULT_TRIM_AT_TOKENS),
            compress_over_tokens=_int(env, "CONTEXT_COMPRESS_OVER_TOKENS", DEFAULT_COMPRESS_OVER_TOKENS),
            compaction_max_chars=_int(env, "CONTEXT_COMPACTION_MAX_CHARS", DEFAULT_COMPACTION_MAX_CHARS),
            recall_timeout_s=_float(env, "CONTEXT_RECALL_TIMEOUT_S", DEFAULT_RECALL_TIMEOUT_S),
            hindsight_url=(str(env.get("HINDSIGHT_URL", "")).strip() or DEFAULT_HINDSIGHT_URL).rstrip("/"),
            context_dir=root / "context",
        )
