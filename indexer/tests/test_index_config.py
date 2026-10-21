"""index.yml schema, defaults, validation and override precedence for indexer/index_config.py."""


import index_config
import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def test_shipped_default_matches_built_in_values():
    shipped = index_config.load(index_config.DEFAULT_PATH, environ={})
    assert shipped == index_config.parse(None)
    assert shipped.source == str(index_config.DEFAULT_PATH)


def test_defaults_reproduce_previous_behaviour(home):
    config = index_config.parse(None)

    assert config.roots == (index_config.Root(home, 3),)
    assert config.repos == (home / ".config/nvim",)
    assert config.vault_auto is True
    assert config.vault_paths == ()
    assert config.notes_paths == ()
    assert config.papers_paths == ()
    assert config.bookmarks_paths == ()
    assert config.exclude == ()
    assert config.max_file_bytes == 128_000
    assert config.poll_seconds == 60
    assert config.vault_quiet_seconds == 30
    assert config.relist_seconds == 600
    assert "node_modules" in config.skip_dirs


def test_empty_file_takes_defaults(home):
    assert index_config.parse(None) == index_config.parse({})


def test_omitted_keys_take_built_in_values_without_merging(home):
    config = index_config.parse({"poll_seconds": 5})

    assert config.poll_seconds == 5
    assert config.repos == (home / ".config/nvim",)


def test_tilde_expands_and_bare_tilde_means_home(home):
    config = index_config.parse({"roots": [{"path": None, "depth": 2}, {"path": "~/work"}], "repos": ["~/a"]})

    assert config.roots == (index_config.Root(home, 2), index_config.Root(home / "work", 3))
    assert config.repos == (home / "a",)


def test_relative_path_is_rejected(home):
    with pytest.raises(index_config.ConfigError, match=r"repos\[0\]: expected an absolute path.*'projects/x'"):
        index_config.parse({"repos": ["projects/x"]})


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"reposs": []}, r"top level: unknown key\(s\) reposs"),
        ({"roots": "~"}, r"roots: expected a list, got a string"),
        ({"roots": [{"path": "~", "dept": 2}]}, r"roots\[0\]: unknown key\(s\) dept"),
        ({"roots": [{"depth": 2}]}, r"roots\[0\]: missing required key 'path'"),
        ({"roots": [{"path": "~", "depth": "3"}]}, r"roots\[0\]\.depth: expected an integer, got a string"),
        ({"roots": [{"path": "~", "depth": 0}]}, r"roots\[0\]\.depth: must be at least 1, got 0"),
        ({"vaults": {"auto": "yes"}}, r"vaults\.auto: expected true or false, got a string"),
        ({"vaults": {"paths": "~/x"}}, r"vaults\.paths: expected a list"),
        ({"vaults": {"autoo": True}}, r"vaults: unknown key\(s\) autoo"),
        ({"exclude": ["*/tmp"]}, r"exclude\[0\]: expected a glob on an absolute path"),
        ({"banks": ["~/x"]}, r"banks: expected a mapping"),
        ({"banks": {"~/x": 4}}, r"banks\[~/x\]: expected a non-empty string, got an integer"),
        ({"max_file_kb": True}, r"max_file_kb: expected an integer, got a boolean"),
        ({"max_file_kb": 0}, r"max_file_kb: must be at least 1, got 0"),
        ({"skip_dirs": ["a/b"]}, r"skip_dirs\[0\]: expected a directory name"),
        ({"poll_seconds": 1.5}, r"poll_seconds: expected an integer, got a number"),
        ({"vault_quiet_seconds": -1}, r"vault_quiet_seconds: must be at least 0"),
        ({"relist_seconds": None}, r"relist_seconds: expected an integer, got nothing"),
    ],
)
def test_invalid_values_name_the_key(home, data, message):
    with pytest.raises(index_config.ConfigError, match=message):
        index_config.parse(data, source="index.yml")


def test_unreadable_yaml_names_the_file(home, tmp_path):
    path = tmp_path / "index.yml"
    path.write_text("roots: [\n")

    with pytest.raises(index_config.ConfigError, match="invalid YAML"):
        index_config.load(path, environ={})


def test_explicit_path_beats_environment_and_home_file(home, tmp_path):
    explicit = tmp_path / "explicit.yml"
    explicit.write_text("poll_seconds: 7\n")
    env_file = tmp_path / "env.yml"
    env_file.write_text("poll_seconds: 8\n")
    (home / ".config/hindsight").mkdir(parents=True)
    (home / ".config/hindsight/index.yml").write_text("poll_seconds: 9\n")

    config = index_config.load(explicit, environ={index_config.ENV_VAR: str(env_file)})

    assert config.poll_seconds == 7
    assert config.source == str(explicit)


def test_environment_beats_home_file(home, tmp_path):
    env_file = tmp_path / "env.yml"
    env_file.write_text("poll_seconds: 8\n")
    (home / ".config/hindsight").mkdir(parents=True)
    (home / ".config/hindsight/index.yml").write_text("poll_seconds: 9\n")

    assert index_config.load(None, environ={index_config.ENV_VAR: str(env_file)}).poll_seconds == 8


def test_home_file_replaces_shipped_default_entirely(home):
    (home / ".config/hindsight").mkdir(parents=True)
    (home / ".config/hindsight/index.yml").write_text("repos: []\n")

    config = index_config.load(environ={})

    assert config.repos == ()
    assert config.source == str(home / ".config/hindsight/index.yml")


def test_shipped_default_used_without_override(home):
    assert index_config.load(environ={}).source == str(index_config.DEFAULT_PATH)


def test_missing_explicit_file_is_an_error(home, tmp_path):
    with pytest.raises(index_config.ConfigError, match="config file not found"):
        index_config.load(tmp_path / "absent.yml", environ={})


def test_bank_for_prefers_longest_prefix(home):
    config = index_config.parse({"banks": {"~/Documents": "docs", "~/Documents/sample-project": "rag"}})

    assert config.bank_for(home / "Documents/sample-project/src") == "rag"
    assert config.bank_for(home / "Documents/other") == "docs"
    assert config.bank_for(home / "Documentsx") is None


def test_is_excluded_matches_absolute_glob(home):
    config = index_config.parse({"exclude": ["~/test", "~/scratch/*"]})

    assert config.is_excluded(home / "test")
    assert config.is_excluded(home / "scratch/one")
    assert not config.is_excluded(home / "test2")
    assert not config.is_excluded(home / "test/child")
