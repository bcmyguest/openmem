# Mise-like config (`config.toml`)

personal-memory is a **meta** orchestrator (see [memory-providers.md](memory-providers.md)). Its
declarative config is intentionally similar to **[mise](https://mise.jdx.dev/)**:

| mise | personal-memory |
| --- | --- |
| `~/.config/mise/config.toml` + `.mise.toml` | `~/.config/personal-memory/config.toml` + `personal-memory.toml` |
| `[tools]` plugins | `[memory] provider = "…"` + `providers/*/manifest.json` |
| `[env]` | Host ports / compose project under `[stack]` |
| `[tasks]` | `./pm up`, `./pm down`, `./pm doctor` |
| `mise install` applies config | `./setup --yes` applies config |

We **do not** replace mise (or mem0/Hindsight native config). You can use both: mise installs
Node/Docker; this file describes **how agent memory runs on this machine**.

## Files

| Path | Purpose |
| --- | --- |
| `config/personal-memory.toml.example` | Shipped template; copy to your user config |
| `~/.config/personal-memory/config.toml` | **Primary** user config (gitignored on your machine) |
| `./personal-memory.toml` | Optional per-checkout overrides (e.g. different ports in a worktree) |
| `config/machine.env` | Legacy env KEY=val seeds (still supported) |
| `~/.config/hindsight/wizard.conf` | Legacy KEY=val **mirror**; updated when setup applies |

## Precedence

1. CLI (`./setup --up`, `--down`, flags)
2. Environment (`MEMORY_PROVIDER`, `PM_BACKEND`, `HINDSIGHT_PORT`, …)
3. `~/.config/personal-memory/config.toml`
4. `personal-memory.toml` / `config/personal-memory.toml` in the repo
5. `config/machine.env`
6. Existing `wizard.conf`

Interactive `./setup` uses this file for **defaults** (Clack pre-selects); your answers still win.

## Sections

- **`[memory]`** — `provider` id (`hindsight`, future `mem0`, …).
- **`[stack]`** — compose project name and host ports.
- **`[wizard]`** — default action (`configure`, `up`, `down`).
- **`[model]`** — meta **LLM routing** for the Hindsight stack only; other providers add
  `[memory.<id>]` tables later.
- **`[tasks.*]`** — descriptions for `./pm`; execution maps to `./setup` (see `wizard/bin/pm.mjs`).

## Apply

```bash
cp config/personal-memory.toml.example ~/.config/personal-memory/config.toml
# edit provider, ports, model backend
./setup --yes
```

After a successful configure, the wizard **writes back** `~/.config/personal-memory/config.toml` so
the file matches what is running (mise-style source of truth).

## Doctor

```bash
./pm doctor
```

Runs the same checks as setup step “Validate memory setup” without mutating the stack.
