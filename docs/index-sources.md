# Index sources

The shared indexer reads `~/.config/hindsight/index.yml` (or `config/index.yml` defaults). One active provider sink receives retains from every source.

| Source kind | Config | Detection | Default bank prefix |
| --- | --- | --- | --- |
| **Git repo** | `roots`, `repos` | Poll `git` fingerprint | `coding-agent::<repo>` |
| **Obsidian vault** | `roots` + `vaults.auto`, `vaults.paths` | inotify after quiet period | `obsidian::<slug>` |
| **Notes** | `notes.paths` | inotify | `notes::<slug>` |
| **Papers** | `papers.paths` | inotify | `papers::<slug>` |
| **Bookmarks** | `bookmarks.paths` | inotify | `bookmarks::<slug>` |

Markdown trees index `.md` (and Obsidian-style structure) the same way; use separate keys so banks stay readable in Hindsight/mem0 scopes.

Override banks with the `banks:` map (longest prefix wins).

```yaml
notes:
  paths:
    - ~/Documents/plain-markdown
papers:
  paths:
    - ~/Zotero/storage/export-md
bookmarks:
  paths:
    - ~/Exports/linkwarden-markdown
repos:
  - ~/src/my-fork
vaults:
  paths:
    - ~/Obsidian/Main
```

Exclude paths with `exclude:` globs. Tune `poll_seconds`, `vault_quiet_seconds`, and `relist_seconds` for watcher behavior.

**More source types** (OpenAlex, Zotero API, Readwise, feeds): [index-sources-roadmap.md](index-sources-roadmap.md).

See [indexer sinks](indexer-sinks.md) for how banks map to mem0/Cognee/Hindsight scopes.
