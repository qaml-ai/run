"""Kill the writer while a ref transaction is open, then immediately after it returns."""
from multiprocessing import get_context
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sys
import time
from store import Store


def writer(path, parent, phase, pipe):
    store = Store(path)
    def changes():
        yield "file","644",b"after"
        if phase == "inside":
            pipe.send("staged")
            time.sleep(60)
    version = store.commit("main",parent,changes())
    pipe.send(version)
    time.sleep(60)


def run(out):
    ctx = get_context("spawn")
    with TemporaryDirectory() as d:
        path = Path(d)/"snapshots"
        store = Store(path)
        base = store.commit("main",None,[("file","644",b"before")])
        store.db.close()
        rows={}
        for phase in ["inside","acknowledged"]:
            recv,send = ctx.Pipe(duplex=False)
            process = ctx.Process(target=writer,args=(path,base,phase,send))
            process.start()
            send.close()
            try:
                if not recv.poll(15):
                    raise TimeoutError("writer did not reach "+phase)
                observed = recv.recv()
            finally:
                process.kill()
                process.join()
                recv.close()
            recovered = Store(path)
            version, = recovered.db.execute("SELECT version FROM refs WHERE name='main'").fetchone()
            expected = base if phase=="inside" else observed
            assert version==expected
            data = recovered.get(recovered.load(version)["file"][2][0])
            assert data == (b"before" if phase=="inside" else b"after")
            rows[phase]={"recovered":data.decode(),"termination":process.exitcode}
            recovered.db.close()
        out.mkdir(parents=True,exist_ok=True)
        (out/"crash.json").write_text(json.dumps(rows,indent=2)+"\n")
        print(rows)
if __name__=="__main__":
    run(Path(sys.argv[1]))
