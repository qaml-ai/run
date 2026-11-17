"""Private read-only nbdkit endpoint for one pinned file snapshot."""
import functools
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, os.environ["SNAP_MODULE"])
from store import Device, Store

API_VERSION = 2

def open(readonly):
    store = Store(os.environ["SNAP_DB"], readonly=True)
    stats = [0,0,0]
    @functools.lru_cache(maxsize=128)
    def fetch(key):
        data = store.get(key)
        stats[0] += len(data)
        return data
    device = Device(store.load(os.environ["SNAP_VERSION"]), fetch)
    return device,stats,store

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
    h[2].db.close()
