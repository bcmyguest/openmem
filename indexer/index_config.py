"""Load and validate the project indexer config (config/index.yml).

Lookup, first hit wins: --config PATH, $HINDSIGHT_INDEX_CONFIG, ~/.config/hindsight/index.yml, then the shipped default.
A file found this way replaces the shipped default entirely. A key the file omits takes its built-in value (DEFAULT_DATA).
"""

import fnmatch
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import yaml


ENV_VAR = "HINDSIGHT_INDEX_CONFIG"
DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "index.yml"
USER_PATH = "~/.config/hindsight/index.yml"
TOP_LEVEL_KEYS = (
    "roots",
    "repos",
    "vaults",
    "notes",
    "papers",
    "bookmarks",
    "feeds",
    "exclude",
    "banks",
    "max_file_kb",
    "skip_dirs",
    "poll_seconds",
    "vault_quiet_seconds",
    "relist_seconds",
)
VAULT_KEYS = ("auto", "paths")
PATH_LIST_KEYS = ("paths",)
FEEDS_KEYS = ("out_dir", "rss", "openalex_queries")
ROOT_KEYS = ("path", "depth")
DEFAULT_SKIP_DIRS = [".cache", ".codegraph", ".decision", ".git", ".next", ".tasks", ".venv", "build", "dist", "node_modules", "target", "vendor"]
DEFAULT_DATA = {
    "roots": [{"path": "~", "depth": 3}],
    "repos": ["~/.config/nvim"],
    "vaults": {"auto": True, "paths": []},
    "notes": {"paths": []},
    "papers": {"paths": []},
    "bookmarks": {"paths": []},
    "feeds": {"out_dir": "~/.local/share/personal-memory/feeds", "rss": [], "openalex_queries": []},
    "exclude": [],
    "banks": {"~/Documents/sample-project": "coding-agent::documents-sample-project"},
    "max_file_kb": 128,
    "skip_dirs": DEFAULT_SKIP_DIRS,
    "poll_seconds": 60,
    "vault_quiet_seconds": 30,
    "relist_seconds": 600,
}


class ConfigError(ValueError):
    """A config file that cannot be read or fails validation. The message names the file and the key."""


@dataclass(frozen=True)
class Root:
    path: Path
    depth: int


@dataclass(frozen=True)
class Config:
    roots: tuple[Root, ...]
    repos: tuple[Path, ...]
    vault_auto: bool
    vault_paths: tuple[Path, ...]
    notes_paths: tuple[Path, ...]
    papers_paths: tuple[Path, ...]
    bookmarks_paths: tuple[Path, ...]
    feeds_out_dir: Path | None
    feeds_rss: tuple[object, ...]
    feeds_openalex_queries: tuple[object, ...]
    exclude: tuple[str, ...]
    banks: tuple[tuple[Path, str], ...]  # longest prefix first
    max_file_kb: int
    skip_dirs: frozenset[str]
    poll_seconds: int
    vault_quiet_seconds: int
    relist_seconds: int
    source: str = field(default="built-in", compare=False)

    @property
    def max_file_bytes(self) -> int:
        return self.max_file_kb * 1000

    def bank_for(self, path: Path) -> str | None:
        for prefix, bank in self.banks:
            if path == prefix or prefix in path.parents:
                return bank
        return None

    def is_excluded(self, path: Path) -> bool:
        return any(fnmatch.fnmatchcase(str(path), pattern) for pattern in self.exclude)

    def markdown_sources(self) -> tuple[tuple[str, Path], ...]:
        """(kind, path) for watched markdown trees: notes, papers, bookmarks, feed cache."""
        out: list[tuple[str, Path]] = []
        for kind, paths in (
            ("notes", self.notes_paths),
            ("papers", self.papers_paths),
            ("bookmarks", self.bookmarks_paths),
        ):
            for path in paths:
                out.append((kind, path))
        if self.feeds_out_dir is not None:
            out.append(("feed", self.feeds_out_dir))
        return tuple(out)


def _kind(value: object) -> str:
    if value is None:
        return "nothing (null)"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, int):
        return "an integer"
    if isinstance(value, float):
        return "a number"
    if isinstance(value, str):
        return "a string"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, dict):
        return "a mapping"
    return type(value).__name__


def _int(source: str, key: str, value: object, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{source}: {key}: expected an integer, got {_kind(value)}")
    if value < minimum:
        raise ConfigError(f"{source}: {key}: must be at least {minimum}, got {value}")
    return value


def _bool(source: str, key: str, value: object) -> bool:
    if not isinstance(value, bool):
        raise ConfigError(f"{source}: {key}: expected true or false, got {_kind(value)}")
    return value


def _text(source: str, key: str, value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{source}: {key}: expected a non-empty string, got {_kind(value)}")
    return value


def _list(source: str, key: str, value: object) -> list:
    if not isinstance(value, list):
        raise ConfigError(f"{source}: {key}: expected a list, got {_kind(value)}")
    return value


def _mapping(source: str, key: str, value: object, allowed: tuple[str, ...]) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(f"{source}: {key}: expected a mapping, got {_kind(value)}")
    unknown = [str(name) for name in value if name not in allowed]
    if unknown:
        raise ConfigError(f"{source}: {key}: unknown key(s) {', '.join(unknown)}; allowed: {', '.join(allowed)}")
    return value


def _abs_path(source: str, key: str, text: str) -> Path:
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise ConfigError(f"{source}: {key}: expected an absolute path or one starting with ~, got {text!r}")
    return path


def _roots(source: str, value: object) -> tuple[Root, ...]:
    roots = []
    for index, item in enumerate(_list(source, "roots", value)):
        key = f"roots[{index}]"
        entry = _mapping(source, key, item, ROOT_KEYS)
        if "path" not in entry:
            raise ConfigError(f"{source}: {key}: missing required key 'path'")
        # A bare ~ is YAML null, so null means home.
        text = "~" if entry["path"] is None else _text(source, f"{key}.path", entry["path"])
        depth = _int(source, f"{key}.depth", entry.get("depth", 3), 1)
        roots.append(Root(_abs_path(source, f"{key}.path", text), depth))
    return tuple(roots)


def _paths(source: str, key: str, value: object) -> tuple[Path, ...]:
    return tuple(_abs_path(source, f"{key}[{index}]", _text(source, f"{key}[{index}]", item)) for index, item in enumerate(_list(source, key, value)))


def _banks(source: str, value: object) -> tuple[tuple[Path, str], ...]:
    if not isinstance(value, dict):
        raise ConfigError(f"{source}: banks: expected a mapping of path to bank id, got {_kind(value)}")
    pairs = []
    for prefix, bank in value.items():
        path = _abs_path(source, f"banks[{prefix}]", _text(source, "banks key", prefix))
        pairs.append((path, _text(source, f"banks[{prefix}]", bank)))
    return tuple(sorted(pairs, key=lambda pair: len(pair[0].parts), reverse=True))


def _exclude(source: str, value: object) -> tuple[str, ...]:
    patterns = []
    for index, item in enumerate(_list(source, "exclude", value)):
        pattern = _text(source, f"exclude[{index}]", item)
        if not pattern.startswith(("/", "~")):
            raise ConfigError(f"{source}: exclude[{index}]: expected a glob on an absolute path, got {pattern!r}")
        patterns.append(os.path.expanduser(pattern))
    return tuple(patterns)


def _skip_dirs(source: str, value: object) -> frozenset[str]:
    names = []
    for index, item in enumerate(_list(source, "skip_dirs", value)):
        name = _text(source, f"skip_dirs[{index}]", item)
        if "/" in name:
            raise ConfigError(f"{source}: skip_dirs[{index}]: expected a directory name, not a path, got {name!r}")
        names.append(name)
    return frozenset(names)


def parse(data: object, source: str = "built-in") -> Config:
    """Validate parsed YAML. None (an empty file) and omitted keys take the DEFAULT_DATA values."""
    top = _mapping(source, "top level", DEFAULT_DATA if data is None else data, TOP_LEVEL_KEYS)
    merged = {**DEFAULT_DATA, **top}
    vaults = _mapping(source, "vaults", merged["vaults"], VAULT_KEYS)
    notes = _mapping(source, "notes", merged["notes"], PATH_LIST_KEYS)
    papers = _mapping(source, "papers", merged["papers"], PATH_LIST_KEYS)
    bookmarks = _mapping(source, "bookmarks", merged["bookmarks"], PATH_LIST_KEYS)
    feeds_raw = _mapping(source, "feeds", merged.get("feeds") or DEFAULT_DATA["feeds"], FEEDS_KEYS)
    feeds_out = _paths(source, "feeds.out_dir", [feeds_raw.get("out_dir") or DEFAULT_DATA["feeds"]["out_dir"]])[0]
    feeds_rss = tuple(_list(source, "feeds.rss", feeds_raw.get("rss") or []))
    feeds_oa = tuple(_list(source, "feeds.openalex_queries", feeds_raw.get("openalex_queries") or []))
    has_feeds = bool(feeds_rss or feeds_oa)
    banks = merged["banks"]
    return Config(
        roots=_roots(source, merged["roots"]),
        repos=_paths(source, "repos", merged["repos"]),
        vault_auto=_bool(source, "vaults.auto", vaults.get("auto", True)),
        vault_paths=_paths(source, "vaults.paths", vaults.get("paths", [])),
        notes_paths=_paths(source, "notes.paths", notes.get("paths", [])),
        papers_paths=_paths(source, "papers.paths", papers.get("paths", [])),
        bookmarks_paths=_paths(source, "bookmarks.paths", bookmarks.get("paths", [])),
        feeds_out_dir=feeds_out if has_feeds else None,
        feeds_rss=feeds_rss,
        feeds_openalex_queries=feeds_oa,
        exclude=_exclude(source, merged["exclude"]),
        banks=_banks(source, banks),
        max_file_kb=_int(source, "max_file_kb", merged["max_file_kb"], 1),
        skip_dirs=_skip_dirs(source, merged["skip_dirs"]),
        poll_seconds=_int(source, "poll_seconds", merged["poll_seconds"], 1),
        vault_quiet_seconds=_int(source, "vault_quiet_seconds", merged["vault_quiet_seconds"], 0),
        relist_seconds=_int(source, "relist_seconds", merged["relist_seconds"], 1),
        source=source,
    )


def read(path: Path) -> object:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigError(f"{path}: cannot read config: {error.strerror or error}") from error
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise ConfigError(f"{path}: invalid YAML: {error}") from error


def _user_path() -> Path | None:
    """The per-machine file, or None when absent or not visible (for example, inside a masked directory)."""
    user = Path(USER_PATH).expanduser()
    try:
        return user if user.is_file() else None
    except OSError:
        return None


def load(explicit: str | Path | None = None, environ: Mapping[str, str] = os.environ) -> Config:
    if explicit:
        path = Path(explicit).expanduser()
    elif environ.get(ENV_VAR):
        path = Path(environ[ENV_VAR]).expanduser()
    else:
        path = _user_path() or DEFAULT_PATH
    if not path.is_file():
        raise ConfigError(f"{path}: config file not found")
    return parse(read(path), source=str(path))
