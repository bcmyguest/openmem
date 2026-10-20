"""Recording stdlib HTTP stub for sink tests.

`serving(route)` starts a loopback server on a free port and records every request as
`{"method", "path", "body"}`. `path` is the raw request target (percent-encoding preserved, query included) and
`body` is the decoded JSON body or None. `route(method, path, body) -> (status, json_value)` decides each reply;
a None json_value sends an empty body. The server needs no cleanup beyond leaving the `with` block.

`stub.headers` is a list parallel to `stub.requests` holding each request's headers as a lowercase-keyed dict.
A `multipart/form-data` request body is parsed (stdlib `email`) into `{"fields": {name: text}, "files":
[{"name", "filename", "content"}]}` with the file content decoded as UTF-8 text; every other body is decoded as
JSON, exactly as before.
"""

import json
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

Route = Callable[[str, str, Any], tuple[int, Any]]


def parse_multipart(content_type: str, raw: bytes) -> dict:
    message = BytesParser(policy=policy.HTTP).parsebytes(f"Content-Type: {content_type}\r\n\r\n".encode() + raw)
    fields: dict[str, str] = {}
    files: list[dict] = []
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = (part.get_payload(decode=True) or b"").decode()
        if part.get_filename() is not None:
            files.append({"name": name, "filename": part.get_filename(), "content": payload})
        else:
            fields[name] = payload
    return {"fields": fields, "files": files}


class RecordingStub:
    def __init__(self, route: Route):
        self.route = route
        self.requests: list[dict] = []
        self.headers: list[dict[str, str]] = []  # parallel to `requests`: lower-cased request headers
        self._lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                content_type = self.headers.get("Content-Type") or ""
                if raw and content_type.lower().startswith("multipart/form-data"):
                    body = parse_multipart(content_type, raw)
                else:
                    body = json.loads(raw) if raw else None
                with stub._lock:
                    stub.requests.append({"method": self.command, "path": self.path, "body": body})
                    stub.headers.append({key.lower(): value for key, value in self.headers.items()})
                status, reply = stub.route(self.command, self.path, body)
                data = json.dumps(reply).encode() if reply is not None else b""
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle

            def log_message(self, *_args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=5)

    def clear(self) -> None:
        with self._lock:
            self.requests.clear()
            self.headers.clear()


@contextmanager
def serving(route: Route) -> Iterator[RecordingStub]:
    stub = RecordingStub(route)
    try:
        yield stub
    finally:
        stub.close()


def closed_port_url() -> str:
    """A loopback URL nothing listens on, for unreachable-server checks."""
    with serving(lambda *_: (200, None)) as stub:
        url = stub.url
    return url
