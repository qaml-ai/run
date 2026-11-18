"""Seed, drive and forcibly kill private writer process groups on the Firecracker host."""

import argparse
import fcntl
import json
import os
import selectors
import signal
import subprocess as sp
import sys
import time
import uuid
from pathlib import Path

from volume import CHUNK, Volume, digest

HERE = Path(__file__).resolve().parent


def seed(folder, volume):
    fixture = folder / "tree"
    fixture.mkdir()
    src = fixture / "src"
    src.mkdir()
    (src / "main.py").write_text("seed\n")
    for i in range(2000):
        (src / f"f{i}.txt").write_text(f"import module_{i}\n")
    with (fixture / "payload").open("wb") as f:
        f.write(os.urandom(8 * 1024**2))
    image = folder / "seed.img"
    with image.open("wb") as f:
        f.truncate(128 * 1024**2)
    sp.run(
        [
            "mkfs.ext4",
            "-q",
            "-F",
            "-E",
            "lazy_itable_init=0,lazy_journal_init=0",
            "-d",
            fixture,
            image,
        ],
        check=True,
    )
    blocks = []
    unique = {}
    with image.open("rb") as f:
        while data := f.read(CHUNK):
            key = digest(data) if any(data) else None
            blocks.append(key)
            if key:
                unique[key] = data
    volume.save_blocks(unique)
    return volume.save_map(blocks)


def receive(process):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(60):
            raise TimeoutError("owner timed out")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("owner exited early")
    return json.loads(line)


def lifecycle(folder, cache, ref, count, crash, report):
    folder.mkdir()
    report["cache_blocks_at_start"] = (
        sum(1 for _ in cache.iterdir()) if cache.exists() else 0
    )
    process = sp.Popen(
        [sys.executable, HERE / "writer.py", folder, cache, ref],
        start_new_session=True,
        stdin=sp.PIPE,
        stdout=sp.PIPE,
        text=True,
    )
    try:
        assert receive(process)["ready"]
        for i in range(count + int(crash)):
            value = uuid.uuid4().hex
            interrupt = i == count
            req = json.dumps({"value": value, "interrupt": interrupt})
            start = time.perf_counter()
            process.stdin.write(req + "\n")
            process.stdin.flush()
            reply = receive(process)
            elapsed = (time.perf_counter() - start) * 1000
            if interrupt:
                assert reply == {"staged": True}
                report["unacknowledged"] = value
            else:
                assert reply["ack"] and reply["value"] == value
                report["edits"].append(dict(reply, elapsed_ms=elapsed))
    finally:
        # No VM shutdown, filesystem unmount, checkpoint or final cache flush.
        os.killpg(process.pid, signal.SIGKILL)
        status = process.wait()
        report["owner_exit"] = status
        report["cache_blocks_at_end"] = sum(p.suffix != ".tmp" for p in cache.iterdir())
        if Path("/sys/class/block", Path(os.environ["TRIAL_NBD"]).name, "pid").exists():
            sp.run(
                ["nbd-client", "-d", os.environ["TRIAL_NBD"]],
                check=True,
                stdout=sp.DEVNULL,
            )
    assert status == -signal.SIGKILL


def main():
    p = argparse.ArgumentParser()
    p.add_argument("folder", type=Path)
    args = p.parse_args()
    folder = args.folder.resolve()
    folder.mkdir()
    report = {"prefix": os.environ["TRIAL_PREFIX"], "cases": []}
    with open(
        "/run/lock/unified-trial-" + Path(os.environ["TRIAL_NBD"]).name, "w"
    ) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        v = Volume()
        root = seed(folder, v)
        for i in range(3):
            cache = folder / f"cache{i}"
            for label, count, fault in [
                ("empty-cache", 1, False),
                ("populated-cache", 5, False),
            ]:
                ref = f"{label}-{i}"
                first = v.publish(ref, root, 0, None, "seed")
                row = {"ref": ref, "first_etag": first, "edits": []}
                lifecycle(folder / ref, cache, ref, count, fault, row)
                report["cases"].append(row)
                print(
                    f"{ref} ACK times ms",
                    [round(e["elapsed_ms"]) for e in row["edits"]],
                    flush=True,
                )
        ref = "before-publish"
        first = v.publish(ref, root, 0, None, "seed")
        row = {"ref": ref, "first_etag": first, "edits": []}
        lifecycle(folder / ref, folder / "fault-cache", ref, 1, True, row)
        report["cases"].append(row)
        (folder / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
