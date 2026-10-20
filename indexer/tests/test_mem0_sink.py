"""mem0 sink: contract, wire format, auth, id mapping, chunking, upsert ordering and the indexer CLI against a stateful mem0 stub."""

import hashlib
import socket
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import sinks
import sinks._http as http_helper
import sinks.mem0 as mem0_sink
from hindsight_stub import build_fixture, mutate_fixture, run_script, scenario_args
from mem0_stub import mem0_route, mem0_serving
from sink_contract import AWKWARD_BANK, run_sink_contract
from stub_server import closed_port_url, serving

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "hindsight-project-index"
BANK = "contract::bank"
AWKWARD_MAPPED = "coding-agent::proj_with_space/and_slash~" + hashlib.sha256(AWKWARD_BANK.encode()).hexdigest()[:8]
AWKWARD_QUOTED = "coding-agent%3A%3Aproj_with_space%2Fand_slash~" + hashlib.sha256(AWKWARD_BANK.encode()).hexdigest()[:8]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("MEMORY_API_URL", raising=False)
    monkeypatch.delenv("MEM0_API_KEY", raising=False)


def mem0(url: str) -> sinks.Sink:
    return sinks.get_sink("mem0", url=url)


def shape(requests: list[dict]) -> list[tuple[str, str]]:
    return [(request["method"], request["path"]) for request in requests]


def methods(requests: list[dict]) -> list[str]:
    return [request["method"] for request in requests]


def list_path(user_id: str, run_id: str) -> str:
    return f"/memories?user_id={user_id}&run_id={run_id}&top_k=1000"


@contextmanager
def raw_http(handler):
    """A loopback HTTP server whose reply is `handler(method, path, body) -> (status, headers, body_bytes)`; records requests."""
    seen: list[tuple[str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            seen.append((self.command, self.path))
            status, headers, payload = handler(self.command, self.path, body)
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True

        do_GET = do_POST = do_DELETE = _handle

        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def garbage_listener():
    """A TCP listener that answers every connection with bytes that are not HTTP, then closes."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    stop = threading.Event()

    def serve() -> None:
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except OSError:
                return
            with connection:
                connection.settimeout(1)
                try:
                    connection.recv(65536)
                    connection.sendall(b"this is not http\r\n\r\n")
                except OSError:
                    pass

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        stop.set()
        socket.create_connection(listener.getsockname(), timeout=1).close()  # wake the blocked accept()
        listener.close()
        thread.join(timeout=5)


# Contract and exact request shapes

def test_mem0_sink_contract():
    route = mem0_route()
    result = run_sink_contract(mem0, lambda: serving(route))
    steps = result.steps

    assert shape(steps["health"]) == [("GET", "/docs")]
    assert steps["prepare"] == [] and steps["prepare_again"] == []

    # retain_minimal: nothing to replace, so a lookup then one write.
    get, post = steps["retain_minimal"]
    assert (get["method"], get["path"]) == ("GET", list_path("contract%3A%3Abank", "doc-1"))
    assert get["body"] is None
    assert (post["method"], post["path"]) == ("POST", "/memories")
    assert post["body"] == {
        "messages": [{"role": "user", "content": "first body"}],
        "user_id": BANK,
        "agent_id": "personal-memory-indexer",
        "run_id": "doc-1",
        "infer": False,
        "metadata": {},
    }

    # retain_full: every optional argument lands in metadata, never in a mem0 field mem0 would reinterpret.
    (_get, full) = steps["retain_full"]
    assert full["body"] == {
        "messages": [{"role": "user", "content": "second body"}],
        "user_id": BANK,
        "agent_id": "personal-memory-indexer",
        "run_id": "doc-2",
        "infer": False,
        "metadata": {"path": "x.md", "kind": "doc", "tags": ["a", "b"], "context": "Project proj doc source", "timestamp": "2026-01-02T03:04:05Z"},
    }

    # upsert: snapshot the old ids, write the new text, only then delete the old memory by id.
    upsert = steps["retain_upsert"]
    assert methods(upsert) == ["GET", "POST", "DELETE"]
    assert upsert[0]["path"] == list_path("contract%3A%3Abank", "doc-1")
    assert upsert[1]["body"]["messages"] == [{"role": "user", "content": "first body, edited"}]
    assert upsert[1]["body"]["infer"] is False
    assert upsert[2]["path"].startswith("/memories/") and upsert[2]["body"] is None

    # awkward bank: mapped to a whitespace-free user_id, then percent-encoded in the lookup and verbatim in the body.
    get, post = steps["retain_awkward_bank"]
    assert get["path"] == list_path(AWKWARD_QUOTED, "doc-3")
    assert " " not in get["path"] and " " not in post["path"]
    assert post["body"]["user_id"] == AWKWARD_MAPPED and not any(char.isspace() for char in post["body"]["user_id"])

    # delete: lookup then one DELETE; delete of a document mem0 does not know is only the lookup.
    assert methods(steps["delete"]) == ["GET", "DELETE"]
    assert shape(steps["delete_missing"]) == [("GET", list_path("contract%3A%3Abank", "never-retained"))]

    # The whole run left exactly one version of each surviving document, all stored verbatim.
    assert route.texts(BANK, "doc-1") == []
    assert route.texts(BANK, "doc-2") == ["second body"]
    assert route.texts(AWKWARD_MAPPED, "doc-3") == ["body"]
    assert all(item["agent_id"] == "personal-memory-indexer" for item in route.memories.values())


def test_every_post_sends_infer_false():
    route = mem0_route()
    with mem0_serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b", "d1", "x")
        sink.retain("b", "d1", "y" * 7000, tags=["t"])
        sink.retain("b", "d2", "z", metadata={"k": "v"}, context="c", timestamp="t")
    posts = [request["body"] for request in stub.requests if request["method"] == "POST"]
    assert len(posts) == 5
    assert all(body["infer"] is False for body in posts)
    assert route.texts("b", "d2") == ["z"]


def test_trailing_slash_is_trimmed_and_registered_by_module_name():
    assert "mem0" in sinks.registered_sinks()
    sink = sinks.get_sink("mem0", url="http://m:1/")
    assert isinstance(sink, mem0_sink.Mem0Sink) and sink.url == "http://m:1"
    with serving(mem0_route()) as stub:
        mem0(stub.url + "/").retain("b", "d", "x")
    assert stub.requests[0]["path"].startswith("/memories?") and not stub.requests[0]["path"].startswith("//")


def test_protocol_conformance_and_capabilities():
    sink = mem0("http://127.0.0.1:1")
    assert isinstance(sink, sinks.Sink)
    assert sink.capabilities.async_ingest is False
    assert mem0_sink.Mem0Sink.capabilities == sinks.Capabilities(async_ingest=False)


def test_the_shared_http_helper_is_not_a_registered_sink():
    assert "_http" not in sinks.registered_sinks()
    with pytest.raises(sinks.UnknownSinkError):
        sinks.get_sink("_http")


# Entity id mapping (bank -> user_id, doc_id -> run_id)

@pytest.mark.parametrize("value", ["plain", "coding-agent::proj", "obsidian::my-vault", "project-index:v1:" + "ab" * 16, "a/b\\c", "ünï-cødé", "x" * 500, "~tilde", "a_b~12345678"])
def test_scope_id_is_the_identity_without_whitespace(value):
    assert mem0_sink.scope_id(value) == value


def test_scope_id_replaces_whitespace_runs_and_appends_a_hash_of_the_original():
    def digest(value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()[:8]

    assert mem0_sink.scope_id("My Vault") == "My_Vault~" + digest("My Vault")
    assert mem0_sink.scope_id("a \t\n  b") == "a_b~" + digest("a \t\n  b")
    assert mem0_sink.scope_id(" lead and trail ") == "_lead_and_trail_~" + digest(" lead and trail ")
    assert mem0_sink.scope_id("nb\u00a0sp") == "nb_sp~" + digest("nb\u00a0sp")
    assert mem0_sink.scope_id("   ") == "_~" + digest("   ")
    assert mem0_sink.scope_id(AWKWARD_BANK) == AWKWARD_MAPPED


def test_scope_id_is_deterministic_and_keeps_whitespace_variants_apart():
    values = ["a b", "a  b", "a\tb", "a_b", " a b", "a b "]
    mapped = [mem0_sink.scope_id(value) for value in values]
    assert mapped == [mem0_sink.scope_id(value) for value in values]
    assert len(set(mapped)) == len(values)
    assert not any(char.isspace() for value in mapped for char in value)


def test_ids_with_whitespace_are_mapped_for_lookup_write_and_delete():
    route = mem0_route()  # the stub answers 400 for whitespace in any id, as the real server does
    bank, doc = "obsidian::My Vault", "notes/two words.md"
    with mem0_serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain(bank, doc, "one")
        sink.retain(bank, doc, "two")
        mapped_bank, mapped_doc = mem0_sink.scope_id(bank), mem0_sink.scope_id(doc)
        assert route.texts(mapped_bank, mapped_doc) == ["two"]
        sink.delete(bank, doc)
    assert route.memories == {}
    for request in stub.requests:
        assert " " not in request["path"]
        if request["method"] == "POST":
            assert not any(char.isspace() for char in request["body"]["user_id"] + request["body"]["run_id"])
    assert stub.requests[0]["path"].startswith("/memories?user_id=obsidian%3A%3AMy_Vault~")


def test_the_stub_rejects_whitespace_ids_like_the_real_server():
    route = mem0_route()
    body = {"messages": [{"role": "user", "content": "x"}], "user_id": "has space", "infer": False}
    assert route("POST", "/memories", body)[0] == 400
    assert route("POST", "/memories", {**body, "user_id": "ok", "run_id": "a\tb"})[0] == 400
    assert route("POST", "/memories", {**body, "user_id": "ok", "agent_id": "a b"})[0] == 400
    assert route("POST", "/memories", {**body, "user_id": "   "})[0] == 400
    assert route("GET", "/memories?user_id=has%20space&top_k=10", None)[0] == 400
    assert route("POST", "/memories", {**body, "user_id": " padded "})[0] == 200  # trimmed, like the server
    assert next(iter(route.memories.values()))["user_id"] == "padded"


# Upsert and delete semantics

def test_retain_twice_leaves_one_set_of_memories():
    route = mem0_route()
    with mem0_serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b", "d", "first " * 700)  # several chunks
        before = route.records("b", "d")
        sink.retain("b", "d", "second")
    assert len(before) > 1
    assert route.texts("b", "d") == ["second"]
    assert len(route.memories) == 1
    assert not set(item["id"] for item in before) & set(route.memories)


def test_documents_and_banks_are_isolated():
    route = mem0_route()
    with mem0_serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b1", "d", "one")
        sink.retain("b2", "d", "two")
        sink.retain("b1", "other", "three")
        sink.delete("b1", "d")
    assert route.texts("b1", "d") == [] and route.texts("b2", "d") == ["two"] and route.texts("b1", "other") == ["three"]


def test_delete_swallows_404_per_id_and_still_deletes_the_rest():
    deletes = []

    def route(method, path, body):
        if method == "GET":
            return 200, {"results": [{"id": "gone"}, {"id": "a/b c"}, {"id": "last"}]}
        deletes.append(path)
        return (404, {"detail": "Memory with id gone not found"}) if path.endswith("gone") else (200, {"message": "Memory deleted successfully"})

    with serving(route) as stub:
        mem0(stub.url).delete("b", "d")
    assert deletes == ["/memories/gone", "/memories/a%2Fb%20c", "/memories/last"]


def test_retain_swallows_404_when_removing_old_memories():
    state = mem0_route()

    def route(method, path, body):
        if method == "DELETE":
            state(method, path, body)  # really delete it, but report 404 as if it had vanished first
            return 404, {"detail": "not found"}
        return state(method, path, body)

    with serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b", "d", "old")
        sink.retain("b", "d", "new")
    assert state.texts("b", "d") == ["new"]


def test_delete_propagates_non_404_errors():
    def route(method, path, body):
        if method == "GET":
            return 200, {"results": [{"id": "x"}]}
        return 500, {"detail": "boom"}

    with serving(route) as stub, pytest.raises(mem0_sink.HttpError) as caught:
        mem0(stub.url).delete("b", "d")
    assert caught.value.status == 500 and "HTTP 500" in str(caught.value)


def test_empty_and_non_json_delete_bodies_are_tolerated():
    state = mem0_route()

    def quiet_delete(reply):
        def route(method, path, body):
            status, answer = state(method, path, body)
            return (status, reply) if method == "DELETE" else (status, answer)

        return route

    for reply in (None, "deleted", {"message": "Memory deleted successfully"}):
        with serving(quiet_delete(reply)) as stub:
            sink = mem0(stub.url)
            sink.retain("b", "d", "x")
            sink.delete("b", "d")
        assert state.texts("b", "d") == []


@pytest.mark.parametrize(
    "reply",
    [None, [], "text", {}, {"results": None}, {"results": {}}, {"results": [1]}, {"results": [{}]}, {"results": [{"id": 5}]}, {"results": [{"id": ""}]}, {"results": [{"id": "ok"}, {"memory": "no id"}]}],
)
def test_malformed_listing_is_an_error_not_an_empty_document(reply):
    with serving(lambda *_: (200, reply)) as stub:
        with pytest.raises(sinks.SinkError, match="unexpected reply"):
            mem0(stub.url).retain("b", "d", "x")
        with pytest.raises(sinks.SinkError):
            mem0(stub.url).delete("b", "d")
    assert set(methods(stub.requests)) == {"GET"}


def test_an_empty_results_list_is_a_valid_listing():
    with serving(lambda method, path, body: (200, {"results": []}) if method == "GET" else (200, {"results": [{"id": "n", "event": "ADD"}]})) as stub:
        mem0(stub.url).retain("b", "d", "x")
        mem0(stub.url).delete("b", "d")
    assert methods(stub.requests) == ["GET", "POST", "GET"]


# Write-then-delete ordering and failures

def flaky(route, fail_when):
    """Wrap a stub route so that requests for which fail_when(method, path, n) is true answer 500."""
    counts: dict[str, int] = {}

    def wrapped(method, path, body):
        counts[method] = counts.get(method, 0) + 1
        if fail_when(method, path, counts[method]):
            return 500, {"detail": "injected failure"}
        return route(method, path, body)

    return wrapped


def test_failed_chunk_post_leaves_the_old_chunks_intact_and_a_retry_converges():
    route = mem0_route()
    text = "paragraph\n\n" * 700  # three chunks
    with serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b", "d", "old text")
        (old,) = route.records("b", "d")
    failing = flaky(route, lambda method, path, n: method == "POST" and n == 2)  # the second chunk of the new text
    with serving(failing) as stub:
        sink = mem0(stub.url)
        with pytest.raises(sinks.SinkError) as caught:
            sink.retain("b", "d", text)
        assert caught.value.status == 500
        assert "DELETE" not in methods(stub.requests)
        texts = route.texts("b", "d")
        assert texts[0] == "old text" and len(texts) == 2  # old chunk intact next to the one new chunk written
        stub.clear()
        sink.retain("b", "d", text)  # what the indexer does on its next run
    assert "".join(route.texts("b", "d")) == text and len(route.records("b", "d")) == 3
    assert old["id"] not in route.memories


def test_failed_delete_leaves_old_and_new_and_a_retry_converges():
    route = mem0_route()
    with serving(route) as stub:
        mem0(stub.url).retain("b", "d", "old " * 1500)  # two chunks
        old_ids = {item["id"] for item in route.records("b", "d")}
    assert len(old_ids) == 2
    failing = flaky(route, lambda method, path, n: method == "DELETE" and n == 2)
    with serving(failing) as stub:
        sink = mem0(stub.url)
        with pytest.raises(sinks.SinkError) as caught:
            sink.retain("b", "d", "new text")
        assert caught.value.status == 500
        records = route.records("b", "d")
        assert len(records) == 2 and "new text" in route.texts("b", "d")  # one old chunk left next to the new one
        assert len(old_ids & {item["id"] for item in records}) == 1
        sink.retain("b", "d", "new text")
    assert route.texts("b", "d") == ["new text"]


def test_a_failed_list_writes_nothing():
    route = mem0_route()
    with serving(flaky(route, lambda method, path, n: method == "GET")) as stub:
        with pytest.raises(sinks.SinkError):
            mem0(stub.url).retain("b", "d", "x")
    assert methods(stub.requests) == ["GET"] and route.memories == {}


@pytest.mark.parametrize("reply", [(200, None), (200, {}), (200, {"results": []}), (200, {"results": None}), (200, ["x"]), (200, "ok")])
def test_a_post_reply_without_a_stored_result_is_an_error_and_keeps_the_old_memories(reply):
    state = mem0_route()
    with serving(state) as stub:
        mem0(stub.url).retain("b", "d", "old")

    def route(method, path, body):
        return reply if method == "POST" else state(method, path, body)

    with serving(route) as stub:
        with pytest.raises(sinks.SinkError, match="stored nothing for chunk 1 of 1 of document 'd'"):
            mem0(stub.url).retain("b", "d", "new")
    assert state.texts("b", "d") == ["old"]
    assert "DELETE" not in methods(stub.requests)


# Empty content

@pytest.mark.parametrize("content", ["", "   \n\n\t"])
def test_empty_content_removes_old_memories_and_writes_nothing(content):
    route = mem0_route()
    with mem0_serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b", "d", "something")
        stub.clear()
        sink.retain("b", "d", content)
    assert methods(stub.requests) == ["GET", "DELETE"]
    assert route.texts("b", "d") == []


# Chunking

def test_split_chunks_prefers_paragraph_then_line_then_space_and_never_loses_text():
    paragraphs = "\n\n".join(f"paragraph {index} " + "w" * 900 for index in range(8))
    chunks = mem0_sink.split_chunks(paragraphs)
    assert "".join(chunks) == paragraphs
    assert all(0 < len(chunk) <= 3000 for chunk in chunks)
    assert all(chunk.endswith("\n\n") for chunk in chunks[:-1])

    lines = "\n".join("line " * 100 for _ in range(30))
    chunks = mem0_sink.split_chunks(lines)
    assert "".join(chunks) == lines and all(chunk.endswith("\n") for chunk in chunks[:-1])

    words = " ".join(["word"] * 2000)
    chunks = mem0_sink.split_chunks(words)
    assert "".join(chunks) == words and all(chunk.endswith(" ") for chunk in chunks[:-1])

    solid = "x" * 7001
    chunks = mem0_sink.split_chunks(solid)
    assert [len(chunk) for chunk in chunks] == [3000, 3000, 1001]


def test_split_chunks_keeps_short_text_unchanged_and_drops_whitespace_only_pieces():
    assert mem0_sink.split_chunks("  indented\n") == ["  indented\n"]
    assert mem0_sink.split_chunks("") == [] and mem0_sink.split_chunks(" \n ") == []
    blank = "\n\n" * 4000
    assert mem0_sink.split_chunks(blank) == []
    assert mem0_sink.split_chunks("a" + blank + "b")[0].startswith("a")


def test_long_content_is_written_as_numbered_chunks():
    route = mem0_route()
    text = "\n\n".join(f"section {index}\n" + "body text " * 90 for index in range(30))
    assert len(text) > 3 * 3000
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", text, tags=["t"], metadata={"path": "p.md"}, context="ctx", timestamp="2026-01-01T00:00:00Z")
    posts = [request["body"] for request in stub.requests if request["method"] == "POST"]
    assert len(posts) > 3
    contents = [post["messages"][0]["content"] for post in posts]
    assert all(0 < len(content) <= 3000 for content in contents)
    assert "".join(contents) == text
    assert [post["metadata"]["chunk"] for post in posts] == list(range(len(posts)))
    assert {post["metadata"]["chunks"] for post in posts} == {len(posts)}
    for post in posts:
        assert {key: post["metadata"][key] for key in ("path", "tags", "context", "timestamp")} == {"path": "p.md", "tags": ["t"], "context": "ctx", "timestamp": "2026-01-01T00:00:00Z"}
        assert post["run_id"] == "d" and post["user_id"] == "b" and post["infer"] is False
    # Only the lookup precedes the writes (nothing old to delete afterwards).
    assert methods(stub.requests) == ["GET"] + ["POST"] * len(posts)


def test_single_chunk_documents_carry_no_chunk_metadata():
    with serving(mem0_route()) as stub:
        mem0(stub.url).retain("b", "d", "short")
    assert "chunk" not in stub.requests[1]["body"]["metadata"] and "chunks" not in stub.requests[1]["body"]["metadata"]


def test_chunk_cap_rejects_before_any_request_and_names_the_document():
    with serving(mem0_route()) as stub:
        sink = mem0(stub.url)
        with pytest.raises(sinks.SinkError, match=r"document 'big doc' needs 901 chunks .* at most 900 per document"):
            sink.retain("b", "big doc", "x" * (3000 * 900 + 1))
    assert stub.requests == []


def test_a_document_of_exactly_the_cap_is_accepted():
    route = mem0_route()
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", "x" * (3000 * 900))
    assert len(route.records("b", "d")) == 900


# Metadata

RESERVED = ["data", "user_id", "agent_id", "run_id", "actor_id", "hash", "created_at", "updated_at", "expiration_date", "role", "text_lemmatized", "attributed_to"]


def test_reserved_set_covers_what_mem0_owns_or_overwrites():
    assert set(mem0_sink.RESERVED_KEYS) == set(RESERVED)


def test_reserved_metadata_keys_are_prefixed_and_sink_keys_win():
    caller = {key: f"v-{key}" for key in RESERVED} | {"path": "a.md", "tags": "caller", "context": "caller"}
    route = mem0_route()  # like the server, the stub silently drops reserved keys, so only renamed keys survive
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", "x", tags=["t1", "t2"], metadata=caller, context="real", timestamp="ts")
    (item,) = route.records("b", "d")
    assert item["metadata"] == {**{f"meta_{key}": f"v-{key}" for key in RESERVED}, "path": "a.md", "tags": ["t1", "t2"], "context": "real", "timestamp": "ts"}
    assert item["user_id"] == "b" and item["run_id"] == "d" and item["agent_id"] == "personal-memory-indexer"


def test_the_stub_drops_reserved_metadata_instead_of_failing():
    route = mem0_route()
    body = {"messages": [{"role": "user", "content": "x"}], "user_id": "u", "infer": False, "metadata": {key: "v" for key in RESERVED} | {"keep": "me"}}
    assert route("POST", "/memories", body)[0] == 200
    assert next(iter(route.memories.values()))["metadata"] == {"keep": "me"}
    assert next(iter(route.memories.values()))["user_id"] == "u"


def test_absent_optionals_add_no_metadata_keys():
    route = mem0_route()
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", "x", tags=[], metadata=None, context=None, timestamp=None)
        mem0(stub.url).retain("b", "e", "x", context="")
    assert route.records("b", "d")[0]["metadata"] == {}
    assert route.records("b", "e")[0]["metadata"] == {"context": ""}


# Auth

def test_api_key_header_is_sent_on_every_request_except_health_and_only_when_set(monkeypatch):
    route = mem0_route()
    with mem0_serving(route) as stub:
        monkeypatch.setenv("MEM0_API_KEY", "m0sk_secret")
        keyed = mem0(stub.url)
        assert keyed.health() is True
        assert [headers.get("x-api-key") for headers in stub.headers] == [None]  # /docs is open: no key on the health check
        stub.clear()
        keyed.retain("b", "d", "x")  # GET, POST
        keyed.retain("b", "d", "y")  # GET, POST, DELETE
        keyed.delete("b", "d")  # GET, DELETE
        sent = [headers.get("x-api-key") for headers in stub.headers]
        assert len(sent) == len(stub.requests) == 2 + 3 + 2 and set(sent) == {"m0sk_secret"}

        monkeypatch.delenv("MEM0_API_KEY")
        stub.clear()
        plain = mem0(stub.url)
        plain.health()
        plain.retain("b", "d", "x")
        assert stub.requests and all("x-api-key" not in headers for headers in stub.headers)


def test_key_is_read_inside_create_and_never_from_the_url_or_path(monkeypatch):
    monkeypatch.setenv("MEM0_API_KEY", "  spaced-key \n")
    sink = mem0("http://127.0.0.1:1")
    monkeypatch.delenv("MEM0_API_KEY")
    assert sink._api_key == "spaced-key"
    assert "spaced-key" not in sink.url and "spaced-key" not in repr(sink.capabilities)
    monkeypatch.setenv("MEM0_API_KEY", "   ")
    assert mem0("http://127.0.0.1:1")._api_key is None


def test_authenticated_stub_works_end_to_end_with_the_right_key(monkeypatch):
    route = mem0_route(api_key="m0sk_right")
    monkeypatch.setenv("MEM0_API_KEY", "m0sk_right")
    result = run_sink_contract(mem0, lambda: mem0_serving(route))
    assert result.steps["retain_upsert"]


def test_wrong_or_missing_key_raises_sink_error_401_without_leaking_it(monkeypatch):
    route = mem0_route(api_key="m0sk_right")
    with mem0_serving(route) as stub:
        monkeypatch.setenv("MEM0_API_KEY", "m0sk_wrong_key_value")
        with pytest.raises(sinks.SinkError) as caught:
            mem0(stub.url).retain("b", "d", "x")
        assert caught.value.status == 401 and isinstance(caught.value, mem0_sink.HttpError)
        assert "m0sk_wrong_key_value" not in str(caught.value) and "m0sk_right" not in str(caught.value)
        assert "HTTP 401" in str(caught.value)
        with pytest.raises(sinks.SinkError) as caught:
            mem0(stub.url).delete("b", "d")
        assert caught.value.status == 401 and "m0sk_wrong_key_value" not in str(caught.value)

        monkeypatch.delenv("MEM0_API_KEY")
        with pytest.raises(sinks.SinkError) as caught:
            mem0(stub.url).retain("b", "d", "x")
        assert caught.value.status == 401
        assert mem0(stub.url).health() is True  # /docs is open
    assert route.memories == {}


def test_key_echoed_by_the_server_is_masked_in_error_messages(monkeypatch):
    monkeypatch.setenv("MEM0_API_KEY", "m0sk_echoed_secret")
    with serving(lambda *_: (400, {"detail": "bad key m0sk_echoed_secret"})) as stub:
        with pytest.raises(sinks.SinkError) as caught:
            mem0(stub.url).retain("b", "d", "x")
    assert "m0sk_echoed_secret" not in str(caught.value) and "***" in str(caught.value)


# Redirects, malformed HTTP and the shared helper

def test_redirects_are_never_followed():
    handler = http_helper.NoRedirect()
    request = urllib.request.Request("http://a.example:8000/", headers={"X-API-Key": "k"})
    for target in ("http://evil.example/x", "http://a.example:9000/x", "http://a.example:8000/docs"):
        for code in (301, 302, 303, 307, 308):
            assert handler.redirect_request(request, None, code, "Moved", {}, target) is None
    assert any(isinstance(h, http_helper.NoRedirect) for h in http_helper.OPENER.handlers)
    assert not any(type(h) is urllib.request.HTTPRedirectHandler for h in http_helper.OPENER.handlers)


def test_a_302_on_a_write_raises_http_error_302_and_is_not_followed(monkeypatch):
    monkeypatch.setenv("MEM0_API_KEY", "m0sk_secret")

    def handler(method, path, body):
        if method == "GET" and path.startswith("/memories?"):
            return 200, {"Content-Type": "application/json"}, b'{"results": []}'
        if method == "POST":
            return 302, {"Location": "/memories/elsewhere"}, b""
        return 200, {}, b"{}"

    with raw_http(handler) as (url, seen):
        with pytest.raises(mem0_sink.HttpError) as caught:
            mem0(url).retain("b", "d", "x")
    assert caught.value.status == 302 and "HTTP 302" in str(caught.value)
    assert [method for method, _ in seen] == ["GET", "POST"]  # no GET /memories/elsewhere afterwards
    assert "m0sk_secret" not in str(caught.value)


def test_a_redirect_to_another_host_is_an_error_and_health_is_false():
    with raw_http(lambda *_: (301, {"Location": "http://other.example.invalid/docs"}, b"")) as (url, seen):
        assert mem0(url).health() is False
        with pytest.raises(mem0_sink.HttpError) as caught:
            mem0(url).delete("b", "d")
    assert caught.value.status == 301
    assert [path for _, path in seen] == ["/docs", list_path("b", "d")]


def test_non_http_reply_is_unreachable_not_an_exception_leak():
    with garbage_listener() as url:
        sink = mem0(url)
        assert sink.health() is False
        with pytest.raises((sinks.SinkError, OSError)):
            sink.retain("b", "d", "x")
        with pytest.raises((sinks.SinkError, OSError)):
            sink.delete("b", "d")


def test_truncated_reply_body_is_an_os_error_not_a_raw_http_client_exception():
    def handler(method, path, body):
        return 200, {"Content-Type": "application/json", "Content-Length": "500"}, b'{"results": ['

    with raw_http(handler) as (url, _seen):
        with pytest.raises(OSError, match="IncompleteRead"):
            mem0(url).delete("b", "d")


def test_open_url_converts_http_client_errors_to_os_error():
    with garbage_listener() as url:
        with pytest.raises(OSError) as caught:
            http_helper.open_url(urllib.request.Request(url + "/docs"), 5)
        assert not isinstance(caught.value, urllib.error.HTTPError)
    with raw_http(lambda *_: (302, {"Location": "/x"}, b"")) as (url, seen):
        with pytest.raises(urllib.error.HTTPError) as caught:
            http_helper.open_url(urllib.request.Request(url + "/docs"), 5)
        assert caught.value.code == 302 and len(seen) == 1


# URL

def test_missing_url_is_a_clear_sink_and_value_error():
    for url in (None, "", "  "):
        with pytest.raises(sinks.SinkError) as caught:
            sinks.get_sink("mem0", url=url)
        assert isinstance(caught.value, ValueError)
        assert str(caught.value) == "mem0 sink needs an API URL: set MEMORY_API_URL or pass --url"
        assert caught.value.status is None
    with pytest.raises(sinks.SinkError) as caught:
        sinks.get_sink("mem0")
    assert "MEMORY_API_URL" in str(caught.value)


def test_url_falls_back_to_memory_api_url_and_explicit_url_wins(monkeypatch):
    monkeypatch.setenv("MEMORY_API_URL", "http://env.example:7/")
    assert sinks.get_sink("mem0").url == "http://env.example:7"
    assert sinks.get_sink("mem0", url="http://flag.example:8").url == "http://flag.example:8"


def test_url_without_a_scheme_is_rejected_without_echoing_it():
    with pytest.raises(sinks.SinkError, match="http:// or https://") as caught:
        sinks.get_sink("mem0", url="localhost:18888")
    assert "localhost" not in str(caught.value)
    with pytest.raises(sinks.SinkError, match="no host"):
        sinks.get_sink("mem0", url="http://")
    with pytest.raises(sinks.SinkError, match="not a valid URL"):
        sinks.get_sink("mem0", url="http://host:notaport")


@pytest.mark.parametrize("url", ["http://user:hunter2@mem0.example:8888", "https://user@mem0.example", "http://:hunter2@mem0.example", "http://a@b@mem0.example"])
def test_url_with_userinfo_is_rejected_without_echoing_the_password(url):
    with pytest.raises(sinks.SinkError, match="must not contain credentials") as caught:
        sinks.get_sink("mem0", url=url)
    assert isinstance(caught.value, ValueError)
    assert "hunter2" not in str(caught.value) and "user" not in str(caught.value).replace("user:pass@host", "")
    assert "MEM0_API_KEY" in str(caught.value)


def test_userinfo_url_from_the_environment_is_rejected_too(monkeypatch):
    monkeypatch.setenv("MEMORY_API_URL", "http://u:hunter2@mem0.example")
    with pytest.raises(sinks.SinkError, match="must not contain credentials") as caught:
        sinks.get_sink("mem0")
    assert "hunter2" not in str(caught.value)


# Health and connection failures

def test_health_is_false_on_http_errors_and_never_raises_on_a_closed_port():
    for status in (500, 401, 404, 302):
        with serving(lambda *_args, status=status: (status, {})) as stub:
            assert mem0(stub.url).health() is False
    assert mem0(closed_port_url()).health() is False
    assert mem0("http://127.0.0.1:1").health() is False


def test_http_error_message_has_method_url_status_and_a_bounded_body():
    with serving(lambda *_: (500, {"detail": "e" * 1000})) as stub:
        with pytest.raises(mem0_sink.HttpError) as caught:
            mem0(stub.url).retain("b", "d", "x")
    message = str(caught.value)
    assert message.startswith(f"GET {stub.url}/memories?") and "HTTP 500" in message
    assert len(message) < len(stub.url) + 400
    assert caught.value.status == 500


def test_unreachable_server_raises_sink_error_or_os_error():
    dead = mem0(closed_port_url())
    with pytest.raises((sinks.SinkError, OSError)):
        dead.retain("b", "d", "x")
    with pytest.raises((sinks.SinkError, OSError)):
        dead.delete("b", "d")


# CLI

def test_cli_with_mem0_sink_indexes_both_banks_and_converges_on_change(tmp_path):
    repo, vault = build_fixture(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    state = tmp_path / "state" / "state.json"
    args = scenario_args(repo, vault, state)
    route = mem0_route()
    with mem0_serving(route) as stub:
        env = {"MEMORY_SINK": "mem0", "MEMORY_API_URL": stub.url}
        first = run_script(SCRIPT, args, env, home)
        assert first.returncode == 0, first.stderr
        by_user = {}
        for item in route.memories.values():
            by_user.setdefault(item["user_id"], []).append(item)
        assert set(by_user) == {"coding-agent::proj", "obsidian::my-vault"}
        assert len(by_user["coding-agent::proj"]) == 2 and len(by_user["obsidian::my-vault"]) == 1
        assert all(item["agent_id"] == "personal-memory-indexer" and item["run_id"].startswith(("project-index:v1:", "obsidian-index:v1:")) for item in route.memories.values())
        assert any("First version of the readme." in item["memory"] for item in by_user["coding-agent::proj"])
        (note,) = by_user["obsidian::my-vault"]
        assert note["metadata"]["tags"] == ["work", "infra", "ops"] and note["metadata"]["kind"] == "note"
        assert [request["method"] for request in stub.requests if request["method"] not in ("GET", "POST", "DELETE")] == []

        mutate_fixture(repo, vault)
        second = run_script(SCRIPT, args, env, home)
        assert second.returncode == 0, second.stderr
        texts = {user: [item["memory"] for item in route.memories.values() if item["user_id"] == user] for user in ("coding-agent::proj", "obsidian::my-vault")}
        assert len(texts["coding-agent::proj"]) == 1 and "Second version of the readme." in texts["coding-agent::proj"][0]
        assert len(texts["obsidian::my-vault"]) == 1 and "A different note." in texts["obsidian::my-vault"][0]
    assert all(body["infer"] is False for body in (request["body"] for request in stub.requests if request["method"] == "POST"))


def test_cli_without_a_url_exits_2_with_a_sink_error(tmp_path):
    repo, vault = build_fixture(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    result = run_script(SCRIPT, scenario_args(repo, vault, tmp_path / "state.json"), {"MEMORY_SINK": "mem0"}, home)
    assert result.returncode == 2
    assert "sink error: mem0 sink needs an API URL: set MEMORY_API_URL or pass --url" in result.stderr


def test_cli_with_a_userinfo_url_exits_2_without_printing_the_password(tmp_path):
    repo, vault = build_fixture(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    result = run_script(SCRIPT, scenario_args(repo, vault, tmp_path / "state.json"), {"MEMORY_SINK": "mem0", "MEMORY_API_URL": "http://u:hunter2@127.0.0.1:1"}, home)
    assert result.returncode == 2
    assert "must not contain credentials" in result.stderr and "hunter2" not in result.stdout + result.stderr
