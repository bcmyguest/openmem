"""Grader for *Decision Ledger*: self-consistency, not retrieval of a gold value.

The agent commits to each item with a plain-text line early in the stream::

    DECIDE 7=B

and later answers a ``RECALL`` or ``APPLY`` question about that item with an
ANSWER block::

    <<<ANSWER k=7>>>
    B
    <<<ANSWER END>>>

There is no gold codename or port in ``gold.json`` -- only which item each
question is about and whether it is a ``recall`` or an ``apply`` question. The
grader parses the agent's own ``DECIDE`` lines out of its context, exactly as it
parses ANSWER blocks, and scores each question against the agent's *own* earlier
commitment:

* ``recall`` is correct when the answer equals the choice in that item's last
  ``DECIDE`` line;
* ``apply`` is correct when the answer equals the deterministic ``PORT_BASE +
  index`` of that choice among the options the item offered -- the grader does
  not need the agent to show its arithmetic, only to land on the right number.

An item with no ``DECIDE`` line anywhere in the agent's context cannot be
consistent with anything, so every question about it counts as wrong rather than
being excluded: silently dropping it would let an agent skip committing and never
be penalized for the questions that depend on it.

Deterministic, no LLM judge: a decision is never looked up in the gold file, and a
reward of 1.0 does not mean the agent picked "the right" codename -- there isn't
one -- only that it never contradicted itself.

Rewards: ``reward``, ``reward_recall`` / ``reward_apply`` per kind,
``reward_attempted`` over the questions answered at all, ``n_decided`` (items
with at least one parsed ``DECIDE``), and the per-turn context size.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import ContextSource, Grader, messages_text, normalize, read_context

__all__ = ["DecisionLedgerGrader", "DECIDE_RE", "ANSWER_RE", "PORT_BASE"]

#: ``DECIDE <k>=<choice>``, the agent's own commitment line.
DECIDE_RE = re.compile(r"^\s*DECIDE\s+([0-9]+)\s*=\s*([^\s]+)\s*$", re.MULTILINE)

#: ``<<<ANSWER k=<k>>>> ... <<<ANSWER END>>>``, same shape as the sibling families.
ANSWER_RE = re.compile(
    r"<<<\s*ANSWER\s+k\s*=\s*([0-9]+)\s*>>>(.*?)<<<\s*ANSWER\s+END\s*>>>",
    re.DOTALL | re.IGNORECASE,
)

#: Mirrors the generator's constant; an apply answer is this plus the chosen
#: option's index among the item's offered options.
PORT_BASE = 8000


class DecisionLedgerGrader(Grader):
    family = "decision_ledger"

    def grade(self, run_dir: Path | str, gold: dict) -> dict:
        questions = gold.get("questions") or []
        decisions = gold.get("decisions") or []
        total = len(questions)
        source = read_context(run_dir)
        if total == 0:
            return self._invalid(source.graded_from, "gold has no questions")
        if source.graded_from == "none":
            return self._invalid("none", "no context snapshots, trajectory or report")

        options_by_item = {int(d["item"]): list(d["options"]) for d in decisions}
        own_decisions = self._collect_decisions(source)
        answers = self._collect_answers(source)

        correct = answered = decided = 0
        by_kind_total: dict[str, int] = {"recall": 0, "apply": 0}
        by_kind_correct: dict[str, int] = {"recall": 0, "apply": 0}
        for item in options_by_item:
            if item in own_decisions:
                decided += 1

        for q in questions:
            item = int(q["item"])
            kind = q.get("kind", "recall")
            by_kind_total[kind] = by_kind_total.get(kind, 0) + 1
            # The ANSWER block is keyed by item (``k=<item>``), not by qid: a
            # recall and an apply question about the same item share one key, so
            # answers accumulate into one set across both operations.
            seen = answers.get(str(item))
            if not seen:
                continue
            answered += 1

            choice = own_decisions.get(item)
            if choice is None:
                # No DECIDE for this item: nothing to be consistent with.
                continue
            if kind == "recall":
                want = normalize(choice)
            else:
                options = options_by_item.get(item) or []
                if choice not in options:
                    # The agent's DECIDE named an option it was never offered;
                    # there is no well-defined port to be consistent with.
                    continue
                want = str(PORT_BASE + options.index(choice))

            if any(_matches(want, a, kind) for a in seen):
                correct += 1
                by_kind_correct[kind] = by_kind_correct.get(kind, 0) + 1

        def _rate(k: str) -> float:
            n = by_kind_total.get(k, 0)
            return (by_kind_correct.get(k, 0) / n) if n else 0.0

        result = {
            "reward": correct / total,
            "reward_recall": _rate("recall"),
            "reward_apply": _rate("apply"),
            "reward_attempted": (correct / answered) if answered else 0.0,
            "n_answered": float(answered),
            "n_decided": float(decided),
            "matched": float(correct),
            "total": float(total),
            "n_snapshots": float(source.n_snapshots),
            "graded_from": source.graded_from,
            "grader_valid": 1.0,
        }
        result.update(self._token_stats(source.tokens))
        return result

    @staticmethod
    def _collect_decisions(source: ContextSource) -> dict[int, str]:
        """``item -> choice`` from the agent's own ``DECIDE`` lines.

        The stream never repeats an item's ``DECIDE`` prompt, but an agent may
        restate or correct its line later; the last one in turn order wins, same
        as the agent's own context would show it.
        """
        decisions: dict[int, str] = {}
        for frame in source.frames:
            for item, choice in DECIDE_RE.findall(messages_text(frame)):
                decisions[int(item)] = choice
        return decisions

    @staticmethod
    def _collect_answers(source: ContextSource) -> dict[str, set[str]]:
        answers: dict[str, set[str]] = {}
        for frame in source.frames:
            for qid, val in ANSWER_RE.findall(messages_text(frame)):
                answers.setdefault(qid.strip(), set()).add(normalize(val))
        return answers


def _matches(want: str, answer: str, kind: str) -> bool:
    if kind == "apply":
        # A port must be the exact number, not merely a substring (so "8001" does
        # not accidentally match an answer that also mentions "18001").
        return re.search(rf"(?<!\d){re.escape(want)}(?!\d)", answer) is not None
    return want in answer
