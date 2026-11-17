"""Compare cold QEMU workspace sessions with independent scratch directories."""
import argparse
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import random
import shutil
import sqlite3
import subprocess as sp
import tarfile
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
MIB = 1024 ** 2
clock = time.monotonic

def run(*args, **kw):
    return sp.run(args, check=True, stdout=sp.PIPE, **kw).stdout

def digest(b):
    return hashlib.sha256(b).hexdigest()

class Origin(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.serve(False)

    def do_GET(self):
        self.serve(True)

    def serve(self, body):
        name = self.path.strip("/")
        file = self.server.root / name
        if "/" in name or not file.is_file():
            self.send_error(404)
            return
        size = file.stat().st_size
        a, b = 0, size-1
        partial = self.headers.get("Range")
        if partial:
            first, last = partial.removeprefix("bytes=").split("-")
            a, b = int(first), min(int(last) if last else b, b)
        if not (0 <= a <= b < size):
            self.send_error(416)
            return
        self.send_response(206 if partial else 200)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(b-a+1))
        if partial:
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.end_headers()
        if body:
            with file.open("rb") as f:
                f.seek(a)
                data = f.read(b-a+1)
                fault = getattr(self.server, "fault", None)
                if fault and fault[0] == name and a <= fault[1] <= b:
                    data = bytearray(data)
                    data[fault[1]-a] ^= 1
                    self.server.fault_hits += 1
                with self.server.lock:
                    self.server.total += len(data)
                self.wfile.write(data)

    def log_message(self, *args):
        pass

def fsync(path):
    with path.open("rb") as f:
        os.fsync(f.fileno())

def syncdir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def fixture(root, mib):
    src = root / "src"
    src.mkdir(parents=True)
    (src / "hot").write_bytes(b"original\n")
    (src / "remove").write_bytes(b"move me\n")
    includes = []
    for i in range(128):
        header = f"h{i}.h"
        (src/header).write_text(f"#define VALUE_{i} {i}\n")
        includes.append(f'#include "{header}"')
    expression = "+".join(f"VALUE_{i}" for i in range(128))
    (src/"compile.c").write_text("\n".join(includes)+f"\nint sum(void) {{return {expression};}}\n")
    rng = random.Random(914)
    for i in range(mib * 16):
        sub = root / "data" / f"{i%32:02}"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / f"{i:05}").write_bytes(rng.randbytes(65536))

class Git:
    def __init__(self, root, files):
        self.repo = root / "git"
        self.index = root / "index"
        run("git", "init", "-q", "--bare", self.repo)
        self.git("config", "core.fsync", "all")
        self.git("--work-tree="+str(files), "add", "-A", cwd=files)
        self.base = self.commit(None)

    def git(self, *args, **kw):
        env = dict(os.environ, GIT_DIR=str(self.repo), GIT_INDEX_FILE=str(self.index),
                   GIT_AUTHOR_NAME="bench", GIT_COMMITTER_NAME="bench",
                   GIT_AUTHOR_EMAIL="bench@localhost", GIT_COMMITTER_EMAIL="bench@localhost")
        return run("git", *args, env=env, **kw)

    def commit(self, parent):
        tree = self.git("write-tree").strip().decode()
        return self.git("commit-tree", tree, *(["-p",parent] if parent else []),
                        "-m","prototype").strip().decode()

    def update(self, parent, changes, removed):
        self.git("read-tree", parent)
        for name, mode, data in changes:
            oid = self.git("hash-object", "-w", "--stdin", input=data).strip().decode()
            self.git("update-index", "--add", "--cacheinfo", mode, oid, name)
        for name in removed:
            self.git("update-index", "-z", "--index-info", input=("0 "+"0"*40+"\t"+name+"\0").encode())
        return self.commit(parent)

    def deliver(self, rev, exchange, mode):
        if mode == "git":
            (exchange/"base.tar").write_bytes(self.git("archive", rev))
            return
        raw = self.git("diff", "--name-status", "--no-renames", "-z", self.base, rev)
        fields = raw.decode().split("\0")[:-1]
        paths, deleted = [], []
        for status, name in zip(fields[::2], fields[1::2]):
            (deleted if status == "D" else paths).append(name)
        if paths:
            (exchange/"patch.tar").write_bytes(self.git("archive",rev,"--",*paths))
        (exchange/"deleted").write_text("".join(n+"\n" for n in deleted))

    def checkpoint(self, rev, exchange):
        changes = []
        with tarfile.open(exchange/"upper.tar") as tf:
            for m in tf:
                name = m.name.removeprefix("./")
                mode = "120000" if m.issym() else ("100755" if m.mode & 0o111 else "100644")
                data = m.linkname.encode() if m.issym() else tf.extractfile(m).read()
                changes.append((name,mode,data))
        removed = [s.removeprefix("./") for s in (exchange/"whiteouts").read_text().splitlines()]
        return self.update(rev,changes,removed)

def inputs_integrity(files, action):
    expected = {}
    for p in sorted(files.rglob("*")):
        if p.is_file():
            expected[p.relative_to(files).as_posix()] = digest(p.read_bytes())
    expected["src/hot"] = digest(b"vm write\n" if action == "recover" else b"api edit\n")
    if action == "recover":
        expected["src/moved"] = expected.pop("src/remove")
    return expected

def one(root, boot, out, mib, mode, server):
    root.mkdir()
    files = root/"files"
    fixture(files,mib)
    catalog = sqlite3.connect(root/"refs")
    catalog.execute("create table heads (branch text primary key, rev text)")
    def advance(branch, old, new):
        with catalog:
            c = catalog.execute("update heads set rev=? where branch=? and rev=?", (new,branch,old))
            if c.rowcount != 1:
                raise ValueError("stale writer")
    def read(branch):
        return catalog.execute("select rev from heads where branch=?",(branch,)).fetchone()[0]
    origin = server.root
    url = f"http://127.0.0.1:{server.server_port}/"
    t = clock()
    git = Git(root,files) if mode != "block" else None
    base = None
    def publish(image):
        # Immutable object plus durable directory entry before ref CAS.
        with image.open("rb") as f:
            oid = hashlib.file_digest(f,"sha256").hexdigest()
        fsync(image)
        os.replace(image,origin/oid)
        syncdir(origin)
        return oid
    if mode != "git":
        image = root/"seed.raw"
        with image.open("wb") as f:
            f.truncate((mib*2+32)*MIB)
        run("mkfs.ext4","-q","-m","0","-E","lazy_itable_init=0,lazy_journal_init=0",
            "-d",files,image)
        if mode == "hybrid":
            blocks = image.stat().st_size // 4096
            hashes = root/"verity-hashes"
            fmt = run("veritysetup","format","--no-superblock","--data-blocks",str(blocks),
                      "--data-block-size","4096","--hash-block-size","4096",image,hashes).decode()
            info = dict(line.split(":",1) for line in fmt.splitlines() if ":" in line)
            verity = (f"0 {blocks*8} verity 1 /dev/vda /dev/vda 4096 4096 {blocks} {blocks} "
                      f"sha256 {info['Root hash'].strip()} {info['Salt'].strip()}")
            # debugfs reads only our generated fixture to locate the fault-injection byte.
            offset = int(run("debugfs","-R","bmap /data/00/00000 0",image).strip())
            blocksize = int(next(s.split(":")[1] for s in run("dumpe2fs","-h",image).decode().splitlines() if s.startswith("Block size:")))
            fault_byte = offset*blocksize
            with image.open("ab") as target, hashes.open("rb") as src:
                shutil.copyfileobj(src,target)
        base = publish(image)
        if mode == "hybrid":
            descriptor = root/"base-descriptor"
            descriptor.write_text(json.dumps(dict(tree=git.base,object=base,verity=verity)))
            descriptor_id = publish(descriptor)
    seed = git.base if git else base
    with catalog:
        catalog.execute("insert into heads values ('main',?)",(seed,))
    rows = {"mode":mode,"payload_mib":mib,"seed_s":clock()-t,"phases":{}}
    def boot_once(rev,action):
        t = clock()
        with tempfile.TemporaryDirectory(dir=root) as d:
            session = Path(d)
            x = session/"exchange"
            x.mkdir()
            (x/"request").write_text(f"{mode} {action}\n")
            if mode == "hybrid":
                descriptor_bytes = (origin/descriptor_id).read_bytes()
                assert digest(descriptor_bytes)==descriptor_id
                pinned = json.loads(descriptor_bytes)
                assert pinned["tree"] == git.base
                (x/"verity").write_text(pinned["verity"])
            if git:
                git.deliver(rev,x,mode)
            delivery = sum(p.stat().st_size for p in x.iterdir() if p.name != "request")
            args = []
            if mode == "block":
                fmt = "raw" if rev == base else "qcow2"
                run("qemu-img","create","-q","-f","qcow2","-F",fmt,"-b",url+rev,session/"rw")
                args = ["-drive",f"if=virtio,file={session}/rw,format=qcow2"]
            elif mode == "hybrid":
                args = ["-drive",f"if=virtio,file={url+pinned['object']},readonly=on,format=raw"]
            log = out/(root.name+"-"+action+".log")
            start_bytes = server.total
            cmd = ["qemu-system-x86_64","-machine","accel=tcg","-cpu","max","-m","640",
                   "-nodefaults","-nographic","-no-reboot","-serial","stdio","-kernel",boot/"kernel",
                   "-initrd",boot/"init.gz","-append","console=ttyS0 quiet panic=1 rdinit=/init",
                   "-virtfs",f"local,path={x},mount_tag=exchange,security_model=none",*args]
            stats = {"file_delivery_bytes":delivery}
            with log.open("wb") as f:
                proc = sp.Popen(cmd,stdout=f,stderr=sp.STDOUT)
                try:
                    while proc.poll() is None:
                        if clock()-t > 100:
                            raise TimeoutError(log.read_text(errors="replace")[-3500:])
                        if "first_s" not in stats and (x/"reached").exists():
                            stats.update(first_s=clock()-t,first_range_bytes=server.total-start_bytes)
                            (x/"proceed").touch()
                        time.sleep(.005)
                    if proc.returncode or not (x/"verdict").is_file():
                        raise RuntimeError(log.read_text(errors="replace")[-3500:])
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
            verification_started=clock()
            if action not in ("api","corrupt"):
                got = {n:h for h,n in (s.split(None,1) for s in (x/"digests").read_text().splitlines())}
                assert got == expected[action], (got.keys() ^ expected[action].keys())
                stage = lambda name: float((x/name).read_text())
                stats.update(build_s=stage("buildend")-stage("scanstart"),scan_s=stage("scanend")-stage("buildend"),guest_first_s=stage("first")-stage("start"))
            verification_s=clock()-verification_started
            pub_start=clock()
            new = rev
            if action in ("edit","api"):
                if git:
                    new = git.checkpoint(rev,x)
                    stats["upper_archive_bytes"]=(x/"upper.tar").stat().st_size
                else:
                    stats["qcow_object_bytes"]=(session/"rw").stat().st_size
                    new = publish(session/"rw")
                advance("main",rev,new)
            stats.update(publication_s=clock()-pub_start,verification_s=verification_s,total_s=clock()-t,range_bytes=server.total-start_bytes)
            return new,stats
    expected = {a:inputs_integrity(files,a) for a in ("edit","recover","fork")}
    t=clock()
    if git:
        edited = git.update(seed,[("src/hot","100644",b"api edit\n")],[])
        advance("main",seed,edited)
        rows["phases"]["api"]={"total_s":clock()-t}
    else:
        edited,rows["phases"]["api"]=boot_once(seed,"api")
    with catalog:
        catalog.execute("insert into heads values ('fork',?)",(edited,))
    final, rows["phases"]["edit"] = boot_once(read("main"),"edit")
    try:
        advance("main",edited,seed)
    except ValueError:
        pass
    else:
        raise AssertionError("stale update succeeded")
    assert read("main")==final
    # Reopen catalog and start completely fresh QEMU processes with empty overlays.
    catalog.close()
    catalog=sqlite3.connect(root/"refs")
    for action,branch in (("recover","main"),("fork","fork")):
        _,rows["phases"][action]=boot_once(read(branch),action)
    if mode == "hybrid":
        server.fault = (base,fault_byte)
        server.fault_hits=0
        try:
            _,rows["phases"]["corrupt"]=boot_once(read("main"),"corrupt")
            assert server.fault_hits>0
            rows["phases"]["corrupt"]["injected_responses"]=server.fault_hits
        finally:
            server.fault=None
    catalog.close()
    return rows

def main():
    p=argparse.ArgumentParser()
    p.add_argument("out",type=Path)
    p.add_argument("--mib",type=int,default=64)
    p.add_argument("--rounds",type=int,default=2)
    args=p.parse_args()
    out=args.out.resolve()
    out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        tmp=Path(d)
        boot=tmp/"boot"
        run("bash",HERE/"kernel.sh",boot)
        with http.server.ThreadingHTTPServer(("127.0.0.1",0),Origin) as server:
            server.root=tmp/"origin"
            server.root.mkdir()
            server.lock=threading.Lock()
            server.total=0
            threading.Thread(target=server.serve_forever,daemon=True).start()
            for i in range(args.rounds):
                order=["block","git","hybrid"]
                for mode in order if i%2==0 else reversed(order):
                    name=f"{i}-{mode}"
                    root=tmp/name
                    row=one(root,boot,out,args.mib,mode,server)
                    (out/(name+".json")).write_text(json.dumps(row,indent=2)+"\n")
                    print(name,json.dumps(row),flush=True)
                    shutil.rmtree(root)
if __name__=="__main__":
    main()
