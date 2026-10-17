"""Doc ID namespacing, code outline documents and stale deletion for bin/hindsight-project-index."""

import importlib.machinery
import importlib.util
import subprocess
from pathlib import Path

import pytest


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


def test_unguarded_sync_counts_all_stale_documents(indexer, tmp_path):
    source = tmp_path / "repo"
    state = {str(source): {"code-id": "d1", "doc-id": "d2"}, indexer.kinds_key(source): {"code-id": "code", "doc-id": "doc"}}
    _, stale = indexer.sync(source, "bank", {}, "http://unused", state, tmp_path / "state.json", False, None, None)
    assert stale == 2


def stale_state(source: Path) -> dict:
    return {str(source): {"gone-id": "d1"}, indexer_kinds(source): {"gone-id": "doc"}}


def indexer_kinds(source: Path) -> str:
    return f"{source}::kinds"


def test_delete_404_counts_as_removed_and_drops_manifest_entry(indexer, tmp_path, monkeypatch):
    source = tmp_path / "repo"
    state_path = tmp_path / "state.json"
    state = stale_state(source)
    calls = []

    def fake_request(url, method, payload=None):
        calls.append((method, url))
        raise indexer.HttpError(method, url, 404, "Document not found")

    monkeypatch.setattr(indexer, "request", fake_request)

    changed, stale = indexer.sync(source, "bank", {}, "http://unused", state, state_path, True, None, None)

    assert (changed, stale) == (0, 1)
    assert calls and calls[0][0] == "DELETE"
    assert "gone-id" not in state[str(source)]
    assert "gone-id" not in state[indexer_kinds(source)]


def test_delete_500_still_fails(indexer, tmp_path, monkeypatch):
    source = tmp_path / "repo"
    state = stale_state(source)

    def fake_request(url, method, payload=None):
        raise indexer.HttpError(method, url, 500, "boom")

    monkeypatch.setattr(indexer, "request", fake_request)

    with pytest.raises(indexer.HttpError, match="HTTP 500"):
        indexer.sync(source, "bank", {}, "http://unused", state, tmp_path / "state.json", True, None, None)
    assert "gone-id" in state[str(source)]
