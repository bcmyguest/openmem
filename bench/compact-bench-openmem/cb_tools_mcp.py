#!/usr/bin/env python3
"""Stdio MCP server exposing Compact-Bench's two continuation tools to Claude Code.

The tools are the harness's own: the names, descriptions and schemas come from
harness/e1_runner.TOOLS_SPEC, and calls go to e1_runner.read_file / e1_runner.run_cmd, so the
command allow-list, 120 s timeout, 3000/8000-character output caps, scrubbed environment and
venv-first PATH are the harness's. Claude Code sees them as mcp__cb__read_file and
mcp__cb__run_command.

Environment: CB_HARNESS (compact-bench/harness dir), CB_TASK_CWD (repository working dir),
CB_TASK_VENV (instance venv), CB_TOOL_LOG (optional JSONL of calls, for the tool log).
"""

import json
import os
import sys

sys.path.insert(0, os.environ["CB_HARNESS"])
import e1_runner as R  # noqa: E402

CWD = os.environ["CB_TASK_CWD"]
VENV = os.environ.get("CB_TASK_VENV") or None
LOG = os.environ.get("CB_TOOL_LOG")
PROTOCOL = "2025-06-18"


def _tools():
    return [{"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]}
            for t in R.TOOLS_SPEC]


def _call(name, args):
    if name == "read_file":
        out, entry = R.read_file(args.get("file_path", ""), CWD), ["read", args.get("file_path", "")]
    elif name == "run_command":
        out = R.run_cmd(args.get("command", ""), CWD, venv=VENV)
        entry = ["cmd", (args.get("command") or "")[:200]]
    else:
        raise ValueError(f"unknown tool {name}")
    if LOG:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return out


def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # notification
    if method == "initialize":
        result = {"protocolVersion": msg.get("params", {}).get("protocolVersion", PROTOCOL),
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "cb", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": _tools()}
    elif method == "tools/call":
        p = msg.get("params") or {}
        try:
            text, err = _call(p.get("name"), p.get("arguments") or {}), False
        except Exception as exc:  # reported to the model as a tool error
            text, err = f"error: {exc}", True
        result = {"content": [{"type": "text", "text": text}], "isError": err}
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        reply = handle(json.loads(line))
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
