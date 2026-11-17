import hashlib
import json
import os
from pathlib import Path
import threading
import subprocess as sp
import sys
import tarfile
import time
from store import Store, index, encode, hash_bytes
from origin import ChunkOrigin
HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parent/"workspace-layouts"))
from bench import fixture

def stop(p):
    if p.poll() is None:
        p.terminate()
        try:
            p.wait(2)
        except sp.TimeoutExpired:
            p.kill()
            p.wait()

def run(work, out, mib, delay_ms):
    out.mkdir(parents=True,exist_ok=True)
    clock = time.monotonic
    start = clock()
    files = work/"fixture"
    fixture(files,mib)
    paths = sorted(p for p in files.rglob("*") if p.is_file())
    sums = {str(p.relative_to(files)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    store = Store(work/"origin.sqlite")
    seed = store.commit("main",None,((str(p.relative_to(files)),"644",p.read_bytes()) for p in paths))
    report = {"mib":mib,"origin_delay_ms":delay_ms,"files":len(paths),"fixture_and_seed_s":clock()-start,"phases":{}}
    start = clock()
    edited = store.commit("main",seed,[("src/hot","644",b"api edit\n")])
    report["api_edit_s"] = clock()-start
    with store.db:
        store.db.execute("INSERT INTO refs VALUES('fork',?)",(edited,))
    sums["src/hot"] = hashlib.sha256(b"api edit\n").hexdigest()
    fork_sums = sums.copy()

    def guest(branch, action, expected, hashes):
        version, = store.db.execute("SELECT version FROM refs WHERE name=?",(branch,)).fetchone()
        session = work/action
        session.mkdir()
        x = session/"exchange"
        x.mkdir()
        (x/"action").write_text(action)
        (x/"expected").write_text(expected)
        t = clock()
        idx = session/"index"
        directory = store.load(version)
        manifest = encode(directory)
        (session/"manifest").write_bytes(manifest)
        index(directory,idx,session/"headers.tar")
        origin = ChunkOrigin(store,directory,delay_ms/1000)
        thread = threading.Thread(target=origin.serve_forever,daemon=True)
        thread.start()
        stats = {"manifest_bytes":len(manifest),"index_bytes":idx.stat().st_size, "index_s":clock()-t}
        env = dict(os.environ,SNAP_MODULE=str(HERE),SNAP_PORT=str(origin.server_port),
                   SNAP_MANIFEST=str(session/"manifest"),SNAP_MANIFEST_HASH=hash_bytes(manifest),
                   SNAP_VERSION=version,SNAP_FIRST=str(x/"first"),SNAP_STATS=str(session/"first.json"),
                   SNAP_TOTAL=str(session/"total.json"))
        sock = session/"nbd"
        with (out/(action+"-device.log")).open("w") as device_log, (out/(action+"-guest.log")).open("w") as guest_log:
            server = sp.Popen(["nbdkit","-f","--readonly","--threads","1","-U",sock,"python",HERE/"plugin.py"],env=env,stderr=device_log)
            try:
                while not sock.exists():
                    if server.poll() is not None or clock()-t>12:
                        raise RuntimeError("NBD startup failed")
                    time.sleep(.01)
                cmd = ["qemu-system-x86_64","-machine","accel=tcg","-cpu","max","-m","640",
                    "-nodefaults","-device","virtio-rng-pci","-nographic","-no-reboot","-serial","stdio",
                    "-kernel",work/"boot/kernel","-initrd",work/"boot/init.gz","-append","console=ttyS0 quiet panic=1 rdinit=/init",
                    "-virtfs",f"local,path={x},mount_tag=exchange,security_model=none",
                    "-drive",f"file={idx},format=raw,if=virtio,readonly=on",
                    "-drive",f"file=nbd+unix:///?socket={sock},format=raw,if=virtio,readonly=on"]
                vm = sp.Popen(cmd,stdout=guest_log,stderr=sp.STDOUT)
                try:
                    while vm.poll() is None:
                        if (x/"first").exists() and not (x/"proceed").exists():
                            stats["host_first_s"] = clock()-t
                            stats["first_source_bytes"] = json.loads((session/"first.json").read_text())[0]
                            (x/"proceed").touch()
                        if clock()-t > 150:
                            raise TimeoutError(f"{action} timed out")
                        time.sleep(.005)
                    if vm.returncode or not (x/"verdict").exists():
                        raise RuntimeError(f"guest failed in {action}: {(out/(action+'-guest.log')).read_text()[-1000:]}")
                finally:
                    stop(vm)
            finally:
                stop(server)
                origin.shutdown()
                thread.join()
                origin.server_close()
        if action != "fault":
            observed = dict((p,h) for h,p in (row.split(None,1) for row in (x/"sums").read_text().splitlines()))
            assert observed == hashes
            stamp = lambda p: float((x/p).read_text())
            stats.update(guest_first_s=stamp("first")-stamp("begin"),full_scan_s=stamp("scanned")-stamp("built"))
            stats["source_bytes"],stats["device_bytes"],stats["device_reads"] = json.loads((session/"total.json").read_text())
        else:
            assert "corrupt chunk" in (out/(action+"-device.log")).read_text()
        report["phases"][action] = stats
        return x

    x = guest("main","edit","api edit",sums)
    t = clock()
    updates = []
    with tarfile.open(x/"upper.tar") as archive:
        for m in archive:
            name = m.name.removeprefix("./")
            assert m.isfile() or m.issym()
            if m.issym():
                updates.append((name,"link",m.linkname.encode()))
            else:
                updates.append((name,"755" if m.mode & 0o111 else "644",archive.extractfile(m).read()))
    updates.extend((p.removeprefix("./"),"delete",b"") for p in (x/"deleted").read_text().splitlines())
    final = store.commit("main",edited,updates)
    report["checkpoint_publish_s"] = clock()-t
    try:
        store.commit("main",edited,[])
    except ValueError as error:
        assert str(error) == "stale parent"
    else:
        raise AssertionError("stale write succeeded")
    sums["src/hot"] = hashlib.sha256(b"vm write\n").hexdigest()
    sums["src/moved"] = sums.pop("src/remove")
    store.db.close()
    store = Store(work/"origin.sqlite")
    guest("main","recover","vm write",sums)
    guest("fork","fork","api edit",fork_sums)
    key = store.load(final)["src/hot"][2][0]
    with store.db:
        store.db.execute("UPDATE objects SET data=? WHERE id=?",(b"bad data\n",key))
    guest("main","fault","",{})
    store.db.close()
    (out/"result.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report),flush=True)

if __name__ == "__main__":
    run(Path(sys.argv[1]),Path(sys.argv[2]).resolve(),int(sys.argv[3]),float(sys.argv[4]) if len(sys.argv)>4 else 0)
