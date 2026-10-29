# I built a thing — OpenMem

Copy/paste for Reddit, HN, Discord, X, etc. Trim for character limits.

---

**Title:** OpenMem — a memory interface for coding agents (Hindsight / mem0 / Cognee)

I got tired of rewiring Claude Code / Codex / Cursor / OpenCode every time I tried a different memory backend.

**OpenMem** is a memory interface for coding agents: one `memory_*` MCP + skill + session hooks, over pluggable providers. Hindsight, mem0, and Cognee ship today. Switch with `openmem switch` — same agent surface. Shared wizard, Docker Compose, and indexer (git / Obsidian / notes / feeds). Import/export via PMM.

It is **not** another memory product. It is the plumbing so the engines stay interchangeable.

```sh
git clone https://github.com/bcmyguest/openmem.git && cd openmem
npm install && npm run setup
node cli/openmem.mjs install-coding-agent --yes
```

Once on npm: `npx @bcmyguest/openmem` / `npx openmem-mcp`

- Repo: https://github.com/bcmyguest/openmem
- Docs: https://bcmyguest.github.io/openmem/
- Concepts: https://bcmyguest.github.io/openmem/docs/concepts/
- Release: https://github.com/bcmyguest/openmem/releases/tag/v0.6.3
- Glama (openmem-mcp): https://glama.ai/mcp/servers/@bcmyguest/openmem

Inspired in part by how OpenFeature separates flag APIs from vendors — listed under Inspiration in the README. Feedback welcome, especially if you run mem0 or Cognee day-to-day.

---

**Short (X / Discord):**

OpenMem — memory interface for coding agents. Stable `memory_*` MCP over Hindsight / mem0 / Cognee. Wizard + indexer + switch. Not a memory engine — the layer in front of them.
https://bcmyguest.github.io/openmem/ · https://github.com/bcmyguest/openmem · https://glama.ai/mcp/servers/@bcmyguest/openmem (openmem-mcp)
