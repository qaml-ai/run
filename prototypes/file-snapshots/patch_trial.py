"""Measure one-byte writes and exercise rollback before publishing a branch."""
import hashlib
import json
from pathlib import Path
import random
import sys
import tempfile
import time
from store import CHUNK, Store, encode


def run(out):
    out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        path = Path(d)/"db"
        store = Store(path)
        data = random.Random(38).randbytes(32*1024**2)
        files = [(f"src/{i}","644",str(i).encode()) for i in range(8000)]
        seed = store.commit("main",None,files+[("large","644",data)])
        before = store.db.execute("select count(*),sum(length(data)) from objects").fetchone()
        def broken():
            yield ("interrupted","644",b"unpublished")
            raise RuntimeError("fixture injection")
        try:
            store.commit("main",seed,broken())
        except RuntimeError:
            pass
        assert store.db.execute("select version from refs").fetchone()==(seed,)
        assert store.db.execute("select count(*),sum(length(data)) from objects").fetchone()==before
        t=time.monotonic()
        new=store.commit("main",seed,[("large","patch",(CHUNK-1,bytes([data[CHUNK-1]^255])))])
        elapsed=time.monotonic()-t
        after=store.db.execute("select count(*),sum(length(data)) from objects").fetchone()
        store.db.close()
        cold=Store(path,readonly=True)
        undo=cold.load(seed)
        changed=cold.load(new)
        assert sum(a!=b for a,b in zip(changed["large"][2],undo["large"][2]))==1
        assert after[0]-before[0]==1 and after[1]-before[1]==CHUNK
        restored=b"".join(cold.get(k) for k in changed["large"][2])
        assert restored==data[:CHUNK-1]+bytes([data[CHUNK-1]^255])+data[CHUNK:]
        row=dict(changed_bytes=1,new_content_bytes=after[1]-before[1],
                 new_manifest_bytes=cold.db.execute("select length(manifest) from versions where id=?",(new,)).fetchone()[0],
                 file_count=len(changed),patch_ms=elapsed*1000,rollback_verified=True)
        cold.db.close()
        (out/"patch.json").write_text(json.dumps(row,indent=2)+"\n")
        print(row)
if __name__=="__main__":
    run(Path(sys.argv[1]))
