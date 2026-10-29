# Meridian route (Claude subscription)

Route the three Hindsight aliases through [Meridian](https://github.com/rynfar/meridian), a local proxy that serves a signed-in Claude subscription over the Anthropic Messages and OpenAI Chat Completions APIs. Hindsight still calls `http://litellm:4000/v1`; only the override YAML changes.

```
hindsight ──openai──▶ litellm:4000 ──anthropic/──▶ host.docker.internal:3456 (Meridian) ──Agent SDK──▶ Claude subscription
```

Checked against Meridian 1.87.0 docs and LiteLLM docs on 2026-10-29. Nothing below was run end to end; steps marked **unverified** rest on docs alone.

## Prerequisites

| Need | Why |
| --- | --- |
| Node.js 22+ | [Meridian quick start](https://github.com/rynfar/meridian#quick-start) |
| Claude Code CLI, signed in (`claude login`) | Meridian runs requests through the Agent SDK with those credentials. Haiku 5.5 needs Claude Code 2.1.293+ ([Haiku 5.5](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#haiku-55)) |
| Claude Pro or Max plan | Requests count against plan limits |
| OpenMem stack set up | `node scripts/setup.mjs` has run once |

## Run Meridian

```sh
npm install -g @rynfar/meridian
claude login
```

Meridian binds `127.0.0.1:3456` by default. The LiteLLM container reaches the host through `host.docker.internal` (`extra_hosts: host-gateway` in `compose.yaml`), which resolves to the Docker bridge address, not loopback, so a loopback-only Meridian is unreachable from the container on Linux. Bind all interfaces and require a key:

| Variable | Value | Source |
| --- | --- | --- |
| `MERIDIAN_HOST` | `0.0.0.0` (default `127.0.0.1`) | [Configuration table](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#configuration) |
| `MERIDIAN_PORT` | `3456` (default) | same |
| `MERIDIAN_API_KEY` | long random secret. Clients send it as `x-api-key` or `Authorization: Bearer`; `/` and `/health` stay open | [API Key Authentication](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#api-key-authentication) |

`0.0.0.0` also exposes port 3456 on every host interface; firewall it to the Docker bridge if the machine sits on a shared network.

```sh
install -d -m 700 ~/.config/meridian
printf 'MERIDIAN_HOST=0.0.0.0\nMERIDIAN_API_KEY=%s\n' "$(openssl rand -hex 32)" > ~/.config/meridian/meridian.env
chmod 600 ~/.config/meridian/meridian.env
set -a; . ~/.config/meridian/meridian.env; set +a
meridian
```

### Keep it running

Meridian documents a Nix Home Manager user service and a [systemd socket-activation example](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#systemd-socket-activation). For an npm install it ships `bin/meridian-launchd.sh`, a POSIX launcher it documents as usable "as a systemd `ExecStart`" ([Running as a service without drift](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#running-as-a-service-without-drift)); the launcher self-updates at start unless `MERIDIAN_NO_SELF_UPDATE=1`.

The unit below is **unverified** (written from those docs, not tested). Replace `ExecStart` with the output of `echo "$(npm root -g)/@rynfar/meridian/bin/meridian-launchd.sh"`, and set `PATH` so the unit finds the same `node` and `npm` as your shell (nvm and volta installs live outside the systemd default `PATH`).

```ini
# ~/.config/systemd/user/meridian.service
[Unit]
Description=Meridian proxy (Claude subscription)

[Service]
EnvironmentFile=%h/.config/meridian/meridian.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/lib/node_modules/@rynfar/meridian/bin/meridian-launchd.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now meridian
loginctl enable-linger "$USER"   # keep it running while logged out
```

**Docker alternative (unverified).** Meridian publishes no image; build it from the repo (`docker build -t meridian .`) and mount `~/.claude` ([Docker, single account](https://github.com/rynfar/meridian/blob/main/docs/deployment.md#single-account)). The image already sets `CLAUDE_PROXY_HOST=0.0.0.0`. Attach it to the stack network with `docker network connect openmem_default meridian` and use `api_base: http://meridian:3456`; nothing is then published to the host. Set `MERIDIAN_HOST_ID` and persist the volumes listed under [Persistence and host identity](https://github.com/rynfar/meridian/blob/main/docs/deployment.md#persistence-and-host-identity).

## Provider choice: `anthropic/`

| | `anthropic/<model>` → `/v1/messages` | `openai/<model>` → `/v1/chat/completions` |
| --- | --- | --- |
| Meridian path | Primary API; Meridian's docs describe LiteLLM on this route (`passthrough` adapter, [Claude Code behind a gateway](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#claude-code-behind-a-gateway)) | Supported; headerless tool loops get a derived session key ([OpenAI-compatible tools](https://github.com/rynfar/meridian/blob/main/docs/agents.md#openai-compatible-tools-open-webui-continue-etc)) |
| Tool calls (`memory-reflect`) | LiteLLM translates OpenAI `tools` to Anthropic `tool_use` ([function calling](https://docs.litellm.ai/docs/providers/anthropic#functiontool-calling)); Meridian returns calls to the client in passthrough mode ([Passthrough Mode](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#passthrough-mode-and-tool-calling)) | Meridian translates OpenAI tools itself |
| `reasoning_effort` | LiteLLM maps it to `thinking` (budget 1024/2048/4096, or adaptive + `output_config.effort` on 4.6+ models) ([thinking](https://docs.litellm.ai/docs/providers/anthropic#usage---thinking--reasoning)). Drop it, below | Meridian's handling undocumented |
| `response_format` | LiteLLM converts it to native `output_format` on models it knows, else to a forced tool call ([structured outputs](https://docs.litellm.ai/docs/providers/anthropic#structured-outputs)). Meridian's handling of `output_format` is **unverified** | Meridian's handling undocumented |

Use `anthropic/`: it is the route Meridian documents for LiteLLM and gives the request shape LiteLLM translates most predictably. Fall back to `openai/<model>` with `api_base: http://host.docker.internal:3456/v1` if retain fails on structured output.

LiteLLM appends `/v1/messages` to `api_base`, so `api_base` has no `/v1` ([Custom API Base](https://docs.litellm.ai/docs/providers/anthropic#custom-api-base)). LiteLLM sends `api_key` as `x-api-key`, which Meridian accepts.

## Thinking and token limits

The shipped `enable_thinking: false` is a llama.cpp chat-template flag; Claude ignores it. Remove it.

| Setting | Behavior through Meridian |
| --- | --- |
| Thinking off | Meridian refuses explicit `thinking: disabled` on Haiku 5.5 with HTTP 400 before generation ([Haiku 5.5](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#haiku-55)). Send no thinking parameter; `additional_drop_params: ["reasoning_effort"]` stops LiteLLM generating one from Hindsight's `reasoning_effort` ([Specify params to drop](https://docs.litellm.ai/docs/completion/drop_params#specify-params-to-drop)) |
| `HINDSIGHT_API_*_MAX_COMPLETION_TOKENS`, LiteLLM `max_tokens` | Ignored by default: the Agent SDK has no output cap, so Meridian does not bound the answer ([Known limitations](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#known-limitations)). Reflect tool calls are never truncated, and output is unbounded |
| `MERIDIAN_ENFORCE_MAX_TOKENS=1` | Enforces the cap on thinking plus text. With reflect at 2048, adaptive thinking can consume the budget, and a cap that lands mid tool call fails the request. Leave unset |
| `temperature`, `top_p` | Meridian's Claude docs do not say whether these reach the model; assume ignored (**unverified**). The README's "does not expose … sampling controls" sentence describes the Antigravity CLI backend, not Claude |

## Route file

`~/.config/hindsight/litellm.yaml` replaces the backend route entirely. Model ids must appear in Meridian's `GET /v1/models`; `claude-haiku-5-5` is Meridian's `haiku` default and `claude-sonnet-5-5` appears in its client examples ([Pi](https://github.com/rynfar/meridian/blob/main/docs/agents.md#pi)). Reflect gets the larger model, as in the shipped routes.

```yaml
# LiteLLM routes for Hindsight, backend: Meridian on the host (Claude subscription).
# See docs/meridian-litellm.md. MERIDIAN_API_KEY lives in ~/.config/hindsight/litellm.env.
model_list:
  - model_name: memory-retain
    litellm_params:
      model: anthropic/claude-haiku-5-5
      api_base: http://host.docker.internal:3456
      api_key: os.environ/MERIDIAN_API_KEY
      max_tokens: 4096
      timeout: 300
      additional_drop_params: ["reasoning_effort"]
  - model_name: memory-reflect
    litellm_params:
      model: anthropic/claude-sonnet-5-5
      api_base: http://host.docker.internal:3456
      api_key: os.environ/MERIDIAN_API_KEY
      max_tokens: 4096
      timeout: 300
      additional_drop_params: ["reasoning_effort"]
  - model_name: memory-consolidate
    litellm_params:
      model: anthropic/claude-haiku-5-5
      api_base: http://host.docker.internal:3456
      api_key: os.environ/MERIDIAN_API_KEY
      max_tokens: 4096
      timeout: 300
      additional_drop_params: ["reasoning_effort"]

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

## With the wizard

`./setup` step "3. Model backend" option 4, **Claude subscription (Meridian)**, automates [Route file](#route-file) and [Apply](#apply). It does not install or start Meridian; run it first as in [Run Meridian](#run-meridian).

| Step | What the wizard does |
| --- | --- |
| Ask | Meridian URL from the host (default `http://127.0.0.1:3456`, port from `MERIDIAN_PORT` in `~/.config/meridian/meridian.env`) and an optional `MERIDIAN_API_KEY` (blank reuses the environment, `meridian.env`, or `litellm.env`) |
| Probe | `GET /health` and `GET /v1/models` (with `x-api-key`) from the host, then `/health` on the `docker0` address. Answering on 127.0.0.1 but not on `docker0` means a loopback-only bind: it warns to set `MERIDIAN_HOST=0.0.0.0`. Without `docker0` it states the requirement |
| Models | Retain and consolidate: `claude-haiku-5-5`, reflect: `claude-sonnet-5-5`, when listed; otherwise the first listed Haiku and Sonnet ids. Unreachable Meridian: the guide defaults |
| Write | The route file above as `~/.config/hindsight/litellm.yaml` (an existing one is copied to `litellm.yaml.bak-<timestamp>`), `MERIDIAN_API_KEY` in `litellm.env` (mode 600; `placeholder` when Meridian runs without a key), and `[model] backend = "meridian"` in `wizard.conf` and `config.toml` |

Non-interactive: `PM_BACKEND=meridian MERIDIAN_BASE=http://127.0.0.1:3456 MERIDIAN_API_KEY=... ./setup --yes`. `[model.meridian] host` in `config.toml` sets `MERIDIAN_BASE`; `PM_DEFAULT_MODEL` and `PM_REFLECT_MODEL` pick models. `--dry-run` probes and prints the plan without writing. Then run the [Smoke test](#smoke-test); the wizard's host-side probe does not prove the container reaches Meridian through a firewall.

## Apply

```sh
cd ~/personal-memory   # this checkout
[ -f ~/.config/hindsight/litellm.yaml ] && cp ~/.config/hindsight/litellm.yaml ~/.config/hindsight/litellm.yaml.bak-$(date +%Y%m%d%H%M%S)
$EDITOR ~/.config/hindsight/litellm.yaml          # paste the route file
grep -h '^MERIDIAN_API_KEY' ~/.config/meridian/meridian.env >> ~/.config/hindsight/litellm.env
node scripts/setup.mjs
docker compose up -d --force-recreate litellm
```

`--force-recreate` matters: Compose does not see edits inside the mounted YAML, so a plain `up -d` can keep the old routes. Revert by moving the override aside and rerunning the last two commands.

## Smoke test

LiteLLM publishes no host port; run curl on the stack network (`openmem_default`, from `name: openmem`).

```sh
set -a; . ~/.config/hindsight/litellm.env; set +a
net="--network openmem_default --add-host host.docker.internal:host-gateway"

# 1. Meridian reachable from a container, models listed
docker run --rm $net curlimages/curl -s http://host.docker.internal:3456/health
docker run --rm $net curlimages/curl -s -H "x-api-key: $MERIDIAN_API_KEY" http://host.docker.internal:3456/v1/models

# 2. Alias answers through LiteLLM
docker run --rm $net curlimages/curl -s http://litellm:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"memory-retain","messages":[{"role":"user","content":"Reply with OK."}]}'

# 3. Reflect returns a tool call (expect finish_reason "tool_calls")
docker run --rm $net curlimages/curl -s http://litellm:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"memory-reflect","reasoning_effort":"low","messages":[{"role":"user","content":"What is the weather in Paris? Use the tool."}],
       "tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city",
       "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
```

Then run a smoke retain and reflect through Hindsight, as for any route change ([Model configuration](model-configuration.md#verify-and-migrate)).

## Caveats

| Topic | Detail |
| --- | --- |
| Terms | Subscription use through third-party proxies is governed by Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms); see also Claude Code's [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) |
| Third-party detection | Meridian reports Claude refusing Pi traffic as third-party ("Third-party apps now draw from your extra usage, not your plan limits") until Pi's prompt fingerprint is scrubbed ([Pi](https://github.com/rynfar/meridian/blob/main/docs/agents.md#pi)). Whether Hindsight's prompts trigger the same is **unverified**; watch Meridian's `/telemetry` |
| Plan limits | Retain runs on every ingest; indexing a large repo spends plan quota. `GET /v1/usage/quota` shows the windows |
| Concurrency | Meridian serializes requests that share a session identity and can return `400 This session advanced while the request was waiting` ([Concurrent requests](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#concurrent-requests-to-the-same-session)). Keep `HINDSIGHT_API_LLM_MAX_CONCURRENT=1` (shipped default) |
| System prompt | Meridian can prepend Claude Code's own system prompt per adapter (SDK feature toggles at `/settings`). An [adapter instance](https://github.com/rynfar/meridian/blob/main/docs/agents.md#adapter-instances) matching `userAgentPrefix: "litellm/"` can turn it off; effect on Hindsight output is **unverified** |
| Exposure | `MERIDIAN_HOST=0.0.0.0` without `MERIDIAN_API_KEY` gives anyone on the network your subscription |
| Server tools | Anthropic server tools (`web_search_*`, `web_fetch_*`) return 400 through Meridian; Hindsight does not use them |
