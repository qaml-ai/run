"""Run on an independent host with S3 access and e2fsprogs. No writer cache is used."""

import argparse
import json
import os
import subprocess as sp
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from botocore.exceptions import ClientError
from volume import CHUNK, Volume
from writer import poll_until


def read_file(image, path):
    result = sp.run(
        ["debugfs", "-R", "cat " + path, image],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def lazy_read(blocks, work):
    nbd = os.environ["TRIAL_NBD"]
    sysdev = Path("/sys/class/block", Path(nbd).name)
    if (sysdev / "pid").exists():
        raise RuntimeError("recovery NBD device busy")
    sock = work / "s"
    mapping = work / "map"
    mapping.write_text(json.dumps(blocks))
    cache, dirty, mount = (work / k for k in ("cache", "dirty", "mnt"))
    for path in (cache, dirty, mount):
        path.mkdir()
    env = dict(
        os.environ,
        TRIAL_MAP=str(mapping),
        TRIAL_CACHE=str(cache),
        TRIAL_DIRTY=str(dirty),
    )
    client = os.environ["NBD_CLIENT"]
    with sp.Popen(
        [
            os.environ["NBDKIT"],
            "-f",
            "-r",
            "--threads",
            "1",
            "-U",
            sock,
            os.environ["NBDKIT_PYTHON"],
            Path(__file__).with_name("device.py"),
        ],
        env=env,
    ) as backend:
        try:
            poll_until(sock.exists, [backend])
            attach = sp.Popen(
                [
                    "sudo",
                    "-n",
                    client,
                    "-unix",
                    sock,
                    nbd,
                    "-readonly",
                    "-nofork",
                    "-nonetlink",
                ],
                stdout=sp.DEVNULL,
            )
            try:
                poll_until(
                    lambda: (
                        (sysdev / "pid").exists()
                        and int((sysdev / "size").read_text()) * 512
                        == len(blocks) * CHUNK
                    ),
                    [backend, attach],
                )
                value = sp.check_output(
                    [
                        "sudo",
                        "-n",
                        "unshare",
                        "--mount",
                        "--propagation",
                        "private",
                        "bash",
                        "-euc",
                        """mount -o ro,noload,nosuid,nodev,noexec "$1" "$2"; trap 'umount "$2"' EXIT; cat "$2/src/main.py" """,
                        "read-restored",
                        nbd,
                        mount,
                    ],
                    text=True,
                ).strip()
            finally:
                if (sysdev / "pid").exists():
                    sp.run(
                        ["sudo", "-n", client, "-d", nbd], check=True, stdout=sp.DEVNULL
                    )
                attach.wait(timeout=10)
        finally:
            backend.terminate()
    return value, len(list(cache.iterdir()))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("writer_report", type=Path)
    p.add_argument("result", type=Path)
    args = p.parse_args()
    report = json.loads(args.writer_report.read_text())
    assert report["prefix"] == os.environ["TRIAL_PREFIX"]
    v = Volume()
    verified = []
    for case in report["cases"]:
        head, etag = v.head(case["ref"])
        last = case["edits"][-1]
        assert head["map"] == last["root"] and head["revision"] == len(case["edits"])
        new_epoch = uuid.uuid4().hex
        new_etag = v.publish(
            case["ref"], head["map"], head["revision"], etag, new_epoch
        )
        try:
            v.publish(
                case["ref"], head["map"], head["revision"] + 1, etag, head["epoch"]
            )
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] != 412:
                raise
        else:
            raise AssertionError("stale writer published")
        assert v.head(case["ref"]) == (dict(head, epoch=new_epoch), new_etag)
        blocks = json.loads(v.read_object("maps", head["map"]))
        with tempfile.TemporaryDirectory() as work:
            image = Path(work) / "restored.ext4"
            with image.open("wb") as f:
                f.truncate(len(blocks) * CHUNK)
                keys = {key for key in blocks if key}
                with ThreadPoolExecutor(max_workers=8) as workers:
                    verified_blocks = dict(
                        zip(
                            keys,
                            workers.map(lambda k: v.read_object("blocks", k), keys),
                        )
                    )
                for i, key in enumerate(blocks):
                    if key:
                        data = verified_blocks[key]
                        assert len(data) == CHUNK
                        f.seek(i * CHUNK)
                        f.write(data)
            sp.run(["e2fsck", "-fn", image], check=True, capture_output=True)
            value, fetched = lazy_read(blocks, Path(work))
            assert value == last["value"] and value != case.get("unacknowledged")
            assert read_file(image, "/src/f1999.txt") == "import module_1999"
        verified.append(
            {
                "ref": case["ref"],
                "revision": head["revision"],
                "value": value,
                "blocks_fetched_for_lazy_mount_and_read": fetched,
                "clean_ext4": True,
                "stale_publish_http": 412,
            }
        )
        print("recovered", case["ref"], "revision", head["revision"], flush=True)
    args.result.write_text(json.dumps(verified, indent=2) + "\n")


if __name__ == "__main__":
    main()
