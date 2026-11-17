"""A local, transactional file-snapshot store for the experiment."""
import bisect
import hashlib
import json
from pathlib import PurePosixPath
import sqlite3
import subprocess
import tarfile

CHUNK = 64 * 1024


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def encode(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":")).encode()


def entry(mode, data, insert):
    if mode == "link":
        return [mode, data.decode()]
    return [mode, len(data), [insert(data[i:i+CHUNK]) for i in range(0, len(data), CHUNK)]]


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path,check_same_thread=False)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, data BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, manifest BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY, version TEXT NOT NULL);
        """)
        self.db.execute("PRAGMA synchronous=FULL")

    def insert(self, data):
        key = hash_bytes(data)
        self.db.execute("INSERT OR IGNORE INTO objects VALUES(?,?)", (key,data))
        return key

    def load(self, version):
        raw, = self.db.execute("SELECT manifest FROM versions WHERE id=?", (version,)).fetchone()
        if hash_bytes(raw) != version:
            raise IOError("manifest hash mismatch")
        return json.loads(raw)["files"]

    def commit(self, branch, parent, edits):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            ref = self.db.execute("SELECT version FROM refs WHERE name=?", (branch,)).fetchone()
            if (ref[0] if ref else None) != parent:
                raise ValueError("stale parent")
            files = self.load(parent) if parent else {}
            for path, mode, data in edits:
                if not path or path != str(PurePosixPath(path)) or path.startswith("/") or ".." in PurePosixPath(path).parts or path==".":
                    raise ValueError("invalid fixture path")
                if mode == "delete":
                    del files[path]
                else:
                    files[path] = entry(mode, data, self.insert)
            raw = encode({"parent":parent,"files":files})
            version = hash_bytes(raw)
            self.db.execute("INSERT OR IGNORE INTO versions VALUES(?,?)", (version,raw))
            self.db.execute("INSERT OR REPLACE INTO refs VALUES(?,?)", (branch,version))
        return version

    def get(self, key):
        row = self.db.execute("SELECT data FROM objects WHERE id=?", (key,)).fetchone()
        if row is None or hash_bytes(row[0]) != key:
            raise IOError("missing or corrupt chunk " + key)
        return row[0]


def layout(files):
    offset = 0
    for path, info in sorted(files.items()):
        hdr = tarfile.TarInfo(path)
        if info[0] == "link":
            hdr.type = tarfile.SYMTYPE
            hdr.linkname = info[1]
            hdr.mode = 0o777
        else:
            hdr.mode = int(info[0],8)
            hdr.size = info[1]
        yield offset, hdr.tobuf(format=tarfile.USTAR_FORMAT), info
        offset += 512 + ((hdr.size+511)//512)*512


def index(files, output, sparse):
    # mkfs parses headers and seeks over file contents. Holes contain no canonical bytes.
    with sparse.open("wb") as f:
        for offset, header, info in layout(files):
            f.seek(offset)
            f.write(header)
            if info[0] != "link":
                f.seek(((info[1]+511)//512)*512,1)
        f.write(bytes(1024))
    subprocess.run(["mkfs.erofs","-T","0","-b","512","--tar=i",output,sparse],check=True,stdout=subprocess.DEVNULL)
    sparse.unlink()


class Device:
    """Resolve the external device's logical byte offsets into verified canonical chunks."""
    def __init__(self, files, fetch):
        self.starts, self.entries = [], []
        self.fetch = fetch
        for offset, _, info in layout(files):
            if info[0] != "link" and info[1]:
                self.starts.append(offset+512)
                self.entries.append(info)
            size = 0 if info[0]=="link" else info[1]
            self.size = offset+512+((size+511)//512)*512+1024
        self.size = ((getattr(self,"size",1024)+4095)//4096)*4096

    def read(self, offset, size):
        if offset < 0 or size < 0 or offset+size > self.size:
            raise IOError("invalid range")
        result = bytearray(size)
        end = offset + size
        i = max(0,bisect.bisect_right(self.starts,offset)-1)
        while i < len(self.starts) and self.starts[i] < end:
            start = self.starts[i]
            _, length, chunks = self.entries[i]
            pos = max(offset,start)
            while pos < min(end,start+length):
                idx, within = divmod(pos-start, CHUNK)
                data = self.fetch(chunks[idx])
                count = min(len(data)-within,end-pos,start+length-pos)
                if count <= 0:
                    raise IOError("short chunk")
                result[pos-offset:pos-offset+count] = data[within:within+count]
                pos += count
            i += 1
        return result
