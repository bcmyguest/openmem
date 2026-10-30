"""Back-of-envelope token/cost model for the three arms on ContextBench streams.

Assumptions (all to be replaced by pilot measurements):
  BASE      Claude Code system prompt + tool schemas + instruction, tokens (unmeasured guess)
  CALLS     API calls per op (tool call, then end-of-turn after the tool result)
  OUT_OP    model output tokens per op (no disk offload; offload multiplies this)
  TOK_F     Claude tokenizer / o200k ratio for this text (unmeasured; 1.0 assumed)
  Native compaction: when context >= NATIVE_AT, one summary call reads the whole
  context and the context resets to BASE + SUMMARY.
  Proxy trim: when context >= TRIM_AT (chars/4 ~ o200k here), the context resets to
  BASE + NOTE + current op; one cache miss (full write) on the trimmed prefix.
  Every call: new suffix tokens are cache writes, the rest cache reads (ideal caching).
Prices: platform.claude.com/docs/en/about-claude/pricing.md (fetched 2026-10-29), $/MTok
  (input, 5m cache write, cache read, output). Haiku 5.5 tier switches above 100k prompt.
"""
import glob
import json
import sys

import tiktoken

BASE, CALLS, OUT_OP, TOK_F = 20000, 2, 150, 1.0
NATIVE_AT, SUMMARY = 150000, 8000
TRIM_AT, NOTE = 120000, 200
WINDOW = {"haiku-4-5": 200000, "haiku-5-5": 1000000}
PRICE = {
    "haiku-4-5": lambda p: (1.00, 1.25, 0.10, 5.00),
    "haiku-5-5": lambda p: (0.10, 0.125, 0.01, 0.50) if p <= 100000 else (0.50, 0.625, 0.05, 2.50),
}
enc = tiktoken.get_encoding("o200k_base")


def ops(task):
    rows = [json.loads(l) for l in open(f"cb/tasks/{task}/environment/stream/chunks.jsonl")]
    return [int(TOK_F * len(enc.encode(r.get("header", "") + "\n" + r.get("body", ""), disallowed_special=()))) for r in rows]


def simulate(op_toks, arm, model):
    ctx, tot = BASE, {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "usd": 0.0, "calls": 0,
                      "peak": 0, "events": 0, "overflow": False}

    def call(prompt, new, out):
        pi, pw, pr, po = PRICE[model](prompt)
        tot["cache_write"] += new
        tot["cache_read"] += prompt - new
        tot["output"] += out
        tot["calls"] += 1
        tot["peak"] = max(tot["peak"], prompt)
        tot["usd"] += (new * pw + (prompt - new) * pr + out * po) / 1e6

    first = True
    for o in op_toks:
        if arm == "proxy" and ctx + o >= TRIM_AT:
            ctx = BASE + NOTE  # trim: keep pinned system/tools + current op
            tot["events"] += 1
        if arm == "native" and ctx >= NATIVE_AT:
            call(ctx, 0, SUMMARY)  # summary request over the full context
            ctx = BASE + SUMMARY
            tot["events"] += 1
        ctx += o
        if ctx > WINDOW[model]:
            tot["overflow"] = True
            break
        new = ctx if (first or tot["events"] and arm != "none") else o
        first = False
        for c in range(CALLS):
            call(ctx, new if c == 0 else OUT_OP // CALLS, OUT_OP // CALLS)
            ctx += OUT_OP // CALLS
        new = 0
    tot["usd"] = round(tot["usd"], 2)
    return tot


if __name__ == "__main__":
    tasks = sys.argv[1:] or ["kv-store-R2000-seed42", "kv-store-R4000-seed42", "log-triage-L3200-seed42",
                             "log-triage-L6400-seed42"]
    for t in tasks:
        o = ops(t)
        for model in ("haiku-5-5", "haiku-4-5"):
            for arm in ("none", "native", "proxy"):
                r = simulate(o, arm, model)
                print(f"{t:26s} {model} {arm:6s} calls={r['calls']:4d} peak={r['peak']:7d} "
                      f"read={r['cache_read']/1e6:6.2f}M write={r['cache_write']/1e6:5.2f}M "
                      f"out={r['output']/1e3:5.1f}k events={r['events']} overflow={r['overflow']} ${r['usd']}")
