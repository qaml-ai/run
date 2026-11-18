"""One serial NBD connection owns the writable disk. Checkpoints inspect it only while frozen."""

import json
import os
import shutil
import tempfile
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from volume import CHUNK, Volume, digest

API_VERSION = 2


def open(readonly):
    handle = (
        json.loads(Path(os.environ["TRIAL_MAP"]).read_bytes()),
        Path(os.environ["TRIAL_CACHE"]),
        Path(os.environ["TRIAL_DIRTY"]),
        Volume(),
    )
    if pending := os.environ.get("TRIAL_PENDING"):
        return (*handle, Path(pending))
    return handle


def get_size(h):
    return len(h[0]) * CHUNK


def block(h, index):
    blocks, cache, dirty, volume = h[:4]
    path = dirty / str(index)
    if path.exists():
        data = path.read_bytes()
        if len(data) != CHUNK:
            raise OSError("incomplete dirty block")
        return data
    key = blocks[index]
    if key is None:
        return bytes(CHUNK)
    path = cache / key
    if path.exists():
        data = path.read_bytes()
        if digest(data) != key:
            raise OSError("NVMe cache integrity error")
    else:
        data = volume.read_object("blocks", key)
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
            name = Path(tmp.name)
            try:
                tmp.write(data)
                tmp.flush()
                name.replace(path)
            finally:
                name.unlink(missing_ok=True)
    if len(data) != CHUNK:
        raise OSError("bad chunk size")
    return data


def pread(h, buf, offset, flags):
    done = 0
    while done < len(buf):
        index, start = divmod(offset + done, CHUNK)
        n = min(CHUNK - start, len(buf) - done)
        buf[done : done + n] = block(h, index)[start : start + n]
        done += n


def pwrite(h, buf, offset, flags):
    done = 0
    while done < len(buf):
        index, start = divmod(offset + done, CHUNK)
        n = min(CHUNK - start, len(buf) - done)
        path = h[2] / str(index)
        if not path.exists():
            path.write_bytes(block(h, index))
        if len(h) == 5:
            mark = h[4] / path.name
            if not mark.exists():
                # A checkpoint may still be uploading the old inode. Its hard
                # link stays immutable while this writer starts the next version.
                if path.stat().st_nlink > 1:
                    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as new:
                        tmp = Path(new.name)
                    try:
                        shutil.copyfile(path, tmp)
                        tmp.replace(path)
                    finally:
                        tmp.unlink(missing_ok=True)
                os.link(path, mark)
        with path.open("r+b") as f:
            f.seek(start)
            f.write(buf[done : done + n])
        done += n


def flush(h, flags):
    for path in h[2].iterdir():
        with path.open("rb") as f:
            os.fsync(f.fileno())
    fd = os.open(h[2], os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
