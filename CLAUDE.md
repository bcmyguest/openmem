# Personal-memory repository

Rules and gotchas for agents. Behavior and configuration live in `docs/`; read the page before changing its area.

## Where things are documented

| Area | Doc |
| --- | --- |
| Data flow | README diagram; [docs/architecture.md](docs/architecture.md) |
| Provider support claims | `providers/*/manifest.json` → [provider status](https://bcmyguest.github.io/openmem/docs/provider-status/) |
| Coding-agent install, hooks, integration modes | [docs/coding-agents.md](docs/coding-agents.md), [docs/coding-agent-hooks.md](docs/coding-agent-hooks.md) |
| Repository auto-registration (`autoRegister`, `optOutPaths`) | [docs/coding-agent-hooks.md](docs/coding-agent-hooks.md) |
| Context management (trimming, session store) | Not in this repo: [Smarter Compact](https://github.com/bcmyguest/smarter-compact) |
| Feed sync scheduling | [docs/sources-feeds.md](docs/sources-feeds.md) |
| mem0 through the stack LiteLLM | [docs/mem0.md](docs/mem0.md#models-through-the-stack-litellm-optional) |
| Export / import | [docs/memory-portability.md](docs/memory-portability.md) |
| Checkout, tests, prek, CI | [docs/development.md](docs/development.md) |

In docs, “provider” names the selected memory system; `providers/<id>/` holds OpenMem's adapter.

## Gotchas

- Tests and prek: [docs/development.md](docs/development.md).
- Installed agents run a copy in `~/.local/share/personal-memory/agent-runtime`, not this checkout. Re-run `install-coding-agent --yes` after changing hook code.
- Never write `ANTHROPIC_BASE_URL`, OpenCode provider `baseURL` or Codex `model_provider`: Smarter Compact owns them. `cli/coding-agent/legacy-context-proxy.mjs` only detects settings left by openmem ≤ 0.9 and prints the manual fix.
- Recall text is untrusted data: keep it inside the escaped `<openmem-recall untrusted="true">` frame.
- `REVAMP.md` tracks unverified live paths (Cursor Agent `transcript_path`, Codex Stop format).

## Site media

`cd site && pnpm media` regenerates the overview diagram and its PNG exports into `site/public/media/`. README and docs reference them as `<picture>` at https://bcmyguest.github.io/openmem/media/; the docs build converts them (`pictureToDuo` in `site/scripts/lib/docs.mjs`).
