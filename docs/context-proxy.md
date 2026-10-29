# Context proxy

The `context-proxy` compose service is a LiteLLM proxy that sits between a coding agent and Anthropic and rewrites each request before forwarding it:

1. **Tool-result compression.** A tool result over `CONTEXT_COMPRESS_OVER_TOKENS` is replaced by its first 40 and last 20 lines (capped at 4000 and 2000 characters) behind a header naming `smart_compact_get(id=...)`. The full text goes to `blobs/<id>.txt`.
2. **Trim.** When a request reaches `CONTEXT_TRIM_AT_TOKENS`, or the session's `.force` flag exists, the proxy drops every message before the last real user turn and appends the dropped content to the session's handoff log. It then puts a pointer to `smart_compact_search` and the handoff log path at the start of the kept turn. System prompt, tools, the first real user turn (usually the task statement, kept ahead of the pointer and never logged) and the in-flight turn are kept verbatim. Tool call/result pairs are never split. The exact rules are in [context-store.md](context-store.md#trim).
3. **Recall on trim.** If the session registration names a bank, the proxy adds Hindsight recall for the last user prompt (`budget: low`, 5 s timeout). When the bank has pending or processing ingest operations, it adds a line saying recent turns may not be in memory yet.
4. **Standing instruction.** Every request, from the first, gets a constant system-prompt note: older turns may be replaced by an `[openmem: …]` pointer, and the agent must call `smart_compact_search` before answering anything that depends on content it cannot see. Agents otherwise tend to answer from the visible turns after a trim. The text and per-format placement are in [context-store.md](context-store.md#proxy-inserted-text).

The cut is sticky. Later requests with the same history receive the same rewrite, byte for byte, so the prompt cache keeps hitting. The cut moves only on the next threshold crossing or `.force`. Recall is computed once per cut. File layout, row shape and inserted text follow [context-store.md](context-store.md).

**OpenCode 2 trims natively and does not use this proxy.** OpenMem's OpenCode 2 plugin applies the same three steps inside OpenCode's `context` hook (`cli/coding-agent/context-trim.mjs`, a JS port of `core.py` for OpenCode's message parts). It uses the same environment variables and defaults, the same pointer and compressed-result text, and the same store files; compressed output matches `compress_text` byte for byte (tested against the Python). It differs in three places. The pointer is its own text part ending in a blank line, because OpenCode's OpenAI-compatible lowering joins text parts without a separator. The pending-ingest line comes from `memory_status`. Its token estimate is the same function (`estimatePromptTokens`, tested against the Python in `scripts/tests/test_context_estimate.mjs`), calibrated from OpenCode's `session.step.ended` event: its `tokens` (`TokenUsage.Info`) pair with the context request that preceded the step, and prompt tokens are `input + cache.read + cache.write` (OpenCode fills `input` from the non-cached count). Live delivery of that event to OpenMem's plugin has not been checked; without it the plugin uses `CONTEXT_CHARS_PER_TOKEN`. Recall goes through the session facade, so every provider can answer, not only Hindsight. `scripts/tests/test_context_parity.mjs` runs shared fixture requests through both implementations and diffs the views, log rows and blobs. OpenCode's own compaction is replaced the same way; see [coding agents](coding-agents.md). `CONTEXT_PROXY_ENABLED=0` also turns the native trim off. To keep the request growing only at its end, the plugin's per-prompt recall is a leading text part of the user message that prompted it, bound to that message's fingerprint and repeated byte for byte on later requests; the system prompt gets only a constant session banner and the standing instruction. Trimming and log rows see the messages without the recall part. A plugin restart forgets the bindings, so the next request renders older turns without recall and misses the cache once.

Code: `proxy/openmem_context/` (stdlib only), `proxy/openmem_context_hook.py` (LiteLLM `async_pre_call_hook` and `async_log_success_event`), `proxy/config.yaml`. Tests: `python3 -m unittest discover -s proxy/tests` (part of `npm test`).

## Configuration

Set these in the stack `.env` or in the shell that runs compose.

| Variable | Default | Effect |
| --- | --- | --- |
| `CONTEXT_PROXY_ENABLED` | `1` | `0` forwards every request unmodified |
| `CONTEXT_TRIM_AT_TOKENS` | `120000` | Prompt tokens (estimated as below) that trigger a trim |
| `CONTEXT_CHARS_PER_TOKEN` | `2.5` | Characters per token for the estimate until the session reports usage (config.toml `[context_proxy] chars_per_token`) |
| `CONTEXT_COMPRESS_OVER_TOKENS` | `4000` | Tool results above this are compressed; `0` disables compression |
| `CONTEXT_COMPACTION_MAX_CHARS` | `12000` | Maximum recalled characters inserted after a trim |
| `CONTEXT_STANDING_INSTRUCTION` | `1` | `0` leaves out the standing `smart_compact_search` instruction in the system prompt (config.toml `[context_proxy] standing_instruction = false`) |
| `CONTEXT_PROXY_PORT` | `4100` | Host port, bound to 127.0.0.1 |
| `CONTEXT_PROXY_ENV_FILE` | `~/.config/personal-memory/context-proxy.env` | Holds `LITELLM_MASTER_KEY` (and keys for extra routes) |
| `OPENMEM_STATE_DIR` | `~/.local/share/openmem` | The proxy mounts `<dir>/context` read-write |
| `OPENMEM_HOST_STATE_DIR` | unset | Host value of `OPENMEM_STATE_DIR`, passed into the container so the pointer names the handoff log path the agent can open; unset, the pointer names the container path `/state/context/...` |
| `CONTEXT_PROXY_HINDSIGHT_URL` | `http://hindsight:8888` | Recall endpoint; the default needs the hindsight profile in the same compose project |

The defaults are untuned guesses, except `CONTEXT_CHARS_PER_TOKEN`: real Claude Code requests measured about 2.3 characters per token, so the former characters / 4 estimate let a 120000 threshold fire at 203–236k real prompt tokens.

## Token estimate

The trim compares `CONTEXT_TRIM_AT_TOKENS` with an estimate calibrated from the provider's reported usage:

1. `async_pre_call_hook` counts the request's characters (system, tools, messages; 6400 per binary block; the standing instruction excluded) and remembers them under the request's `litellm_call_id`.
2. `async_log_success_event` reads the prompt tokens of that call, cache reads and cache writes included, and stores `{chars, tokens}` in the session's `.trim.json`, per conversation thread (keyed like the cut, by the first message's fingerprint) and as the session's latest sample.
3. The next request in the thread estimates `tokens + ceil((chars now − chars then) / ratio)`, where `ratio` is that sample's chars per token, bounded to 1–8. A thread with no sample yet (a new subagent) uses the session's latest ratio; a session with no usage uses `CONTEXT_CHARS_PER_TOKEN`.

The estimate only decides whether a new cut is chosen. It never changes a stored cut or the rendered request, so calibration keeps the rewrite sticky and cache-stable.

Usage sources, read in the LiteLLM v1.106.6 source and checked against that image with a fake Anthropic upstream (all six calls recorded input + cache read + cache write):

| Call | Success-hook response | Prompt tokens |
| --- | --- | --- |
| `/v1/messages` (`anthropic_messages`), plain or streamed | `ModelResponse` built from Anthropic's usage (streams: from the SSE usage events) | `usage.prompt_tokens`, which LiteLLM sums from `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| `/v1/chat/completions`, plain or streamed | `ModelResponse` | `usage.prompt_tokens` |
| `/v1/responses`, plain or streamed | `ResponsesAPIResponse`, or the `response.completed` event | `usage.input_tokens` (cached tokens included) |

A raw Anthropic usage object is summed the same way, and `standard_logging_object.prompt_tokens` is the last fallback. Limits: when an upstream reports no usage, LiteLLM substitutes its own `token_counter` estimate and calibration learns that estimate; LiteLLM adds `stream_options.include_usage` itself only for OpenAI-backed chat streams. Anthropic responses with server-side `iterations` report input summed over the iterations, which overstates one prompt and trims early. A call that fails, or a proxy restart between request and response, leaves the session on its previous sample. OpenAI-backed routes were not run live.

## Enable

`install-coding-agent` writes the env file and points Claude Code at the proxy. By hand:

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

The service runs as `HOST_UID:HOST_GID` so the context store stays host-owned. It has its own profile, separate from the `litellm` service Hindsight uses, so Hindsight's model traffic never passes through it.

## Limits

- **Codex is not wired yet.** The Responses adapter (`/v1/responses`, `prompt_cache_key` as session id) is unit-tested only.
- **OpenAI-format clients need routes.** The shipped `"*"` route sends every model name to Anthropic. Add one entry per OpenAI model to `proxy/config.yaml` (see the comment there). Whether an exact model name takes precedence over the `"*"` wildcard has not been tested here.
- **Claude Code persists large outputs itself.** In Claude Code 2.1.280, a 106 KB Bash output reached the API as a file path plus a 2 KB preview; a 24 KB output arrived inline and was compressed. Compression therefore mostly hits mid-size results.
- **One worker.** Session state uses an in-process lock; do not run LiteLLM with several workers.
- **A trim invalidates the prompt cache once**, on the request that moves the cut; requests after it hit again.
- **Fail open.** Any error prints one line (exception type and location, never content) to the container log and forwards the request unmodified.
