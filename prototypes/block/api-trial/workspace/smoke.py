"""Exercise the persistent-disk API across two host endpoints for a NEW workspace."""
import argparse
import base64
import hashlib
import http.client
import json
import os
import socket
import time
from urllib.parse import quote


def call(sock, method, path, data=b"", status=200):
    with socket.socket(socket.AF_UNIX) as chan:
        chan.connect(sock)
        conn = http.client.HTTPConnection("localhost")
        conn.sock = chan
        try:
            start = time.monotonic()
            conn.request(method, path, data)
            res = conn.getresponse()
            body = res.read()
            if res.status != status:
                raise RuntimeError(f"{method} {path}: HTTP {res.status}: {body[:2000]!r}")
            if res.getheader("Content-Type") == "application/json":
                body = json.loads(body)
            return body, round(1000 * (time.monotonic() - start), 2)
        finally:
            conn.close()


def exercise(api, compute):
    def req(method, url, data=b"", status=200):
        return call(api, method, url, data, status)[0]

    p = "/files/" + quote("nested dir/code/input.bin")
    payload = os.urandom(256 * 1024 + 17)
    report = {}
    created = req("POST", "/create")
    req("POST", "/create", status=409)
    _, report["sleeping_put_ms"] = call(api, "PUT", p, payload)
    assert req("GET", p) == payload
    started, report["cold_start_to_mounted_ms"] = call(compute, "POST", "/start")
    # The second endpoint can only see these bytes through its lazy disk.
    assert call(compute, "GET", p)[0] == payload
    # The same API socket now routes both reads and writes to the guest owner.
    assert req("GET", p) == payload
    assert req("PUT", "/files/awake.txt", b"from the API\n")["revision"] >= 2
    cmd = b"sha256sum 'nested dir/code/input.bin'; cat awake.txt; mkdir -p result; printf 'from Bash' >result/output"
    reply = req("POST", "/exec", cmd)
    assert reply["status"] == 0
    assert base64.b64decode(reply["data"]) == (hashlib.sha256(payload).hexdigest()
        + "  nested dir/code/input.bin\nfrom the API\n").encode()
    assert req("GET", "/files/result/output") == b"from Bash"
    req("POST", "/stop")
    assert req("GET", "/files/result/output") == b"from Bash"
    req("PUT", p, b"")
    assert req("GET", p) == b""
    req("PUT", p, b"short")
    req("PUT", "/files/%2e%2e/outside", b"bad", status=400)
    last, _ = call(compute, "POST", "/start")
    assert started["owner"] != last["owner"]
    assert call(compute, "GET", p)[0] == b"short"
    req("POST", "/stop")
    status = req("GET", "/status")
    assert status["epoch"] == "asleep" and status["map"] != created["map"]
    report.update(final_revision=status["revision"], template=created["map"],
                  final_map=status["map"], payload_bytes=len(payload),
                  durable_guest_to_api=True, routed_api_to_guest=True)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("api")
    p.add_argument("compute")
    args = p.parse_args()
    exercise(args.api, args.compute)
