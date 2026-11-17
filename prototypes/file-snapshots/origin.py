"""Loopback content origin. Each trial serves only chunks reachable from its pinned snapshot."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time


class ChunkOrigin(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store, files, delay):
        self.store = store
        self.allowed = {key for info in files.values() if info[0] != "link" for key in info[2]}
        self.delay = delay
        super().__init__(("127.0.0.1",0), ReadChunk)


class ReadChunk(BaseHTTPRequestHandler):
    disable_nagle_algorithm = True
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        key = self.path[1:]
        if key not in self.server.allowed:
            self.send_error(404)
            return
        data = self.server.store.db.execute("SELECT data FROM objects WHERE id=?",(key,)).fetchone()
        if data is None:
            self.send_error(500)
            return
        if self.server.delay:
            time.sleep(self.server.delay)
        self.send_response(200)
        self.send_header("Content-Length",str(len(data[0])))
        self.end_headers()
        self.wfile.write(data[0])

    def log_message(self,*args):
        pass
