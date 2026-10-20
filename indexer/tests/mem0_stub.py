"""A stateful mem0 REST stub for the mem0 sink tests, following `server/main.py` in github.com/mem0ai/mem0.

`mem0_route(api_key=None)` returns a `Mem0Stub`, a callable `(method, path, body) -> (status, json)` for
`stub_server.serving`. It emulates only the endpoints the sink uses and the replies that matter to it:

- `GET /docs` answers 200 and needs no key (the server leaves it open).
- With `api_key` set, every other request needs `X-API-Key: <api_key>`, else 401. The route cannot see headers, so
  the stub reads them from the `RecordingStub` bound by `mem0_serving` (a wrapper around `serving`); with no key
  configured there is nothing to check and plain `serving` works too.
- `POST /memories` with `{"messages", "user_id", "agent_id", "run_id", "metadata", "infer"}`: 400 when no identifier
  is given. Like the server's `_validate_and_trim_entity_id`, an id is trimmed and then a 400 when it is empty or
  still contains whitespace (user_id, agent_id and run_id, on writes and on list filters alike). Caller metadata is
  treated as the real payload treats it: the keys mem0 owns or overwrites (`RESERVED_KEYS`, identity keys included)
  are silently dropped, never an error, so a sink that forgets to rename them loses data here too. With `infer`
  exactly false, each message becomes one memory whose text is stored verbatim. With `infer` true or missing the stub
  stores a rewritten text, as the real server's LLM would, so a sink that forgets `infer: false` is caught. Memory
  ids are server-generated UUIDs; the memories are keyed by (user_id, run_id, id).
- `GET /memories?user_id=&run_id=&agent_id=&top_k=`: `{"results": [...]}` of the memories matching every given
  (trimmed) filter, at most `top_k` of them (default 20, like a client that forgot the parameter; above 1000 is a 422). With
  no identifier it answers 403 (admin only). Each result carries `id`, `memory`, `user_id`, `agent_id`, `run_id`,
  `metadata`.
- `DELETE /memories/{id}`: 200 `{"message": "Memory deleted successfully"}`, or 404 for an unknown id.
- `DELETE /memories?...` and `/reset` answer 403: they need an admin key, which the sink must never rely on.
"""

import re
import urllib.parse
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from stub_server import RecordingStub, serving

RESERVED_KEYS = {"data", "user_id", "agent_id", "run_id", "actor_id", "hash", "created_at", "updated_at", "expiration_date", "role", "text_lemmatized", "attributed_to"}
DEFAULT_TOP_K = 20
MAX_TOP_K = 1000
MEMORY_PATH = re.compile(r"^/memories/([^/?]+)$")


def trim_entity_id(value, name: str) -> tuple[str | None, str | None]:
    """The server's `_validate_and_trim_entity_id`: (trimmed id or None, error message or None)."""
    if value is None:
        return None, None
    trimmed = str(value).strip()
    if trimmed == "":
        return None, f"Invalid {name}: cannot be empty or whitespace-only. Provide a valid identifier."
    if any(char.isspace() for char in trimmed):
        return None, f"Invalid {name}: cannot contain whitespace. Provide a valid identifier without spaces."
    return trimmed, None


class Mem0Stub:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key
        self.memories: dict[str, dict] = {}  # id -> record, in insertion order
        self.recording: RecordingStub | None = None

    def bind(self, recording: RecordingStub) -> None:
        self.recording = recording

    def texts(self, user_id: str, run_id: str) -> list[str]:
        """The stored texts of one document, in write order."""
        return [item["memory"] for item in self.memories.values() if item["user_id"] == user_id and item["run_id"] == run_id]

    def records(self, user_id: str, run_id: str) -> list[dict]:
        return [item for item in self.memories.values() if item["user_id"] == user_id and item["run_id"] == run_id]

    def _authorized(self, path: str) -> bool:
        if self.api_key is None or path.split("?", 1)[0] in {"/docs", "/openapi.json"}:
            return True
        assert self.recording is not None, "use mem0_serving(route) so the stub can read request headers"
        with self.recording._lock:  # RecordingStub appends this request's headers under the same lock
            sent = self.recording.headers[-1].get("x-api-key")
        return sent == self.api_key

    def __call__(self, method: str, path: str, body):
        if method == "GET" and path == "/docs":
            return 200, {}
        if not self._authorized(path):
            return 401, {"detail": "Invalid or missing API key"}
        route, _, query = path.partition("?")
        if route == "/memories" and method == "POST":
            return self._add(body)
        if route == "/memories" and method == "GET":
            return self._list(urllib.parse.parse_qs(query, keep_blank_values=True))
        if route in ("/memories", "/reset") and method in ("DELETE", "POST"):
            return 403, {"detail": "Admin role required."}
        if (match := MEMORY_PATH.match(path)) and method == "DELETE":
            memory_id = urllib.parse.unquote(match.group(1))
            if self.memories.pop(memory_id, None) is None:
                return 404, {"detail": f"Memory with id {memory_id} not found"}
            return 200, {"message": "Memory deleted successfully"}
        return 500, {"detail": f"unexpected {method} {path}"}

    def _add(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list) or not body["messages"]:
            return 422, {"detail": "messages required"}
        if not any(body.get(key) for key in ("user_id", "agent_id", "run_id")):
            return 400, {"detail": "At least one identifier (user_id, agent_id, run_id) is required."}
        ids = {}
        for key in ("user_id", "agent_id", "run_id"):
            ids[key], problem = trim_entity_id(body.get(key), key)
            if problem:
                return 400, {"detail": problem}
        metadata = {key: value for key, value in (body.get("metadata") or {}).items() if key not in RESERVED_KEYS}
        results = []
        for message in body["messages"]:
            text = message["content"] if body.get("infer") is False else "inferred: " + message["content"][:20]
            memory_id = str(uuid.uuid4())
            self.memories[memory_id] = {"id": memory_id, "memory": text, **ids, "metadata": dict(metadata)}
            results.append({"id": memory_id, "memory": text, "event": "ADD"})
        return 200, {"results": results}

    def _list(self, query: dict[str, list[str]]):
        filters = {}
        for key in ("user_id", "run_id", "agent_id"):
            if query.get(key) and query[key][0]:
                filters[key], problem = trim_entity_id(query[key][0], key)
                if problem:
                    return 400, {"detail": problem}
        if not filters:
            return 403, {"detail": "Admin role required to list all memories."}
        top_k = int(query["top_k"][0]) if query.get("top_k") else DEFAULT_TOP_K
        if not 0 <= top_k <= MAX_TOP_K:
            return 422, {"detail": "top_k out of range"}
        matching = [item for item in self.memories.values() if all(item[key] == value for key, value in filters.items())]
        return 200, {"results": [dict(item) for item in matching[:top_k]]}


def mem0_route(api_key: str | None = None) -> Mem0Stub:
    """A fresh stateful mem0 stub; `api_key` turns authentication on."""
    return Mem0Stub(api_key)


@contextmanager
def mem0_serving(route: Mem0Stub) -> Iterator[RecordingStub]:
    """`serving(route)` that also tells the stub which RecordingStub holds the request headers."""
    with serving(route) as stub:
        route.bind(stub)
        yield stub
