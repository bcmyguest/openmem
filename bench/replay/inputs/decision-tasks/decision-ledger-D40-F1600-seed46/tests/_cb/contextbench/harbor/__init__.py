"""ContextBench on Harbor: task packaging, the op stream, agents and verifiers.

``turn_source``, ``mixin`` and ``package`` import nothing from Harbor, so a task can
be built and a stream tested without it installed. ``agents``, ``wrap`` and
``verifiers`` require ``harbor>=0.16`` (``pip install 'contextbench[harbor]'``).
"""

from __future__ import annotations

from .mixin import CBStreamMixin
from .turn_source import (
    ENV_STREAM_COUNT,
    ENV_STREAM_PATH,
    ENV_STREAM_SHA256,
    STREAM_RECORD_NAME,
    STREAM_RELPATH,
    StreamIdentityError,
    TurnSource,
    canonical_sha256,
)

__all__ = [
    "CBStreamMixin",
    "ENV_STREAM_COUNT",
    "ENV_STREAM_PATH",
    "ENV_STREAM_SHA256",
    "STREAM_RECORD_NAME",
    "STREAM_RELPATH",
    "StreamIdentityError",
    "TurnSource",
    "canonical_sha256",
]
