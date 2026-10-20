"""Rebuild per-file evidence from downloaded test-timings artifacts (no application access).
Usage: python3 scripts/test-mode-report.py BASELINE TRACE [AFTER]
Writes docs/operations/ci-mode-split/files.csv and summary.json.
"""
import datetime
import csv
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/operations/ci-mode-split"
manifest = json.loads((ROOT / "tests/mode-sensitive.json").read_text())


def results(directory, mode):
    records = {}
    for path in sorted(pathlib.Path(directory).rglob(f"{mode}-*of*.json")):
        failed = set(path.with_suffix(".failed").read_text().splitlines())
        retry = path.with_suffix(".retry")
        retry_times = json.loads(retry.read_text()) if retry.exists() else {}
        retry_failed = set(path.with_suffix(".retry-failed").read_text().splitlines()) if retry.exists() else set()
        for file, seconds in json.loads(path.read_text()).items():
            records[file] = {"seconds": seconds, "first": "fail" if file in failed else "pass",
                             "retry": ("fail" if file in retry_failed else "pass") if file in retry_times else "",
                             "retrySeconds": retry_times.get(file, ""),
                             "final": ("fail" if file in retry_failed else "pass") if file in retry_times else ("fail" if file in failed else "pass")}
    return records


baseline, traced = sys.argv[1:3]
after = sys.argv[3] if len(sys.argv) > 3 else None
runs = {"before": baseline, "trace": traced, **({"after": after} if after else {})}
tables = {name: {mode: results(directory, mode) for mode in ("inline", "process")} for name, directory in runs.items()}
hits = {}
for path in pathlib.Path(traced).rglob("*.test.ts.jsonl"):
    owner = path.name.removesuffix(".jsonl")
    mode = "inline" if "inline" in str(path.relative_to(traced).parts[0]) else "process"
    for line in path.read_text().splitlines():
        event = json.loads(line)
        hits.setdefault(owner, set()).add(f"{mode}/{event['branch']}/{event['result']}")
files = sorted(path.name for path in (ROOT / "tests").glob("*.test.ts"))
rows = []
for file in files:
    row = {"file": file, "static": file in manifest["static"], "area": file in manifest["area"], "branchHit": file in hits,
           "historical": file in manifest["historical"], "processSelected": file in manifest["files"],
           "branches": ";".join(sorted(hits.get(file, [])))}
    for name, modes in tables.items():
        for mode, records in modes.items():
            for field in ("seconds", "first", "retry", "retrySeconds", "final"):
                row[f"{name}_{mode}_{field}"] = records.get(file, {}).get(field, "not scheduled" if field in ("first", "final") else "")
    rows.append(row)
OUT.mkdir(parents=True, exist_ok=True)
with (OUT / "files.csv").open("w") as stream:
    writer = csv.DictWriter(stream, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
summary = {"files": len(files), "static": len(manifest["static"]), "dynamic": len(hits),
           "area": len(manifest["area"]), "historical": len(manifest["historical"]), "selected": len(manifest["files"]),
           "runs": {name: {mode: {"files": len(records), "seconds": round(sum(r["seconds"] for r in records.values()), 1),
                                  "firstFailures": [f for f, r in records.items() if r["first"] == "fail"]}
                            for mode, records in modes.items()} for name, modes in tables.items()}}

# Optional `gh run view ID --json jobs,createdAt,updatedAt` snapshot beside each artifact tree.
def job_times(directory):
    path = pathlib.Path(directory) / "jobs.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    def timestamp(value):
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    jobs = [job for job in data["jobs"] if job["name"].startswith("test (")]
    if not jobs or any(job["status"] != "completed" for job in jobs):
        raise ValueError("Test jobs must be complete")
    rows = []
    for job in jobs:
        steps = [step for step in job["steps"] if step["name"].startswith("Run npm run test:shard")]
        rows.append({"name": job["name"], "conclusion": job["conclusion"],
                     "jobSeconds": (timestamp(job["completedAt"]) - timestamp(job["startedAt"])).total_seconds(),
                     "testSeconds": sum((timestamp(step["completedAt"]) - timestamp(step["startedAt"])).total_seconds() for step in steps)})
    return {"jobs": rows, "jobMinutes": round(sum(row["jobSeconds"] for row in rows) / 60, 2),
            "testStepMinutes": round(sum(row["testSeconds"] for row in rows) / 60, 2),
            "slowestJobSeconds": max(row["jobSeconds"] for row in rows),
            "slowestTestStepSeconds": max(row["testSeconds"] for row in rows),
            "testWindowSeconds": (max(timestamp(job["completedAt"]) for job in jobs) - min(timestamp(job["startedAt"]) for job in jobs)).total_seconds(),
            "ciUntilUpdatedSeconds": (timestamp(data["updatedAt"]) - timestamp(data["createdAt"])).total_seconds()}
summary["jobTimes"] = {name: job_times(directory) for name, directory in runs.items()}
(OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
