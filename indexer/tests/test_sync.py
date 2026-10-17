"""Doc ID namespacing and the stale-deletion guard for bin/hindsight-project-index."""

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
    first = indexer.source_documents(make_repo(tmp_path / "a" / "proj"), apply=False)[0]
    second = indexer.source_documents(make_repo(tmp_path / "b" / "proj"), apply=False)[0]
    assert first and second
    assert not set(first) & set(second)


def test_stale_guard_keeps_code_and_unknown_documents(indexer, tmp_path, capsys):
    source = tmp_path / "repo"
    state = {
        str(source): {"code-id": "d1", "doc-id": "d2", "legacy-id": "d3"},
        indexer.kinds_key(source): {"code-id": "code", "doc-id": "doc"},
    }
    # Guarded run: only the known-prose document may be deleted; the code and legacy entries stay.
    changed, stale = indexer.sync(source, "bank", {}, "http://unused", state, tmp_path / "state.json", False, None, None, guard_code=True)
    assert stale == 1
    assert "keeping code documents" in capsys.readouterr().err


def test_unguarded_sync_counts_all_stale_documents(indexer, tmp_path):
    source = tmp_path / "repo"
    state = {str(source): {"code-id": "d1", "doc-id": "d2"}, indexer.kinds_key(source): {"code-id": "code", "doc-id": "doc"}}
    _, stale = indexer.sync(source, "bank", {}, "http://unused", state, tmp_path / "state.json", False, None, None)
    assert stale == 2
