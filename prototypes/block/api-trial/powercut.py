"""Measure an acknowledged write inside a disposable owner host, then cut its power from outside."""

import argparse
import json
import os
import signal
import subprocess as sp
import sys
import time
import uuid
from pathlib import Path

from run import HERE, receive, seed
from volume import Volume


def inside(folder):
    folder = folder.resolve()
    folder.mkdir()
    v = Volume()
    root = seed(folder, v)
    ref = "power-loss"
    first = v.publish(ref, root, 0, None, "seed")
    session = folder / "session"
    session.mkdir()
    with sp.Popen(
        [sys.executable, HERE / "writer.py", session, folder / "cache", ref],
        stdin=sp.PIPE,
        stdout=sp.PIPE,
        text=True,
    ) as writer:
        assert receive(writer)["ready"]
        row = {"ref": ref, "edits": [], "first_etag": first}
        for _ in range(2):
            value = uuid.uuid4().hex
            t = time.perf_counter()
            writer.stdin.write(json.dumps({"value": value}) + "\n")
            writer.stdin.flush()
            reply = receive(writer)
            assert reply["ack"] and reply["value"] == value
            row["edits"].append(
                dict(reply, elapsed_ms=(time.perf_counter() - t) * 1000)
            )
        print(
            json.dumps({"prefix": os.environ["TRIAL_PREFIX"], "cases": [row]}),
            flush=True,
        )
        time.sleep(60)
        raise RuntimeError("waiting guest survived power-cut deadline")


def outside(pidfile, image, output, command):
    # Keep a handle to this VMM and check its identity before executing the test.
    pid = int(pidfile.read_text())
    fd = os.pidfd_open(pid)
    try:
        process = Path("/proc") / str(pid)
        if (process / "exe").resolve().name != "qemu-system-x86_64":
            raise RuntimeError("pidfile does not identify QEMU")
        image_path = Path(image).resolve(strict=True)
        if not any(file.resolve() == image_path for file in (process / "fd").iterdir()):
            raise RuntimeError("VMM does not hold the specified private disk")
        with sp.Popen(command, stdout=sp.PIPE, text=True) as remote:
            report = receive(remote)
            if (
                report["cases"][0]["ref"] != "power-loss"
                or len(report["cases"][0]["edits"]) != 2
            ):
                raise RuntimeError("missing final acknowledgement")
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            status = remote.wait(timeout=15)
            if status == 0:
                raise RuntimeError("SSH exited normally during power cut")
        report["outer_vmm_signal"] = "SIGKILL"
        report["owner_ssh_exit"] = status
        output.write_text(json.dumps(report, indent=2) + "\n")
    finally:
        os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("inside").add_argument("folder", type=Path)
    external = modes.add_parser("outside")
    external.add_argument("pidfile", type=Path)
    external.add_argument("image")
    external.add_argument("output", type=Path)
    external.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.mode == "inside":
        inside(args.folder)
    else:
        outside(args.pidfile, args.image, args.output, args.command)
