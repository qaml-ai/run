#!/usr/bin/env bash
# Reviewer only. Isolated unit-8 format measurement; never use shared daemon data.
set -euo pipefail
[[ -e /nvme/host-free ]] || { echo 'unit 8: skipped (no reviewer host slot)'; exit 0; }
[[ $EUID == 0 ]] || { echo 'run as root in the reviewer slot' >&2; exit 1; }
cd "$(dirname "$0")/.."
D=/nvme/camelfs-u8
[[ ! -e $D ]] || { echo "$D exists; inspect prior results first" >&2; exit 1; }
mkdir -p "$D/work/mnt" "$D/data"
W=$D/work SOCK=$D/api.sock BIN=$D/work/camelfsd
BUCKET=${BUCKET:-camel-fs-proto-904534089871-usw2}
PREFIX=camelfsd/u8-$(date -u +%Y%m%dT%H%M%SZ)
STORE=s3://$BUCKET/$PREFIX/root
PID=
cleanup() {
 mountpoint -q "$W/mnt" && umount "$W/mnt" || true
 if [[ -n $PID ]]; then kill -TERM "$PID"; wait "$PID" || true; fi
}
trap cleanup EXIT
exec 3>&1
exec > >(tee "$W/results.txt") 2>&1
TEE_PID=$!
now() { date +%s%N; }
elapsed() { echo $(( ($(now)-$1)/1000000 )); }
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
client() { "$BIN" client --socket "$SOCK" "$@"; }
stats() { curl -fsS --unix-socket "$SOCK" http://localhost/v0/stats; }
start() {
 "$BIN" host --data "$D/data" --socket "$SOCK" --nbd-listen 127.0.0.1:10812 --store "$STORE" --fetch-depth 64 > "$W/daemon.log" 2>&1 &
 PID=$!
 for ((i=0;i<200;i++)); do curl -fsS --unix-socket "$SOCK" http://localhost/v0/health >/dev/null 2>&1 && return; kill -0 "$PID";sleep .1;done
 return 1
}
stop() { kill -TERM "$PID";wait "$PID";PID=; }
inventory() { aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/root/" --output json > "$W/$1.json"; }
# Only build this checkout. This script never switches branches or modifies prototypes.
go build -o "$BIN" ./cmd/camelfsd
REPO=$(git rev-parse --show-toplevel)
mkdir "$W/s3speed"
git -C "$REPO" archive origin/proto/s3speed prototypes/s3speed | tar -xf - -C "$W/s3speed"
(cd "$W/s3speed/prototypes/s3speed" && go build -o "$W/s3speed.bin" .)
"$W/s3speed.bin" upload --bucket "$BUCKET" --prefix "$PREFIX/speed" --chunks 4096 --layouts pack4m --concurrency 64
"$W/s3speed.bin" fetch --bucket "$BUCKET" --prefix "$PREFIX/speed" --chunks 4096 --mode pack4m --concurrency 64 --out "$W/nic.img" --csv-header > "$W/nic.csv"
truncate -s 4G "$W/large.img"
mkfs.ext4 -q -E lazy_itable_init=0,lazy_journal_init=0 -F "$W/large.img"
mount -o loop "$W/large.img" "$W/mnt"
cp -a /nvme/bench/trees/large/. "$W/mnt/"
sync;umount "$W/mnt"
echo '## unit 8'
start
imp=$(client import-image --lineage large --name main --path "$W/large.img")
echo "import=$imp"
ROOT=$(field root <<< "$imp")
inventory import
python3 - "$W/import.json" "$imp" <<'PY'
import json,sys
objects=json.load(open(sys.argv[1])).get('Contents',[]);imp=json.loads(sys.argv[2])
packs=[o for o in objects if '/p/' in o['Key']];chunks=[o for o in objects if '/c/' in o['Key']]
n=sum(o['Size'] for o in packs);expected=imp['chunks']*262144
assert not chunks, chunks
# Repeated chunk hashes may reduce bytes below the non-hole image count.
assert 0<n<=expected and n==imp['packBytes'], (n,expected,imp)
print(f'import pack_count={len(packs)} s3_pack_bytes={n} nonhole_image_bytes={expected} ratio={n/expected:.4f} c_objects=0')
PY
stop
# Separate daemon processes ensure trusted cache entries never outlive deleted files.
for mode in first full hydrate; do
 rm -rf "$D/data/cache"
 rm -f "$D/data/images/$ROOT.img"
 start
 hydrate=false;[[ $mode != hydrate ]] || hydrate=true
 started=$(now)
 mounted=$(client mount --job u8 --lineage large --root "$ROOT" --hydrate="$hydrate")
 dev=$(field image <<< "$mounted")
 if [[ $mode == hydrate ]]; then
  for ((i=0;i<6000;i++)); do
   status=$(client status --job u8);[[ $(field state <<< "$status") == hydrated ]] && break;sleep .1
  done
  [[ $(field state <<< "$status") == hydrated ]]
  ms=$(elapsed "$started")
  python3 - "$W/nic.csv" "$ms" "$imp" <<'PY'
import csv,json,sys
nic=float(list(csv.DictReader(open(sys.argv[1])))[-1]['mb_per_s']);ms=int(sys.argv[2]);n=json.loads(sys.argv[3])['packBytes'];rate=n/1e6/(ms/1000)
print(f'hydration_ms={ms} hydration_mb_s={rate:.2f} nic_ceiling_mb_s={nic:.2f} fraction={rate/nic:.3f}')
PY
 else
  started=$(now);mount -o ro,noload "$dev" "$W/mnt"
  if [[ $mode == first ]]; then cat "$W/mnt/src/m0/d0/f0.ts" >/dev/null;else tar cf - -C "$W/mnt" . | cat >/dev/null;fi
  echo "cold_$mode contents_ms=$(elapsed "$started")";umount "$W/mnt"
 fi
 echo "$mode stats=$(stats)"
 client release --job u8;stop
done
# A ref mount permits checkpoint. Freeze by unmounting before the POST.
start
mounted=$(client mount --job edit --lineage large --ref main --hydrate=true)
dev=$(field image <<< "$mounted")
for ((i=0;i<6000;i++)); do status=$(client status --job edit);[[ $(field state <<< "$status") == hydrated ]] && break;sleep .1;done
[[ $(field state <<< "$status") == hydrated ]]
mount "$dev" "$W/mnt"
for i in 0 1 2; do printf 'unit8 edit %s\n' "$i" >> "$W/mnt/src/m0/d0/f$i.ts";done
sync;umount "$W/mnt"
inventory before-checkpoint
cp=$(client checkpoint --job edit)
echo "three_file_checkpoint=$cp"
inventory after-checkpoint
python3 - "$W/before-checkpoint.json" "$W/after-checkpoint.json" "$cp" <<'PY'
import json,sys
before={o['Key'] for o in json.load(open(sys.argv[1])).get('Contents',[])}
new=[o for o in json.load(open(sys.argv[2])).get('Contents',[]) if '/p/' in o['Key'] and o['Key'] not in before]
cp=json.loads(sys.argv[3]);n=sum(o['Size'] for o in new)
assert len(new)==1,(new,cp)
assert n==cp['uploadedChunks']*262144,(n,cp)
print(f'checkpoint pack_count=1 pack_bytes={n} uploaded_chunks={cp["uploadedChunks"]} target_approx_bytes={7*262144}')
PY
client release --job edit;stop
sync
exec >&3 2>&3
wait "$TEE_PID"
cat "$W/results.txt" >> scripts/ec2-smoke-results.txt
echo "unit 8 raw outputs: $W; objects retained: s3://$BUCKET/$PREFIX"
