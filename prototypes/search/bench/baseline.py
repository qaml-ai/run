#!/usr/bin/env python3
"""ripgrep and git grep over the same queries as `camelsearch bench`.
usage: baseline.py QUERIES.json TREE_DIR GIT_DIR COMMIT [runs] [tools]
Prints one JSON line per (tool, query): p50/max of `runs` timed runs after one warm-up, plus the matching file count
(which must equal camelsearch's fileHits when that result is not truncated)."""
import json, subprocess, sys, time, statistics

qfile, tree, gitdir, commit = sys.argv[1:5]
runs = int(sys.argv[5]) if len(sys.argv) > 5 else 5
tools = (sys.argv[6] if len(sys.argv) > 6 else "rg,gitgrep").split(",")
RGTYPE = {"c": "c", "go": "go", "python": "py", "typescript": "ts", "rust": "rust"}
GITLANG = {"c": ["*.c", "*.h"], "go": ["*.go"]}

def rg_cmd(q, files_only=False):
    # the same globs as git's pathspecs: rg ORs several -g globs, so path+file are combined into one glob
    a = ["rg", "--no-ignore", "--hidden", "-g", "!.git", "--no-heading", "-n", "-m", "200"]
    for g in git_spec(q):
        a += ["-g", g[len(":(glob)"):]]
    if not q.get("q"):
        return a[:5] + ["--files"] + a[9:] + ["."]
    if q.get("i"): a.append("-i")
    if not q.get("regex"): a.append("-F")
    if files_only: a.append("-l")
    return a + ["-e", q["q"], "."]

def git_spec(q):
    base = q.get("path", "").rstrip("*").rstrip("/") if q.get("path") else ""
    if q.get("path") and not q.get("file") and not q.get("lang"):
        return [":(glob)" + q["path"]]
    names = [q["file"]] if q.get("file") else GITLANG.get(q.get("lang"), [])
    if not names: return []
    return [":(glob)" + (base + "/" if base else "") + "**/" + n for n in names]

def git_cmd(q, files_only=False):
    spec = git_spec(q)
    if not q.get("q"):
        return ["git", "-C", gitdir, "ls-files", "--"] + spec
    a = ["git", "-C", gitdir, "grep", "-n", "-I", "-P" if q.get("regex") else "-F"]
    if q.get("i"): a.append("-i")
    if files_only: a.append("-l")
    return a + ["-e", q["q"], commit, "--"] + spec

def timed(cmd, cwd):
    t = time.perf_counter()
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return (time.perf_counter() - t) * 1000, p.stdout

for q in json.load(open(qfile)):
    if q.get("symbol"): continue
    for tool in tools:
        build = rg_cmd if tool == "rg" else git_cmd
        cmd = build(q)
        timed(cmd, tree)  # warm-up
        lat = [timed(cmd, tree)[0] for _ in range(runs)]
        _, out = timed(build(q, True), tree)
        files = len([l for l in out.splitlines() if l])
        print(json.dumps({"tool": tool, "class": q["class"], "q": q.get("q", ""), "path": q.get("path"), "file": q.get("file"),
                          "lang": q.get("lang"), "p50": round(statistics.median(lat), 2), "max": round(max(lat), 2), "files": files}), flush=True)
