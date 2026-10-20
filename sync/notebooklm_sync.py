#!/usr/bin/env python3
"""Sync NotebookLM notebooks into Hindsight banks, one bank per notebook.

Backends:
  client      unofficial notebooklm-py client, using the browser login stored in NOTEBOOKLM_HOME
  enterprise  documented NotebookLM Enterprise REST API; lists notebooks only (no source or note text)

Each item becomes one Hindsight document with a stable ID (notebooklm:v1:<notebook>:<kind>:<item>).
A state file records each document's bank and content digest, so unchanged items are skipped and
removed items are deleted from Hindsight. The state file is the only record of what this tool wrote.
"""

from __future__ import annotations

import argparse
import asyncio
import fnmatch
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_CONFIG = Path(os.environ.get("NOTEBOOKLM_CONFIG", "/opt/config/notebooklm.yml"))
DEFAULT_OVERRIDE = Path(os.environ.get("NOTEBOOKLM_OVERRIDE", "/etc/notebooklm/override.yml"))
DEFAULT_STATE = Path(os.environ.get("NOTEBOOKLM_STATE", "/data/state/state.json"))
DEFAULT_HINDSIGHT_URL = "http://hindsight:8888"
HINDSIGHT_STRATEGY = "notebooklm"
HINDSIGHT_RETAIN_STRATEGY = {"retain_extraction_mode": "chunks", "retain_chunk_size": 3000}
CHAT_HISTORY_LIMIT = 50
AUTH_RETRY_SECONDS = 900
DISABLED_SLEEP_SECONDS = 3600
ERROR_SLEEP_SECONDS = 300
LOGIN_INSTRUCTION = (
    "NotebookLM is not logged in. On the host re-run setup and enable NotebookLM "
    "(it opens Google sign-in and sets NOTEBOOKLM_HOME), or: "
    "mkdir -p ~/.config/notebooklm && uv tool install 'notebooklm-py[browser]==0.8.5' && "
    "uv tool run --from 'notebooklm-py[browser]==0.8.5' python -m playwright install chromium && "
    "NOTEBOOKLM_HOME=$HOME/.config/notebooklm notebooklm login. "
    "Then restart: docker compose --profile notebooklm up -d notebooklm"
)
ENTERPRISE_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
ENTERPRISE_LOCATIONS = ("global", "us", "eu")
ENTERPRISE_PAGE_MAX = 500
BANK_PREFIX_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
TOP_LEVEL_KEYS = {"enabled", "backend", "interval_minutes", "bank_prefix", "include_notebooks", "exclude_notebooks", "include", "client", "enterprise"}
INCLUDE_KEYS = {"notes", "sources", "chats"}
CLIENT_KEYS = {"storage_path"}
ENTERPRISE_KEYS = {"project_number", "location", "service_account_file", "notebook_limit"}

log = logging.getLogger("notebooklm-sync")


class ConfigError(ValueError):
    """The config file is missing, malformed, or fails validation."""


class AuthProblem(RuntimeError):
    """NotebookLM rejects or lacks the stored login."""


class HttpError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url} -> HTTP {status}: {body}")
        self.status = status


@dataclass(frozen=True)
class EnterpriseConfig:
    project_number: str
    location: str
    service_account_file: str
    notebook_limit: int


@dataclass(frozen=True)
class Config:
    enabled: bool
    backend: str
    interval_minutes: int
    bank_prefix: str
    include_notebooks: tuple[str, ...]
    exclude_notebooks: tuple[str, ...]
    notes: bool
    sources: bool
    chats: bool
    storage_path: str
    enterprise: EnterpriseConfig

    def selects(self, title: str) -> bool:
        lowered = title.lower()
        if any(fnmatch.fnmatchcase(lowered, pattern.lower()) for pattern in self.exclude_notebooks):
            return False
        return not self.include_notebooks or any(fnmatch.fnmatchcase(lowered, pattern.lower()) for pattern in self.include_notebooks)


@dataclass(frozen=True)
class Item:
    kind: str
    item_id: str
    title: str
    body: str
    url: str = ""


@dataclass(frozen=True)
class NotebookSnapshot:
    id: str
    title: str
    items: tuple[Item, ...]
    # False when a list call failed: the notebook's stored documents are left alone this run.
    complete: bool = True


@dataclass(frozen=True)
class FetchResult:
    snapshots: tuple[NotebookSnapshot, ...]
    # True when the listing covers every notebook, so a notebook missing from it has been deleted or deselected.
    listing_complete: bool


@dataclass
class SyncReport:
    retained: int = 0
    deleted: int = 0
    skipped: int = 0
    failed: int = 0

    def summary(self) -> str:
        return f"retained={self.retained} deleted={self.deleted} skipped={self.skipped} failed={self.failed}"


# ---------- configuration ----------


def _merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _read_yaml(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text())
    except OSError as error:
        raise ConfigError(f"cannot read {path}: {error}") from error
    except yaml.YAMLError as error:
        raise ConfigError(f"{path} is not valid YAML: {error}") from error
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must contain a mapping at the top level")
    return data


def _check_keys(section: str, data: dict, allowed: set[str]) -> None:
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ConfigError(f"{section}: unknown key(s) {', '.join(unknown)}; allowed: {', '.join(sorted(allowed))}")


def _bool(name: str, value) -> bool:
    if not isinstance(value, bool):
        raise ConfigError(f"{name} must be true or false, got {value!r}")
    return value


def _int(name: str, value, low: int, high: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{name} must be an integer, got {value!r}")
    if value < low or (high is not None and value > high):
        bound = f"{low}..{high}" if high is not None else f">= {low}"
        raise ConfigError(f"{name} must be {bound}, got {value}")
    return value


def _globs(name: str, value) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ConfigError(f"{name} must be a list of non-empty title globs")
    return tuple(value)


def validate_config(raw: dict) -> Config:
    _check_keys("config", raw, TOP_LEVEL_KEYS)
    enabled = _bool("enabled", raw.get("enabled", False))
    backend = raw.get("backend", "client")
    if backend not in ("client", "enterprise"):
        raise ConfigError(f"backend must be 'client' or 'enterprise', got {backend!r}")
    interval = _int("interval_minutes", raw.get("interval_minutes", 60), 1)
    prefix = raw.get("bank_prefix", "notebooklm")
    if not isinstance(prefix, str) or not BANK_PREFIX_PATTERN.match(prefix):
        raise ConfigError(f"bank_prefix must match {BANK_PREFIX_PATTERN.pattern}, got {prefix!r}")
    include_notebooks = _globs("include_notebooks", raw.get("include_notebooks", []))
    exclude_notebooks = _globs("exclude_notebooks", raw.get("exclude_notebooks", []))

    include = raw.get("include", {})
    if not isinstance(include, dict):
        raise ConfigError("include must be a mapping of notes/sources/chats to true or false")
    _check_keys("include", include, INCLUDE_KEYS)
    flags = {key: _bool(f"include.{key}", include.get(key, default)) for key, default in (("notes", True), ("sources", True), ("chats", False))}

    client = raw.get("client", {})
    if not isinstance(client, dict):
        raise ConfigError("client must be a mapping")
    _check_keys("client", client, CLIENT_KEYS)
    storage_path = client.get("storage_path", "") or ""
    if not isinstance(storage_path, str):
        raise ConfigError("client.storage_path must be a path string")

    ent = raw.get("enterprise", {})
    if not isinstance(ent, dict):
        raise ConfigError("enterprise must be a mapping")
    _check_keys("enterprise", ent, ENTERPRISE_KEYS)
    project = str(ent.get("project_number", "") or "")
    location = ent.get("location", "global")
    if location not in ENTERPRISE_LOCATIONS:
        raise ConfigError(f"enterprise.location must be one of {', '.join(ENTERPRISE_LOCATIONS)}, got {location!r}")
    sa_file = ent.get("service_account_file", "") or ""
    if not isinstance(sa_file, str):
        raise ConfigError("enterprise.service_account_file must be a path string")
    limit = _int("enterprise.notebook_limit", ent.get("notebook_limit", ENTERPRISE_PAGE_MAX), 1, ENTERPRISE_PAGE_MAX)
    if project and not project.isdigit():
        raise ConfigError(f"enterprise.project_number must be the numeric project number, got {project!r}")
    if enabled and backend == "enterprise" and not project:
        raise ConfigError("enterprise.project_number is required when backend is enterprise")

    return Config(
        enabled=enabled,
        backend=backend,
        interval_minutes=interval,
        bank_prefix=prefix,
        include_notebooks=include_notebooks,
        exclude_notebooks=exclude_notebooks,
        notes=flags["notes"],
        sources=flags["sources"],
        chats=flags["chats"],
        storage_path=storage_path,
        enterprise=EnterpriseConfig(project, location, sa_file, limit),
    )


def load_config(default_path: Path = DEFAULT_CONFIG, override_path: Path = DEFAULT_OVERRIDE) -> Config:
    if not default_path.is_file():
        raise ConfigError(f"shipped config missing: {default_path}")
    raw = _read_yaml(default_path)
    if override_path.is_file():
        raw = _merge(raw, _read_yaml(override_path))
    return validate_config(raw)


# ---------- naming and IDs ----------


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80].strip("-")
    return slug or "untitled"


def assign_banks(notebooks: list[tuple[str, str]], prefix: str) -> dict[str, str]:
    """Map notebook ID to bank. Duplicate titles get the first 8 characters of their ID appended."""
    slugs = {nb_id: slugify(title) for nb_id, title in notebooks}
    counts: dict[str, int] = {}
    for slug in slugs.values():
        counts[slug] = counts.get(slug, 0) + 1
    banks = {}
    for nb_id, slug in slugs.items():
        name = slug if counts[slug] == 1 else f"{slug}-{slugify(nb_id)[:8]}"
        banks[nb_id] = f"{prefix}::{name}"
    return banks


def document_id(notebook_id: str, kind: str, item_id: str) -> str:
    return f"notebooklm:v1:{notebook_id}:{kind}:{item_id}"


def chat_item_id(question: str) -> str:
    return hashlib.sha256(question.encode()).hexdigest()[:16]


def build_documents(snapshot: NotebookSnapshot, bank: str) -> dict[str, dict]:
    documents = {}
    for item in snapshot.items:
        doc_id = document_id(snapshot.id, item.kind, item.item_id)
        content = f"# {item.title}\n\n{item.body}".rstrip() + "\n"
        context = f"NotebookLM notebook '{snapshot.title}', {item.kind}: '{item.title}'"
        metadata = {"source": "notebooklm", "notebook_id": snapshot.id, "notebook_title": snapshot.title, "kind": item.kind, "item_id": item.item_id, "url": item.url}
        digest = hashlib.sha256(json.dumps({"content": content, "context": context, "metadata": metadata}, sort_keys=True).encode()).hexdigest()
        documents[doc_id] = {"bank": bank, "notebook": snapshot.id, "content": content, "context": context, "metadata": metadata, "digest": digest}
    return documents


# ---------- state ----------


def load_state(path: Path) -> dict[str, dict]:
    """Return document ID -> {bank, notebook, digest}. A missing file is an empty state; a corrupt file is an error."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"state file {path} is corrupt ({error}); move it aside to rebuild") from error
    return data.get("documents", {})


def save_state(path: Path, documents: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"version": 1, "documents": documents}, indent=2, sort_keys=True))
    temp.replace(path)


# ---------- Hindsight HTTP ----------


class Hindsight:
    def __init__(self, base_url: str, timeout: float = 300):
        self.base = base_url.rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        url = self.base + path
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            raise HttpError(method, path, error.code, error.read().decode(errors="replace")[:300]) from error
        return json.loads(body) if body else {}

    @staticmethod
    def _bank_path(bank: str) -> str:
        return "/v1/default/banks/" + urllib.parse.quote(bank, safe="")

    def ensure_bank(self, bank: str) -> None:
        path = self._bank_path(bank)
        try:
            response = self._request("GET", path + "/config")
        except HttpError as error:
            if error.status != 404:
                raise
            self._request("PUT", path, {})
            response = self._request("GET", path + "/config")
        config = response.get("config", response)
        strategies = config.get("retain_strategies") or {}
        updates = {}
        if strategies.get(HINDSIGHT_STRATEGY) != HINDSIGHT_RETAIN_STRATEGY:
            updates["retain_strategies"] = {**strategies, HINDSIGHT_STRATEGY: HINDSIGHT_RETAIN_STRATEGY}
        if config.get("enable_auto_consolidation") is not False:
            updates["enable_auto_consolidation"] = False
        if updates:
            self._request("PATCH", path + "/config", {"updates": updates})

    def retain(self, bank: str, doc_id: str, document: dict) -> None:
        item = {
            "content": document["content"],
            "document_id": doc_id,
            "context": document["context"],
            "metadata": document["metadata"],
            "timestamp": "unset",
            "strategy": HINDSIGHT_STRATEGY,
        }
        self._request("POST", self._bank_path(bank) + "/memories", {"items": [item], "async": False})

    def delete(self, bank: str, doc_id: str) -> None:
        try:
            self._request("DELETE", self._bank_path(bank) + "/documents/" + urllib.parse.quote(doc_id, safe=""))
        except HttpError as error:
            if error.status != 404:  # 404: already gone. Treat as deleted.
                raise


# ---------- sync core ----------


def sync_snapshots(fetch: FetchResult, bank_prefix: str, hindsight: Hindsight, state: dict[str, dict], state_path: Path) -> SyncReport:
    """Retain changed documents, delete removed ones, and persist state after each successful write."""
    report = SyncReport()
    complete = [snap for snap in fetch.snapshots if snap.complete]
    banks = assign_banks([(snap.id, snap.title) for snap in fetch.snapshots], bank_prefix)
    ensured: set[str] = set()
    desired: dict[str, dict] = {}
    for snap in fetch.snapshots:
        if not snap.complete:
            report.skipped += 1
            log.warning("notebook %r: listing failed this run; keeping its stored documents", snap.title)
            continue
        desired.update(build_documents(snap, banks[snap.id]))

    for doc_id, document in desired.items():
        recorded = state.get(doc_id)
        if recorded and recorded["bank"] == document["bank"] and recorded["digest"] == document["digest"]:
            report.skipped += 1
            continue
        try:
            if document["bank"] not in ensured:
                hindsight.ensure_bank(document["bank"])
                ensured.add(document["bank"])
            hindsight.retain(document["bank"], doc_id, document)
        except HttpError as error:
            report.failed += 1
            log.error("retain failed for %s: %s", doc_id, error)
            continue
        report.retained += 1
        state[doc_id] = {"bank": document["bank"], "notebook": document["notebook"], "digest": document["digest"]}
        if recorded and recorded["bank"] != document["bank"]:
            _delete_remote(hindsight, doc_id, recorded["bank"], report)
        save_state(state_path, state)

    complete_ids = {snap.id for snap in complete}
    listed_ids = {snap.id for snap in fetch.snapshots}
    for doc_id, recorded in list(state.items()):
        if doc_id in desired:
            continue
        notebook = recorded["notebook"]
        if notebook in complete_ids or (fetch.listing_complete and notebook not in listed_ids):
            if _delete_remote(hindsight, doc_id, recorded["bank"], report):
                state.pop(doc_id, None)
            save_state(state_path, state)
    return report


def _delete_remote(hindsight: Hindsight, doc_id: str, bank: str, report: SyncReport) -> bool:
    """Delete a document from Hindsight only; the caller owns the state entry."""
    try:
        hindsight.delete(bank, doc_id)
    except HttpError as error:
        report.failed += 1
        log.error("delete failed for %s: %s", doc_id, error)
        return False
    report.deleted += 1
    return True


# ---------- client backend ----------


def refresh_client_auth() -> None:
    """Refresh stored cookies once before a run. A failed refresh is logged; the fetch then reports the real state."""
    try:
        result = subprocess.run(["notebooklm", "auth", "refresh", "--quiet"], capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as error:
        log.warning("notebooklm auth refresh did not run: %s", error)
        return
    if result.returncode != 0:
        log.warning("notebooklm auth refresh exited %d", result.returncode)


async def fetch_client(cfg: Config) -> FetchResult:
    from notebooklm import AuthError, NotebookLMClient, NotebookLMError

    snapshots = []
    try:
        async with NotebookLMClient.from_storage(path=cfg.storage_path or None) as client:
            notebooks = [nb for nb in await client.notebooks.list() if cfg.selects(nb.title)]
            for nb in notebooks:
                items: list[Item] = []
                complete = True
                try:
                    if cfg.notes:
                        for note in await client.notes.list(nb.id):
                            items.append(Item("note", note.id, note.title or "Untitled note", note.content or ""))
                    if cfg.sources:
                        for source in await client.sources.list(nb.id):
                            items.append(await _client_source_item(client, nb.id, source, AuthError, NotebookLMError))
                    if cfg.chats:
                        for question, answer in await client.chat.get_history(nb.id, limit=CHAT_HISTORY_LIMIT):
                            items.append(Item("chat", chat_item_id(question), question[:120], answer, ""))
                except AuthError:
                    raise
                except NotebookLMError as error:
                    complete = False
                    log.error("notebook %r: %s", nb.title, error)
                title = nb.title or "Untitled notebook"
                if complete and not items:
                    # ensure_bank runs only when retaining documents; empty notebooks never appear as banks.
                    log.info("notebook %r (%s): nothing to sync (no notes/sources/chats); skipping bank", title, nb.id)
                snapshots.append(NotebookSnapshot(nb.id, title, tuple(items), complete))
    except FileNotFoundError as error:
        raise AuthProblem(f"{error}\n{LOGIN_INSTRUCTION}") from error
    except AuthError as error:
        raise AuthProblem(f"{error}\n{LOGIN_INSTRUCTION}") from error
    return FetchResult(tuple(snapshots), listing_complete=True)


async def _client_source_item(client, notebook_id: str, source, auth_error: type, base_error: type) -> Item:
    text = ""
    summary = ""
    try:
        text = (await client.sources.get_fulltext(notebook_id, source.id, output_format="markdown")).content or ""
    except auth_error:
        raise
    except base_error as error:
        log.warning("source %r: no full text (%s)", source.title, error.__class__.__name__)
    try:
        summary = (await client.sources.get_guide(notebook_id, source.id)).summary or ""
    except auth_error:
        raise
    except base_error:
        pass
    parts = []
    if source.url:
        parts.append(f"URL: {source.url}")
    if summary:
        parts.append(f"## Guide summary\n\n{summary}")
    if text:
        parts.append(f"## Full text\n\n{text}")
    return Item("source", source.id, source.title or "Untitled source", "\n\n".join(parts), source.url or "")


def fetch_client_sync(cfg: Config) -> FetchResult:
    return asyncio.run(fetch_client(cfg))


# ---------- enterprise backend ----------


def fetch_enterprise(cfg: Config) -> FetchResult:
    """List recently viewed notebooks through the documented v1alpha REST method.

    The documented API has no sources or notes list, so each notebook yields one 'notebook' item.
    Response field names (notebooks, nextPageToken, name, title) follow the REST reference and are not verified against a live project.
    """
    import google.auth
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    ent = cfg.enterprise
    if ent.service_account_file:
        credentials = service_account.Credentials.from_service_account_file(ent.service_account_file, scopes=[ENTERPRISE_SCOPE])
    else:
        credentials, _ = google.auth.default(scopes=[ENTERPRISE_SCOPE])
    credentials.refresh(Request())
    base = f"https://{ent.location}-discoveryengine.googleapis.com/v1alpha/projects/{ent.project_number}/locations/{ent.location}"

    notebooks: list[dict] = []
    token = ""
    while True:
        query = {"pageSize": str(ent.notebook_limit)}
        if token:
            query["pageToken"] = token
        url = f"{base}/notebooks:listRecentlyViewed?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {credentials.token}"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                page = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise HttpError("GET", url.split("?")[0], error.code, error.read().decode(errors="replace")[:300]) from error
        notebooks.extend(page.get("notebooks", []))
        token = page.get("nextPageToken", "")
        if not token:
            break

    snapshots = []
    for entry in notebooks:
        notebook_id = str(entry.get("name", "")).rsplit("/", 1)[-1]
        if not notebook_id:
            continue
        title = entry.get("title") or "Untitled notebook"
        if not cfg.selects(title):
            continue
        body = f"Resource: {entry.get('name')}\n" + "".join(f"{key}: {entry[key]}\n" for key in ("createTime", "lastViewTime") if key in entry)
        snapshots.append(NotebookSnapshot(notebook_id, title, (Item("notebook", notebook_id, title, body),)))
    return FetchResult(tuple(snapshots), listing_complete=not token)


# ---------- entry points ----------


def run_cycle(cfg: Config, hindsight: Hindsight, state_path: Path) -> SyncReport:
    if cfg.backend == "client":
        refresh_client_auth()
        fetch = fetch_client_sync(cfg)
    else:
        fetch = fetch_enterprise(cfg)
    state = load_state(state_path)
    report = sync_snapshots(fetch, cfg.bank_prefix, hindsight, state, state_path)
    log.info("sync done: %d notebook(s); %s", len(fetch.snapshots), report.summary())
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--override", type=Path, default=DEFAULT_OVERRIDE)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--hindsight-url", default=os.environ.get("HINDSIGHT_URL", DEFAULT_HINDSIGHT_URL))
    parser.add_argument("--once", action="store_true", help="run one sync and exit")
    parser.add_argument("--check-config", action="store_true", help="validate config and exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.check_config:
        try:
            cfg = load_config(args.config, args.override)
        except ConfigError as error:
            print(f"config error: {error}", file=sys.stderr)
            return 2
        print(f"config ok: enabled={cfg.enabled} backend={cfg.backend} interval_minutes={cfg.interval_minutes}")
        return 0

    hindsight = Hindsight(args.hindsight_url)
    while True:
        try:
            cfg = load_config(args.config, args.override)
        except ConfigError as error:
            log.error("config error: %s; retrying in %ds", error, ERROR_SLEEP_SECONDS)
            if args.once:
                return 2
            time.sleep(ERROR_SLEEP_SECONDS)
            continue
        if not cfg.enabled:
            log.info("disabled: set enabled: true in %s and restart the service", args.override)
            if args.once:
                return 0
            time.sleep(DISABLED_SLEEP_SECONDS)
            continue
        try:
            run_cycle(cfg, hindsight, args.state)
            delay = cfg.interval_minutes * 60
        except AuthProblem as error:
            log.error("%s", error)
            if args.once:
                return 3
            delay = AUTH_RETRY_SECONDS
        except Exception:  # keep the loop alive; the next cycle retries
            log.exception("sync failed; retrying in %ds", ERROR_SLEEP_SECONDS)
            if args.once:
                return 1
            delay = ERROR_SLEEP_SECONDS
        if args.once:
            return 0
        time.sleep(delay)


if __name__ == "__main__":
    sys.exit(main())
