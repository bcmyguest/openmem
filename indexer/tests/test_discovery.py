"""Source discovery from index.yml (roots, vault auto-discovery, exclude) and bank precedence in bin/hindsight-project-index."""

import importlib.machinery
import importlib.util
import json
import subprocess
from pathlib import Path

import index_config
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "bin" / "hindsight-project-index"


@pytest.fixture(scope="module")
def indexer():
    loader = importlib.machinery.SourceFileLoader("hindsight_project_index_discovery", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def make_home(home: Path) -> Path:
    for vault in ("Documents/Personal", "Documents/Work", "Documents/Acme Notes", "deep/a/b/c", ".hidden", "Documents/node_modules/x"):
        (home / vault / ".obsidian").mkdir(parents=True)
    repo = home / "proj"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    return home


def config_for(home: Path, **overrides) -> index_config.Config:
    data = {"roots": [{"path": str(home), "depth": 3}], "repos": [], "exclude": [], "banks": {}}
    data.update(overrides)
    return index_config.parse(data, source="test")


def test_vault_auto_discovery_finds_vaults_within_depth(indexer, tmp_path):
    home = make_home(tmp_path)

    _repos, vaults, _md = indexer.discover(config_for(home))

    assert vaults == [home / "Documents/Acme Notes", home / "Documents/Personal", home / "Documents/Work"]


def test_vault_auto_false_keeps_only_explicit_vaults(indexer, tmp_path):
    home = make_home(tmp_path)
    extra = home / "elsewhere"
    (extra / ".obsidian").mkdir(parents=True)

    _repos, vaults, _notes = indexer.discover(config_for(home, vaults={"auto": False, "paths": [str(extra)]}))

    assert vaults == [extra]


def test_repos_discovered_under_roots_and_explicit_repos_added(indexer, tmp_path):
    home = make_home(tmp_path)
    nvim = tmp_path / "outside" / "nvim"
    nvim.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=nvim, check=True)

    repos, _vaults, _md = indexer.discover(config_for(home, repos=[str(nvim)]))

    assert repos == sorted([home / "proj", nvim])


def test_markdown_paths_discovered(indexer, tmp_path):
    notes = tmp_path / "my-notes"
    notes.mkdir()
    (notes / "readme.md").write_text("# Hi\n")
    papers = tmp_path / "papers-lib"
    papers.mkdir()
    _repos, _vaults, found = indexer.discover(
        config_for(tmp_path, notes={"paths": [str(notes)]}, papers={"paths": [str(papers)]}),
    )
    assert found == [("notes", notes), ("papers", papers)]


def test_exclude_skips_listed_source(indexer, tmp_path, monkeypatch, capsys):
    home = make_home(tmp_path)
    config_file = tmp_path / "index.yml"
    config_file.write_text(f"roots:\n  - path: {home}\n    depth: 3\nrepos: []\nexclude:\n  - {home}/proj\n")
    monkeypatch.setattr(indexer, "AGENT_CONFIG", tmp_path / "absent.json")
    monkeypatch.setattr("sys.argv", ["hindsight-project-index", "--config", str(config_file), "--list"])

    assert indexer.main() == 0

    out = capsys.readouterr().out.splitlines()
    assert out == [f"vault\t{home / 'Documents/Acme Notes'}", f"vault\t{home / 'Documents/Personal'}", f"vault\t{home / 'Documents/Work'}"]


def test_invalid_config_exits_with_error(indexer, tmp_path, monkeypatch, capsys):
    config_file = tmp_path / "index.yml"
    config_file.write_text("reposs: []\n")
    monkeypatch.setattr("sys.argv", ["hindsight-project-index", "--config", str(config_file), "--list"])

    assert indexer.main() == 2
    assert "unknown key(s) reposs" in capsys.readouterr().err


def test_bank_precedence_config_then_personal_then_legacy_then_name(indexer, tmp_path, monkeypatch):
    personal = tmp_path / "personal-coding-agent.json"
    personal.write_text(json.dumps({"mapPathToBank": {str(tmp_path / "agent"): "from-personal"}}))
    legacy = tmp_path / "legacy-coding-agent.json"
    legacy.write_text(json.dumps({"mapPathToBank": {
        str(tmp_path / "agent"): "legacy-lower-priority",
        str(tmp_path / "legacy"): "from-legacy",
    }}))
    monkeypatch.setattr(indexer, "PERSONAL_MEMORY_AGENT_CONFIG", personal)
    monkeypatch.setattr(indexer, "AGENT_CONFIG", legacy)
    config = config_for(tmp_path, banks={str(tmp_path / "agent"): "from-config", str(tmp_path / "cfg"): "cfg-bank"})

    assert indexer.bank_id(tmp_path / "agent" / "repo", config) == "from-config"
    assert indexer.bank_id(tmp_path / "cfg" / "repo", config) == "cfg-bank"
    assert indexer.bank_id(tmp_path / "agent" / "repo") == "from-personal"
    assert indexer.bank_id(tmp_path / "legacy" / "repo") == "from-legacy"
    assert indexer.bank_id(tmp_path / "plain" / "MixedCase") == "coding-agent::MixedCase"


def test_linked_worktree_uses_common_project_name(indexer, tmp_path):
    main = tmp_path / "MainProject"
    worktree = tmp_path / "linked-checkout"
    git_dir = main / ".git"
    worktree_git_dir = git_dir / "worktrees" / "linked-checkout"
    worktree_git_dir.mkdir(parents=True)
    (worktree_git_dir / "commondir").write_text("../..\n")
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {worktree_git_dir}\n")

    assert indexer.bank_id(worktree) == "coding-agent::MainProject"


def test_vault_bank_uses_config_before_slug(indexer, tmp_path):
    config = config_for(tmp_path, banks={str(tmp_path / "Documents"): "obsidian::shared"})

    assert indexer.vault_bank(tmp_path / "Documents/Work", config) == "obsidian::shared"
    assert indexer.vault_bank(tmp_path / "Documents/Work") == "obsidian::work"
