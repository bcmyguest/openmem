"""OpenMem compaction for Compact-Bench: store the frozen history, render the proxy's trimmed view.

Everything that decides the view is the proxy's own code from $OPENMEM_REPO/proxy/openmem_context:
AnthropicAdapter (turn starts, first user turn, rows, tool-result compression), core.first_user_index,
core.choose_cut, core._droppable, core.pointer_text, core.render, core.stored_rows,
core.STANDING_INSTRUCTION, Store and sessiondb (the sessions/<sid>.db schema and writer).

The request at the compaction point is H + [continuation message], as the proxy would see it.

budget_tokens = 0 ("proxy" mode) is the proxy's rule unchanged: the cut is the last real user turn,
i.e. the continuation message, so the view is [first user turn, pointer + continuation]. Phase A
of every Compact-Bench task is one user turn (one task statement, then tool loops), so the proxy
never keeps any of its steps.

budget_tokens > 0 ("budget" mode) also keeps the most recent phase-A steps whose text fits the
budget. It reuses choose_cut and render with one change, a StepAdapter whose is_turn_start accepts
exactly one candidate assistant message: choose_cut then returns that index iff the proxy's
call/result pairing check accepts it as a cut. Candidates are tried earliest first; the first one
whose kept steps fit the budget wins. render() prepends the pointer to the cut item, which here
is an assistant message (the proxy only ever prepends it to a user turn): a known deviation.
Sizes use tokens.text_tokens (characters / 4), the proxy's per-text measure.
"""

import os
import sys
import time

OPENMEM_REPO = os.environ.get("OPENMEM_REPO")
if not OPENMEM_REPO:
    raise RuntimeError("set OPENMEM_REPO to an OpenMem checkout (proxy/openmem_context)")
sys.path.insert(0, os.path.join(OPENMEM_REPO, "proxy"))
from openmem_context import core, sessiondb  # noqa: E402
from openmem_context.adapters import AnthropicAdapter  # noqa: E402
from openmem_context.settings import DEFAULT_COMPRESS_OVER_TOKENS  # noqa: E402
from openmem_context.store import Store  # noqa: E402
from openmem_context.tokens import text_tokens  # noqa: E402


class StepAdapter(AnthropicAdapter):
    """AnthropicAdapter whose only turn start is one chosen item (by identity)."""

    def __init__(self, chosen):
        self.chosen = chosen

    def is_turn_start(self, item):
        return item is self.chosen


def item_tokens(adapter, item, names):
    return sum(text_tokens(text) for _, _, _, text in adapter.rows(item, names))


def _budget_cut(items, first, budget_tokens, names):
    """Earliest assistant step whose kept steps (cut .. last phase-A item) fit budget_tokens, or None."""
    base = AnthropicAdapter()
    last = len(items) - 1  # the continuation message, always kept
    sizes = [item_tokens(base, x, names) for x in items]
    for i in range(1, last):
        if items[i].get("role") != "assistant":
            continue
        if sum(sizes[i:last]) > budget_tokens:
            continue
        if core.choose_cut(StepAdapter(items[i]), items, 0, first) == i:
            return i, StepAdapter(items[i])
    return None


def compact(history, continuation, sid, state_dir, budget_tokens=0):
    """Write every message to <state_dir>/context/sessions/<sid>.db and return the trimmed view.

    history: the frozen messages (Anthropic format); continuation: the continuation user message.
    Returns (view, info): view is the message list ending with the (possibly noted) continuation;
    info records the cut, the counts and token sizes.
    """
    adapter = AnthropicAdapter()
    store = Store(os.path.join(state_dir, "context"))
    original = [*history, continuation]
    items = [adapter.compress_item(x, DEFAULT_COMPRESS_OVER_TOKENS, store.write_blob) for x in original]
    names = adapter.tool_names(items)
    first = core.first_user_index(adapter, items)
    mode, cut, cut_adapter = "proxy", None, adapter
    if budget_tokens > 0:
        found = _budget_cut(items, first, budget_tokens, names)
        if found:
            mode, (cut, cut_adapter) = "budget", found
    if cut is None:
        cut = core.choose_cut(adapter, items, 0, first)
    if cut is None:
        raise RuntimeError("no cut: the request has no real user turn after the first")
    dropped = len(core._droppable(cut_adapter, items, cut, first))
    note = core.pointer_text(sid, dropped)
    view = core.render(cut_adapter, items, cut, note, first)

    rows, cut_row = core.stored_rows(adapter, original, items, names, cut, first)
    store.ensure_sessions()
    db = sessiondb.open_session(store.db_path(sid))
    added = db.sync(rows, cut_row, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    sessiondb.drop_session(store.db_path(sid))

    all_tokens = sum(item_tokens(adapter, x, names) for x in items[:-1])
    kept_steps = sum(item_tokens(adapter, x, names) for x in items[cut:-1]) if mode == "budget" else 0
    info = {"mode": mode, "cut": cut, "first": first, "messages": len(items), "dropped": dropped,
            "kept_messages": len(view), "rows": len(rows), "rows_added": added,
            "history_tokens": all_tokens, "kept_step_tokens": kept_steps,
            "first_turn_tokens": item_tokens(adapter, items[first], names) if first is not None else 0,
            "pointer_tokens": text_tokens(note), "budget_tokens": budget_tokens,
            "db": str(store.db_path(sid))}
    return view, info


STANDING_INSTRUCTION = core.STANDING_INSTRUCTION
