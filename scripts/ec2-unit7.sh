#!/usr/bin/env bash
# Reviewer only, on an approved disposable root-capable host. Never run in CI.
# Usage: sudo scripts/ec2-unit7.sh SOCKET DATA SOURCE_IMAGE [RELATIVE_FIRST_FILE]
# The daemon must use DATA and a store writable by the reviewer. SOURCE_IMAGE
# is an ext4 large-root image, <=4 GiB. Outputs JSON rows; no ublk comparison.
set -euo pipefail
[[ $EUID == 0 && $# -ge 3 ]] || { echo 'usage: sudo scripts/ec2-unit7.sh SOCKET DATA SOURCE_IMAGE [RELATIVE_FIRST_FILE]' >&2; exit 2; }
python3 - "$@" <<'PY'
import hashlib, http.client, json, os, pathlib, random, shutil, socket, statistics, subprocess, sys, tempfile, time
sock,data,source=sys.argv[1:4]
first=sys.argv[4] if len(sys.argv)>4 else None
class API(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX); self.sock.connect(sock)
def api(method,path,body=None):
    c=API('localhost',timeout=600)
    c.request(method,'/v0/'+path,json.dumps(body) if body is not None else None)
    r=c.getresponse(); b=r.read(); c.close()
    if r.status>=300: raise RuntimeError(b.decode())
    return json.loads(b)
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb',buffering=0) as f:
        while b:=f.read(4<<20): h.update(b)
    return h.hexdigest()
work=pathlib.Path(tempfile.mkdtemp(prefix='unit7-',dir=data))
try:
    sparse=work/'sparse-65m.img'
    with sparse.open('wb') as f:
        for _ in range(65): f.write(os.urandom(1<<20))
    sparse_times={}
    for label,gib,src in [('sparse65',1,sparse),('sparse65',16,sparse),('large',4,source),('large',16,source),('large',64,source)]:
        img=work/f'root-{gib}.img'
        subprocess.run(['cp','--reflink=always','--sparse=always',str(src),str(img)],check=True)
        with img.open('r+b') as f: f.truncate(gib<<30)
        root=api('POST','images',{'lineage':'unit7','path':str(img)})['root']
        # Only remove this benchmark's imported complete image. Do not clear
        # a running daemon's verified cache; use a fresh daemon per cold trial.
        (pathlib.Path(data)/'images'/f'{root}.img').unlink()
        job=f'unit7-{label}-{gib}'
        start=time.perf_counter()
        v=api('POST','mounts',{'jobId':job,'lineage':'unit7','root':root,'hydrate':False,'fence':{'holder':'reviewer','epoch':1}})
        mounted=False
        try:
            first_ms=None
            if first and label=='large':
                mount=work/'mnt'; mount.mkdir(exist_ok=True)
                t=time.perf_counter(); subprocess.run(['mount','-o','ro,noload',v['image'],str(mount)],check=True); mounted=True
                with (mount/first).open('rb') as f: f.read()
                first_ms=(time.perf_counter()-t)*1000
                subprocess.run(['umount',str(mount)],check=True); mounted=False
            lat=[]
            with open(v['image'],'rb',buffering=0) as f:
                while True:
                    t=time.perf_counter_ns(); os.pread(f.fileno(),4096,random.randrange(0,min(gib<<30,670<<20)//4096)*4096)
                    lat.append((time.perf_counter_ns()-t)/1000)
                    status=api('GET',f'mounts/{job}')
                    if status['state']=='hydrated': break
                    if time.perf_counter()-start>600: raise TimeoutError('hydration')
            hydration_ms=(time.perf_counter()-start)*1000
            row={'label':label,'first_cold_file_ms':first_ms,'virtual_gib':gib,'hydration_ms':hydration_ms,'swap_ms':status['swapMs'],'hydrated_bytes':status['hydratedBytes'],'demand_p99_us':sorted(lat)[min(len(lat)-1,int(len(lat)*.99))],'demand_samples':len(lat)}
            t=time.perf_counter(); got=digest(v['image']); row['local_full_read_ms']=(time.perf_counter()-t)*1000
            assert got==digest(img),'post-swap bytes differ'
            # Exactly three chunk edits, then two checkpoints verify delta.
            with open(v['image'],'r+b',buffering=0) as f:
                for off in [4096,2<<20,6<<20]: os.pwrite(f.fileno(),b'unit7-delta',off)
                os.fsync(f.fileno())
            cp=api('POST',f'mounts/{job}/checkpoint',{})
            row['checkpoint']=cp
            assert cp['changedChunks']==3,cp
            assert api('POST',f'mounts/{job}/checkpoint',{})['changedChunks']==0
            if label=='sparse65': sparse_times[gib]=hydration_ms
            print(json.dumps(row),flush=True)
        finally:
            if mounted: subprocess.run(['umount',str(work/'mnt')],check=True)
            api('DELETE',f'mounts/{job}')
        assert (pathlib.Path(data)/'images'/f'{root}.img').exists()
    ratio=max(sparse_times.values())/min(sparse_times.values())
    print(json.dumps({'sparse65_virtual_size_ratio':ratio,'within_20_percent':ratio<=1.2}),flush=True)
finally:
    shutil.rmtree(work)
PY
