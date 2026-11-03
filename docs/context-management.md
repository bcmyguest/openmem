# Context management (smart compaction)

> **WARNING — Deprecated in OpenMem.** Context management is **moving out** of this repository. Do not start new installs on OpenMem's context proxy or trim plugin; use **[Smarter Compact](https://github.com/bcmyguest/smarter-compact)** instead (`npm install -g smarter-compact`, [`smarter-compact enable`](https://github.com/bcmyguest/smarter-compact#readme)). OpenMem keeps ContextBench notes and the optional compose profile for existing stacks only.

Smart compaction documentation **moved to [Smarter Compact](https://github.com/bcmyguest/smarter-compact)** — the standalone trimmer and agent plugin package.

| Topic | Link |
| --- | --- |
| Overview (with animation) | [Smart compaction](https://bcmyguest.github.io/smarter-compact/context-management.html) |
| LiteLLM proxy, env vars, **proxy port** | [Context proxy](https://bcmyguest.github.io/smarter-compact/context-proxy.html) |
| Session store, MCP tools, trim rules | [Context store](https://bcmyguest.github.io/smarter-compact/context-store.html) |
| OpenCode plugin | [OpenCode](https://bcmyguest.github.io/smarter-compact/opencode.html) |
| Related work and benchmark method | [Context research](https://bcmyguest.github.io/smarter-compact/context-research.html) |

Install: `npm install -g smarter-compact` or clone [bcmyguest/smarter-compact](https://github.com/bcmyguest/smarter-compact).

**Still in this repo (OpenMem):** [Evidence plan](evidence-plan.md) and the optional `context-proxy` compose profile when you run the full memory stack via `./setup`.
