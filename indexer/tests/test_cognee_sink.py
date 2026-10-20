"""Cognee sink: the shared contract, exact request shapes, auth, flush, paging and the indexer CLI."""

import json
import re
import socket
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import sinks
import sinks.cognee as cognee_sink
from cognee_stub import cognee_route
from hindsight_stub import build_fixture, mutate_fixture, run_script, scenario_args
from sink_contract import AWKWARD_BANK, run_sink_contract
from stub_server import closed_port_url, serving

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "hindsight-project-index"
BANK = "contract::bank"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("COGNEE_API_KEY", raising=False)
    monkeypatch.delenv("MEMORY_API_URL", raising=False)


def make(url):
    return sinks.get_sink("cognee", url=url)


FOOTER = re.compile(r"\n\n<!-- personal-memory:doc:[0-9a-f]{16} -->\n$")


def plain(document):
    """A stored document's text without the per-document footer the sink appends."""
    return FOOTER.sub("", document["content"])


def shape(requests):
    return [(r["method"], r["path"].split("?")[0]) for r in requests]


def generic(requests):
    """Replace dataset and data UUIDs so request sequences compare equal."""
    return [(method, re.sub(UUID, "<id>", path)) for method, path in shape(requests)]


# Registry and construction

def test_cognee_is_registered_by_module_name():
    assert "cognee" in sinks.registered_sinks()
    built = make("http://x:1/")
    assert isinstance(built, cognee_sink.CogneeSink)
    assert built.url == "http://x:1"


def test_sink_conformance_and_async_capability():
    built = make("http://x:1")
    assert isinstance(built, sinks.Sink)
    assert built.capabilities.async_ingest is True
    assert callable(built.flush)


def test_url_falls_back_to_memory_api_url(monkeypatch):
    monkeypatch.setenv("MEMORY_API_URL", "http://env-host:9/")
    assert sinks.get_sink("cognee").url == "http://env-host:9"
    assert sinks.get_sink("cognee", url="http://arg:1").url == "http://arg:1"


def test_missing_url_is_a_clear_error():
    with pytest.raises(sinks.SinkError, match="MEMORY_API_URL"):
        sinks.get_sink("cognee")


def test_non_http_url_is_rejected():
    with pytest.raises(sinks.SinkError, match="http"):
        sinks.get_sink("cognee", url="file:///etc/passwd")


# Dataset naming

def test_dataset_name_examples():
    assert re.fullmatch(r"coding_agent_proj_[0-9a-f]{8}", cognee_sink.dataset_name("coding-agent::proj"))
    awkward = cognee_sink.dataset_name(AWKWARD_BANK)
    assert re.fullmatch(r"coding_agent_proj_with_space_and_slash_[0-9a-f]{8}", awkward)
    assert cognee_sink.dataset_name(AWKWARD_BANK) == awkward


def test_dataset_name_empty_slug_long_bank_and_character_set():
    assert re.fullmatch(r"bank_[0-9a-f]{8}", cognee_sink.dataset_name("::--"))
    long_name = cognee_sink.dataset_name("A" * 100)
    assert re.fullmatch(r"a{40}_[0-9a-f]{8}", long_name)
    for bank in ("Ünïcode/bank", "a b", "x" * 200, "::"):
        assert re.fullmatch(r"[a-z0-9_]+_[0-9a-f]{8}", cognee_sink.dataset_name(bank))


def test_banks_that_slug_identically_get_different_datasets():
    first, second = "coding-agent::proj", "coding_agent/proj"
    assert cognee_sink.dataset_name(first) != cognee_sink.dataset_name(second)
    assert cognee_sink.dataset_name(first).rsplit("_", 1)[0] == cognee_sink.dataset_name(second).rsplit("_", 1)[0]
    with serving(cognee_route()) as stub:
        sink = make(stub.url)
        sink.retain(first, "d", "one")
        sink.retain(second, "d", "two")
        state = stub.route.state
        assert [plain(d) for d in state.documents(cognee_sink.dataset_name(first))] == ["one"]
        assert [plain(d) for d in state.documents(cognee_sink.dataset_name(second))] == ["two"]


# Contract

def test_cognee_sink_contract():
    run_sink_contract(make, lambda: serving(cognee_route()))


def contract_steps():
    result = run_sink_contract(make, lambda: serving(cognee_route()))
    return {name: generic(requests) for name, requests in result.steps.items()}


def test_contract_request_sequences():
    steps = contract_steps()
    assert steps["health"] == [("GET", "/health")]
    assert steps["prepare"] == [("POST", "/api/v1/datasets")]
    assert steps["prepare_again"] == []
    list_data = ("GET", "/api/v1/datasets/<id>/data")
    assert steps["retain_minimal"] == [list_data, ("POST", "/api/v1/add")]
    assert steps["retain_full"] == [list_data, ("POST", "/api/v1/add")]
    assert steps["retain_upsert"] == [list_data, ("DELETE", "/api/v1/datasets/<id>/data/<id>"), ("POST", "/api/v1/add")]
    assert steps["retain_awkward_bank"] == [("POST", "/api/v1/datasets"), list_data, ("POST", "/api/v1/add")]
    assert steps["delete"] == [list_data, ("DELETE", "/api/v1/datasets/<id>/data/<id>")]
    assert steps["delete_missing"] == [list_data]
    assert not any(method == "DELETE" for method, _ in steps["delete_missing"])


def test_upsert_leaves_exactly_one_live_document():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "doc-1", "first")
        sink.retain(BANK, "doc-1", "second")
        sink.retain(BANK, "doc-2", "other")
        docs = route.state.documents(cognee_sink.dataset_name(BANK))
        assert sorted(plain(d) for d in docs) == ["other", "second"]
        assert [d["externalMetadata"]["doc_id"] for d in docs if plain(d) == "second"] == ["doc-1"]


def test_upsert_with_identical_content_does_not_conflict_or_duplicate():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        for _ in range(3):
            sink.retain(BANK, "doc-1", "same")
        assert len(route.state.documents(cognee_sink.dataset_name(BANK))) == 1


def test_delete_without_a_dataset_never_creates_one():
    route = cognee_route()
    with serving(route) as stub:
        make(stub.url).delete("never::seen", "doc")
        assert shape(stub.requests) == [("GET", "/api/v1/datasets")]
        assert route.state.datasets == {}


def test_delete_finds_an_existing_dataset_by_name_with_a_fresh_instance():
    route = cognee_route()
    with serving(route) as stub:
        make(stub.url).retain(BANK, "doc-1", "body")
        stub.clear()
        make(stub.url).delete(BANK, "doc-1")
        assert [m for m, _ in shape(stub.requests)] == ["GET", "GET", "DELETE"]
        assert route.state.documents(cognee_sink.dataset_name(BANK)) == []


def test_delete_swallows_404_on_data_but_raises_on_auth_failures():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "doc-1", "body")
        route.state.fail[("DELETE", "/api/v1/datasets/")] = (404, {"detail": "gone"})
        sink.delete(BANK, "doc-1")
        for status in (401, 403):
            route.state.fail[("DELETE", "/api/v1/datasets/")] = (status, {"detail": "no"})
            with pytest.raises(sinks.SinkError) as caught:
                sink.delete(BANK, "doc-1")
            assert caught.value.status == status


def test_delete_swallows_a_vanished_dataset():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "doc-1", "body")
        route.state.datasets.clear()
        sink.delete(BANK, "doc-1")


def test_retain_recovers_when_the_cached_dataset_vanished():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "doc-1", "body")
        route.state.datasets.clear()
        sink.retain(BANK, "doc-1", "body v2")
        assert [plain(d) for d in route.state.documents(cognee_sink.dataset_name(BANK))] == ["body v2"]


# Wire shape of add

def add_request(stub):
    return next(r for r in stub.requests if r["path"] == "/api/v1/add")


def test_add_multipart_shape_full():
    with serving(cognee_route()) as stub:
        make(stub.url).retain(
            BANK,
            "project-index:v1:abc",
            "body text\nline 2\r\n",
            tags=["alpha,beta", "b"],
            metadata={"path": "docs/x.md", "kind": "doc", "doc_id": "spoof"},
            context="ctx",
            timestamp="2026-01-02T03:04:05Z",
        )
        body = add_request(stub)["body"]
    fields = body["fields"]
    assert fields["datasetName"] == cognee_sink.dataset_name(BANK)
    assert "run_in_background" not in fields and "datasetId" not in fields
    meta = json.loads(fields["external_metadata"])
    assert meta == [
        {
            "path": "docs/x.md",
            "kind": "doc",
            "doc_id": "project-index:v1:abc",
            "bank": BANK,
            "tags": ["alpha,beta", "b"],
            "context": "ctx",
            "timestamp": "2026-01-02T03:04:05Z",
        }
    ]
    assert json.loads(fields["labels"]) == ["alpha_beta"]
    [upload] = body["files"]
    assert upload["name"] == "data"
    assert upload["content"] == cognee_sink.upload_text("project-index:v1:abc", "body text\nline 2\r\n")
    assert upload["content"].startswith("body text\nline 2\r\n\n\n<!-- personal-memory:doc:")
    assert "project-index" not in upload["content"].split("<!--")[1]
    assert re.fullmatch(r"[0-9a-f]{16}-[0-9a-f]{8}\.md", upload["filename"])
    assert "project" not in upload["filename"] and "/" not in upload["filename"]


def test_add_multipart_shape_minimal():
    with serving(cognee_route()) as stub:
        make(stub.url).retain(BANK, "d1", "x")
        fields = add_request(stub)["body"]["fields"]
    assert json.loads(fields["external_metadata"]) == [{"doc_id": "d1", "bank": BANK}]
    assert "labels" not in fields


def test_upload_name_is_unique_per_version_and_stable_per_content():
    first = cognee_sink.upload_name("d", "one")
    assert first == cognee_sink.upload_name("d", "one")
    assert first != cognee_sink.upload_name("d", "two")
    assert first.split("-")[0] != cognee_sink.upload_name("e", "one").split("-")[0]


def test_content_that_looks_like_multipart_markup_survives():
    nasty = "--boundary\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\nyes\r\n--\r\n\u00e9\u4e2d"
    route = cognee_route()
    with serving(route) as stub:
        make(stub.url).retain(BANK, "d", nasty)
        assert [plain(d) for d in route.state.documents(cognee_sink.dataset_name(BANK))] == [nasty]


def test_listing_tolerates_snake_case_and_missing_metadata():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.prepare(BANK)
        dataset = route.state.by_name(cognee_sink.dataset_name(BANK))
        for data_id, meta_key, meta in (("a", "external_metadata", {"doc_id": "d"}), ("b", "externalMetadata", None), ("c", "other", None)):
            dataset["data"][data_id] = {"id": data_id, "name": data_id, meta_key: meta, "content": "", "label": None}
        # The stub serves stored keys as is, so snake_case stays snake_case and None stays None.
        assert sink._matching(dataset["id"], "d") == ["a"]
        sink.delete(BANK, "d")
        assert sorted(dataset["data"]) == ["b", "c"]


def test_listing_pages_past_1000_items():
    route = cognee_route()
    name = cognee_sink.dataset_name(BANK)
    route.state.seed(name, 2500)
    with serving(route) as stub:
        sink = make(stub.url)
        sink.delete(BANK, "seed-2499")
        listings = [r["path"] for r in stub.requests if r["method"] == "GET" and "/data?" in r["path"]]
        assert [p.split("?")[1] for p in listings] == ["limit=1000&offset=0", "limit=1000&offset=1000", "limit=1000&offset=2000"]
        assert len(route.state.documents(name)) == 2499
        stub.clear()
        sink.retain(BANK, "seed-0", "replaced")
        assert len(route.state.documents(name)) == 2499
        assert [plain(d) for d in route.state.documents(name) if d["externalMetadata"]["doc_id"] == "seed-0"] == ["replaced"]
        assert sum(1 for r in stub.requests if r["method"] == "DELETE") == 1


def test_listing_exactly_one_full_page_asks_for_the_next():
    route = cognee_route()
    name = cognee_sink.dataset_name(BANK)
    route.state.seed(name, 1000)
    with serving(route) as stub:
        make(stub.url).delete(BANK, "nope")
        listings = [r["path"].split("?")[1] for r in stub.requests if "/data?" in r["path"]]
        assert listings == ["limit=1000&offset=0", "limit=1000&offset=1000"]


# Errors, health and auth

def test_conflict_on_add_surfaces_as_sink_error_with_status():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        route.state.fail[("POST", "/api/v1/add")] = (409, {"detail": "file exists with different content"})
        with pytest.raises(sinks.SinkError) as caught:
            sink.retain(BANK, "d", "x")
        assert caught.value.status == 409
        assert isinstance(caught.value, cognee_sink.HttpError)
        assert "409" in str(caught.value)
        assert len([r for r in stub.requests if r["path"] == "/api/v1/add"]) == 1


def test_stub_refuses_same_name_with_different_content_like_cognee():
    # Why the sink uploads one file name per version: the server (and the stub) answer 409 otherwise.
    with serving(cognee_route()) as stub:
        sink = make(stub.url)
        name = cognee_sink.dataset_name(BANK)
        for content, expected in (("one", None), ("one", None), ("two", 409)):
            body, content_type = cognee_sink_multipart(name, "same.md", content)
            if expected is None:
                sink._request("POST", "/api/v1/add", raw=body, content_type=content_type)
            else:
                with pytest.raises(cognee_sink.HttpError) as caught:
                    sink._request("POST", "/api/v1/add", raw=body, content_type=content_type)
                assert caught.value.status == expected


def cognee_sink_multipart(dataset, filename, content):
    return cognee_sink.multipart({"datasetName": dataset}, filename, content.encode())


def test_http_error_body_is_truncated():
    route = cognee_route()
    with serving(route) as stub:
        route.state.fail[("POST", "/api/v1/datasets")] = (500, {"detail": "x" * 1000})
        with pytest.raises(cognee_sink.HttpError) as caught:
            make(stub.url).prepare(BANK)
        assert caught.value.status == 500
        assert len(str(caught.value)) < 450


def test_health_false_on_server_error_and_when_down():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        assert sink.health() is True
        route.state.fail[("GET", "/health")] = (500, {"detail": "down"})
        assert sink.health() is False
    assert make(closed_port_url()).health() is False


def test_unreachable_server_raises_oserror_or_sink_error():
    sink = make(closed_port_url())
    with pytest.raises((sinks.SinkError, OSError)):
        sink.prepare(BANK)


def test_no_api_key_header_unless_configured():
    with serving(cognee_route()) as stub:
        sink = make(stub.url)
        sink.health()
        sink.retain(BANK, "d", "x")
        sink.flush()
        assert stub.headers and all("x-api-key" not in headers for headers in stub.headers)


def test_api_key_is_sent_on_every_request(monkeypatch):
    monkeypatch.setenv("COGNEE_API_KEY", "sekrit-key-123")
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.health()
        sink.prepare(BANK)
        sink.retain(BANK, "d", "x")
        sink.retain(BANK, "d", "y")
        sink.delete(BANK, "d")
        sink.flush()
        assert len(stub.headers) == len(stub.requests) > 6
        assert all(headers.get("x-api-key") == "sekrit-key-123" for headers in stub.headers)
        assert not any("sekrit" in request["path"] for request in stub.requests)


def test_api_key_never_appears_in_repr_or_error_messages(monkeypatch):
    monkeypatch.setenv("COGNEE_API_KEY", "sekrit-key-123")
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        assert "sekrit" not in repr(sink)
        # A server that echoes the credential back must not leak it through the error text.
        route.state.fail[("POST", "/api/v1/add")] = (401, {"detail": "bad key sekrit-key-123"})
        with pytest.raises(cognee_sink.HttpError) as caught:
            sink.retain(BANK, "d", "x")
        assert caught.value.status == 401
        assert "sekrit" not in str(caught.value) and "sekrit" not in repr(caught.value)
        assert "***" in str(caught.value)
        del route.state.fail[("POST", "/api/v1/add")]
        route.state.fail[("GET", "/api/v1/datasets")] = (500, {"detail": "boom"})
        with pytest.raises(cognee_sink.HttpError) as caught:
            sink.delete("other::bank", "d")
        assert "sekrit" not in str(caught.value)
    with pytest.raises(OSError) as dead:
        make(closed_port_url()).prepare(BANK)
    assert "sekrit" not in str(dead.value)


# Redirects and malformed replies

@contextmanager
def raw_http(handler):
    """A loopback HTTP server whose reply is `handler(method, path, headers) -> (status, headers, body_bytes)`."""
    seen: list[tuple[str, str, dict]] = []

    class Handler(BaseHTTPRequestHandler):
        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            headers = {key.lower(): value for key, value in self.headers.items()}
            seen.append((self.command, self.path, headers))
            status, reply_headers, payload = handler(self.command, self.path, headers)
            self.send_response(status)
            for key, value in reply_headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
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
        listener.close()
        thread.join(timeout=5)


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_a_redirect_is_an_http_error_and_the_key_never_reaches_the_second_host(monkeypatch, method):
    monkeypatch.setenv("COGNEE_API_KEY", "sekrit-key-123")
    with raw_http(lambda *_: (200, {"Content-Type": "application/json"}, b"{}")) as (second_url, second_seen):
        with raw_http(lambda *_: (302, {"Location": second_url + "/elsewhere"}, b"")) as (url, first_seen):
            sink = make(url)
            call = (lambda: sink.prepare(BANK)) if method == "POST" else (lambda: sink.delete("other::bank", "d"))
            with pytest.raises(cognee_sink.HttpError) as caught:
                call()
            assert caught.value.status == 302 and "HTTP 302" in str(caught.value)
            assert "sekrit" not in str(caught.value)
            assert [m for m, _p, _h in first_seen] == [method]
            assert first_seen[0][2].get("x-api-key") == "sekrit-key-123"
    assert second_seen == []


def test_health_is_false_on_a_redirect_and_never_follows_it(monkeypatch):
    monkeypatch.setenv("COGNEE_API_KEY", "sekrit-key-123")
    with raw_http(lambda *_: (200, {}, b"{}")) as (second_url, second_seen):
        with raw_http(lambda *_: (301, {"Location": second_url + "/health"}, b"")) as (url, _seen):
            assert make(url).health() is False
    assert second_seen == []


def test_non_http_reply_is_unreachable_and_never_leaks_an_exception():
    with garbage_listener() as url:
        sink = make(url)
        assert sink.health() is False
        for call in (lambda: sink.prepare(BANK), lambda: sink.retain(BANK, "d", "x"), lambda: sink.delete(BANK, "d"), lambda: sink.flush(BANK)):
            with pytest.raises((sinks.SinkError, OSError)):
                call()


def test_truncated_reply_body_is_an_os_error():
    def handler(method, path, headers):
        return 200, {"Content-Type": "application/json", "Content-Length": "500"}, b'[{"id": '

    with raw_http(handler) as (url, _seen):
        with pytest.raises(OSError, match="IncompleteRead"):
            make(url).delete(BANK, "d")


# flush

def cognified_datasets(route):
    return [c["datasets"] for c in route.state.cognified]


def test_flush_with_an_explicit_bank_always_requests_cognify_even_from_a_fresh_instance():
    route = cognee_route()
    with serving(route) as stub:
        make(stub.url).retain(BANK, "d", "x")
        fresh = make(stub.url)  # a new process: no in-memory dirty set, no cached dataset id
        stub.clear()
        fresh.flush(BANK)
        assert generic(stub.requests) == [("GET", "/api/v1/datasets"), ("GET", "/api/v1/datasets/<id>/data"), ("POST", "/api/v1/cognify")]
        assert cognified_datasets(route) == [[cognee_sink.dataset_name(BANK)]]
        assert route.state.cognified[0] == {"datasets": [cognee_sink.dataset_name(BANK)], "runInBackground": True}
        # Explicit flush is not skipped on a second call either: the caller (the indexer) decides.
        fresh.flush(BANK)
        assert len(route.state.cognified) == 2


def test_flush_uses_the_cached_dataset_id_without_listing_datasets():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        stub.clear()
        sink.flush(BANK)
        assert generic(stub.requests) == [("GET", "/api/v1/datasets/<id>/data"), ("POST", "/api/v1/cognify")]
        assert next(r for r in stub.requests if "/data?" in r["path"])["path"].endswith("?limit=1&offset=0")


def test_flush_on_an_unknown_dataset_sends_no_cognify_and_creates_nothing():
    route = cognee_route()
    with serving(route) as stub:
        make(stub.url).flush("never::touched")
        assert shape(stub.requests) == [("GET", "/api/v1/datasets")]
        assert route.state.datasets == {} and route.state.cognified == []


def test_flush_on_an_empty_dataset_sends_no_cognify():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        sink.delete(BANK, "d")  # delete-only batch that emptied the bank
        stub.clear()
        sink.flush(BANK)
        assert route.state.cognified == []
        assert not any(r["path"] == "/api/v1/cognify" for r in stub.requests)
        sink.flush()  # nothing left dirty either
        assert route.state.cognified == []


def test_flush_recovers_from_a_stale_cached_dataset_id():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        route.state.datasets.clear()
        sink.flush(BANK)  # dataset gone: nothing to process, no error
        assert route.state.cognified == []
        sink.retain(BANK, "d", "y")
        route.state.datasets.clear()
        route.state.seed(cognee_sink.dataset_name(BANK), 1)  # same name, new id
        sink.flush(BANK)
        assert len(route.state.cognified) == 1


def test_flush_none_flushes_only_dirty_banks():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain("bank::one", "d1", "x")
        sink.retain("bank::one", "d2", "y")
        sink.retain("bank::two", "d1", "z")
        assert route.state.cognified == []
        sink.flush()
        assert sorted(sum(cognified_datasets(route), [])) == sorted(cognee_sink.dataset_name(b) for b in ("bank::one", "bank::two"))
        count = len(route.state.cognified)
        stub.clear()
        sink.flush()
        assert stub.requests == [] and len(route.state.cognified) == count
        make(stub.url).flush()  # a fresh instance has nothing dirty
        assert len(route.state.cognified) == count


def test_flush_none_leaves_other_banks_dirty_after_a_single_bank_flush():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain("bank::one", "d1", "x")
        sink.retain("bank::two", "d1", "z")
        sink.flush("bank::one")
        assert cognified_datasets(route) == [[cognee_sink.dataset_name("bank::one")]]
        sink.flush()
        assert cognified_datasets(route)[1:] == [[cognee_sink.dataset_name("bank::two")]]


def test_flush_clears_the_dirty_flag_only_on_success():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        route.state.fail[("POST", "/api/v1/cognify")] = (500, {"detail": "llm key missing"})
        with pytest.raises(sinks.SinkError) as caught:
            sink.flush()
        assert caught.value.status == 500
        assert route.state.cognified == []
        del route.state.fail[("POST", "/api/v1/cognify")]
        sink.flush()  # still dirty after the failure, so the retry goes out
        assert len(route.state.cognified) == 1
        stub.clear()
        sink.flush()
        assert stub.requests == []


def test_delete_marks_the_bank_dirty_only_when_something_was_removed():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        sink.retain(BANK, "e", "y")
        sink.flush()
        assert len(route.state.cognified) == 1
        sink.delete(BANK, "absent")
        sink.flush()
        assert len(route.state.cognified) == 1
        sink.delete(BANK, "d")
        sink.flush()
        assert len(route.state.cognified) == 2


def test_flush_sink_helper_calls_the_cognee_flush():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        sinks.flush_sink(sink, BANK)
        assert len(route.state.cognified) == 1


# Identical content in two documents

def test_identical_content_in_two_documents_uploads_distinct_bytes_and_keeps_both():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "doc-a", "same words")
        sink.retain(BANK, "doc-b", "same words")
        uploads = [r["body"]["files"][0]["content"] for r in stub.requests if r["path"] == "/api/v1/add"]
        assert len(set(uploads)) == 2
        assert all(u.startswith("same words\n\n<!-- personal-memory:doc:") for u in uploads)
        assert not any("doc-a" in u or "doc-b" in u for u in uploads)
        docs = route.state.documents(cognee_sink.dataset_name(BANK))
        assert sorted(d["externalMetadata"]["doc_id"] for d in docs) == ["doc-a", "doc-b"]
        sink.delete(BANK, "doc-a")
        assert [d["externalMetadata"]["doc_id"] for d in route.state.documents(cognee_sink.dataset_name(BANK))] == ["doc-b"]


def test_stub_deduplicates_identical_bytes_like_cognee():
    # Without the footer the second document would be swallowed by the first row, metadata and all.
    with serving(cognee_route()) as stub:
        sink = make(stub.url)
        name = cognee_sink.dataset_name(BANK)
        for filename, doc_id in (("a.md", "doc-a"), ("b.md", "doc-b")):
            fields = {"datasetName": name, "external_metadata": json.dumps([{"doc_id": doc_id}])}
            body, content_type = cognee_sink.multipart(fields, filename, b"same bytes")
            sink._request("POST", "/api/v1/add", raw=body, content_type=content_type)
        docs = stub.route.state.documents(name)
        assert [d["externalMetadata"]["doc_id"] for d in docs] == ["doc-a"]


# Indexer CLI

BANKS = ("coding-agent::proj", "obsidian::my-vault")


def cli_run(tmp_path, stub_url, repo, vault):
    env = {"MEMORY_SINK": "cognee", "MEMORY_API_URL": stub_url}
    result = run_script(SCRIPT, scenario_args(repo, vault, tmp_path / "state" / "state.json"), env, tmp_path / "home")
    assert result.returncode == 0, result.stderr
    return result


def test_cli_writes_documents_and_flushes_once_per_bank_per_change(tmp_path):
    (tmp_path / "home").mkdir()
    repo, vault = build_fixture(tmp_path)
    route = cognee_route()
    expected = sorted(cognee_sink.dataset_name(bank) for bank in BANKS)
    with serving(route) as stub:
        cli_run(tmp_path, stub.url, repo, vault)
        names = {d["name"] for d in route.state.datasets.values()}
        for bank in BANKS:
            assert cognee_sink.dataset_name(bank) in names, (bank, names)
            documents = route.state.documents(cognee_sink.dataset_name(bank))
            assert documents, bank
            for document in documents:
                assert document["externalMetadata"]["bank"] == bank
                assert document["externalMetadata"]["doc_id"]
                assert re.fullmatch(r"[0-9a-f]{16}-[0-9a-f]{8}\.md", document["name"])
        # First apply run: exactly one cognify per bank, addressed by dataset name.
        assert sorted(sum(cognified_datasets(route), [])) == expected
        assert all(len(datasets) == 1 for datasets in cognified_datasets(route))

        # A second run with nothing changed sends no cognify.
        route.state.cognified.clear()
        cli_run(tmp_path, stub.url, repo, vault)
        assert route.state.cognified == []

        # After a change, one cognify per bank again.
        mutate_fixture(repo, vault)
        cli_run(tmp_path, stub.url, repo, vault)
        assert sorted(sum(cognified_datasets(route), [])) == expected
        assert all(len(datasets) == 1 for datasets in cognified_datasets(route))


def test_cli_delete_only_batch_that_empties_a_bank_sends_no_failing_cognify(tmp_path):
    (tmp_path / "home").mkdir()
    repo, vault = build_fixture(tmp_path)
    route = cognee_route()
    with serving(route) as stub:
        cli_run(tmp_path, stub.url, repo, vault)
        route.state.cognified.clear()
        (vault / "plan.md").unlink()  # the vault bank's only document goes away
        cli_run(tmp_path, stub.url, repo, vault)  # exit 0 even though cognify would 400 on an empty dataset
        assert route.state.documents(cognee_sink.dataset_name(BANKS[1])) == []
        assert route.state.cognified == []
        # The marker was cleared, so another run stays quiet.
        cli_run(tmp_path, stub.url, repo, vault)
        assert route.state.cognified == []
