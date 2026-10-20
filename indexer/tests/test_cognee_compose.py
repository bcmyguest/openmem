"""Cognee compose fragment: layered over compose.yaml under `--profile cognee`, plus the real scripts/setup.mjs run.

Runs `docker compose config` only (nothing starts, nothing is pulled) with scratch env files, a scratch HOME and the
project name pm-test-cognee-compose, so it never touches a running stack or the operator's files. Skipped when Docker
Compose v2.24+ is unavailable.
"""

import os
import shutil
import subprocess

import pytest
import yaml
from compose_support import COMPOSE_OK, ROOT, render

PROJECT = "pm-test-cognee-compose"
FRAGMENT = "providers/cognee/compose.yaml"
FILES = ("compose.yaml", FRAGMENT)
COGNEE_SERVICES = {"cognee", "indexer", "indexer-state-init"}
HINDSIGHT_SERVICES = {"hindsight", "litellm", "indexer", "indexer-state-init"}
IMAGE_PREFIX = "cognee/cognee@sha256:"
LLM_SECRET = "sk-test-llm-secret-value"
INDEXER_SECRET = "cogkey-test-indexer-secret"

pytestmark = pytest.mark.skipif(not COMPOSE_OK, reason="needs docker compose v2.24+")


@pytest.fixture(scope="module")
def scratch(tmp_path_factory):
    """Scratch env file, a HOME that holds no real files, and env files with fake secrets."""
    tmp = tmp_path_factory.mktemp("cognee")
    home = tmp / "home"
    home.mkdir()
    (tmp / "litellm.yaml").write_text("model_list: []\n")
    (tmp / "litellm.env").write_text("")
    (tmp / "hindsight.env").write_text("")
    (tmp / "cognee.env").write_text(f"LLM_API_KEY={LLM_SECRET}\n")
    (tmp / "cognee-indexer.env").write_text(f"COGNEE_API_KEY={INDEXER_SECRET}\n")
    env_file = tmp / "scratch.env"
    env_file.write_text(
        f"HOST_UID=1000\nHOST_GID=1000\nCOGNEE_PORT=18766\nLITELLM_CONFIG={tmp}/litellm.yaml\n"
        f"LITELLM_ENV_FILE={tmp}/litellm.env\nHINDSIGHT_ENV_FILE={tmp}/hindsight.env\n"
        f"COGNEE_ENV_FILE={tmp}/cognee.env\nCOGNEE_INDEXER_ENV_FILE={tmp}/cognee-indexer.env\n"
    )
    return {"env_file": env_file, "home": home, "tmp": tmp}


def cognee(scratch, *args, files=FILES, env_file=None, env=None) -> dict:
    process_env = {"HOME": str(scratch["home"]), **(env or {})}
    return render(env_file or scratch["env_file"], PROJECT, *args, files=files, env=process_env)


def test_cognee_profile_renders_exactly_the_cognee_service_set(scratch):
    assert set(cognee(scratch, "--profile", "cognee")["services"]) == COGNEE_SERVICES


def test_hindsight_profile_set_is_untouched(scratch):
    rendered = render(
        scratch["env_file"], PROJECT, "--profile", "hindsight", env={"HOME": str(scratch["home"])}
    )
    assert set(rendered["services"]) == HINDSIGHT_SERVICES


def test_image_is_pinned_by_digest_and_nothing_says_placeholder(scratch):
    rendered = cognee(scratch, "--profile", "cognee")
    assert rendered["services"]["cognee"]["image"].startswith(IMAGE_PREFIX)
    assert "placeholder" not in str(rendered).lower()
    for path in (ROOT / "providers" / "cognee").rglob("*"):
        if path.is_file():
            assert "placeholder" not in path.read_text().lower(), path


def test_port_is_published_on_loopback_only_and_targets_8000(scratch):
    ports = cognee(scratch, "--profile", "cognee")["services"]["cognee"]["ports"]
    assert [(p["host_ip"], p["published"], p["target"]) for p in ports] == [("127.0.0.1", "18766", 8000)]


def test_default_port_is_8766_when_the_stack_env_has_none(scratch):
    env_file = scratch["tmp"] / "no-port.env"
    env_file.write_text("HOST_UID=1000\nHOST_GID=1000\nLITELLM_CONFIG=/nowhere/litellm.yaml\n")
    ports = cognee(scratch, "--profile", "cognee", env_file=env_file)["services"]["cognee"]["ports"]
    assert [(p["host_ip"], p["published"]) for p in ports] == [("127.0.0.1", "8766")]


def test_healthcheck_targets_the_health_route(scratch):
    check = cognee(scratch, "--profile", "cognee")["services"]["cognee"]["healthcheck"]
    assert check["test"][:2] == ["CMD", "python3"]
    assert "http://127.0.0.1:8000/health" in check["test"][-1]
    assert check["retries"] == 10


def test_single_user_mode_and_data_paths(scratch):
    service = cognee(scratch, "--profile", "cognee")["services"]["cognee"]
    assert service["environment"]["ENABLE_BACKEND_ACCESS_CONTROL"] == "false"
    # The image defaults both root directories under /cognee-storage, owned by its uid 1000; do not override them.
    assert "DATA_ROOT_DIRECTORY" not in service["environment"]
    assert "SYSTEM_ROOT_DIRECTORY" not in service["environment"]
    assert [(v["type"], v["target"]) for v in service["volumes"]] == [("volume", "/cognee-storage")]
    assert service["volumes"][0]["source"] == "cognee-data"
    assert service["extra_hosts"] == ["host.docker.internal=host-gateway"]
    assert service["stop_grace_period"] == "15s"


def test_data_volume_is_declared(scratch):
    assert "cognee-data" in cognee(scratch, "--profile", "cognee")["volumes"]


def test_indexer_is_wired_to_cognee_with_a_hard_healthy_dependency(scratch):
    indexer = cognee(scratch, "--profile", "cognee")["services"]["indexer"]
    assert indexer["environment"]["MEMORY_SINK"] == "cognee"
    assert indexer["environment"]["MEMORY_API_URL"] == "http://cognee:8000"
    assert indexer["depends_on"]["cognee"] == {"condition": "service_healthy", "required": True}
    assert indexer["image"] == "personal-memory-indexer:local"


def test_llm_key_reaches_cognee_only_and_the_indexer_gets_only_its_own_key(scratch):
    services = cognee(scratch, "--profile", "cognee")["services"]
    assert services["cognee"]["environment"]["LLM_API_KEY"] == LLM_SECRET
    assert "COGNEE_API_KEY" not in services["cognee"]["environment"]
    indexer_env = services["indexer"]["environment"]
    assert "LLM_API_KEY" not in indexer_env
    assert indexer_env["COGNEE_API_KEY"] == INDEXER_SECRET
    assert LLM_SECRET not in str(services["indexer"])


def test_missing_env_files_render_fine(scratch):
    env_file = scratch["tmp"] / "absent.env"
    env_file.write_text(
        "HOST_UID=1000\nHOST_GID=1000\nLITELLM_CONFIG=/nowhere/litellm.yaml\n"
        f"COGNEE_ENV_FILE={scratch['tmp']}/absent-cognee.env\n"
        f"COGNEE_INDEXER_ENV_FILE={scratch['tmp']}/absent-cognee-indexer.env\n"
    )
    services = cognee(scratch, "--profile", "cognee", env_file=env_file)["services"]
    assert set(services) == COGNEE_SERVICES
    assert "LLM_API_KEY" not in services["cognee"]["environment"]


def test_default_env_file_locations_follow_home(scratch):
    """With no COGNEE_*_ENV_FILE set, the files are read from <HOME>/.config/personal-memory/."""
    home = scratch["tmp"] / "home-with-files"
    (home / ".config" / "personal-memory").mkdir(parents=True)
    (home / ".config" / "personal-memory" / "cognee.env").write_text("LLM_MODEL=from-default-location\n")
    env_file = scratch["tmp"] / "defaults.env"
    env_file.write_text("HOST_UID=1000\nHOST_GID=1000\nLITELLM_CONFIG=/nowhere/litellm.yaml\n")
    rendered = render(env_file, PROJECT, "--profile", "cognee", files=FILES, env={"HOME": str(home)})
    assert rendered["services"]["cognee"]["environment"]["LLM_MODEL"] == "from-default-location"


def test_fragment_without_its_profile_fails_loudly(scratch):
    with pytest.raises(subprocess.CalledProcessError):
        cognee(scratch)


def test_fragment_is_valid_yaml_with_a_single_provider_profile():
    data = yaml.safe_load((ROOT / FRAGMENT).read_text())
    assert data["services"]["cognee"]["profiles"] == ["cognee"]
    assert set(data["services"]) == {"cognee", "indexer"}


# --- the real scripts/setup.mjs, end to end -----------------------------------------------------------------------


def run_setup(stack, home, extra_env=None):
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("COGNEE_", "MEMORY_", "PM_", "LITELLM_", "HINDSIGHT_"))
    }
    env.update({"HOME": str(home), "PM_STACK_ROOT": str(stack), "MEMORY_PROVIDER": "cognee"})
    env.update(extra_env or {})
    return subprocess.run(
        ["node", str(ROOT / "scripts" / "setup.mjs")], cwd=ROOT, env=env, capture_output=True, text=True, check=True
    )


def read_env(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line)


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_writes_an_env_that_renders_with_no_manual_variables(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    home.mkdir()
    result = run_setup(stack, home)

    written = read_env(stack / ".env")
    assert set(written) == {"HOST_UID", "HOST_GID", "COGNEE_PORT", "COMPOSE_PROFILES", "LITELLM_CONFIG"}
    assert written["COGNEE_PORT"] == "8766"
    assert written["COMPOSE_PROFILES"] == "cognee"
    assert written["LITELLM_CONFIG"] == str(ROOT / "config" / "litellm.lemond.yaml")
    assert (stack / ".env").stat().st_mode & 0o777 == 0o644
    text = (stack / ".env").read_text()
    for forbidden in ("LLM_API_KEY", "COGNEE_API_KEY", "sk-"):
        assert forbidden not in text
    assert "LLM_API_KEY" in result.stdout and str(home / ".config/personal-memory/cognee.env") in result.stdout

    # Everything setup.mjs wrote stays under the scratch stack and HOME (it also runs gen-masks and makes
    # ~/.config/hindsight, both scoped to PM_STACK_ROOT and HOME).
    assert (stack / "compose.override.yaml").exists()
    assert {p.name for p in home.iterdir()} <= {".config"}

    # The scratch HOME has no env files, so the optional env_file entries are simply skipped.
    rendered = render(stack / ".env", PROJECT, "--profile", "cognee", files=FILES, env={"HOME": str(home)})
    assert set(rendered["services"]) == COGNEE_SERVICES
    assert rendered["services"]["cognee"]["ports"][0]["published"] == "8766"

    # A hand-run `config` with no --profile flag picks the profile up from COMPOSE_PROFILES in that same .env.
    plain = render(stack / ".env", PROJECT, files=FILES, env={"HOME": str(home)})
    assert set(plain["services"]) == COGNEE_SERVICES


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_rewrites_keys_without_duplicating_and_keeps_an_existing_litellm_config(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    stack.mkdir()
    home.mkdir()
    (stack / ".env").write_text("LITELLM_CONFIG=/kept/litellm.yaml\nCOGNEE_PORT=18000\nHOST_UID=1\n")
    run_setup(stack, home)
    run_setup(stack, home, {"COGNEE_PORT": "18001"})
    lines = (stack / ".env").read_text().splitlines()
    assert sorted(line.split("=")[0] for line in lines) == [
        "COGNEE_PORT",
        "COMPOSE_PROFILES",
        "HOST_GID",
        "HOST_UID",
        "LITELLM_CONFIG",
    ]
    assert read_env(stack / ".env")["LITELLM_CONFIG"] == "/kept/litellm.yaml"
    assert read_env(stack / ".env")["COGNEE_PORT"] == "18001"
    # The first run kept the port from the existing .env.
    run_setup(stack, home)
    assert read_env(stack / ".env")["COGNEE_PORT"] == "18001"


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_replaces_a_stale_hindsight_profile_with_exactly_one_cognee_line(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    stack.mkdir()
    home.mkdir()
    (stack / ".env").write_text("COMPOSE_PROFILES=hindsight\nHINDSIGHT_PORT=8888\n")
    run_setup(stack, home)
    lines = (stack / ".env").read_text().splitlines()
    assert [line for line in lines if line.startswith("COMPOSE_PROFILES")] == ["COMPOSE_PROFILES=cognee"]
    assert "HINDSIGHT_PORT=8888" in lines


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_litellm_config_branches(tmp_path):
    shipped = str(ROOT / "config" / "litellm.lemond.yaml")

    def fresh(name, seed=None, extra=None):
        stack, home = tmp_path / name / "stack", tmp_path / name / "home"
        stack.mkdir(parents=True)
        home.mkdir()
        if seed is not None:
            (stack / ".env").write_text(seed)
        run_setup(stack, home, extra)
        text = (stack / ".env").read_text()
        assert len([line for line in text.splitlines() if line.startswith("LITELLM_CONFIG")]) == 1
        return read_env(stack / ".env")["LITELLM_CONFIG"]

    assert fresh("none") == shipped
    assert fresh("empty-line", "LITELLM_CONFIG=\n") == shipped
    assert fresh("process-env", extra={"LITELLM_CONFIG": "/operator/litellm.yaml"}) == "/operator/litellm.yaml"
    assert fresh("empty-line-and-env", "LITELLM_CONFIG=\n", {"LITELLM_CONFIG": "/operator/l.yaml"}) == "/operator/l.yaml"
    # A value already in the stack .env wins over the process env.
    assert fresh("existing", "LITELLM_CONFIG=/kept.yaml\n", {"LITELLM_CONFIG": "/operator/l.yaml"}) == "/kept.yaml"


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_normalises_the_port(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    home.mkdir()
    run_setup(stack, home, {"COGNEE_PORT": "008766"})
    assert read_env(stack / ".env")["COGNEE_PORT"] == "8766"


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_rejects_a_bad_port_and_leaves_the_env_alone(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    home.mkdir()
    for bad in ("0", "70000", "abc"):
        with pytest.raises(subprocess.CalledProcessError) as failure:
            run_setup(stack, home, {"COGNEE_PORT": bad})
        assert "COGNEE_PORT must be a number" in failure.value.stderr
    assert not (stack / ".env").exists()


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_notices_follow_the_env_file_state_and_never_print_values(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    home.mkdir()
    env_file = tmp_path / "cognee.env"

    env_file.write_text("LLM_API_KEY=\n")
    out = run_setup(stack, home, {"COGNEE_ENV_FILE": str(env_file)}).stdout
    assert f"put LLM_API_KEY=... in {env_file}" in out

    env_file.write_text(f"LLM_API_KEY={LLM_SECRET}\n")
    env_file.chmod(0o644)
    out = run_setup(stack, home, {"COGNEE_ENV_FILE": str(env_file)}).stdout
    assert "needs an LLM key" not in out
    assert f"{env_file} is readable by other users" in out
    assert LLM_SECRET not in out

    env_file.chmod(0o600)
    out = run_setup(stack, home, {"COGNEE_ENV_FILE": str(env_file)}).stdout
    assert "NOTE" not in out


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_setup_mjs_persists_custom_env_file_paths_and_compose_reads_them(tmp_path):
    """A non-default env file location is written to the stack .env as a path (never its contents)."""
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    vault = home / "vault"
    vault.mkdir(parents=True)
    (vault / "cognee.env").write_text(f"LLM_API_KEY={LLM_SECRET}\n")
    (vault / "indexer.env").write_text(f"COGNEE_API_KEY={INDEXER_SECRET}\n")
    custom = {
        "COGNEE_ENV_FILE": "~/vault/cognee.env",
        "COGNEE_INDEXER_ENV_FILE": str(vault / "indexer.env"),
    }
    run_setup(stack, home, custom)

    written = read_env(stack / ".env")
    assert written["COGNEE_ENV_FILE"] == str(vault / "cognee.env")
    assert written["COGNEE_INDEXER_ENV_FILE"] == str(vault / "indexer.env")
    text = (stack / ".env").read_text()
    for forbidden in ("LLM_API_KEY=", "COGNEE_API_KEY=", LLM_SECRET, INDEXER_SECRET):
        assert forbidden not in text

    # A plain `docker compose` run (no process variables) finds the same files through the stack .env.
    rendered = render(stack / ".env", PROJECT, "--profile", "cognee", files=FILES, env={"HOME": str(home)})
    assert rendered["services"]["cognee"]["environment"]["LLM_API_KEY"] == LLM_SECRET
    assert rendered["services"]["indexer"]["environment"]["COGNEE_API_KEY"] == INDEXER_SECRET

    # Without the variables a rerun keeps the persisted paths, and re-running with new ones replaces them.
    run_setup(stack, home)
    assert read_env(stack / ".env")["COGNEE_ENV_FILE"] == str(vault / "cognee.env")
    run_setup(stack, home, {"COGNEE_ENV_FILE": str(vault / "other.env")})
    lines = (stack / ".env").read_text().splitlines()
    assert [line for line in lines if line.startswith("COGNEE_ENV_FILE=")] == [f"COGNEE_ENV_FILE={vault / 'other.env'}"]
