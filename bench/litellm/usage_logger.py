"""LiteLLM callback: one JSONL row per upstream request with Anthropic usage.

Rows go to $BENCH_USAGE_LOG. The arm is $BENCH_ARM (one proxy container per arm) and, as a
cross-check, the x-bench-arm request header. Token fields come from LiteLLM's standard logging
payload: for Anthropic, prompt_tokens = input + cache_creation + cache_read
(litellm/llms/anthropic/chat/transformation.py calculate_usage), so input is derived.
trimmed / n_compressed scan the messages actually sent (after openmem_context_hook).
"""

import json
import os
import threading
import time

from litellm.integrations.custom_logger import CustomLogger

LOG = os.environ.get("BENCH_USAGE_LOG", "/results/usage.jsonl")
ARM = os.environ.get("BENCH_ARM")
TRIM_MARK = "[openmem: continuing session"
COMPRESS_MARK = "[openmem: tool result compressed,"
_lock = threading.Lock()


def _lower(h):
    return {str(k).lower(): v for k, v in (h or {}).items()} if isinstance(h, dict) else {}


def headers(kwargs, slo):
    lp = kwargs.get("litellm_params") or {}
    for h in ((slo.get("metadata") or {}).get("requester_custom_headers"),
              (lp.get("proxy_server_request") or {}).get("headers"),
              (lp.get("metadata") or {}).get("headers")):
        if h:
            return _lower(h)
    return {}


def _num(v):
    return int(v) if isinstance(v, (int, float)) else 0


def usage(slo, response_obj):
    raw = response_obj.get("usage") if isinstance(response_obj, dict) else None
    if isinstance(raw, dict) and "input_tokens" in raw:  # non-streamed Anthropic body
        cr, cw = _num(raw.get("cache_read_input_tokens")), _num(raw.get("cache_creation_input_tokens"))
        return {"input": _num(raw.get("input_tokens")), "cache_read": cr, "cache_write": cw,
                "cache_write_1h": _num((raw.get("cache_creation") or {}).get("ephemeral_1h_input_tokens")),
                "output": _num(raw.get("output_tokens")), "source": "response"}
    u = (slo.get("metadata") or {}).get("usage_object") or {}
    prompt = _num(u.get("prompt_tokens") or slo.get("prompt_tokens"))
    cr, cw = _num(u.get("cache_read_input_tokens")), _num(u.get("cache_creation_input_tokens"))
    details = ((u.get("prompt_tokens_details") or {}).get("cache_creation_token_details") or {})
    return {"input": max(prompt - cr - cw, 0), "cache_read": cr, "cache_write": cw,
            "cache_write_1h": _num(details.get("ephemeral_1h_input_tokens")),
            "output": _num(u.get("completion_tokens") or slo.get("completion_tokens")), "source": "slo"}


def row(kwargs, response_obj, start, end, ok):
    slo = kwargs.get("standard_logging_object") or {}
    h = headers(kwargs, slo)
    msgs = slo.get("messages") or kwargs.get("messages") or []
    text = json.dumps(msgs, ensure_ascii=False) if not isinstance(msgs, str) else msgs
    out = {"ts": time.time(), "ok": ok, "arm": ARM, "arm_header": h.get("x-bench-arm"),
           "session": h.get("x-claude-code-session-id"), "model": slo.get("model") or kwargs.get("model"),
           "call_type": slo.get("call_type") or kwargs.get("call_type"),
           "latency_s": (end - start).total_seconds() if start and end else None,
           "n_messages": len(msgs) if isinstance(msgs, list) else None,
           "trimmed": TRIM_MARK in text, "n_compressed": text.count(COMPRESS_MARK)}
    if ok:
        out.update(usage(slo, response_obj))
    else:
        out["error"] = str(slo.get("error_str") or "")[:500]
    return out


class BenchUsageLogger(CustomLogger):
    def _write(self, *args):
        try:
            line = json.dumps(row(*args), default=str) + "\n"
            with _lock, open(LOG, "a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception as exc:  # logging must never break a request
            print(f"usage_logger: {exc!r}", flush=True)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._write(kwargs, response_obj, start_time, end_time, True)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._write(kwargs, response_obj, start_time, end_time, False)


handler = BenchUsageLogger()
