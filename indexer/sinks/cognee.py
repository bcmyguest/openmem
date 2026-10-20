"""Cognee sink: the self-hosted REST server (`cognee/cognee`), stdlib only.

Namespace mapping: `bank` maps to a Cognee dataset named `<slug>_<8 hex of sha256(bank)>`, where the slug is the
bank lowercased, runs of characters outside [a-z0-9] collapsed to "_", stripped, truncated to 40 characters
(`bank` when empty). Dataset names reach file and database paths on the server, so they stay in [a-z0-9_]; the hash
suffix keeps two banks that slug identically apart. Cognee's data and delete endpoints take the dataset UUID, so the
sink resolves name -> id once (`POST /api/v1/datasets` is create-or-return) and caches it for the instance.

Document mapping: Cognee has no client-chosen document id and `POST /api/v1/add` never updates a document (same
name with different content is a 409). The sink therefore stores `doc_id` in the document's `external_metadata`
and upserts by lookup: page through `GET /api/v1/datasets/{id}/data` (limit 1000), pick every item whose
`externalMetadata.doc_id` equals the id, `DELETE /api/v1/datasets/{id}/data/{data_id}` each, then add the new
version. The upload file name is `<sha256(doc_id)[:16]>-<8 hex of sha256(content)>.md`: unique per version (so a
changed document never collides with an old one) and free of path text. The add request addresses the dataset by
`datasetName` (the same name cognify takes), so it also works if the cached dataset id went stale.

`add` is quick; building the graph is the slow, separate `POST /api/v1/cognify` step, so
`capabilities.async_ingest` is True and a retained document is not searchable until cognify finishes.

Flush: `flush(bank)` (optional hook, see `sinks.flush_sink`) always means "process this bank now". The indexer
calls it with an explicit bank after a changed batch or when an earlier flush is still pending, possibly in a fresh
process, so it never relies on this instance's memory: it resolves the dataset by name (cached id, else
`GET /api/v1/datasets`; never created), and when the dataset is missing or holds no data item
(`GET .../data?limit=1`) it sends nothing (cognify on an empty dataset is an error; this covers delete-only
batches that emptied a bank). Otherwise it sends one `POST /api/v1/cognify {"datasets": [name], "runInBackground":
true}`. `flush(None)` flushes only the banks this instance dirtied (retain or a delete that removed something) and
is meant for direct callers and tests; the indexer never uses it. The dirty flag is cleared on success or when
there was nothing to process, never on an error.

Document text: Cognee deduplicates an add by content hash within a dataset (and owner), so two documents with
different `doc_id` and identical bytes would collapse into one row (the second add keeps the first's metadata, and
deleting either removes the shared content). The uploaded text is therefore `content` plus a footer line
`<!-- personal-memory:doc:<first 16 hex of sha256(doc_id)> -->`, which makes every document's bytes unique and
leaks no id or path text.

Delete: a bank with no dataset (looked up by name, never created) has nothing to delete. A 404 on listing (dataset
gone) or on the data DELETE (data gone) is swallowed. Cognee answers 401 for "dataset missing or no permission"
and 403 for permission, which cannot be told apart from an auth failure, so 401 and 403 always raise.

Auth: env `COGNEE_API_KEY`, read in `create`, is sent as `X-Api-Key` on every request when set. It never appears
in URLs, errors or logs. URL: `create(url)`, else env `MEMORY_API_URL`; there is no default. Every request goes
through `sinks._http.open_url`: no redirect is ever followed (so the key cannot reach another host and a write is
never replayed as a GET) and a malformed HTTP reply is an `OSError`.

Failure windows. Upsert is delete-then-add, so between the two a document is missing until the retry; the indexer
retries because it saves a document's digest only after `retain` returns. A client-side add timeout can leave the
add completed on the server; the retry then deletes that copy and adds again, which is harmless. A cognify
requested while the previous pipeline run for the dataset is still running may be skipped or queued by Cognee
(unverified); the indexer's pending marker only guarantees that a cognify call is issued after the last change, so
check `GET /api/v1/datasets/status?dataset=<uuid>` when a document does not become searchable
(the live 1.6.5 API takes dataset UUIDs, not names).

Listing metadata: `externalMetadata` / `external_metadata` may be a dict, a list of objects, or a JSON string of
either (same shapes as `providers/cognee/lib/smoke.mjs` `docIds`); `_matching` accepts all of them. Not verified
offline against a real server: which of those shapes a given Cognee build actually returns, what `name` the server
stores for an uploaded file (the sink never reads it), that a `.md` upload with `text/markdown` is accepted by the
loaders, and the exact cognify behaviour for a dataset that is already processing.
"""

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Mapping

from sinks import Capabilities, SinkError
from sinks._http import open_url, read_all

PAGE = 1000
SLUG_MAX = 40
ADD_TIMEOUT = 300
TIMEOUT = 60
HEALTH_TIMEOUT = 5


class HttpError(SinkError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url}: HTTP {status}: {body}", status)


def dataset_name(bank: str) -> str:
    """The Cognee dataset name for `bank`: `<slug>_<8 hex of sha256(bank)>`."""
    slug = re.sub(r"[^a-z0-9]+", "_", bank.lower()).strip("_")[:SLUG_MAX].strip("_") or "bank"
    return f"{slug}_{hashlib.sha256(bank.encode()).hexdigest()[:8]}"


def upload_name(doc_id: str, content: str) -> str:
    """Upload file name: unique per document version, with no doc id or path text in it."""
    return f"{hashlib.sha256(doc_id.encode()).hexdigest()[:16]}-{hashlib.sha256(content.encode()).hexdigest()[:8]}.md"


def upload_text(doc_id: str, content: str) -> str:
    """`content` plus a per-document footer, so identical texts of two documents never share a content hash."""
    return f"{content}\n\n<!-- personal-memory:doc:{hashlib.sha256(doc_id.encode()).hexdigest()[:16]} -->\n"


def metadata_doc_ids(item: Mapping) -> list[str]:
    """Every `doc_id` string in an item's external metadata (parity with smoke.mjs `docIds`)."""
    meta = item.get("externalMetadata")
    if meta is None:
        meta = item.get("external_metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            return []
    entries = meta if isinstance(meta, list) else [meta] if meta else []
    return [str(entry["doc_id"]) for entry in entries if isinstance(entry, dict) and isinstance(entry.get("doc_id"), str)]


def multipart(fields: Mapping[str, str], filename: str, content: bytes) -> tuple[bytes, str]:
    """Build a multipart/form-data body with text `fields` and one `data` file part. Returns (body, content type)."""
    boundary = "----cognee" + uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode() + value.encode() + b"\r\n")
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="data"; filename="{filename}"\r\nContent-Type: text/markdown\r\n\r\n'.encode()
        + content
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def clean_label(tag: str) -> str:
    """Cognee labels cannot contain commas."""
    return tag.replace(",", "_").strip()


class CogneeSink:
    capabilities = Capabilities(async_ingest=True)

    def __init__(self, url: str, api_key: str | None = None):
        self.url = url.rstrip("/")
        self._api_key = api_key or None
        self._datasets: dict[str, str] = {}
        self._dirty: set[str] = set()

    # HTTP

    def _headers(self, extra: Mapping[str, str] | None = None) -> dict[str, str]:
        headers = dict(extra or {})
        if self._api_key:
            headers["X-Api-Key"] = self._api_key
        return headers

    def _request(self, method: str, path: str, payload: dict | None = None, *, raw: bytes | None = None, content_type: str | None = None, timeout: int = TIMEOUT):
        url = self.url + path
        if raw is not None:
            data, extra = raw, {"Content-Type": content_type or "application/octet-stream"}
        elif payload is not None:
            data, extra = json.dumps(payload).encode(), {"Content-Type": "application/json"}
        else:
            data, extra = None, {}
        request = urllib.request.Request(url, data=data, headers=self._headers(extra), method=method)
        try:
            with open_url(request, timeout) as response:
                body = read_all(response)
        except urllib.error.HTTPError as error:
            text = read_all(error).decode(errors="replace")
            if self._api_key:
                text = text.replace(self._api_key, "***")
            raise HttpError(method, url, error.code, text[:300]) from error
        if not body:
            return {}
        try:
            return json.loads(body)
        except ValueError:
            return {}

    def health(self) -> bool:
        try:
            request = urllib.request.Request(self.url + "/health", headers=self._headers())
            with open_url(request, HEALTH_TIMEOUT) as response:
                return 200 <= response.status < 300
        except (OSError, ValueError):  # includes HTTPError (3xx and errors), URLError and malformed replies
            return False

    # Datasets

    def prepare(self, bank: str) -> None:
        self._dataset_id(bank)

    def _dataset_id(self, bank: str) -> str:
        if bank not in self._datasets:
            response = self._request("POST", "/api/v1/datasets", {"name": dataset_name(bank)})
            dataset_id = response.get("id") if isinstance(response, dict) else None
            if not dataset_id:
                raise SinkError(f"POST {self.url}/api/v1/datasets: reply carries no dataset id")
            self._datasets[bank] = str(dataset_id)
        return self._datasets[bank]

    def _find_dataset(self, bank: str) -> str | None:
        """The dataset id for `bank` when it exists; never creates it."""
        if bank in self._datasets:
            return self._datasets[bank]
        name = dataset_name(bank)
        response = self._request("GET", "/api/v1/datasets")
        for item in response if isinstance(response, list) else []:
            if isinstance(item, dict) and item.get("name") == name and item.get("id"):
                self._datasets[bank] = str(item["id"])
                return self._datasets[bank]
        return None

    def _list_data(self, dataset_id: str) -> list[dict]:
        items: list[dict] = []
        offset = 0
        while True:
            page = self._request("GET", f"/api/v1/datasets/{urllib.parse.quote(dataset_id, safe='')}/data?limit={PAGE}&offset={offset}")
            if not isinstance(page, list):
                raise SinkError(f"GET dataset data: expected a list, got {type(page).__name__}")
            items.extend(item for item in page if isinstance(item, dict))
            if len(page) < PAGE:
                return items
            offset += len(page)

    def _matching(self, dataset_id: str, doc_id: str) -> list[str]:
        """Ids of the dataset's items whose external metadata carries `doc_id` (dict, list, or JSON string)."""
        ids = []
        for item in self._list_data(dataset_id):
            if doc_id in metadata_doc_ids(item) and item.get("id"):
                ids.append(str(item["id"]))
        return ids

    def _delete_data(self, dataset_id: str, data_ids: list[str]) -> None:
        for data_id in data_ids:
            try:
                self._request("DELETE", f"/api/v1/datasets/{urllib.parse.quote(dataset_id, safe='')}/data/{urllib.parse.quote(data_id, safe='')}")
            except HttpError as error:
                # 404: the data is already gone. 401/403 are auth failures and raise.
                if error.status != 404:
                    raise

    # Documents

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
        dataset_id = self._dataset_id(bank)
        try:
            existing = self._matching(dataset_id, doc_id)
        except HttpError as error:
            if error.status != 404:
                raise
            # The cached dataset was removed behind our back: recreate it and look again.
            self._datasets.pop(bank, None)
            dataset_id = self._dataset_id(bank)
            existing = self._matching(dataset_id, doc_id)
        self._delete_data(dataset_id, existing)
        meta: dict = {str(key): str(value) for key, value in (metadata or {}).items()}
        meta["doc_id"] = doc_id
        meta["bank"] = bank
        if tags:
            meta["tags"] = list(tags)
        if context is not None:
            meta["context"] = context
        if timestamp is not None:
            meta["timestamp"] = timestamp
        fields = {"datasetName": dataset_name(bank), "external_metadata": json.dumps([meta])}
        if tags:
            fields["labels"] = json.dumps([clean_label(tags[0])])
        body, content_type = multipart(fields, upload_name(doc_id, content), upload_text(doc_id, content).encode())
        self._request("POST", "/api/v1/add", raw=body, content_type=content_type, timeout=ADD_TIMEOUT)
        self._dirty.add(bank)

    def delete(self, bank: str, doc_id: str) -> None:
        dataset_id = self._find_dataset(bank)
        if dataset_id is None:
            return
        try:
            existing = self._matching(dataset_id, doc_id)
        except HttpError as error:
            # 404: the dataset is gone, so is the document.
            if error.status != 404:
                raise
            self._datasets.pop(bank, None)
            return
        if existing:
            self._delete_data(dataset_id, existing)
            self._dirty.add(bank)

    def flush(self, bank: str | None = None) -> None:
        """`flush(bank)`: run cognify for `bank` now (see the module docstring). `flush(None)`: every dirty bank."""
        for name in sorted(self._dirty) if bank is None else [bank]:
            self._cognify(name)

    def _peek(self, dataset_id: str) -> list | None:
        """One data item of the dataset ([] when empty), or None when the dataset is gone (404)."""
        try:
            page = self._request("GET", f"/api/v1/datasets/{urllib.parse.quote(dataset_id, safe='')}/data?limit=1&offset=0")
        except HttpError as error:
            if error.status != 404:
                raise
            return None
        return page if isinstance(page, list) else []

    def _cognify(self, bank: str) -> None:
        dataset_id = self._find_dataset(bank)
        page = self._peek(dataset_id) if dataset_id else None
        if page is None and dataset_id:
            # The cached id went stale: look the dataset up by name once more.
            self._datasets.pop(bank, None)
            dataset_id = self._find_dataset(bank)
            page = self._peek(dataset_id) if dataset_id else None
        if page:
            self._request("POST", "/api/v1/cognify", {"datasets": [dataset_name(bank)], "runInBackground": True})
        self._dirty.discard(bank)


def create(url: str | None = None, **_cfg) -> CogneeSink:
    url = url or os.environ.get("MEMORY_API_URL")
    if not url:
        raise SinkError("the cognee sink needs a server URL: pass --url or set MEMORY_API_URL")
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise SinkError("the cognee sink URL must start with http:// or https://")
    return CogneeSink(url, os.environ.get("COGNEE_API_KEY"))
