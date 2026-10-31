# Decision Ledger - process graded (interactive)

You are filling in a service ledger one decision at a time. Operations are
delivered to you ONE AT A TIME, as messages in this conversation. You do NOT
fetch them: each operation arrives automatically as the next user message, and
you receive the following operation only after you finish the current turn.
There are four kinds of operations:

- A **DECIDE** prompt - `DECIDE <k>: pick a codename for service-<k>. Options:
  <A, B[, C]>.` Commit to exactly one of the listed options by replying with a
  line of the form `DECIDE <k>=<choice>`. Your choice for an item is never given
  to you again, so it is yours alone to keep track of.
- A **FILL-BATCH** block, delimited by unique `<<<FILL-BATCH <id> BEGIN ...>>>` /
  `<<<FILL-BATCH <id> END>>>` sentinel lines, carrying many lines of unrelated
  service-log filler. The filler is never asked about.
- A **RECALL** question - `RECALL <n>: which codename did you pick for
  service-<k>?` Answer with the exact codename you committed to in that item's
  `DECIDE` line.
- An **APPLY** question - `APPLY <n>: ...` asks for a value computed from the
  codename you picked (for example, a port number derived from its position
  among the options you were offered). Answer with that computed value.

## Turn protocol (IMPORTANT)
Each incoming message is ONE operation. Do whatever work it needs FIRST (commit
a decision, offload a filler batch, emit an ANSWER block, ...). When you are
done with the current operation, **end your turn** by running this single
command with the `bash` tool to receive the next operation:

```
echo READY_FOR_NEXT_OP
```

This is a multi-turn task: the harness RUNS this command and then delivers the
next operation as the next user message. You MAY bundle real work into the SAME
command — in fact the cleanest way to commit a decision or answer a question is
to emit the required line and the marker together, e.g.:

```
printf 'DECIDE 7=B\n'; echo READY_FOR_NEXT_OP
```

ONLY running `echo READY_FOR_NEXT_OP` advances to the next operation — a reply
with no tool call does NOT advance (it just prompts you to keep going). Do NOT
run the marker until you have fully handled the current operation.

## How to commit a DECIDE

Reply (in that same turn) with a line of the exact form:

```
DECIDE <k>=<choice>
```

using one of the options that round offered. You are never shown this item's
options again, so decide once and keep track of what you picked.

## How to answer a RECALL or APPLY question

Reply (in that same turn) with an **ANSWER block** on its own lines:

```
<<<ANSWER k=<k>>>>
<the codename, or the computed value the question asks for>
<<<ANSWER END>>>
```

You are NOT told in advance which items will be asked about, so you must be
able to recall any decision you made earlier in the stream.

## How you are graded

Process-graded: this task has no fixed "correct" codename to recall — the only
thing graded is whether your `RECALL` and `APPLY` answers are **consistent with
your own earlier `DECIDE` line** for that item. Grading reads your **context**
(the `DECIDE` lines and ANSWER blocks across your turns). You MAY use
the disk as scratch/storage, but FINDING a value (e.g. with `grep`) is NOT
answering — only an ANSWER block that actually appears in your
context is scored, so you must PRINT the value inside `<<<ANSWER ...>>>` ...
`<<<ANSWER END>>>`.
If you never emitted a `DECIDE` line for an item, any `RECALL` or `APPLY`
answer about it is scored wrong, because there is nothing of yours to be
consistent with.
The run ends automatically after the final operation; you do not need to
submit.
