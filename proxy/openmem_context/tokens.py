"""Deterministic token estimate: characters / 4, with a flat charge for binary attachments."""

import hashlib
import json

# Block types whose payload is binary (base64) rather than text.
BINARY_BLOCK_TYPES = frozenset({"image", "document", "input_image", "input_file", "image_url", "file"})
# Flat charge per binary block, in characters (about 1600 tokens).
BINARY_BLOCK_CHARS = 6400


def text_tokens(text):
    return (len(text) + 3) // 4


def _chars(value):
    if isinstance(value, str):
        return len(value)
    if isinstance(value, dict):
        if value.get("type") in BINARY_BLOCK_TYPES:
            return BINARY_BLOCK_CHARS
        return sum(len(str(k)) + _chars(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return sum(_chars(v) for v in value)
    if value is None:
        return 0
    return len(str(value))


def estimate_tokens(*values):
    return (sum(_chars(v) for v in values) + 3) // 4


def _normalize(value):
    if isinstance(value, dict):
        out = {k: _normalize(v) for k, v in value.items() if k != "cache_control"}
        content = out.get("content")
        if (isinstance(content, list) and len(content) == 1 and isinstance(content[0], dict)
                and content[0].get("type") == "text" and set(content[0]) == {"type", "text"}):
            out["content"] = content[0]["text"]
        return out
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def fingerprint(value):
    """Stable hash of a message, ignoring key order, cache_control markers and single-text-block wrapping.

    Claude Code marks the newest message with cache_control and sends its content as one text block; on later
    requests the marker is gone and the same content is a plain string. Both shapes must hash the same.
    """
    blob = json.dumps(_normalize(value), sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]
