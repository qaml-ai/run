"""Reconstruct each published revision on another host and check ext4 and the edited file."""

import json
import os
import subprocess as sp
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from volume import CHUNK, Volume


def check(report):
    volume = Volume()
    assert report["prefix"] == os.environ["TRIAL_PREFIX"]
    cache = {}
    verified = []
    for case in report["cases"]:
        head, _ = volume.head(case["ref"])
        assert head["map"] == case["edits"][-1]["root"] and head["epoch"] == "asleep"
        for row in case["edits"]:
            blocks = json.loads(volume.read_object("maps", row["root"]))
            missing = sorted({k for k in blocks if k} - cache.keys())
            with ThreadPoolExecutor(max_workers=8) as pool:
                cache.update(
                    zip(
                        missing,
                        pool.map(lambda k: volume.read_object("blocks", k), missing),
                        strict=True,
                    )
                )
            with tempfile.TemporaryDirectory() as stage:
                image = Path(stage) / "workspace.ext4"
                with image.open("wb") as dest:
                    dest.truncate(len(blocks) * CHUNK)
                    for i, k in enumerate(blocks):
                        if k:
                            dest.seek(i * CHUNK)
                            dest.write(cache[k])
                r = sp.run(
                    ["e2fsck", "-fn", image],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if r.returncode:
                    raise ValueError((case["ref"], row["revision"], r.stdout, r.stderr))
                for path, expected in [
                    ("/src/main.py", row["value"]),
                    ("/src/f1999.txt", "import module_1999"),
                ]:
                    found = sp.check_output(
                        ["debugfs", "-R", "cat " + path, image], stderr=sp.DEVNULL
                    )
                    assert found == (expected + "\n").encode()
            verified.append([case["ref"], row["revision"]])
    return {
        "verified_revisions": verified,
        "count": len(verified),
        "all_filesystems_clean": True,
    }


if __name__ == "__main__":
    result = check(json.loads(Path(sys.argv[1]).read_text()))
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
