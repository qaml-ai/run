"""Exercise the userspace ext4 editor on real local images, including allocation and refusal."""

import json
import os
import subprocess as sp
import tempfile
from pathlib import Path

from trial import CHUNK, library_edit
from volume import digest


class Objects(dict):
    def read_object(self, kind, key):
        assert kind == "blocks"
        data = self[key]
        if digest(data) != key:
            raise OSError("corrupt block")
        return data


def view(image, folder):
    store = Objects()
    blocks = []
    with image.open("rb") as src:
        while data := src.read(CHUNK):
            key = digest(data) if any(data) else None
            if key:
                store[key] = data
            blocks.append(key)
    cache, dirty = folder / "cache", folder / "dirty"
    for p in (cache, dirty):
        p.mkdir(parents=True)
    return blocks, cache, dirty, store


def run(folder):
    image = folder / "test.ext4"
    tree = folder / "fixture"
    (tree / "src").mkdir(parents=True)
    (tree / "src/main.py").write_text("original")
    (tree / "other").write_text("intact")
    with image.open("wb") as f:
        f.truncate(32 * 1024**2)
    sp.run(["mkfs.ext4", "-q", "-F", "-d", tree, image], check=True)
    for i, data in enumerate([os.urandom(CHUNK + 4103), b"a" * 73, b"", b"restored"]):
        h = view(image, folder / str(i))
        library_edit(h, data)
        with image.open("r+b") as f:
            for path in h[2].iterdir():
                f.seek(int(path.name) * CHUNK)
                f.write(path.read_bytes())
        sp.run(["e2fsck", "-fn", image], check=True, capture_output=True)
        dst = folder / f"out{i}"
        sp.run(
            ["debugfs", "-R", f"dump /src/main.py {dst}", image],
            check=True,
            capture_output=True,
        )
        assert dst.read_bytes() == data
        assert (
            sp.check_output(["debugfs", "-R", "cat /other", image], stderr=sp.DEVNULL)
            == b"intact"
        )
    h = view(image, folder / "bad")
    h[3][h[0][0]] = bytes(CHUNK)
    try:
        library_edit(h, b"bad")
    except OSError as e:
        assert "corrupt block" in str(e)
    else:
        raise AssertionError("corrupt block accepted")
    sp.run(
        ["debugfs", "-w", "-R", "feature needs_recovery", image],
        check=True,
        capture_output=True,
    )
    features = sp.check_output(["dumpe2fs", "-h", image], stderr=sp.DEVNULL)
    assert b"needs_recovery" in features
    try:
        library_edit(view(image, folder / "unclean"), b"bad")
    except OSError as e:
        assert "(117)" in str(e)
    else:
        raise AssertionError("unclean image accepted")
    print(
        json.dumps(
            {
                "growth": True,
                "shrink": True,
                "empty": True,
                "regrowth": True,
                "corruption_refused": True,
                "journal_replay_required_refused": True,
            }
        )
    )


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as work:
        run(Path(work))
