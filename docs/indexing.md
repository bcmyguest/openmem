# Indexing

The indexer indexes each source once at startup, then keeps it current:

- **Git repositories:** the outermost repositories under each `roots` entry, plus `repos`. The indexer polls each one every `poll_seconds` (default 60). A poll fingerprints `HEAD` and the tracked-file status (`git status --porcelain -uno`). After one poll with an unchanged fingerprint, the repository is re-indexed. Edits to an already-modified tracked file change no fingerprint until `HEAD` or the status changes. Repositories with a persistent error re-run on each poll. Banks default to `coding-agent::<repo>` unless `banks` maps the path.
- **Obsidian vaults:** any folder containing `.obsidian/` within a root's depth, plus `vaults.paths`. Each uses the bank `obsidian::<slug>` unless `banks` maps it. Changes are watched with inotify. A vault is re-indexed after `vault_quiet_seconds` (default 30) without changes. Dot-prefixed paths are ignored.
- **Markdown trees:** `notes.paths`, `papers.paths`, and `bookmarks.paths` (plain folders without `.obsidian/`). Watched with inotify; banks default to `notes::`, `papers::`, and `bookmarks::` slugs. Bookmarks also index `.html` and `.txt` exports. Use `papers.paths` for Zotero markdown export dirs; see [sources-zotero.md](sources-zotero.md) and [sources-readwise.md](sources-readwise.md).
- **Feed cache:** when `feeds.rss` or `feeds.openalex_queries` is set in `index.yml`, run `npx openmem feed-sync` to refresh markdown under `feeds.out_dir`; the indexer watches that directory as kind `feed` (`feed::<slug>` banks). See [sources-feeds.md](sources-feeds.md).
- **Source discovery:** sources are re-listed every `relist_seconds` (default 600), so new repos, vaults, and configured paths are picked up without a restart.

Operator overview: [index-sources.md](index-sources.md).
- Code files get a tree-sitter outline (signatures, doc comments, imports) instead of a CodeGraph run. Parsing runs in-process; grammars are prefetched into the image at `/opt/tree-sitter-grammars`, so indexing needs no network. Supported languages: Python, JavaScript, TypeScript, TSX, Go, Rust, Java, C, C++, C#, Ruby, Lua, Bash, PHP. Known gaps: Go type declarations and TypeScript type aliases are not captured, and files with syntax errors give partial outlines. Outlines are re-retained once after this change, and the old CodeGraph-based code documents are deleted as stale.
- `optInPaths` filters sources. A missing file means no filter; an empty list means nothing is indexed.
- Automatic consolidation is disabled for the whole indexed bank, not only for indexed documents.
- Document IDs include the absolute source path. The first run after this change re-retains every document, which costs extraction time on the model server.
- Concurrent `--apply` runs (the watcher and a manual run) serialize through a lock on `state.json.lock`.

Set `INDEXER_DRY_RUN=1` to log the commands the watcher would run without executing them. The environment variables `POLL_SECONDS`, `VAULT_QUIET_SECONDS`, and `RELIST_SECONDS` override the timings in `index.yml`.

### Source config: `index.yml`

`config/index.yml` in the repository is the default. The indexer reads the first of these that exists:

1. `--config PATH` (manual runs and `--list`)
2. `$HINDSIGHT_INDEX_CONFIG`
3. `~/.config/hindsight/index.yml` (per machine; the container sees it through `scripts/setup.mjs`'s mount)
4. `config/index.yml` (baked into the image at `/opt/config/index.yml`; rebuild after changing it)

A file found this way replaces the default entirely. Keys it omits take the built-in values, which match `config/index.yml`. Unknown keys and wrong types fail at startup with the file, key, and reason. `~` expands; a bare `~` in YAML is null, which means home under `roots[].path`.

| Key | Meaning |
| --- | --- |
| `roots` | `[{path, depth}]`. Repositories are the outermost git repositories found within `depth` levels (default 3). |
| `repos` | Extra repositories, outside the roots or not. Each must be a git repository. |
| `vaults.auto` | `true` (default) finds any folder with `.obsidian/` within a root's depth. |
| `vaults.paths` | Extra vault folders. |
| `notes.paths`, `papers.paths`, `bookmarks.paths` | Markdown (and bookmark export) directories; see [index-sources.md](index-sources.md). |
| `feeds.out_dir`, `feeds.rss`, `feeds.openalex_queries` | Feed sync output; requires `npx openmem feed-sync`. |
| `exclude` | Glob patterns on absolute paths. A matching source is skipped. |
| `banks` | Absolute path prefix to bank id; the longest prefix wins. Applies to all source kinds. Unmatched repos fall back to `~/.config/personal-memory/coding-agent.json` `mapPathToBank`, then legacy `~/.hindsight/coding-agent.json`, then `coding-agent::<repository-name>`. |
| `max_file_kb` | Largest indexed file, in kilobytes (1 KB = 1000 bytes). Default 128. |
| `skip_dirs` | Directory names not descended into. Dot-prefixed directories are always skipped. |
| `poll_seconds`, `vault_quiet_seconds`, `relist_seconds` | Watcher timings. |

`optInPaths` in `~/.hindsight/coding-agent.json` still filters sources after discovery.

Check the result with `--list` before a first `--apply`. Excluded sources are reported on stderr.

Manual runs. The script defaults to a dry run; `--apply` writes:

```sh
docker compose run --rm --no-deps indexer hindsight-project-index --list
docker compose run --rm --no-deps indexer hindsight-project-index --repo PATH --apply
docker compose run --rm --no-deps indexer hindsight-project-index --vault PATH --apply
```

`--no-deps` avoids starting the `hindsight` service, which the indexer depends on. `PATH` is the host path, which the container also sees.
