"""Callbacks for the image check config (proxy/tests/image/config.yaml). Test-only.

Loads the real hook from /app/proxy, points LiteLLM's Codex pass-through at the fake upstream instead of
chatgpt.com, and adds a probe that records what each callback received (types and keys only) in $PROBE_LOG.
LiteLLM parses a pass-through stream as a Responses stream only for chatgpt.com (is_openai_compatible_url), so the
fake host is accepted there too; without that the usage of a fake Codex stream reads as zero.
"""

import json
import os
import sys

sys.path.insert(0, "/app/proxy")

import openmem_context_hook  # noqa: E402
from litellm.integrations.custom_logger import CustomLogger  # noqa: E402
from litellm.proxy.pass_through_endpoints import codex_passthrough_endpoints  # noqa: E402
from litellm.proxy.pass_through_endpoints.llm_provider_handlers import openai_passthrough_logging_handler as oai  # noqa: E402

FAKE_BASE = os.environ["FAKE_CHATGPT_BASE"]
codex_passthrough_endpoints.CHATGPT_API_BASE = FAKE_BASE
_is_openai_compatible_url = oai.is_openai_compatible_url
oai.is_openai_compatible_url = lambda url: str(url or "").startswith(FAKE_BASE) or _is_openai_compatible_url(url)
PROBE_LOG = os.environ.get("PROBE_LOG", "/log/probe.jsonl")


def _write(entry):
    with open(PROBE_LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, default=str) + "\n")


class Probe(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        _write({"event": "pre_call", "call_type": str(getattr(call_type, "value", call_type)),
                "keys": sorted(data), "litellm_call_id": data.get("litellm_call_id"),
                "logging_obj_call_id": getattr(data.get("litellm_logging_obj"), "litellm_call_id", None),
                "route": getattr(user_api_key_dict, "request_route", None)})
        return data

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        _write({"event": "success", "call_type": kwargs.get("call_type"), "litellm_call_id": kwargs.get("litellm_call_id"),
                "response_type": type(response_obj).__name__,
                "response_keys": sorted(response_obj) if isinstance(response_obj, dict) else None,
                "usage": str(getattr(response_obj, "usage", None) if not isinstance(response_obj, dict) else response_obj.get("usage"))[:300],
                "inner": str(response_obj.get("response") if isinstance(response_obj, dict) else None)[:600],
                "slo_prompt_tokens": (kwargs.get("standard_logging_object") or {}).get("prompt_tokens")})


handler = openmem_context_hook.handler
probe = Probe()
