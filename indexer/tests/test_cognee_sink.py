"""Cognee sink: the shared contract, exact request shapes, auth, flush, paging and the indexer CLI."""

import json
import re
from pathlib import Path

import pytest
import sinks
import sinks.cognee as cognee_sink
from cognee_stub import cognee_route
from hindsight_stub import build_fixture, run_script, scenario_args
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
        assert [d["content"] for d in state.documents(cognee_sink.dataset_name(first))] == ["one"]
        assert [d["content"] for d in state.documents(cognee_sink.dataset_name(second))] == ["two"]


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
        assert sorted(d["content"] for d in docs) == ["other", "second"]
        assert [d["externalMetadata"]["doc_id"] for d in docs if d["content"] == "second"] == ["doc-1"]


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
        assert [d["content"] for d in route.state.documents(cognee_sink.dataset_name(BANK))] == ["body v2"]


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
    assert upload["content"] == "body text\nline 2\r\n"
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
        assert [d["content"] for d in route.state.documents(cognee_sink.dataset_name(BANK))] == [nasty]


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
        assert [d["content"] for d in route.state.documents(name) if d["externalMetadata"]["doc_id"] == "seed-0"] == ["replaced"]
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


def test_api_key_never_appears_in_error_strings(monkeypatch):
    monkeypatch.setenv("COGNEE_API_KEY", "sekrit-key-123")
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        # A server that echoes the credential back must not leak it through the error text.
        route.state.fail[("POST", "/api/v1/add")] = (401, {"detail": "bad key sekrit-key-123"})
        with pytest.raises(sinks.SinkError) as caught:
            sink.retain(BANK, "d", "x")
        assert "sekrit" not in str(caught.value)
        assert "sekrit" not in repr(caught.value)
        assert caught.value.status == 401
    with pytest.raises(OSError) as dead:
        make(closed_port_url()).prepare(BANK)
    assert "sekrit" not in str(dead.value)
    assert "sekrit" not in repr(make(stub.url).__dict__.get("url"))


# flush

def test_flush_sends_one_cognify_per_dirty_bank_with_dataset_names():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain("bank::one", "d1", "x")
        sink.retain("bank::one", "d2", "y")
        sink.retain("bank::two", "d1", "z")
        assert route.state.cognified == []
        sink.flush()
        assert sorted(c["datasets"][0] for c in route.state.cognified) == sorted(cognee_sink.dataset_name(b) for b in ("bank::one", "bank::two"))
        assert all(len(c["datasets"]) == 1 and c["runInBackground"] is True and set(c) == {"datasets", "runInBackground"} for c in route.state.cognified)


def test_flush_a_single_bank_leaves_the_other_dirty():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain("bank::one", "d1", "x")
        sink.retain("bank::two", "d1", "z")
        sink.flush("bank::one")
        assert [c["datasets"] for c in route.state.cognified] == [[cognee_sink.dataset_name("bank::one")]]
        sink.flush()
        assert [c["datasets"] for c in route.state.cognified][1:] == [[cognee_sink.dataset_name("bank::two")]]


def test_flush_on_a_clean_bank_issues_no_request():
    with serving(cognee_route()) as stub:
        sink = make(stub.url)
        sink.flush("never::touched")
        sink.flush()
        assert stub.requests == []
        sink.retain(BANK, "d", "x")
        sink.flush(BANK)
        stub.clear()
        sink.flush(BANK)
        sink.flush()
        assert stub.requests == []


def test_flush_clears_the_dirty_flag_only_on_success():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
        route.state.fail[("POST", "/api/v1/cognify")] = (500, {"detail": "llm key missing"})
        with pytest.raises(sinks.SinkError) as caught:
            sink.flush(BANK)
        assert caught.value.status == 500
        assert route.state.cognified == []
        del route.state.fail[("POST", "/api/v1/cognify")]
        sink.flush(BANK)
        assert len(route.state.cognified) == 1
        sink.flush(BANK)
        assert len(route.state.cognified) == 1


def test_delete_marks_the_bank_dirty_only_when_something_was_removed():
    route = cognee_route()
    with serving(route) as stub:
        sink = make(stub.url)
        sink.retain(BANK, "d", "x")
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


# Indexer CLI

def test_cli_writes_documents_into_datasets_for_both_banks(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    repo, vault = build_fixture(tmp_path)
    state = tmp_path / "state" / "state.json"
    route = cognee_route()
    with serving(route) as stub:
        env = {"MEMORY_SINK": "cognee", "MEMORY_API_URL": stub.url}
        result = run_script(SCRIPT, scenario_args(repo, vault, state), env, home)
        assert result.returncode == 0, result.stderr
        names = {d["name"] for d in route.state.datasets.values()}
        for bank in ("coding-agent::proj", "obsidian::my-vault"):
            assert cognee_sink.dataset_name(bank) in names, (bank, names)
            documents = route.state.documents(cognee_sink.dataset_name(bank))
            assert documents, bank
            for document in documents:
                assert document["externalMetadata"]["bank"] == bank
                assert document["externalMetadata"]["doc_id"]
                assert re.fullmatch(r"[0-9a-f]{16}-[0-9a-f]{8}\.md", document["name"])
        # Whether the CLI also issues cognify after each bank's batch is covered by test_flush.py; this test
        # only asserts the stored documents.
        assert not any(r["path"] == "/api/v1/datasets/status" for r in stub.requests)
