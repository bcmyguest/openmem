# mem0

**mem0** is a supported OpenMem provider. You run a [self-hosted mem0 REST server](https://docs.mem0.ai/open-source/features/rest-api); OpenMem points the shared indexer and unified `memory_*` MCP at it. One active provider at a time — same agent surface as Hindsight or Cognee.

This is **not** the hosted platform at `https://api.mem0.ai` (different API shape). OpenMem talks to the open-source REST server only (no `/v1/` prefix).

Upstream project: [mem0ai/mem0](https://github.com/mem0ai/mem0). Stack details for contributors: `providers/mem0/OPERATOR.md`.

## What you run vs what OpenMem runs

| You | OpenMem |
| --- | --- |
| mem0 REST server (JWT, Postgres/pgvector, embedder keys) | `MEMORY_PROVIDER=mem0`, `MEMORY_SINK=mem0` |
| API key in `~/.config/personal-memory/mem0.env` (mode **600**) | `MEM0_API_URL` / `MEM0_INDEXER_URL` in stack env |
| Bind so the indexer container can reach the server | Wizard smoke: docs, retain, search, delete-by-id |
| | Unified MCP + optional native mem0 MCP |

Compose profile `mem0` adds env + `extra_hosts` on the shared **indexer** only — there is no mem0 container in this repo yet. The optional profile `litellm` adds the stack LiteLLM on loopback for mem0's LLM ([below](#models-through-the-stack-litellm-optional)).

## First-time setup

1. Start your mem0 REST server (default OpenMem port expectation: **18888**).
2. Put the API key in the env file (skip if `AUTH_DISABLED=true` on the server for local dev only):

```text
~/.config/personal-memory/mem0.env
MEM0_API_KEY=…
```

Never put `MEM0_API_KEY` in stack `.env`, `wizard.conf`, `config.toml`, or `mcp.json`.

3. Select mem0 in the wizard, or switch later:

```sh
npx @bcmyguest/openmem              # choose mem0 when prompted
# or:
npx @bcmyguest/openmem switch mem0 --yes
```

4. Confirm:

```sh
npx @bcmyguest/openmem doctor
curl -fsS "$MEM0_API_URL/docs"   # URL from wizard / stack .env
```

## URLs

| Variable | Meaning |
| --- | --- |
| `MEM0_API_URL` | Host view (what you curl), e.g. `http://127.0.0.1:18888` |
| `MEM0_INDEXER_URL` | Derived for the indexer container — loopback hosts are rewritten to the Docker bridge gateway. Do not set this to `127.0.0.1` by hand inside the container. |

**Linux:** a process bound only to loopback is often unreachable from the indexer container. Bind mem0 to `0.0.0.0` (or a real hostname). Prefer `https://` when the server is not on loopback — `X-API-Key` is cleartext on plain HTTP.

Search fails if the server’s embedder is misconfigured; smoke stores with `infer: false` and looks for that fact.

## Models through the stack LiteLLM (optional)

mem0 picks its own LLM and embedder. The wizard can instead route mem0's LLM through the stack's LiteLLM, the gateway Hindsight uses, so a model change (Claude included) is one LiteLLM route. In step 3 answer yes to "Route mem0's LLM through the stack LiteLLM", or run `./setup --yes` with `MEM0_LITELLM=1`.

| Backend | mem0 LLM (`memory-llm`) | Embeddings (`memory-embed`) | Key in `litellm.env` |
| --- | --- | --- | --- |
| Ollama | `ollama_chat/<model>` (default `gemma4:e2b`) | `ollama/nomic-embed-text` by default (`none` keeps mem0's embedder) | none |
| Custom OpenAI-compatible URL | `openai/<model>` | optional `openai/<model>` (e.g. `text-embedding-3-small`) | `LEMOND_API_KEY` (same variable as Hindsight's custom route) |
| Anthropic API key | `anthropic/<model>` (default `claude-haiku-5-5`) | none: mem0 keeps its own embedder | `ANTHROPIC_API_KEY` |
| Claude subscription (Meridian) | `anthropic/<model>` at Meridian ([guide](meridian-litellm.md)); use is governed by Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) | none | `MERIDIAN_API_KEY` |

What the wizard does:

- writes `~/.config/personal-memory/mem0-litellm.yaml` (routes only; keys are `os.environ/…` references) and points `LITELLM_CONFIG` at it;
- keeps `LITELLM_MASTER_KEY` and provider keys in `~/.config/hindsight/litellm.env` (mode 600; `LITELLM_ENV_FILE` overrides), creating an `sk-` master key when the file is new;
- sets `COMPOSE_PROFILES=mem0,litellm`. `litellm` has its own compose profile; `providers/mem0/compose.yaml` publishes it on **`127.0.0.1:${MEM0_LITELLM_PORT:-4000}` only** (the wizard keeps 4000 when free, else offers the next free port) and its entrypoint exits unless `LITELLM_MASTER_KEY` starts with `sk-`;
- prints the mem0 config blocks below. It does **not** edit your mem0 server config.

```json
{
  "llm": {"provider": "openai", "config": {"model": "memory-llm", "openai_base_url": "http://127.0.0.1:4000/v1", "api_key": "<LITELLM_MASTER_KEY>"}},
  "embedder": {"provider": "openai", "config": {"model": "memory-embed", "openai_base_url": "http://127.0.0.1:4000/v1", "api_key": "<LITELLM_MASTER_KEY>"}},
  "vector_store": {"config": {"embedding_model_dims": 768}}
}
```

The `embedder` and `vector_store` blocks appear only when the backend serves embeddings (768 is `nomic-embed-text`'s size). Apply the blocks yourself: `POST /configure` on the REST server with an admin key, or merge them into the dict you pass to `Memory.from_config`.

Why these keys (mem0 `main` at [26cdefb](https://github.com/mem0ai/mem0/tree/26cdefb46600c0fa5953c4b5ee5003c125539fc4)):

- The self-hosted REST server bundles only the `openai`, `anthropic` and `gemini` LLM providers and the `openai` and `gemini` embedders ([server/main.py L62-63](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/server/main.py#L62-L63)), so the snippet uses provider `openai` against LiteLLM rather than mem0's `litellm` provider ([docs](https://docs.mem0.ai/components/llms/models/litellm)), which also passes no base URL to `litellm.completion` ([mem0/llms/litellm.py](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/llms/litellm.py)).
- The `openai` LLM uses `openai_base_url` and `api_key` from its config, but switches to OpenRouter when `OPENROUTER_API_KEY` is set ([mem0/llms/openai.py](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/llms/openai.py), [config](https://docs.mem0.ai/components/llms/config)).
- The `openai` embedder reads `openai_base_url`, `api_key` and `model` ([mem0/embeddings/openai.py](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/embeddings/openai.py), [config](https://docs.mem0.ai/components/embedders/config)). Leaving `embedding_dims` unset keeps it from sending a `dimensions` parameter.
- pgvector's collection size is `vector_store.config.embedding_model_dims` (default 1536, [mem0/configs/vector_stores/pgvector.py](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/configs/vector_stores/pgvector.py)). A different embedder needs a new collection or re-added memories.
- `POST /configure` deep-merges the body into the running config and persists it ([server/main.py L332-337](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/server/main.py#L332-L337), `update_config` in `server/server_state.py`).

Limits: `127.0.0.1` reaches LiteLLM only from a mem0 server running on this host; a mem0 server inside another container needs host networking or a different route. Claude has no embedding model, so the Anthropic and Meridian backends route the LLM only. Whether mem0's extraction prompts (JSON `response_format`) work with every routed model is not verified here; test with an `infer: true` add after switching.

## Banks / scopes

mem0 scopes map to **`user_id`**. OpenMem’s MCP `bank` argument and indexer banks become that `user_id`. Default unified MCP scope is `openmem-mcp` unless tools pass `bank`. Project work should pass the resolved project bank so session noise does not land in the default. See [Concepts — Context and banks](concepts.md#context-and-banks).

## Coding agents and MCP

**Preferred:** unified OpenMem MCP (`memory_*`) — same tools as Hindsight/Cognee:

```sh
npx @bcmyguest/openmem install-coding-agent --yes
# or MCP only:
npx @bcmyguest/openmem install-mcp --yes
```

**Optional native mem0 tools** (upstream `@yeyuan98/mem0-mcp` names, not `memory_*`):

```sh
MEMORY_PROVIDER=mem0 npx @bcmyguest/openmem install-mcp --yes --provider-only
```

That registers `cli/mem0-mcp.mjs` with `MEM0_API_URL` / `MEM0_BASE_URL` and the **path** to `mem0.env` — never the key value in `mcp.json`. Mem0’s cloud MCP (`https://mcp.mem0.ai`) is **not** for self-hosted REST.

Restart Cursor Agent after MCP changes. Full flag matrix: [MCP setup](mcp-setup.md).

There is no Hindsight-style coding-agent plugin for mem0; session hooks + unified MCP cover day-to-day agent memory.

## Portability

Export/import uses **PMM** via `memory_export` / `memory_import` on the unified MCP. Switching providers does **not** migrate data by itself — export, switch, import (or re-index). See [Portable memory (PMM)](memory-portability.md).

## Switch provider

```sh
npx @bcmyguest/openmem switch mem0 --yes
# later:
npx @bcmyguest/openmem switch hindsight --yes
```

Updates active provider config, restarts the stack (unless `--no-stack`), refreshes MCP (unless `--no-mcp`). Does **not** migrate memories.

## Related

- [Concepts](concepts.md) — interface layer
- [MCP setup](mcp-setup.md) — unified vs provider-native
- [Portable memory (PMM)](memory-portability.md)
- [Architecture](architecture.md) · [Provider status](provider-status.md)
