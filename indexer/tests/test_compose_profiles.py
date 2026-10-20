"""Compose profile design: provider-neutral indexer, Hindsight under its profile, fragments layered per provider.

Runs `docker compose config` only (nothing starts, nothing is pulled) with a scratch env file and project name, so it
never touches a running stack. Skipped when Docker Compose v2.24+ is unavailable.
"""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
PROJECT = "pm-test-sink-compose"
HINDSIGHT_SERVICES = {"hindsight", "litellm", "indexer", "indexer-state-init"}


def compose_version() -> tuple[int, ...] | None:
    try:
        out = subprocess.run(["docker", "compose", "version", "--short"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.match(r"v?(\d+)\.(\d+)", out.strip())
    return tuple(int(part) for part in match.groups()) if match else None


VERSION = compose_version()
pytestmark = pytest.mark.skipif(VERSION is None or VERSION < (2, 24), reason="needs docker compose v2.24+")


@pytest.fixture(scope="module")
def scratch(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("compose")
    (tmp / "litellm.yaml").write_text("model_list: []\n")
    (tmp / "litellm.env").write_text("")
    (tmp / "hindsight.env").write_text("")
    env = tmp / "scratch.env"
    env.write_text(
        f"HOST_UID=1000\nHOST_GID=1000\nLITELLM_CONFIG={tmp}/litellm.yaml\nLITELLM_ENV_FILE={tmp}/litellm.env\n"
        f"HINDSIGHT_ENV_FILE={tmp}/hindsight.env\nHINDSIGHT_PORT=18888\nHINDSIGHT_CP_PORT=19999\n"
    )
    return env


def render(scratch: Path, *args: str, files: tuple[str, ...] = ("compose.yaml",), profiles_env: str | None = None) -> dict:
    command = ["docker", "compose", "-p", PROJECT, "--env-file", str(scratch)]
    for file in files:
        command += ["-f", file]
    env = {key: value for key, value in os.environ.items() if key != "COMPOSE_PROFILES"}
    if profiles_env is not None:
        env["COMPOSE_PROFILES"] = profiles_env
    out = subprocess.run([*command, *args, "config", "--format", "json"], cwd=ROOT, env=env, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def services(*args, **kwargs) -> set[str]:
    return set(render(*args, **kwargs)["services"])


def test_explicit_hindsight_profile_gives_the_pre_change_service_set(scratch):
    assert services(scratch, "--profile", "hindsight") == HINDSIGHT_SERVICES


def test_compose_profiles_env_gives_the_same_set_for_plain_up(scratch):
    assert services(scratch, profiles_env="hindsight") == HINDSIGHT_SERVICES


def test_no_profile_starts_only_the_provider_neutral_indexer(scratch):
    assert services(scratch) == {"indexer", "indexer-state-init"}


def test_notebooklm_profile_still_brings_the_hindsight_stack(scratch):
    assert services(scratch, "--profile", "notebooklm") == HINDSIGHT_SERVICES | {"notebooklm"}
    assert services(scratch, "--profile", "notebooklm", profiles_env="hindsight") == HINDSIGHT_SERVICES | {"notebooklm"}


def test_only_hindsight_services_are_profiled_and_the_indexer_is_neutral(scratch):
    everything = render(scratch, "--profile", "hindsight", "--profile", "notebooklm")["services"]
    assert "hindsight" in everything["hindsight"]["profiles"] and "hindsight" in everything["litellm"]["profiles"]
    assert "profiles" not in everything["indexer"]
    assert "profiles" not in everything["indexer-state-init"]
    depends = everything["indexer"]["depends_on"]
    assert depends["hindsight"]["required"] is False
    assert depends["indexer-state-init"]["required"] is True
    assert everything["indexer"]["image"] == "personal-memory-indexer:local"
    assert everything["indexer"]["environment"]["HINDSIGHT_URL"] == "http://hindsight:8888"


def test_bench_overlay_still_renders_with_the_hindsight_profile(scratch):
    rendered = render(scratch, "--profile", "hindsight", files=("compose.yaml", "compose.bench.yaml"))
    ports = [(port["host_ip"], port["published"]) for port in rendered["services"]["hindsight"]["ports"]]
    assert ("172.17.0.1", "18888") in ports and ("127.0.0.1", "18888") in ports


def test_template_fragment_replaces_hindsight_for_its_provider(scratch):
    files = ("compose.yaml", "providers/_template/compose.yaml")
    rendered = render(scratch, "--profile", "example", files=files)
    assert set(rendered["services"]) == {"example", "indexer", "indexer-state-init"}
    indexer = rendered["services"]["indexer"]
    assert indexer["environment"]["MEMORY_SINK"] == "example"
    assert indexer["environment"]["MEMORY_API_URL"] == "http://example:8080"
    assert indexer["depends_on"]["example"]["condition"] == "service_healthy"
    assert indexer["depends_on"]["example"]["required"] is True
    assert "example-data" in rendered["volumes"] or any(name.endswith("example-data") for name in rendered["volumes"])


def test_fragment_without_its_profile_fails_loudly(scratch):
    with pytest.raises(subprocess.CalledProcessError):
        render(scratch, files=("compose.yaml", "providers/_template/compose.yaml"))


def test_template_is_valid_yaml_with_a_single_provider_profile():
    data = yaml.safe_load((ROOT / "providers" / "_template" / "compose.yaml").read_text())
    assert data["services"]["example"]["profiles"] == ["example"]
    assert set(data["services"]) == {"example", "indexer"}
