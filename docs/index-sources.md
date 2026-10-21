# Index sources

The shared indexer reads `~/.config/hindsight/index.yml` (or `config/index.yml` defaults). One active provider sink receives retains from every source.

| Source kind | Config | Detection | Default bank prefix |
| --- | --- | --- | --- |
| **Git repo** | `roots`, `repos` | Poll `git` fingerprint | `coding-agent::<repo>` |
| **Obsidian vault** | `roots` + `vaults.auto`, `vaults.paths` | inotify after quiet period | `obsidian::<slug>` |
| **Notes folder** | `notes.paths` | inotify (no `.obsidian` required) | `notes::<slug>` |

Override banks with the `banks:` map (longest prefix wins).

```yaml
notes:
  paths:
    - ~/Documents/plain-markdown
repos:
  - ~/src/my-fork
vaults:
  paths:
    - ~/Obsidian/Main
```

Exclude paths with `exclude:` globs. Tune `poll_seconds`, `vault_quiet_seconds`, and `relist_seconds` for watcher behavior.

See [indexer sinks](indexer-sinks.md) for how banks map to mem0/Cognee/Hindsight scopes.
