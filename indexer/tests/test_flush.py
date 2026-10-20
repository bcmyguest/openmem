"""The optional sink `flush(bank)` hook: the helper, and when the indexer CLI calls it."""

import importlib.machinery
import importlib.util
import json
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


# Pending-flush marker: a failed or interrupted flush is retried by the next process.


class Scripted(FlushingSink):
    """Shared `plan` drives failures across runs; every run builds a fresh instance, like a fresh process."""

    def __init__(self, plan):
        super().__init__()
        self.plan = plan

    def retain(self, bank, doc_id, content, **kwargs):
        if self.plan.get("fail_retain_bank") == bank:
            retains = [call for call in self.calls if call[0] == "retain" and call[1] == bank]
            if retains:
                self.plan.pop("fail_retain_bank")
                raise sinks.SinkError("retain failed", status=500)
        super().retain(bank, doc_id, content, **kwargs)

    def flush(self, bank):
        if bank in self.plan.get("fail_flush_banks", set()):
            self.plan["fail_flush_banks"].discard(bank)
            raise sinks.SinkError("cognify failed", status=500)
        super().flush(bank)


def load_state(tmp_path):
    return json.loads((tmp_path / "state.json").read_text())


def pending(indexer, tmp_path):
    return load_state(tmp_path).get(indexer.PENDING_FLUSH_KEY)


def test_failed_flush_is_retried_by_the_next_apply_even_when_nothing_changed(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    plan = {"fail_flush_banks": set(BANKS)}
    run = lambda: run_main(indexer, monkeypatch, tmp_path, lambda url: Scripted(plan), source_argv(repo, vault))

    code, (first,) = run()
    assert code == 1
    assert flushes(first) == []
    assert pending(indexer, tmp_path) == BANKS

    code, (second,) = run()
    assert code == 0
    assert [call[0] for call in second.calls] == ["flush", "flush"]  # no prepare, no retain: nothing changed
    assert sorted(flushes(second)) == [("flush", bank) for bank in BANKS]
    assert pending(indexer, tmp_path) is None

    code, (third,) = run()
    assert code == 0
    assert third.calls == []


def test_retain_failure_keeps_the_marker_and_the_next_run_flushes(indexer, monkeypatch, tmp_path, capsys):
    repo, vault = build_fixture(tmp_path)
    plan = {"fail_retain_bank": "coding-agent::proj"}
    run = lambda: run_main(indexer, monkeypatch, tmp_path, lambda url: Scripted(plan), source_argv(repo, vault))

    code, (first,) = run()
    assert code == 1
    assert "retain failed" in capsys.readouterr().err
    assert ("flush", "coding-agent::proj") not in first.calls
    assert ("flush", "obsidian::my-vault") in first.calls
    assert pending(indexer, tmp_path) == ["coding-agent::proj"]

    code, (second,) = run()
    assert code == 0
    assert [call[0] for call in second.calls if call[1] == "coding-agent::proj"][-1] == "flush"
    assert len(flushes(second)) == 1
    assert pending(indexer, tmp_path) is None


def test_dry_run_neither_flushes_nor_touches_the_marker(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    plan = {"fail_flush_banks": set(BANKS)}
    run_main(indexer, monkeypatch, tmp_path, lambda url: Scripted(plan), source_argv(repo, vault))
    before = (tmp_path / "state.json").read_bytes()
    code, built = run_main(indexer, monkeypatch, tmp_path, lambda url: Scripted(plan), source_argv(repo, vault, apply=False))
    assert code == 0
    assert built == []
    assert (tmp_path / "state.json").read_bytes() == before


def test_dry_run_on_a_fresh_state_writes_no_marker(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault, apply=False))
    assert not (tmp_path / "state.json").exists()


def test_sink_without_flush_leaves_the_state_free_of_any_marker(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    code, _ = run_main(indexer, monkeypatch, tmp_path, PlainSink, source_argv(repo, vault))
    assert code == 0
    state = load_state(tmp_path)
    assert indexer.PENDING_FLUSH_KEY not in state
    assert set(state) == {str(repo), str(vault), indexer.kinds_key(repo), indexer.kinds_key(vault)}


def test_successful_flush_leaves_the_state_free_of_the_marker(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    code, _ = run_main(indexer, monkeypatch, tmp_path, FlushingSink, source_argv(repo, vault))
    assert code == 0
    assert indexer.PENDING_FLUSH_KEY not in load_state(tmp_path)


def test_marker_is_scoped_to_the_banks_a_run_handles(indexer, monkeypatch, tmp_path):
    repo, vault = build_fixture(tmp_path)
    plan = {"fail_flush_banks": set(BANKS)}
    factory = lambda url: Scripted(plan)
    run_main(indexer, monkeypatch, tmp_path, factory, source_argv(repo, vault))
    assert pending(indexer, tmp_path) == BANKS

    code, (repo_only,) = run_main(indexer, monkeypatch, tmp_path, factory, ["--apply", "--repo", str(repo)])
    assert code == 0
    assert flushes(repo_only) == [("flush", "coding-agent::proj")]
    assert pending(indexer, tmp_path) == ["obsidian::my-vault"]

    code, (rest,) = run_main(indexer, monkeypatch, tmp_path, factory, source_argv(repo, vault))
    assert code == 0
    assert flushes(rest) == [("flush", "obsidian::my-vault")]
    assert pending(indexer, tmp_path) is None
