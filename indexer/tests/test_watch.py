"""Repository fingerprints and poll debounce for indexer/watch.py."""

import importlib.machinery
import importlib.util
import subprocess
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "watch.py"


@pytest.fixture(scope="module")
def watch():
    loader = importlib.machinery.SourceFileLoader("indexer_watch", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    path.mkdir()
    git(path, "init", "-q")
    (path / "tracked.md").write_text("one\n")
    git(path, "add", "tracked.md")
    git(path, "commit", "-q", "-m", "init")
    return path


def test_fingerprint_is_stable_without_changes(watch, repo):
    assert watch.git_fingerprint(repo) == watch.git_fingerprint(repo)


def test_fingerprint_ignores_untracked_files(watch, repo):
    before = watch.git_fingerprint(repo)
    (repo / "scratch.txt").write_text("new\n")
    assert watch.git_fingerprint(repo) == before


def test_fingerprint_changes_on_tracked_edit(watch, repo):
    before = watch.git_fingerprint(repo)
    (repo / "tracked.md").write_text("two\n")
    assert watch.git_fingerprint(repo) != before


def test_fingerprint_changes_on_commit(watch, repo):
    before = watch.git_fingerprint(repo)
    (repo / "tracked.md").write_text("two\n")
    git(repo, "commit", "-q", "-am", "edit")
    assert watch.git_fingerprint(repo) != before


def test_fingerprint_works_for_repository_without_commits(watch, tmp_path):
    path = tmp_path / "empty"
    path.mkdir()
    git(path, "init", "-q")
    assert watch.git_fingerprint(path).startswith("unborn:")


def test_change_indexes_only_after_one_stable_poll(watch):
    state = watch.RepoWatch(indexed="a", seen="a")

    state, should = watch.step(state, "b")
    assert should is False  # first sighting of the change: wait one poll

    state, should = watch.step(state, "b")
    assert should is True  # unchanged for one more poll: index

    state = watch.mark_indexed(state, "b")
    state, should = watch.step(state, "b")
    assert should is False  # already indexed


def test_flapping_fingerprint_never_indexes(watch):
    state = watch.RepoWatch(indexed="a", seen="a")
    for fingerprint in ("b", "c", "b", "c"):
        state, should = watch.step(state, fingerprint)
        assert should is False


def test_change_reverted_before_stable_does_not_index(watch):
    state = watch.RepoWatch(indexed="a", seen="a")
    state, _ = watch.step(state, "b")
    state, should = watch.step(state, "a")
    assert should is False


def test_failed_index_is_retried_on_next_stable_poll(watch):
    state = watch.RepoWatch(indexed="a", seen="a")
    state, _ = watch.step(state, "b")
    state, should = watch.step(state, "b")
    assert should is True
    # The run failed, so mark_indexed is not called; the fingerprint is still unindexed and stable.
    state, should = watch.step(state, "b")
    assert should is True


def test_timings_come_from_config_and_environment_overrides_it(watch, tmp_path):
    import index_config

    settings = index_config.parse({"poll_seconds": 5, "vault_quiet_seconds": 7, "relist_seconds": 9}, source="test")

    assert watch.timings(settings, {}) == (5, 7, 9)
    assert watch.timings(settings, {"POLL_SECONDS": "11", "RELIST_SECONDS": "13"}) == (11, 7, 13)
