# Zotero → indexer

**Assumption:** use export-to-disk first; no Zotero API key in the stack yet.

1. Install [Better BibTeX](https://retorque.re/zotero-better-bibtex/) (optional) for stable cite keys.
2. Export markdown or JSON notes to a folder, e.g. `~/Zotero/export-md`.
3. Point `papers.paths` at that folder in `~/.config/hindsight/index.yml`:

```yaml
papers:
  paths:
    - ~/Zotero/export-md
```

4. Restart the indexer container or run `bin/hindsight-project-index --apply --papers ~/Zotero/export-md`.

Banks default to `papers::<folder-name>` unless overridden under `banks:`.
