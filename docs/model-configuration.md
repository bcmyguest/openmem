# Model configuration

Hindsight never names a model server. It calls the LiteLLM proxy at `http://litellm:4000/v1` with three fixed aliases, and the proxy's YAML maps each alias to a model:

| Alias | Hindsight operation |
| --- | --- |
| `memory-retain` | retain (extraction on ingest) |
| `memory-reflect` | reflect, the base `HINDSIGHT_API_LLM_MODEL`, and mental-model refresh. Needs a model that makes tool calls |
| `memory-consolidate` | consolidation |

## Shipped routes

Edit the YAML (or a per-machine override) to change models.

| File | Backend | Default split |
| --- | --- | --- |
| `config/litellm.lemond.yaml` | lemond on the host | Reflect: Gemma 4 E4B GGUF (`unsloth/`); retain and consolidate: E2B |
| `config/litellm.ollama.yaml` | Ollama on the host | Used when `MEMORY_BACKEND=ollama`; `gemma4:e4b` needs Ollama newer than 0.20.3 |
| `~/.config/hindsight/litellm.yaml` (written by `./setup`, backend `meridian`) | Meridian on the host (Claude subscription) | Retain and consolidate: `claude-haiku-5-5`; reflect: `claude-sonnet-5-5`. See [Meridian route](meridian-litellm.md#with-the-wizard) |

**Why reflect uses a larger model:** E2B often returns no usable tool call on Hindsight reflect (`finish_reason=length`). The shipped lemond route uses E4B for `memory-reflect` only. Qwen3.5-4B works as an alternative if you change the route; pick any model that passes a direct tool-call check and a smoke reflect.

## Route selection

| Priority | Path |
| --- | --- |
| 1 | `~/.config/hindsight/litellm.yaml` — full override, mounted read-only into the proxy |
| 2 | `config/litellm.$MEMORY_BACKEND.yaml` — `lemond` (default) or `ollama` |

`scripts/setup.mjs` writes `LITELLM_CONFIG` in the stack `.env`. After changing backend, override, or routes:

```sh
node scripts/setup.mjs
docker compose up -d litellm
```

Optional Ollama backend:

```sh
MEMORY_BACKEND=ollama node scripts/setup.mjs
docker compose up -d litellm
```

## Thinking and token limits

Thinking is off on all three aliases in the route YAML (`enable_thinking: false` / `think: false`) so replies are not empty when Hindsight sends low `reasoning_effort`.

| Layer | Role |
| --- | --- |
| LiteLLM `litellm_params.max_tokens` | Default when the client omits `max_tokens` (4096 in shipped routes) |
| `HINDSIGHT_API_*_MAX_COMPLETION_TOKENS` in `hindsight.env` | Hard cap Hindsight enforces (retain 16384; reflect and consolidation 2048) |

Retain cap must exceed each retain strategy's chunk size (coding-agent strategies use 12000) or Hindsight returns `400 Invalid retain strategy`.

## Retain extraction mode

OpenMem’s shipped `config/hindsight.env.example` sets:

```env
HINDSIGHT_API_RETAIN_EXTRACTION_MODE=verbatim
```

**verbatim** keeps each chunk’s text as the memory unit and still calls the retain LLM for entities, time, and location (cheaper than default `concise` fact rewriting). Alternatives: `concise` / `verbose` (LLM facts), `chunks` (no LLM on ingest; pass entities yourself if needed), or `HINDSIGHT_API_LLM_PROVIDER=none` (chunks-only; reflect disabled). Per-bank strategies can override this (the indexer already uses `chunks` for `project-index`).

## Secrets

`~/.config/hindsight/litellm.env` (mode 600): `LITELLM_MASTER_KEY` (Hindsight uses this as `HINDSIGHT_API_LLM_API_KEY`), plus provider keys referenced as `os.environ/NAME` in the YAML.

Example hosted reflect model:

```yaml
  - model_name: memory-reflect
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

Hindsight always sends the alias names above; you do not edit model ids in `hindsight.env` for route changes.

## mem0 through the same LiteLLM

The `litellm` service carries its own compose profile `litellm` next to `hindsight` and `notebooklm`, so Hindsight's stack renders and starts as before. mem0's wizard can enable that profile: LiteLLM then runs without Hindsight, published on `127.0.0.1:${MEM0_LITELLM_PORT:-4000}` only, from `~/.config/personal-memory/mem0-litellm.yaml`, with the same `litellm.env` and master key.

| Alias | mem0 use |
| --- | --- |
| `memory-llm` | mem0's LLM (fact extraction and memory updates) |
| `memory-embed` | mem0's embedder, only for backends with an embedding model (Ollama `nomic-embed-text`, an OpenAI-compatible server) |

Claude (Anthropic API key or Meridian) has no embedding model; with those backends mem0 keeps its own embedder. The mem0 config keys and their sources are in [mem0 — Models through the stack LiteLLM](mem0.md#models-through-the-stack-litellm-optional).

## Verify and migrate

Health check from the compose network:

```sh
docker compose exec litellm python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness').read())"
```

Older `hindsight.env` files that pointed at lemond/Ollama directly:

```sh
node scripts/setup.mjs --migrate-env
docker compose up -d
```

Migration rewrites LLM lines to use `http://litellm:4000/v1` and the three aliases; other lines stay as they are.
