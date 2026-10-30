"""Claude Code on a ContextBench stream: one `claude -p --resume <id>` per op.

ContextBench's cb_stream() refuses ClaudeCode (contextbench/harbor/wrap.py: only codex and
mini-swe-agent). This mirrors its _CodexResume strategy:

    harbor trial start -p cb/tasks/kv-store-R2000-seed42 -e docker \
        -a cc_stream:ClaudeCodeStream -m anthropic/claude-haiku-5-5 \
        --agent-kwarg context_budget_tokens=1000000 --ae DISABLE_AUTO_COMPACT=1 ...

Sources checked (2026-10-29):
  * code.claude.com/docs/en/headless "Continue conversations": `claude -p --resume <id>` continues a
    session; cli-reference: `--session-id <uuid>` fixes the id up front, `--fork-session` is what
    would create a new one, so the id (and the proxy's x-claude-code-session-id key) stays stable.
  * agent-sdk/typescript: stream-json events `system/init` (session_id, claude_code_version, model),
    `assistant` (message: BetaMessage with id + usage, parent_tool_use_id), `user` (tool results),
    `system/compact_boundary` (compact_metadata.trigger, .pre_tokens), `result` (subtype, is_error,
    num_turns, duration_ms, total_cost_usd, usage, modelUsage).
  * agent-sdk/cost-tracking: result.total_cost_usd/modelUsage include spend restored from a resumed
    session (v2.1.277+), so they are cumulative; per-step input/cache usage comes from assistant
    messages deduplicated by message.id; per-step output_tokens is a placeholder (use result.usage).
  * sessions.md: the session JSONL format is internal and changes between releases, so history is
    rebuilt from stream-json (documented), not from the JSONL.
  * headless "bare mode": --bare does not read CLAUDE_CODE_OAUTH_TOKEN, so it is not used.
  * harbor 0.16.1 agents/installed/claude_code.py: install(), env (IS_SANDBOX=1,
    CLAUDE_CONFIG_DIR=/logs/agent/sessions, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1), and
    `claude --verbose --output-format=stream-json ... --print -- <prompt>` are reused here.

strict (default False): the "strict" ContextBench variant. Claude Code gets no built-in tools
(`--tools ""` plus Harbor's disallowed_tools kwarg for --disallowedTools) and only the MCP servers in
mcp_config (`--strict-mcp-config`), so a value can only come from context or from those MCP tools.
Readiness then comes from the reply text, as in ContextBench's own runner (contextbench/runner.py:
proto.is_ready_line): a turn whose assistant text has READY_FOR_NEXT_OP on a line of its own
advances; any other turn gets proto.NO_MARKER_TEXT. STRICT_NOTE is appended to the instruction.

openmem_mcp (default False, needs strict): write a stdio MCP config for OpenMem's server
(node <node> <repo>/cli/openmem-mcp.mjs, OPENMEM_STATE_DIR=<state>) to {WORK}/mcp.json and pass it with
--mcp-config. The repo, a Node build and the arm's proxy state dir must be mounted into the
container (harbor --mounts-json); the state dir is mounted at the proxy's own /state so the
pointer's log path is valid in the container.

mcp_env (default empty, needs openmem_mcp): extra env for the MCP server, a JSON object (Harbor parses
--agent-kwarg mcp_env='{...}' into a dict) merged over the defaults, so HINDSIGHT_URL can be overridden.
"{sid8}" in a value becomes the first 8 characters of the Claude Code session id (a per-trial bank).

stop_hook (default False, needs openmem_mcp): pass --settings with one Stop hook that runs OpenMem's
hook-runner (claude-code stop, stderr to /logs/agent/stop-hook.err) with HOME={WORK}/mcp-home and the MCP's HINDSIGHT_URL, write
coding-agent.json mapping /app to bank "cbench-s3d-<sid8>", and tell the agent that bank in the
instruction. Arm s3d-recall (design b in semantic-arms.md).

extra_note (default empty): one more line appended to the instruction after STRICT_NOTE (arm
s3c-semantic-nudged: 'Prefer smart_compact_search mode "semantic" for questions about earlier content.').

pin_instruction (default False): the task statement is the first user message, together with op 0,
as in ContextBench's codex adapter. True moves it into --append-system-prompt-file (the workaround
for a proxy that drops the first user message on trim).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import Any

WORK = "/tmp/cb_cc"
CONFIG_DIR = "/logs/agent/sessions"  # same as Harbor's ClaudeCode
TRUE = ("1", "true", "yes", "on")
PASS_ENV = (
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "DISABLE_AUTO_COMPACT", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_THINKING_TOKENS", "ENABLE_TOOL_SEARCH",
)


STRICT_NOTE = """
## STRICT MODE (this overrides the turn protocol and storage advice above)

In this run you have NO shell, file or sub-agent tools: there is no `bash` tool, you cannot run
`echo`, and there is no disk to offload to or `grep`. Everything you need later must stay in this
conversation. If any tools are listed for you, you may use them.

- Answer an operation by writing its ANSWER block directly in your reply text.
- End EVERY reply with READY_FOR_NEXT_OP on a line of its own. That line replaces
  `echo READY_FOR_NEXT_OP`: it is what advances the stream. A reply without it does not advance.
"""
READY_COMMAND = "echo READY_FOR_NEXT_OP"  # what a reply-line marker counts as (TurnSource.pending)
MCP_SERVER = "openmem"
MCP_TOOLS = ("smart_compact_search", "smart_compact_get")


@dataclass
class TurnLog:
    """One `claude -p` invocation, parsed from its stream-json stdout."""

    session_id: str | None = None
    version: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)  # main-loop, after the prompt
    compactions: list[dict[str, Any]] = field(default_factory=list)  # compact_metadata per boundary
    steps: list[dict[str, Any]] = field(default_factory=list)  # one usage dict per API response
    result: dict[str, Any] | None = None
    last_bash: str | None = None
    last_bash_code: int = 1
    errors: list[str] = field(default_factory=list)
    texts: list[str] = field(default_factory=list)  # main-loop assistant text blocks
    tool_uses: list[str] = field(default_factory=list)  # main-loop tool_use names, in order
    init_tools: list[str] | None = None
    init_mcp: list[dict[str, Any]] | None = None
    retries: list[dict[str, Any]] = field(default_factory=list)  # system events whose subtype has "retry"

    @property
    def reply(self) -> str:
        return "\n".join(self.texts)

    @property
    def failed(self) -> bool:
        return self.result is None or bool(self.result.get("is_error"))


def _block_text(block: Any) -> str:
    if not isinstance(block, dict):
        return str(block)
    kind = block.get("type")
    if kind == "text":
        return str(block.get("text") or "")
    if kind == "tool_use":
        return f"[tool_use {block.get('name')}] {json.dumps(block.get('input'), ensure_ascii=False)}"
    if kind == "tool_result":
        content = block.get("content")
        if isinstance(content, list):
            content = "\n".join(_block_text(c) for c in content)
        return str(content or "")
    if kind in ("thinking", "redacted_thinking"):
        return ""  # not visible to the grader as an answer; keeps snapshots comparable across arms
    return str(block.get("text") or block.get("content") or "")


def flatten(role: str, content: Any) -> dict[str, Any]:
    """Anthropic content blocks -> one string message the ContextBench graders can scan.

    graders/base.messages_text() reads item["text"] or item["content"] and would str() a list-valued
    tool_result, escaping the newlines inside an ANSWER block, so everything becomes plain text.
    """
    if isinstance(content, list):
        text = "\n".join(t for t in (_block_text(b) for b in content) if t)
    else:
        text = "" if content is None else str(content)
    return {"role": role, "content": text}


def parse_stream(text: str) -> TurnLog:
    """Parse stream-json stdout (non-JSON lines such as stderr are skipped)."""
    log = TurnLog()
    seen: set[str] = set()
    calls: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind, sub = ev.get("type"), ev.get("subtype")
        if kind == "system" and sub == "init":
            log.session_id = ev.get("session_id") or log.session_id
            log.version = ev.get("claude_code_version") or log.version
            if log.init_tools is None:
                log.init_tools = list(ev.get("tools") or [])
                log.init_mcp = list(ev.get("mcp_servers") or [])
        elif kind == "system" and "retry" in str(sub or ""):
            log.retries.append({k: v for k, v in ev.items() if k not in ("uuid", "session_id")})
        elif kind == "system" and sub == "compact_boundary":
            meta = dict(ev.get("compact_metadata") or {})
            log.compactions.append(meta)
            log.messages = [{"role": "user", "content": f"[compact_boundary {json.dumps(meta)}]"}]
        elif kind in ("assistant", "user") and not ev.get("parent_tool_use_id"):
            msg = ev.get("message") or {}
            content = msg.get("content")
            log.messages.append(flatten(msg.get("role") or kind, content))
            if kind == "assistant":
                mid = msg.get("id")
                if mid and mid not in seen and isinstance(msg.get("usage"), dict):
                    seen.add(mid)
                    log.steps.append({"id": mid, **msg["usage"]})
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                if kind == "assistant" and b.get("type") == "text":
                    log.texts.append(str(b.get("text") or ""))
                if kind == "assistant" and b.get("type") == "tool_use":
                    log.tool_uses.append(str(b.get("name")))
                if b.get("type") == "tool_use" and b.get("name") == "Bash":
                    calls[b.get("id")] = str((b.get("input") or {}).get("command") or "")
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in calls:
                    log.last_bash = calls[b["tool_use_id"]]
                    log.last_bash_code = 1 if b.get("is_error") else 0
        elif kind == "result":
            log.result = ev
            log.session_id = ev.get("session_id") or log.session_id
            log.errors += [str(e) for e in ev.get("errors") or []]
    return log


def _make_agent_class():
    from harbor.agents.installed.claude_code import ClaudeCode
    from contextbench import stream as proto
    from contextbench.harbor.wrap import TURN_ENDED_TEXT, _StreamChain, unwrap_shell

    class ClaudeCodeStream(_StreamChain, ClaudeCode):
        """Claude Code, one resumed `claude -p` per ContextBench user turn."""

        def __init__(self, *args: Any, context_budget_tokens: int = 1000000,
                     context_budget_reserve_tokens: int = 2048, max_steps: int = 100000,
                     max_consecutive_reminders: int = 20, max_failures: int = 3,
                     turn_timeout: int = 1800, pin_instruction: bool = False, strict: bool = False,
                     openmem_mcp: bool = False, mcp_node: str = "/opt/node/bin/node",
                     mcp_repo: str = "/repo", mcp_state_dir: str = "/state", mcp_env: Any = "",
                     stop_hook: bool = False, extra_note: str = "", **kwargs: Any):
            super().__init__(*args, **kwargs)
            self._cb_init(context_budget_tokens, context_budget_reserve_tokens, max_steps)
            self.cb_max_reminders = int(max_consecutive_reminders)
            self.cb_max_failures = int(max_failures)
            self.cb_turn_timeout = int(turn_timeout)
            self.pin_instruction = str(pin_instruction).strip().lower() in TRUE
            self.strict = str(strict).strip().lower() in TRUE
            self.openmem_mcp = str(openmem_mcp).strip().lower() in TRUE
            if self.openmem_mcp and not self.strict:
                raise ValueError("openmem_mcp needs strict=true")
            self.mcp_node, self.mcp_repo, self.mcp_state_dir = mcp_node, mcp_repo, mcp_state_dir
            self.cc_session_id = str(uuid.uuid4())
            self.started = False
            raw = json.loads(mcp_env) if isinstance(mcp_env, str) and mcp_env.strip() else (mcp_env or {})
            self.mcp_env = {str(k): str(v).replace("{sid8}", self.cc_session_id[:8]) for k, v in raw.items()}
            self.stop_hook = str(stop_hook).strip().lower() in TRUE
            self.extra_note = str(extra_note or "").strip()
            if (self.mcp_env or self.stop_hook) and not self.openmem_mcp:
                raise ValueError("mcp_env/stop_hook need openmem_mcp=true")
            self.hook_bank = f"cbench-s3d-{self.cc_session_id[:8]}" if self.stop_hook else None

        @staticmethod
        def name() -> str:
            return "claude-code-contextbench"

        def _env(self) -> dict[str, str]:
            env = {k: v for k in PASS_ENV if (v := (self._get_env(k) or "").strip())}
            model = (self.model_name or "").split("/")[-1]  # a known id keeps Claude Code's 1M window
            env.update({
                "ANTHROPIC_MODEL": model, "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model, "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                "CLAUDE_CODE_SUBAGENT_MODEL": model,
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
                "IS_SANDBOX": "1", "CLAUDE_CONFIG_DIR": CONFIG_DIR,
            })
            return env

        def mcp_config(self) -> dict[str, Any]:
            return {"mcpServers": {MCP_SERVER: {
                "type": "stdio", "command": self.mcp_node,
                "args": [f"{self.mcp_repo}/cli/openmem-mcp.mjs"],
                "env": {"OPENMEM_STATE_DIR": self.mcp_state_dir, "HOME": f"{WORK}/mcp-home",
                        "HINDSIGHT_URL": "http://127.0.0.1:9", **self.mcp_env},
            }}}

        async def _write_stop_hook(self, environment: Any) -> None:
            url = self.mcp_env.get("HINDSIGHT_URL", "http://127.0.0.1:9")
            home = f"{WORK}/mcp-home"
            hook = (f"HOME={home} HINDSIGHT_URL={url} {self.mcp_node} "
                    f"{self.mcp_repo}/cli/coding-agent/hook-runner.mjs claude-code stop "
                    "2>>/logs/agent/stop-hook.err")
            settings = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": hook, "timeout": 60}]}]}}
            await environment.exec(f"mkdir -p {home}/.config/personal-memory", timeout_sec=60)
            await self._cb_put_text(environment, json.dumps({"mapPathToBank": {"/app": self.hook_bank}}),
                                    f"{home}/.config/personal-memory/coding-agent.json")
            await self._cb_put_text(environment, json.dumps(settings), f"{WORK}/settings.json")

        def _command(self, n: int) -> str:
            ident = f"--resume {self.cc_session_id}" if self.started else f"--session-id {self.cc_session_id}"
            # build_cli_flags(): Harbor's ClaudeCode flags (permission_mode defaults to
            # bypassPermissions; disallowed_tools etc. via --agent-kwarg).
            flags = f"{ident} {self.build_cli_flags()} --output-format=stream-json --verbose"
            if self.pin_instruction:
                flags += f" --append-system-prompt-file {WORK}/system.txt"
            if self.strict:
                flags += ' --tools "" --strict-mcp-config'
                if self.openmem_mcp:
                    flags += f" --mcp-config {WORK}/mcp.json"
                if self.stop_hook:
                    flags += f" --settings {WORK}/settings.json"
            return (f'export PATH="$HOME/.local/bin:$PATH"; cd /app; claude {flags} '
                    f'--print -- "$(cat {WORK}/prompt.txt)" 2>&1 </dev/null '
                    f"| tee /logs/agent/cc-turn-{n:04d}.jsonl")

        async def _turn(self, environment: Any, prompt: str, n: int) -> TurnLog:
            await self._cb_put_text(environment, prompt, f"{WORK}/prompt.txt")
            await environment.exec(self._command(n), env=self._env(), timeout_sec=self.cb_turn_timeout)
            path = self.logs_dir / f"cc-turn-{n:04d}.jsonl"
            log = parse_stream(path.read_text(errors="replace") if path.is_file() else "")
            if log.session_id and log.session_id != self.cc_session_id:
                raise RuntimeError(f"session id changed: {self.cc_session_id} -> {log.session_id}")
            return log

        async def run(self, instruction: str, environment: Any, context: Any) -> None:
            ts = await self.cb_setup(environment)
            await environment.exec(f"mkdir -p {WORK} {WORK}/mcp-home {CONFIG_DIR}/projects/-app", timeout_sec=60)
            if self.openmem_mcp:
                await self._cb_put_text(environment, json.dumps(self.mcp_config(), indent=2), f"{WORK}/mcp.json")
            if self.strict:
                instruction = instruction.rstrip("\n") + "\n" + STRICT_NOTE
            if self.extra_note:
                instruction = instruction.rstrip("\n") + "\n" + self.extra_note + "\n"
            if self.stop_hook:
                await self._write_stop_hook(environment)
                instruction += (f'\nTurns removed from your context are stored in memory bank "{self.hook_bank}"; '
                                f'call memory_recall(query=..., bank="{self.hook_bank}") before answering anything '
                                "you cannot see.\n")
            first = ts.first_turn(turn=0) or ""
            if self.pin_instruction:
                await self._cb_put_text(environment, instruction, f"{WORK}/system.txt")
                prompt = first
            else:
                prompt = instruction.rstrip("\n") + "\n\n" + first
            usable, n, reminders, failures = self.cb_budget - self.cb_reserve, 0, 0, 0
            history: list[dict[str, Any]] = []
            compactions: list[dict[str, Any]] = []
            version = None
            init_tools, init_mcp = None, None
            tool_uses: dict[str, int] = {}
            retries: list[dict[str, Any]] = []
            try:
                while not ts.done:
                    if n >= self.cb_max_steps:
                        ts.terminate("max_steps")
                        break
                    log = await self._turn(environment, prompt, n)
                    n += 1
                    version = log.version or version
                    if init_tools is None and log.init_tools is not None:
                        init_tools, init_mcp = log.init_tools, log.init_mcp
                    for t in log.tool_uses:
                        tool_uses[t] = tool_uses.get(t, 0) + 1
                    retries += log.retries
                    if (self.logs_dir / "sessions" / "projects" / "-app" / f"{self.cc_session_id}.jsonl").is_file():
                        self.started = True  # a retry must --resume, --session-id would collide
                    if log.failed and not log.messages:
                        failures += 1
                        if failures >= self.cb_max_failures:
                            raise RuntimeError(f"claude failed {failures}x: {log.errors or log.result}")
                        continue  # nothing reached the session; same prompt again
                    failures, self.started = 0, True
                    if log.compactions:  # parse_stream already restarted messages at the boundary
                        compactions += log.compactions
                        history = list(log.messages)
                    else:
                        history += [{"role": "user", "content": prompt}, *log.messages]
                    tokens = self.cb_snapshot(history, "turn", {"compactions": len(compactions)})
                    if self.strict:  # readiness from the reply, as contextbench/runner.py does
                        ready = proto.is_ready_line(log.reply)
                        texts = ts.pending(READY_COMMAND, 0, turn=n) if ready else []
                    else:
                        cmd = unwrap_shell(log.last_bash or "")
                        texts = ts.pending(cmd, log.last_bash_code, turn=n) if log.last_bash else []
                    if ts.done:
                        break
                    if tokens > usable:
                        ts.terminate("budget_wall")
                        break
                    if texts:
                        reminders, prompt = 0, "\n\n".join(texts)
                    else:
                        reminders += 1
                        if reminders > self.cb_max_reminders:
                            ts.terminate("max_steps")
                            break
                        prompt = proto.NO_MARKER_TEXT if self.strict else TURN_ENDED_TEXT
            except asyncio.CancelledError:
                ts.terminate("timeout")
                raise
            finally:
                ts.write()
                meta = {"session_id": self.cc_session_id, "claude_code_version": version,
                        "n_invocations": n, "pin_instruction": self.pin_instruction,
                        "compactions": compactions, "peak_context_tokens": self.cb_peak_tokens,
                        "terminated_by": ts.terminated_by, "n_ops_delivered": ts.n_delivered,
                        "n_ops_total": ts.n_total, "strict": self.strict,
                        "openmem_mcp": self.openmem_mcp, "init_tools": init_tools,
                        "init_mcp_servers": init_mcp, "tool_uses": tool_uses, "retry_events": retries}
                if self.mcp_env:
                    meta["mcp_env"] = self.mcp_env
                if self.stop_hook:
                    meta["stop_hook_bank"] = self.hook_bank
                if self.extra_note:
                    meta["extra_note"] = self.extra_note
                (self.logs_dir / "cc_stream.json").write_text(json.dumps(meta, indent=2) + "\n")
                context.metadata = meta

        def populate_context_post_run(self, context: Any) -> None:
            meta = dict(context.metadata or {})
            try:
                super().populate_context_post_run(context)  # Harbor's trajectory.json from the JSONL
            except Exception:
                pass
            context.metadata = {**(context.metadata or {}), **meta}

    return ClaudeCodeStream


try:
    ClaudeCodeStream = _make_agent_class()
except ImportError:  # parse_stream stays importable without harbor/contextbench
    ClaudeCodeStream = None
