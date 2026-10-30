"""One authenticated, disposable Docker computer behind an optional Cloudflare Tunnel."""
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import threading
import time
import uuid


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(16)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Session:
    def __init__(self, lifetime=900, image="python:3.11-bookworm"):
        self.id = "camelrun-computer-" + uuid.uuid4().hex
        self.deadline = time.monotonic() + lifetime
        self.claim = None
        self.lock = threading.Lock()
        self.results = {}
        self.closed = False
        # No host mounts, host network, Docker socket, privileged mode or host env.
        subprocess.run(["docker", "run", "--detach", "--name", self.id, "--label", "camelrun.computer=true",
                        "--cpus", "1", "--memory", "1g", "--pids-limit", "256", "--cap-drop", "ALL",
                        "--security-opt", "no-new-privileges", image, "sleep", str(lifetime)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)

    def close(self):
        with self.lock:
            if not self.closed:
                subprocess.run(["docker", "rm", "--force", self.id], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                self.closed = True

    def request(self, path, data):
        with self.lock:
            if self.closed or time.monotonic() >= self.deadline:
                raise TimeoutError("Computer session ended")
            claim = data.get("claim")
            if not isinstance(claim, str) or not 16 <= len(claim) <= 128:
                raise ValueError("Invalid claim")
            if path == "/claim":
                if self.claim not in (None, claim):
                    raise PermissionError("Computer already claimed")
                self.claim = claim
                return {"id": self.id, "capabilities": ["shell", "files"],
                        "seconds_remaining": int(self.deadline - time.monotonic())}
            if claim != self.claim:
                raise PermissionError("Invalid claim")
            if path == "/close":
                return {"closing": True}
            if path != "/exec":
                raise ValueError("Unknown operation")
            command, timeout, key = data.get("command"), data.get("timeout"), data.get("key")
            if not isinstance(command, str) or not 1 <= len(command) <= 32000:
                raise ValueError("Invalid command")
            if type(timeout) is not int or not 1 <= timeout <= 120:
                raise ValueError("Invalid timeout")
            if not isinstance(key, str) or not 16 <= len(key) <= 128:
                raise ValueError("Invalid request key")
            digest = hashlib.sha256(json.dumps([command, timeout]).encode()).hexdigest()
            if key in self.results:
                previous, result = self.results[key]
                if previous != digest:
                    raise ValueError("Retried command changed")
                return result
            if len(self.results) >= 1000:
                raise ValueError("Session command limit reached")
            self.results[key] = (digest, {"error": "Command outcome unknown; inspect before retrying"})
            timeout = max(1, min(timeout, int(self.deadline - time.monotonic())))
            # timeout runs INSIDE the container, so dropping an HTTP request cannot leave
            # its foreground command running forever. Detached jobs end with the container.
            proc = subprocess.Popen(["docker", "exec", self.id, "timeout", "--signal=KILL", str(timeout),
                                     "bash", "-lc", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            output = {}
            def drain(name, stream):
                chunks = bytearray()
                while block := stream.read(8192):
                    chunks.extend(block[:max(0, 24000 - len(chunks))])
                stream.close()
                output[name] = chunks.decode(errors="replace")
            readers = [threading.Thread(target=drain, args=(name, stream), daemon=True) for name, stream in
                       [("stdout", proc.stdout), ("stderr", proc.stderr)]]
            for reader in readers:
                reader.start()
            try:
                proc.wait(timeout=timeout + 10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                raise TimeoutError("Docker command did not finish") from None
            finally:
                for reader in readers:
                    reader.join(timeout=5)
            result = {"exit_code": proc.returncode, "stdout": output.get("stdout", ""),
                      "stderr": output.get("stderr", "")}
            self.results[key] = (digest, result)
            return result


def handler(session, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # No URLs, credentials, commands or output in access logs.

        def do_POST(self):
            self.connection.settimeout(5)
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.send_error(401)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 128000 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("Invalid body length")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("Expected object")
                result = session.request(self.path, data)
                if self.path == "/close":
                    session.close()
                    result = {"closed": True}
                body = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (PermissionError, ValueError, TimeoutError) as error:
                self.send_error({PermissionError: 403, ValueError: 400, TimeoutError: 410}[type(error)])
            except Exception:
                self.send_error(500)  # Never return host/provider exception details.
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection-file", type=Path, required=True)
    parser.add_argument("--tunnel", action="store_true", help="Launch installed cloudflared with a temporary HTTPS URL")
    parser.add_argument("--url", help="HTTPS origin of an existing named tunnel to this server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--lifetime", type=int, default=900)
    args = parser.parse_args()
    if not 60 <= args.lifetime <= 900 or (args.tunnel and args.url):
        parser.error("Use a 60–900 second lifetime and at most one tunnel mode")
    if args.connection_file.exists():
        parser.error("Connection file already exists; choose a new path")
    session, server, tunnel = None, None, None
    wrote_connection = False
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    try:
        session = Session(args.lifetime)
        token = secrets.token_urlsafe(32)
        server = BoundedServer(("127.0.0.1", args.port), handler(session, token))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:" + str(server.server_port)
        if args.tunnel:
            tunnel = subprocess.Popen(["cloudflared", "tunnel", "--url", url, "--no-autoupdate"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            ready = threading.Event()
            urls = []
            def watch():
                for line in tunnel.stderr:
                    match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                    if match and not urls:
                        urls.append(match.group(0))
                        ready.set()
            threading.Thread(target=watch, daemon=True).start()
            if not ready.wait(45):
                raise RuntimeError("Cloudflare Tunnel did not become ready")
            url = urls[0]
        elif args.url:
            from urllib.parse import urlsplit
            parsed = urlsplit(args.url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
                raise ValueError("Named tunnel URL must be an HTTPS origin")
            url = args.url
        args.connection_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.connection_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump({"url": url, "token": token}, file)
        wrote_connection = True
        print(json.dumps({"ready": True, "connection_file": str(args.connection_file), "computer_id": session.id}), flush=True)
        while not stop.wait(0.5) and not session.closed and time.monotonic() < session.deadline:
            if tunnel and tunnel.poll() is not None:
                raise RuntimeError("Cloudflare Tunnel exited")
    finally:
        try:
            if session:
                session.close()
        finally:
            if server:
                server.shutdown()
                server.server_close()
            if tunnel:
                tunnel.terminate()
                try:
                    tunnel.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    tunnel.kill()
                    tunnel.wait()
            if wrote_connection:
                args.connection_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
