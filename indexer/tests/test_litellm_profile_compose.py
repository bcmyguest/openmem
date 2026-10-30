"""The `litellm` compose profile: Hindsight renders as before, mem0 gets LiteLLM on loopback behind a master key.

`docker compose config` only (nothing starts, nothing is pulled), scratch env files, project `pm-test-litellm-profile`.
The key-check entrypoint is run with the local /bin/sh, not in a container. Skipped without Docker Compose v2.24+.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from compose_support import COMPOSE_OK, ROOT, render

pytestmark = pytest.mark.skipif(not COMPOSE_OK, reason="needs docker compose v2.24+")

PROJECT = "pm-test-litellm-profile"
MEM0_FILES = ("compose.yaml", "providers/mem0/compose.yaml")
HINDSIGHT_SERVICES = {"hindsight", "litellm", "indexer", "indexer-state-init"}
LITELLM_PROFILES_LINE = '    profiles: ["hindsight", "notebooklm", "litellm"]\n'
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")


@pytest.fixture
def scratch(tmp_path):
    (tmp_path / "litellm.yaml").write_text("model_list: []\n")
    (tmp_path / "litellm.env").write_text("LITELLM_MASTER_KEY=sk-scratch-not-a-key\n")
    (tmp_path / "hindsight.env").write_text("")
    env = tmp_path / "scratch.env"
    env.write_text(
        f"HOST_UID=1000\nHOST_GID=1000\nMEM0_INDEXER_URL=http://host.docker.internal:18888\n"
        f"MEM0_ENV_FILE={tmp_path}/absent-mem0.env\nLITELLM_CONFIG={tmp_path}/litellm.yaml\n"
        f"LITELLM_ENV_FILE={tmp_path}/litellm.env\nHINDSIGHT_ENV_FILE={tmp_path}/hindsight.env\n"
        f"HINDSIGHT_PORT=18888\nHINDSIGHT_CP_PORT=19999\n"
    )
    return env


def without_litellm_profile(rendered: dict) -> dict:
    """The rendered config with litellm's profile list removed (the only intended Hindsight-side difference)."""
    rendered = json.loads(json.dumps(rendered))
    rendered["services"]["litellm"].pop("profiles", None)
    return rendered


def test_litellm_carries_its_own_profile_next_to_hindsight_and_notebooklm(scratch):
    profiles = render(scratch, PROJECT, "--profile", "litellm")["services"]["litellm"]["profiles"]
    assert profiles == ["hindsight", "notebooklm", "litellm"]


@pytest.mark.parametrize("args", [("--profile", "hindsight"), ("--profile", "notebooklm"), ("--profile", "hindsight", "--profile", "ollama")])
def test_hindsight_render_is_identical_to_the_compose_file_without_the_new_profile(scratch, tmp_path, args):
    # Same file with the "litellm" profile taken out = the pre-change compose.yaml for every Hindsight-side profile.
    source = (ROOT / "compose.yaml").read_text()
    assert source.count(LITELLM_PROFILES_LINE) == 1
    before = tmp_path / "compose.before.yaml"
    before.write_text(source.replace(LITELLM_PROFILES_LINE, '    profiles: ["hindsight", "notebooklm"]\n'))
    now = render(scratch, PROJECT, *args)
    old = render(scratch, PROJECT, "--project-directory", str(ROOT), *args, files=(str(before),))
    assert without_litellm_profile(now) == without_litellm_profile(old)


def test_hindsight_keeps_litellm_internal(scratch):
    rendered = render(scratch, PROJECT, "--profile", "hindsight")
    assert set(rendered["services"]) == HINDSIGHT_SERVICES
    litellm = rendered["services"]["litellm"]
    assert "ports" not in litellm
    assert litellm.get("entrypoint") is None
    assert rendered["services"]["hindsight"]["depends_on"]["litellm"]["condition"] == "service_healthy"


def test_litellm_profile_alone_starts_only_litellm_and_the_neutral_indexer(scratch):
    rendered = render(scratch, PROJECT, "--profile", "litellm")
    assert set(rendered["services"]) == {"litellm", "indexer", "indexer-state-init"}
    assert "ports" not in rendered["services"]["litellm"]


def mem0_litellm(scratch: Path, **env: str) -> dict:
    return render(scratch, PROJECT, "--profile", "mem0", "--profile", "litellm", files=MEM0_FILES, env=env or None)


def test_mem0_with_litellm_publishes_on_loopback_only(scratch):
    rendered = mem0_litellm(scratch)
    assert set(rendered["services"]) == {"litellm", "indexer", "indexer-state-init"}
    ports = rendered["services"]["litellm"]["ports"]
    assert [(p["host_ip"], p["published"], p["target"]) for p in ports] == [("127.0.0.1", "4000", 4000)]


def test_mem0_litellm_port_is_configurable(scratch):
    ports = mem0_litellm(scratch, MEM0_LITELLM_PORT="4123")["services"]["litellm"]["ports"]
    assert [(p["host_ip"], p["published"]) for p in ports] == [("127.0.0.1", "4123")]


def test_mem0_litellm_reads_the_master_key_file_and_keeps_its_command(scratch):
    litellm = mem0_litellm(scratch)["services"]["litellm"]
    assert litellm["environment"]["LITELLM_MASTER_KEY"] == "sk-scratch-not-a-key"
    assert litellm["command"] == ["--config", "/app/config.yaml", "--port", "4000"]
    assert litellm["entrypoint"][:2] == ["/bin/sh", "-c"] and litellm["entrypoint"][3] == "litellm"


def test_mem0_without_litellm_profile_does_not_start_it(scratch):
    rendered = render(scratch, PROJECT, "--profile", "mem0", files=MEM0_FILES)
    assert "litellm" not in rendered["services"]


def run_entrypoint(scratch: Path, key: str | None) -> subprocess.CompletedProcess:
    """Run the rendered entrypoint script with /bin/sh in an empty dir, so `exec docker/prod_entrypoint.sh` fails."""
    # `config` keeps the $$ escapes so its output stays valid compose; compose passes a single $ to the container.
    entrypoint = [part.replace("$$", "$") for part in mem0_litellm(scratch)["services"]["litellm"]["entrypoint"]]
    env = {"PATH": "/usr/bin:/bin"}
    if key is not None:
        env["LITELLM_MASTER_KEY"] = key
    return subprocess.run([*entrypoint, "--config", "/app/config.yaml"], cwd=scratch.parent, env=env, capture_output=True, text=True)


@pytest.mark.parametrize("key", [None, "", "not-sk-prefixed", "sk-"])
def test_entrypoint_refuses_to_start_without_an_sk_master_key(scratch, key):
    result = run_entrypoint(scratch, key)
    assert result.returncode == 1
    assert "LITELLM_MASTER_KEY=sk-... is missing" in result.stderr


def test_entrypoint_hands_over_to_the_image_entrypoint_with_a_key(scratch):
    result = run_entrypoint(scratch, "sk-scratch-not-a-key")
    # The image script is absent here, so exec fails with "not found" (127): the check itself passed.
    assert result.returncode == 127
    assert "missing" not in result.stderr


def run_setup(stack: Path, home: Path, **extra: str) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("PM_", "MEM0_", "LITELLM_", "MEMORY_"))}
    env.update({"HOME": str(home), "PM_STACK_ROOT": str(stack), "MEMORY_PROVIDER": "mem0", **extra})
    return subprocess.run(["node", "scripts/setup.mjs"], cwd=ROOT, env=env, capture_output=True, text=True)


@needs_node
def test_setup_mjs_with_the_option_writes_an_env_that_renders_litellm_on_loopback(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    routes = home / ".config" / "personal-memory" / "mem0-litellm.yaml"
    routes.parent.mkdir(parents=True)
    routes.write_text("model_list: []\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n")
    result = run_setup(stack, home, MEM0_API_URL="http://127.0.0.1:18888", MEM0_LITELLM="1", MEM0_LITELLM_PORT="4077")
    assert result.returncode == 0, result.stderr
    values = dict(line.split("=", 1) for line in (stack / ".env").read_text().splitlines() if line)
    assert values["COMPOSE_PROFILES"] == "mem0,litellm"
    assert values["LITELLM_CONFIG"] == str(routes)
    assert values["MEM0_LITELLM_PORT"] == "4077"
    assert "LITELLM_MASTER_KEY" not in (stack / ".env").read_text()

    litellm_env = home / ".config" / "hindsight" / "litellm.env"
    assert litellm_env.stat().st_mode & 0o777 == 0o600
    assert any(line.startswith("LITELLM_MASTER_KEY=sk-") for line in litellm_env.read_text().splitlines())

    # The .env alone (COMPOSE_PROFILES, no --profile flag) renders litellm on the chosen loopback port.
    rendered = render(stack / ".env", PROJECT, files=MEM0_FILES, env={"MEM0_ENV_FILE": str(tmp_path / "absent.env")})
    assert set(rendered["services"]) == {"litellm", "indexer", "indexer-state-init"}
    ports = rendered["services"]["litellm"]["ports"]
    assert [(p["host_ip"], p["published"]) for p in ports] == [("127.0.0.1", "4077")]

    # Turning the option off returns to COMPOSE_PROFILES=mem0 and no litellm service.
    result = run_setup(stack, home, MEM0_API_URL="http://127.0.0.1:18888")
    assert result.returncode == 0, result.stderr
    assert dict(line.split("=", 1) for line in (stack / ".env").read_text().splitlines() if line)["COMPOSE_PROFILES"] == "mem0"
    rendered = render(stack / ".env", PROJECT, files=MEM0_FILES, env={"MEM0_ENV_FILE": str(tmp_path / "absent.env")})
    assert "litellm" not in rendered["services"]


@needs_node
def test_setup_mjs_refuses_the_option_without_the_route_file(tmp_path):
    result = run_setup(tmp_path / "stack", tmp_path / "home", MEM0_API_URL="http://127.0.0.1:18888", MEM0_LITELLM="1")
    assert result.returncode == 1
    assert "mem0-litellm.yaml is missing" in result.stderr
