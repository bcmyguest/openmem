# Readwise → indexer

Export highlights from [Readwise Reader](https://readwise.io/read) or the legacy export as **Markdown**.

1. Export to a directory (Readwise → Export → Markdown).
2. Add to `notes.paths` or `papers.paths` depending on how you split reading vs research:

```yaml
notes:
  paths:
    - ~/Readwise/Full-Sync
```

3. Re-run indexing; chunks retain with bank `notes::full-sync` (slug from folder name).

For automatic sync, use Readwise’s scheduled export + the same path (filesystem watcher picks up changes).
