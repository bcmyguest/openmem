"""mem0 sink: the self-hosted mem0 REST server (`server/main.py` in github.com/mem0ai/mem0), stdlib only.

Namespace mapping. `bank` is the mem0 `user_id`, verbatim (JSON body for writes, percent-encoded query for lookups).
`doc_id` is the mem0 `run_id`. Every memory the sink writes also carries the fixed `agent_id`
`personal-memory-indexer`, for provenance only: lookups filter on `user_id` and `run_id` and never on `agent_id`.
mem0 has no bank to create (the `user_id` exists once a memory carries it), so `prepare` is a no-op.

Documents. mem0 gives every memory a server-generated id and has no upsert, so the sink resolves a document to its
memories with `GET /memories?user_id=<bank>&run_id=<doc_id>&top_k=1000`. `retain` deletes every memory found there
(`DELETE /memories/{id}`, a 404 for an already-gone id is swallowed), then writes the new text. The text is split
into chunks of at most 3000 characters (cut at a blank line, else a newline, else a space, else mid-text; the
chunks concatenate back to the original text, only chunks that are pure whitespace are dropped), and each chunk is
one `POST /memories` with `infer` literally false, so mem0 stores it verbatim instead of asking an LLM to rewrite
it. A document of empty or whitespace-only text has no chunks: its old memories are deleted and nothing is written
(the document is simply absent, which is what an empty document means to a search). A document that would need more
than 900 chunks is rejected before any request is sent, so the 1000-entry listing can never hide a stale chunk and a
rejected retain leaves the previous version intact. If a request fails part-way the error propagates; the indexer
keeps the document marked as changed and the next run repeats the whole delete-then-write, which converges.

Metadata. The caller's metadata is copied; a key mem0 reserves in its stored payload (`data`, `user_id`, `agent_id`,
`run_id`, `hash`, `created_at`, `updated_at`, `expiration_date`) is renamed with the prefix `meta_`. The sink then
adds `tags` (a list, only when there are tags), `context` and `timestamp` (only when not None; mem0 has no event-time
field) and, for a document of several chunks, `chunk` (0-based index) and `chunks` (the total). These sink-owned
keys win over a caller key of the same name.

Auth. `MEM0_API_KEY` is read from the environment inside `create`, never from a document or a path, and is sent as
`X-API-Key` on every request when set (and no auth header otherwise). It never appears in an error message. The
sink does not follow a redirect to another host, so the key cannot be handed to a different server.

URL. There is no default: mem0 publishes no standard port. `create` reads `MEMORY_API_URL` when no url is passed and
raises `MissingUrlError` (a `SinkError` and a `ValueError`, so the CLI reports it as a sink error) when both are empty.
Health is `GET /docs`, which the server leaves open (it has no dedicated health route).
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping

from sinks import Capabilities, SinkError

URL_ENV = "MEMORY_API_URL"
KEY_ENV = "MEM0_API_KEY"
AGENT_ID = "personal-memory-indexer"
CHUNK_CHARS = 3000
MAX_CHUNKS = 900
LIST_LIMIT = 1000
RESERVED_KEYS = frozenset({"data", "user_id", "agent_id", "run_id", "hash", "created_at", "updated_at", "expiration_date"})
READ_TIMEOUT = 30
WRITE_TIMEOUT = 300
HEALTH_TIMEOUT = 5


class MissingUrlError(SinkError, ValueError):
    """No usable API URL. A ValueError too, so `bin/hindsight-project-index` reports it as a sink error (exit 2)."""


class HttpError(SinkError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url}: HTTP {status}: {body}", status)


class SameHostRedirect(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only within the same host and port, because the request may carry the API key."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(SameHostRedirect)


def split_chunks(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Cut `text` into pieces of at most `limit` characters whose concatenation is `text`, minus pure-whitespace pieces."""
    pieces = []
    position = 0
    while len(text) - position > limit:
        window = text[position : position + limit]
        cut = limit
        for separator in ("\n\n", "\n", " "):
            found = window.rfind(separator)
            if found >= 0:
                cut = found + len(separator)
                break
        pieces.append(text[position : position + cut])
        position += cut
    pieces.append(text[position:])
    return [piece for piece in pieces if piece.strip()]


class Mem0Sink:
    capabilities = Capabilities(async_ingest=False)

    def __init__(self, url: str, api_key: str | None = None):
        self.url = url.rstrip("/")
        self._api_key = api_key or None

    def _headers(self, with_body: bool) -> dict[str, str]:
        headers = {"Content-Type": "application/json"} if with_body else {}
        if self._api_key:
            headers["X-API-Key"] = self._api_key
        return headers

    def _excerpt(self, body: bytes) -> str:
        text = body.decode(errors="replace")[:300]
        return text.replace(self._api_key, "***") if self._api_key else text

    def _request(self, method: str, path: str, payload: dict | None = None, timeout: float = READ_TIMEOUT) -> object:
        """One request; returns the decoded JSON reply, or None for an empty or non-JSON body."""
        url = self.url + path
        data = json.dumps(payload).encode() if payload is not None else None
        try:
            with OPENER.open(urllib.request.Request(url, data=data, headers=self._headers(data is not None), method=method), timeout=timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            raise HttpError(method, url, error.code, self._excerpt(error.read())) from error
        try:
            return json.loads(body) if body else None
        except ValueError:
            return None

    def _memory_ids(self, bank: str, doc_id: str) -> list[str]:
        query = urllib.parse.urlencode({"user_id": bank, "run_id": doc_id, "top_k": LIST_LIMIT}, quote_via=urllib.parse.quote)
        reply = self._request("GET", "/memories?" + query)
        if not isinstance(reply, dict):
            raise SinkError(f"GET {self.url}/memories: reply is not a JSON object; cannot tell which memories a document has")
        results = reply.get("results") or []
        return [item["id"] for item in results if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]]

    def _delete_memories(self, bank: str, doc_id: str) -> None:
        for memory_id in self._memory_ids(bank, doc_id):
            try:
                self._request("DELETE", "/memories/" + urllib.parse.quote(memory_id, safe=""))
            except HttpError as error:
                # 404: already gone (deleted server-side or by a concurrent run).
                if error.status != 404:
                    raise

    def health(self) -> bool:
        try:
            with OPENER.open(urllib.request.Request(self.url + "/docs", headers=self._headers(False)), timeout=HEALTH_TIMEOUT) as response:
                return 200 <= response.status < 300
        except (OSError, ValueError):  # includes urllib.error.HTTPError and URLError
            return False

    def prepare(self, bank: str) -> None:
        return None

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
        chunks = split_chunks(content)
        if len(chunks) > MAX_CHUNKS:
            raise SinkError(f"document {doc_id!r} needs {len(chunks)} chunks of at most {CHUNK_CHARS} characters; the mem0 sink accepts at most {MAX_CHUNKS} per document")
        base = {f"meta_{key}" if key in RESERVED_KEYS else key: value for key, value in (metadata or {}).items()}
        if tags:
            base["tags"] = list(tags)
        if context is not None:
            base["context"] = context
        if timestamp is not None:
            base["timestamp"] = timestamp
        self._delete_memories(bank, doc_id)
        for index, chunk in enumerate(chunks):
            meta = dict(base)
            if len(chunks) > 1:
                meta["chunk"] = index
                meta["chunks"] = len(chunks)
            body = {"messages": [{"role": "user", "content": chunk}], "user_id": bank, "agent_id": AGENT_ID, "run_id": doc_id, "infer": False, "metadata": meta}
            self._request("POST", "/memories", body, WRITE_TIMEOUT)

    def delete(self, bank: str, doc_id: str) -> None:
        self._delete_memories(bank, doc_id)


def create(url: str | None = None, **_cfg) -> Mem0Sink:
    resolved = (url or os.environ.get(URL_ENV) or "").strip()
    if not resolved:
        raise MissingUrlError(f"mem0 sink needs an API URL: set {URL_ENV} or pass --url")
    if not resolved.lower().startswith(("http://", "https://")):
        raise MissingUrlError(f"mem0 sink API URL must start with http:// or https://, got {resolved!r}")
    return Mem0Sink(resolved, (os.environ.get(KEY_ENV) or "").strip() or None)
