"""Join run.mjs results with `wrangler tail --format json` events: CPU and outcomes of the spike's object invocations
per run window. Usage: python3 analyze.py runs.jsonl tail.jsonl > summary.json"""
import json
import sys
from datetime import datetime


def events(path):
    text = open(path).read()
    decoder, index = json.JSONDecoder(), 0
    while True:
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            return
        value, index = decoder.raw_decode(text, index)
        yield value


def ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


tail = [e for e in events(sys.argv[2]) if e.get("scriptName") == "camelrun-spike-pi-subagents"]
out = []
for line in open(sys.argv[1]):
    run = json.loads(line)
    start, end = ms(run["startedAt"]), ms(run["endedAt"])
    window = [e for e in tail if start - 2000 <= e["eventTimestamp"] <= end and e.get("executionModel") == "durableObject"]
    kinds = {}
    for e in window:
        event = e.get("event") or {}
        kind = "alarm" if "scheduledTime" in event and "cron" not in event else ("rpc" if "rpcMethod" in event else ("fetch" if "request" in event else "other"))
        k = kinds.setdefault(kind, {"count": 0, "cpuMs": 0, "maxCpuMs": 0, "maxWallMs": 0})
        k["count"] += 1
        k["cpuMs"] += e.get("cpuTime", 0)
        k["maxCpuMs"] = max(k["maxCpuMs"], e.get("cpuTime", 0))
        k["maxWallMs"] = max(k["maxWallMs"], e.get("wallTime", 0))
    outcomes = {}
    for e in window:
        outcomes[e.get("outcome")] = outcomes.get(e.get("outcome"), 0) + 1
    summary = run["final"].get("summary", {}) if isinstance(run.get("final"), dict) else {}
    cpu = sum(e.get("cpuTime", 0) for e in window)
    deltas = summary.get("deltas") or 0
    out.append({
        "name": run["name"], "n": run["n"], "ctx": run["ctx"], "remote": run.get("remote"), "crashAt": run.get("crashAt"),
        "wallMs": run.get("wallMs"), "reset": run.get("reset"), "pi": run["final"].get("pi"), "children": run["final"].get("children"),
        "summary": {k: summary.get(k) for k in ["answered", "statuses", "errors", "firstDeltaMs", "childDurationMs", "streamLatencyMs", "loopLagMs", "sqlStatements", "parentDoneMs", "maxStreaming", "reports"]},
        "databaseBytes": run["final"].get("databaseBytes"),
        "tail": {"events": len(window), "outcomes": outcomes, "byKind": kinds, "cpuMs": cpu, "cpuUsPerDelta": round(cpu * 1000 / deltas, 1) if deltas else None},
        "concurrency": summary.get("concurrency"),
    })
json.dump(out, sys.stdout, indent=1)
