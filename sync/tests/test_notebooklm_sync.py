import asyncio
import json
from pathlib import Path

import pytest
import yaml

import notebooklm_sync as ns

REPO = Path(__file__).resolve().parents[2]


class FakeHindsight:
    """Records calls; fails retains for doc IDs listed in fail_retain."""

    def __init__(self, fail_retain=()):
        self.retained: list[tuple[str, str]] = []
        self.deleted: list[tuple[str, str]] = []
        self.banks: list[str] = []
        self.fail_retain = set(fail_retain)

    def ensure_bank(self, bank):
        self.banks.append(bank)

    def retain(self, bank, doc_id, document):
        if doc_id in self.fail_retain:
            raise ns.HttpError("POST", "/memories", 500, "boom")
        self.retained.append((bank, doc_id))

    def delete(self, bank, doc_id):
        self.deleted.append((bank, doc_id))


def snap(nb_id="nb1", title="Project Alpha", items=(), complete=True):
    return ns.NotebookSnapshot(nb_id, title, tuple(items), complete)


def note(item_id="n1", title="Decision", body="Use Postgres."):
    return ns.Item("note", item_id, title, body)


def fetch_of(*snapshots, listing_complete=True):
    return ns.FetchResult(tuple(snapshots), listing_complete=listing_complete)


def base_config(**overrides):
    raw = yaml.safe_load((REPO / "config" / "notebooklm.yml").read_text())
    raw.update(overrides)
    return ns.validate_config(raw)


# ---------- slugs, banks, IDs ----------


def test_slugify_lowercases_and_collapses_punctuation():
    assert ns.slugify("My Project: Notes!") == "my-project-notes"


def test_slugify_falls_back_and_truncates():
    assert ns.slugify("  !!! ") == "untitled"
    assert len(ns.slugify("a" * 200)) == 80


def test_assign_banks_uses_prefix_and_title():
    banks = ns.assign_banks([("nb1", "Project Alpha")], "notebooklm")
    assert banks == {"nb1": "notebooklm::project-alpha"}


def test_assign_banks_suffixes_only_duplicate_titles():
    banks = ns.assign_banks([("abcdef123456", "Same"), ("zz999999", "Same"), ("q1", "Other")], "notebooklm")
    assert banks["abcdef123456"] == "notebooklm::same-abcdef12"
    assert banks["zz999999"] == "notebooklm::same-zz999999"
    assert banks["q1"] == "notebooklm::other"


def test_document_ids_are_stable_and_namespaced():
    assert ns.document_id("nb1", "note", "n1") == "notebooklm:v1:nb1:note:n1"
    assert ns.chat_item_id("What is X?") == ns.chat_item_id("What is X?")
    assert ns.chat_item_id("What is X?") != ns.chat_item_id("What is Y?")


def test_digest_changes_only_with_content():
    first = ns.build_documents(snap(items=[note()]), "notebooklm::project-alpha")
    again = ns.build_documents(snap(items=[note()]), "notebooklm::project-alpha")
    edited = ns.build_documents(snap(items=[note(body="Use SQLite.")]), "notebooklm::project-alpha")
    key = "notebooklm:v1:nb1:note:n1"
    assert first[key]["digest"] == again[key]["digest"]
    assert first[key]["digest"] != edited[key]["digest"]
    assert first[key]["bank"] == "notebooklm::project-alpha"


# ---------- sync core: change detection, deletion, state ----------


def test_first_sync_retains_then_second_sync_skips(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    hs = FakeHindsight()
    fetch = fetch_of(snap(items=[note(), note("n2", "Other", "x")]))
    first = ns.sync_snapshots(fetch, "notebooklm", hs, state, state_path)
    assert first.retained == 2 and first.skipped == 0
    assert len(hs.retained) == 2

    hs2 = FakeHindsight()
    second = ns.sync_snapshots(fetch, "notebooklm", hs2, ns.load_state(state_path), state_path)
    assert second.retained == 0 and second.skipped == 2
    assert hs2.retained == [] and hs2.deleted == []


def test_edited_item_is_retained_again(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    ns.sync_snapshots(fetch_of(snap(items=[note()])), "notebooklm", FakeHindsight(), state, state_path)
    hs = FakeHindsight()
    report = ns.sync_snapshots(fetch_of(snap(items=[note(body="changed")])), "notebooklm", hs, ns.load_state(state_path), state_path)
    assert report.retained == 1
    assert hs.retained == [("notebooklm::project-alpha", "notebooklm:v1:nb1:note:n1")]


def test_removed_item_is_deleted_and_dropped_from_state(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    ns.sync_snapshots(fetch_of(snap(items=[note(), note("n2")])), "notebooklm", FakeHindsight(), state, state_path)
    hs = FakeHindsight()
    report = ns.sync_snapshots(fetch_of(snap(items=[note()])), "notebooklm", hs, ns.load_state(state_path), state_path)
    assert report.deleted == 1
    assert hs.deleted == [("notebooklm::project-alpha", "notebooklm:v1:nb1:note:n2")]
    assert "notebooklm:v1:nb1:note:n2" not in ns.load_state(state_path)


def test_incomplete_notebook_keeps_its_documents(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    ns.sync_snapshots(fetch_of(snap(items=[note()])), "notebooklm", FakeHindsight(), state, state_path)
    hs = FakeHindsight()
    report = ns.sync_snapshots(fetch_of(snap(items=[], complete=False)), "notebooklm", hs, state, state_path)
    assert hs.deleted == [] and report.skipped == 1
    assert "notebooklm:v1:nb1:note:n1" in state


def test_vanished_notebook_is_deleted_only_when_listing_complete(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    ns.sync_snapshots(fetch_of(snap(items=[note()])), "notebooklm", FakeHindsight(), state, state_path)
    partial = FakeHindsight()
    ns.sync_snapshots(fetch_of(listing_complete=False), "notebooklm", partial, state, state_path)
    assert partial.deleted == []
    full = FakeHindsight()
    ns.sync_snapshots(fetch_of(listing_complete=True), "notebooklm", full, state, state_path)
    assert full.deleted == [("notebooklm::project-alpha", "notebooklm:v1:nb1:note:n1")]
    assert state == {}


def test_renamed_notebook_moves_documents_to_new_bank(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    ns.sync_snapshots(fetch_of(snap(title="Old Name", items=[note()])), "notebooklm", FakeHindsight(), state, state_path)
    hs = FakeHindsight()
    ns.sync_snapshots(fetch_of(snap(title="New Name", items=[note()])), "notebooklm", hs, state, state_path)
    assert ("notebooklm::new-name", "notebooklm:v1:nb1:note:n1") in hs.retained
    assert hs.deleted == [("notebooklm::old-name", "notebooklm:v1:nb1:note:n1")]
    assert state["notebooklm:v1:nb1:note:n1"]["bank"] == "notebooklm::new-name"


def test_retain_failure_is_counted_and_not_recorded(tmp_path):
    state_path = tmp_path / "state.json"
    state = {}
    hs = FakeHindsight(fail_retain={"notebooklm:v1:nb1:note:n1"})
    report = ns.sync_snapshots(fetch_of(snap(items=[note(), note("n2")])), "notebooklm", hs, state, state_path)
    assert report.failed == 1 and report.retained == 1
    assert "notebooklm:v1:nb1:note:n1" not in state
    assert "notebooklm:v1:nb1:note:n2" in state


def test_corrupt_state_file_is_an_error(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json")
    with pytest.raises(RuntimeError, match="corrupt"):
        ns.load_state(path)


def test_missing_state_file_is_empty(tmp_path):
    assert ns.load_state(tmp_path / "absent.json") == {}


def test_ensure_bank_creates_missing_bank_then_sets_strategy(monkeypatch):
    calls = []

    def fake_request(self, method, path, payload=None):
        calls.append((method, path))
        if method == "GET" and len(calls) == 1:
            raise ns.HttpError(method, path, 404, "missing")
        if method == "GET":
            return {"config": {"retain_strategies": {}, "enable_auto_consolidation": True}}
        return {}

    monkeypatch.setattr(ns.Hindsight, "_request", fake_request)
    ns.Hindsight("http://x").ensure_bank("notebooklm::a")
    assert calls[1] == ("PUT", "/v1/default/banks/notebooklm%3A%3Aa")
    assert calls[-1][0] == "PATCH"


# ---------- filtering ----------


def test_selects_applies_include_then_exclude_case_insensitively():
    cfg = base_config(include_notebooks=["work*"], exclude_notebooks=["*secret*"])
    assert cfg.selects("Work Notes")
    assert not cfg.selects("Work SECRET plan")
    assert not cfg.selects("Personal")


def test_empty_include_selects_everything():
    assert base_config().selects("Anything")


# ---------- configuration ----------


def test_shipped_default_is_disabled_client_backend():
    cfg = ns.load_config(REPO / "config" / "notebooklm.yml", Path("/nonexistent/override.yml"))
    assert cfg.enabled is False
    assert cfg.backend == "client"
    assert cfg.interval_minutes == 60
    assert (cfg.notes, cfg.sources, cfg.chats) == (True, True, False)


def test_override_merges_by_key(tmp_path):
    override = tmp_path / "override.yml"
    override.write_text("enabled: true\ninclude:\n  chats: true\n")
    cfg = ns.load_config(REPO / "config" / "notebooklm.yml", override)
    assert cfg.enabled is True
    assert cfg.chats is True and cfg.sources is True


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"backend": "scrape"}, "backend must be"),
        ({"interval_minutes": 0}, "interval_minutes must be"),
        ({"interval_minutes": True}, "interval_minutes must be an integer"),
        ({"bank_prefix": "Bad Prefix"}, "bank_prefix must match"),
        ({"enabled": "yes"}, "enabled must be true or false"),
        ({"include": {"notes": "yes"}}, "include.notes must be true or false"),
        ({"include": {"comments": True}}, "unknown key"),
        ({"include_notebooks": "work"}, "include_notebooks must be a list"),
        ({"enterprise": {"location": "asia"}}, "enterprise.location must be"),
        ({"enterprise": {"notebook_limit": 900}}, "notebook_limit must be"),
        ({"enterprise": {"project_number": "my-project"}}, "numeric project number"),
        ({"surprise": 1}, "unknown key"),
    ],
)
def test_invalid_config_is_rejected(overrides, message):
    with pytest.raises(ns.ConfigError, match=message):
        base_config(**overrides)


def test_enterprise_requires_project_number_when_enabled():
    with pytest.raises(ns.ConfigError, match="project_number is required"):
        base_config(enabled=True, backend="enterprise")


def test_enterprise_valid_when_project_given():
    cfg = base_config(enabled=True, backend="enterprise", enterprise={"project_number": "123456", "location": "us"})
    assert cfg.enterprise.project_number == "123456" and cfg.enterprise.location == "us"


def test_load_config_rejects_non_mapping(tmp_path):
    bad = tmp_path / "override.yml"
    bad.write_text("- just\n- a list\n")
    with pytest.raises(ns.ConfigError, match="mapping at the top level"):
        ns.load_config(REPO / "config" / "notebooklm.yml", bad)


# ---------- client adapter producing items ----------


class AuthError(Exception):
    pass


class BaseError(Exception):
    pass


class FakeSource:
    def __init__(self, sid, title, url=""):
        self.id, self.title, self.url = sid, title, url


class FakeSources:
    def __init__(self, fail_fulltext=False):
        self.fail_fulltext = fail_fulltext

    async def get_fulltext(self, notebook_id, source_id, output_format):
        if self.fail_fulltext:
            raise BaseError("no text")
        return type("Full", (), {"content": f"full text of {source_id}"})()

    async def get_guide(self, notebook_id, source_id):
        return type("Guide", (), {"summary": "short summary"})()


def test_client_source_item_includes_url_summary_and_text():
    item = asyncio.run(ns._client_source_item(type("C", (), {"sources": FakeSources()})(), "nb1", FakeSource("s1", "Spec", "https://example.com/spec"), AuthError, BaseError))
    assert item.kind == "source" and item.item_id == "s1" and item.title == "Spec"
    assert item.url == "https://example.com/spec"
    assert "URL: https://example.com/spec" in item.body
    assert "## Guide summary" in item.body and "short summary" in item.body
    assert "full text of s1" in item.body


def test_client_source_item_tolerates_missing_full_text():
    item = asyncio.run(ns._client_source_item(type("C", (), {"sources": FakeSources(fail_fulltext=True)})(), "nb1", FakeSource("s2", "Pdf"), AuthError, BaseError))
    assert "Guide summary" in item.body and "Full text" not in item.body


def test_client_source_item_reraises_auth_errors():
    class AuthSources:
        async def get_fulltext(self, *args, **kwargs):
            raise AuthError("expired")

    client = type("C", (), {"sources": AuthSources()})()
    with pytest.raises(AuthError):
        asyncio.run(ns._client_source_item(client, "nb1", FakeSource("s3", "x"), AuthError, BaseError))


def test_fetched_items_become_documents_with_stable_ids():
    item = asyncio.run(ns._client_source_item(type("C", (), {"sources": FakeSources()})(), "nb1", FakeSource("s1", "Spec"), AuthError, BaseError))
    docs = ns.build_documents(snap(items=[item]), "notebooklm::project-alpha")
    assert list(docs) == ["notebooklm:v1:nb1:source:s1"]
    assert docs["notebooklm:v1:nb1:source:s1"]["metadata"]["kind"] == "source"


# ---------- entry point ----------

SHIPPED_CONFIG = Path(__file__).resolve().parents[2] / "config" / "notebooklm.yml"


def test_check_config_exit_codes(tmp_path, capsys):
    bad = tmp_path / "override.yml"
    bad.write_text("backend: scrape\n")
    assert ns.main(["--check-config", "--config", str(SHIPPED_CONFIG), "--override", str(bad)]) == 2
    good = tmp_path / "ok.yml"
    good.write_text("enabled: false\n")
    assert ns.main(["--check-config", "--config", str(SHIPPED_CONFIG), "--override", str(good)]) == 0


def test_once_with_disabled_config_exits_zero(tmp_path):
    override = tmp_path / "override.yml"
    override.write_text("enabled: false\n")
    assert ns.main(["--once", "--config", str(SHIPPED_CONFIG), "--override", str(override), "--state", str(tmp_path / "s.json")]) == 0


def test_json_state_is_versioned(tmp_path):
    path = tmp_path / "state.json"
    ns.save_state(path, {"x": {"bank": "b", "notebook": "n", "digest": "d"}})
    assert json.loads(path.read_text())["version"] == 1
