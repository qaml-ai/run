#!/usr/bin/env python3
"""Check and summarize the two-round native normal-start qualification.

Usage: python3 summarize.py raw/RUN_ID --output .
Reads captured files only. Requires the complete 64 GiB matrix and host-restoration
receipt before emitting results.json, phases.csv and results.md.
"""

import argparse
import csv
import hashlib
import io
import json
import math
import re
import statistics
import tarfile
from collections import defaultdict
from pathlib import Path


LINEAGE = re.compile(r"benchmark lineage=(coldbench-(0|50|500)-[0-9]+)\b")
TOKEN = re.compile(r'\b([A-Za-z_][A-Za-z_0-9]*)=("(?:[^"\\]|\\.)*"|[^\s]+)')
HEX40 = re.compile(r"[a-f0-9]{40}")
HEX64 = re.compile(r"[a-f0-9]{64}")
PAIRED = ("first-miss", "local-hit", "remote-hit", "api-edit", "api-add", "checkpoint-recovery")
PHASES = ("first-miss", "local-hit", "remote-hit", "api-edit", "api-add", "checkpoint", "checkpoint-recovery", "checkpoint-remote", "corrupt-prepare")
ARMS = ("canonical-control", "prebuilt")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def values(line):
    return {key: json.loads(value) if value.startswith('"') else value for key, value in TOKEN.findall(line)}


def number(fields, name):
    value = float(fields[name])
    require(math.isfinite(value) and value >= 0, f"invalid {name}: {value}")
    return value


def expected_matrix():
    keys = {(size, arm, phase) for size in (50, 500) for arm in ARMS for phase in PAIRED}
    keys |= {(size, "prebuilt", phase) for size in (50, 500) for phase in ("checkpoint", "checkpoint-remote")}
    keys |= {(0, arm, phase) for arm in ARMS for phase in ("first-miss", "local-hit", "remote-hit")}
    keys.add((50, "prebuilt", "corrupt-prepare"))
    return keys


def check_round(text, round_id, archive_path):
    require(re.search(r"(?m)^--- PASS: TestKVMPrebuiltSessionQualification \(", text), f"round {round_id}: terminal qualification PASS missing")
    require(not re.search(r"(?m)^--- FAIL:|^FAIL(?:\s|$)", text), f"round {round_id}: failed test in captured log")
    require(re.search(r"(?m)^PASS\s*$", text), f"round {round_id}: Go PASS missing")
    fixtures, records = {}, {}
    helpers, boots, checkpoints, baselines = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    apply_reads, rejections = set(), []
    current = None
    for line_no, line in enumerate(text.splitlines(), 1):
        match = LINEAGE.search(line)
        if match:
            lineage, size = match.groups()
            current = {"lineage": lineage, "sizeMiB": int(size)}
            require(int(size) not in fixtures, f"round {round_id}: duplicate size fixture")
            fixtures[int(size)] = current
        if "PREBUILT_FIXTURE " in line:
            fields = values(line)
            size = int(fields["size_mb"])
            require(current is not None and current["sizeMiB"] == size, "fixture has no matching lineage")
            require(int(fields["files"]) == (1 if size == 0 else 10000 + size - 40), "fixture shape differs from qualification")
            require(int(fields.get("virtual_size_bytes", "0")) == 64 << 30, "fixture did not use the pilot's 64 GiB disk")
            require(fields.get("format") == "2", "fixture did not use sparse image format 2")
            current["imageFormat"] = 2
            for name in ("commit", "tree"):
                require(HEX40.fullmatch(fields[name]), f"invalid fixture {name}")
                current[name] = fields[name]
            current["files"] = int(fields["files"])
        if "PREBUILT_SESSION_METRIC " in line:
            fields = values(line)
            key = int(fields["size_mb"]), fields["arm"], fields["phase"]
            require(key not in records, f"round {round_id}: duplicate metric {key}")
            require(current is not None and current["sizeMiB"] == key[0], "metric has no matching fixture")
            for name in ("commit", "tree"):
                require(HEX40.fullmatch(fields[name]), f"invalid metric {name}")
            require(int(fields.get("virtual_size_bytes", "0")) == 64 << 30, "metric did not use a 64 GiB disk")
            require(number(fields, "first_read_ms") < 60000, "first read exceeded the Worker startup deadline")
            vm = current["lineage"] + "-" + key[1] + "-" + key[2]
            records[key] = {"round": round_id, "sizeMiB": key[0], "arm": key[1], "phase": key[2],
                            "firstReadMs": number(fields, "first_read_ms"), "workspaceVirtualBytes": 64 << 30, "commit": fields["commit"], "tree": fields["tree"],
                            "lineage": current["lineage"], "vm": vm, "log": archive_path,
                            "member": f"logs-workspace/prebuilt-{round_id}.log", "line": line_no}
        if "PREBUILT_CORRUPTION_REJECTED " in line:
            fields = values(line)
            require(fields["code"] == "start_failed", "corruption did not reject startup")
            rejections.append({**fields, "round": round_id, "line": line_no})
        for marker, destination in (("compute_prebuilt_image ", helpers), ("compute_boot ", boots),
                                    ("compute_checkpoint ", checkpoints), ("compute_baseline ", baselines)):
            if marker in line:
                fields = values(line)
                destination[fields["vm"]].append({**fields, "line": line_no})
        if "compute_apply_reads " in line:
            apply_reads.add(values(line)["vm"])
    require(set(fixtures) == {0, 50, 500}, f"round {round_id}: incomplete size fixtures")
    require(set(records) == expected_matrix(), f"round {round_id}: incomplete matrix; missing={expected_matrix()-set(records)}, extra={set(records)-expected_matrix()}")
    require(len(rejections) == 1, f"round {round_id}: expected one corruption rejection")
    for size, fixture in fixtures.items():
        require("commit" in fixture and "tree" in fixture, "canonical fixture receipt missing")
        observed_order = [row["arm"] for row in records.values() if row["sizeMiB"] == size and row["phase"] == "first-miss"]
        require(observed_order == (list(ARMS) if round_id == 1 else list(reversed(ARMS))), f"round {round_id}: arm order was not reversed")
        fixture["logicalBytes"] = 4096 if size == 0 else 10000 * 4096 + (size - 40) * (1 << 20)
        fixture["workspaceVirtualBytes"] = 64 << 30
        paired_phases = ("first-miss", "local-hit", "remote-hit") if size == 0 else PAIRED
        for phase in paired_phases:
            a, b = (records[(size, arm, phase)] for arm in ARMS)
            require((a["commit"], a["tree"]) == (b["commit"], b["tree"]), f"paired versions differ for {size}/{phase}")
        for arm in ARMS:
            for phase in ("first-miss", "local-hit", "remote-hit"):
                row = records[(size, arm, phase)]
                require((row["commit"], row["tree"]) == (fixture["commit"], fixture["tree"]), "initial phases changed versions")
        if size == 0:
            continue
        checkpoint_row = records[(size, "prebuilt", "checkpoint")]
        added = records[(size, "prebuilt", "api-add")]
        require((checkpoint_row["commit"], checkpoint_row["tree"]) == (added["commit"], added["tree"]), "checkpoint startup did not replay API-added version")
        recovered = records[(size, "prebuilt", "checkpoint-recovery")]
        remote = records[(size, "prebuilt", "checkpoint-remote")]
        require((recovered["commit"], recovered["tree"]) == (remote["commit"], remote["tree"]), "checkpoint remote hit changed versions")
        require(recovered["commit"] != added["commit"] and recovered["tree"] != added["tree"], "checkpoint produced no new version/tree")
    for key, row in records.items():
        vm = row["vm"]
        good_boots = [entry for entry in boots[vm] if entry.get("error") == "<nil>"]
        require(len(good_boots) == 1, f"{vm}: expected one successful boot receipt")
        row["bootMs"] = {name: number(good_boots[0], name) for name in ("image", "mount", "first_exec", "syncMs", "disk", "assets", "tap", "policy", "scope", "vsock")}
        if row["arm"] == "prebuilt":
            require(vm not in apply_reads, f"{vm}: prebuilt startup read canonical apply payloads")
        if row["arm"] == "canonical-control" or row["phase"] == "local-hit":
            require(not helpers[vm], f"{vm}: unexpectedly used shared image helper")
        else:
            require(len(helpers[vm]) == 1, f"{vm}: expected one shared-image receipt")
            entry = helpers[vm][0]
            mode = "remote" if row["phase"] in ("remote-hit", "checkpoint", "checkpoint-remote") else "build"
            require(entry.get("error") == "<nil>" and entry["mode"] == mode and entry["tree"] == row["tree"], f"{vm}: invalid shared-image receipt")
            require(HEX64.fullmatch(entry["image"]), f"{vm}: invalid verified raw image ID")
            row["prebuilt"] = {"mode": mode, "image": entry["image"], **{name: number(entry, name) for name in ("buildMs", "publishMs", "transferMs", "ms")}}
        if row["phase"] == "checkpoint":
            require(len(checkpoints[vm]) == 2 and all(entry.get("error") == "<nil>" for entry in checkpoints[vm]), f"{vm}: changed/no-op checkpoint receipts missing")
            row["checkpoints"] = [{"kind": kind, **{name: number(entry, name) for name in ("freeze", "walk", "commit", "cas")}}
                                  for kind, entry in zip(("changed", "unchanged"), checkpoints[vm])]
        if row["arm"] == "canonical-control" and row["phase"] == "first-miss":
            require(any(entry.get("error") == "<nil>" for entry in baselines[vm]), f"{vm}: canonical baseline completion missing")
    corrupt = records[(50, "prebuilt", "corrupt-prepare")]
    require(rejections[0]["tree"] == corrupt["tree"], "corruption rejection targeted another tree")
    require(corrupt["tree"] not in {row["tree"] for key, row in records.items() if key != (50, "prebuilt", "corrupt-prepare")}, "fault injection reused a positive tree")
    return list(records.values()), list(fixtures.values()), rejections


def validate_restoration(receipt):
    require(receipt.get("draining") is False, "restored host is still draining")
    for name in ("lost", "restarting"):
        require(receipt.get(name) is None or receipt[name] is False, f"restored host is {name}")
    for name in ("allocated", "free", "slots"):
        require(not isinstance(receipt.get(name), bool) and re.fullmatch(r"[0-9]+", str(receipt.get(name))), f"invalid restored {name}")
    require(int(receipt["allocated"]) == 0, "restored host retains reservations")
    require(int(receipt["free"]) == int(receipt["slots"]) > 0, "restored host has no free capacity")



def validate_public_smoke(path, source):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    steps = defaultdict(list)
    for row in rows:
        steps[row["step"]].append(row)
    require(rows[-1]["step"] == "passed" and not steps["failed"], "normal-CLI smoke did not finish successfully")
    require(len(steps["starting"]) == 1 and steps["starting"][0]["source"] == source, "normal-CLI smoke used another source")
    require(len(steps["bash-turn"]) == 2, "normal-CLI smoke did not run both Bash sessions")
    for row in steps["bash-turn"]:
        require(row["state"] == "completed" and row["tools"] == [{"tool": "bash", "ok": True}], "normal-CLI Bash session failed")
    require(len(steps["ordinary-host-prebuilt-build"]) == 2, "normal-CLI image build receipts missing")
    builds = []
    for row in steps["ordinary-host-prebuilt-build"]:
        fields = values(row["receipt"])
        require(fields["mode"] == "build" and fields["tree"] == row["tree"] and fields["vm"] == row["vm"] and fields["error"] == "<nil>", "normal-CLI build receipt mismatch")
        builds.append({"vm": row["vm"], "tree": row["tree"], "helperMs": number(fields, "ms")})
    require(len(steps["public-bash-proof-passed"]) == 1, "normal-CLI fresh-boot/API-edit proof missing")
    proof = steps["public-bash-proof-passed"][0]
    require(proof["firstBoot"] != proof["secondBoot"], "normal-CLI did not use distinct guests")
    require(len(steps["compute-usage-reconciled"]) == 1, "normal-CLI billing proof missing")
    usage = steps["compute-usage-reconciled"][0]
    require(abs(usage["agentMicros"] - usage["expectedMicros"]) <= usage["eventCount"] and
            abs(usage["ledgerMicros"] - usage["expectedMicros"]) <= usage["eventCount"] and
            abs(usage["ledgerSeconds"] - usage["expectedSeconds"]) <= 0.001, "normal-CLI compute settlement mismatch")
    require(len(steps["owned-tenant-deleted"]) == 1 and all(steps["owned-tenant-deleted"][0][key] == 0 for key in ("tenants", "agents", "tokens")), "normal-CLI account cleanup missing")
    require(len(steps["owned-storage-cleanup"]) == 1 and steps["owned-storage-cleanup"][0]["currentS3Keys"] == 0, "normal-CLI storage cleanup missing")
    return {"passed": True, "builds": builds, "host": steps["starting"][0]["host"], "proof": proof, "computeUsage": usage,
            "cleanup": steps["owned-storage-cleanup"][0]}


def load(results, output):
    archive_path = results / "host-logs.tar.gz"
    require((results / "restored.json").is_file(), "serving-host restoration receipt missing")
    validate_restoration(json.loads((results / "restored.json").read_text()))
    with tarfile.open(archive_path, "r:gz") as archive:
        members = {}
        for item in archive:
            if item.isfile():
                require(item.name not in members, f"duplicate archive member {item.name}")
                members[item.name] = archive.extractfile(item).read()
    source = members["logs-workspace/revision.txt"].decode().strip()
    require(HEX40.fullmatch(source), "full source revision missing")
    binary_line = members["logs-workspace/binaries.sha256"].decode().splitlines()
    require(len(binary_line) == 1 and HEX64.fullmatch(binary_line[0].split()[0]), "binary digest missing")
    records, fixtures, rejections = [], [], []
    for round_id in (1, 2):
        rows, seeds, rejected = check_round(members[f"logs-workspace/prebuilt-{round_id}.log"].decode(), round_id, archive_path.relative_to(output).as_posix())
        records.extend(rows)
        fixtures.extend(seeds)
        rejections.extend(rejected)
    require(len({fixture["lineage"] for fixture in fixtures}) == 6, "fixture lineages were reused between rounds")
    require(len(records) == 70 and len(rejections) == 2, "qualification totals differ from 70 starts and 2 rejections")
    require((results / "revision.txt").read_text().strip() == source, "outer and archived source revisions differ")
    require((results / "binaries.sha256").read_text().split() == binary_line[0].split(), "outer and archived binary manifests differ")
    cleanup_lines = (results / "ddb-cleanup.log").read_text().splitlines()
    cleaned = {}
    for line in cleanup_lines:
        match = re.fullmatch(r"(coldbench-(?:0|50|500)-[0-9]+): cleared ([0-9]+) locator rows; image descriptors/payloads are S3-only", line)
        require(match is not None and match[1] not in cleaned and int(match[2]) > 0, "invalid or duplicate locator cleanup receipt")
        cleaned[match[1]] = int(match[2])
    require(set(cleaned) == {fixture["lineage"] for fixture in fixtures}, "locator cleanup does not cover exactly the qualification lineages")
    s3_cleanup = re.fullmatch(r"Cleared ([0-9]+) objects under (cold-bench/qualification/[^/]+/)\n?", (results / "s3-cleanup.log").read_text())
    require(s3_cleanup is not None and int(s3_cleanup[1]) > 0, "terminal S3 cleanup receipt missing")
    require(s3_cleanup[2] == f"cold-bench/qualification/{results.name}/", "S3 cleanup targeted another run")
    receipts = [{"path": path.relative_to(output).as_posix(), "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                for path in sorted(results.iterdir()) if path.is_file()]
    public_smoke = results / "public-smoke.jsonl"
    live = validate_public_smoke(public_smoke, source) if public_smoke.is_file() else None
    if live:
        validate_restoration(json.loads((results / "public-final-host-row.json").read_text()))
        health = json.loads((results / "public-final-public-health.json").read_text())
        require(health.get("ok") is True and health.get("backend") == "workers-native", "public Worker health receipt is not healthy")
        candidate = {line.split()[1]: line.split()[0] for line in (results / "candidate-binaries.sha256").read_text().splitlines()}
        require(candidate.get("kvm-qualification") == binary_line[0].split()[0] and HEX64.fullmatch(candidate.get("camelfsd-host", "")), "candidate and qualification binary manifests differ")
        running = (results / "public-final-running-host.txt").read_text().splitlines()
        require(f"source={source}" in running and "ActiveState=active" in running and "SubState=running" in running and
                f"{candidate['camelfsd-host']}  /usr/local/bin/camelfsd" in running, "final running host does not match the qualified candidate")
        live["hostBinarySHA256"] = candidate["camelfsd-host"]
    return {"format": 1, "source": source, "publicSmoke": live, "binarySHA256": binary_line[0].split()[0],
            "environment": {"hostType": "m8id.xlarge", "physicalHosts": 1, "vmVCPUs": 2, "vmMemoryMiB": 2048,
                            "workspaceVirtualMiB": 65536, "pilotUnitWorkspaceVirtualMiB": 65536, "daemonDefaultWorkspaceVirtualMiB": 1024, "workspaceImageFormat": 2}, "records": records,
            "fixtures": fixtures, "corruptionRejections": rejections,
            "cleanup": {"locatorRowsByLineage": cleaned, "currentS3Objects": int(s3_cleanup[1]), "s3Prefix": s3_cleanup[2]}, "receipts": receipts}


def render(data):
    records = data["records"]
    lines = ["# Normal VM starts with prebuilt ext4 images", "", f"Source `{data['source']}`; qualification binary SHA256 `{data['binarySHA256']}`.", "",
             "Two order-reversed rounds ran on one physical Firecracker host. Each round used a one-file 4 KiB fixture plus new nominal 50/500 MiB random fixtures: 10,000 × 4 KiB files plus 1 MiB binaries (10 or 460). Each paired arm replayed the same committed version. Fresh host directories model empty local caches; S3 and the physical host were shared.", "",
             "The pilot host was an m8id.xlarge. VMs used 2 vCPU and 2048 MiB RAM. All workspace disks were 64 GiB, matching the pilot serving unit, and held 4 KiB or 49.0625/499.0625 MiB of logical data. The bare daemon command defaults to 1024 MiB unless configured by its serving unit. Guest image and kernel digests were pinned in the captured runner.", "",
             "All 70 timed startups passed full-file checksum/count assertions. Four changed/no-op checkpoint pairs passed; restored checkpoint files preserved executable mode and symlink target. Two distinct fault-injection images were rejected before becoming runnable. The captured restoration receipt is required by the checker.", "",
             "The first-read timer starts before the ordinary VM-create request to a ready host and ends after a verified SHA256 read. Host-process initialization, including canonical blank-image creation, precedes it. First-miss includes synchronous image build and publication. API-edit/add use fresh host directories after the canonical API commit exists; API write latency is outside this timer. The checkpoint row times startup before the checkpoint RPCs; reported checkpoint stages appear separately.", "",
             "| Size | Phase | Canonical seconds median [min–max] | Prebuilt seconds median [min–max] | Prebuilt change | n per arm |", "|---|---|---:|---:|---:|---:|"]
    for size in (0, 50, 500):
        for phase in (("first-miss", "local-hit", "remote-hit") if size == 0 else PHASES):
            if phase == "corrupt-prepare":
                continue
            groups = {arm: [row["firstReadMs"] / 1000 for row in records if (row["sizeMiB"], row["phase"], row["arm"]) == (size, phase, arm)] for arm in ARMS}
            a, b = (statistics.median(groups[arm]) if groups[arm] else None for arm in ARMS)
            change = f"{(b / a - 1) * 100:+.1f}%" if a and b else "—"
            canonical = seconds_range(groups["canonical-control"]) if a is not None else "—"
            prebuilt = seconds_range(groups["prebuilt"]) if b is not None else "—"
            count = f"{len(groups['canonical-control'])}/{len(groups['prebuilt'])}"
            lines.append(f"| {size_label(size)} | {phase} | {canonical} | {prebuilt} | {change} | {count} |")
    remote = [row for row in records if row.get("prebuilt", {}).get("mode") == "remote"]
    slowest = max(remote, key=lambda row: row["firstReadMs"])
    slowest_build = max((row for row in records if row.get("prebuilt", {}).get("mode") == "build"), key=lambda row: row["firstReadMs"])
    lines += ["", "Values are medians and complete observed ranges of two runs; the JSON and CSV retain every per-phase value and boot stage. Positive percentages mean prebuilt was slower. The n column gives canonical/prebuilt counts.", "",
              f"The slowest new-image startup was round {slowest_build['round']}, {size_label(slowest_build['sizeMiB'])}, `{slowest_build['phase']}`: {slowest_build['firstReadMs']/1000:.6f} s to the first verified read, including {slowest_build['prebuilt']['ms']/1000:.6f} s in the helper ({slowest_build['prebuilt']['buildMs']/1000:.6f} s build and {slowest_build['prebuilt']['publishMs']/1000:.6f} s publication).", "",
              f"The slowest remote-mode startup was round {slowest['round']}, {slowest['sizeMiB']} MiB, `{slowest['phase']}`: {slowest['firstReadMs']/1000:.6f} s to the first verified read, including {slowest['prebuilt']['transferMs']/1000:.6f} s in the transfer/decode helper. That helper includes HEAD/range downloads, gzip decoding, hashing, sparse-file writes and fsync; the run did not measure their individual durations.", "",
              "| Size | All successful remote-mode starts | First-read seconds median [min–max] | Transfer/decode seconds median [min–max] |", "|---|---:|---:|---:|"]
    for size in (0, 50, 500):
        rows = [row for row in remote if row["sizeMiB"] == size]
        first = seconds_range([row["firstReadMs"] / 1000 for row in rows])
        transfer = seconds_range([row["prebuilt"]["transferMs"] / 1000 for row in rows])
        lines.append(f"| {size_label(size)} | {len(rows)} | {first} | {transfer} |")
    lines += ["", "This remote group includes `remote-hit`, startup before `checkpoint`, and `checkpoint-remote`; it combines different committed trees. Its range describes every remote-mode observation in this run.", "",
              "| Size | Producer phase | Build seconds | Publish seconds | Helper total seconds |", "|---|---|---:|---:|---:|"]
    for size in (0, 50, 500):
        for phase in (("first-miss",) if size == 0 else ("first-miss", "api-edit", "api-add", "checkpoint-recovery")):
            entries = [row["prebuilt"] for row in records if row["sizeMiB"] == size and row["phase"] == phase and row["arm"] == "prebuilt"]
            values_ms = [statistics.median(entry[name] for entry in entries) / 1000 for name in ("buildMs", "publishMs", "ms")]
            lines.append(f"| {size_label(size)} | {phase} | " + " | ".join(f"{value:.3f}" for value in values_ms) + " |")
    lines += ["", "Helper total includes lookup and local cache installation as well as build/publication. These costs are already inside first-read time; adding them again would double count.", "",
              "| Size | Checkpoint | Freeze ms | Walk ms | Commit ms | CAS ms |", "|---|---|---:|---:|---:|---:|"]
    for size in (50, 500):
        for kind in ("changed", "unchanged"):
            entries = [entry for row in records if row["sizeMiB"] == size for entry in row.get("checkpoints", []) if entry["kind"] == kind]
            stages = [statistics.median(entry[name] for entry in entries) for name in ("freeze", "walk", "commit", "cas")]
            lines.append(f"| {size_label(size)} | {kind} | " + " | ".join(f"{value:.3f}" for value in stages) + " |")
    lines += ["", "Checkpoint columns are the host’s reported stages, not an independently measured end-to-end RPC timer.", "", "## Reproduce the report", "", "```sh", "python3 summarize.py raw/RUN_ID --output .", "python3 summarize.py raw/RUN_ID --output . --check", "```", "", "The parser requires both complete 35-start matrices, paired canonical versions, successful boot/baseline/checkpoint receipts, expected build/remote/local behavior, two corruption refusals, exact fixture cleanup and the restoration receipt. It checks that the captured host is undrained, healthy and fully free. It reads captured artifacts only.", "", "## Raw evidence", ""]
    if data["publicSmoke"]:
        live = data["publicSmoke"]
        usage = live["computeUsage"]
        build_times = "/".join(f"{entry['helperMs']:.3f}" for entry in live["builds"])
        lines[-3:-3] = ["", "## Deployed normal-CLI canary", "", "The separate public Worker/SDK canary passed two Bash sessions on distinct guests, a committed checkpoint, an API addition before the next start, exact compute settlement and owned account/storage cleanup. Its two ordinary-host image build receipts match this source. Model and Worker ingress time are outside the native timing tables above.", "",
                        f"The two normal-host image helpers took {build_times} ms. Their compute usage reconciled at {usage['expectedSeconds']:.3f} seconds, {usage['agentMicros']:.6f} µUSD in agent usage and {usage['ledgerMicros']:.0f} µUSD in the rounded ledger ({usage['eventCount']} events), stable across a later observation. The final receipts retain candidate `{live['hostBinarySHA256']}`, active/running, with all host slots free and healthy public Worker status.", ""]
    for receipt in data["receipts"]:
        target = Path(receipt["path"])
        lines.append(f"- [{target.name}]({target.as_posix()}): {receipt['bytes']} bytes, SHA256 `{receipt['sha256']}`.")
    return "\n".join(lines) + "\n"


def size_label(size):
    return "4 KiB" if size == 0 else f"{size} MiB"


def seconds_range(group):
    return f"{statistics.median(group):.3f} [{min(group):.3f}–{max(group):.3f}]"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--output", type=Path, default=Path("."))
    parser.add_argument("--check", action="store_true", help="compare regenerated output with saved output without writing")
    args = parser.parse_args()
    output = args.output.resolve()
    data = load(args.results.resolve(), output)
    phases = io.StringIO(newline="")
    fields = ("round", "sizeMiB", "arm", "phase", "firstReadMs", "workspaceVirtualBytes", "commit", "tree", "lineage", "vm", "log", "member", "line")
    writer = csv.DictWriter(phases, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    writer.writerows(data["records"])
    outputs = {"results.json": json.dumps(data, indent=2) + "\n", "phases.csv": phases.getvalue(), "results.md": render(data)}
    if args.check:
        for name, body in outputs.items():
            path = output / name
            require(path.is_file() and path.read_bytes() == body.encode(), f"saved {name} differs from regenerated output")
    else:
        output.mkdir(parents=True, exist_ok=True)
        for name, body in outputs.items():
            (output / name).write_bytes(body.encode())
    print(f"Verified {len(data['records'])} startups and {len(data['corruptionRejections'])} corruption refusals at {data['source']}.")


if __name__ == "__main__":
    main()
