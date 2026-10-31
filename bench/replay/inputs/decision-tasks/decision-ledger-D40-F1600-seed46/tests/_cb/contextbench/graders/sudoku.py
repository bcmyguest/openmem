"""Grader for *Sudoku Sketchpad*: versioned, process-graded.

Each move advances the sketchpad to a new version ``v`` with a correct grid ``G_v``
(a cell-to-value map). The agent labels every panel it displays with a ``VERSION``
line. Every versioned panel the agent ever displayed is recovered from the per-turn
context frames, and for each gold version the grader checks whether the agent
displayed that exact grid.

This makes the styles comparable on one number. An agent that edits its context in
place bumps the version and changes the affected cells, so one panel lives in
context and stays small; each version appears transiently across the turns. An
append-only agent writes a brand-new full panel per move, so all versions
accumulate and the context grows by a panel per move. Both score equally on
correctness while every version is right: the benefit of editing shows up in the
per-turn context size, and in correctness holding at large horizons where an
append-only context overflows the budget.

Rewards:

* ``reward`` -- ``reward_content``, the fraction of gold versions whose exact grid
  the agent displayed. The cells are what "exact match of the gold sketchpad
  throughout the process" means; the version label is a secondary bookkeeping check.
* ``reward_versioned`` -- the same, but the panel's version label must match too;
* ``reward_cell`` -- mean over versions of the best per-cell accuracy seen;
* ``reward_final_em`` / ``reward_final_cell`` -- the final displayed grid against
  the final gold grid;
* ``agent_peak_tokens`` / ``agent_mean_tokens`` -- per-turn context size.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator

from .base import ContextSource, Grader, messages_text, read_context

__all__ = ["SudokuSketchpadGrader", "SYMBOLS"]

#: Single-character value symbols; must match the generator.
SYMBOLS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

_TUPLE_RE = re.compile(r"\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([^)]*?)\s*\)")
_VERSION_RE = re.compile(r"VERSION:\s*(\d+)")

Cells = dict[str, str]
Panel = tuple[tuple[str, str], ...]


def _norm_value(raw: str) -> str:
    raw = raw.strip()
    if raw in (".", ""):
        return "."
    if raw.startswith("="):
        return "=" + raw[1:].strip()
    return raw


def _parse_panel_body(body: list[str], side: int) -> Cells:
    """Parse one board body into ``{"rXcY": value}``.

    Position-independent: every cell self-locates through its ``(r,c,v)`` tuple and
    a later occurrence wins, so the parse is robust to spacing and to the same tuple
    text appearing elsewhere in the block.
    """
    cells: Cells = {}
    for m in _TUPLE_RE.finditer("\n".join(body)):
        r, c, v = int(m.group(1)), int(m.group(2)), m.group(3).strip()
        if not (1 <= r <= side and 1 <= c <= side):
            continue
        if v in (".", ""):
            cells[f"r{r}c{c}"] = "."
        elif v in SYMBOLS[:side]:
            cells[f"r{r}c{c}"] = f"={SYMBOLS.index(v) + 1}"
    return cells


def _parse_blocks(text: str, side: int) -> list[tuple[int | None, Cells]]:
    """Every sketchpad block in ``text`` as ``(version, cells)``.

    The version comes from the block's ``VERSION:`` line, or is ``None``.
    """
    blocks: list[tuple[int | None, Cells]] = []
    buf: list[str] | None = None
    for line in text.splitlines():
        if "SKETCHPAD BEGIN" in line:
            buf = []
        elif "SKETCHPAD END" in line:
            if buf is not None:
                ver = None
                for bl in buf:
                    m = _VERSION_RE.search(bl)
                    if m:
                        ver = int(m.group(1))
                        break
                cells = _parse_panel_body(buf, side)
                if cells:
                    blocks.append((ver, cells))
            buf = None
        elif buf is not None:
            buf.append(line)
    return blocks


def _cell_accuracy(gold: Cells, panel: Panel) -> float:
    if not gold:
        return 0.0
    state = dict(panel)
    return sum(1 for k, v in gold.items() if state.get(k) == v) / len(gold)


def gold_states(gold: dict) -> Iterator[tuple[int, Cells]]:
    """Fold the compact per-version deltas into ``(version, full cells)`` pairs.

    A ``reset`` delta replaces the whole board (a new puzzle, or version 0); an
    ordinary delta updates only the changed cells. Version 0, the given starting
    panel, is yielded too, but the scorer grades only the streamed actions.
    """
    current: Cells = {}
    for d in gold.get("deltas") or []:
        cells = {k: _norm_value(v) for k, v in (d.get("cells") or {}).items()}
        if d.get("reset"):
            current = dict(cells)
        else:
            current.update(cells)
        yield d["v"], dict(current)


class SudokuSketchpadGrader(Grader):
    family = "sudoku_sketchpad"

    def grade(self, run_dir: Path | str, gold: dict) -> dict:
        meta = gold.get("meta") or {}
        # No silent 9x9 default: a missing side in a 16x16 or 25x25 gold would grade
        # the board on a 9x9 assumption and look perfectly healthy while doing it.
        if "side" not in meta:
            raise ValueError(
                "gold.meta['side'] is missing: refusing to default to 9x9. A larger "
                "board graded under a silent 9x9 default would pass every check we "
                "have. Stamp 'side' in the instance gold.meta."
            )
        side = int(meta["side"])

        source = read_context(run_dir)
        if source.graded_from == "none":
            return self._invalid("none", "no context snapshots, trajectory or report")
        obs = self._observe(source, side)

        total = 0
        versioned = 0
        content = 0
        cell_sum = 0.0
        final_gold: Panel | None = None
        for v, cells in gold_states(gold):
            if v == 0:
                continue
            total += 1
            panel: Panel = tuple(sorted(cells.items()))
            final_gold = panel
            if panel in obs["by_version"].get(v, ()):
                versioned += 1
            if panel in obs["content"]:
                content += 1
            seen = obs["by_version"].get(v)
            if seen:
                cell_sum += max(
                    (_cell_accuracy(cells, s) for s in seen), default=0.0
                )

        if total == 0:
            return self._invalid(source.graded_from, "gold has no graded versions")

        final_state: Panel | None = obs["final"]
        final_em = 1.0 if (final_state is not None and final_state == final_gold) else 0.0
        final_cell = (
            _cell_accuracy(dict(final_gold), final_state)
            if (final_state is not None and final_gold is not None)
            else 0.0
        )

        result = {
            "reward": content / total,
            "reward_versioned": versioned / total,
            "reward_content": content / total,
            "reward_cell": cell_sum / total,
            "reward_final_em": final_em,
            "reward_final_cell": final_cell,
            "matched": float(versioned),
            "total": float(total),
            "n_snapshots": float(source.n_snapshots),
            "graded_from": source.graded_from,
            "grader_valid": 1.0,
        }
        result.update(self._token_stats(source.tokens))
        return result

    @staticmethod
    def _observe(source: ContextSource, side: int) -> dict:
        """Every versioned panel, deduplicated as canonical tuples.

        Deduplication keeps an append-only agent that re-shows every old version
        from blowing up the grader's memory.
        """
        by_version: dict[int, set[Panel]] = {}
        content: set[Panel] = set()
        final_state: Panel | None = None

        for frame in source.frames:
            blocks = _parse_blocks(messages_text(frame), side)
            best: tuple[int, Panel] | None = None
            for ver, cells in blocks:
                panel: Panel = tuple(sorted(cells.items()))
                content.add(panel)
                if ver is not None:
                    by_version.setdefault(ver, set()).add(panel)
                    if best is None or ver >= best[0]:
                        best = (ver, panel)
            # The final state is the highest-version panel of the latest frame that
            # has one at all.
            if best is not None:
                final_state = best[1]
            elif blocks:
                final_state = tuple(sorted(blocks[-1][1].items()))

        return {"by_version": by_version, "content": content, "final": final_state}
