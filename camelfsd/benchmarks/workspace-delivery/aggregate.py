#!/usr/bin/env python3
"""Aggregate completed isolated prototypes, requiring every planned trial."""

import argparse
import collections
import csv
import hashlib
import json
import math
import re
import statistics
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORK = ROOT / "raw"
PHASES = ("initial", "api-edit", "api-add")
SERIES = (
    ("packed", "20261117T153951Z-f8831868", "random", 12, {"baseline": 4, "packedplain": 4, "packedgzip": 4}),
    ("ranges-images", "20261117T155154Z-49671f85", "random", 6,
     {"packedparallel": 2, "image": 2, "imageparallel": 2}),
    ("source", "20261117T154851Z-1a566035", "source", 4, {"baseline": 2, "packedgzip": 2}),
    ("medium", "20261117T160805Z-21f994ca", "random", 1, {"bundlemedium": 1}),
)
TRIAL = re.compile(r"logs-workspace/(50|500)MiB-([1-3])-(\w+)\.log")
RUN = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{8}")
LABELS = (
    "WORKSPACE_METRIC", "PACKED_APPLY_RESULT", "PACKED_APPLY_BUILD",
    "PACKED_APPLY_API_EDIT", "PACKED_APPLY_API_ADD", "compute_boot",
    "compute_apply_reads", "compute_apply_archive", "CLEAN_IMAGE_BUILD",
    "CLEAN_IMAGE_RESTORE", "CLEAN_IMAGE_USED",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    value = float(value)
    require(math.isfinite(value), "nonfinite measurement")
    return value


def one(values, description):
    require(len(values) == 1, f"expected one {description}, found {len(values)}")
    return values[0]


def events(text):
    out = collections.defaultdict(list)
    for line in text.splitlines():
        for label in LABELS:
            match = re.search(r"\b" + label + r" (.*)", line)
            if match:
                out[label].append(dict(re.findall(r"(\w+)=([^ ]+)", match[1])))
                break
    return out


def phase_for_vm(row, lineage):
    return one([phase for phase in PHASES if row.get("vm") == lineage + "-" + phase], "VM phase")


def parse_trial(series, fixture, run_id, trial, log):
    size, round_number, arm = trial["sizeMiB"], trial["round"], trial["arm"]
    require("--- PASS: TestKVMColdSessionBench" in log and "\nPASS\n" in log,
            f"trial did not pass: {run_id}/{size}/{round_number}/{arm}")
    lineage = one(re.findall(r"benchmark lineage=(coldbench-\d+-\d+)", log), "lineage")
    require(trial["lineages"] == [lineage], "summary/archive lineage mismatch")
    content = re.findall(r"benchmark content=(random|source)", log)
    require(content == [fixture] if fixture == "source" else content in ([], [fixture]),
            "fixture content does not match the executed benchmark")
    rows = events(log)
    workspace = rows["WORKSPACE_METRIC"]
    require(len(workspace) == 3 and {x["phase"] for x in workspace} == set(PHASES), "trial must have all three phases")
    reported = events("\n".join(trial["metrics"]))["WORKSPACE_METRIC"]
    require(workspace == reported, "summary/archive first-read mismatch")
    terminal = one(rows["PACKED_APPLY_RESULT"], "terminal result")
    require(int(terminal["files"]) == 10000 + size - 40, "unexpected base file inventory")
    require(int(terminal["size_mb"]) == size, "result size mismatch")
    metric_map = {x["phase"]: x for x in workspace}
    result_keys = ("initial_ms", "api_edit_fresh_ms", "api_add_fresh_ms")
    for phase, key in zip(PHASES, result_keys):
        require(abs(number(metric_map[phase]["first_read_ms"]) - number(terminal[key])) < 0.002,
                "terminal/phase measurement mismatch")
    out = {}
    seeded = one(re.findall(r"seed \d+ MB, \d+ files: ([^,]+), tree [0-9a-f]{40}", log), "canonical seed duration")
    units = {"h": 3600000, "m": 60000, "s": 1000, "ms": 1, "µs": 0.001, "ns": 0.000001}
    seed_ms = sum(number(value) * units[unit] for value, unit in re.findall(r"([0-9.]+)(ms|µs|ns|h|m|s)", seeded))
    require(seed_ms > 0, "invalid canonical seed duration")
    for phase in PHASES:
        row = metric_map[phase]
        require(int(row["size_mb"]) == size and number(row["first_read_ms"]) > 0, "invalid first read")
        out[phase] = dict(series=series, fixture=fixture, run=run_id, sizeMiB=size,
                          round=round_number, arm=arm, phase=phase, lineage=lineage,
                          files=10000 + size - 40 + (phase == "api-add"),
                          canonicalSeedMs=seed_ms,
                          firstReadMs=number(row["first_read_ms"]), prepareMs=0.0, apiWriteMs=0.0,
                          rawLog=f"raw/{run_id}/host-logs.tar.gz#logs-workspace/{size}MiB-{round_number}-{arm}.log")
    for label, phase in (("PACKED_APPLY_API_EDIT", "api-edit"), ("PACKED_APPLY_API_ADD", "api-add")):
        out[phase]["apiWriteMs"] = number(one(rows[label], label)["ms"])
    for row in rows["compute_boot"]:
        record = out[phase_for_vm(row, lineage)]
        require(row.get("error") == "<nil>", "boot error in passed trial")
        for key, target in (("image", "bootImageMs"), ("mount", "bootMountMs"),
                            ("first_exec", "bootFirstExecMs"), ("syncMs", "guestSyncMs"),
                            ("disk", "bootDiskMs"), ("vsock", "bootVsockMs")):
            record[target] = number(row[key])
    require(len(rows["compute_boot"]) == 3, "expected three boot breakdowns")
    for row in rows["compute_apply_reads"]:
        if row.get("vm") == "archive-build":
            continue
        record = out[phase_for_vm(row, lineage)]
        for key in ("locatorMs", "looseReads", "packGets", "rangeGets", "bundleBytes"):
            record[key] = number(row[key])
        record["payloadGETCount"] = sum(number(row[key]) for key in ("looseReads", "packGets", "rangeGets"))
    image_arm = arm in ("image", "imageparallel")
    packed_arm = arm.startswith("packed")
    if image_arm:
        builds, restores, uses = (rows[label] for label in ("CLEAN_IMAGE_BUILD", "CLEAN_IMAGE_RESTORE", "CLEAN_IMAGE_USED"))
        require(len(builds) == len(restores) == len(uses) == 3, "image arm missing complete preparation/use evidence")
        require(not rows["compute_apply_reads"], "image arm fetched canonical payloads")
        for phase, build, restore, used in zip(PHASES, builds, restores, uses):
            require(build["tree"] == restore["tree"] == used["tree"] and used["phase"] == phase and used["warm"] == "true",
                    "image use/binding mismatch")
            record = out[phase]
            require(int(build["files"]) == record["files"], "image artifact file count mismatch")
            record.update(tree=build["tree"], commit=build["version"], storedBytes=int(build["compressed_bytes"]),
                          imageVirtualBytes=int(build["virtual_bytes"]), transferRestoreMs=number(restore["transfer_restore_ms"]),
                          expectedPayloadGETCount=math.ceil(int(build["compressed_bytes"]) / (8 << 20)) if arm == "imageparallel" else 1)
            for key, target in (("materialize_ms", "materializeMs"), ("mkfs_ms", "mkfsMs"),
                                ("compress_ms", "compressMs"), ("total_ms", "buildMs"), ("upload_ms", "uploadMs")):
                record[target] = number(build[key])
            record["prepareMs"] = record["buildMs"] + record["uploadMs"]
    elif packed_arm:
        builds, replays = rows["PACKED_APPLY_BUILD"], rows["compute_apply_archive"]
        require(len(builds) == len(replays) == 3, "packed arm missing preparation/replay evidence")
        for build in builds:
            phase = build["phase"]
            record = out[phase]
            replay = one([r for r in replays if r["tree"] == build["tree"]], "packed replay")
            require(replay["error"] == "<nil>", "packed replay error")
            require(int(replay["storedBytes"]) == int(build["stored_bytes"]), "artifact byte mismatch")
            parallel = replay.get("parallel") == "true"
            require(parallel == (arm == "packedparallel"), "wrong packed download mode")
            record.update(tree=build["tree"], commit=build["commit"], artifactBlob=build["blob"],
                          artifactSHA256=build["sha256"], rawSHA256=build["raw_sha256"],
                          prepareMs=number(build["ms"]), storedBytes=int(build["stored_bytes"]),
                          rawBytes=int(build["raw_bytes"]), logicalBytes=int(build["logical_bytes"]),
                          downloadVerifyMs=number(replay["fetchMs"]), decodeVerifyMs=number(replay["verifyMs"]),
                          guestSendMs=number(replay["sendMs"]), payloadGETCount=int(replay["rangeGets"]) if parallel else 1)
            if parallel:
                require(record["payloadGETCount"] == math.ceil(record["storedBytes"] / (8 << 20)), "range count mismatch")
    else:
        require(arm in ("baseline", "bundlemedium") and len(rows["compute_apply_reads"]) == 3,
                "unexpected canonical restore payload evidence")
    for record in out.values():
        record["apiPlusPreparePlusReadMs"] = record["apiWriteMs"] + record["prepareMs"] + record["firstReadMs"]
    return list(out.values())


def read_series(spec):
    name, run_id, fixture, expected_count, expected_arms = spec
    require(RUN.fullmatch(run_id), f"invalid run identifier {run_id}")
    run = WORK / run_id
    needed = ("summary.json", "restored.json", "host-logs.tar.gz", "ddb-cleanup.log", "s3-cleanup.log")
    missing = [name for name in needed if not (run / name).is_file()]
    allowed_counts = (expected_count,) if isinstance(expected_count, int) else expected_count
    status = dict(series=name, fixture=fixture, run=run_id, expectedTrials=list(allowed_counts),
                  expectedPhases=[n * 3 for n in allowed_counts], missing=missing)
    if missing:
        return status, [], None
    restored = json.loads((run / "restored.json").read_text())
    require(restored["draining"] is False and int(restored["allocated"]) == 0 and
            int(restored["free"]) == int(restored["slots"]) and not restored.get("lost") and not restored.get("restarting"),
            f"pilot not restored after {run_id}")
    summary = json.loads((run / "summary.json").read_text())
    trials = summary["trials"]
    require(len(trials) in allowed_counts, f"{name}: expected {allowed_counts} trials, found {len(trials)}")
    actual_arms = collections.Counter(t["arm"] for t in trials)
    require(set(actual_arms) == set(expected_arms), f"{name}: unexpected arms")
    for arm, count in expected_arms.items():
        choices = (count,) if isinstance(count, int) else count
        require(actual_arms[arm] in choices, f"{name}: unexpected count for {arm}")
    if name == "medium":
        require(all(t["sizeMiB"] == 500 for t in trials), "medium fixture must be 500 MiB")
    keys = [(t["sizeMiB"], t["round"], t["arm"]) for t in trials]
    require(len(set(keys)) == len(keys), f"{name}: duplicate trial")
    phases = []
    with tarfile.open(run / "host-logs.tar.gz", "r:gz") as archive:
        logs = {}
        for member in archive:
            match = TRIAL.fullmatch(member.name)
            if match and member.isfile():
                key = int(match[1]), int(match[2]), match[3]
                require(key not in logs, "duplicate archived log")
                logs[key] = archive.extractfile(member).read().decode()
        require(set(logs) == set(keys), "summary/archive trial inventory mismatch")
        if "logs-workspace/content.txt" in archive.getnames():
            require(archive.extractfile("logs-workspace/content.txt").read().decode().strip() == fixture, "fixture content mismatch")
        revisions = {}
        for line in archive.extractfile("logs-workspace/revisions.tsv").read().decode().splitlines():
            arm, revision, sha = line.split("\t")
            require(arm not in revisions and re.fullmatch(r"[0-9a-f]{40}", revision) and
                    re.fullmatch(r"[0-9a-f]{64}", sha), "invalid revision provenance")
            revisions[arm] = dict(revision=revision, binarySha256=sha)
        require(revisions == summary["revisions"], "revision manifest mismatch")
        for trial in trials:
            key = trial["sizeMiB"], trial["round"], trial["arm"]
            phases.extend(parse_trial(name, fixture, run_id, trial, logs[key]))
    lineages = {p["lineage"] for p in phases}
    require(len(lineages) == len(trials), "fresh trials reused a lineage")
    cleanup = (run / "ddb-cleanup.log").read_text()
    require(all(f"{lineage}: cleared " in cleanup for lineage in lineages), "locator cleanup receipt incomplete")
    require(run_id in (run / "s3-cleanup.log").read_text(), "S3 cleanup scope mismatch")
    status.update(actualTrials=len(trials), actualPhases=len(phases), complete=True)
    if name == "medium":
        status.update(allowedTrialCounts=list(allowed_counts), expectedTrials=[len(trials)],
                      expectedPhases=[len(phases)])
    return status, phases, revisions


def statistics_for(values):
    return dict(n=len(values), median=statistics.median(values), minimum=min(values), maximum=max(values))


def aggregate(phases):
    grouped = collections.defaultdict(list)
    for row in phases:
        key = row["fixture"], row["sizeMiB"], row["arm"]
        grouped[key + (row["phase"],)].append(row)
        grouped[key + ("combined",)].append(row)
    out = []
    metadata = {"sizeMiB", "round", "files"}
    for (fixture, size, arm, phase), rows in sorted(grouped.items()):
        fields = {k for row in rows for k, value in row.items() if isinstance(value, (int, float)) and k not in metadata}
        metrics = {k: statistics_for([row[k] for row in rows if k in row]) for k in sorted(fields)}
        out.append(dict(fixture=fixture, sizeMiB=size, arm=arm, phase=phase, metrics=metrics))
    return out


def warm_service():
    base = ROOT / "warm-repo-service/raw"
    out = []
    cleanup = json.loads((base / "cleanup.json").read_text())
    require(cleanup["serverProcesses"] == 0 and cleanup["syntheticStateAbsent"] and
            cleanup["priorURLAuth"] == cleanup["restoredURLAuth"] and cleanup["pairedRunExit"] == 0,
            "warm service cleanup incomplete")
    for size in (50, 500):
        rows = [json.loads(line) for line in (base / f"shard-2/client-{size}.jsonl").read_text().splitlines() if line]
        first = one([r for r in rows if r["event"] == "warm_repo_remote_first_file"], "warm first read")
        snapshots = [r for r in rows if r["event"] == "warm_repo_remote_snapshot"]
        api = one([r for r in rows if r["event"] == "warm_repo_remote_api"], "warm repeated API read")
        fill = one([json.loads(line) for line in (base / f"shard-1/fill-{size}.jsonl").read_text().splitlines() if line], "warm fill")
        require(first["path"] == "src/d000/f00000.ts" and first["bytes"] == 4096, "warm marker mismatch")
        require(len(snapshots) == 3 and {r["trial"] for r in snapshots} == {1, 2, 3}, "warm snapshot trials incomplete")
        require(api["calls"] == 32 and all(r["files"] == 10000 + size - 40 for r in snapshots), "warm inventory mismatch")
        require(all(r["bytes"] == 10000 * 4096 + (size - 40) * (1 << 20) for r in snapshots), "warm payload count mismatch")
        require(all(r["commit"] == first["commit"] and r["tree"] == first["tree"] for r in snapshots), "warm pinned version mismatch")
        out.append(dict(sizeMiB=size, firstReadMs=first["ms"], apiP50Ms=api["p50Ms"], apiP95Ms=api["p95Ms"],
                        fullSnapshotMs=statistics_for([r["ms"] for r in snapshots]), localFillMs=fill["ms"],
                        files=snapshots[0]["files"], logicalBytes=snapshots[0]["bytes"], commit=first["commit"], tree=first["tree"]))
    return out


def amortization(groups):
    initial = {(g["fixture"], g["sizeMiB"], g["arm"]): g["metrics"]
               for g in groups if g["phase"] == "initial"}
    rows = []
    for (fixture, size, arm), metrics in initial.items():
        if arm == "baseline" or (fixture, size, "baseline") not in initial:
            continue
        baseline = initial[fixture, size, "baseline"]["firstReadMs"]["median"]
        restore = metrics["firstReadMs"]["median"]
        prepare = metrics["prepareMs"]["median"]
        saving = baseline - restore
        rows.append(dict(fixture=fixture, sizeMiB=size, arm=arm, baselineColdReadMs=baseline,
                         readyArtifactColdReadMs=restore, prepareMs=prepare, firstMissTotalMs=prepare + restore,
                         savingPerColdRestoreMs=saving,
                         approximateUsesToBreakEven=max(1, math.ceil(prepare / saving)) if saving > 0 else None))
    return rows


def cell(stats, seconds=False):
    if stats is None:
        return "—"
    scale = 1000 if seconds else 1
    return f'{stats["median"]/scale:.3f} [{stats["minimum"]/scale:.3f}, {stats["maximum"]/scale:.3f}]'


def render(data):
    lines = ["# Workspace delivery prototypes", "", f'Generated {data["generatedAt"]}.', ""]
    if not data["complete"]:
        lines += ["**Preliminary. Some planned series are pending.**", ""]
    lines += [f'Recorded {data["trialCount"]} VM trials and {data["phaseCount"]} phases, plus the separate two-Sprite HTTP experiment.', ""]
    lines += ["Canonical parallel restore is the simplest choice when commits change frequently. Every derived artifact increased the measured first-miss time once full preparation and upload were included.", "",
              "For repeated cold restores of the same commit, parallel clean images had the fastest ready-artifact times: 1.404/3.102 seconds at 50/500 MiB, with 2.928/14.682 seconds of preparation per tree. Initial-phase arithmetic suggests about 4/21 cold uses to recover that preparation. Gzip apply streams reuse the existing guest receiver and improved the artificially compressible source fixture from 2.303 to 1.647 seconds, with 0.823 seconds of preparation; that fixture suggests roughly two cold uses.", "",
              "The one bulk 1 MiB bundle layout was slower than the 500 MiB baseline. The warm Git service measured file and snapshot HTTP transfer, so its results alone do not establish a faster VM restore or a simpler replacement for the current API cache.", ""]
    lines += ["Each VM trial used a fresh daemon process, empty workspace cache and fresh local metadata on the same physical Firecracker host. Canonical objects were in S3. First read verifies the requested file. Initial markers are 4 KiB, and API phases verify shorter new text. Image times include downloading, verifying and restoring the image before VM creation. Full workspace hydration precedes guest execution. Every phase checked the full file count.", "",
              "The random fixture has 10,000 random 4 KiB files and 10 or 460 random 1 MiB binaries. Labels 50/500 MiB represent 49.0625/499.0625 MiB of initial payload and 10,010/10,460 files. API edit replaces the marker, and API add creates `src/api-added.ts`. The source fixture replaces only small files with repeated per-path TypeScript-like text. It is artificially compressible and leaves large binaries random.", "",
              "| Series | Run | Expected trials / phases | Recorded trials / phases |", "| --- | --- | --- | --- |"]
    for status in data["series"]:
        trials = "/".join(str(n) for n in status["expectedTrials"])
        phases = "/".join(str(n) for n in status["expectedPhases"])
        lines.append(f'| {status["series"]} | `{status["run"]}` | {trials} trials, {phases} phases | {status.get("actualTrials", 0)} / {status.get("actualPhases", 0)} |')
    lines += ["", "## Combined comparison", "", "Medians pool initial, API edit and API addition phases. Preparation is a separate cost for each committed tree.", "",
              "| Fixture | MiB | Arm | Trials / phases | Cold read seconds | Prepare seconds | Constraint |", "| --- | --- | --- | --- | --- | --- | --- |"]
    constraints = {"baseline": "Canonical parallel restore", "packedplain": "Single GET, verification spools, full rebuild",
                   "packedgzip": "Single GET, gzip, full rebuild", "packedparallel": "8 MiB range GETs, full rebuild",
                   "image": "mkfs and gzip producer, full rebuild", "imageparallel": "mkfs and gzip producer, range GETs",
                   "bundlemedium": "1 MiB cutoff, one bulk asset publication"}
    for group in data["aggregates"]:
        if group["phase"] != "combined":
            continue
        m = group["metrics"]
        n = m["firstReadMs"]["n"]
        lines.append(f'| {group["fixture"]} | {group["sizeMiB"]} | {group["arm"]} | {n//3} / {n} | {m["firstReadMs"]["median"]/1000:.3f} | {m["prepareMs"]["median"]/1000:.3f} | {constraints[group["arm"]]} |')
    lines += ["", "## First verified read", "", "Seconds shown as median [minimum, maximum]. Combined pools the three phases' samples. Preparation and API writes are excluded here and reported below.", "",
              "| Fixture | MiB label | Arm | Phase | n | Seconds |", "| --- | --- | --- | --- | --- | --- |"]
    for group in data["aggregates"]:
        value = group["metrics"]["firstReadMs"]
        lines.append(f'| {group["fixture"]} | {group["sizeMiB"]} | {group["arm"]} | {group["phase"]} | {value["n"]} | {cell(value, True)} |')
    lines += ["", "## Artifact preparation and API writes", "", "Preparation includes artifact build and upload. API mutation timing covers signed Storage API blob upload and commit creation. The fixture selects that commit directly for boot and excludes branch-ref CAS and public runtime routing. The last column adds API mutation, preparation, and first read for each sample before aggregation. It represents a serialized fixture operation that needs a new artifact. Background preparation would move the preparation cost outside that operation.", "",
              "| Fixture | MiB | Arm | Phase | Prepare seconds | Stored MiB | API write ms | API + prepare + read seconds |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for group in data["aggregates"]:
        if group["phase"] == "combined":
            continue
        m = group["metrics"]
        stored = m.get("storedBytes")
        stored_text = "—" if stored is None else f'{stored["median"]/(1<<20):.3f}'
        lines.append(f'| {group["fixture"]} | {group["sizeMiB"]} | {group["arm"]} | {group["phase"]} | {cell(m["prepareMs"], True)} | {stored_text} | {cell(m["apiWriteMs"])} | {cell(m["apiPlusPreparePlusReadMs"], True)} |')
    lines += ["", "## First miss and repeated use", "", "Approximate calculations use initial-phase medians. First miss adds a complete build/upload to the cold first read. Break-even compares one preparation plus N cold restores against N baseline cold restores of the same commit. It assumes the artifact remains available and ignores additional operational costs. Some arms ran in a later series with fewer repetitions, so these are arithmetic estimates rather than paired repeated-use measurements.", "",
              "| Fixture | MiB | Arm | Baseline cold seconds | Prepared cold seconds | Prepare seconds | First miss seconds | Approximate cold uses to break even |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in data["amortization"]:
        uses = row["approximateUsesToBreakEven"]
        values = [f'{row[k]/1000:.3f}' for k in ("baselineColdReadMs", "readyArtifactColdReadMs", "prepareMs", "firstMissTotalMs")]
        lines.append(f'| {row["fixture"]} | {row["sizeMiB"]} | {row["arm"]} | ' + " | ".join(values) + f' | {uses if uses is not None else "No saving observed"} |')
    lines += ["", "## Canonical fixture publication", "", "One seed measurement per trial includes fixture byte generation, canonical uploads, locator checks and tree import. It excludes derived artifact preparation. Seeding is a synthetic bulk-publication setup cost, and these values are not ordinary API-write latency.", "",
              "| Fixture | MiB | Arm | Trials | Seed seconds, median [min, max] |", "| --- | --- | --- | --- | --- |"]
    for group in data["aggregates"]:
        if group["phase"] != "initial":
            continue
        seed = group["metrics"]["canonicalSeedMs"]
        lines.append(f'| {group["fixture"]} | {group["sizeMiB"]} | {group["arm"]} | {seed["n"]} | {cell(seed, True)} |')
    lines += ["", "The medium-bundle candidate uses fresh synthetic fixtures, changes the locator contract to cover blobs through 1 MiB, and stages all asset files in one publication into 8 MiB packs. Individual 1 MiB API uploads would create singleton packs. It has no separate whole-tree artifact preparation, and its canonical publication cost still applies. One 500 MiB trial measured this bulk-publication pack layout. A separate deliberately interleaved 272 MiB test fetched about 1,016 MiB while crossing bounded apply windows. Ordinary ordered checkpoint spool windows can produce different pack locality, so that amplification does not describe every medium-bundle layout.", "",
              "## Restore breakdown", "", "Combined-phase medians in milliseconds. Packed fetch includes stored-byte verification, decoded verification uses a second spool, and guest send includes the existing guest apply stream. Image transfer/restore combines GET, verification, sparse decode and cache publication. Baseline payload requests include loose GETs, full pack GETs and member range GETs. These are payload counts, excluding metadata requests. Image request counts are inferred from the selected single-GET or 8 MiB range configuration and are recorded separately as `expectedPayloadGETCount` in JSON/CSV. Full precision, ranges, counts and additional boot/build stages are in `results.json` and `phases.csv`.", "",
              "| Fixture | MiB | Arm | Fetch + stored verification | Decoded verification | Guest send | Image transfer + restore | Locator | Payload requests |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for group in data["aggregates"]:
        if group["phase"] != "combined":
            continue
        m = group["metrics"]
        values = [m.get(k) for k in ("downloadVerifyMs", "decodeVerifyMs", "guestSendMs", "transferRestoreMs", "locatorMs", "payloadGETCount")]
        lines.append(f'| {group["fixture"]} | {group["sizeMiB"]} | {group["arm"]} | ' + " | ".join(cell(v) for v in values) + " |")
    lines += ["", "## Warm Git service", "", "This separate experiment used a server and client on two Sprites over HTTPS. It measured API file reads and complete snapshot transfer with client verification. Its timings exclude Firecracker boot, guest apply and ext4 writes. Fill used local canonical fixture storage. The current API already caches small blob bytes in SQLite, and this service has no paired current-API control.", "",
              "| MiB | First 4 KiB read ms | 32-read API p50 / p95 ms | Full snapshot ms, median [min, max] | Local fill seconds |", "| --- | --- | --- | --- | --- |"]
    for row in data["warmService"]:
        lines.append(f'| {row["sizeMiB"]} | {row["firstReadMs"]:.3f} | {row["apiP50Ms"]:.3f} / {row["apiP95Ms"]:.3f} | {cell(row["fullSnapshotMs"])} | {row["localFillMs"]/1000:.3f} |')
    lines += ["", "Snapshot first-entry timing refers to `assets/a0000.bin`. The separately measured 4 KiB API read used `src/d000/f00000.ts`. A later fill-only compression experiment reduced the 499 MiB Git fill from 38.790 to 24.491 seconds with `core.compression=0`. Default compression ran first, so source cache warming can affect that comparison. Original transfer trials used default compression.", "",
              "[Warm service evidence and limitations](warm-repo-service/results.md) · [Warm client raw trials](warm-repo-service/raw/shard-2/client-50.jsonl) · [Warm cleanup receipt](warm-repo-service/raw/cleanup.json) · [Git compression follow-up](warm-repo-service/raw/compression/summary.json)", "", "## Provenance and completion", ""]
    for status in data["series"]:
        run = status["run"]
        if not status.get("complete"):
            lines.append(f'- `{run}` is pending ' + ", ".join(status["missing"]) + ".")
            continue
        lines.append(f'- `{run}` — [summary](raw/{run}/summary.json), [archived trial logs](raw/{run}/host-logs.tar.gz), [restored host](raw/{run}/restored.json), [locator cleanup](raw/{run}/ddb-cleanup.log), [S3 cleanup](raw/{run}/s3-cleanup.log), [console](raw/{run}/console.log).')
    lines += ["", "The first series completed all 12 trial tests and 36 phase checks before the outer maintenance wrapper hit a shell parser error. Host restoration and scoped cleanup completed, and the archived logs and all first-read measurements were independently reviewed. The aggregation rechecks terminal PASS markers, phase counts, reported measurements, binary revisions and restoration/cleanup receipts. The wrapper error remains recorded in its console log.", "",
              "Prepared manifests were supplied by the trusted fixture. Production publication, retry, retention and deletion integration would require additional implementation.", "",
              "The final pilot check records the original service active, its binary checksum correct, both slots free, no allocated VMs, and no benchmark VM scopes, taps or mounts. All four owned remote qualification folders were removed after their evidence and cleanup receipts were captured.", "",
              "[Final host state](final-host.json) · [Final service and cleanup check](final-pilot-check.log) · [Independent data review](independent-review.json)", "",
              "[Machine-readable results](results.json) · [Per-phase CSV](phases.csv) · [Input checksums](raw-manifest.json) · [Aggregation script](aggregate.py)", ""]
    text = "\n".join(lines).replace("Fill used local canonical fixture storage.",
                                    "Fill used local canonical fixture storage and warmed server Git files and memory before reads.")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report completion without writing results")
    args = parser.parse_args()
    statuses, phases, revisions = [], [], {}
    for spec in SERIES:
        status, records, versions = read_series(spec)
        statuses.append(status)
        phases.extend(records)
        if versions is not None:
            revisions[status["run"]] = versions
    complete = all(status.get("complete") for status in statuses)
    print(json.dumps(dict(complete=complete, series=statuses), indent=2))
    require(complete, "planned series are incomplete")
    output = ROOT
    evidence = sorted((output / "raw").rglob("*"))
    evidence += sorted((output / "warm-repo-service/raw").rglob("*"))
    evidence += [output / name for name in ("final-host.json", "final-pilot-check.log", "independent-review.json")]
    manifest = [dict(path=str(path.relative_to(output)), bytes=path.stat().st_size,
                     sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                for path in evidence if path.is_file()]
    previous = json.loads((output / "results.json").read_text()) if (output / "results.json").exists() else {}
    groups = aggregate(phases)
    data = dict(complete=complete, generatedAt=previous.get("generatedAt", datetime.now(timezone.utc).isoformat()), series=statuses,
                trialCount=sum(status.get("actualTrials", 0) for status in statuses), phaseCount=len(phases),
                revisions=revisions, phases=phases, aggregates=groups, amortization=amortization(groups),
                warmService=warm_service())
    if args.check:
        require(previous == data, "results.json differs from archived evidence; regenerate it")
        require(json.loads((output / "raw-manifest.json").read_text()) == manifest, "input checksum manifest differs")
        require((output / "results.md").read_text() == render(data), "results.md differs from computed results")
        print(f"Verified {len(phases)} phases and {len(manifest)} evidence checksums")
        return 0
    (output / "results.json").write_text(json.dumps(data, indent=2) + "\n")
    (output / "raw-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "results.md").write_text(render(data))
    fields = ["series", "fixture", "run", "sizeMiB", "round", "arm", "phase"]
    fields += sorted({key for row in phases for key in row} - set(fields))
    with (output / "phases.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(phases)
    print(f"Wrote {len(phases)} measured phases to {output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
