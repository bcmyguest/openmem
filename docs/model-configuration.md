# Model configuration

Hindsight never names a model server. It calls the LiteLLM proxy at `http://litellm:4000/v1` with three fixed aliases, and the proxy's YAML maps each alias to a model:

| Alias | Hindsight operation |
| --- | --- |
| `memory-retain` | retain (extraction on ingest) |
| `memory-reflect` | reflect, the base `HINDSIGHT_API_LLM_MODEL`, and mental-model refresh. Needs a model that makes tool calls |
| `memory-consolidate` | consolidation |

Shipped routes (edit the YAML to change models):

| File | Backend | Notes |
| --- | --- | --- |
| `config/litellm.lemond.yaml` | lemond on the host | Reflect uses E4B GGUF; retain/consolidate use E2B |
| `config/litellm.ollama.yaml` | Ollama on the host | Used when `MEMORY_BACKEND=ollama`; `gemma4:e4b` needs Ollama newer than 0.20.3 |

Why reflect uses E4B: Gemma 4 E2B returned no usable tool call on Hindsight reflect (`finish_reason=length`). Measured on a three-fact test bank with the same query, through LiteLLM and lemond:

| Candidate | Direct tool call | Hindsight reflect |
| --- | --- | --- |
| `unsloth/gemma-4-E4B-it-GGUF:Q4_K_M` | pass, 6.5 s | HTTP 200, 29.1 s, grounded answer |
| `unsloth/Qwen3.5-4B-GGUF:Q4_K_M` | pass, 6.9 s | HTTP 200, 43.7 s, grounded answer |
| `NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB` (already in lemond) | not run | lemond fails to load the GGUF: `blk.1.ffn_gate_inp.weight` shape mismatch, llama-server exits |

Qwen3.5-4B also passes, but Gemma E4B answers faster. The official `google/` org publishes no E4B GGUF, so the GGUF comes from `unsloth/`.

Planned: switch memory-reflect to Nemotron 3.5 Bolt E4B when released (Oct 23, 2026). No E4B repo exists yet on `nvidia/` or Ollama, so the alias stays on the candidates above.

Thinking is disabled on all three aliases (`memory-retain`, `memory-reflect`, `memory-consolidate`) in the route itself: `chat_template_kwargs.enable_thinking: false` on lemond, `think: false` on Ollama. These override the `reasoning_effort` that Hindsight sends per request (for example `HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT=low`), which a route default cannot. At `max_tokens` 200 a thinking reply can finish with empty content.

Output is capped at two levels. Each alias sets `max_tokens: 4096` and `timeout: 300` in its `litellm_params`. That value applies only when the client omits `max_tokens`; a client-sent larger value overrides it (tested: 8893 tokens generated against a 100000 request), so it is a default, not a ceiling. Hindsight enforces the real limit with `HINDSIGHT_API_{RETAIN,REFLECT,CONSOLIDATION}_MAX_COMPLETION_TOKENS` in `hindsight.env` (retain 16384, reflect and consolidation 2048). Retain must exceed every retain strategy's chunk size or Hindsight rejects the strategy: the default chunk is 3000, and the coding-agent plugin's strategies (`gitlog`, `git`, `conversation`, `document`) use `retain_chunk_size: 12000`, so a 4096 cap made plugin seeding fail with `400 Invalid retain strategy 'gitlog'`.

Selection, in order:

1. `~/.config/hindsight/litellm.yaml`, if it exists. A per-machine override that replaces the shipped routes entirely. It is mounted read-only into the proxy.
2. Otherwise `config/litellm.$MEMORY_BACKEND.yaml`, where `MEMORY_BACKEND` is `lemond` (default) or `ollama`.

The choice is written to `.env` as `LITELLM_CONFIG` when `scripts/setup.mjs` runs. After changing `MEMORY_BACKEND`, an override file, or a route, rerun `setup.mjs` and then `docker compose up -d litellm`. Optional Ollama route (not the default):

```sh
MEMORY_BACKEND=ollama node scripts/setup.mjs
docker compose up -d litellm
```

Secrets live in `~/.config/hindsight/litellm.env` (mode 600, created by `setup.mjs`): `LITELLM_MASTER_KEY`, a random key that Hindsight also uses as its `HINDSIGHT_API_LLM_API_KEY`, and `LEMOND_API_KEY` (a placeholder; lemond ignores it). Routes read keys with `os.environ/NAME`, so the YAML holds no secrets.

Adding a hosted model: add the provider key to `litellm.env`, for example `ANTHROPIC_API_KEY=...`, then point an alias at it in the YAML:

```yaml
  - model_name: memory-reflect
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

Hindsight sends the same alias name for every provider, so changing a model never touches `hindsight.env`.

Verify a route from a throwaway container on the compose network, without publishing the proxy:

```sh
docker compose exec litellm python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness').read())"
```

### Migrating an existing `hindsight.env`

An older `hindsight.env` calls lemond or Ollama directly. Move it to the proxy once:

```sh
node scripts/setup.mjs --migrate-env   # backs up hindsight.env, rewrites only the LLM lines, prints no values
docker compose up -d                  # recreates hindsight so it reads the new env
```

The migration sets `HINDSIGHT_API_LLM_PROVIDER=openai`, `HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1`, the `*_LLM_MODEL` aliases, and `HINDSIGHT_API_LLM_API_KEY` to the LiteLLM master key. Other lines stay as they are. `setup.mjs` prints a reminder when it finds a direct model URL.

To switch models or a route later, edit the LiteLLM YAML (or `litellm.yaml` override) and run `docker compose up -d litellm`. Hindsight needs no change.
