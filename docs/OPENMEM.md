# OpenMem

**OpenMem** is the product name for this repository (formerly *personal-memory*).

For the product idea — memory interface for coding agents, providers, `memory_*`, banks, formats — start with **[Concepts](https://bcmyguest.github.io/openmem/docs/concepts/)**.

## CLI

```sh
npx openmem
openmem setup
openmem doctor
```

Bins: `openmem`, `openmem-setup`, `openmem-mcp`, `openmem-install-mcp`, `openmem-install-coding-agent`, `openmem-switch-provider`, `openmem-notebooklm-mcp`, `openmem-cognee-mcp`.

Machine config paths under `~/.config/personal-memory/` and `~/.config/hindsight/` stay as-is for now so existing installs keep working. Installers rewrite leftover `personal-memory` MCP server entries to `openmem`.

## Repo

- GitHub: [bcmyguest/openmem](https://github.com/bcmyguest/openmem)
- Docs: [site](https://bcmyguest.github.io/openmem/) · [Concepts](https://bcmyguest.github.io/openmem/docs/concepts/) · [Quickstart](https://bcmyguest.github.io/openmem/docs/getting-started/)
- npm: `openmem` (package formerly `personal-memory`)
