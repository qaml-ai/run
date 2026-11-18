"""A single workspace's private HTTP endpoint. The socket directory belongs to its operator."""
import argparse
import base64
import fcntl
import io
import http.client
import json
import os
import socket
import sys
import tempfile
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import UnixStreamServer
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parent / "offline")]
from botocore.exceptions import ClientError
from disk import NAME, OwnershipError, Workspace, format_template, mapping
from fileio import workspace_file
from volume import Volume, snapshot
from writer import boot, rpc


def guest_call(sock, op, **args):
    with socket.socket(socket.AF_UNIX) as chan:
        chan.settimeout(None)
        chan.connect(str(sock))
        with chan.makefile("rwb") as stream:
            stream.write(b"CONNECT 5000\n")
            stream.flush()
            if not stream.readline().startswith(b"OK "):
                raise ConnectionError("guest handshake failed")
            stream.write(b"file\n" + json.dumps(dict(op=op, **args)).encode() + b"\n")
            stream.flush()
            reply = json.loads(stream.readline())
    if reply.get("error"):
        raise OSError(reply["error"])
    return reply


class Active:
    def __init__(self, disk, folder, host, previous_owner=None):
        self.disk = disk
        self.stack = ExitStack()
        self.tag = None
        try:
            name = Path(os.environ["TRIAL_NBD"]).name
            lock = self.stack.enter_context(open("/run/lock/camelfs-" + name + ".lock", "a"))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            work = Path(self.stack.enter_context(tempfile.TemporaryDirectory(dir=folder)))
            self.head, self.tag, self.epoch = disk.claim(host, previous_owner)
            self.base = mapping(disk.volume, self.head)
            self.sock, self.dirty = self.stack.enter_context(boot(work, disk.cache, self.base))
        except BaseException:
            self.stack.close()
            # No VM request succeeded at this point. Return an originally clean
            # disk to sleep only while this failed start still owns the head.
            if self.tag is not None and previous_owner is None:
                disk.volume.publish(disk.ref, self.head["map"], self.head["revision"],
                                    self.tag, "asleep")
            raise

    def confirm_owner(self):
        _, current = self.disk.volume.head(self.disk.ref)
        if current != self.tag:
            raise Conflict("VM ownership changed")

    def checkpoint(self, sleep=False):
        # Freeze keeps open descriptors valid across ordinary commands. Sleep
        # publishes a clean unmount for the userspace filesystem editor.
        rpc(self.sock, "unmount" if sleep else "freeze")
        blocks, uploaded = snapshot(self.disk.volume, self.base, self.dirty)
        root = self.disk.volume.save_map(blocks)
        rev = self.head["revision"] + 1
        self.tag = self.disk.volume.publish(self.disk.ref, root, rev, self.tag,
                                           "asleep" if sleep else self.epoch)
        self.base = blocks
        self.head = {"map": root, "revision": rev}
        if not sleep:
            rpc(self.sock, "thaw")
        return {"map": root, "revision": rev, "uploaded_bytes": uploaded}

    def close(self):
        self.stack.close()


class Conflict(Exception):
    pass


class PeerError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def forward(sock, owner, method, path, body):
    # Addresses come only from operator configuration. The ref names a peer.
    with socket.socket(socket.AF_UNIX) as channel:
        channel.connect(sock)
        conn = http.client.HTTPConnection("localhost")
        conn.sock = channel
        try:
            conn.request(method, path, body, {"X-Workspace-Owner": owner})
            reply = conn.getresponse()
            raw = reply.read()
            if reply.status != 200:
                raise PeerError(reply.status, f"owner returned HTTP {reply.status}")
            if reply.getheader("Content-Type") == "application/octet-stream":
                return raw
            return json.loads(raw)
        finally:
            conn.close()


class App:
    def __init__(self, disk, folder, host, peers):
        self.disk, self.folder, self.vm = disk, folder, None
        self.host, self.peers = host, peers

    def disconnect(self):
        vm, self.vm = self.vm, None
        if vm:
            vm.close()

    def handle(self, method, target, data, expected=None):
        state = None
        if expected:
            if not self.vm or self.vm.epoch != expected:
                raise Conflict("request reached a displaced VM owner")
            self.vm.confirm_owner()
        elif not self.vm and (target.startswith("/files/") or target in ("/exec", "/stop")):
            state = self.disk.volume.head(self.disk.ref)
            owner = state[0]["epoch"]
            if owner != "asleep":
                peer = owner.partition(":")[0]
                if peer not in self.peers:
                    raise Conflict("workspace is held by " + owner)
                return forward(self.peers[peer], owner, method, target, data)
        if method == "POST" and target == "/create":
            return {"map": self.disk.create()}
        if method == "GET" and target == "/status":
            return self.disk.volume.head(self.disk.ref)[0]
        if method == "POST" and target == "/recover":
            epoch = data.decode()
            if self.vm:
                raise Conflict("stop the local owner first")
            recovery = Active(self.disk, self.folder, self.host, previous_owner=epoch)
            try:
                # ext4 replays the committed journal inside the VM, then hands
                # the offline editor a clean revision.
                return recovery.checkpoint(sleep=True)
            finally:
                recovery.close()
        if method == "POST" and target == "/start":
            if self.vm:
                self.vm.confirm_owner()
            else:
                self.vm = Active(self.disk, self.folder, self.host)
            return {"owner": self.vm.epoch}
        if method == "POST" and target in ("/stop", "/exec"):
            if not self.vm:
                raise Conflict("VM is not running on this host")
            self.vm.confirm_owner()
            try:
                if target == "/stop":
                    reply = self.vm.checkpoint(sleep=True)
                    self.disconnect()
                    return reply
                reply = guest_call(self.vm.sock, "exec", command=data.decode())
                reply.update(self.vm.checkpoint())
                return reply
            except BaseException:
                self.disconnect()
                raise
        if method not in ("PUT", "GET") or not target.startswith("/files/"):
            raise ValueError("unknown operation")
        path = unquote(target[len("/files/"):], errors="strict")
        if any(piece in ("", ".", "..") for piece in path.split("/")) or "\0" in path:
            raise ValueError("invalid workspace-relative path")
        write = method == "PUT"
        if self.vm:
            self.vm.confirm_owner()
            if not write:
                reply = guest_call(self.vm.sock, "get", path=path)
                return base64.b64decode(reply.get("data", ""), validate=True)
            try:
                guest_call(self.vm.sock, "put", path=path, data=base64.b64encode(data).decode())
                return self.vm.checkpoint()
            except BaseException:
                self.disconnect()
                raise
        if write:
            return self.disk.edit(state, lambda h: workspace_file(h, path, data), True)
        out = io.BytesIO()
        self.disk.edit(state, lambda h: workspace_file(h, path, output=out), False)
        return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    def request_body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("expected Content-Length")
        size = int(self.headers.get("Content-Length", "0"))
        if size < 0:
            raise ValueError("invalid Content-Length")
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError("incomplete request body")
        return data

    def dispatch(self):
        try:
            result = self.server.app.handle(self.command, self.path, self.request_body(),
                                            self.headers.get("X-Workspace-Owner"))
        except Exception as exc:
            status = 500
            if isinstance(exc, PeerError):
                status = exc.status
            elif isinstance(exc, (FileNotFoundError, NotADirectoryError)):
                status = 404
            elif isinstance(exc, ValueError):
                status = 400
            elif isinstance(exc, (Conflict, OwnershipError, BlockingIOError)):
                status = 409
            elif isinstance(exc, ClientError):
                status = exc.response["ResponseMetadata"]["HTTPStatusCode"]
                if status == 412:
                    status = 409
            self.send_error(status, explain=str(exc))
            return
        binary = isinstance(result, bytes)
        body = result if binary else json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream" if binary else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_PUT = do_GET = dispatch

    def log_message(self, fmt, *args):
        print(fmt % args, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("format-template").add_argument("size_mib", type=int)
    serve = modes.add_parser("serve")
    serve.add_argument("name")
    serve.add_argument("state_dir", type=Path)
    serve.add_argument("--host", required=True)
    serve.add_argument("--peer", action="append", default=[], metavar="NAME=SOCKET")
    args = parser.parse_args()
    volume = Volume()
    if args.mode == "format-template":
        print(format_template(volume, args.size_mib << 20))
        return
    os.umask(0o077)
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    peers = {}
    for entry in args.peer:
        name, sep, address = entry.partition("=")
        if not sep or not NAME.fullmatch(name) or not os.path.isabs(address) or name in peers or name == args.host:
            parser.error("expected a distinct peer NAME=/absolute/socket")
        peers[name] = address
    if not NAME.fullmatch(args.host):
        parser.error("invalid host name")
    app = App(Workspace(volume, args.name, args.state_dir / "cache"), args.state_dir, args.host, peers)
    sock = args.state_dir / "api.sock"
    # flock distinguishes a dead process's leftover socket from a live endpoint.
    with (args.state_dir / "server.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sock.unlink(missing_ok=True)
        try:
            with UnixStreamServer(str(sock), Handler) as server:
                server.app = app
                server.serve_forever()
        finally:
            app.disconnect()
            sock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
