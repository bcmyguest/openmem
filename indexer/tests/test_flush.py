"""The optional sink `flush(bank)` hook: the helper, and when the indexer CLI calls it."""

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

import pytest

import sinks
from hindsight_stub import build_fixture, mutate_fixture


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "hindsight-project-index"
BANKS = ["coding-agent::proj", "obsidian::my-vault"]


@pytest.fixture(scope="module")
def indexer():
    loader = importlib.machinery.SourceFileLoader("hindsight_project_index_flush", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class PlainSink:
    """No flush attribute: satisfies the Sink protocol exactly as the existing sinks do."""

    capabilities = sinks.Capabilities()

    def __init__(self, url: str | None = None):
        self.calls: list[tuple] = []

    def health(self):
        return True

    def prepare(self, bank):
        self.calls.append(("prepare", bank))

    def retain(self, bank, doc_id, content, *, tags=None, metadata=None, context=None, timestamp=None):
        self.calls.append(("retain", bank, doc_id))

    def delete(self, bank, doc_id):
        self.calls.append(("delete", bank, doc_id))


class FlushingSink(PlainSink):
    capabilities = sinks.Capabilities(async_ingest=True)

    def flush(self, bank):
        self.calls.append(("flush", bank))


class FailingFlushSink(FlushingSink):
    def flush(self, bank):
        raise sinks.SinkError("cognify failed", status=500)


def run_main(indexer, monkeypatch, tmp_path, factory, extra_argv):
    built = []

    def build(**cfg):
        sink = factory(cfg.get("url"))
        built.append(sink)
        return sink

    for key in ("HINDSIGHT_URL", "MEMORY_API_URL", "MEMORY_SINK"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(indexer, "AGENT_CONFIG", tmp_path / "absent-coding-agent.json")
    sinks.register_sink("fakeflush", build)
    try:
        argv = ["hindsight-project-index", "--sink", "fakeflush", "--state", str(tmp_path / "state.json"), *extra_argv]
        monkeypatch.setattr(sys, "argv", argv)
        code = indexer.main()
    finally:
        sinks._registry.pop("fakeflush")
    return code, built


def source_argv(repo, vault, apply=True):
    return (["--apply"] if apply else []) + ["--repo", str(repo), "--vault", str(vault)]


def flushes(sink):
    return [call for call in sink.calls if call[0] == "flush"]


def test_flush_sink_is_a_noop_without_flush():
    sink = PlainSink()
    assert isinstance(sink, sinks.Sink)
    sinks.flush_sink(sink, "b")
    assert sink.calls == []


def test_flush_sink_calls_flush_with_the_bank():
    sink = FlushingSink()
    sinks.flush_sink(sink, "b::1")
    assert sink.calls == [("flush", "b::1")]


def test_flush_is_not_part_of_the_sink_protocol():
    assert isinstance(FlushingSink(), sinks.Sink)
    assert "flush" not in sinks.Sink.__protocol_attrs__


def test_apply_flushes_each_changed_bank_once_after_its_writes(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    code, (sink,) = run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    assert code == 0
    assert sorted(flushes(sink)) == [("flush", bank) for bank in BANKS]
    for bank in BANKS:
        writes = [i for i, call in enumerate(sink.calls) if call[0] in ("retain", "delete") and call[1] == bank]
        (flush_at,) = [i for i, call in enumerate(sink.calls) if call == ("flush", bank)]
        assert writes and flush_at > max(writes)


def test_flush_after_deletes_only_still_flushes(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    (vault / "plan.md").unlink()
    code, (sink,) = run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    assert code == 0
    assert [call[0] for call in sink.calls if call[1] == "obsidian::my-vault"] == ["delete", "flush"]
    assert flushes(sink) == [("flush", "obsidian::my-vault")]


def test_second_apply_with_nothing_changed_does_not_flush(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    code, (sink,) = run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    assert code == 0
    assert sink.calls == []


def test_changed_documents_flush_again_on_the_next_apply(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    mutate_fixture(repo, vault)
    code, (sink,) = run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    assert code == 0
    assert sorted(flushes(sink)) == [("flush", bank) for bank in BANKS]


def test_dry_run_never_flushes(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    code, built = run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault, apply=False))
    assert code == 0
    assert built == []


def test_sink_without_flush_runs_unchanged(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    code, (sink,) = run_main(indexer, monkeypatch, tmp_path, PlainSink, source_argv(repo, vault))
    assert code == 0
    assert {call[0] for call in sink.calls} == {"prepare", "retain"}


def test_flush_error_fails_that_source_like_a_retain_error(indexer, monkeypatch, tmp_path, capsys):
    repo, vault = build_fixture(tmp_path)
    code, _ = run_main(indexer, monkeypatch, tmp_path, FailingFlushSink, source_argv(repo, vault))
    assert code == 1
    err = capsys.readouterr().err
    assert "SinkError: cognify failed" in err and "2 source(s) failed" in err
