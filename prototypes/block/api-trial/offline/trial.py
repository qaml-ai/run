"""Compare two private offline ext4 editors against the same sleeping S3-backed volume."""

import ctypes as ct
import errno
import fcntl
import json
import os
import signal
import subprocess as sp
import sys
import time
import uuid
from pathlib import Path

from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import device
from run import receive, seed
from volume import CHUNK, Volume, snapshot
from writer import poll_until

clock = time.perf_counter
Transfer = ct.CFUNCTYPE(ct.c_int, ct.c_int, ct.c_ulonglong, ct.c_size_t, ct.c_void_p)


def library_edit(h, data):
    lib = ct.CDLL(str(HERE / "edit.so"))
    lib.replace_fixture.argtypes = [Transfer, ct.c_char_p, ct.c_uint]
    lib.replace_fixture.restype = ct.c_long
    errors = []

    @Transfer
    def transfer(write, offset, size, pointer):
        try:
            if offset + size > device.get_size(h):
                raise ValueError("invalid ext4 IO range")
            if write:
                device.pwrite(h, ct.string_at(pointer, size), offset, 0)
            else:
                buf = bytearray(size)
                device.pread(h, buf, offset, 0)
                ct.memmove(pointer, bytes(buf), size)
            return 0
        except Exception as error:  # noqa: BLE001 - exceptions cannot cross a ctypes callback.
            errors.append(error)
            return errno.EIO

    status = lib.replace_fixture(transfer, data, len(data))
    if errors:
        raise errors[0]
    if status:
        raise OSError(f"ext4 editor rejected image or operation ({status})")


def kernel_edit(h, data):
    blocks, cache, dirty, _ = h
    work = dirty.parent
    mapping, sock, mnt = work / "map.json", work / "nbd.sock", work / "mnt"
    mnt.mkdir()
    mapping.write_text(json.dumps(blocks))
    env = dict(
        os.environ,
        TRIAL_CACHE=str(cache),
        TRIAL_MAP=str(mapping),
        TRIAL_DIRTY=str(dirty),
    )
    nbd = os.environ["TRIAL_NBD"]
    sysdev = Path("/sys/class/block", Path(nbd).name)
    if (sysdev / "pid").exists():
        raise RuntimeError("test device busy")
    with (work / "device.log").open("wb") as log:
        backend = sp.Popen(
            [
                os.environ["NBDKIT"],
                "-f",
                "--threads",
                "1",
                "-U",
                sock,
                os.environ["NBDKIT_PYTHON"],
                HERE.parent / "device.py",
            ],
            env=env,
            stdout=log,
            stderr=log,
        )
        try:
            poll_until(sock.exists, [backend])
            client = sp.Popen(
                ["nbd-client", "-unix", sock, nbd, "-nofork", "-nonetlink"],
                stdout=log,
                stderr=log,
            )
            try:
                poll_until(
                    lambda: (
                        (sysdev / "pid").exists()
                        and int((sysdev / "size").read_text()) * 512
                        == len(blocks) * CHUNK
                    ),
                    [backend, client],
                )
                sp.run(
                    [
                        "mount",
                        "-t",
                        "ext4",
                        "-o",
                        "noatime,nodev,nosuid,noexec",
                        nbd,
                        mnt,
                    ],
                    check=True,
                )
                try:
                    (mnt / "src/main.py").write_bytes(data)
                finally:
                    sp.run(["umount", mnt], check=True)
            finally:
                if (sysdev / "pid").exists():
                    sp.run(
                        ["nbd-client", "-d", nbd], check=True, stdout=log, stderr=log
                    )
                client.wait(timeout=10)
        finally:
            backend.terminate()
            backend.wait(timeout=10)


def prepare(volume, ref, cache, work, value, editor):
    t = clock()
    head, etag = volume.head(ref)
    if head["epoch"] != "asleep":
        raise RuntimeError("workspace active")
    blocks = json.loads(volume.read_object("maps", head["map"]))
    loaded = clock()
    dirty = work / "dirty"
    dirty.mkdir(parents=True)
    editor((blocks, cache, dirty, volume), (value + "\n").encode())
    edited = clock()
    updated, uploaded = snapshot(volume, blocks, dirty)
    root = volume.save_map(updated)
    # Populate the verified, immutable cache for the next request on this host.
    for path in dirty.iterdir():
        key = updated[int(path.name)]
        if key and not (cache / key).exists():
            os.link(path, cache / key)
    staged = clock()
    return etag, {
        "value": value,
        "revision": head["revision"] + 1,
        "root": root,
        "uploaded_bytes": uploaded,
        "metadata_ms": 1000 * (loaded - t),
        "edit_ms": 1000 * (edited - loaded),
        "stage_ms": 1000 * (staged - edited),
    }


def publish(volume, ref, etag, record):
    t = clock()
    volume.publish(ref, record["root"], record["revision"], etag, "asleep")
    record["publish_ms"] = 1000 * (clock() - t)


def edit(volume, ref, cache, work, editor):
    t = clock()
    etag, row = prepare(volume, ref, cache, work, uuid.uuid4().hex, editor)
    publish(volume, ref, etag, row)
    row["elapsed_ms"] = 1000 * (clock() - t)
    return row


def wake(volume, ref, cache, work, previous, with_race):
    # Prepare a private competing edit before the VM claims the ref.
    if with_race:
        etag, loser = prepare(
            volume, ref, cache, work / "pending", uuid.uuid4().hex, library_edit
        )
    folder = work / "guest"
    folder.mkdir(parents=True)
    owner = sp.Popen(
        [sys.executable, HERE.parent / "writer.py", folder, work / "guest-cache", ref],
        stdin=sp.PIPE,
        stdout=sp.PIPE,
        text=True,
        start_new_session=True,
    )

    def request(expected, sleep):
        value = uuid.uuid4().hex
        owner.stdin.write(
            json.dumps(
                {"expected_before": expected, "value": value, "sleep_after": sleep}
            )
            + "\n"
        )
        owner.stdin.flush()
        row = receive(owner)
        assert row["ack"] and row["value"] == value
        return row

    try:
        assert receive(owner)["ready"]
        rows = [request(previous, not with_race)]
        if with_race:
            try:
                publish(volume, ref, etag, loser)
            except ClientError as failure:
                if failure.response["ResponseMetadata"]["HTTPStatusCode"] != 412:
                    raise
            else:
                raise AssertionError("stale API publish succeeded")
            try:
                edit(volume, ref, cache, work / "active", library_edit)
            except RuntimeError as failure:
                if str(failure) != "workspace active":
                    raise
            else:
                raise AssertionError("offline edit accepted during guest ownership")
            rows.append(request(rows[-1]["value"], True))
        owner.wait(timeout=5)
        assert owner.returncode == 0
        return rows
    finally:
        os.killpg(owner.pid, signal.SIGKILL)
        owner.wait()
        dev = os.environ["TRIAL_NBD"]
        if Path("/sys/class/block", Path(dev).name, "pid").exists():
            sp.run(["nbd-client", "-d", dev], check=True, stdout=sp.DEVNULL)


def main(folder):
    folder.mkdir()
    volume = Volume()
    root = seed(folder, volume)
    report = {"prefix": os.environ["TRIAL_PREFIX"], "cases": []}
    for repeat in range(3):
        for label, editor in [("kernel", kernel_edit), ("library", library_edit)]:
            ref = f"{label}-{repeat}"
            cache = folder / (ref + "-cache")
            cache.mkdir()
            volume.publish(ref, root, 0, None, "asleep")
            rows = [
                edit(volume, ref, cache, folder / ref / str(i), editor)
                for i in range(4)
            ]
            print(ref, [round(r["elapsed_ms"]) for r in rows], flush=True)
            # Boot from a cold cache, then release cleanly, edit again, and wake once more.
            rows.extend(
                wake(
                    volume,
                    ref,
                    cache,
                    folder / ref / "first-wake",
                    rows[-1]["value"],
                    True,
                )
            )
            rows.append(edit(volume, ref, cache, folder / ref / "after-guest", editor))
            rows.extend(
                wake(
                    volume,
                    ref,
                    cache,
                    folder / ref / "second-wake",
                    rows[-1]["value"],
                    False,
                )
            )
            assert len(rows) == 8 and [r["revision"] for r in rows] == list(range(1, 9))
            report["cases"].append(
                {
                    "ref": ref,
                    "edits": rows,
                    "stale_publish": 412,
                    "active_ref_rejected": True,
                }
            )
            (folder / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    with open(
        "/run/lock/unified-trial-" + Path(os.environ["TRIAL_NBD"]).name, "w"
    ) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main(Path(sys.argv[1]).resolve())
