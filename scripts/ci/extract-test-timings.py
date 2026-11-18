import re, sys, json, glob
t = {}
for f in sorted(glob.glob(sys.argv[1] + "/shard*.log")):
    cur = None
    for line in open(f, errors="replace"):
        m = re.search(r"##\[group\](\S+\.test\.tsx?):", line)
        if m:
            cur = m.group(1); t.setdefault(cur, 0.0); continue
        if "##[endgroup]" in line: cur = None; continue
        m = re.search(r"\((?:pass|fail|skip|todo)\).*\[([\d.]+)(ms|s)\]\s*$", line)
        if m and cur:
            v = float(m.group(1)); t[cur] += v/1000 if m.group(2) == "ms" else v
json.dump({k: round(v, 2) for k, v in sorted(t.items())}, open(sys.argv[2], "w"), indent=1)
vals = sorted(t.items(), key=lambda kv: -kv[1])
print("files", len(t), "total_s", round(sum(t.values())), "median_s", round(sorted(t.values())[len(t)//2], 2))
for k, v in vals[:30]: print(f"{v:8.1f}  {k}")
