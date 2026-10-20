"""Memory sinks: where the indexer writes documents.

`bin/hindsight-project-index` produces documents (stable id, text, tags, metadata) and hands them to a sink. A sink
is any object satisfying the `Sink` protocol below. The indexer holds no provider knowledge beyond choosing a sink
with `--sink NAME` (env `MEMORY_SINK`, default `hindsight`).

Import name: `indexer/` is the import root (PYTHONPATH=/opt/indexer in the image, `indexer/` on sys.path in the
tests), so this package imports as `sinks`, next to `index_config` and `code_outline`.

Adding a sink: drop `indexer/sinks/<name>.py` that defines `create(url=None, **cfg) -> Sink`. Nothing else is
edited: `get_sink` finds the module by name, and the Dockerfile copies the whole directory. `<name>` is the
provider id (lowercase letters, digits, underscore) and is what `--sink` and `MEMORY_SINK` accept.

Namespace ("bank") mapping. The indexer says `bank` for the logical grouping a document belongs to (a repository's
bank, an Obsidian vault's bank; for example `coding-agent::proj` or `obsidian::my-vault`). Hindsight uses it
verbatim as the bank id. A provider without banks maps it to its nearest scoping concept and documents the rule in
its own module docstring:

    mem0    bank -> user_id (agent_id may hold a fixed indexer name)
    cognee  bank -> dataset name

The bank is an opaque, non-empty string: sinks must quote or sanitize it for their own API, and must not assume
it is URL-safe. `doc_id` is a stable string (`project-index:v1:<hash>`); the same id always names the same
logical document within a bank.

Errors. HTTP error replies raise `SinkError` (or a subclass); `SinkError.status` is the HTTP status. A server
that cannot be reached raises `SinkError` or `OSError` (urllib's URLError is an OSError). `delete` of a document
that is already gone is NOT an error. `health()` never raises.

URL. `get_sink(name, url=...)` passes the API base URL; the CLI resolves it from `--url`, then `HINDSIGHT_URL`
for the hindsight sink, or `MEMORY_API_URL` for every other sink. A sink reads any credentials from its own env
vars inside `create`, never from the document path.
"""

import importlib
import pkgutil
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


DEFAULT_SINK = "hindsight"
NAME = re.compile(r"^[a-z][a-z0-9_]*$")


class SinkError(RuntimeError):
    """A sink request failed. `status` is the HTTP status, or None for a connection-level failure."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class UnknownSinkError(ValueError):
    """The requested sink name is not registered."""


@dataclass(frozen=True)
class Capabilities:
    """What a sink can do beyond the basics.

    async_ingest: retain() may return before the provider has made the document searchable (for example Cognee
    add -> cognify). Callers must not read their own writes immediately.
    """

    async_ingest: bool = False


@runtime_checkable
class Sink(Protocol):
    capabilities: Capabilities

    def health(self) -> bool:
        """True when the provider answers its health endpoint. Never raises."""
        ...

    def prepare(self, bank: str) -> None:
        """Make `bank` ready for retain (create it, set retain strategy). Called before a batch of retains for
        that bank; must be idempotent and may be a no-op."""
        ...

    def retain(
        self,
        bank: str,
        doc_id: str,
        content: str,
        *,
        tags: list[str] | None = None,
        metadata: Mapping[str, str] | None = None,
        context: str | None = None,
        timestamp: str | None = None,
    ) -> None:
        """Upsert one document: retaining an existing `doc_id` replaces it, never duplicates it.

        timestamp None means "no event time"; the sink maps that to the provider's own convention.
        """
        ...

    def delete(self, bank: str, doc_id: str) -> None:
        """Remove a document. A document that does not exist is not an error."""
        ...


_registry: dict[str, Callable[..., Sink]] = {}


def register_sink(name: str, factory: Callable[..., Sink]) -> None:
    """Register a factory under `name` for this process, taking precedence over a module of the same name."""
    if not NAME.match(name):
        raise ValueError(f"invalid sink name {name!r}: use lowercase letters, digits and underscore")
    _registry[name] = factory


def registered_sinks() -> list[str]:
    """Sorted sink names: explicit registrations plus every public module in this package."""
    names = {module.name for module in pkgutil.iter_modules(__path__) if NAME.match(module.name)}
    return sorted(names | set(_registry))


def get_sink(name: str, **cfg: Any) -> Sink:
    """Build the sink `name` with `cfg` (normally `url=`). Raises UnknownSinkError listing the valid names."""
    if name in _registry:
        return _registry[name](**cfg)
    if name not in registered_sinks():
        raise UnknownSinkError(f"unknown sink {name!r}; registered sinks: {', '.join(registered_sinks()) or 'none'}")
    module = importlib.import_module(f"{__name__}.{name}")
    factory = getattr(module, "create", None)
    if not callable(factory):
        raise UnknownSinkError(f"sink module {module.__name__} defines no create(url=None, **cfg) factory")
    return factory(**cfg)
