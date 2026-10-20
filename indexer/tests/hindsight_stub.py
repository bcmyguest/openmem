"""A Hindsight REST stub and a fixed indexing scenario, shared by the sink regression tests.

`run_scenario(script, root)` drives `bin/hindsight-project-index --apply` over a fixed repository and vault, twice
(initial retain, then a change that leaves one stale document per source), against a stub that behaves like
Hindsight: the bank config returns 404 until the bank is created, strategy PATCHes stick, and deleting a vault
document answers 404 (already gone). `normalize` replaces the path-dependent document ids with `<DOC:n>`, so the
recorded requests compare equal across runs and temp directories.

indexer/tests/fixtures/hindsight_requests_baseline.json was captured by running the script as it was before the
sink refactor, so a passing comparison means the refactor kept the wire behavior byte for byte.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from stub_server import RecordingStub, serving


DOC_ID = re.compile(r"(?:project-index|obsidian-index)(?::|%3A)v1(?::|%3A)[0-9a-f]{32}")
BANK_CONFIG = re.compile(r"^/v1/default/banks/([^/]+)/config$")
BANK = re.compile(r"^/v1/default/banks/([^/]+)$")
DOCUMENT = re.compile(r"^/v1/default/banks/([^/]+)/documents/[^/]+$")


def hindsight_route():
    """A stateful route function emulating the Hindsight endpoints the indexer uses."""
    banks: dict[str, dict] = {}

    def route(method: str, path: str, body):
        if path == "/health" and method == "GET":
            return 200, {"status": "healthy"}
        if match := BANK_CONFIG.match(path):
            bank = match.group(1)
            if method == "GET":
                return (200, {"config": banks[bank]}) if bank in banks else (404, {"detail": "bank not found"})
            if method == "PATCH":
                banks[bank].update(body["updates"])
                return 200, {"config": banks[bank]}
        if match := BANK.match(path):
            if method == "PUT":
                banks.setdefault(match.group(1), {})
                return 200, {}
        if re.match(r"^/v1/default/banks/[^/]+/memories$", path) and method == "POST":
            return 200, {"success": True}
        if match := DOCUMENT.match(path):
            if method == "DELETE":
                # The vault bank's documents are "already gone" on the server.
                return (404, {"detail": "Document not found"}) if "obsidian" in match.group(1) else (200, {})
        return 500, {"detail": f"unexpected {method} {path}"}

    return route


def build_fixture(root: Path) -> tuple[Path, Path]:
    repo = root / "work" / "proj"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / "README.md").write_text("# Proj\n\nFirst version of the readme.\n")
    (repo / "app.py").write_text("def handler(event):\n    return event\n")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    vault = root / "notes" / "My Vault"
    vault.mkdir(parents=True)
    (vault / "plan.md").write_text("---\ntags: [work, infra]\n---\n# Plan\n\nShip it with #ops and [[Roadmap]].\n")
    return repo, vault


def mutate_fixture(repo: Path, vault: Path) -> None:
    (repo / "README.md").write_text("# Proj\n\nSecond version of the readme.\n")
    subprocess.run(["git", "rm", "-q", "-f", "app.py"], cwd=repo, check=True)
    (vault / "plan.md").unlink()
    (vault / "other.md").write_text("# Other\n\nA different note.\n")


def run_script(script: Path, args: list[str], env_extra: dict[str, str], home: Path, python: str = sys.executable) -> subprocess.CompletedProcess:
    indexer_dir = Path(__file__).resolve().parents[1]
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "PYTHONPATH": str(indexer_dir),
        "PYTHONNOUSERSITE": "1",
        **env_extra,
    }
    if "TREE_SITTER_GRAMMAR_DIR" in os.environ:
        env["TREE_SITTER_GRAMMAR_DIR"] = os.environ["TREE_SITTER_GRAMMAR_DIR"]
    return subprocess.run([python, str(script), *args], env=env, capture_output=True, text=True, check=False)


def scenario_args(repo: Path, vault: Path, state: Path) -> list[str]:
    return ["--apply", "--state", str(state), "--repo", str(repo), "--vault", str(vault)]


def normalize(requests: list[dict]) -> list[dict]:
    ids: dict[str, str] = {}

    def swap(match: re.Match) -> str:
        found = match.group(0)
        canonical = found.replace("%3A", ":")
        label = ids.setdefault(canonical, f"<DOC:{len(ids) + 1}>")
        return label

    text = DOC_ID.sub(swap, json.dumps(requests, sort_keys=True))
    return json.loads(text)


def run_scenario(script: Path, root: Path, python: str = sys.executable, extra_env: dict[str, str] | None = None, extra_args: list[str] | None = None) -> tuple[list[dict], list[subprocess.CompletedProcess]]:
    """Run the two-pass scenario; return the normalized requests and both process results."""
    home = root / "home"
    home.mkdir()
    repo, vault = build_fixture(root)
    state = root / "state" / "state.json"
    results = []
    with serving(hindsight_route()) as stub:
        stub: RecordingStub
        env = {"HINDSIGHT_URL": stub.url, **(extra_env or {})}
        args = scenario_args(repo, vault, state) + (extra_args or [])
        results.append(run_script(script, args, env, home, python))
        mutate_fixture(repo, vault)
        results.append(run_script(script, args, env, home, python))
        requests = list(stub.requests)
    return normalize(requests), results
