"""Private read-only nbdkit endpoint for one pinned file snapshot."""
from collections import OrderedDict
import struct
import http.client
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, os.environ["SNAP_MODULE"])
from store import Device, hash_bytes

API_VERSION = 2

def open(readonly):
    raw = Path(os.environ["SNAP_MANIFEST"]).read_bytes()
    if hash_bytes(raw) != os.environ["SNAP_MANIFEST_HASH"]:
        raise IOError("mount metadata mismatch")
    connection = http.client.HTTPConnection("127.0.0.1",int(os.environ["SNAP_PORT"]),timeout=10)
    stats = [0,0,0]
    files = json.loads(raw)
    order = list(dict.fromkeys(key for _,info in sorted(files.items()) if info[0]!="link" for key in info[2]))
    positions = {key:i for i,key in enumerate(order)}
    cache = OrderedDict()
    last = None
    width = int(os.environ["SNAP_BATCH"])
    def fetch(key):
        nonlocal last
        pos = positions[key]
        contiguous = last is not None and last+1==pos
        last = pos
        if key not in cache:
            keys = [k for k in order[pos:pos+(width if contiguous else 1)] if k not in cache]
            connection.request("POST","/chunks",body=json.dumps(keys))
            response = connection.getresponse()
            data = response.read()
            if response.status != 200:
                raise IOError(f"chunk service returned {response.status}")
            offset = 0
            for k in keys:
                length, = struct.unpack_from(">I",data,offset)
                block = data[offset+4:offset+4+length]
                offset += 4+length
                if len(block)!=length or hash_bytes(block)!=k:
                    raise IOError("missing or corrupt chunk "+k)
                cache[k] = block
                stats[0] += length
            if offset != len(data):
                raise IOError("unexpected bytes after chunk batch")
            while len(cache)>128:
                cache.popitem(last=False)
        cache.move_to_end(key)
        return cache[key]
    device = Device(files,fetch)
    return device,stats,connection

def get_size(h):
    return h[0].size

def pread(h, buf, offset, flags):
    data = h[0].read(offset,len(buf))
    h[1][1] += len(buf)
    h[1][2] += 1
    buf[:] = data
    if not Path(os.environ["SNAP_FIRST"]).exists():
        Path(os.environ["SNAP_STATS"]).write_text(json.dumps(h[1]))

def close(h):
    Path(os.environ["SNAP_TOTAL"]).write_text(json.dumps(h[1]))
    h[2].close()
