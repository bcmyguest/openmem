"""Run ctx/queue.txt lines ("RUN ARM TASK NAME") through run_ctx.sh one, at most MAX at a time.

    python ctx_sched.py [MAX] [QUEUE]   QUEUE defaults to $CTX_QUEUE, else ctx/queue.txt (run D: ctx/queue-D.txt)

Lines may be appended while it runs (reruns). Exits when ctx/STOP exists and nothing is running or pending.
Skips a line whose task dir is missing (logged to ctx/skipped.txt).
"""
import os, subprocess, sys, time
from pathlib import Path

B = Path(__file__).parent
Q = B / (sys.argv[2] if len(sys.argv) > 2 else os.environ.get("CTX_QUEUE") or "ctx/queue.txt")
STOP = B / "ctx" / "STOP"
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 4

started, running = 0, []
while True:
    running = [p for p in running if p.poll() is None]
    lines = [l.split() for l in Q.read_text().splitlines() if l.strip() and not l.startswith("#")]
    while len(running) < MAX and started < len(lines):
        run, arm, task, name = lines[started]
        started += 1
        if not (B / "cb" / "tasks" / task).is_dir():
            with open(B / "ctx" / "skipped.txt", "a") as fh:
                fh.write(f"{run} {arm} {task} missing task dir\n")
            continue
        running.append(subprocess.Popen([str(B / "run_ctx.sh"), "one", run, arm, task, name]))
        time.sleep(5)  # stagger container starts
    if not running and started >= len(lines) and STOP.exists():
        break
    time.sleep(10)
