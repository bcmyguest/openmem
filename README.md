# Local Hindsight memory

Source files for the local Hindsight coding-agent memory on this machine. Live paths are symlinks into this repository, created by `install.sh`.

## Layout

| Repository file | Live path |
| --- | --- |
| `bin/hindsight-project-index` | `~/.local/bin/hindsight-project-index` |
| `systemd/hindsight.service` | `~/.config/systemd/user/hindsight.service` |
| `systemd/hindsight-index.service` | `~/.config/systemd/user/hindsight-index.service` |
| `systemd/hindsight-index.timer` | `~/.config/systemd/user/hindsight-index.timer` |
| `config/coding-agent.json` | `~/.hindsight/coding-agent.json` |

`config/hindsight.env.example` is a template. The real env file, `~/.config/hindsight/hindsight.env` (mode 600), holds a secret and is not in this repository. `.gitignore` excludes it.

## Install

Prerequisites:

- `hindsight-api`: `uv tool install hindsight-api`
- Client plugin: `npx @vectorize-io/hindsight-coding-agents install claude-code codex opencode`
- lemond serving the extraction model at `127.0.0.1:13305/v1`
- `codegraph` on `PATH` (the project indexer initializes and syncs it)

Then run:

```sh
./install.sh
```

The script is idempotent. It refuses to replace a live regular file that differs from its repository copy. It creates `~/.config/hindsight/hindsight.env` from the example only when that file is missing, then set `HINDSIGHT_API_LLM_API_KEY` in it. It finishes with `systemctl --user daemon-reload`. It does not enable, start, or restart units. On a fresh machine, enable them with:

```sh
systemctl --user enable --now hindsight.service hindsight-index.timer
```

## Overview

Hindsight runs as a user service (`hindsight.service`) on `127.0.0.1:8888`. It stores its embedded database in the user's home directory. Its extraction model is served by lemond at `127.0.0.1:13305/v1`; embeddings and reranking run locally in Hindsight. The user service reads `~/.config/hindsight/hindsight.env`. Startup skips the LLM connection probe so the API can serve stored memories while lemond is restarting; conversation extraction still requires lemond. Hindsight sends one LLM request at a time to fit lemond's local serving slot.

The first-party coding-agents connector is registered for Claude Code, Codex, and OpenCode. Its shared configuration is `~/.hindsight/coding-agent.json`; it is opted in for paths under `/home/example`. Each repository uses a `coding-agent::<repo-name>` bank, so the three agents recall the same project conversations. The independent `/home/example/Documents/sample-project` checkout maps to `coding-agent::documents-sample-project` to avoid a name collision. The connector also ingests Git history and a codebase survey as sessions start. Hindsight is a derived memory store; repository source files remain authoritative.

`~/.local/bin/hindsight-project-index` adds project content to those same banks. It discovers outermost Git repositories under `/home/example` to a depth of three directories, plus `~/.config/nvim`. It reads tracked files only, skips credentials, generated directories, files over 128 KB, and `.decision/` and `.tasks/`. Markdown is split by headings and paragraphs into short chunks. CodeGraph supplies each indexed source file's symbols and call, import, and reference relationships; the script initializes or syncs CodeGraph when applying, then reads its local graph database for bulk extraction. Hindsight stores these project chunks using a separate `project-index` strategy, leaving conversation extraction settings intact. Automatic observation consolidation is disabled on indexed banks to keep bulk imports from overloading lemond; ordinary retain and recall still work. Stable document IDs allow changed content to replace earlier copies; the progress manifest is `~/.cache/hindsight-project-index/state.json`.

```sh
systemctl --user status hindsight.service
curl -fsS http://127.0.0.1:8888/health
hindsight-project-index --repo ~/.config/nvim --limit 5       # dry run
hindsight-project-index --repo ~/.config/nvim --limit 5 --apply # incremental pilot
hindsight-project-index --apply                               # all discovered repos
```

`--limit N` processes at most N changed documents per repository per run and disables removal of stale index documents. Re-run it to make progress; a full run also removes stale documents that this indexer previously wrote. The script saves progress after each successful retain. For one repository, pass `--repo PATH`; repeat `--repo` for several.

`hindsight-index.timer` runs a full refresh daily at 03:30; `hindsight-index.service` is its resumable, low-priority worker. Inspect it with `systemctl --user status hindsight-index.service` and `journalctl --user -u hindsight-index.service`. CodeGraph indexing creates disposable `.codegraph/` directories in repositories that did not already have one.
