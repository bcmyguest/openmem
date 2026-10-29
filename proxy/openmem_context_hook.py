"""LiteLLM callback: `litellm_settings.callbacks: openmem_context_hook.handler`.

Thin wrapper; all logic lives in the dependency-free openmem_context package next to this file.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from litellm.integrations.custom_logger import CustomLogger  # noqa: E402

from openmem_context import process_request, process_usage  # noqa: E402


class OpenMemContextHook(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        # File and Hindsight I/O run off the event loop; process_request never raises.
        return await asyncio.to_thread(process_request, data, call_type)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        # Streams arrive here once, with the assembled response. kwargs carries the litellm_call_id that
        # async_pre_call_hook saw in data; process_usage never raises.
        await asyncio.to_thread(process_usage, kwargs, response_obj)


handler = OpenMemContextHook()
