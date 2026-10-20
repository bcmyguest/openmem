"""Sink registry, Hindsight sink wire behavior and the indexer CLI's sink selection."""

import importlib.machinery
import importlib.util
import json
import sys
from pathlib import Path

import pytest
import sinks
import sinks.hindsight as hindsight_sink
from hindsight_stub import build_fixture, hindsight_route, run_scenario
from sink_contract import run_sink_contract
from stub_server import serving

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "hindsight-project-index"
BASELINE = Path(__file__).resolve().parent / "fixtures" / "hindsight_requests_baseline.json"


@pytest.fixture(scope="module")
def indexer():
    loader = importlib.machinery.SourceFileLoader("hindsight_project_index_sinks", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FakeSink:
    """Test-only sink: stores documents in memory per bank."""

    capabilities = sinks.Capabilities(async_ingest=True)

    def __init__(self, url: str | None = None):
        self.url = url
        self.docs: dict[tuple[str, str], dict] = {}
        self.prepared: list[str] = []

    def health(self) -> bool:
        return True

    def prepare(self, bank):
        self.prepared.append(bank)

    def retain(self, bank, doc_id, content, *, tags=None, metadata=None, context=None, timestamp=None):
        self.docs[(bank, doc_id)] = {"content": content, "tags": tags, "metadata": metadata, "context": context, "timestamp": timestamp}

    def delete(self, bank, doc_id):
        self.docs.pop((bank, doc_id), None)


# Registry

def test_hindsight_is_registered_by_module_name():
    assert "hindsight" in sinks.registered_sinks()
    assert isinstance(sinks.get_sink("hindsight", url="http://x:1"), hindsight_sink.HindsightSink)


def test_unknown_sink_error_lists_registered_sinks():
    with pytest.raises(sinks.UnknownSinkError) as caught:
        sinks.get_sink("nope")
    assert "unknown sink 'nope'" in str(caught.value)
    assert "hindsight" in str(caught.value)


@pytest.mark.parametrize("name", ["../etc", "Hindsight", "a.b", "", "_private", "os"])
def test_unlisted_or_malformed_names_never_import(name):
    with pytest.raises(sinks.UnknownSinkError):
        sinks.get_sink(name)


def test_register_sink_overrides_and_validates_name():
    sinks.register_sink("fakecase", FakeSink)
    try:
        assert "fakecase" in sinks.registered_sinks()
        built = sinks.get_sink("fakecase", url="http://u")
        assert isinstance(built, FakeSink) and built.url == "http://u"
    finally:
        sinks._registry.pop("fakecase")
    with pytest.raises(ValueError):
        sinks.register_sink("Bad-Name", FakeSink)


def test_dropping_a_module_into_the_package_registers_it(tmp_path, monkeypatch):
    (tmp_path / "dropin.py").write_text(
        "import sinks\n"
        "class S:\n    capabilities = sinks.Capabilities()\n"
        "    def __init__(self, url=None): self.url = url\n"
        "def create(url=None, **cfg):\n    return S(url)\n"
    )
    (tmp_path / "nofactory.py").write_text("X = 1\n")
    monkeypatch.setattr(sinks, "__path__", [*sinks.__path__, str(tmp_path)])
    try:
        assert {"dropin", "nofactory"} <= set(sinks.registered_sinks())
        assert sinks.get_sink("dropin", url="http://d").url == "http://d"
        with pytest.raises(sinks.UnknownSinkError, match="no create"):
            sinks.get_sink("nofactory")
    finally:
        sys.modules.pop("sinks.dropin", None)
        sys.modules.pop("sinks.nofactory", None)


def test_protocol_conformance_checks_methods():
    assert isinstance(FakeSink(), sinks.Sink)
    assert isinstance(hindsight_sink.HindsightSink(), sinks.Sink)

    class Incomplete:
        capabilities = sinks.Capabilities()

        def health(self):
            return True

    assert not isinstance(Incomplete(), sinks.Sink)


# Hindsight sink wire format

def hindsight(url: str) -> sinks.Sink:
    return sinks.get_sink("hindsight", url=url)


def test_hindsight_sink_passes_the_generic_contract():
    stateful = hindsight_route()

    def route(method, path, body):
        if method == "DELETE" and path.endswith("/documents/never-retained"):
            return 404, {"detail": "Document not found"}
        return stateful(method, path, body)

    result = run_sink_contract(hindsight, lambda: serving(route))
    assert [(r["method"], r["path"]) for r in result.steps["health"]] == [("GET", "/health")]


def test_hindsight_retain_request_is_exact():
    with serving(hindsight_route()) as stub:
        sink = hindsight(stub.url + "/")  # trailing slash is trimmed
        sink.retain(
            "coding-agent::my proj",
            "project-index:v1:abc",
            "body",
            tags=["t1"],
            metadata={"path": "a.md", "kind": "doc"},
            context="ctx",
        )
        sink.retain("b", "d2", "body2", metadata={}, context="c")
    first, second = stub.requests
    assert first["method"] == "POST"
    assert first["path"] == "/v1/default/banks/coding-agent%3A%3Amy%20proj/memories"
    assert first["body"] == {
        "items": [
            {
                "content": "body",
                "document_id": "project-index:v1:abc",
                "context": "ctx",
                "metadata": {"path": "a.md", "kind": "doc"},
                "timestamp": "unset",
                "strategy": "project-index",
                "tags": ["t1"],
            }
        ],
        "async": False,
    }
    assert "tags" not in second["body"]["items"][0]


def test_hindsight_retain_maps_timestamp_and_none_context():
    with serving(hindsight_route()) as stub:
        hindsight(stub.url).retain("b", "d", "x", timestamp="2026-01-02T03:04:05Z")
    item = stub.requests[0]["body"]["items"][0]
    assert item["timestamp"] == "2026-01-02T03:04:05Z"
    assert "context" not in item and "metadata" not in item


def test_hindsight_prepare_creates_missing_bank_then_pins_strategy_once():
    with serving(hindsight_route()) as stub:
        sink = hindsight(stub.url)
        sink.prepare("b::1")
        sink.prepare("b::1")
    assert [(r["method"], r["path"]) for r in stub.requests] == [
        ("GET", "/v1/default/banks/b%3A%3A1/config"),
        ("PUT", "/v1/default/banks/b%3A%3A1"),
        ("GET", "/v1/default/banks/b%3A%3A1/config"),
        ("PATCH", "/v1/default/banks/b%3A%3A1/config"),
        ("GET", "/v1/default/banks/b%3A%3A1/config"),
    ]
    assert stub.requests[3]["body"] == {
        "updates": {
            "retain_strategies": {"project-index": {"retain_extraction_mode": "chunks", "retain_chunk_size": 3000}},
            "enable_auto_consolidation": False,
        }
    }


def test_hindsight_delete_quotes_id_and_swallows_404_only():
    def route(method, path, body):
        return (404, {"detail": "x"}) if path.endswith("gone") else (500, {"detail": "boom"}) if path.endswith("bad") else (200, {})

    with serving(route) as stub:
        sink = hindsight(stub.url)
        sink.delete("coding-agent::p", "project-index:v1:gone")
        with pytest.raises(sinks.SinkError) as caught:
            sink.delete("coding-agent::p", "project-index:v1:bad")
    assert stub.requests[0] == {"method": "DELETE", "path": "/v1/default/banks/coding-agent%3A%3Ap/documents/project-index%3Av1%3Agone", "body": None}
    assert caught.value.status == 500
    assert isinstance(caught.value, hindsight_sink.HttpError)
    assert "HTTP 500" in str(caught.value)


def test_hindsight_retain_http_error_carries_status():
    with serving(lambda *_: (400, {"detail": "bad"})) as stub:
        with pytest.raises(hindsight_sink.HttpError) as caught:
            hindsight(stub.url).retain("b", "d", "x")
    assert caught.value.status == 400


def test_hindsight_capabilities_are_synchronous():
    assert hindsight_sink.HindsightSink().capabilities.async_ingest is False


# Regression: the CLI's requests equal the pre-refactor script's

def test_cli_requests_match_pre_refactor_baseline(tmp_path):
    requests, results = run_scenario(SCRIPT, tmp_path)
    assert [r.returncode for r in results] == [0, 0], [r.stderr for r in results]
    assert requests == json.loads(BASELINE.read_text())


# CLI sink selection

def run_main(indexer, monkeypatch, tmp_path, argv, env):
    for key in ("HINDSIGHT_URL", "MEMORY_API_URL", "MEMORY_SINK"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(indexer, "AGENT_CONFIG", tmp_path / "absent-coding-agent.json")
    monkeypatch.setattr(sys, "argv", ["hindsight-project-index", *argv])
    return indexer.main()


def make_source(tmp_path):
    return build_fixture(tmp_path)


def test_unknown_sink_flag_exits_2_listing_sinks(indexer, monkeypatch, tmp_path, capsys):
    code = run_main(indexer, monkeypatch, tmp_path, ["--sink", "bogus", "--list"], {})
    assert code == 2
    err = capsys.readouterr().err
    assert "unknown sink 'bogus'" in err and "hindsight" in err


def test_unknown_sink_env_exits_2(indexer, monkeypatch, tmp_path, capsys):
    assert run_main(indexer, monkeypatch, tmp_path, ["--list"], {"MEMORY_SINK": "bogus"}) == 2
    assert "registered sinks" in capsys.readouterr().err


def test_env_selects_fake_sink_with_memory_api_url_and_writes_through_it(indexer, monkeypatch, tmp_path):
    built = []

    def factory(**cfg):
        sink = FakeSink(cfg.get("url"))
        built.append(sink)
        return sink

    sinks.register_sink("fakecli", factory)
    try:
        repo, vault = make_source(tmp_path)
        argv = ["--apply", "--state", str(tmp_path / "state.json"), "--repo", str(repo), "--vault", str(vault)]
        env = {"MEMORY_SINK": "fakecli", "MEMORY_API_URL": "http://mem.example:9", "HINDSIGHT_URL": "http://ignored:8888"}
        assert run_main(indexer, monkeypatch, tmp_path, argv, env) == 0
    finally:
        sinks._registry.pop("fakecli")
    (sink,) = built
    assert sink.url == "http://mem.example:9"
    assert sorted(sink.prepared) == ["coding-agent::proj", "obsidian::my-vault"]
    assert {bank for bank, _ in sink.docs} == {"coding-agent::proj", "obsidian::my-vault"}
    assert len(sink.docs) == 3
    assert any(doc["tags"] == ["work", "infra", "ops"] for doc in sink.docs.values())


def test_dry_run_never_builds_the_sink(indexer, monkeypatch, tmp_path):
    def factory(**cfg):
        raise AssertionError("dry run must not construct a sink")

    sinks.register_sink("fakedry", factory)
    try:
        repo, _vault = make_source(tmp_path)
        assert run_main(indexer, monkeypatch, tmp_path, ["--sink", "fakedry", "--repo", str(repo)], {}) == 0
    finally:
        sinks._registry.pop("fakedry")


def test_resolve_url_precedence(indexer, monkeypatch):
    monkeypatch.delenv("HINDSIGHT_URL", raising=False)
    monkeypatch.delenv("MEMORY_API_URL", raising=False)
    assert indexer.resolve_url("hindsight", None) == "http://127.0.0.1:8888"
    assert indexer.resolve_url("mem0", None) is None
    monkeypatch.setenv("HINDSIGHT_URL", "http://h:1")
    monkeypatch.setenv("MEMORY_API_URL", "http://m:2")
    assert indexer.resolve_url("hindsight", None) == "http://h:1"
    assert indexer.resolve_url("mem0", None) == "http://m:2"
    assert indexer.resolve_url("mem0", "http://flag:3") == "http://flag:3"
    assert indexer.resolve_url("hindsight", "http://flag:3") == "http://flag:3"
