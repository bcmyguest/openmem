"""cc_stream: stream-json parsing and the resume loop, against recorded-shape fixtures.

No model, no Docker: fixtures follow the documented stream-json types
(code.claude.com/docs/en/agent-sdk/typescript: SDKSystemMessage, SDKAssistantMessage,
SDKUserMessage, SDKCompactBoundaryMessage, SDKResultMessage). The container is a fake whose
exec() understands the commands TurnSource and ClaudeCodeStream issue.
"""

from __future__ import annotations

import asyncio
import json
import re
import shlex
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import pytest

import cc_stream
from contextbench.harbor import ENV_STREAM_COUNT, ENV_STREAM_SHA256, canonical_sha256
from contextbench.harbor.reward import harbor_rewards

FIX = Path(__file__).parent / "fixtures"
SID = "11111111-2222-4333-8444-555555555555"
OPS = [
    {"index": 0, "header": "set batch (keys 0-0)",
     "body": "<<<SET-BATCH 0000 BEGIN>>>\nSET K00001 = alpha-7\n<<<SET-BATCH 0000 END>>>"},
    {"index": 1, "header": "get", "body": "GET K00001"},
]
GOLD = {"meta": {"task_family": "kv_store"}, "queries": [{"qid": 0, "key": "K00001", "value": "alpha-7"}]}


def fx(name: str) -> str:
    return (FIX / name).read_text()


# ------------------------------------------------------------------ parse_stream
def test_parse_set_turn():
    log = cc_stream.parse_stream(fx("turn_set.jsonl"))
    assert log.session_id == SID and log.version == "2.1.300"
    assert log.last_bash == "echo READY_FOR_NEXT_OP" and log.last_bash_code == 0
    assert [s["id"] for s in log.steps] == ["msg_01", "msg_02", "msg_03"]  # msg_01 twice -> once
    assert log.steps[0]["cache_creation_input_tokens"] == 9000
    assert not log.failed and log.result["usage"]["output_tokens"] == 57
    assert log.compactions == []
    assert any("[tool_use Bash]" in m["content"] for m in log.messages)


def test_parse_flattens_list_tool_result_for_grader():
    from contextbench.graders.base import messages_text
    from contextbench.graders.kv import ANSWER_RE

    log = cc_stream.parse_stream(fx("turn_get.jsonl"))
    assert all(isinstance(m["content"], str) for m in log.messages)
    found = dict((k, v.strip()) for k, v in ANSWER_RE.findall(messages_text(log.messages)))
    assert found["K00001"] == "alpha-7"


def test_parse_compact_boundary_restarts_history_and_reads_exit_code():
    log = cc_stream.parse_stream(fx("turn_compact.jsonl"))
    assert log.compactions == [{"trigger": "auto", "pre_tokens": 120345}]
    assert log.messages[0]["content"].startswith("[compact_boundary")
    assert "kv.txt" not in "\n".join(m["content"] for m in log.messages[:1])
    assert "continued from a previous conversation" in log.messages[1]["content"]
    assert log.last_bash == "false" and log.last_bash_code == 1


def test_parse_error_result_and_garbage():
    log = cc_stream.parse_stream(fx("turn_autherr.jsonl"))
    assert log.failed and log.messages == [] and "401" in log.errors[0]
    empty = cc_stream.parse_stream("not json\n{broken\n")
    assert empty.failed and empty.result is None


# ---------------------------------------------------------------- the resume loop
@dataclass
class _Res:
    stdout: str = ""
    stderr: str = ""
    return_code: int = 0


@dataclass
class _Cfg:
    env: dict = field(default_factory=dict)
    workdir: str = "/app"


class FakeContainer:
    """Container paths map under root; /logs/agent maps to the agent's logs_dir (Harbor mount)."""

    def __init__(self, root: Path, logs: Path, turns: list[str]):
        self.root, self.logs, self.turns = root, logs, list(turns)
        self.claude_cmds: list[str] = []
        self.claude_env: list[dict] = []
        d = root / "app" / "stream"
        d.mkdir(parents=True)
        (d / "chunks.jsonl").write_text("".join(json.dumps(o) + "\n" for o in OPS))
        self.task_env_config = _Cfg({ENV_STREAM_COUNT: str(len(OPS)), ENV_STREAM_SHA256: canonical_sha256(OPS)})

    def host(self, path: str) -> Path:
        if path.startswith("/logs/agent"):
            return self.logs / path[len("/logs/agent"):].lstrip("/")
        return self.root / path.lstrip("/")

    async def upload_file(self, source, target: str) -> None:
        dst = self.host(target)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dst)

    async def exec(self, command: str, env: dict | None = None, timeout_sec: int | None = None, **_):
        if " claude " in command:
            self.claude_cmds.append(command)
            self.claude_env.append(dict(env or {}))
            n = int(re.search(r"cc-turn-(\d{4})\.jsonl", command).group(1))
            name = self.turns.pop(0)
            (self.logs / f"cc-turn-{n:04d}.jsonl").write_text(fx(name))
            if name != "turn_autherr.jsonl":
                sess = self.logs / "sessions" / "projects" / "-app"
                sess.mkdir(parents=True, exist_ok=True)
                (sess / f"{SID}.jsonl").touch()
            return _Res()
        argv = shlex.split(command)
        if argv[0] == "cat":
            p = self.host(argv[1])
            return _Res(p.read_text()) if p.exists() else _Res("", "missing", 1)
        if argv[:2] == ["rm", "-rf"]:
            shutil.rmtree(self.host(argv[2]), ignore_errors=True)
            return _Res()
        if argv[:2] == ["test", "-e"]:
            return _Res(return_code=0 if self.host(argv[2]).exists() else 1)
        if argv[0] == "mkdir":
            return _Res()
        raise AssertionError(f"unexpected command {command!r}")


class _Ctx:
    metadata: dict | None = None


def _run(tmp_path: Path, turns: list[str], **kw):
    logs = tmp_path / "agent"
    logs.mkdir()
    env = FakeContainer(tmp_path / "c", logs, turns)
    agent = cc_stream.ClaudeCodeStream(
        logs_dir=logs, model_name="anthropic/claude-haiku-5-5",
        extra_env={"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-test", "ANTHROPIC_BASE_URL": "http://172.17.0.1:4200",
                   "DISABLE_AUTO_COMPACT": "1"}, **kw)
    agent.cc_session_id = SID
    agent.session_id = "trial__agent"  # Harbor overwrites this; the adapter must not use it
    ctx = _Ctx()
    asyncio.run(agent.run("TASK STATEMENT", env, ctx))
    return agent, env, ctx, logs


def test_run_default_keeps_task_in_first_user_message(tmp_path):
    agent, env, ctx, logs = _run(tmp_path, ["turn_set.jsonl", "turn_get.jsonl"])
    assert len(env.claude_cmds) == 2
    assert f"--session-id {SID}" in env.claude_cmds[0] and "--resume" not in env.claude_cmds[0]
    assert f"--resume {SID}" in env.claude_cmds[1]
    assert all("--append-system-prompt" not in c for c in env.claude_cmds)
    assert all("--permission-mode=bypassPermissions" in c and "--output-format=stream-json" in c
               for c in env.claude_cmds)
    snap0 = json.loads((logs / "context_snapshots" / "turn-0000.json").read_text())
    assert snap0["messages"][0]["content"].startswith("TASK STATEMENT\n\n=== set batch")
    e = env.claude_env[0]
    assert e["ANTHROPIC_MODEL"] == "claude-haiku-5-5" and e["IS_SANDBOX"] == "1"
    assert e["DISABLE_AUTO_COMPACT"] == "1" and e["CLAUDE_CONFIG_DIR"] == "/logs/agent/sessions"
    assert ctx.metadata["terminated_by"] == "stream_exhausted" and ctx.metadata["n_ops_delivered"] == 2
    numeric, _ = harbor_rewards(logs, GOLD)
    assert numeric["reward"] == 1.0 and numeric["graded_from_code"] == 3


def test_run_pin_instruction_flag(tmp_path):
    agent, env, ctx, logs = _run(tmp_path, ["turn_set.jsonl", "turn_get.jsonl"], pin_instruction="true")
    assert all("--append-system-prompt-file /tmp/cb_cc/system.txt" in c for c in env.claude_cmds)
    assert (env.root / "tmp" / "cb_cc" / "system.txt").read_text() == "TASK STATEMENT"
    snap0 = json.loads((logs / "context_snapshots" / "turn-0000.json").read_text())
    assert snap0["messages"][0]["content"].startswith("=== set batch")


def test_run_retries_failed_turn_with_same_prompt(tmp_path):
    agent, env, ctx, logs = _run(tmp_path, ["turn_autherr.jsonl", "turn_set.jsonl", "turn_get.jsonl"])
    assert len(env.claude_cmds) == 3
    assert "--session-id" in env.claude_cmds[1]  # nothing was saved, so the id is still fresh
    assert ctx.metadata["terminated_by"] == "stream_exhausted"


def test_run_gives_up_after_repeated_failures(tmp_path):
    with pytest.raises(RuntimeError, match="claude failed 3x"):
        _run(tmp_path, ["turn_autherr.jsonl"] * 3)


def test_run_records_compaction(tmp_path):
    # set -> compact turn ends on a failing command (no advance) -> reminder -> get
    agent, env, ctx, logs = _run(tmp_path, ["turn_set.jsonl", "turn_compact.jsonl", "turn_get.jsonl"])
    assert ctx.metadata["compactions"] == [{"trigger": "auto", "pre_tokens": 120345}]
    snap1 = json.loads((logs / "context_snapshots" / "turn-0001.json").read_text())
    assert snap1["messages"][0]["content"].startswith("[compact_boundary")
    prompt = (env.root / "tmp" / "cb_cc" / "prompt.txt").read_text()
    assert prompt.startswith("[Your turn ended without running")  # reminder delivered before the GET turn
    assert harbor_rewards(logs, GOLD)[0]["reward"] == 1.0


# ------------------------------------------------------------------- strict mode
def test_parse_strict_reply_tools_and_retries():
    log = cc_stream.parse_stream(fx("strict_nomarker.jsonl"))
    assert log.init_tools == ["mcp__openmem__smart_compact_search", "mcp__openmem__smart_compact_get"]
    assert log.tool_uses == ["mcp__openmem__smart_compact_search"]
    assert log.retries and log.retries[0]["error_status"] == 429
    assert "READY_FOR_NEXT_OP later" in log.reply and log.last_bash is None


def test_run_strict_advances_on_reply_marker(tmp_path):
    agent, env, ctx, logs = _run(tmp_path, ["strict_set.jsonl", "strict_nomarker.jsonl", "strict_get.jsonl"],
                                 strict="true", openmem_mcp="true",
                                 disallowed_tools="Bash,Write,mcp__openmem__memory_add")
    assert len(env.claude_cmds) == 3
    assert all('--tools "" --strict-mcp-config --mcp-config /tmp/cb_cc/mcp.json' in c for c in env.claude_cmds)
    assert all("--disallowedTools Bash,Write,mcp__openmem__memory_add" in c for c in env.claude_cmds)
    mcp = json.loads((env.root / "tmp" / "cb_cc" / "mcp.json").read_text())["mcpServers"]["openmem"]
    assert mcp["command"] == "/opt/node/bin/node" and mcp["args"] == ["/repo/cli/openmem-mcp.mjs"]
    assert mcp["env"]["OPENMEM_STATE_DIR"] == "/state"
    snap0 = json.loads((logs / "context_snapshots" / "turn-0000.json").read_text())
    assert "STRICT MODE" in snap0["messages"][0]["content"]
    # the no-marker turn (marker mentioned mid-sentence) did not advance and got the reply-mode reminder
    assert (env.root / "tmp" / "cb_cc" / "prompt.txt").read_text().startswith("[No READY_FOR_NEXT_OP")
    m = ctx.metadata
    assert m["terminated_by"] == "stream_exhausted" and m["n_ops_delivered"] == 2
    assert m["tool_uses"] == {"mcp__openmem__smart_compact_search": 1}
    assert m["init_tools"][0] == "mcp__openmem__smart_compact_search" and len(m["retry_events"]) == 1
    assert harbor_rewards(logs, GOLD)[0]["reward"] == 1.0


def test_openmem_mcp_requires_strict(tmp_path):
    with pytest.raises(ValueError, match="needs strict"):
        cc_stream.ClaudeCodeStream(logs_dir=tmp_path, model_name="anthropic/claude-haiku-5-5", openmem_mcp="true")
