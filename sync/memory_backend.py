"""NotebookLM sync target: Hindsight REST or the same indexer sinks (mem0, cognee, …)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Protocol

# Indexer sinks live under ../indexer at dev time; /opt/indexer in the notebooklm image.
_INDEXER = Path(__file__).resolve().parents[1] / "indexer"
if _INDEXER.is_dir() and str(_INDEXER) not in sys.path:
    sys.path.insert(0, str(_INDEXER))


class MemoryBackend(Protocol):
    def ensure_bank(self, bank: str) -> None: ...
    def retain(self, bank: str, doc_id: str, document: dict) -> None: ...
    def delete(self, bank: str, doc_id: str) -> None: ...
    def after_bank_batch(self, bank: str) -> None:
        """Optional hook after retains/deletes for a bank (e.g. Cognee cognify)."""


def create_backend(hindsight_url: str) -> MemoryBackend:
    sink_name = (os.environ.get("MEMORY_SINK") or "hindsight").strip() or "hindsight"
    if sink_name == "hindsight":
        from notebooklm_sync import Hindsight

        return HindsightAdapter(Hindsight(hindsight_url))
    import sinks

    url = (os.environ.get("MEMORY_API_URL") or "").strip()
    if not url:
        raise RuntimeError(f"MEMORY_SINK={sink_name!r} requires MEMORY_API_URL in the notebooklm service environment")
    return SinkAdapter(sinks.get_sink(sink_name, url=url))


class HindsightAdapter:
    def __init__(self, client):
        self._client = client

    def ensure_bank(self, bank: str) -> None:
        self._client.ensure_bank(bank)

    def retain(self, bank: str, doc_id: str, document: dict) -> None:
        self._client.retain(bank, doc_id, document)

    def delete(self, bank: str, doc_id: str) -> None:
        self._client.delete(bank, doc_id)

    def after_bank_batch(self, bank: str) -> None:
        return None


class SinkAdapter:
    def __init__(self, sink):
        self._sink = sink
        self._pending_flush: set[str] = set()

    def ensure_bank(self, bank: str) -> None:
        self._sink.prepare(bank)

    def retain(self, bank: str, doc_id: str, document: dict) -> None:
        tags = list(document.get("tags") or [])
        meta = dict(document.get("metadata") or {})
        self._sink.retain(
            bank,
            doc_id,
            document["content"],
            tags=tags,
            metadata=meta,
            context=document.get("context"),
            timestamp="unset",
        )
        self._pending_flush.add(bank)

    def delete(self, bank: str, doc_id: str) -> None:
        self._sink.delete(bank, doc_id)
        self._pending_flush.add(bank)

    def after_bank_batch(self, bank: str) -> None:
        if bank not in self._pending_flush:
            return
        from sinks import flush_sink

        flush_sink(self._sink, bank)
        self._pending_flush.discard(bank)
