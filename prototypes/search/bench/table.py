#!/usr/bin/env python3
"""table.py LOG [corpus]: per-query camelsearch latencies next to ripgrep and git grep, from run.sh's RESULT lines."""
import json, sys

rows, base = [], {}
for line in open(sys.argv[1]):
    if not line.startswith("RESULT "):
        continue
    try:
        d = json.loads(line[7:])
    except ValueError:
        continue
    if len(sys.argv) > 2 and d.get("corpus") != sys.argv[2]:
        continue
    r = d.get("r")
    if not isinstance(r, dict):
        continue
    if r.get("event") == "query" and "snap" not in d:
        rows.append((d["corpus"], r))
    elif "tool" in r:
        key = (d["corpus"], r["q"] or "", r.get("path"), r.get("file"), r.get("lang"))
        base[(key, r["tool"])] = r

print(f"| corpus | class | query | camelsearch p50 / p99 ms | files | candidates | rg warm p50 ms | git grep p50 ms | rg files |")
print("|---|---|---|---|---|---|---|---|---|")
for corpus, r in rows:
    q = r["q"]
    pattern, path, file, lang = q, None, None, None
    for tag in (" lang:", " file:", " path:"):
        if tag in pattern:
            pattern, val = pattern.split(tag, 1)
            if tag == " path:": path = val
            if tag == " file:": file = val
            if tag == " lang:": lang = val
    # the label is "pattern path:x file:y lang:z" in that order; re-split for exact keys
    parts = q.split(" path:")
    pattern = parts[0]
    rest = parts[1] if len(parts) > 1 else ""
    path = rest.split(" file:")[0].split(" lang:")[0] if len(parts) > 1 else None
    file = q.split(" file:")[1].split(" lang:")[0] if " file:" in q else None
    lang = q.split(" lang:")[1] if " lang:" in q else None
    pattern = pattern.split(" file:")[0].split(" lang:")[0]
    key = (corpus, pattern, path, file, lang)
    rg = base.get((key, "rg"), {})
    gg = base.get((key, "gitgrep"), {})
    res = r["result"]
    hits = res.get("fileHits", res.get("hits"))
    flag = " (cap)" if res.get("truncated") else ""
    label = q.replace("|", "\\|") + (" -i" if r.get("i") else "")
    print(f"| {corpus} | {r['class']} | `{label}` | {r['p50']:.2f} / {r['p99']:.2f} | {hits}{flag} | {res.get('candidates', '')} | "
          f"{rg.get('p50', '')} | {gg.get('p50', '')} | {rg.get('files', '')} |")
