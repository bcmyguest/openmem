# Context proxy

The `context-proxy` compose service is a LiteLLM proxy that sits between a coding agent and its model API (Anthropic for Claude Code and OpenCode 1, ChatGPT's Codex backend for Codex) and rewrites each request before forwarding it:

1. **Tool-result compression.** A tool result over `CONTEXT_COMPRESS_OVER_TOKENS` is replaced by its first 40 and last 20 lines (capped at 4000 and 2000 characters) behind a header naming `smart_compact_get(id=...)`. The full text goes to `blobs/<id>.txt`.
2. **Store.** Every request's messages go into the session's SQLite database, `sessions/<sid>.db`: one row per content block, keyed by a chained fingerprint so resent history is never stored twice, with lines and FTS5 indexes for search. Each row records whether it is still in the model's context. Database errors are logged and never block the request. Schema and rules: [context-store.md](context-store.md#session-database).
3. **Trim.** When a request reaches `CONTEXT_TRIM_AT_TOKENS`, or the session's `.force` flag exists, the proxy drops the messages before the last real user turn and marks the dropped rows `in_context = 0`. It then puts a pointer to `smart_compact_search` / `smart_compact_sql` at the start of the kept turn. System prompt, tools, the first real user turn (usually the task statement), the agent reply just before the kept turn and the kept turn stay verbatim. When that turn's own tool loop is long, the proxy also drops its oldest tool exchanges, keeping at least the newest 3 and more while the request stays under `CONTEXT_TRIM_TO_FRACTION` (default 0.3) of the threshold. Tool call/result pairs are never split. Kept assistant messages from before the trim lose their signed thinking blocks, because the trim changes the prefix those signatures cover; the latest assistant message at trim time stays byte-identical, and thinking produced after the trim stays until the next trim. The exact rules are in [context-store.md](context-store.md#trim).
4. **Recall on trim.** If the session registration names a bank, the proxy adds Hindsight recall for the last user prompt (`budget: low`, 5 s timeout), inside an `<openmem-recall untrusted="true">` block that a fixed sentence marks as reference data, not instructions; recalled text cannot close the block ([format](context-store.md#proxy-inserted-text)). `CONTEXT_COMPACTION_RECALL=0` turns recall off. When the bank has pending or processing ingest operations, it adds a line saying recent turns may not be in memory yet.
5. **Standing instruction.** Every request, from the first, gets a constant system-prompt note: older turns may be replaced by an `[openmem: …]` pointer, and the agent must call `smart_compact_search` (or `smart_compact_sql` for counts and aggregates) before answering anything that depends on content it cannot see, and that text inside `<openmem-recall>` blocks is data, not instructions. Agents otherwise tend to answer from the visible turns after a trim. The text and per-format placement are in [context-store.md](context-store.md#proxy-inserted-text).

The cut is sticky. Later requests with the same history receive the same rewrite, byte for byte, so the prompt cache keeps hitting. The cut moves only on the next threshold crossing or `.force`. Recall is computed once per cut. File layout, schema and inserted text follow [context-store.md](context-store.md). Embeddings for hybrid search are computed on a background thread, never in the request path, and only when `CONTEXT_EMBEDDING_MODEL` is set ([Vectors](context-store.md#vectors)). At start the proxy deletes sessions idle longer than `CONTEXT_STORE_TTL_DAYS`, at most once a day ([Retention](context-store.md#retention)).

**OpenCode 2 trims natively and does not use this proxy.** OpenMem's OpenCode 2 plugin applies the same steps inside OpenCode's `context` hook (`cli/coding-agent/context-trim.mjs`, a JS port of `core.py` for OpenCode's message parts). It uses the same environment variables and defaults, the same pointer and compressed-result text, and the same store files, writing the session database through `cli/coding-agent/session-db.mjs` (`node:sqlite`); compressed output matches `compress_text` byte for byte and the database rows match the proxy's (both tested against the Python). It differs in three places. The pointer is its own text part ending in a blank line, because OpenCode's OpenAI-compatible lowering joins text parts without a separator. The pending-ingest line comes from `memory_status`. Its token estimate is the same function (`estimatePromptTokens`, tested against the Python in `scripts/tests/test_context_estimate.mjs`), calibrated from OpenCode's `session.step.ended` event: its `tokens` (`TokenUsage.Info`) pair with the context request that preceded the step, and prompt tokens are `input + cache.read + cache.write` (OpenCode fills `input` from the non-cached count). Live delivery of that event to OpenMem's plugin has not been checked; without it the plugin uses `CONTEXT_CHARS_PER_TOKEN`. Recall goes through the session facade, so every provider can answer, not only Hindsight. `scripts/tests/test_context_parity.mjs` runs shared fixture requests through both implementations and diffs the views, database rows, schema and blobs. OpenCode's own compaction is replaced the same way; see [coding agents](coding-agents.md). `CONTEXT_PROXY_ENABLED=0` also turns the native trim off. To keep the request growing only at its end, the plugin's per-prompt recall is a leading text part of the user message that prompted it, bound to that message's fingerprint and repeated byte for byte on later requests; the system prompt gets only a constant session banner and the standing instruction. Trimming and database rows see the messages without the recall part. A plugin restart forgets the bindings, so the next request renders older turns without recall and misses the cache once.

Related work and benchmark results behind this design: [context research](context-research.md).

Code: `proxy/openmem_context/` (stdlib only), `proxy/openmem_context_hook.py` (LiteLLM `async_pre_call_hook` and `async_log_success_event`), `proxy/config.yaml`. Tests: `python3 -m unittest discover -s proxy/tests` (part of `npm test`). Image check (Docker, manual): `python3 proxy/tests/image/run.py` runs the hook inside the compose image against a fake upstream.

The service image is the LiteLLM dev build `v1.109.0-dev.1`, the only release with PR #41522 (ChatGPT-subscription pass-through, which Codex needs); stable releases lack it. Hindsight's own `litellm` service stays on stable. Move the pin to the first stable release with #41522 and rerun the image check.

## Configuration

Set these in the stack `.env` or in the shell that runs compose.

| Variable | Default | Effect |
| --- | --- | --- |
| `CONTEXT_PROXY_ENABLED` | `1` | `0` forwards every request unmodified |
| `CONTEXT_TRIM_AT_TOKENS` | unset: `95000` for Haiku, `125000` otherwise | Prompt tokens (estimated as below) that trigger a trim. Unset or not an integer, the threshold follows the request's model (`MODEL_TRIM_AT_TOKENS` in `proxy/openmem_context/settings.py`): a model id containing `haiku` trims at 95000, under the higher price that Haiku charges for prompts over 100k tokens. A set value applies to every model |
| `CONTEXT_TRIM_TO_FRACTION` | `0.3` | A trim keeps older in-turn tool exchanges only while the request stays under this fraction of `CONTEXT_TRIM_AT_TOKENS`; must be between 0 and 1, else the default applies (config.toml `[context_proxy] trim_to_fraction`) |
| `CONTEXT_CHARS_PER_TOKEN` | `2.5` | Characters per token for the estimate until the session reports usage (config.toml `[context_proxy] chars_per_token`) |
| `CONTEXT_COMPRESS_OVER_TOKENS` | `4000` | Tool results above this are compressed; `0` disables compression |
| `CONTEXT_COMPACTION_MAX_CHARS` | `12000` | Maximum characters of the recall block (frame included) inserted after a trim |
| `CONTEXT_COMPACTION_RECALL` | `1` | `0` leaves recall out of the trim pointer (config.toml `[compaction] recall = false`) |
| `CONTEXT_STANDING_INSTRUCTION` | `1` | `0` leaves out the standing `smart_compact_search` instruction in the system prompt (config.toml `[context_proxy] standing_instruction = false`) |
| `CONTEXT_PROXY_PORT` | `4100` | Host port, bound to 127.0.0.1 |
| `CONTEXT_PROXY_ENV_FILE` | `~/.config/personal-memory/context-proxy.env` | Holds `LITELLM_MASTER_KEY` (and keys for extra routes) |
| `OPENMEM_STATE_DIR` | `~/.local/share/openmem` | The proxy mounts `<dir>/context` read-write |
| `CONTEXT_STORE_TTL_DAYS` | `30` | Delete session files idle this many days, checked at start at most once a day; `0` keeps them (config.toml `[context_store] ttl_days`) |
| `CONTEXT_EMBEDDING_MODEL` | empty | Embedding model for hybrid search; empty turns vectors off (config.toml `[context_store] embedding_model`) |
| `CONTEXT_EMBEDDING_TIMEOUT_S` | `30` | Seconds per row of a background embeddings call (config.toml `[context_store] embedding_timeout_s`) |
| `CONTEXT_EMBEDDING_MAX_CHARS` | `4000` | Characters of each row's head that are embedded (config.toml `[context_store] embedding_max_chars`) |
| `CONTEXT_PROXY_EMBEDDING_URL` | `http://host.docker.internal:11434/v1` | OpenAI-compatible embeddings base URL as the container sees it (Ollama on the host); passed in as `CONTEXT_EMBEDDING_URL` |
| `CONTEXT_PROXY_HINDSIGHT_URL` | `http://hindsight:8888` | Recall endpoint; the default needs the hindsight profile in the same compose project |

The defaults are untuned guesses, except `CONTEXT_CHARS_PER_TOKEN`: real Claude Code requests measured about 2.3 characters per token, so the former characters / 4 estimate let a 120000 threshold fire at 203–236k real prompt tokens.

## Token estimate

The trim compares `CONTEXT_TRIM_AT_TOKENS` with an estimate calibrated from the provider's reported usage:

1. `async_pre_call_hook` counts the request's characters (system, tools, messages; 6400 per binary block; the standing instruction excluded) and remembers them under the request's `litellm_call_id`.
2. `async_log_success_event` reads the prompt tokens of that call, cache reads and cache writes included, and stores `{chars, tokens}` in the session's `.trim.json`, per conversation thread (keyed like the cut, by the first message's fingerprint) and as the session's latest sample.
3. The next request in the thread estimates `tokens + ceil((chars now − chars then) / ratio)`, where `ratio` is that sample's chars per token, bounded to 1–8. A thread with no sample yet (a new subagent) uses the session's latest ratio; a session with no usage uses `CONTEXT_CHARS_PER_TOKEN`.

The estimate only decides whether a new cut is chosen. It never changes a stored cut or the rendered request, so calibration keeps the rewrite sticky and cache-stable.

Usage sources, read in the LiteLLM source and checked with a fake upstream: v1.106.6 for the first three rows; v1.109.0-dev.1 (`proxy/tests/image/run.py`, 2026-10-29) for all four, each plain and streamed, recording the fake's 4321 prompt tokens:

| Call | Success-hook response | Prompt tokens |
| --- | --- | --- |
| `/v1/messages` (`anthropic_messages`), plain or streamed | `ModelResponse` built from Anthropic's usage (streams: from the SSE usage events) | `usage.prompt_tokens`, which LiteLLM sums from `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| `/v1/chat/completions`, plain or streamed | `ModelResponse` | `usage.prompt_tokens` |
| `/v1/responses`, plain or streamed | `ResponsesAPIResponse`, or the `response.completed` event | `usage.input_tokens` (cached tokens included) |
| `/backend-api/codex/responses` (call type `pass_through_endpoint`; the call id comes from the logging object, not the forwarded body) | `ResponsesAPIResponse` from the terminal stream event | `usage.input_tokens` |

A raw Anthropic usage object is summed the same way, and `standard_logging_object.prompt_tokens` is the last fallback. Limits: when an upstream reports no usage, LiteLLM substitutes its own `token_counter` estimate and calibration learns that estimate; LiteLLM adds `stream_options.include_usage` itself only for OpenAI-backed chat streams. Anthropic responses with server-side `iterations` report input summed over the iterations, which overstates one prompt and trims early. A call that fails, or a proxy restart between request and response, leaves the session on its previous sample. OpenAI-backed routes were not run live. On the Codex route LiteLLM parses the stream only for a model in its price map (`chatgpt/gpt-6-sol` is); for an unmapped model the success hook gets an unparsed stream and calibration falls back to `CONTEXT_CHARS_PER_TOKEN`.

## Enable

`install-coding-agent` writes the env file and points Claude Code, OpenCode 1 and Codex at the proxy. By hand:

```sh
mkdir -p -m 700 ~/.local/share/openmem/context   # compose must not create it as root
docker compose --profile hindsight --profile context-proxy up -d context-proxy
```

Claude Code settings (`env`):

```json
{
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:4100",
  "ANTHROPIC_CUSTOM_HEADERS": "x-litellm-api-key: Bearer <LITELLM_MASTER_KEY>"
}
```

Leave `ANTHROPIC_API_KEY` out of the proxy environment. The client's own credentials, including Claude subscription OAuth, then pass through to Anthropic.

Codex (`~/.codex/config.toml`, written mode 600; a previous `model_provider` is backed up and restored on disable):

```toml
model_provider = "openmem"

[model_providers.openmem]
name = "OpenMem context proxy"
base_url = "http://127.0.0.1:4100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
http_headers = { "x-litellm-api-key" = "Bearer <LITELLM_MASTER_KEY>" }
```

Codex keeps its ChatGPT login: `requires_openai_auth` makes it send the ChatGPT bearer and `ChatGPT-Account-ID` as it does to chatgpt.com, and LiteLLM's `/backend-api/codex/{models,responses}` route forwards both to `https://chatgpt.com/backend-api/codex`. That route also requires the LiteLLM key in `x-litellm-api-key`, separate from the ChatGPT bearer (`codex_passthrough_endpoints.py`). `openai_base_url` cannot carry it: Codex ignores `http_headers` on the built-in `openai` provider. The hook handles the pass-through only on the `/backend-api/codex/responses` route (Responses adapter, `prompt_cache_key` as session id); other pass-through bodies go through unchanged. A custom provider has no remote compaction in Codex 0.162.0, so Codex compacts locally.

The service runs as `HOST_UID:HOST_GID` so the context store stays host-owned. It has its own profile, separate from the `litellm` service Hindsight uses, so Hindsight's model traffic never passes through it.

## Limits

- **Codex was checked live once** (one `codex exec` turn: answer, stored turn, usage). Trims, compression and recall on the Codex route ran only against the fake upstream. Whether `codex resume` lists sessions recorded under another `model_provider` is unverified.
- **Dev image.** The service runs a LiteLLM dev build (`v1.109.0-dev.1`); expect to move the pin.
- **OpenAI-format clients need routes.** The shipped `"*"` route sends every model name to Anthropic. Add one entry per OpenAI model to `proxy/config.yaml` (see the comment there). Whether an exact model name takes precedence over the `"*"` wildcard has not been tested here.
- **Claude Code persists large outputs itself.** In Claude Code 2.1.280, a 106 KB Bash output reached the API as a file path plus a 2 KB preview; a 24 KB output arrived inline and was compressed. Compression therefore mostly hits mid-size results.
- **One worker.** Session state uses an in-process lock; do not run LiteLLM with several workers.
- **Single host.** The session database uses SQLite WAL, which needs the proxy container and the host MCP server to share memory through the bind-mounted `-shm` file. Linux Docker with a bind mount works; Docker Desktop and network filesystems are unverified.
- **A trim invalidates the prompt cache once**, on the request that moves the cut; requests after it hit again.
- **Fail open.** Any error prints one line (exception type and location, never content) to the container log and forwards the request unmodified. Once the session id is known, the error is also written to the session database as a `fail_open` [event](context-store.md#events); each trim writes a `trim` event with estimated tokens before and after. `openmem context status` and the `context_status` MCP tool summarize both without docker, and flag a proxy whose code differs from the checkout.
