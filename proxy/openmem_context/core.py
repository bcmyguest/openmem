"""Request rewriting: tool-result compression, sticky trim, recall injection.

Pure stdlib. The LiteLLM hook calls process_request(data, call_type) before each request and
process_usage(kwargs, response) after each success; tests call them directly.
"""

import sys
import threading
import time
import traceback
from collections import OrderedDict
from pathlib import Path

from . import recall as recall_mod
from .adapters import UnsupportedCallType, adapter_for, strip_reminders
from .session import resolve_session_id
from .settings import Settings
from .store import RegistrationNotFound, Store, session_lock
from .tokens import DEFAULT_CHARS_PER_TOKEN, estimate_prompt_tokens, fingerprint, record_usage, request_chars

MAX_THREADS = 32
# Requests awaiting their usage report, by litellm_call_id: (sid, thread root, request chars).
MAX_PENDING = 256
RECALL_QUERY_MAX_CHARS = 2000
# Added to the system prompt of every request while trimming is on, before any trim; constant, so the cached
# prefix never changes. Same text as STANDING_INSTRUCTION in cli/coding-agent/context-trim.mjs.
STANDING_INSTRUCTION = (
    "Context management: to fit your context window, older turns may be removed and replaced by an "
    "[openmem: …] pointer. Removed content is saved, not forgotten. Before answering anything that depends on "
    "earlier content you cannot see in your context — values, ids, keys, counts, decisions — call "
    "smart_compact_search (use `pattern` for exact ids/keys, `context` for neighbouring rows; `line_matches` gives "
    "exact counts); never guess or answer from memory you cannot see."
)
_pending = OrderedDict()
_pending_guard = threading.Lock()


def _log_error(exc):
    """One stderr line: exception type and location only, never message content."""
    tb = traceback.extract_tb(exc.__traceback__)
    where = f"{tb[-1].filename.rsplit('/', 1)[-1]}:{tb[-1].lineno}" if tb else "?"
    print(f"openmem-context: fail-open {type(exc).__name__} at {where}", file=sys.stderr, flush=True)


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def pointer_text(sid, dropped, log_path):
    return (
        f"[openmem: continuing session {sid}; {dropped} earlier messages are NOT in your context. "
        f'You MUST call smart_compact_search(session_id="{sid}", query=... or pattern=...) before answering '
        f"anything that depends on them; the handoff log is {log_path} (JSONL, one row per block).]"
    )


def pending_text(sid):
    return (
        "[openmem: memory ingest is still running, so the most recent turns may not be in memory yet. "
        f'Use smart_compact_search(session_id="{sid}", query=...) for them.]'
    )


def add_standing_instruction(adapter, data):
    """Add STANDING_INSTRUCTION to the request's system prompt unless it is already there."""
    if STANDING_INSTRUCTION not in adapter.system_text(data):
        adapter.add_instruction(data, STANDING_INSTRUCTION)


def first_user_index(adapter, items):
    """Index of the first real user turn (pinned through every trim), or None."""
    for i, item in enumerate(items):
        if adapter.is_first_user(item):
            return i
    return None


def _droppable(adapter, items, stop, first):
    return [x for j, x in enumerate(items[:stop]) if j != first and not adapter.is_pinned(x)]


def choose_cut(adapter, items, after, first=None):
    """Index of the last real user turn > after whose kept part shares no call/result pair with the dropped part.

    The kept part is the suffix from the cut plus the pinned first user turn.
    """
    for i in range(len(items) - 1, after, -1):
        item = items[i]
        if not adapter.is_turn_start(item):
            continue
        dropped = _droppable(adapter, items, i, first)
        if not dropped:
            return None
        kept = items[i:] + ([items[first]] if first is not None and first < i else [])
        d_calls = set().union(*(adapter.call_ids(x) for x in dropped)) - {None}
        d_results = set().union(*(adapter.result_ids(x) for x in dropped)) - {None}
        k_calls = set().union(*(adapter.call_ids(x) for x in kept)) - {None}
        k_results = set().union(*(adapter.result_ids(x) for x in kept)) - {None}
        if d_calls & k_results or k_calls & d_results:
            continue
        return i
    return None


def render(adapter, items, cut, note, first=None):
    """Pinned items and the first user turn before the cut (in order), then the noted cut turn and the rest."""
    if not cut:
        return items
    head = [x for j, x in enumerate(items[:cut]) if j == first or adapter.is_pinned(x)]
    return [*head, adapter.prepend_note(items[cut], note), *items[cut + 1:]]


def _locate_cut(items, thread):
    idx = thread.get("cut")
    want = thread.get("cut_fp")
    if isinstance(idx, int) and 0 < idx < len(items) and fingerprint(items[idx]) == want:
        return idx
    for i in range(1, len(items)):
        if fingerprint(items[i]) == want:
            return i
    return 0


def _registered_bank(store, sid):
    try:
        bank = store.registration(sid).get("bank")
    except RegistrationNotFound:
        return None
    return bank if isinstance(bank, str) and bank else None


def _build_note(adapter, items, cut, sid, dropped, store, settings, http):
    log_path = Path(settings.pointer_context_dir) / "sessions" / store.log_path(sid).name
    parts = [pointer_text(sid, dropped, log_path)]
    bank = _registered_bank(store, sid)
    if bank:
        query = strip_reminders(adapter.user_text(items[cut]))[:RECALL_QUERY_MAX_CHARS]
        if query:
            try:
                text = recall_mod.recall_text(
                    http, settings.hindsight_url, bank, query, settings.compaction_max_chars, settings.recall_timeout_s
                )
                if text:
                    parts.append("[openmem recall]\n" + text)
            except Exception as exc:  # recall is best effort
                _log_error(exc)
        try:
            if recall_mod.active_operations(http, settings.hindsight_url, bank) > 0:
                parts.append(pending_text(sid))
        except Exception as exc:
            _log_error(exc)
    return "\n".join(parts)


def _rows(adapter, items, start, stop, names, ts, skip=None):
    rows = []
    for j in range(start, min(stop, len(items))):
        item = items[j]
        if j == skip or adapter.is_pinned(item):
            continue
        for role, kind, name, text in adapter.rows(item, names):
            rows.append({"ts": ts, "role": role, "kind": kind, "name": name, "text": text})
    return rows


def _rewrite(data, call_type, settings, http):
    try:
        adapter = adapter_for(call_type)
    except UnsupportedCallType:
        return data
    original = adapter.get_items(data)
    if not isinstance(original, list) or not original or not all(isinstance(x, dict) for x in original):
        return data
    store = Store(settings.context_dir)

    items = original
    if settings.compress_over_tokens > 0:
        items = [adapter.compress_item(x, settings.compress_over_tokens, store.write_blob) for x in original]

    sid = resolve_session_id(data, adapter, original)
    roots = [x for x in items if not adapter.is_pinned(x)]
    if not roots:
        if settings.standing_instruction:
            add_standing_instruction(adapter, data)
        return data
    root = fingerprint(roots[0])
    first = first_user_index(adapter, items)
    context = [data.get(k) for k in adapter.context_keys]

    with session_lock(sid):
        state = store.load_trim(sid)
        threads = state["threads"]
        thread = threads.get(root)
        cut, note = 0, None
        if thread:
            cut = _locate_cut(items, thread)
            note = thread.get("note") if cut else None
            if not cut:
                threads.pop(root, None)
        view = render(adapter, items, cut, note, first)
        force = store.force_requested(sid)
        ratio = settings.chars_per_token if settings.chars_per_token > 0 else DEFAULT_CHARS_PER_TOKEN
        tokens = estimate_prompt_tokens(request_chars(*context, view), state.get("usage"), root, ratio)
        if force or tokens >= settings.trim_at_tokens:
            new_cut = choose_cut(adapter, items, cut, first)
            if new_cut is not None:
                names = adapter.tool_names(items)
                store.append_log(sid, _rows(adapter, items, cut, new_cut, names, _utc_now(), skip=first))
                dropped = len(_droppable(adapter, items, new_cut, first))
                note = _build_note(adapter, items, new_cut, sid, dropped, store, settings, http)
                threads.pop(root, None)
                threads[root] = {"cut": new_cut, "cut_fp": fingerprint(items[new_cut]), "note": note,
                                 "format": adapter.name, "updated": _utc_now()}
                while len(threads) > MAX_THREADS:
                    threads.pop(next(iter(threads)))
                store.save_trim(sid, state)
                if force:
                    store.clear_force(sid)
                view = render(adapter, items, new_cut, note, first)
            elif thread and not cut:
                store.save_trim(sid, state)
        elif thread and not cut:
            store.save_trim(sid, state)

    # Measured like the estimate, before the standing instruction, so calibration compares like with like.
    _await_usage(data.get("litellm_call_id"), sid, root, request_chars(*context, view))
    if not (len(view) == len(original) and all(a is b for a, b in zip(view, original))):
        data[adapter.items_key] = view
    if settings.standing_instruction:
        # After trimming, so the cut, the token estimate and the session id never see it.
        add_standing_instruction(adapter, data)
    return data


def _await_usage(call_id, sid, root, chars):
    if not isinstance(call_id, str) or not call_id:
        return
    with _pending_guard:
        _pending.pop(call_id, None)
        _pending[call_id] = (sid, root, chars)
        while len(_pending) > MAX_PENDING:
            _pending.popitem(last=False)


def _field(obj, name):
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def _count(value):
    return value if type(value) is int and value >= 0 else None


def prompt_tokens_from_usage(usage):
    """Prompt tokens in a usage object, cache reads and writes included, or None.

    LiteLLM Usage (chat, and /v1/messages logged as a ModelResponse) has prompt_tokens, which already includes
    Anthropic cache tokens. Anthropic's own usage has input_tokens without them plus cache_read_input_tokens and
    cache_creation_input_tokens. Responses API usage has input_tokens, cached tokens included.
    """
    if usage is None:
        return None
    prompt = _count(_field(usage, "prompt_tokens"))
    if prompt:
        return prompt
    base = _count(_field(usage, "input_tokens"))
    if base is None:
        return None
    total = base + (_count(_field(usage, "cache_read_input_tokens")) or 0) \
        + (_count(_field(usage, "cache_creation_input_tokens")) or 0)
    return total or None


def response_prompt_tokens(response, kwargs):
    """Prompt tokens LiteLLM reports for a finished call: the response's usage (or its .response's, for a Responses
    stream's completed event), else standard_logging_object.prompt_tokens; None when none is reported."""
    for obj in (response, _field(response, "response")):
        if obj is not None:
            tokens = prompt_tokens_from_usage(_field(obj, "usage"))
            if tokens:
                return tokens
    slo = kwargs.get("standard_logging_object") if isinstance(kwargs, dict) else None
    tokens = _count(_field(slo, "prompt_tokens")) if slo is not None else None
    return tokens or None


def process_usage(kwargs, response, settings=None):
    """Calibrate the session of a finished call from its reported prompt tokens. Never raises."""
    try:
        call_id = kwargs.get("litellm_call_id") if isinstance(kwargs, dict) else None
        if not isinstance(call_id, str):
            return
        with _pending_guard:
            entry = _pending.pop(call_id, None)
        if entry is None:
            return
        settings = settings or Settings.from_env()
        tokens = response_prompt_tokens(response, kwargs)
        if not settings.enabled or tokens is None:
            return
        sid, root, chars = entry
        store = Store(settings.context_dir)
        with session_lock(sid):
            state = store.load_trim(sid)
            if record_usage(state, root, chars, tokens):
                store.save_trim(sid, state)
    except Exception as exc:
        _log_error(exc)


def process_request(data, call_type, settings=None, http=None):
    """Rewrite data in place and return it; on any error return it unmodified."""
    try:
        settings = settings or Settings.from_env()
        if not settings.enabled or not isinstance(data, dict):
            return data
        return _rewrite(data, call_type, settings, http or recall_mod.urllib_http)
    except Exception as exc:
        _log_error(exc)
        return data
