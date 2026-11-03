# Context proxy

> **WARNING — Deprecated in OpenMem.** The context proxy and trim stack are **moving to [Smarter Compact](https://github.com/bcmyguest/smarter-compact)**. New installs should use Smarter Compact; this page describes the legacy OpenMem compose profile only.

The **context proxy** service in this repository is the Docker Compose profile used when OpenMem's wizard wires Claude Code, OpenCode 1, and Codex through LiteLLM on the memory stack.

**Product documentation moved to [Smarter Compact](https://github.com/bcmyguest/smarter-compact):**

- [Context proxy](https://bcmyguest.github.io/smarter-compact/context-proxy.html) — rewrite pipeline, configuration, token estimate, **proxy port** (default 4101 in the standalone package; OpenMem stack default remains 4100 in compose)
- [Smart compaction overview](https://bcmyguest.github.io/smarter-compact/context-management.html)
- [Context store contract](https://bcmyguest.github.io/smarter-compact/context-store.html)

Standalone install (no Docker stack): [smarter-compact README](https://github.com/bcmyguest/smarter-compact#readme) and `smarter-compact enable`.

OpenMem stack enable path: [coding agents](coding-agents.md), `npx @bcmyguest/openmem install-coding-agent`, and [context management](context-management.md) (redirect).
