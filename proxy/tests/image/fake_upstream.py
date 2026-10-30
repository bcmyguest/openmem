"""Fake model upstream for the image check (proxy/tests/image/run.sh). Stdlib only.

Answers Anthropic /v1/messages, OpenAI /v1/chat/completions and /v1/responses, and the ChatGPT Codex
/backend-api/codex/responses route, streamed or not, each reporting PROMPT_TOKENS prompt tokens. Every request is
appended to $FAKE_LOG as one JSON line: path, the names of the headers it carried, and the body.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROMPT_TOKENS = 4321
LOG = os.environ.get("FAKE_LOG", "/log/requests.jsonl")


def sse(events):
    return "".join(f"event: {name}\ndata: {json.dumps(body)}\n\n" for name, body in events).encode()


def anthropic(body):
    usage = {"input_tokens": 21, "cache_read_input_tokens": PROMPT_TOKENS - 21, "cache_creation_input_tokens": 0,
             "output_tokens": 2}
    msg = {"id": "msg_fake", "type": "message", "role": "assistant", "model": body.get("model", "claude"),
           "content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn", "stop_sequence": None,
           "usage": usage}
    if not body.get("stream"):
        return "application/json", json.dumps(msg).encode()
    start = {**msg, "content": [], "stop_reason": None, "usage": {**usage, "output_tokens": 0}}
    return "text/event-stream", sse([
        ("message_start", {"type": "message_start", "message": start}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "OK"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                           "usage": {"output_tokens": 2}}),
        ("message_stop", {"type": "message_stop"}),
    ])


def chat(body):
    usage = {"prompt_tokens": PROMPT_TOKENS, "completion_tokens": 2, "total_tokens": PROMPT_TOKENS + 2}
    base = {"id": "chatcmpl-fake", "created": 1, "model": body.get("model", "gpt")}
    if not body.get("stream"):
        return "application/json", json.dumps({**base, "object": "chat.completion", "usage": usage, "choices": [
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "OK"}}]}).encode()
    chunks = [
        {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "OK"}}]},
        {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {**base, "object": "chat.completion.chunk", "choices": [], "usage": usage},
    ]
    return "text/event-stream", ("".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n").encode()


def responses(body):
    usage = {"input_tokens": PROMPT_TOKENS, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 2,
             "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": PROMPT_TOKENS + 2}
    item = {"id": "msg_fake", "type": "message", "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": "OK", "annotations": []}]}
    resp = {"id": "resp_fake", "object": "response", "created_at": 1, "status": "completed",
            "model": body.get("model", "gpt"), "output": [item], "usage": usage, "parallel_tool_calls": True,
            "tool_choice": "auto", "tools": []}
    if not body.get("stream"):
        return "application/json", json.dumps(resp).encode()
    pending = {**resp, "status": "in_progress", "output": [], "usage": None}
    return "text/event-stream", sse([
        ("response.created", {"type": "response.created", "sequence_number": 0, "response": pending}),
        ("response.output_item.added", {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0,
                                        "item": {**item, "status": "in_progress", "content": []}}),
        ("response.output_text.delta", {"type": "response.output_text.delta", "sequence_number": 2, "item_id": "msg_fake",
                                        "output_index": 0, "content_index": 0, "delta": "OK"}),
        ("response.output_item.done", {"type": "response.output_item.done", "sequence_number": 3, "output_index": 0,
                                       "item": item}),
        ("response.completed", {"type": "response.completed", "sequence_number": 4, "response": resp}),
    ])


ROUTES = {
    "/v1/messages": anthropic,
    "/v1/chat/completions": chat,
    "/chat/completions": chat,
    "/v1/responses": responses,
    "/responses": responses,
    "/backend-api/codex/responses": responses,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        body = json.loads(raw or b"{}")
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"path": path, "headers": sorted(k.lower() for k in self.headers.keys()),
                                 "body": body}) + "\n")
        handler = ROUTES.get(path)
        if handler is None:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        ctype, payload = handler(body)
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("FAKE_PORT", "9000"))), Handler).serve_forever()
