#!/usr/bin/env bash
# The runnable slice: lazy NBD device over a latency-injected chunk store -> dm-thin (external origin) -> ext4,
# forks as thin snapshots, checkpoints from thin metadata, a file index with extents, a Workers-style read.
#   sudo bash run.sh <small|medium|large> [latency]      (run on a box with CAP_SYS_ADMIN; see RESULTS.md)
set -euo pipefail
pgrep -x systemd-udevd >/dev/null || export DM_DISABLE_UDEV=1   # no udev on a sprite: dmsetup makes the /dev/mapper nodes itself
SIZE=${1:-small}; LAT=${2:-15ms}
B=${BENCH_DIR:-/bench}; T=$B/trees/$SIZE; BIN=$B/lazyblk; NODE=$(command -v node)
PORT=9000; STORE=${STORE:-http://127.0.0.1:$PORT}; CACHE=$B/cache; NBD=/dev/nbd1
CLONE=${CLONE:-0}   # 1: NBD -> dm-clone (hydrates into an NVMe file) -> thin; needs the dm-clone module
M=$B/mnt
case $SIZE in small) IMG_MB=1024;; medium) IMG_MB=2048;; large) IMG_MB=4096;; esac
log() { printf '\n== %s\n' "$*"; }
ms() { local t0=$1; echo $(( ($(date +%s%N) - t0) / 1000000 )); }
now() { date +%s%N; }
stats() { case $STORE in s3://*) echo s3;; *) curl -s $STORE/stats;; esac; }
devstats() { curl -s 127.0.0.1:9100/ 2>/dev/null || true; }
drop() { sync; echo 3 > /proc/sys/vm/drop_caches; }
die() { echo "FAIL: $*" >&2; exit 1; }
mnt() { mount "$@" && mountpoint -q "${@: -1}" || die "mount $*"; }
R="$B/results-$SIZE.txt"; : > "$R"
rec() { echo "$*" | tee -a "$R"; }

cleanup() {
  set +e
  for m in $M/v0 $M/f2 $M/local $M/fuse $M/fusept; do mountpoint -q $m && umount $m; done
  for d in fork2 snap1 snapB vol0; do dmsetup remove $d 2>/dev/null; done
  dmsetup remove pool 2>/dev/null; dmsetup remove clone0 2>/dev/null; dmsetup remove_all 2>/dev/null
  nbd-client -d $NBD 2>/dev/null
  pkill -x lazyblk 2>/dev/null; pkill -x fuse-loop 2>/dev/null
  losetup -D 2>/dev/null
}
trap cleanup EXIT
cleanup
sleep 0.5
rm -rf $B/store $CACHE $B/work; case $STORE in s3://*) STORE=$STORE/$(date +%s);; esac; mkdir -p $B/store $CACHE $B/work $M/v0 $M/f2 $M/local $M/fuse $M/fusept

[ -d $T ] || { log "generating $SIZE tree"; mkdir -p $T; $NODE $B/gen.mjs $T $SIZE; }
FILES=$(find $T -type f | wc -l); rec "size=$SIZE files=$FILES bytes=$(du -sb $T | cut -f1) latency=$LAT"

log "base image (ext4, $IMG_MB MiB)"
IMG=$B/work/base.img; rm -f $IMG; truncate -s ${IMG_MB}M $IMG
mkfs.ext4 -q -E lazy_itable_init=0,lazy_journal_init=0 -F $IMG
mnt -o loop $IMG $M/local; t0=$(now); cp -a $T/. $M/local/; sync; rec "cp_tree_into_ext4_ms=$(ms $t0)"; umount $M/local

log "store + import"
case $STORE in s3://*) rec "store=$STORE (real S3, instance role)";; *) $BIN store --dir $B/store --listen 127.0.0.1:$PORT --latency $LAT 2>$B/work/store.log & sleep 0.3;; esac
t0=$(now); ROOT=$($BIN import --from $IMG --store $STORE 2>$B/work/import.log); rec "import_ms=$(ms $t0) $(cat $B/work/import.log)"; [ -n "$ROOT" ] || die import
case $STORE in s3://*) ;; *) rec "store_bytes=$(du -sb $B/store/chunk | cut -f1) store_objects=$(ls $B/store/chunk | wc -l)";; esac

log "lazy device (cold cache) + thin pool + ext4"
$BIN serve --root $ROOT --store $STORE --cache $CACHE --listen 127.0.0.1:10809 --stats 127.0.0.1:9100 2>$B/work/serve.log & sleep 0.3
nbd-client -N x 127.0.0.1 10809 $NBD -C 4 >/dev/null
SECT=$(blockdev --getsz $NBD)
ORIGIN=$NBD
if [ "$CLONE" = 1 ]; then
  truncate -s $((SECT*512)) $B/work/clone-dest.img; dd if=/dev/zero of=$B/work/clone-meta.img bs=1M count=64 2>/dev/null
  CD=$(losetup -f --show $B/work/clone-dest.img); CM=$(losetup -f --show $B/work/clone-meta.img)
  dmsetup create clone0 --table "0 $SECT clone $CM $CD $NBD 512 1 no_hydration"
  ORIGIN=/dev/mapper/clone0; rec "dm-clone: origin $NBD -> dest $CD (256 KiB regions, hydration off until asked)"
fi
truncate -s 20G $B/work/pool-data.img; truncate -s 256M $B/work/pool-meta.img
LD=$(losetup -f --show $B/work/pool-data.img); LM=$(losetup -f --show $B/work/pool-meta.img)
dmsetup create pool --table "0 $(blockdev --getsz $LD) thin-pool $LM $LD 512 0 1 skip_block_zeroing"
dmsetup message /dev/mapper/pool 0 "create_thin 0"
dmsetup create vol0 --table "0 $SECT thin /dev/mapper/pool 0 $ORIGIN"
G0=$(stats)
t0=$(now); mnt /dev/mapper/vol0 $M/v0; rec "mount_cold_ms=$(ms $t0)"
t0=$(now); cat $M/v0/src/m0/d0/f0.ts >/dev/null; rec "first_file_cold_ms=$(ms $t0) (mount+first file) store_before=$G0 store_after=$(stats)"
t0=$(now); ls -R $M/v0/src >/dev/null; rec "ls_R_cold_ms=$(ms $t0)"
t0=$(now); tar cf - -C $M/v0 src | cat >/dev/null; rec "full_read_cold_ms=$(ms $t0) store=$(stats) dev=$(devstats)"
drop; t0=$(now); tar cf - -C $M/v0 src | cat >/dev/null; rec "full_read_warm_cache_ms=$(ms $t0) (page cache dropped, chunk cache warm)"
t0=$(now); tar cf - -C $M/v0 src | cat >/dev/null; rec "full_read_pagecache_ms=$(ms $t0)"
drop; t0=$(now); grep -r "function" $M/v0/src | wc -l >/dev/null; rec "grep_r_warm_cache_ms=$(ms $t0)"
if [ "$CLONE" = 1 ]; then
  t0=$(now); dmsetup message clone0 0 enable_hydration; dmsetup message clone0 0 hydration_batch_size 64; dmsetup message clone0 0 hydration_threshold 64
  until [ "$(dmsetup status clone0 | awk '{print $7}' | cut -d/ -f1)" = "$(dmsetup status clone0 | awk '{print $7}' | cut -d/ -f2)" ]; do sleep 0.2; done
  rec "clone_hydrate_full_ms=$(ms $t0) status=$(dmsetup status clone0 | cut -c1-80)"
  drop; t0=$(now); tar cf - -C $M/v0 src | cat >/dev/null; rec "full_read_hydrated_ms=$(ms $t0) (page cache dropped, dm-clone fully hydrated: no userspace in the read path)"
  drop; t0=$(now); grep -r "function" $M/v0/src | wc -l >/dev/null; rec "grep_r_hydrated_ms=$(ms $t0)"
  drop; t0=$(now); ls -R $M/v0/src >/dev/null; rec "ls_R_hydrated_ms=$(ms $t0)"
fi

log "local ext4 baseline (loop on the same disk)"
mnt -o loop $IMG $M/local
drop; t0=$(now); tar cf - -C $M/local src | cat >/dev/null; rec "local_full_read_cold_ms=$(ms $t0)"
t0=$(now); tar cf - -C $M/local src | cat >/dev/null; rec "local_full_read_pagecache_ms=$(ms $t0)"
drop; t0=$(now); grep -r "function" $M/local/src | wc -l >/dev/null; rec "local_grep_r_cold_ms=$(ms $t0)"

log "small change (f0,f1,f2) -> checkpoint A (freeze, thin snap, thin_dump, hash+upload)"
$NODE $B/gen.mjs $M/v0 $SIZE change; sync
t0=$(now); dmsetup suspend vol0; dmsetup message /dev/mapper/pool 0 "create_snap 1 0"; dmsetup resume vol0; dmsetup create snap1 --table "0 $SECT thin /dev/mapper/pool 1 $ORIGIN"; rec "snapshot_ms=$(ms $t0)"
t0=$(now); dmsetup message /dev/mapper/pool 0 reserve_metadata_snap; thin_dump -m --dev-id 1 $LM > $B/work/dump1.xml; dmsetup message /dev/mapper/pool 0 release_metadata_snap; rec "thin_dump_ms=$(ms $t0) mapped=$(grep -c mapping $B/work/dump1.xml)"
t0=$(now); ROOT2=$($BIN checkpoint --dev /dev/mapper/snap1 --base $ROOT --mapped $B/work/dump1.xml --store $STORE 2>$B/work/ck1.log); rec "checkpoint_A_ms=$(ms $t0) $(cat $B/work/ck1.log)"
$BIN fetch --store $STORE root $ROOT > $B/work/root1.bin; $BIN fetch --store $STORE root $ROOT2 > $B/work/root2.bin
rec "diff_blocks: $($BIN diff $B/work/root1.bin $B/work/root2.bin)"

log "file index (the Workers view): full, then incremental after the change"
t0=$(now); $BIN index --mount $M/v0 --out $B/work/idx1.json --root $ROOT2 2>$B/work/idx1.log; rec "index_full_ms=$(ms $t0) $(cat $B/work/idx1.log) bytes=$(stat -c %s $B/work/idx1.json)"
echo "// touched" >> $M/v0/src/m0/d0/f3.ts; sync
t0=$(now); $BIN index --mount $M/v0 --prev $B/work/idx1.json --out $B/work/idx2.json --root $ROOT2 2>$B/work/idx2.log; rec "index_incremental_ms=$(ms $t0) $(cat $B/work/idx2.log)"
rec "diff_files: $($BIN diff $B/work/idx1.json $B/work/idx2.json)"
t0=$(now); $BIN read --index $B/work/idx1.json --store $STORE src/m0/d0/f0.ts src/m1/d60/f3000.ts 2>&1 | sed "s/^/  /" | tee -a $R; rec "worker_read_2files_ms=$(ms $t0) (chunks straight from the store, no mount)"

log "fork: thin snapshot of the checkpoint, mounted beside the original"
t0=$(now); dmsetup message /dev/mapper/pool 0 "create_snap 2 1"; dmsetup create fork2 --table "0 $SECT thin /dev/mapper/pool 2 $ORIGIN"; rec "fork_create_ms=$(ms $t0)"
t0=$(now); if mount /dev/mapper/fork2 $M/f2 2>/dev/null; then rec "fork_mount_ms=$(ms $t0) (same UUID accepted)"; else tune2fs -U random /dev/mapper/fork2 >/dev/null 2>&1; mnt /dev/mapper/fork2 $M/f2; rec "fork_mount_ms=$(ms $t0) (ext4 refused the duplicate UUID; tune2fs -U random on the fork, then mount)"; fi
if mountpoint -q $M/f2; then
  t0=$(now); cat $M/f2/src/m0/d0/f0.ts >/dev/null; rec "fork_first_file_ms=$(ms $t0)"
  echo fork-only > $M/f2/FORK; sync; [ -e $M/v0/FORK ] && rec "ISOLATION BROKEN" || rec "fork_isolated=yes"
  head -c 40 $M/f2/src/m0/d0/f0.ts | tr -d "\n" | sed "s/^/  f0 in fork: /"; echo
fi

log "build-ish workload: git init+add+commit (hash every file, write objects)"
for m in $M/local $M/v0; do
  rm -rf $m/.git; t0=$(now); (cd $m && git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -q -m x); sync; rec "git_add_commit_ms[$m]=$(ms $t0)"
done
rec "thin_status_after_git=$(dmsetup status pool)"

log "checkpoint B after the git workload (bigger delta)"
t0=$(now); dmsetup suspend vol0; dmsetup message /dev/mapper/pool 0 "create_snap 3 0"; dmsetup resume vol0; dmsetup create snapB --table "0 $SECT thin /dev/mapper/pool 3 $ORIGIN"
dmsetup message /dev/mapper/pool 0 reserve_metadata_snap; thin_dump -m --dev-id 3 $LM > $B/work/dumpB.xml; dmsetup message /dev/mapper/pool 0 release_metadata_snap
ROOT3=$($BIN checkpoint --dev /dev/mapper/snapB --base $ROOT2 --mapped $B/work/dumpB.xml --store $STORE 2>$B/work/ckB.log); rec "checkpoint_B_ms=$(ms $t0) $(cat $B/work/ckB.log)"

log "per-op latency: local ext4 | nbd+thin ext4 | FUSE loopback | FUSE passthrough"
N=2000
rec "--- local ext4"; $BIN fsbench $M/local/fsb $N 2>/dev/null | tee -a $R
rec "--- nbd-thin ext4"; $BIN fsbench $M/v0/fsb $N 2>/dev/null | tee -a $R
if [ -x $B/fuse-loop ]; then
  $B/fuse-loop -passthrough=false $M/local $M/fuse 2>$B/work/fuse.log & sleep 0.7; mountpoint -q $M/fuse || die fuse-mount
  rec "--- FUSE loopback (go-fuse, no passthrough)"; $BIN fsbench $M/fuse/fsb $N 2>/dev/null | tee -a $R
  drop; t0=$(now); tar cf - -C $M/fuse src | cat >/dev/null; rec "fuse_full_read_cold_ms=$(ms $t0)"
  t0=$(now); tar cf - -C $M/fuse src | cat >/dev/null; rec "fuse_full_read_pagecache_ms=$(ms $t0)"
  umount $M/fuse
  $B/fuse-loop -passthrough=true $M/local $M/fusept 2>$B/work/fusept.log & sleep 0.7; mountpoint -q $M/fusept || die fusept-mount
  rec "--- FUSE passthrough (go-fuse, kernel 6.9+ passthrough)"; $BIN fsbench $M/fusept/fsb $N 2>/dev/null | tee -a $R
  drop; t0=$(now); tar cf - -C $M/fusept src | cat >/dev/null; rec "fusept_full_read_cold_ms=$(ms $t0)"
  t0=$(now); tar cf - -C $M/fusept src | cat >/dev/null; rec "fusept_full_read_pagecache_ms=$(ms $t0)"
  umount $M/fusept
fi
log "raw 4 KiB random reads, QD1 and QD16, direct, 5 s: local loop vs NBD lazy device (chunk cache warm)"
LB=$(losetup -f --show $IMG)
for qd in 1 16; do for d in $LB $NBD; do
  fio --name=r --filename=$d --rw=randread --bs=4k --iodepth=$qd --direct=1 --runtime=5 --time_based --ioengine=libaio --size=${IMG_MB}M --output-format=json 2>/dev/null \
    | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).jobs[0].read;console.log(`fio_randread_4k_qd'$qd'['$d']: iops=${Math.round(j.iops)} clat_mean_us=${(j.clat_ns.mean/1000).toFixed(1)} p99_us=${(j.clat_ns.percentile["99.000000"]/1000).toFixed(1)}`)})' | tee -a $R
done; done
losetup -d $LB
rec "final store=$(stats) dev=$(devstats) cache_bytes=$(du -sb $CACHE | cut -f1)"
log "done: $R"
