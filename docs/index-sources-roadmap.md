# Index sources — roadmap

Today the indexer **ships** git repos, Obsidian vaults, markdown directory trees (`notes`, `papers`, `bookmarks` in `index.yml`), and a **feed cache** (`feeds` + `feed-sync`). Everything else below is **planned** or **bring-your-own-export** (point a folder at an export until a native connector exists).

## Shipped (filesystem)

| Kind | Config | Typical content |
| --- | --- | --- |
| Git repo | `roots`, `repos` | Code + tracked docs |
| Obsidian vault | `vaults` | Notes with `.obsidian` |
| Notes | `notes.paths` | Plain markdown trees |
| Papers | `papers.paths` | Paper notes, Zotero md export, reading notes |
| Bookmarks | `bookmarks.paths` | Saved links as markdown/HTML exports |
| Feed cache | `feeds.out_dir` + `feed-sync` | RSS / OpenAlex markdown under a watched dir |

## Planned connectors (API / sync jobs)

| Source | Idea | Likely bank prefix | Notes |
| --- | --- | --- | --- |
| **Zotero** | API or periodic export dir | `papers::zotero` | Prefer export-to-`papers.paths` first |
| **OpenAlex / OpenResearch** | Metadata + abstract pull | `openresearch::` | Read-only citeable snippets, not full PDF hosting |
| **Semantic Scholar** | Library sync | `papers::s2` | Same pattern as OpenAlex |
| **Readwise** | Reader / highlight export | `readwise::` | Official export → markdown dir |
| **Hypothesis** | Annotation export | `hypothesis::` | Web annotation JSON → indexer adapter |
| **Pinboard / Linkwarden / Karakeep** | Bookmark API or export | `bookmarks::` | Overlap with `bookmarks.paths` |
| **RSS / arXiv feed** | `npx personal-memory feed-sync` | `feed::*` | Shipped; see [sources-feeds.md](sources-feeds.md) |
| **Email** | mbox / selective forward | `mail::` | High privacy risk; opt-in only |
| **Slack / Discord export** | JSON dump dirs | `chat::` | Enterprise exports only |
| **NotebookLM** | Already optional Hindsight profile | `notebooklm::*` | Not a generic source type |

## Design rules for new sources

1. **One sink** — all sources retain into the active provider via the same indexer process.
2. **Stable bank ids** — prefix + slug; override with `banks:` in `index.yml`.
3. **Filesystem first** — if the tool can export to a directory, use `*.paths` before building OAuth sync.
4. **No secrets in repo** — API keys in `~/.config/personal-memory/`, not index.yml.

Contributing a connector: add a row here, then either a new `*.paths` kind (markdown) or an indexer sidecar script that writes retains through the existing sink.
