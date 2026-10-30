# Personal-memory repository

Rules and gotchas for agents. Behavior and configuration live in `docs/`; read the page before changing its area.

## Where things are documented

| Area | Doc |
| --- | --- |
| Data flow | README diagram; [docs/architecture.md](docs/architecture.md) |
| Provider support claims | `providers/*/manifest.json` → [provider status](https://bcmyguest.github.io/openmem/docs/provider-status/) |
| Coding-agent install, hooks, integration modes | [docs/coding-agents.md](docs/coding-agents.md), [docs/coding-agent-hooks.md](docs/coding-agent-hooks.md) |
| Context management (per-agent switches, OpenCode 2 plugin) | [docs/context-management.md](docs/context-management.md) |
| Context proxy (trim, compression, recall, usage calibration) | [docs/context-proxy.md](docs/context-proxy.md) |
| Session store (schema, events, embedding) | [docs/context-store.md](docs/context-store.md) |
| Feed sync scheduling | [docs/sources-feeds.md](docs/sources-feeds.md) |
| mem0 through the stack LiteLLM | [docs/mem0.md](docs/mem0.md#models-through-the-stack-litellm-optional) |
| Export / import | [docs/memory-portability.md](docs/memory-portability.md) |

In docs, “provider” names the selected memory system; `providers/<id>/` holds OpenMem's adapter.

## Gotchas

- Installed agents run a copy in `~/.local/share/personal-memory/agent-runtime`, not this checkout. Re-run `install-coding-agent --yes` after changing hook code.
- The proxy core (`proxy/openmem_context/`) and the OpenCode 2 port (`cli/coding-agent/context-trim.mjs`) mirror each other; shared constants (`STANDING_INSTRUCTION`, `RECALL_*`) must stay identical, and a behavior change lands in both.
- Trim fingerprints ignore `cache_control` and single-text-block wrapping, because Claude Code changes both on resent messages.
- The `context-proxy` image is pinned to LiteLLM v1.109.0-dev.1 (the only release with PR #41522, needed for Codex); `proxy/tests/image/run.py` checks the hook inside it.
- Recall text is untrusted data: keep it inside the escaped `<openmem-recall untrusted="true">` frame.
- `REVAMP.md` tracks unverified live paths (Cursor Agent `transcript_path`, Codex Stop format).

## Site media

`cd site && pnpm media` regenerates the overview diagrams, ContextBench charts (from `site/src/data/contextbench.json`, written by `site/scripts/bench/compute-contextbench.py <bench dir>`) and GIFs into `site/public/media/`. README and docs reference them as `<picture>` at https://bcmyguest.github.io/openmem/media/; the docs build converts them (`pictureToDuo` in `site/scripts/lib/docs.mjs`).
