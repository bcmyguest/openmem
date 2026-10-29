# Context proxy

The `context-proxy` compose service is a LiteLLM proxy that sits between a coding agent and Anthropic and rewrites each request before forwarding it:

1. **Tool-result compression.** A tool result over `CONTEXT_COMPRESS_OVER_TOKENS` is replaced by its first 40 and last 20 lines (capped at 4000 and 2000 characters) behind a header naming `smart_compact_get(id=...)`. The full text goes to `blobs/<id>.txt`.
2. **Trim.** When a request reaches `CONTEXT_TRIM_AT_TOKENS`, or the session's `.force` flag exists, the proxy drops every message before the last real user turn and appends the dropped content to the session's handoff log. It then puts a pointer to `smart_compact_search` at the start of the kept turn. System prompt, tools and the in-flight turn are kept verbatim. Tool call/result pairs are never split.
3. **Recall on trim.** If the session registration names a bank, the proxy adds Hindsight recall for the last user prompt (`budget: low`, 5 s timeout). When the bank has pending or processing ingest operations, it adds a line saying recent turns may not be in memory yet.

The cut is sticky. Later requests with the same history receive the same rewrite, byte for byte, so the prompt cache keeps hitting. The cut moves only on the next threshold crossing or `.force`. Recall is computed once per cut. File layout, row shape and inserted text follow [context-store.md](context-store.md).

Code: `proxy/openmem_context/` (stdlib only), `proxy/openmem_context_hook.py` (LiteLLM `async_pre_call_hook`), `proxy/config.yaml`. Tests: `python3 -m unittest discover -s proxy/tests` (part of `npm test`).

## Configuration

Set these in the stack `.env` or in the shell that runs compose.

| Variable | Default | Effect |
| --- | --- | --- |
| `CONTEXT_PROXY_ENABLED` | `1` | `0` forwards every request unmodified |
| `CONTEXT_TRIM_AT_TOKENS` | `120000` | Estimated request tokens (characters / 4) that trigger a trim |
| `CONTEXT_COMPRESS_OVER_TOKENS` | `4000` | Tool results above this are compressed; `0` disables compression |
| `CONTEXT_COMPACTION_MAX_CHARS` | `12000` | Maximum recalled characters inserted after a trim |
| `CONTEXT_PROXY_PORT` | `4100` | Host port, bound to 127.0.0.1 |
| `CONTEXT_PROXY_ENV_FILE` | `~/.config/personal-memory/context-proxy.env` | Holds `LITELLM_MASTER_KEY` (and keys for extra routes) |
| `OPENMEM_STATE_DIR` | `~/.local/share/openmem` | The proxy mounts `<dir>/context` read-write |
| `CONTEXT_PROXY_HINDSIGHT_URL` | `http://hindsight:8888` | Recall endpoint; the default needs the hindsight profile in the same compose project |

The defaults are untuned guesses.

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
