"""Claude Code (`claude -p`) as Compact-Bench's continuation agent and summarizer.

The harness's continuation (e1_runner.episode) is a Messages tool loop: up to 8 model calls,
max_tokens 4096, tools read_file and run_command. Here the same history is written as a Claude Code
session file and continued with `claude -p --resume <sid>`:

  * tools: the harness's two tools via cb_tools_mcp.py (mcp__cb__read_file, mcp__cb__run_command);
    `--tools ""` removes every built-in tool and `--strict-mcp-config` every other MCP server. The
    openmem method adds OpenMem's MCP server restricted to the three smart_compact tools.
  * --max-turns 8 (the harness's 8 steps), CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 (CONT_MAX_TOKENS).
  * history tool names are rewritten to the MCP names (read_file -> mcp__cb__read_file), since
    Claude Code only offers MCP tools under the mcp__<server>__ prefix.
  * each call gets its own CLAUDE_CONFIG_DIR, so the user's hooks, plugins, CLAUDE.md and settings
    do not apply; the OAuth token comes from the env (CLAUDE_CODE_OAUTH_TOKEN), never printed.

The session JSONL format is internal to Claude Code; write_session() writes the minimal user /
assistant entries that `--resume` loads (verified with Claude Code 2.1.280, see README).
Usage, cost and tool calls come from the stream-json events, parsed with cc_stream.parse_stream.
"""

import json
import os
import re
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
sys.path.insert(0, BENCH)
from cc_stream import parse_stream  # noqa: E402

MODEL = os.environ.get("CBO_MODEL", "claude-haiku-5-5")
CLAUDE = os.environ.get("CBO_CLAUDE", "claude")
MAX_TURNS = 8          # e1_runner.episode(..., 8, ...)
CONT_MAX_TOKENS = 4096  # cb_common.CONT_MAX_TOKENS
CB_SERVER = "cb"
CB_TOOLS = {"read_file": "mcp__cb__read_file", "run_command": "mcp__cb__run_command"}
OM_SERVER = "openmem"
OM_TOOLS = ("mcp__openmem__smart_compact_search", "mcp__openmem__smart_compact_get",
            "mcp__openmem__smart_compact_sql")
OM_DENY = ("memory_add", "memory_capture_initiative", "memory_consolidate", "memory_export", "memory_forget",
           "memory_import", "memory_pages_list", "memory_pages_read", "memory_pages_search", "memory_project_scope",
           "memory_provider_status", "memory_recall", "memory_reflect", "memory_search", "memory_status")
SUMMARY_SYSTEM = "You are a helpful assistant."
# Haiku 5.5 list prices, USD per MTok, prompts up to 100k tokens (platform.claude.com pricing, saved in
# ../pricing.md): input, 5-minute cache write, 1-hour cache write, cache read, output. Claude Code 2.1.280
# reports costBasis "unknown" for this model and a total_cost_usd about 30x these prices, so cost is
# recomputed from the result event's usage. A subscription run is not billed per token.
PRICE = {"input": 0.10, "write_5m": 0.125, "write_1h": 0.20, "read": 0.01, "output": 0.50}


def project_slug(cwd):
    """Claude Code's projects/<slug> directory name for a working directory."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def rename_tools(messages):
    """Copy of messages with tool_use names mapped to their MCP names."""
    out = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            c = [{**b, "name": CB_TOOLS.get(b.get("name"), b.get("name"))}
                 if isinstance(b, dict) and b.get("type") == "tool_use" else b for b in c]
        out.append({**m, "content": c})
    return out


def write_session(config_dir, cwd, sid, messages, version):
    """Write messages as a Claude Code session file; returns its path."""
    path = os.path.join(config_dir, "projects", project_slug(cwd), f"{sid}.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    parent = None
    with open(path, "w", encoding="utf-8") as fh:
        for i, m in enumerate(messages):
            mid = str(uuid.uuid4())
            entry = {"parentUuid": parent, "isSidechain": False, "userType": "external", "cwd": cwd,
                     "sessionId": sid, "version": version, "type": m["role"], "uuid": mid, "timestamp": _now()}
            if m["role"] == "assistant":
                content = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
                stop = "tool_use" if any(b.get("type") == "tool_use" for b in content) else "end_turn"
                entry["message"] = {"id": f"msg_cbo_{i:04d}", "type": "message", "role": "assistant",
                                    "model": MODEL, "content": content, "stop_reason": stop,
                                    "stop_sequence": None, "usage": {"input_tokens": 0, "output_tokens": 0}}
            else:
                entry["message"] = {"role": "user", "content": m["content"]}
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            parent = mid
    return path


def _env(config_dir, max_output):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_"))}
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if not token:
        raise RuntimeError("CLAUDE_CODE_OAUTH_TOKEN is not set (run.sh loads it from the token file)")
    env.update({
        "CLAUDE_CODE_OAUTH_TOKEN": token, "CLAUDE_CONFIG_DIR": config_dir,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTO_COMPACT": "1",
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(max_output),
        "MAX_THINKING_TOKENS": "0",  # the harness's Messages call sends no thinking parameter
        "ANTHROPIC_MODEL": MODEL, "ANTHROPIC_DEFAULT_HAIKU_MODEL": MODEL,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": MODEL, "ANTHROPIC_DEFAULT_OPUS_MODEL": MODEL,
        "CLAUDE_CODE_SUBAGENT_MODEL": MODEL,
    })
    return env


def list_cost_usd(usage):
    """Haiku 5.5 list-price cost of a result event's usage (all prompts assumed under 100k tokens)."""
    if not usage:
        return 0.0
    cc = usage.get("cache_creation") or {}
    w1h = cc.get("ephemeral_1h_input_tokens", 0)
    w5m = cc.get("ephemeral_5m_input_tokens", usage.get("cache_creation_input_tokens", 0) - w1h)
    total = (usage.get("input_tokens", 0) * PRICE["input"] + w5m * PRICE["write_5m"] + w1h * PRICE["write_1h"]
             + usage.get("cache_read_input_tokens", 0) * PRICE["read"] + usage.get("output_tokens", 0) * PRICE["output"])
    return round(total / 1e6, 6)


LIMIT_RE = re.compile(r"429|529|rate.?limit|usage limit|limit reached|overloaded|too many requests", re.I)
RESET_RE = re.compile(r"\|(\d{10})\b")


def limit_wait(rec, attempt):
    """Seconds to wait before retrying a call that hit a rate or usage limit, or None if it did not.

    A run with no result event (crash, timeout) or an is_error result other than error_max_turns (an API
    error after Claude Code's own retries) also counts, so it is retried rather than scored.
    """
    text = " ".join([rec.get("result_text") or "", *map(str, rec.get("errors") or [])])
    api_error = rec.get("is_error") and rec.get("subtype") != "error_max_turns"
    if rec.get("subtype") is None or api_error or LIMIT_RE.search(text):
        m = RESET_RE.search(text)  # "Claude AI usage limit reached|<epoch>"
        if m:
            return max(60, int(m.group(1)) - int(time.time()) + 60)
        return min(1800, 60 * 2 ** attempt)
    return None


def claude_version():
    out = subprocess.run([CLAUDE, "--version"], capture_output=True, text=True).stdout
    return out.split()[0] if out.split() else "unknown"


def _summarize_log(log, raw_path, extra=None):
    r = log.result or {}
    return {"session_id": log.session_id, "version": log.version, "init_tools": log.init_tools,
            "init_mcp": log.init_mcp, "tool_uses": log.tool_uses, "num_turns": r.get("num_turns"),
            "subtype": r.get("subtype"), "is_error": r.get("is_error"), "cost_usd": list_cost_usd(r.get("usage")),
            "cc_reported_cost_usd": r.get("total_cost_usd"),
            "usage": r.get("usage"), "model_usage": r.get("modelUsage"), "duration_ms": r.get("duration_ms"),
            "steps": log.steps, "errors": log.errors, "retry_events": len(log.retries),
            "result_text": (r.get("result") or "")[:500] if r.get("is_error") or log.failed else "", "reply_tail": log.reply[-800:], "stream": raw_path,
            **(extra or {})}


def run_claude(args, cwd, env, stdin_text, raw_path, timeout):
    """Run claude, tee stream-json to raw_path, return the parsed TurnLog."""
    with open(raw_path, "w", encoding="utf-8") as out:
        try:
            subprocess.run([CLAUDE, *args], cwd=cwd, env=env, input=stdin_text, stdout=out,
                           stderr=subprocess.STDOUT, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            out.write('\n{"type":"cbo_timeout"}\n')
    with open(raw_path, encoding="utf-8", errors="replace") as fh:
        return parse_stream(fh.read())


def summarize(user_text, work_dir, max_tokens):
    """One summarizer call through Claude Code: no tools, no MCP, one turn. Returns (text or None, record)."""
    config_dir = os.path.join(work_dir, "cc-config-summary")
    os.makedirs(config_dir, exist_ok=True)
    args = ["-p", "--model", MODEL, "--output-format", "stream-json", "--verbose", "--tools", "",
            "--strict-mcp-config", "--max-turns", "1", "--system-prompt", SUMMARY_SYSTEM]
    raw = os.path.join(work_dir, "summary.stream.jsonl")
    log = run_claude(args, work_dir, _env(config_dir, max_tokens), user_text, raw, 1800)
    return (None if log.failed else log.reply), _summarize_log(log, raw)


def continue_session(messages, final, cwd, venv, harness_dir, work_dir, openmem=None, timeout=3600):
    """Continue `messages` (Anthropic format, harness tool names) with the user message `final` in cwd.

    `final` goes in through `--input-format stream-json`, so a list of content blocks (the openmem
    pointer block ahead of the continuation text) reaches the model as the proxy renders it.

    openmem: None, or dict(node, repo, state_dir, system) to add OpenMem's MCP server (only the
    smart_compact tools allowed) and append `system` (the standing instruction) to the system prompt.
    Returns a record with the TurnLog summary and the harness-style tool log.
    """
    os.makedirs(work_dir, exist_ok=True)
    config_dir = os.path.join(work_dir, "cc-config")
    sid = (openmem or {}).get("session_id") or str(uuid.uuid4())
    version = claude_version()
    session_file = write_session(config_dir, cwd, sid, rename_tools(messages), version)
    tool_log = os.path.join(work_dir, "cb-tools.jsonl")
    open(tool_log, "w").close()
    servers = {CB_SERVER: {"type": "stdio", "command": sys.executable,
                           "args": [os.path.join(HERE, "cb_tools_mcp.py")],
                           "env": {"CB_HARNESS": harness_dir, "CB_TASK_CWD": cwd, "CB_TASK_VENV": venv or "",
                                   "CB_TOOL_LOG": tool_log, "PYTHONUTF8": "1"}}}
    allowed = list(CB_TOOLS.values())
    if openmem:
        servers[OM_SERVER] = {"type": "stdio", "command": openmem["node"],
                              "args": [os.path.join(openmem["repo"], "cli", "openmem-mcp.mjs")],
                              "env": {"OPENMEM_STATE_DIR": openmem["state_dir"],
                                      "HOME": os.path.join(work_dir, "mcp-home"),
                                      "HINDSIGHT_URL": "http://127.0.0.1:9", "CONTEXT_STORE_TTL_DAYS": "0"}}
        os.makedirs(os.path.join(work_dir, "mcp-home"), exist_ok=True)
        allowed += list(OM_TOOLS)
    mcp_path = os.path.join(work_dir, "mcp.json")
    with open(mcp_path, "w", encoding="utf-8") as fh:
        json.dump({"mcpServers": servers}, fh, indent=2)
    args = ["-p", "--resume", sid, "--model", MODEL, "--output-format", "stream-json", "--verbose",
            "--tools", "", "--strict-mcp-config", "--mcp-config", mcp_path,
            "--allowedTools", ",".join(allowed), "--max-turns", str(MAX_TURNS), "--input-format", "stream-json"]
    if openmem:
        # openmem-mcp.mjs also serves the memory_* tools (no memory provider here); remove them so only the
        # three smart_compact tools are listed.
        args += ["--disallowedTools", ",".join(f"mcp__{OM_SERVER}__{t}" for t in OM_DENY),
                 "--append-system-prompt", openmem["system"]]
    raw = os.path.join(work_dir, "continue.stream.jsonl")
    line = json.dumps({"type": "user", "message": {"role": "user", "content": final["content"]},
                       "parent_tool_use_id": None, "session_id": sid}, ensure_ascii=False) + "\n"
    log = run_claude(args, cwd, _env(config_dir, CONT_MAX_TOKENS), line, raw, timeout)
    with open(tool_log, encoding="utf-8") as fh:
        tlog = [tuple(json.loads(line)) for line in fh if line.strip()]
    return _summarize_log(log, raw, {"resumed_session": session_file, "harness_tools": tlog,
                                     "history_messages": len(messages)})
