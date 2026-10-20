"""mem0 sink: contract, wire format, auth, chunking, upsert and the indexer CLI against a stateful mem0 stub."""

import urllib.request
from pathlib import Path

import pytest
import sinks
import sinks.mem0 as mem0_sink
from hindsight_stub import build_fixture, mutate_fixture, run_script, scenario_args
from mem0_stub import mem0_route, mem0_serving
from sink_contract import AWKWARD_BANK, run_sink_contract
from stub_server import closed_port_url, serving

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "hindsight-project-index"
BANK = "contract::bank"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("MEMORY_API_URL", raising=False)
    monkeypatch.delenv("MEM0_API_KEY", raising=False)


def mem0(url: str) -> sinks.Sink:
    return sinks.get_sink("mem0", url=url)


def shape(requests: list[dict]) -> list[tuple[str, str]]:
    return [(request["method"], request["path"]) for request in requests]


def list_path(bank: str, doc_id: str) -> str:
    return f"/memories?user_id={bank}&run_id={doc_id}&top_k=1000"


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

    # upsert: lookup, delete the old memory by id, then write the new text.
    upsert = steps["retain_upsert"]
    assert [request["method"] for request in upsert] == ["GET", "DELETE", "POST"]
    assert upsert[0]["path"] == list_path("contract%3A%3Abank", "doc-1")
    assert upsert[1]["path"].startswith("/memories/") and upsert[1]["body"] is None
    assert upsert[2]["body"]["messages"] == [{"role": "user", "content": "first body, edited"}]
    assert upsert[2]["body"]["infer"] is False

    # awkward bank: percent-encoded in the lookup, verbatim in the JSON body.
    get, post = steps["retain_awkward_bank"]
    assert get["path"] == list_path("coding-agent%3A%3Aproj%20with%20space%2Fand%20slash", "doc-3")
    assert " " not in get["path"] and " " not in post["path"]
    assert post["body"]["user_id"] == AWKWARD_BANK

    # delete: lookup then one DELETE; delete of a document mem0 does not know is only the lookup.
    assert [request["method"] for request in steps["delete"]] == ["GET", "DELETE"]
    assert shape(steps["delete_missing"]) == [("GET", list_path("contract%3A%3Abank", "never-retained"))]

    # The whole run left exactly one version of each surviving document, all stored verbatim.
    assert route.texts(BANK, "doc-1") == []
    assert route.texts(BANK, "doc-2") == ["second body"]
    assert route.texts(AWKWARD_BANK, "doc-3") == ["body"]
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
    assert not {item["id"] for item in before} & set(route.memories)


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


def test_delete_propagates_non_404_errors():
    def route(method, path, body):
        if method == "GET":
            return 200, {"results": [{"id": "x"}]}
        return 500, {"detail": "boom"}

    with serving(route) as stub, pytest.raises(mem0_sink.HttpError) as caught:
        mem0(stub.url).delete("b", "d")
    assert caught.value.status == 500 and "HTTP 500" in str(caught.value)


def test_missing_results_and_empty_or_non_json_delete_bodies_are_tolerated():
    def route(method, path, body):
        if method == "GET":
            return 200, {}
        return 200, None

    with serving(route) as stub:
        mem0(stub.url).delete("b", "d")
        mem0(stub.url).retain("b", "d", "x")
    assert [request["method"] for request in stub.requests] == ["GET", "GET", "POST"]

    def plain(method, path, body):
        return (200, {"results": [{"id": "x"}]}) if method == "GET" else (200, "deleted")

    with serving(plain) as stub:
        mem0(stub.url).delete("b", "d")
    assert [request["method"] for request in stub.requests] == ["GET", "DELETE"]


def test_unusable_listing_is_an_error_not_an_empty_document():
    with serving(lambda *_: (200, ["not", "an", "object"])) as stub, pytest.raises(
        sinks.SinkError, match="reply is not a JSON object"
    ):
        mem0(stub.url).retain("b", "d", "x")
    assert [request["method"] for request in stub.requests] == ["GET"]


def test_failed_chunk_post_propagates_and_a_retry_converges():
    route = mem0_route()
    fail = {"on_post": 2}
    posts = {"n": 0}

    def flaky(method, path, body):
        if method == "POST":
            posts["n"] += 1
            if posts["n"] == fail["on_post"]:
                return 500, {"detail": "embedder down"}
        return route(method, path, body)

    text = "paragraph\n\n" * 700  # three chunks
    with serving(flaky) as stub:
        sink = mem0(stub.url)
        with pytest.raises(sinks.SinkError) as caught:
            sink.retain("b", "d", text)
        assert caught.value.status == 500
        assert len(route.records("b", "d")) == 1  # partial write
        fail["on_post"] = 0
        sink.retain("b", "d", text)  # what the indexer does on its next run
    assert "".join(route.texts("b", "d")) == text
    assert len(route.records("b", "d")) == 3


# Empty content

@pytest.mark.parametrize("content", ["", "   \n\n\t"])
def test_empty_content_removes_old_memories_and_writes_nothing(content):
    route = mem0_route()
    with mem0_serving(route) as stub:
        sink = mem0(stub.url)
        sink.retain("b", "d", "something")
        stub.clear()
        sink.retain("b", "d", content)
    assert [request["method"] for request in stub.requests] == ["GET", "DELETE"]
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
    # Only the lookup precedes the writes.
    assert [request["method"] for request in stub.requests] == ["GET"] + ["POST"] * len(posts)


def test_single_chunk_documents_carry_no_chunk_metadata():
    with serving(mem0_route()) as stub:
        mem0(stub.url).retain("b", "d", "short")
    assert "chunk" not in stub.requests[1]["body"]["metadata"] and "chunks" not in stub.requests[1]["body"]["metadata"]


def test_chunk_cap_rejects_before_any_request():
    with serving(mem0_route()) as stub:
        sink = mem0(stub.url)
        with pytest.raises(sinks.SinkError, match="at most 900 per document"):
            sink.retain("b", "d", "x" * (3000 * 900 + 1))
    assert stub.requests == []


def test_a_document_of_exactly_the_cap_is_accepted():
    route = mem0_route()
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", "x" * (3000 * 900))
    assert len(route.records("b", "d")) == 900


# Metadata

def test_reserved_metadata_keys_are_prefixed_and_sink_keys_win():
    reserved = {"data", "user_id", "agent_id", "run_id", "hash", "created_at", "updated_at", "expiration_date"}
    caller = {key: f"v-{key}" for key in reserved} | {"path": "a.md", "tags": "caller", "context": "caller"}
    route = mem0_route()  # the stub answers 400 for any reserved key, so success proves the renaming
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", "x", tags=["t1", "t2"], metadata=caller, context="real", timestamp="ts")
    (item,) = route.records("b", "d")
    assert item["metadata"] == {**{f"meta_{key}": f"v-{key}" for key in reserved}, "path": "a.md", "tags": ["t1", "t2"], "context": "real", "timestamp": "ts"}


def test_absent_optionals_add_no_metadata_keys():
    route = mem0_route()
    with mem0_serving(route) as stub:
        mem0(stub.url).retain("b", "d", "x", tags=[], metadata=None, context=None, timestamp=None)
        mem0(stub.url).retain("b", "e", "x", context="")
    assert route.records("b", "d")[0]["metadata"] == {}
    assert route.records("b", "e")[0]["metadata"] == {"context": ""}


# Auth

def test_api_key_header_is_sent_on_every_request_only_when_set(monkeypatch):
    route = mem0_route()
    with mem0_serving(route) as stub:
        monkeypatch.setenv("MEM0_API_KEY", "m0sk_secret")
        keyed = mem0(stub.url)
        assert keyed.health() is True
        keyed.retain("b", "d", "x")
        keyed.retain("b", "d", "y")
        keyed.delete("b", "d")
        sent = [headers.get("x-api-key") for headers in stub.headers]
        assert len(sent) == len(stub.requests) == 1 + 2 + 3 + 2 and set(sent) == {"m0sk_secret"}

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
    with serving(lambda *_: (400, {"detail": "bad key m0sk_echoed_secret"})) as stub, pytest.raises(
        sinks.SinkError
    ) as caught:
        mem0(stub.url).retain("b", "d", "x")
    assert "m0sk_echoed_secret" not in str(caught.value) and "***" in str(caught.value)


def test_redirects_leave_the_host_only_when_no_key_could_travel():
    handler = mem0_sink.SameHostRedirect()
    request = urllib.request.Request("http://a.example:8000/", headers={"X-API-Key": "k"})
    assert handler.redirect_request(request, None, 302, "Found", {}, "http://evil.example/x") is None
    assert handler.redirect_request(request, None, 302, "Found", {}, "http://a.example:9000/x") is None
    followed = handler.redirect_request(request, None, 302, "Found", {}, "http://a.example:8000/docs")
    assert followed is not None and followed.full_url == "http://a.example:8000/docs"
    assert followed.get_header("X-api-key") == "k"


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


def test_url_without_a_scheme_is_rejected():
    with pytest.raises(sinks.SinkError, match="http:// or https://"):
        sinks.get_sink("mem0", url="localhost:18888")


# Health and connection failures

def test_health_is_false_on_http_errors_and_never_raises_on_a_closed_port():
    for status in (500, 401, 404, 302):
        with serving(lambda *_args, status=status: (status, {})) as stub:
            assert mem0(stub.url).health() is False
    assert mem0(closed_port_url()).health() is False
    assert mem0("http://127.0.0.1:1").health() is False


def test_http_error_message_has_method_url_status_and_a_bounded_body():
    with serving(lambda *_: (500, {"detail": "e" * 1000})) as stub, pytest.raises(
        mem0_sink.HttpError
    ) as caught:
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
