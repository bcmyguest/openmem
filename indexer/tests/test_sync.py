"""Doc ID namespacing, code outline documents and stale deletion for bin/hindsight-project-index."""

import importlib.machinery
import importlib.util
import subprocess
from pathlib import Path

import pytest

import sinks


SCRIPT = Path(__file__).resolve().parents[2] / "bin" / "hindsight-project-index"


@pytest.fixture(scope="module")
def indexer():
    loader = importlib.machinery.SourceFileLoader("hindsight_project_index_sync", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def make_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    (path / "README.md").write_text("# Same\n\nsame text\n")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    return path


def test_same_relative_path_in_two_repos_gets_distinct_doc_ids(indexer, tmp_path):
    first = indexer.source_documents(make_repo(tmp_path / "a" / "proj"))
    second = indexer.source_documents(make_repo(tmp_path / "b" / "proj"))
    assert first and second
    assert not set(first) & set(second)


def test_code_files_become_outline_documents_and_unknown_suffixes_are_skipped(indexer, tmp_path):
    repo = make_repo(tmp_path / "proj")
    (repo / "app.py").write_text("def handler(event):\n    return event\n")
    (repo / "notes.txt").write_text("not code\n")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    documents = indexer.source_documents(repo)
    code = [value for value in documents.values() if value["kind"] == "code"]
    assert [value["path"] for value in code] == ["app.py"]
    assert "- L1 def handler(event):" in code[0]["content"]
    assert all(value["path"] != "notes.txt" for value in documents.values())


class RecordingSink:
    """Satisfies sinks.Sink; records calls and optionally fails deletes."""

    capabilities = sinks.Capabilities()

    def __init__(self, delete_error: Exception | None = None):
        self.calls: list[tuple] = []
        self.delete_error = delete_error

    def health(self) -> bool:
        return True

    def prepare(self, bank):
        self.calls.append(("prepare", bank))

    def retain(self, bank, doc_id, content, *, tags=None, metadata=None, context=None, timestamp=None):
        self.calls.append(("retain", bank, doc_id, content, tags, metadata, context, timestamp))

    def delete(self, bank, doc_id):
        self.calls.append(("delete", bank, doc_id))
        if self.delete_error:
            raise self.delete_error


def test_unguarded_sync_counts_all_stale_documents(indexer, tmp_path):
    source = tmp_path / "repo"
    state = {str(source): {"code-id": "d1", "doc-id": "d2"}, indexer.kinds_key(source): {"code-id": "code", "doc-id": "doc"}}
    sink = RecordingSink()
    _, stale = indexer.sync(source, "bank", {}, sink, state, tmp_path / "state.json", False, None, None)
    assert stale == 2
    assert sink.calls == []  # a dry run never touches the sink


def stale_state(source: Path) -> dict:
    return {str(source): {"gone-id": "d1"}, indexer_kinds(source): {"gone-id": "doc"}}


def indexer_kinds(source: Path) -> str:
    return f"{source}::kinds"


def test_stale_document_is_deleted_and_dropped_from_manifest(indexer, tmp_path):
    source = tmp_path / "repo"
    state = stale_state(source)
    sink = RecordingSink()

    changed, stale = indexer.sync(source, "bank", {}, sink, state, tmp_path / "state.json", True, None, None)

    assert (changed, stale) == (0, 1)
    assert sink.calls == [("delete", "bank", "gone-id")]
    assert "gone-id" not in state[str(source)]
    assert "gone-id" not in state[indexer_kinds(source)]


def test_sink_delete_failure_keeps_manifest_entry(indexer, tmp_path):
    source = tmp_path / "repo"
    state = stale_state(source)
    sink = RecordingSink(delete_error=sinks.SinkError("boom", 500))

    with pytest.raises(sinks.SinkError, match="boom"):
        indexer.sync(source, "bank", {}, sink, state, tmp_path / "state.json", True, None, None)
    assert "gone-id" in state[str(source)]


def test_changed_documents_prepare_once_then_retain_each(indexer, tmp_path):
    source = tmp_path / "repo"
    documents = {
        "id-1": {"content": "one", "digest": "d1", "kind": "doc", "context": "ctx", "metadata": {"path": "a.md"}},
        "id-2": {"content": "two", "digest": "d2", "kind": "note", "context": "ctx", "metadata": {"path": "b.md"}, "tags": ["x"]},
    }
    state: dict = {}
    sink = RecordingSink()

    changed, stale = indexer.sync(source, "bank", documents, sink, state, tmp_path / "state.json", True, None, None)

    assert (changed, stale) == (2, 0)
    assert sink.calls == [
        ("prepare", "bank"),
        ("retain", "bank", "id-1", "one", None, {"path": "a.md"}, "ctx", None),
        ("retain", "bank", "id-2", "two", ["x"], {"path": "b.md"}, "ctx", None),
    ]
    assert state[str(source)] == {"id-1": "d1", "id-2": "d2"}
