#!/usr/bin/env bash
# Root-only integration test. The caller must check /nvme/host-free first.
# Usage: sudo ./scripts/ec2-smoke.sh [clone|prehydrate]
set -euo pipefail
[[ -e /nvme/host-free ]] || { echo "units 3–5 smoke skipped: /nvme/host-free is absent"; exit 0; }
[[ $EUID == 0 ]] || { echo 'run as root' >&2; exit 1; }
MODE=${1:-clone}
[[ $MODE == clone || $MODE == prehydrate ]] || exit 2
export PATH=/usr/local/go/bin:$PATH
cd "$(dirname "$0")/.."
D=/nvme/camelfs
W=/nvme/bench/work/camelfsd-$MODE
SOCK=$D/api.sock
export GOCACHE=$PWD/.cache GOPATH=$PWD/.go TMPDIR=/tmp/camelfsd-smoke
mkdir -p "$GOCACHE" "$GOPATH" "$TMPDIR"
BIN=$PWD/camelfsd
mkdir -p "$D" "$W" "$W/mnt"
RESULT=$D/smoke-$MODE.txt
: > "$RESULT"
rec() { echo "$*" | tee -a "$RESULT"; }
now() { date +%s%N; }
elapsed() { echo $(( ($(now)-$1)/1000000 )); }
field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
assert() { python3 -c 'import json,sys; j=json.load(sys.stdin); assert eval(sys.argv[1]),j' "$1"; }
client() {
 if [[ $1 == checkpoint ]]; then
  local j=$3 status
  status=$("$BIN" client --socket "$SOCK" status --job "$j")
  mount -o loop "$(field image <<<"$status")" "$W/mnt"
  if [[ ! -f $W/$j.idx.json ]]; then
   "$BIN" testguest apply --vsock-dir "$W/$j" --job "$j" --mount "$W/mnt" --index "$W/$j.idx.json"
  fi
  "$BIN" testguest checkpoint --vsock-dir "$W/$j" --job "$j" --mount "$W/mnt" --index "$W/$j.idx.json" &
  local guest=$! result
  result=$("$BIN" client --socket "$SOCK" "$@")
  wait "$guest"
  "$BIN" testguest checkpointed --index "$W/$j.idx.json" --tree "$(field tree <<<"$result")"
  umount "$W/mnt"
  echo "$result"
 else
  if [[ $1 == mount ]]; then
   local previous= arg
   for arg in "$@"; do
    if [[ $previous == --job ]]; then rm -f "$W/$arg.idx.json" "$W/$arg.idx.pending.json";break;fi
    previous=$arg
   done
  fi
  "$BIN" client --socket "$SOCK" "$@"
 fi
}
PID=
AWAY=0
cleanup() {
  set +e
  if mountpoint -q "$W/mnt"; then umount "$W/mnt"; fi
  for j in j1 j2 j3; do client release --job "$j" >/dev/null 2>&1; done
  if [[ -n $PID ]]; then kill -TERM "$PID" 2>/dev/null; wait "$PID"; fi
  if [[ $AWAY == 1 ]]; then
    mkdir -p "$D/images"
    cp -an --reflink=always "$D/images.away/." "$D/images/"
    rm -rf "$D/images.away"
  fi
}
trap cleanup EXIT
[[ ! -e $D/images.away ]] || { echo 'images.away already exists; refusing' >&2; exit 1; }
pgrep -x camelfsd >/dev/null && { echo 'camelfsd already running; refusing' >&2; exit 1; }
go test ./...
go vet ./...
go build -o "$BIN" ./cmd/camelfsd
IMG=$W/base.img
truncate -s 0 "$IMG"; truncate -s 2048M "$IMG"
mkfs.ext4 -q -E lazy_itable_init=0,lazy_journal_init=0 -F "$IMG"
mount -o loop "$IMG" "$W/mnt"
cp -a /nvme/bench/trees/medium/. "$W/mnt/"
sync
umount "$W/mnt"
STORE=s3://camel-fs-proto-904534089871-usw2/camelfsd/$(date +%s)-$MODE
rec "mode=$MODE store=$STORE"
"$BIN" host --socket "$SOCK" --data "$D" --store "$STORE" --region us-west-2 --cold "$MODE" >"$W/host.log" 2>&1 &
PID=$!
for ((i=0;i<100;i++)); do
  if curl -fsS --unix-socket "$SOCK" http://localhost/v0/health >/dev/null 2>&1; then break; fi
  kill -0 "$PID"; sleep .1
done
T1=$(client import-tree --lineage test --dir /nvme/bench/trees/medium | field tree)
IMPORT=$(client import-image --lineage test --name main --path "$IMG" --tree "$T1")
rec "import $IMPORT"
ROOT=$(field root <<<"$IMPORT")
MOUNT=$(client mount --job j1 --lineage test --ref main --vsock "$W/j1")
assert 'j["warm"] is True and j["root"]=="'"$ROOT"'"' <<<"$MOUNT"
rec "warm_mount $MOUNT"
mount -o loop "$(field image <<<"$MOUNT")" "$W/mnt"
node /nvme/bench/gen.mjs "$W/mnt" medium change
sync; umount "$W/mnt"
CP=$(client checkpoint --job j1)
assert '1 <= j["changedChunks"] <= 40' <<<"$CP"
assert 'j["changedBytes"] < 64 * 1024 * 1024' <<<"$CP"
NEW=$(field root <<<"$CP")
[[ $NEW != "$ROOT" ]]
rec "checkpoint $CP"
J2=$(client mount --job j2 --lineage test --root "$NEW")
mount -o loop,ro,noload "$(field image <<<"$J2")" "$W/mnt"
head -1 "$W/mnt/src/m0/d0/f0.ts" | grep -q '^// file 100000'
umount "$W/mnt"
client release --job j1 >/dev/null
client release --job j2 >/dev/null
mv "$D/images" "$D/images.away"; AWAY=1
mkdir -p "$D/images"
cp --reflink=always "$D/images.away"/blank-*.img "$D/images/"
# Drop the daemon's chunk cache as well as complete images to measure real cold S3.
rm -rf "$D/cache"
COLD=$(client mount --job j3 --lineage test --ref main --hydrate --vsock "$W/j3")
if [[ $MODE == clone ]]; then
  assert 'j["warm"] is False and j["image"]=="/dev/mapper/camelfs-j3"' <<<"$COLD"
else
  assert 'j["warm"] is True' <<<"$COLD"
fi
rec "cold_mount $COLD"
DEV=$(field image <<<"$COLD")
T=$(now); mount -o loop "$DEV" "$W/mnt"
cat "$W/mnt/src/m0/d0/f0.ts" >/dev/null
rec "first_file_ms=$(elapsed "$T") (includes filesystem mount)"
T=$(now); tar cf - -C "$W/mnt" src | cat >/dev/null
rec "full_read_ms=$(elapsed "$T")"
T=$(now)
for ((i=0;i<3000;i++)); do
  STATUS=$(client status --job j3)
  STATE=$(field state <<<"$STATUS")
  [[ $STATE == hydrated || $STATE == warm ]] && break
  sleep .1
done
[[ $STATE == hydrated || $STATE == warm ]]
rec "hydration_wait_ms=$(elapsed "$T") status=$STATUS"
# A second generation of edits to exactly three files.
for i in 0 1 2; do echo '// smoke generation 2' >> "$W/mnt/src/m0/d0/f$i.ts"; done
sync; umount "$W/mnt"
CP2=$(client checkpoint --job j3)
rec "promoted_checkpoint $CP2"
RELEASE=$(client release --job j3)
assert 'j["promoted"] is True' <<<"$RELEASE"
rec "release $RELEASE"
NEW2=$(field root <<<"$CP2")
[[ -f $D/images/$NEW2.img ]]
# Verify the moved ref and exact cold-checkpoint bytes through another mount.
VERIFY=$(client mount --job j2 --lineage test --ref main)
assert 'j["warm"] is True and j["root"]=="'"$NEW2"'"' <<<"$VERIFY"
mount -o loop,ro,noload "$(field image <<<"$VERIFY")" "$W/mnt"
grep -q '^// smoke generation 2' "$W/mnt/src/m0/d0/f0.ts"
umount "$W/mnt"; client release --job j2 >/dev/null
source scripts/ec2-unit3.sh
unit3
source scripts/ec2-unit45.sh
unit45
cleanup; PID=; AWAY=0
rec 'cleanup checks:'
DM=$(dmsetup ls 2>&1); rec "$DM"
LOOPS=$(losetup -a); rec "$LOOPS"
PROCS=$(pgrep -x camelfsd || true); rec "camelfsd_pids=${PROCS:-none}"
[[ $DM != *camelfs-* && $LOOPS != *camelfsd-* && -z $PROCS ]]
# Check every kernel NBD attachment, without detaching devices owned by others.
for p in /sys/block/nbd*/pid; do [[ ! -e $p ]] || { rec "unexpected_nbd_attachment=$p"; exit 1; }; done
rec '| step | milliseconds |'
rec '|---|---:|'
for pair in "import:importMs:$IMPORT" "warm mount:mountMs:$MOUNT" "checkpoint reflink:reflinkMs:$CP" "checkpoint FIEMAP:fiemapMs:$CP" "checkpoint hash:hashMs:$CP" "checkpoint upload:uploadMs:$CP" "checkpoint total:checkpointMs:$CP" "cold mount:mountMs:$COLD" "promoted checkpoint:checkpointMs:$CP2"; do
  LABEL=${pair%%:*}; REST=${pair#*:}; KEY=${REST%%:*}; JSON=${REST#*:}
  rec "| $LABEL | $(field "$KEY" <<<"$JSON") |"
done
rec "PASS $MODE"
