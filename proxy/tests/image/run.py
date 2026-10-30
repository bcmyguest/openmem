#!/usr/bin/env python3
"""Image check: run the context-proxy hook inside the pinned LiteLLM image against a fake upstream.

Manual, needs Docker; not part of `unittest discover` (the name does not start with test_). Run from the repo root:

    python3 proxy/tests/image/run.py [--image IMAGE] [--port 4199] [--keep]

The image defaults to the context-proxy service's image in compose.yaml. Checks, for /v1/messages,
/v1/chat/completions, /v1/responses and the Codex pass-through /backend-api/codex/responses, streamed and not:
async_pre_call_hook rewrote the upstream body (standing instruction, compressed tool result), the session database
got the messages, and async_log_success_event recorded the fake's prompt tokens in the trim state
and a usage event. Then: FTS5 from
the image's Python sqlite3, WAL on the bind mount, and the MCP tool code reading on the host while the container
writes. Containers and the network are named cbench-img-*; the work directory is removed unless --keep.
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROXY_DIR = HERE.parents[1]
REPO = PROXY_DIR.parent
NAME = "cbench-img"
MASTER_KEY = "sk-image-check"
PROMPT_TOKENS = 4321  # fake_upstream.PROMPT_TOKENS
STANDING = "Context management: to fit your context window"
COMPRESSED = "[openmem: tool result compressed"
BIG = "marker line of tool output\n" * 400


def compose_image():
    text = (REPO / "compose.yaml").read_text(encoding="utf-8")
    block = text.split("\n  context-proxy:\n", 1)[1]
    return re.search(r"^\s+image:\s*(\S+)", block, re.M).group(1)


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)


def anthropic_body(stream):
    return {"model": "claude-fake", "max_tokens": 16, "stream": stream, "system": "be brief", "messages": [
        {"role": "user", "content": [{"type": "text", "text": "marker question"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": BIG}]},
    ]}


def chat_body(stream):
    return {"model": "gpt-fake", "stream": stream, "messages": [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "marker question"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "shell", "arguments": "{\"cmd\":\"ls\"}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": BIG},
    ]}


def responses_input(turns=1):
    items = []
    for t in range(turns):
        items += [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": f"marker question {t}"}]},
            {"type": "function_call", "call_id": f"c{t}", "name": "shell", "arguments": "{\"cmd\":\"ls\"}"},
            {"type": "function_call_output", "call_id": f"c{t}", "output": BIG},
        ]
    return items


def responses_body(stream, model="gpt-fake"):
    return {"model": model, "stream": stream, "instructions": "be brief", "input": responses_input()}


def codex_body(stream, sid, turns=1):
    # gpt-6-sol: LiteLLM prices the ChatGPT stream only for a mapped model; an unmapped one logs no usage.
    return {"model": "gpt-6-sol", "stream": stream, "store": False, "instructions": "be brief",
            "prompt_cache_key": sid, "input": responses_input(turns)}


def lite_headers(sid):
    return {"authorization": f"Bearer {MASTER_KEY}", "x-openmem-session-id": sid}


def codex_headers(_sid):
    return {"authorization": "Bearer fake-chatgpt-token", "chatgpt-account-id": "fake-account",
            "x-litellm-api-key": f"Bearer {MASTER_KEY}"}


CASES = [
    ("messages", "/v1/messages", anthropic_body, {"x-litellm-api-key": f"Bearer {MASTER_KEY}"}),
    ("chat", "/v1/chat/completions", chat_body, None),
    ("responses", "/v1/responses", responses_body, None),
    ("codex", "/backend-api/codex/responses", None, None),
]


def post(port, path, body, headers):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def upstream_rewritten(body):
    """(standing instruction present, tool result compressed) in the body the fake received."""
    text = json.dumps(body, ensure_ascii=False)
    return STANDING in text, COMPRESSED in text and BIG not in text


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.2)
    return fn()


def trim_tokens(sessions, sid):
    try:
        state = json.loads((sessions / f"{sid}.trim.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return ((state.get("usage") or {}).get("last") or {}).get("tokens")


def usage_event(db):
    """The newest usage event's cache counts and breakpoints, or None."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return con.execute("SELECT input_tokens, cache_read_tokens, cache_creation_tokens, breakpoints FROM events "
                           "WHERE kind = 'usage' ORDER BY id DESC LIMIT 1").fetchone()
    except sqlite3.Error:
        return None
    finally:
        con.close()


def host_count(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return con.execute("SELECT count(*) FROM messages").fetchone()[0]
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--image", default=compose_image())
    ap.add_argument("--port", type=int, default=4199)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    work = Path(tempfile.mkdtemp(prefix="openmem-image-check-"))
    log, context = work / "log", work / "state" / "context"
    sessions = context / "sessions"
    for d in (log, sessions, context / "blobs"):
        d.mkdir(parents=True, mode=0o700)
    os.chmod(work / "state", 0o700)
    os.chmod(context, 0o700)
    uid = f"{os.getuid()}:{os.getgid()}"
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print(f"{'PASS' if ok else 'FAIL'} {name}{f' ({detail})' if detail else ''}", flush=True)

    try:
        docker("network", "create", NAME)
        docker("run", "-d", "--name", f"{NAME}-fake", "--network", NAME, "--network-alias", "fake", "-u", uid,
               "-v", f"{HERE}:/h:ro", "-v", f"{log}:/log", "-e", "FAKE_LOG=/log/requests.jsonl",
               "--entrypoint", "python3", args.image, "/h/fake_upstream.py")
        docker("run", "-d", "--name", f"{NAME}-proxy", "--network", NAME, "-u", uid,
               "-p", f"127.0.0.1:{args.port}:4000", "-v", f"{PROXY_DIR}:/app/proxy:ro", "-v", f"{log}:/log",
               "-v", f"{context}:/state/context", "-e", "HOME=/tmp", "-e", "PYTHONDONTWRITEBYTECODE=1",
               "-e", "OPENMEM_STATE_DIR=/state", "-e", f"LITELLM_MASTER_KEY={MASTER_KEY}",
               "-e", "FAKE_CHATGPT_BASE=http://fake:9000/backend-api/codex", "-e", "CONTEXT_COMPRESS_OVER_TOKENS=50",
               "-e", "HINDSIGHT_URL=http://127.0.0.1:9", "-e", "PROBE_LOG=/log/probe.jsonl",
               args.image, "--config", "/app/proxy/tests/image/config.yaml", "--port", "4000")
        if not wait_for(lambda: _healthy(args.port), timeout=120):
            print(docker("logs", f"{NAME}-proxy", check=False).stderr[-3000:])
            raise SystemExit("proxy did not become healthy")
        print(f"image {args.image}", flush=True)

        upstream_log = log / "requests.jsonl"
        for name, path, build, headers in CASES:
            for stream in (False, True):
                sid = f"img-{name}-{'stream' if stream else 'json'}"
                body = codex_body(stream, sid) if name == "codex" else build(stream)
                hdrs = codex_headers(sid) if name == "codex" else {**lite_headers(sid), **(headers or {})}
                seen = upstream_log.read_text(encoding="utf-8").count("\n") if upstream_log.exists() else 0
                status, text = post(args.port, path, body, hdrs)
                label = f"{path} {'stream' if stream else 'json'}"
                check(f"{label}: answered", status == 200 and "OK" in text, f"status {status}")
                lines = upstream_log.read_text(encoding="utf-8").splitlines()[seen:]
                got = [json.loads(x) for x in lines]
                standing, compressed = upstream_rewritten(got[-1]["body"]) if got else (False, False)
                check(f"{label}: pre-call hook rewrote the upstream body", standing and compressed,
                      f"standing={standing} compressed={compressed} upstream={[g['path'] for g in got]}")
                db = sessions / f"{sid}.db"
                check(f"{label}: session database written", db.exists() and host_count(db) >= 3,
                      f"rows={host_count(db) if db.exists() else 0}")
                tokens = wait_for(lambda: trim_tokens(sessions, sid))
                check(f"{label}: success event calibrated usage", tokens == PROMPT_TOKENS, f"tokens={tokens}")
                event = wait_for(lambda: usage_event(db))
                # The fake's Anthropic usage reports cache counts; the others report only totals. The request
                # carries no cache_control, so the Anthropic route counts 0 breakpoints and the others record none.
                want = (21, PROMPT_TOKENS - 21, 0, 0) if name == "messages" else None
                ok = event == want if want else event is not None and sum(x or 0 for x in event[:3]) == PROMPT_TOKENS
                check(f"{label}: usage event recorded", ok, f"event={event}")

        # FTS5 from the image's Python sqlite3, on a database the hook wrote.
        fts = docker("exec", f"{NAME}-proxy", "python3", "-c",
                     "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                     "print(sqlite3.sqlite_version, c.execute(\"SELECT count(*) FROM messages_fts WHERE messages_fts "
                     "MATCH 'marker'\").fetchone()[0])", "/state/context/sessions/img-codex-stream.db", check=False)
        parts = fts.stdout.split()
        check("FTS5 query in the image", fts.returncode == 0 and len(parts) == 2 and int(parts[1]) > 0,
              fts.stdout.strip() or fts.stderr.strip()[-200:])
        con = sqlite3.connect(f"file:{sessions / 'img-codex-stream.db'}?mode=ro", uri=True)
        mode = con.execute("PRAGMA journal_mode").fetchone()[0]
        con.close()
        check("WAL journal on the bind mount", mode == "wal", f"journal_mode={mode}")

        # Host reader (MCP tool code) while the container writes the same database.
        sid, rounds = "img-concurrent", 15
        errors = []

        def writer():
            for turn in range(1, rounds + 1):
                try:
                    post(args.port, "/backend-api/codex/responses", codex_body(True, sid, turn), codex_headers(sid))
                except Exception as exc:  # noqa: BLE001 - reported below
                    errors.append(repr(exc))

        post(args.port, "/backend-api/codex/responses", codex_body(True, sid, 1), codex_headers(sid))
        thread = threading.Thread(target=writer)
        thread.start()
        reader = subprocess.run(["node", "--no-warnings", str(HERE / "host_reader.mjs"), sid, "30"], cwd=REPO,
                                env={**os.environ, "OPENMEM_STATE_DIR": str(work / "state")},
                                capture_output=True, text=True, timeout=180)
        thread.join()
        summary = json.loads(reader.stdout or "{}") if reader.returncode == 0 else {}
        counts = [c for c in summary.get("counts", []) if isinstance(c, int)]
        final = host_count(sessions / f"{sid}.db")
        check("host reader during container writes", reader.returncode == 0 and not summary.get("errors")
              and not errors and summary.get("sqls") == 30 and counts == sorted(counts),
              f"searches={summary.get('searches')} sqls={summary.get('sqls')} counts={counts[:1]}..{counts[-1:]} "
              f"errors={summary.get('errors') or errors or reader.stderr.strip()[-200:]}")
        check("all concurrent turns stored", final == rounds * 3, f"rows={final}")

        hook_errors = [x for x in docker("logs", f"{NAME}-proxy", check=False).stderr.splitlines()
                       if "openmem-context" in x]
        check("no hook fail-open lines in the proxy log", not hook_errors, "; ".join(hook_errors[:3]))
    finally:
        docker("rm", "-f", f"{NAME}-fake", f"{NAME}-proxy", check=False)
        docker("network", "rm", NAME, check=False)
        if args.keep:
            print(f"kept {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


def _healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health/liveliness", timeout=2) as resp:
            return resp.status == 200
    except OSError:
        return False


if __name__ == "__main__":
    sys.exit(main())
