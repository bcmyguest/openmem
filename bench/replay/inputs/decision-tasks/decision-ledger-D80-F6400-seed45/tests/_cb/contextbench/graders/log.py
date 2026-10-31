"""Grader for *Incident Log Triage*: process-graded, ANSWER-block based.

The agent answers each ``QUERY <n>`` by emitting an ANSWER block::

    <<<ANSWER qid=0>>>
    timeout retry connection refused #ab12cd34      (lookup)
    <<<ANSWER END>>>

Every per-turn context frame is scanned, all ANSWER blocks are collected as
``qid -> {answer strings}``, and the score is the fraction of gold queries answered
correctly. Matching is per type:

* ``lookup`` -- the exact message string must appear in the agent's answer, as a
  whitespace-normalized substring, so adding a label does not cost a point;
* ``count`` -- the integer must appear as a standalone token in the answer.

A gold message ends in a random ``#<hex>`` uniqueness tag that a model treats as a
noise id and usually drops. Lookup grading measures retrieval -- did the agent
surface the right log line's message -- not whether it parrots that tag, so a
trailing tag is stripped before matching.

Rewards: ``reward``, ``reward_lookup`` / ``reward_count`` per type,
``reward_attempted`` over the queries answered at all, and the per-turn context size.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import ContextSource, Grader, messages_text, normalize, read_context

__all__ = ["LogTriageGrader", "ANSWER_RE"]

ANSWER_RE = re.compile(
    r"<<<\s*ANSWER\s+qid\s*=\s*([0-9]+)\s*>>>(.*?)<<<\s*ANSWER\s+END\s*>>>",
    re.DOTALL | re.IGNORECASE,
)

#: The trailing uniqueness tag of a gold message.
_TAG_RE = re.compile(r"\s*#[0-9a-f]+\s*$")


#: A complete number: optional sign, digits, optional decimal part.
_NUMBER_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")


def _count_correct(want: str, answers: set[str]) -> bool:
    """A count is correct when an answer states exactly one number and it equals the
    gold integer. ``-5``, ``5.9`` or a hedge such as ``5 or 6`` is not ``5``."""
    return any(_NUMBER_RE.findall(a) == [want] for a in answers)


def _lookup_correct(want: str, answers: set[str]) -> bool:
    core = _TAG_RE.sub("", want).strip()
    if not core:
        return False
    return any(core in a for a in answers)


class LogTriageGrader(Grader):
    family = "log_triage"

    def grade(self, run_dir: Path | str, gold: dict) -> dict:
        queries = gold.get("queries") or []
        total = len(queries)
        source = read_context(run_dir)
        if total == 0:
            return self._invalid(source.graded_from, "gold has no queries")
        if source.graded_from == "none":
            return self._invalid("none", "no context snapshots, trajectory or report")

        answers = self._collect(source)
        correct = answered = 0
        by_type_total: dict[str, int] = {"lookup": 0, "count": 0}
        by_type_correct: dict[str, int] = {"lookup": 0, "count": 0}
        for q in queries:
            qid = str(q["qid"])
            qtype = q.get("type", "lookup")
            want = normalize(str(q["answer"]))
            by_type_total[qtype] = by_type_total.get(qtype, 0) + 1
            seen = answers.get(qid)
            if not seen:
                continue
            answered += 1
            ok = (
                _count_correct(want, seen)
                if qtype == "count"
                else _lookup_correct(want, seen)
            )
            if ok:
                correct += 1
                by_type_correct[qtype] = by_type_correct.get(qtype, 0) + 1

        def _rate(t: str) -> float:
            n = by_type_total.get(t, 0)
            return (by_type_correct.get(t, 0) / n) if n else 0.0

        result = {
            "reward": correct / total,
            "reward_lookup": _rate("lookup"),
            "reward_count": _rate("count"),
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
        answers: dict[str, set[str]] = {}
        for frame in source.frames:
            for qid, val in ANSWER_RE.findall(messages_text(frame)):
                answers.setdefault(qid.strip(), set()).add(normalize(val))
        return answers
