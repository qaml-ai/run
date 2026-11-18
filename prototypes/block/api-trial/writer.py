"""One isolated owner serving test requests from its supervisor over stdin/stdout."""

import json
from contextlib import ExitStack, contextmanager
import os
import socket
import subprocess as sp
import sys
import time
import uuid
from pathlib import Path

from volume import CHUNK, Volume, snapshot

HERE = Path(__file__).resolve().parent
clock = time.perf_counter


def emit(**fields):
    print(json.dumps(fields), flush=True)


def poll_until(test, processes, timeout=15):
    end = clock() + timeout
    while not test():
        for process in processes:
            if process.poll() is not None:
                raise RuntimeError(f"{process.args[0]} exited {process.returncode}")
        if clock() >= end:
            raise TimeoutError("device or guest failed to become ready")
        time.sleep(0.005)


def rpc(path, command):
    with socket.socket(socket.AF_UNIX) as channel:
        channel.settimeout(12)
        channel.connect(str(path))
        with channel.makefile("rwb", buffering=0) as f:
            f.write(b"CONNECT 5000\n")
            if not f.readline().startswith(b"OK "):
                raise ConnectionError("vsock handshake")
            f.write(command.encode() + b"\n")
            result = f.readline().decode().strip()
    if not result or (not command.startswith("read") and result != "OK"):
        raise OSError("guest request failed: " + command.split()[0])
    return result


@contextmanager
def boot(folder, cache, base, track_changes=False):
    nbd = os.environ["TRIAL_NBD"]
    bound = Path("/sys/class/block") / Path(nbd).name / "pid"
    if bound.exists():
        raise RuntimeError("NBD device busy")
    vsock = folder / "vm.sock"
    dirty = folder / "dirty"
    dirty.mkdir()
    cache.mkdir(exist_ok=True)
    processes = []
    with (folder / "backend.log").open("wb") as log:
        try:
            mapping = folder / "map.json"
            mapping.write_text(json.dumps(base))
            env = dict(
                os.environ,
                TRIAL_MAP=str(mapping),
                TRIAL_CACHE=str(cache),
                TRIAL_DIRTY=str(dirty),
            )
            if track_changes:
                pending = folder / "pending"
                pending.mkdir()
                env["TRIAL_PENDING"] = str(pending)
            nbd_sock = folder / "nbd.sock"

            def launch(args, **kwargs):
                process = sp.Popen(
                    ["setpriv", "--pdeathsig", "SIGKILL", "--", *args],
                    stdout=log, stderr=log, stdin=sp.DEVNULL, **kwargs
                )
                processes.append(process)
                return process

            launch(
                [
                    os.environ["NBDKIT"],
                    "-f",
                    "-U",
                    nbd_sock,
                    "--threads",
                    "1",
                    os.environ["NBDKIT_PYTHON"],
                    HERE / "device.py",
                ],
                env=env,
            )
            poll_until(nbd_sock.exists, processes)
            launch(["nbd-client", "-unix", nbd_sock, nbd, "-nofork", "-nonetlink"])
            size = len(base) * CHUNK
            poll_until(
                lambda expected=size: (
                    bound.exists()
                    and int((bound.parent / "size").read_text()) * 512 == expected
                ),
                processes,
            )
            with open(nbd, "rb", buffering=0) as device:
                if device.seek(0, 2) != len(base) * CHUNK:
                    raise OSError("host block capacity mismatch")
            cfg = {
                "boot-source": {
                    "kernel_image_path": os.environ["TRIAL_KERNEL"],
                    "initrd_path": os.environ["TRIAL_INITRD"],
                    "boot_args": "console=ttyS0 panic=1 reboot=k pci=off rdinit=/init",
                },
                "machine-config": {"vcpu_count": 1, "mem_size_mib": 192},
                "vsock": {"guest_cid": 19, "uds_path": str(vsock)},
                "drives": [
                    {
                        "drive_id": "workspace",
                        "path_on_host": nbd,
                        "is_root_device": False,
                        "is_read_only": False,
                        "cache_type": "Writeback",
                        "io_engine": "Sync",
                    }
                ],
            }
            # The developer workload fixture needs Node, its offline package
            # cache and a native ext4 control on a separate disposable drive.
            if toolbox := os.environ.get("TRIAL_TOOLBOX"):
                cfg["machine-config"] = {"vcpu_count": 4, "mem_size_mib": 4096}
                cfg["drives"].append({"drive_id": "toolbox", "path_on_host": toolbox,
                                      "is_root_device": False, "is_read_only": False})
            config = folder / "firecracker.json"
            config.write_text(json.dumps(cfg))
            launch(["firecracker", "--no-api", "--config-file", config])

            def ready():
                try:
                    return rpc(vsock, "ping") == "OK"
                except (OSError, ConnectionError):
                    return False

            poll_until(ready, processes)
            yield vsock, dirty
        finally:
            for process in reversed(processes):
                if process.args[4] == "nbd-client" and process.poll() is None and bound.exists():
                    sp.run(["nbd-client", "-d", nbd], check=True, stdout=log, stderr=log)
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except sp.TimeoutExpired:
                        process.kill()
                        process.wait()


def run():
    volume = Volume()
    folder, cache, ref = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    emit(ready=True)
    with ExitStack() as stack:
        cold = True
        for line in sys.stdin:
            request = json.loads(line)
            t = clock()
            if cold:
                head, etag = volume.head(ref)
                epoch = uuid.uuid4().hex
                etag = volume.publish(ref, head["map"], head["revision"], etag, epoch)
                base = json.loads(volume.read_object("maps", head["map"]))
                vsock, dirty = stack.enter_context(boot(folder, cache, base))
                cold = False
            mounted = clock()
            value = request["value"]
            if "expected_before" in request and rpc(vsock, "read") != request["expected_before"]:
                raise AssertionError("guest opened a different revision")
            sleep = request.get("sleep_after", False)
            rpc(vsock, "put " + value)
            if rpc(vsock, "read") != value:
                raise AssertionError("Bash did not observe API write")
            edited = clock()
            rpc(vsock, "unmount" if sleep else "freeze")
            frozen = clock()
            base, uploaded = snapshot(volume, base, dirty)
            root = volume.save_map(base)
            staged = clock()
            if request.get("interrupt"):
                emit(staged=True)
                time.sleep(60)
                raise RuntimeError("fault supervisor did not kill owner")
            revision = head["revision"] + 1
            etag = volume.publish(ref, root, revision, etag, "asleep" if sleep else epoch)
            published = clock()
            head = {"map": root, "revision": revision}
            if not sleep:
                rpc(vsock, "thaw")
            emit(
                ack=True,
                value=value,
                root=root,
                revision=revision,
                uploaded_bytes=uploaded,
                mount_ms=(mounted - t) * 1000,
                edit_and_bash_ms=(edited - mounted) * 1000,
                freeze_ms=(frozen - edited) * 1000,
                blocks_and_map_ms=(staged - frozen) * 1000,
                publish_ms=(published - staged) * 1000,
                thaw_ms=(clock() - published) * 1000,
            )
            if sleep:
                return


if __name__ == "__main__":
    run()
