#!/usr/bin/env python3
"""Local Docker-only boot comparison; never contacts AWS. Uses an existing disposable Postgres.

Example: python3 scripts/bench-boot.py --before camelrun-boot:baseline --after camelrun-boot:after \
  --baseline-source /tmp/camelrun-boot-original --database-host host.docker.internal --database-port 55882
Baseline-source contains git-show copies of src/node.ts and src/voice/turns/{inference,inference-worker}.ts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--baseline-source", type=Path, required=True)
    parser.add_argument("--database-host", default="host.docker.internal")
    parser.add_argument("--database-port", type=int, required=True)
    parser.add_argument("--trials", type=int, default=5)
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix="camelrun-boot-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        (root / "tenants.json").write_text(json.dumps({"tenants": {"bench": {"tokenSha256": hashlib.sha256(b"local-boot-fixture").hexdigest()}}}))
        (root / "uptime.mjs").write_text('const log = console.log; console.log = (...args) => { try { const line = JSON.parse(args[0]); if (line.type === "listening") args[0] = JSON.stringify({...line, uptimeMs: Math.round(process.uptime()*1000)}); } catch {} log(...args); };')
        # First pair warms Docker layers and applies migrations to the disposable database; exclude it.
        for trial in range(args.trials + 1):
            for variant, image in [("before", args.before), ("after", args.after)]:
                command = ["run", "-d", "--cpus=1", "--memory=2g", "-v", f"{root}:/bench:ro"]
                if variant == "before":
                    for file in ["src/node.ts", "src/voice/turns/inference.ts", "src/voice/turns/inference-worker.ts"]:
                        command += ["-v", f"{(args.baseline_source / file).resolve()}:/app/{file}:ro"]
                for value in ["AGENT_TENANTS_FILE=/bench/tenants.json", "AGENT_SESSION_SECRET=local-boot-fixture-with-at-least-32-chars", f"AGENT_DATABASE_URL=postgres://postgres:test@{args.database_host}:{args.database_port}/postgres", "AGENT_VOICE=true", "AGENT_VOICE_TURN_MODELS=true", "AGENT_HOSTING=inline"]:
                    command += ["-e", value]
                started = time.monotonic()
                container = docker(*command, image, "node", "--import", "/bench/uptime.mjs", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts")
                try:
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        logs = docker("logs", container)
                        lines = []
                        for line in logs.splitlines():
                            try:
                                lines.append(json.loads(line))
                            except ValueError:
                                pass
                        listening = next((line for line in lines if line.get("type") == "listening"), None)
                        if listening:
                            # Give background models time to report, without including this in listening time.
                            time.sleep(1)
                            stages = [json.loads(line) for line in docker("logs", container).splitlines() if line.startswith('{"type":"startup_stage"')]
                            if trial:
                                results.append({"trial": trial, "variant": variant, "listeningUptimeMs": listening["uptimeMs"], "observedContainerToListeningMs": round((time.monotonic() - started - 1) * 1000), "stages": stages})
                            break
                        time.sleep(0.05)
                    else:
                        raise RuntimeError(f"{variant} did not listen: {logs}")
                finally:
                    docker("stop", "-t", "15", container)
                    docker("rm", "-f", container)
    print(json.dumps({"environment": "local Docker ARM64, 1 CPU / 2 GiB, warm layers, disposable local PostgreSQL; no AWS/provider calls", "images": {variant: {"tag": tag, "bytes": int(docker("image", "inspect", tag, "--format", "{{.Size}}"))} for variant, tag in [("before", args.before), ("after", args.after)]}, "medianListeningUptimeMs": {variant: statistics.median(row["listeningUptimeMs"] for row in results if row["variant"] == variant) for variant in ["before", "after"]}, "trials": results}, indent=2))


if __name__ == "__main__":
    main()
