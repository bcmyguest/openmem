"""mem0 sink: the self-hosted mem0 REST server (`server/main.py` in github.com/mem0ai/mem0), stdlib only.

Namespace mapping. `bank` is the mem0 `user_id` and `doc_id` is the mem0 `run_id`, both through `scope_id`. mem0
trims an entity id and then rejects one that still contains whitespace (`_validate_and_trim_entity_id` in
`mem0/memory/main.py`; it has no length or charset rule), so `scope_id` is the identity for any id without
whitespace, and otherwise replaces each run of whitespace with `_` and appends `~` plus the first 8 hex digits of the
SHA-256 of the original id (`obsidian::My Vault` -> `obsidian::My_Vault~<8 hex>`). The suffix keeps two different
ids that differ only in whitespace apart, and the mapping is deterministic, so the same bank and document always
resolve to the same ids. It is applied to every use of the two ids (the lookup, the writes, the deletes). The
original text of a mapped id is not stored. Every memory also carries the fixed `agent_id`
`openmem-indexer`, for provenance only: lookups filter on `user_id` and `run_id` and never on `agent_id`.
mem0 has no bank to create (the `user_id` exists once a memory carries it), so `prepare` is a no-op.

Documents. mem0 gives every memory a server-generated id and has no upsert, so the sink resolves a document to its
memories with `GET /memories?user_id=<bank>&run_id=<doc_id>&top_k=1000` (percent-encoded). `retain` is
write-then-delete so that a failure never loses a document: it lists the document's current memory ids, writes the
new text, and only then deletes the listed ids (`DELETE /memories/{id}`; a 404 for an already-gone id is swallowed).
A failure part-way leaves the old memories, possibly next to some of the new ones; the indexer keeps the document
marked as changed, and its next run repeats the whole sequence, which converges on exactly the new chunks. Until
then a search can see duplicates. The text is split into chunks of at most 3000 characters (cut at a blank line,
else a newline, else a space, else mid-text; the chunks concatenate back to the original text, only chunks that are
pure whitespace are dropped), and each chunk is one `POST /memories` with `infer` literally false, so mem0 stores it
verbatim instead of asking an LLM to rewrite it. Each reply must be a JSON object whose `results` list is not empty
(infer=false answers one ADD result per message), otherwise the retain fails. A document of empty or whitespace-only
text has no chunks: its old memories are deleted and nothing is written (the document is simply absent, which is
what an empty document means to a search).

Limits and races. A document that would need more than 900 chunks (about 2.7 million characters) is rejected before
any request is sent, with a message naming the document id, so the 1000-entry listing can never hide a stale chunk
and a rejected retain leaves the previous version intact. The indexer retries a failed document on every run, so such
a document fails its whole source on every run until it is shortened or excluded. mem0 enforces no uniqueness on
`run_id`: two indexer runs that retain the same document concurrently (for example with different state files) can
both list the old memories and both write, leaving two sets of chunks. The next retain of that document lists and
removes all of them.

Metadata. The caller's metadata is copied; a key that mem0 reserves, drops or overwrites in the stored payload
(`data`, `user_id`, `agent_id`, `run_id`, `actor_id`, `hash`, `created_at`, `updated_at`, `expiration_date`, `role`,
`text_lemmatized`, `attributed_to`) is renamed with the prefix `meta_`. The sink then adds `tags` (a list, only when
there are tags), `context` and `timestamp` (only when not None; mem0 has no event-time field) and, for a document of
several chunks, `chunk` (0-based index) and `chunks` (the total). These sink-owned keys win over a caller key of
the same name.

Auth. `MEM0_API_KEY` is read from the environment inside `create`, never from a document or a path, and is sent as
`X-API-Key` on every request except the health check (`/docs` is open, so no key travels with it). Without a key no
auth header is sent. The key never appears in an error message. Over plain `http://` the key travels in cleartext:
use `https://` (or a loopback address) for any server that is not on the same host. The sink follows no redirects
(see `sinks/_http.py`; the mem0 server has `redirect_slashes=False` and API calls never redirect), so a 3xx is an
error carrying its status, and the key cannot be handed to another host.

URL. There is no default: mem0 publishes no standard port. `create` reads `MEMORY_API_URL` when no url is passed and
raises `MissingUrlError` (a `SinkError` and a `ValueError`, so the CLI reports it as a sink error) when both are empty,
when the URL has no http(s) scheme or host, or when it embeds credentials (`user:pass@host`; use `MEM0_API_KEY`).
Error messages never echo the URL given. Health is `GET /docs`, which the server leaves open (it has no dedicated
health route).
"""

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping

from sinks import Capabilities, SinkError
from sinks._http import open_url, read_all

URL_ENV = "MEMORY_API_URL"
KEY_ENV = "MEM0_API_KEY"
AGENT_ID = "openmem-indexer"
CHUNK_CHARS = 3000
MAX_CHUNKS = 900
LIST_LIMIT = 1000
RESERVED_KEYS = frozenset(
    {"data", "user_id", "agent_id", "run_id", "actor_id", "hash", "created_at", "updated_at", "expiration_date", "role", "text_lemmatized", "attributed_to"}
)
READ_TIMEOUT = 30
WRITE_TIMEOUT = 300
HEALTH_TIMEOUT = 5


class MissingUrlError(SinkError, ValueError):
    """No usable API URL. A ValueError too, so `bin/hindsight-project-index` reports it as a sink error (exit 2)."""


class HttpError(SinkError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url}: HTTP {status}: {body}", status)


def scope_id(value: str) -> str:
    """Map a bank or document id to a mem0 entity id: itself when it has no whitespace, else a whitespace-free form.

    Each run of whitespace becomes `_`, then `~` and the first 8 hex digits of sha256(value) are appended.
    """
    if not any(char.isspace() for char in value):
        return value
    pieces = []
    in_space = False
    for char in value:
        if char.isspace():
            if not in_space:
                pieces.append("_")
            in_space = True
        else:
            pieces.append(char)
            in_space = False
    return "".join(pieces) + "~" + hashlib.sha256(value.encode()).hexdigest()[:8]


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
            with open_url(urllib.request.Request(url, data=data, headers=self._headers(data is not None), method=method), timeout) as response:
                body = read_all(response)
        except urllib.error.HTTPError as error:
            try:
                excerpt = self._excerpt(read_all(error))
            except OSError:
                excerpt = ""
            raise HttpError(method, url, error.code, excerpt) from error
        try:
            return json.loads(body) if body else None
        except ValueError:
            return None

    def _memory_ids(self, user_id: str, run_id: str) -> list[str]:
        query = urllib.parse.urlencode({"user_id": user_id, "run_id": run_id, "top_k": LIST_LIMIT}, quote_via=urllib.parse.quote)
        reply = self._request("GET", "/memories?" + query)
        results = reply.get("results") if isinstance(reply, dict) else None
        if not isinstance(results, list) or not all(isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] for item in results):
            raise SinkError(f"GET {self.url}/memories: unexpected reply (want an object with a `results` list of memories that have an id); cannot tell which memories the document has")
        return [item["id"] for item in results]

    def _delete_ids(self, memory_ids: list[str]) -> None:
        for memory_id in memory_ids:
            try:
                self._request("DELETE", "/memories/" + urllib.parse.quote(memory_id, safe=""))
            except HttpError as error:
                # 404: already gone (deleted server-side or by a concurrent run).
                if error.status != 404:
                    raise

    def health(self) -> bool:
        try:
            with open_url(urllib.request.Request(self.url + "/docs"), HEALTH_TIMEOUT) as response:
                return 200 <= response.status < 300
        except (OSError, ValueError):  # includes HTTPError, URLError and, via open_url, malformed HTTP replies
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
        user_id, run_id = scope_id(bank), scope_id(doc_id)
        base = {f"meta_{key}" if key in RESERVED_KEYS else key: value for key, value in (metadata or {}).items()}
        if tags:
            base["tags"] = list(tags)
        if context is not None:
            base["context"] = context
        if timestamp is not None:
            base["timestamp"] = timestamp
        old_ids = self._memory_ids(user_id, run_id)
        for index, chunk in enumerate(chunks):
            meta = dict(base)
            if len(chunks) > 1:
                meta["chunk"] = index
                meta["chunks"] = len(chunks)
            body = {"messages": [{"role": "user", "content": chunk}], "user_id": user_id, "agent_id": AGENT_ID, "run_id": run_id, "infer": False, "metadata": meta}
            reply = self._request("POST", "/memories", body, WRITE_TIMEOUT)
            results = reply.get("results") if isinstance(reply, dict) else None
            if not isinstance(results, list) or not results:
                raise SinkError(f"POST {self.url}/memories: mem0 stored nothing for chunk {index + 1} of {len(chunks)} of document {doc_id!r} (want an object with a non-empty `results` list)")
        self._delete_ids(old_ids)

    def delete(self, bank: str, doc_id: str) -> None:
        self._delete_ids(self._memory_ids(scope_id(bank), scope_id(doc_id)))


def create(url: str | None = None, **_cfg) -> Mem0Sink:
    resolved = (url or os.environ.get(URL_ENV) or "").strip()
    if not resolved:
        raise MissingUrlError(f"mem0 sink needs an API URL: set {URL_ENV} or pass --url")
    # No message below echoes the URL: it could carry a password.
    if not resolved.lower().startswith(("http://", "https://")):
        raise MissingUrlError("mem0 sink API URL must start with http:// or https://")
    try:
        parts = urllib.parse.urlsplit(resolved)
        host = parts.hostname
        _ = parts.port  # raises ValueError for a malformed port
    except ValueError:
        raise MissingUrlError("mem0 sink API URL is not a valid URL") from None
    if "@" in parts.netloc:
        raise MissingUrlError(f"mem0 sink API URL must not contain credentials (user:pass@host); set {KEY_ENV} for the API key")
    if not host:
        raise MissingUrlError("mem0 sink API URL has no host")
    return Mem0Sink(resolved, (os.environ.get(KEY_ENV) or "").strip() or None)
