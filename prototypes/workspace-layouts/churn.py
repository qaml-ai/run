"""Measure archive preparation as a branch diverges from its prebuilt base."""
import json
from pathlib import Path
import random
import sys
import tempfile
import time

from bench import Git, MIB, fixture

out = Path(sys.argv[1])
out.mkdir(parents=True,exist_ok=True)
rows = []
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    files = root/"files"
    fixture(files,64)
    big = files/"data"/"large.bin"
    big.write_bytes(random.Random(47).randbytes(32*MIB))
    repo = Git(root, files)
    small = sorted(f for f in (files/"data").rglob("*") if f.is_file() and f != big)
    for name, subset in (("one header",[files/"src/h0.h"]),("one large file",[big]),
                         ("one percent",small[:10]),("ten percent",small[:102]),("all small files",small)):
        changes = []
        for path in subset:
            data = bytearray(path.read_bytes())
            data[0] ^= 1
            changes.append((str(path.relative_to(files)),"100644",bytes(data)))
        rev = repo.update(repo.base,changes,[])
        for mode in ("hybrid","git"):
            with tempfile.TemporaryDirectory() as exchange:
                start = time.monotonic()
                repo.deliver(rev,Path(exchange),mode)
                elapsed = time.monotonic()-start
                rows.append(dict(edit=name,changed_bytes=len(subset),mode=mode,
                                 package_bytes=sum(p.stat().st_size for p in Path(exchange).iterdir()),
                                 prepare_s=elapsed))
(out/"churn.json").write_text(json.dumps(rows,indent=2)+"\n")
print(json.dumps(rows))
