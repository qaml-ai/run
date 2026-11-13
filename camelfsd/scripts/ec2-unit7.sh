#!/usr/bin/env bash
# Reviewer only. Never run against the shared camelfsd service or its data.
set -euo pipefail
[[ -e /nvme/host-free ]] || { echo 'unit 7: reviewer runs (no host slot)'; exit 0; }
[[ $EUID == 0 ]] || { echo 'run as root in the reviewer slot' >&2; exit 1; }
cd "$(dirname "$0")/.."
REPO=$(git rev-parse --show-toplevel)
D=/nvme/camelfs-u7
SOCK=$D/api.sock
[[ ! -e $D ]] || { echo "$D exists; reviewer must inspect and remove prior run first" >&2; exit 1; }
mkdir -p "$D/work/mnt"
W=$D/work
RESULT=$W/results.txt
INSTANCE=$(curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)
PREFIX=camelfsd/u7-$(date -u +%Y%m%dT%H%M%SZ)
BUCKET=camel-fs-proto-904534089871-usw2
PID= UBLK_PID= UBLK_ID= LOOP_DEV=
cleanup() {
 [[ -z $LOOP_DEV ]] || losetup -d "$LOOP_DEV" || true
 mountpoint -q "$W/mnt" && umount "$W/mnt" || true
 if [[ -n $UBLK_ID ]]; then "$UBLK_BIN" del -n "$UBLK_ID" || true; fi
 [[ -z $UBLK_PID ]] || wait "$UBLK_PID" || true
 if [[ -n $PID ]]; then kill -TERM "$PID"; wait "$PID" || true; fi
}
trap cleanup EXIT
exec 3>&1
exec > >(tee -a "$RESULT") 2>&1
TEE_PID=$!
now() { date +%s%N; }
elapsed() { echo $(( ($(now)-$1)/1000000 )); }
field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
client() { "$BIN" client --socket "$SOCK" "$@"; }
start_daemon() {
 local store=$1;shift
 "$BIN" host --data "$D/data-$LABEL" --socket "$SOCK" --nbd-listen 127.0.0.1:10811 --store "$store" --fetch-depth 64 "$@" > "$W/daemon-$LABEL.log" 2>&1 &
 PID=$!
 for ((i=0;i<200;i++)); do curl -fsS --unix-socket "$SOCK" http://localhost/v0/health >/dev/null 2>&1 && return; kill -0 "$PID"; sleep .1; done
 return 1
}
stop_daemon() { kill -TERM "$PID";wait "$PID";PID=;rm -f "$SOCK"; }
# Build unit 6 and HEAD from archives, never check out another branch here.
for pair in before:81ee7ec8 after:HEAD; do
 label=${pair%%:*};ref=${pair#*:}
 mkdir -p "$W/$label"
 git -C "$REPO" archive "$ref" camelfsd | tar -xf - -C "$W/$label"
 if [[ $label == before ]]; then
  # Count successful payload GETs without changing the baseline cache/read path.
  python3 - "$W/$label/camelfsd/internal/store/store.go" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text();s=s.replace('return io.ReadAll(o.Body)', 'b, e := io.ReadAll(o.Body); fmt.Fprintf(os.Stderr, "u7_fetch bytes=%d\\n", len(b)); return b, e');p.write_text(s)
PY
 fi
 (cd "$W/$label/camelfsd" && go build -o "$W/$label.bin" ./cmd/camelfsd)
done
# NIC ceiling first, using the separate branch without modifying prototypes/.
git -C "$REPO" show origin/proto/s3speed --stat
mkdir "$W/s3speed"
git -C "$REPO" archive origin/proto/s3speed prototypes/s3speed | tar -xf - -C "$W/s3speed"
(cd "$W/s3speed/prototypes/s3speed" && go build -o "$W/s3speed.bin" .)
"$W/s3speed.bin" upload --bucket "$BUCKET" --prefix "$PREFIX/speed" --chunks 4096 --layouts pack4m --concurrency 64
"$W/s3speed.bin" fetch --bucket "$BUCKET" --prefix "$PREFIX/speed" --chunks 4096 --mode pack4m --concurrency 64 --out "$W/speed.img" --csv-header > "$W/nic.csv"
cat "$W/nic.csv"
python3 - "$W/nic.csv" <<'PY'
import csv,sys
r=list(csv.DictReader(open(sys.argv[1])))[-1];print('nic_ceiling_mb_s='+r['mb_per_s'])
PY
truncate -s 4G "$W/large.img"
mkfs.ext4 -q -E lazy_itable_init=0,lazy_journal_init=0 -F "$W/large.img"
mount -o loop "$W/large.img" "$W/mnt"
cp -a /nvme/bench/trees/large/. "$W/mnt/"
sync;umount "$W/mnt"
echo "unit 7 instance=$INSTANCE prefix=s3://$BUCKET/$PREFIX"
for LABEL in before after; do
 BIN=$W/$LABEL.bin
 start_daemon "s3://$BUCKET/$PREFIX/$LABEL"
 imported=$(client import-image --lineage large --name main --path "$W/large.img")
 echo "$LABEL import=$imported"
 ROOT=$(field root <<< "$imported")
 stop_daemon
 # A new process is essential: never delete trusted cache files under a daemon.
 for hydrate in false true; do
  rm -rf "$D/data-$LABEL/cache" "$D/data-$LABEL/images/$ROOT.img"
  start_daemon "s3://$BUCKET/$PREFIX/$LABEL"
  start=$(now)
  mounted=$(client mount --job u7 --lineage large --root "$ROOT" --hydrate="$hydrate")
  dev=$(field image <<< "$mounted")
  if [[ $hydrate == true ]]; then
   (
    for ((i=0;i<6000;i++)); do
     status=$(client status --job u7)
     if [[ $(field state <<< "$status") == hydrated ]]; then elapsed "$start" > "$W/$LABEL-hydration-ms";exit 0;fi
     sleep .1
    done
    exit 1
   ) &
   poll=$!
   fio --name=demand --filename="$dev" --bs=4k --iodepth=1 --direct=1 --rw=randread --runtime=5 --time_based=1 --ioengine=io_uring --readonly --output-format=json --output="$W/$LABEL-demand.json" &
   demand_pid=$!
  fi
  first=$(now)
  mount -o ro,noload "$dev" "$W/mnt"
  cat "$W/mnt/src/m0/d0/f0.ts" >/dev/null
  echo "$LABEL hydrate=$hydrate first_file_cold_ms=$(elapsed "$first")"
  first=$(now);tar cf - -C "$W/mnt" . | cat >/dev/null
  echo "$LABEL hydrate=$hydrate full_read_ms=$(elapsed "$first")"
  umount "$W/mnt"
  if [[ $hydrate == true ]]; then
   wait "$poll";wait "$demand_pid"
   echo "$LABEL hydration_ms=$(cat "$W/$LABEL-hydration-ms")"
   python3 - "$LABEL" "$W/$LABEL-demand.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[2]))['jobs'][0];assert r['error']==0
r=r['read'];print(sys.argv[1], 'demand_during_hydration', 'mean_us=',r['lat_ns']['mean']/1000,'p99_us=',r['clat_ns']['percentile']['99.000000']/1000)
PY
  fi
  curl -sS --unix-socket "$SOCK" http://localhost/v0/stats || true
  client release --job u7
  stop_daemon
  if [[ $LABEL == before ]]; then
   python3 - "$W/daemon-$LABEL.log" <<'PY'
import re,sys
v=[int(x) for x in re.findall(r'u7_fetch bytes=(\d+)',open(sys.argv[1]).read())];print('before fetches=',len(v),'bytes=',sum(v))
PY
  fi
 done
 aws s3 ls "s3://$BUCKET/$PREFIX/$LABEL/" --recursive --summarize | tail -2
done
# Local-dir warm NBD and hydrated dm-clone over exactly the loop backing file.
LABEL=local BIN=$W/after.bin
start_daemon "$D/local-store" --packs=false
imported=$(client import-image --lineage local --name main --path "$W/large.img")
ROOT=$(field root <<< "$imported")
stop_daemon
rm -f "$D/data-$LABEL/images/$ROOT.img"
start_daemon "$D/local-store" --packs=false
mounted=$(client mount --job fio --lineage local --root "$ROOT" --hydrate=true)
dev=$(field image <<< "$mounted")
for ((i=0;i<6000;i++)); do
 status=$(client status --job fio)
 [[ $(field state <<< "$status") == hydrated ]] && break
 sleep .1
done
[[ $(field state <<< "$status") == hydrated ]]
nbd=$(field NBD <<< "$status")
# Warm every NBD chunk, including previously guest-written regions.
dd if="$nbd" of=/dev/null bs=4M status=none
source scripts/ec2-unit7-ublk.sh
ublk_table "$W/large.img" "$nbd" "$dev"
client release --job fio
stop_daemon
# Includes pack object bytes explicitly, in addition to total root storage.
aws s3 ls "s3://$BUCKET/$PREFIX/after/p/" --recursive --summarize | tail -2
python3 - "$RESULT" <<'PYTABLE'
import re,sys
s=open(sys.argv[1]).read()
print('| metric | before (unit 6) | after (unit 7) |')
print('|---|---:|---:|')
for metric,hydrate in [('first_file_cold_ms','false'),('full_read_ms','false'),('full_read_ms','true'),('hydration_ms',None)]:
 vals=[]
 for label in ['before','after']:
  pat=label+(r' hydrate='+hydrate if hydrate else '')+r'.*?'+metric+r'=(\d+)'
  m=re.search(pat,s);vals.append(m[1] if m else 'unavailable')
 print('|',metric+(' hydrate='+hydrate if hydrate else ''),'|',' | '.join(vals),'|')
PYTABLE
sync
exec >&3 2>&3
wait "$TEE_PID"
# Append once after tee has flushed preceding lines.
cat "$RESULT" >> scripts/ec2-smoke-results.txt
echo "Raw outputs retained at $W; S3 objects retained at s3://$BUCKET/$PREFIX"
