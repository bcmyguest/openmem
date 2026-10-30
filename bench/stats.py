import json,glob,os,tiktoken,collections,tomllib
enc=tiktoken.get_encoding("o200k_base")
seen=set()
for d in sorted(glob.glob("cb/tasks/*-seed42")):
    lv=os.path.basename(d)[:-7]
    ch=[json.loads(l) for l in open(d+"/environment/stream/chunks.jsonl")]
    toks=sum(len(enc.encode((c.get("header","") or "")+"\n"+(c.get("body","") or ""),disallowed_special=())) for c in ch)
    ins=len(enc.encode(open(d+"/instruction.md").read(),disallowed_special=()))
    t=tomllib.load(open(d+"/task.toml","rb"))
    mx=max(len(enc.encode(c.get("body","") or "",disallowed_special=())) for c in ch)
    print(f"{lv:28s} ops={len(ch):4d} stream_tok={toks:8d} max_op={mx:6d} instr={ins:5d} P={t['metadata'].get('contextbench_pressure')} timeout={t['agent']['timeout_sec']}")
