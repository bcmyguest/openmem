"""Hindsight sink: REST `/v1/default/banks/{bank}/...`, moved verbatim from bin/hindsight-project-index.

Namespace mapping: `bank` is the Hindsight bank id, percent-encoded into the URL path.
Retains are synchronous (`"async": false`) with the `project-index` retain strategy; `prepare` creates the bank
when missing and pins that strategy and disables auto-consolidation.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping

from sinks import Capabilities, SinkError


DEFAULT_URL = "http://127.0.0.1:8888"
STRATEGY = "project-index"


class HttpError(SinkError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url}: HTTP {status}: {body}", status)


def request(url: str, method: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=300) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        raise HttpError(method, url, error.code, error.read().decode(errors="replace")[:300]) from error
    return json.loads(body) if body else {}


def ensure_strategy(endpoint: str) -> None:
    strategy = {"retain_extraction_mode": "chunks", "retain_chunk_size": 3000}
    try:
        response = request(endpoint + "/config", "GET")
    except HttpError as error:
        if error.status != 404:
            raise
        request(endpoint, "PUT", {})
        response = request(endpoint + "/config", "GET")
    config = response.get("config", response)
    strategies = config.get("retain_strategies") or {}
    updates = {}
    if strategies.get(STRATEGY) != strategy:
        updates["retain_strategies"] = {**strategies, STRATEGY: strategy}
    if config.get("enable_auto_consolidation") is not False:
        updates["enable_auto_consolidation"] = False
    if updates:
        request(endpoint + "/config", "PATCH", {"updates": updates})


class HindsightSink:
    capabilities = Capabilities(async_ingest=False)

    def __init__(self, url: str = DEFAULT_URL):
        self.url = url.rstrip("/")

    def _endpoint(self, bank: str) -> str:
        return f"{self.url}/v1/default/banks/{urllib.parse.quote(bank, safe='')}"

    def health(self) -> bool:
        try:
            with urllib.request.urlopen(self.url + "/health", timeout=5) as response:
                return 200 <= response.status < 300
        except (OSError, ValueError):
            return False

    def prepare(self, bank: str) -> None:
        ensure_strategy(self._endpoint(bank))

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
        item: dict = {"content": content, "document_id": doc_id}
        if context is not None:
            item["context"] = context
        if metadata is not None:
            item["metadata"] = dict(metadata)
        item["timestamp"] = timestamp if timestamp is not None else "unset"
        item["strategy"] = STRATEGY
        if tags:
            item["tags"] = list(tags)
        request(self._endpoint(bank) + "/memories", "POST", {"items": [item], "async": False})

    def delete(self, bank: str, doc_id: str) -> None:
        try:
            request(self._endpoint(bank) + "/documents/" + urllib.parse.quote(doc_id, safe=""), "DELETE")
        except HttpError as error:
            # 404: already gone (deleted server-side or never retained).
            if error.status != 404:
                raise


def create(url: str | None = None, **_cfg) -> HindsightSink:
    return HindsightSink(url or DEFAULT_URL)
