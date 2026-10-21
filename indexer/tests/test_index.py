"""Vault discovery, bank naming and opt-in filtering for bin/hindsight-project-index."""

import importlib.machinery
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "bin" / "hindsight-project-index"


@pytest.fixture(scope="module")
def indexer():
    loader = importlib.machinery.SourceFileLoader("hindsight_project_index", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_vault_bank_slugifies_name(indexer):
    assert indexer.vault_bank(Path("/home/alice/Documents/Acme Notes")) == "obsidian::acme-notes"
    assert indexer.vault_bank(Path("/tmp/Personal")) == "obsidian::personal"


def test_vault_documents_skips_obsidian_and_trash(indexer, tmp_path):
    vault = tmp_path / "My Vault"
    (vault / "projects").mkdir(parents=True)
    (vault / ".obsidian").mkdir()
    (vault / ".trash").mkdir()
    (vault / "projects" / "plan.md").write_text("# Plan\n\nSee [[Roadmap|the roadmap]].\n")
    (vault / ".obsidian" / "app.md").write_text("# hidden\n\nconfig\n")
    (vault / ".trash" / "old.md").write_text("# gone\n\ndeleted\n")
    (vault / "notes.txt").write_text("# not markdown\n")

    documents = indexer.vault_documents(vault)

    paths = {value["path"] for value in documents.values()}
    assert paths == {"projects/plan.md"}
    (doc,) = documents.values()
    assert doc["metadata"]["links"] == "Roadmap"
    assert doc["context"] == "Obsidian vault My Vault note"
    assert doc["content"].startswith("Vault: My Vault\nSource: projects/plan.md")


def test_vault_documents_strips_html_for_bookmarks_kind(indexer, tmp_path):
    folder = tmp_path / "exports"
    folder.mkdir()
    (folder / "link.html").write_text(
        "<html><head><title>T</title><style>.x{}</style></head>"
        "<body><h1>Save</h1><p>Hello <b>world</b></p><script>bad()</script></body></html>"
    )
    documents = indexer.vault_documents(folder, kind="bookmarks")
    assert len(documents) == 1
    content = next(iter(documents.values()))["content"]
    assert "Hello" in content and "world" in content
    assert "bad()" not in content
    assert "<h1>" not in content


def test_vault_documents_collects_frontmatter_and_inline_tags(indexer, tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "a.md").write_text(
        "---\ntags:\n  - work\n  - \"#infra\"\n---\n# Title\n\nBody with #ops and a [[Target]].\n"
    )
    (vault / "b.md").write_text("---\ntags: [alpha, beta]\n---\n# B\n\nText.\n")

    documents = {value["path"]: value for value in indexer.vault_documents(vault).values()}

    assert documents["a.md"]["tags"] == ["work", "infra", "ops"]
    assert documents["b.md"]["tags"] == ["alpha", "beta"]
    assert "---" not in documents["a.md"]["content"]


def test_vault_document_ids_are_stable(indexer, tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "a.md").write_text("# A\n\nSame text.\n")

    first = set(indexer.vault_documents(vault))
    second = set(indexer.vault_documents(vault))

    assert first == second
    assert all(doc_id.startswith("obsidian-index:v1:") for doc_id in first)


def test_opt_in_paths_missing_config_means_no_filter(indexer, tmp_path):
    assert indexer.load_opt_in_paths(tmp_path / "absent.json") is None


def test_opt_in_filter_keeps_only_listed_trees(indexer, tmp_path):
    config = tmp_path / "coding-agent.json"
    allowed_root = tmp_path / "home" / "alice"
    config.write_text(json.dumps({"optInPaths": [str(allowed_root)]}))
    allowed = indexer.load_opt_in_paths(config)

    inside = allowed_root / "adrs"
    outside = tmp_path / "other" / "repo"

    assert indexer.opted_in(inside, allowed)
    assert indexer.opted_in(allowed_root, allowed)
    assert not indexer.opted_in(outside, allowed)
    assert not indexer.opted_in(tmp_path / "home" / "bob", allowed)


def test_empty_opt_in_list_indexes_nothing(indexer, tmp_path):
    config = tmp_path / "coding-agent.json"
    config.write_text(json.dumps({"optInPaths": []}))
    allowed = indexer.load_opt_in_paths(config)

    assert allowed == []
    assert not indexer.opted_in(tmp_path, allowed)


def test_bank_id_uses_mapping_then_repo_name(indexer, tmp_path, monkeypatch):
    config = tmp_path / "coding-agent.json"
    mapped = tmp_path / "Documents" / "sample-project"
    config.write_text(json.dumps({"mapPathToBank": {str(mapped): "coding-agent::documents-sample-project"}}))
    monkeypatch.setattr(indexer, "AGENT_CONFIG", config)

    assert indexer.bank_id(mapped) == "coding-agent::documents-sample-project"
    assert indexer.bank_id(tmp_path / "adrs") == "coding-agent::adrs"


def test_frontmatter_without_closing_fence_is_body(indexer):
    tags, body = indexer.split_frontmatter("---\ntags: [x]\n# never closed\n")

    assert tags == []
    assert body.startswith("---\ntags")
