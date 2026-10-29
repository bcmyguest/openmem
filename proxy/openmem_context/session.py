"""Session id resolution, in contract order."""

import hashlib
import json
import re

from .store import sanitize_sid

_LEGACY_USER_ID_RE = re.compile(r"_session_([0-9A-Za-z-]{8,})$")
_FALLBACK_HEADERS = ("session_id", "x-session-id", "conversation_id")


def _headers(data):
    psr = data.get("proxy_server_request") or {}
    raw = psr.get("headers") or {}
    return {str(k).lower(): v for k, v in raw.items()} if isinstance(raw, dict) else {}


def _body(data):
    psr = data.get("proxy_server_request") or {}
    body = psr.get("body")
    return body if isinstance(body, dict) else {}


def _from_user_id(user_id):
    if not isinstance(user_id, str) or not user_id:
        return None
    try:
        parsed = json.loads(user_id)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and parsed.get("session_id"):
        return str(parsed["session_id"])
    m = _LEGACY_USER_ID_RE.search(user_id)
    return m.group(1) if m else None


def _first_user_text(adapter, items):
    for item in items or ():
        if isinstance(item, dict) and adapter.is_turn_start(item):
            return adapter.user_text(item)
    return ""


def resolve_session_id(data, adapter, items):
    """Sanitized session id: OpenMem header, Claude Code header, metadata.user_id, OpenAI/Codex fields, fp-."""
    headers = _headers(data)
    body = _body(data)
    sid = headers.get("x-openmem-session-id") or headers.get("x-claude-code-session-id")
    if not sid:
        for meta in (data.get("metadata"), body.get("metadata")):
            if isinstance(meta, dict):
                sid = _from_user_id(meta.get("user_id"))
                if sid:
                    break
    if not sid:
        sid = data.get("prompt_cache_key") or body.get("prompt_cache_key")
    if not sid:
        for name in _FALLBACK_HEADERS:
            if headers.get(name):
                sid = headers[name]
                break
    if sid:
        return sanitize_sid(sid)
    seed = adapter.system_text(data) + _first_user_text(adapter, items)
    return "fp-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]
