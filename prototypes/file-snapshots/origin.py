"""Loopback origin for content reachable from a single pinned snapshot."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import time

MAX_BATCH = 16

class ChunkOrigin(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store, files, delay):
        self.store = store
        self.allowed = {key for info in files.values() if info[0] != "link" for key in info[2]}
        self.delay = delay
        self.requests = 0
        super().__init__(("127.0.0.1",0), ReadChunk)


class ReadChunk(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    def do_POST(self):
        size = int(self.headers.get("Content-Length",0))
        if self.path != "/chunks" or not 0 < size <= MAX_BATCH*70:
            self.send_error(400)
            return
        keys = json.loads(self.rfile.read(size))
        if not isinstance(keys,list) or not 1 <= len(keys) <= MAX_BATCH or any(k not in self.server.allowed for k in keys):
            self.send_error(404)
            return
        self.server.requests += 1
        marks = ",".join("?" for _ in keys)
        found = dict(self.server.store.db.execute(f"SELECT id,data FROM objects WHERE id IN ({marks})", keys))
        if found.keys() != set(keys):
            self.send_error(500)
            return
        payload = b"".join(struct.pack(">I",len(found[k]))+found[k] for k in keys)
        if self.server.delay:
            time.sleep(self.server.delay)
        self.send_response(200)
        self.send_header("Content-Length",str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self,*args):
        pass
