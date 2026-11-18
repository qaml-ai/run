import hashlib
import json
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

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
        self.upload_blocks(unique.items())

    def upload_blocks(self, items):
        concurrency = 8
        with ThreadPoolExecutor(max_workers=concurrency) as workers:
            pending = set()
            for key, data in items:
                pending.add(workers.submit(self.put, "blocks/" + key, data))
                if len(pending) >= 2 * concurrency:
                    completed, pending = wait(pending, return_when=FIRST_COMPLETED)
                    for task in completed:
                        task.result()
            for task in pending:
                task.result()

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
    known = set(base)
    uploaded = 0

    def changed_blocks():
        nonlocal uploaded
        for path in dirty_dir.iterdir():
            i = int(path.name)
            if i < 0 or i >= len(blocks):
                raise OSError("dirty block outside volume")
            data = path.read_bytes()
            if len(data) != CHUNK:
                raise OSError("incomplete dirty block")
            key = digest(data) if any(data) else None
            blocks[i] = key
            if key and key not in known:
                known.add(key)
                uploaded += CHUNK
                yield key, data

    volume.upload_blocks(changed_blocks())
    return blocks, uploaded
