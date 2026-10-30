"""Progress of the strict run: per arm and session, request count, last prompt size, trims, errors."""
import json, sys, time, collections
from pathlib import Path
R = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "results-strict")
for arm in sorted(p for p in R.iterdir() if (p / "usage.jsonl").is_file()):
    rows = [json.loads(l) for l in (arm / "usage.jsonl").read_text().splitlines() if l.strip()]
    errs = [r for r in rows if not r.get("ok")]
    by = collections.defaultdict(list)
    for r in rows:
        if r.get("ok"):
            by[r.get("session")].append(r)
    done = sum(1 for t in (arm / "trials").iterdir() if (t / "result.json").is_file()) if (arm / "trials").is_dir() else 0
    print(f"{arm.name}: rows={len(rows)} errors={len(errs)} trials_done={done}")
    for e in errs[-3:]:
        print("   ERR", time.strftime("%H:%M:%S", time.gmtime(e["ts"])), str(e.get("error"))[:160])
    for s, v in by.items():
        last = v[-1]
        print(f"   {str(s)[:8]} n={len(v)} last={last['input']+last['cache_read']+last['cache_write']} "
              f"peak={max(x['input']+x['cache_read']+x['cache_write'] for x in v)} trimmed={sum(x['trimmed'] for x in v)} "
              f"compressed={sum(1 for x in v if x['n_compressed'])} at={time.strftime('%H:%M:%S', time.gmtime(last['ts']))}")
