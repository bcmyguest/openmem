"""mem0 compose fragment (URL-only) and its stack-env step.

Runs `docker compose config` only (nothing starts, nothing is pulled) with scratch env files and the project name
`pm-test-mem0-compose`, so it never touches a running stack. The setup.mjs test points HOME and PM_STACK_ROOT into
tmp_path, so nothing outside it is written. Skipped when Docker Compose v2.24+ is unavailable.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml
from compose_support import COMPOSE_OK, ROOT, render

pytestmark = pytest.mark.skipif(not COMPOSE_OK, reason="needs docker compose v2.24+")

PROJECT = "pm-test-mem0-compose"
FILES = ("compose.yaml", "providers/mem0/compose.yaml")
MEM0_SERVICES = {"indexer", "indexer-state-init"}
STACK_ENV_MODULE = ROOT / "providers" / "mem0" / "lib" / "stack-env.mjs"
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")


@pytest.fixture
def scratch(tmp_path):
    (tmp_path / "litellm.yaml").write_text("model_list: []\n")
    (tmp_path / "litellm.env").write_text("")
    (tmp_path / "hindsight.env").write_text("")
    (tmp_path / "mem0.env").write_text("MEM0_API_KEY=scratch-not-a-key\n")
    env = tmp_path / "scratch.env"
    env.write_text(
        f"HOST_UID=1000\nHOST_GID=1000\nMEM0_INDEXER_URL=http://host.docker.internal:18888\n"
        f"MEM0_ENV_FILE={tmp_path}/mem0.env\nLITELLM_CONFIG={tmp_path}/litellm.yaml\n"
        f"LITELLM_ENV_FILE={tmp_path}/litellm.env\nHINDSIGHT_ENV_FILE={tmp_path}/hindsight.env\n"
    )
    return env


def mem0_render(env_file: Path, *args: str, **kwargs) -> dict:
    return render(env_file, PROJECT, "--profile", "mem0", *args, files=FILES, **kwargs)


def test_mem0_profile_renders_only_the_neutral_indexer_services(scratch):
    assert set(mem0_render(scratch)["services"]) == MEM0_SERVICES


def test_indexer_is_wired_to_the_external_server(scratch):
    indexer = mem0_render(scratch)["services"]["indexer"]
    assert indexer["environment"]["MEMORY_SINK"] == "mem0"
    assert indexer["environment"]["MEMORY_API_URL"] == "http://host.docker.internal:18888"
    assert "host.docker.internal=host-gateway" in indexer["extra_hosts"] or indexer["extra_hosts"].get(
        "host.docker.internal"
    ) == "host-gateway"
    # The server is external: the indexer waits only for its own state-init step.
    assert "mem0" not in indexer["depends_on"]
    assert "profiles" not in indexer


def test_no_hindsight_or_litellm_service_and_no_placeholder_image(scratch):
    rendered = mem0_render(scratch)
    assert not {"hindsight", "litellm"} & set(rendered["services"])
    assert all("placeholder" not in service.get("image", "") for service in rendered["services"].values())


def test_env_file_supplies_the_key_when_present(scratch):
    environment = mem0_render(scratch)["services"]["indexer"]["environment"]
    assert environment["MEM0_API_KEY"] == "scratch-not-a-key"


def test_absent_env_file_still_renders(scratch, tmp_path):
    missing = tmp_path / "does-not-exist.env"
    environment = mem0_render(scratch, env={"MEM0_ENV_FILE": str(missing)})["services"]["indexer"]["environment"]
    assert "MEM0_API_KEY" not in environment
    assert environment["MEMORY_SINK"] == "mem0"


def test_fragment_declares_an_optional_env_file_and_no_service_of_its_own():
    data = yaml.safe_load((ROOT / "providers" / "mem0" / "compose.yaml").read_text())
    assert set(data["services"]) == {"indexer"}
    assert "volumes" not in data
    entry = data["services"]["indexer"]["env_file"][0]
    assert entry["required"] is False
    assert entry["path"] == "${MEM0_ENV_FILE:-${HOME}/.config/personal-memory/mem0.env}"


def test_missing_indexer_url_fails_loudly(scratch):
    with pytest.raises(subprocess.CalledProcessError):
        mem0_render(scratch, env={"MEM0_INDEXER_URL": ""})


def test_fragment_without_its_profile_still_requires_the_url(scratch):
    with pytest.raises(subprocess.CalledProcessError):
        render(scratch, PROJECT, files=FILES, env={"MEM0_INDEXER_URL": ""})


def test_hindsight_profile_with_the_fragment_is_a_plain_overlay(scratch):
    # The fragment adds no service, so it may be layered under any profile; nothing about it is promised beyond that.
    rendered = render(scratch, PROJECT, "--profile", "hindsight", files=FILES)
    assert {"hindsight", "litellm"} <= set(rendered["services"])


def test_manifest_compose_block_matches_the_fragment():
    manifest = json.loads((ROOT / "providers" / "mem0" / "manifest.json").read_text())
    compose = manifest["compose"]
    assert compose["profile"] == "mem0"
    assert compose["files"] == ["providers/mem0/compose.yaml"]
    assert compose["defaultHostPort"] == 18888
    assert compose["healthPath"] == "/docs"
    assert (ROOT / compose["files"][0]).is_file()


def node_json(source: str, env: dict[str, str] | None = None) -> object:
    process_env = {key: value for key, value in os.environ.items() if not key.startswith(("PM_", "MEM0_", "LITELLM_"))}
    process_env.update(env or {})
    out = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        capture_output=True,
        text=True,
        check=True,
        env=process_env,
    ).stdout
    return json.loads(out)


@needs_node
def test_indexer_url_rewrites_loopback_hosts_only():
    cases = [
        "http://127.0.0.1:18888",
        "http://localhost:18888/",
        "http://0.0.0.0:18888",
        "http://[::1]:18888",
        "http://LOCALHOST",
        "https://mem0.example.com/x/",
        "http://192.168.1.5:8000/api",
    ]
    source = f"""
import {{ indexerUrl, normalizeHostUrl }} from {json.dumps(STACK_ENV_MODULE.as_uri())};
const out = {{}};
for (const c of {json.dumps(cases)}) {{
  out[c] = {{ indexer: indexerUrl(c), host: normalizeHostUrl(c) }};
}}
console.log(JSON.stringify(out));
"""
    got = node_json(source)
    assert got["http://127.0.0.1:18888"]["indexer"] == "http://host.docker.internal:18888"
    assert got["http://localhost:18888/"]["indexer"] == "http://host.docker.internal:18888"
    assert got["http://0.0.0.0:18888"]["indexer"] == "http://host.docker.internal:18888"
    assert got["http://[::1]:18888"]["indexer"] == "http://host.docker.internal:18888"
    assert got["http://LOCALHOST"]["indexer"] == "http://host.docker.internal"
    assert got["https://mem0.example.com/x/"]["indexer"] == "https://mem0.example.com/x"
    assert got["http://192.168.1.5:8000/api"]["indexer"] == "http://192.168.1.5:8000/api"
    # The host view is the normalized URL: trailing slash gone, host lower-cased, never the raw string.
    assert got["http://localhost:18888/"]["host"] == "http://localhost:18888"
    assert got["http://LOCALHOST"]["host"] == "http://localhost"
    assert got["https://mem0.example.com/x/"]["host"] == "https://mem0.example.com/x"


@needs_node
def test_indexer_url_rejects_unsafe_values_without_echoing_them():
    secret = "s3cretvalue"
    cases = {
        "scheme": "ftp://127.0.0.1:21",
        "garbage": f"not a url {secret}",
        "userinfo": f"http://user:{secret}@127.0.0.1:18888",
        "newline": f"http://h\n/x\nFOO={secret}",
        "carriage": f"http://h/x\rFOO={secret}",
        "tab": f"http://h/x\t{secret}",
        "dollar": f"http://host/$HOME/{secret}",
        "query": f"http://host:1/x?api_key={secret}",
        "fragment": f"http://host:1/x#{secret}",
        "empty": "",
    }
    source = f"""
import {{ indexerUrl, normalizeHostUrl }} from {json.dumps(STACK_ENV_MODULE.as_uri())};
const out = {{}};
for (const [name, c] of Object.entries({json.dumps(cases)})) {{
  out[name] = [];
  for (const fn of [indexerUrl, normalizeHostUrl]) {{
    try {{ out[name].push({{ value: fn(c) }}); }} catch (e) {{ out[name].push({{ error: e.message }}); }}
  }}
}}
console.log(JSON.stringify(out));
"""
    got = node_json(source)
    for name, results in got.items():
        for result in results:
            assert "error" in result, name
            assert secret not in result["error"], name
            assert "FOO" not in result["error"], name
        if name in {"userinfo", "newline", "carriage", "tab", "dollar", "query", "fragment"}:
            assert "MEM0_API_KEY" in results[0]["error"], name


def run_setup(provider: str, stack: Path, home: Path, **extra: str) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("PM_", "MEM0_", "LITELLM_", "MEMORY_"))}
    env.update({"HOME": str(home), "PM_STACK_ROOT": str(stack), "MEMORY_PROVIDER": provider, **extra})
    return subprocess.run(["node", "scripts/setup.mjs"], cwd=ROOT, env=env, capture_output=True, text=True, check=True)


def env_pairs(stack: Path) -> list[tuple[str, str]]:
    return [tuple(line.split("=", 1)) for line in (stack / ".env").read_text().splitlines() if line]


def count(stack: Path, key: str) -> int:
    return [name for name, _ in env_pairs(stack)].count(key)


@needs_node
def test_setup_mjs_writes_env_that_renders_without_manual_variables(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    home.mkdir()
    result = run_setup("mem0", stack, home, MEM0_API_URL="http://127.0.0.1:18888/")
    assert "MEM0_INDEXER_URL=http://host.docker.internal:18888" in result.stdout
    assert "MEM0_API_KEY" in result.stdout  # the notice names the variable, never a value

    values = dict(env_pairs(stack))
    assert values["MEM0_INDEXER_URL"] == "http://host.docker.internal:18888"
    assert values["MEM0_API_URL"] == "http://127.0.0.1:18888"  # normalized, no trailing slash
    assert values["COMPOSE_PROFILES"] == "mem0"
    assert values["HOST_UID"] == str(os.getuid()) and values["HOST_GID"] == str(os.getgid())
    inert = Path(values["LITELLM_CONFIG"])
    assert inert.is_absolute() and inert.is_file() and inert.name == "litellm.lemond.yaml"

    # Nothing but the stack and the scratch home were written; the notice file was not created.
    assert sorted(path.name for path in stack.iterdir()) == [".env", "compose.override.yaml"]
    assert not (home / ".config" / "personal-memory").exists()

    # Re-running rewrites the mem0 keys instead of duplicating them.
    run_setup("mem0", stack, home, MEM0_API_URL="http://127.0.0.1:18888")
    for key in ("MEM0_INDEXER_URL", "MEM0_API_URL", "LITELLM_CONFIG", "COMPOSE_PROFILES", "HOST_UID", "HOST_GID"):
        assert count(stack, key) == 1, key

    # The written .env alone is enough for `docker compose config`. MEM0_ENV_FILE is set so the default under the
    # real $HOME is never read; the services that would need other HOME-based files are inactive under the profile.
    absent = {"MEM0_ENV_FILE": str(home / "absent-mem0.env")}
    rendered = render(stack / ".env", PROJECT, "--profile", "mem0", files=FILES, env=absent)
    assert set(rendered["services"]) == MEM0_SERVICES
    environment = rendered["services"]["indexer"]["environment"]
    assert environment["MEMORY_SINK"] == "mem0"
    assert environment["MEMORY_API_URL"] == "http://host.docker.internal:18888"

    # COMPOSE_PROFILES=mem0 in the .env makes a plain hand-run `config` (no --profile flag) agree with the wizard.
    assert set(render(stack / ".env", PROJECT, files=FILES, env=absent)["services"]) == MEM0_SERVICES


@needs_node
def test_provider_switch_leaves_one_compose_profile_and_a_valid_env_each_way(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    home.mkdir()
    (tmp_path / "hindsight.env").write_text("")
    absent = {
        "MEM0_ENV_FILE": str(tmp_path / "absent-mem0.env"),
        "HINDSIGHT_ENV_FILE": str(tmp_path / "hindsight.env"),
        "LITELLM_ENV_FILE": str(home / ".config" / "hindsight" / "litellm.env"),
    }

    run_setup("hindsight", stack, home)
    assert dict(env_pairs(stack))["COMPOSE_PROFILES"] == "hindsight"
    hindsight_config = dict(env_pairs(stack))["LITELLM_CONFIG"]

    run_setup("mem0", stack, home, MEM0_API_URL="http://127.0.0.1:18888")
    values = dict(env_pairs(stack))
    assert count(stack, "COMPOSE_PROFILES") == 1 and values["COMPOSE_PROFILES"] == "mem0"
    assert count(stack, "LITELLM_CONFIG") == 1
    # The Hindsight route file path set by the earlier run is the operator's value in the .env and is kept.
    assert values["LITELLM_CONFIG"] == hindsight_config
    assert set(render(stack / ".env", PROJECT, files=FILES, env=absent)["services"]) == MEM0_SERVICES

    run_setup("hindsight", stack, home)
    values = dict(env_pairs(stack))
    assert count(stack, "COMPOSE_PROFILES") == 1 and values["COMPOSE_PROFILES"] == "hindsight"
    assert count(stack, "LITELLM_CONFIG") == 1 and values["LITELLM_CONFIG"] == hindsight_config
    assert set(render(stack / ".env", PROJECT, env=absent)["services"]) == {
        "hindsight",
        "litellm",
        "indexer",
        "indexer-state-init",
    }


@needs_node
def test_setup_never_copies_the_api_key_into_the_env_or_the_output(tmp_path):
    stack = tmp_path / "stack"
    home = tmp_path / "home"
    key_dir = home / ".config" / "personal-memory"
    key_dir.mkdir(parents=True)
    key_file = key_dir / "mem0.env"
    fake_key = "m0sk_fake-key-for-the-leak-test"
    key_file.write_text(f"MEM0_API_KEY={fake_key}\n")
    key_file.chmod(0o600)

    result = run_setup("mem0", stack, home, MEM0_API_URL="https://mem0.example.com", MEM0_ENV_FILE=str(key_file))
    assert fake_key not in result.stdout + result.stderr
    assert fake_key not in (stack / ".env").read_text()
    assert "MEM0_API_KEY" not in (stack / ".env").read_text()
    assert "needs an API key" not in result.stdout  # a key is present, so no notice
    assert "loopback" not in result.stdout  # a real hostname, so no loopback caveat
    # The directory that holds the key file is masked from the indexer.
    assert f'- "{key_dir}"' in (stack / "compose.override.yaml").read_text()


@needs_node
def test_gen_masks_masks_the_provider_env_directory_only_when_it_exists(tmp_path):
    def generate(home: Path, stack: Path) -> str:
        stack.mkdir()
        env = {"HOME": str(home), "PM_STACK_ROOT": str(stack), "PATH": os.environ["PATH"]}
        subprocess.run(["node", "scripts/gen-masks.mjs"], cwd=ROOT, env=env, capture_output=True, text=True, check=True)
        return (stack / "compose.override.yaml").read_text()

    with_dir = tmp_path / "with"
    (with_dir / ".config" / "personal-memory").mkdir(parents=True)
    masked = generate(with_dir, tmp_path / "stack-with")
    assert f'- "{with_dir}/.config/personal-memory"' in masked
    assert "tmpfs:" in masked

    without_dir = tmp_path / "without"
    without_dir.mkdir()
    plain = generate(without_dir, tmp_path / "stack-without")
    assert "personal-memory" not in plain
    # A home with none of the masked paths yields the minimal override, exactly as before this directory was added.
    assert plain == "# Generated by scripts/gen-masks.mjs for this host. Do not commit.\nservices:\n  indexer:\n"

    # A Hindsight-only home (its directory exists, the new one does not) masks only what it had.
    hindsight_only = tmp_path / "hindsight-only"
    (hindsight_only / ".config" / "hindsight").mkdir(parents=True)
    override = generate(hindsight_only, tmp_path / "stack-hindsight")
    assert f'- "{hindsight_only}/.config/hindsight"' in override and "personal-memory" not in override


@needs_node
def test_prepare_stack_env_litellm_config_branches(tmp_path):
    empty_root = tmp_path / "empty-package"
    empty_root.mkdir()

    def stack_with(name: str, text: str | None) -> str:
        stack = tmp_path / name
        stack.mkdir()
        if text is not None:
            (stack / ".env").write_text(text)
        return str(stack)

    shipped = str(ROOT / "config" / "litellm.lemond.yaml")
    cases = {
        "env": [stack_with("a", "LITELLM_CONFIG=/from/dotenv.yaml\n"), {"LITELLM_CONFIG": "/from/process.yaml"}],
        "dotenv": [stack_with("b", "LITELLM_CONFIG=/from/dotenv.yaml\n"), {}],
        "empty-line": [stack_with("c", "LITELLM_CONFIG=\n"), {}],
        "none": [stack_with("d", None), {}],
        "empty-env": [stack_with("e", None), {"LITELLM_CONFIG": ""}],
    }
    source = f"""
import {{ prepareStackEnv }} from {json.dumps(STACK_ENV_MODULE.as_uri())};
const out = {{}};
for (const [name, [repo, extra]] of Object.entries({json.dumps(cases)})) {{
  const spec = prepareStackEnv({{ repo, home: repo, env: {{ MEM0_API_URL: "https://mem0.example.com", ...extra }} }});
  out[name] = {{ value: Object.fromEntries(spec.entries).LITELLM_CONFIG, dropped: spec.drop.includes("LITELLM_CONFIG"),
    count: spec.entries.filter(([k]) => k === "LITELLM_CONFIG").length }};
}}
console.log(JSON.stringify(out));
"""
    got = node_json(source)
    assert got["env"]["value"] == "/from/process.yaml"
    assert got["dotenv"]["value"] == "/from/dotenv.yaml"
    assert got["empty-line"]["value"] == shipped
    assert got["none"]["value"] == shipped
    assert got["empty-env"]["value"] == shipped
    for name, result in got.items():
        assert result["dropped"] and result["count"] == 1, name

    # A broken install (no shipped config) is a clear error, but only when the shipped value is needed.
    broken = f"""
import {{ prepareStackEnv }} from {json.dumps(STACK_ENV_MODULE.as_uri())};
const out = {{}};
for (const [name, repo, extra] of [["needed", {json.dumps(stack_with("f", None))}, {{}}],
    ["not-needed", {json.dumps(stack_with("g", None))}, {{ LITELLM_CONFIG: "/x.yaml" }}]]) {{
  try {{ prepareStackEnv({{ repo, home: repo, env: {{ MEM0_API_URL: "https://mem0.example.com", ...extra }} }}); out[name] = "ok"; }}
  catch (e) {{ out[name] = e.message; }}
}}
console.log(JSON.stringify(out));
"""
    got = node_json(broken, env={"PM_PACKAGE_ROOT": str(empty_root)})
    assert got["needed"] == "shipped config/litellm.lemond.yaml missing: broken install"
    assert got["not-needed"] == "ok"


@needs_node
def test_prepare_stack_env_requires_the_api_url_and_stores_the_normalized_one(tmp_path):
    stack = tmp_path / "stack"
    stack.mkdir()
    (stack / ".env").write_text("MEM0_API_URL=http://localhost:18888/\n")
    source = f"""
import {{ prepareStackEnv }} from {json.dumps(STACK_ENV_MODULE.as_uri())};
const repo = {json.dumps(str(tmp_path / "nowhere"))};
const out = {{}};
try {{ prepareStackEnv({{ repo, home: repo, env: {{}} }}); out.missing = "no error"; }}
catch (e) {{ out.missing = e.message; }}
const fromEnvFile = prepareStackEnv({{ repo: {json.dumps(str(stack))}, home: repo, env: {{}} }});
const spec = prepareStackEnv({{ repo, home: repo, env: {{ MEM0_API_URL: "https://mem0.example.com/x/" }} }});
out.fromEnvFile = Object.fromEntries(fromEnvFile.entries);
out.keys = spec.entries.map(([k]) => k);
out.drop = spec.drop;
out.values = Object.fromEntries(spec.entries);
console.log(JSON.stringify(out));
"""
    got = node_json(source)
    assert got["missing"].startswith("MEM0_API_URL is required")
    assert got["fromEnvFile"]["MEM0_API_URL"] == "http://localhost:18888"
    assert got["fromEnvFile"]["MEM0_INDEXER_URL"] == "http://host.docker.internal:18888"
    assert got["keys"] == ["MEM0_API_URL", "MEM0_INDEXER_URL", "COMPOSE_PROFILES", "LITELLM_CONFIG"]
    assert set(got["drop"]) == set(got["keys"])
    assert got["values"]["MEM0_API_URL"] == "https://mem0.example.com/x"
    assert got["values"]["MEM0_INDEXER_URL"] == "https://mem0.example.com/x"
    assert got["values"]["COMPOSE_PROFILES"] == "mem0"


@needs_node
def test_setup_notices_cover_missing_key_open_mode_and_loopback(tmp_path):
    key_file = tmp_path / "mem0.env"
    source = f"""
import {{ setupNotices }} from {json.dumps(STACK_ENV_MODULE.as_uri())};
import fs from "node:fs";
const file = {json.dumps(str(key_file))};
const home = {json.dumps(str(tmp_path))};
const env = {{ MEM0_ENV_FILE: file }};
const out = {{}};
out.absent = setupNotices({{ home, env }});
fs.writeFileSync(file, "# no key\\n", {{ mode: 0o600 }});
out.nokey = setupNotices({{ home, env }});
fs.writeFileSync(file, "MEM0_API_KEY=abc123secret\\n", {{ mode: 0o600 }});
fs.chmodSync(file, 0o600);
out.good = setupNotices({{ home, env }});
out.remote = setupNotices({{ home, env: {{ ...env, MEM0_API_URL: "https://mem0.example.com" }} }});
out.loopback = setupNotices({{ home, env: {{ ...env, MEM0_API_URL: "http://127.0.0.1:18888" }} }});
out.ipv6 = setupNotices({{ home, env: {{ ...env, MEM0_API_URL: "http://[::1]:18888" }} }});
out.tls = setupNotices({{ home, env: {{ ...env, MEM0_API_URL: "https://localhost:18888" }} }});
fs.mkdirSync(home + "/stack");
fs.writeFileSync(home + "/stack/.env", "MEM0_API_URL=http://localhost:18888\\n");
out.fromDotenv = setupNotices({{ repo: home + "/stack", home, env }});
fs.chmodSync(file, 0o644);
out.open = setupNotices({{ home, env }});
console.log(JSON.stringify(out));
"""
    got = node_json(source)
    for key in ("absent", "nokey"):
        assert got[key][0].startswith("NOTE: mem0 needs an API key for the indexer: put MEM0_API_KEY=...")
        assert "AUTH_DISABLED" in " ".join(got[key])
    assert got["good"] == [] and got["remote"] == []
    for key in ("loopback", "ipv6", "fromDotenv"):
        text = " ".join(got[key])
        assert "NOT reachable" in text and "0.0.0.0" in text and "docker bridge" in text, key
        assert "certificate" not in text, key
    assert "certificate" in " ".join(got["tls"])
    assert len(got["open"]) == 1 and "chmod 600" in got["open"][0]
    assert "abc123secret" not in json.dumps(got)
