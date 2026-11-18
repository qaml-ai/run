"""Persistent ext4 workspace operations. A ref is the sole commit/ownership point."""
import errno
import json
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

from botocore.exceptions import ClientError

from volume import CHUNK, digest, snapshot

NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*")
TEMPLATE = "empty-ext4-v1"


class OwnershipError(Exception):
    pass


def workspace_ref(name):
    if not NAME.fullmatch(name):
        raise ValueError("invalid workspace name")
    return "workspaces/" + name


def mapping(volume, head):
    data = json.loads(volume.read_object("maps", head["map"]))
    if not isinstance(data, list) or not data or any(
        key is not None and (not isinstance(key, str) or not re.fullmatch("[a-f0-9]{64}", key))
        for key in data
    ):
        raise ValueError("invalid block map")
    return data


def format_template(volume, size):
    if size <= 0 or size % CHUNK:
        raise ValueError("size must be a positive multiple of the block size")
    try:
        head, _ = volume.head(TEMPLATE)
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("NoSuchKey", "404"):
            raise
    else:
        if len(mapping(volume, head)) * CHUNK != size:
            raise ValueError("existing template has another size")
        return head["map"]
    with tempfile.TemporaryDirectory() as tmp:
        image = Path(tmp) / "empty.ext4"
        blocks = [None] * (size // CHUNK)
        with image.open("w+b", buffering=0) as f:
            f.truncate(size)
            subprocess.run(["mkfs.ext4", "-q", "-F", str(image)], check=True)
            # Enumerate only allocated extents, even for large sparse templates.
            offset = 0
            while offset < size:
                try:
                    first = os.lseek(f.fileno(), offset, os.SEEK_DATA)
                except OSError as err:
                    if err.errno == errno.ENXIO:
                        break
                    raise
                end = os.lseek(f.fileno(), first, os.SEEK_HOLE)
                for index in range(first // CHUNK, (end + CHUNK - 1) // CHUNK):
                    data = os.pread(f.fileno(), CHUNK, index * CHUNK)
                    if len(data) != CHUNK:
                        raise IOError("short template read")
                    if any(data):
                        key = digest(data)
                        volume.save_blocks({key: data})
                        blocks[index] = key
                offset = end
    root = volume.save_map(blocks)
    try:
        volume.publish(TEMPLATE, root, 0, None, "asleep")
    except ClientError as exc:
        if exc.response["ResponseMetadata"]["HTTPStatusCode"] != 412:
            raise
        # A concurrent formatter won. A different disk size is a conflict.
        winner, _ = volume.head(TEMPLATE)
        if len(mapping(volume, winner)) * CHUNK != size:
            raise ValueError("existing template has another size") from exc
        return winner["map"]
    return root


class Workspace:
    def __init__(self, volume, name, cache):
        self.volume = volume
        self.ref = workspace_ref(name)
        self.cache = Path(cache)
        self.cache.mkdir(mode=0o700, parents=True, exist_ok=True)

    def create(self):
        head, _ = self.volume.head(TEMPLATE)
        mapping(self.volume, head)
        self.volume.publish(self.ref, head["map"], 0, None, "asleep")
        return head["map"]

    def edit(self, state, operation, write):
        head, etag = state
        if head["epoch"] != "asleep":
            raise OwnershipError("workspace has a VM owner: " + head["epoch"])
        base = mapping(self.volume, head)
        with tempfile.TemporaryDirectory() as temp:
            dirty = Path(temp)
            handle = (base, self.cache, dirty, self.volume)
            result = operation(handle)
            if write:
                blocks, uploaded = snapshot(self.volume, base, dirty)
                root = self.volume.save_map(blocks)
                revision = head["revision"] + 1
                self.volume.publish(self.ref, root, revision, etag, "asleep")
                return {"map": root, "revision": revision, "uploaded_bytes": uploaded}
        return result

    def claim(self, host, previous_owner=None):
        head, etag = self.volume.head(self.ref)
        expected = "asleep" if previous_owner is None else previous_owner
        if not expected or previous_owner == "asleep" or head["epoch"] != expected:
            raise OwnershipError("workspace ownership changed: " + head["epoch"])
        epoch = host + ":" + uuid.uuid4().hex
        tag = self.volume.publish(self.ref, head["map"], head["revision"], etag, epoch)
        return head, tag, epoch
