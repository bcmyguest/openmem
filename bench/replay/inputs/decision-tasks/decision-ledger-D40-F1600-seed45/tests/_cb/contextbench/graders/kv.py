"""Grader for *Key-Value Store*: process-graded, ANSWER-block based.

The agent answers each ``GET <key>`` by emitting an ANSWER block::

    <<<ANSWER key=K00007>>>
    <the value it stored for K00007>
    <<<ANSWER END>>>

Every per-turn context frame is scanned, all ANSWER blocks are collected as
``key -> {value strings the agent ever produced}``, and the score is the fraction
of gold GET queries whose correct value was produced.

Reading the whole per-turn series rather than the final context is what makes the
mechanisms comparable on one number: an agent that parks values outside its context
and surfaces the queried one only transiently has the value in the snapshot of the
GET turn, but not in its final context.

Rewards:

* ``reward`` -- fraction of GET queries answered with the correct value;
* ``reward_attempted`` -- of the GETs answered at all, the fraction correct;
* ``n_answered`` -- how many distinct gold GETs got any ANSWER block;
* ``agent_peak_tokens`` / ``agent_mean_tokens`` -- per-turn context size.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import ContextSource, Grader, messages_text, normalize, read_context

__all__ = ["KVStoreGrader", "ANSWER_RE"]

#: ``<<<ANSWER key=K00007>>> ... <<<ANSWER END>>>``; the key may carry spaces.
ANSWER_RE = re.compile(
    r"<<<\s*ANSWER\s+key\s*=\s*([^\s>]+)\s*>>>(.*?)<<<\s*ANSWER\s+END\s*>>>",
    re.DOTALL | re.IGNORECASE,
)


class KVStoreGrader(Grader):
    family = "kv_store"

    def grade(self, run_dir: Path | str, gold: dict) -> dict:
        queries = gold.get("queries") or []
        total = len(queries)
        source = read_context(run_dir)
        if total == 0:
            return self._invalid(source.graded_from, "gold has no queries")
        if source.graded_from == "none":
            return self._invalid("none", "no context snapshots, trajectory or report")

        answers = self._collect(source)
        correct = 0
        answered = 0
        for q in queries:
            key = normalize(str(q["key"]))
            want = normalize(str(q["value"]))
            seen = answers.get(key)
            if seen:
                answered += 1
                # Tolerate the value being embedded in a longer answer line.
                if want in seen or any(want in s for s in seen):
                    correct += 1

        result = {
            "reward": correct / total,
            "reward_attempted": (correct / answered) if answered else 0.0,
            "n_answered": float(answered),
            "matched": float(correct),
            "total": float(total),
            "n_snapshots": float(source.n_snapshots),
            "graded_from": source.graded_from,
            "grader_valid": 1.0,
        }
        result.update(self._token_stats(source.tokens))
        return result

    @staticmethod
    def _collect(source: ContextSource) -> dict[str, set[str]]:
        """``key -> {normalized answer strings}`` across every frame."""
        answers: dict[str, set[str]] = {}
        for frame in source.frames:
            for key, val in ANSWER_RE.findall(messages_text(frame)):
                answers.setdefault(normalize(key), set()).add(normalize(val))
        return answers
