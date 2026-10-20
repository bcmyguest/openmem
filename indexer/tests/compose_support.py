"""Shared helpers for provider compose-fragment tests: `docker compose config` only, nothing starts or is pulled.

Provider tests (mem0, Cognee) render the layered files with a scratch env file and their own project name, so a
running stack is never touched. `test_compose_profiles.py` keeps its own copy of these helpers on purpose: the
Hindsight profile tests stay byte-identical.
"""

import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def compose_version() -> tuple[int, ...] | None:
    try:
        out = subprocess.run(["docker", "compose", "version", "--short"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.match(r"v?(\d+)\.(\d+)", out.strip())
    return tuple(int(part) for part in match.groups()) if match else None


VERSION = compose_version()
COMPOSE_OK = VERSION is not None and VERSION >= (2, 24)


def render(
    env_file: Path,
    project: str,
    *args: str,
    files: tuple[str, ...] = ("compose.yaml",),
    env: dict[str, str] | None = None,
) -> dict:
    """`docker compose -p <project> --env-file <env_file> -f ... <args> config --format json`, parsed.

    `env` adds process variables (they beat the env file). COMPOSE_PROFILES is always removed from the inherited
    environment so a profile in the operator's shell cannot change the result.
    """
    command = ["docker", "compose", "-p", project, "--env-file", str(env_file)]
    for file in files:
        command += ["-f", file]
    process_env = {key: value for key, value in os.environ.items() if key != "COMPOSE_PROFILES"}
    process_env.update(env or {})
    out = subprocess.run([*command, *args, "config", "--format", "json"], cwd=ROOT, env=process_env, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def service_names(*args, **kwargs) -> set[str]:
    return set(render(*args, **kwargs)["services"])
