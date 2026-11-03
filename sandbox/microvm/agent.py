"""The private MicroVM command endpoint. Authentication is enforced by AWS's proxy."""
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LIMIT = 65536
MAX_JOBS = 4096  # Never evict keys: an old retry must not execute twice.
JOBS = {}
LOCK = threading.Lock()


class Job:
    def __init__(self, command, seconds):
        self.command = command
        self.seconds = seconds
        self.done = threading.Event()
        self.result = None

    def run(self):
        buffers = [bytearray(), bytearray()]
        truncated = [False, False]

        def drain(stream, index):
            while True:
                chunk = stream.read(8192)
                if not chunk:
                    break
                left = LIMIT - len(buffers[index])
                buffers[index].extend(chunk[:left])
                truncated[index] |= len(chunk) > left
            stream.close()

        try:
            process = subprocess.Popen(["bash", "-lc", self.command], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, start_new_session=True, cwd=os.path.expanduser("~"))
            readers = [threading.Thread(target=drain, args=(stream, i), daemon=True)
                       for i, stream in enumerate([process.stdout, process.stderr])]
            for reader in readers:
                reader.start()
            try:
                code = process.wait(timeout=self.seconds)
            except subprocess.TimeoutExpired:
                code = 124
            finally:
                # Include background descendants even after the foreground shell exits.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            for reader in readers:
                reader.join()
            self.result = {"stdout": buffers[0].decode("utf-8", "replace"),
                           "stderr": buffers[1].decode("utf-8", "replace"),
                           "exitCode": code, "truncated": any(truncated)}
        except Exception:
            self.result = {"stdout": "", "stderr": "Command could not start", "exitCode": 127, "truncated": False}
        finally:
            self.done.set()


def start_job(key, command, seconds):
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key):
        raise ValueError("Invalid requestKey")
    if not isinstance(command, str) or not command or len(command) > 32000:
        raise ValueError("Invalid command")
    if type(seconds) is not int or not 1 <= seconds <= 1800:
        raise ValueError("Invalid timeoutSeconds")
    with LOCK:
        if key in JOBS:
            job = JOBS[key]
            if job.command != command or job.seconds != seconds:
                raise ValueError("Retried job changed")
            return job
        if len(JOBS) >= MAX_JOBS:
            raise OverflowError("Session job limit reached")
        if sum(not job.done.is_set() for job in JOBS.values()) >= 4:
            raise OverflowError("Too many active commands")
        job = JOBS[key] = Job(command, seconds)
        threading.Thread(target=job.run, daemon=True).start()
        return job


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # Commands and proxy headers must never reach logs.

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Job remains available after a client disconnects.

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= 200000:
                self.close_connection = True
                return self.send(413, {"error": "Request too large"})
            data = self.rfile.read(length)
            if self.path in {"/aws/lambda-microvms/runtime/v1/" + hook
                             for hook in ["run", "resume", "suspend", "terminate"]}:
                return self.send(200, {"ok": True})
            if self.path != "/exec":
                return self.send(404, {"error": "Unknown route"})
            request = json.loads(data)
            job = start_job(request.get("requestKey"), request.get("command"), request.get("timeoutSeconds", 600))
            return self.send(200 if job.done.is_set() else 202, job.result or {"running": True})
        except (ValueError, TypeError, AttributeError):
            self.send(400, {"error": "Invalid or conflicting job"})
        except OverflowError:
            self.send(429, {"error": "Session job limit reached"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self.send(200, {"ok": True})
        if not parsed.path.startswith("/exec/"):
            return self.send(404, {"error": "Unknown route"})
        with LOCK:
            job = JOBS.get(urllib.parse.unquote(parsed.path[6:]))
        if not job:
            return self.send(404, {"error": "Unknown job"})
        try:
            wait = min(25, max(0, float(urllib.parse.parse_qs(parsed.query).get("wait", ["0"])[0])))
        except ValueError:
            return self.send(400, {"error": "Invalid wait"})
        job.done.wait(wait)
        self.send(200 if job.done.is_set() else 202, job.result or {"running": True})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
