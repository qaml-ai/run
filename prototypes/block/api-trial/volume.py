import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config

CHUNK = 256 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()


class Volume:
    def __init__(self):
        self.bucket = os.environ["TRIAL_BUCKET"]
        self.prefix = os.environ["TRIAL_PREFIX"].strip("/") + "/"
        if not self.prefix.startswith("unified-volume-trials/"):
            raise ValueError("expected private experiment prefix")
        self.s3 = boto3.client(
            "s3",
            region_name="us-west-2",
            config=Config(retries={"total_max_attempts": 1}),
        )

    def get(self, key):
        reply = self.s3.get_object(Bucket=self.bucket, Key=self.prefix + key)
        with reply["Body"] as body:
            return body.read(), reply["ETag"]

    def put(self, key, data, condition=None):
        # Sign the conditional header on Ubuntu botocore versions predating modeled IfMatch.
        def header(request, **kwargs):
            request.headers[condition[0]] = condition[1]

        if condition:
            self.s3.meta.events.register("before-sign.s3.PutObject", header)
        try:
            reply = self.s3.put_object(
                Bucket=self.bucket, Key=self.prefix + key, Body=data
            )
        finally:
            if condition:
                self.s3.meta.events.unregister("before-sign.s3.PutObject", header)
        return reply["ETag"]

    def read_object(self, kind, key):
        data, _ = self.get(kind + "/" + key)
        if digest(data) != key:
            raise OSError("corrupt " + kind)
        return data

    def save_blocks(self, unique):
        def upload(item):
            key, data = item
            self.put("blocks/" + key, data)

        with ThreadPoolExecutor(max_workers=8) as workers:
            list(workers.map(upload, unique.items()))

    def save_map(self, blocks):
        data = encode(blocks)
        key = digest(data)
        self.put("maps/" + key, data)
        return key

    def head(self, ref):
        raw, etag = self.get("refs/" + ref)
        return json.loads(raw), etag

    def publish(self, ref, root, revision, etag, epoch):
        state = encode({"map": root, "revision": revision, "epoch": epoch})
        condition = ("If-Match", etag) if etag else ("If-None-Match", "*")
        return self.put("refs/" + ref, state, condition)


def snapshot(volume, base, dirty_dir):
    blocks = base.copy()
    new = {}
    known = set(base)
    uploaded = 0
    for path in dirty_dir.iterdir():
        i = int(path.name)
        data = path.read_bytes()
        if len(data) != CHUNK:
            raise OSError("incomplete dirty block")
        key = digest(data) if any(data) else None
        blocks[i] = key
        if key and key not in known:
            known.add(key)
            new[key] = data
            uploaded += CHUNK
            if len(new) == 8:
                volume.save_blocks(new)
                new.clear()
    if new:
        volume.save_blocks(new)
    return blocks, uploaded
