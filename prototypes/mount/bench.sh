#!/usr/bin/env bash
# bench.sh [sizes] [latency]: the mount-vs-copy measurements, on one sprite (scripts/sprite-test --dirty HEAD bash
# prototypes/mount/bench.sh). Every result is one JSON line prefixed "RESULT". Needs sudo, /dev/fuse and overlayfs.
#   sizes:   comma list of small,medium,large,repo (default small,medium,large,repo)
#   latency: the fake R2's first-byte latency per request (default 20ms)
set -uo pipefail
SIZES=${1:-small,medium,large,repo} LAT=${2:-20ms}
HERE=$(cd "$(dirname "$0")" && pwd)
W=/tmp/camelfs-bench
B=$W/camelfs
S=http://127.0.0.1:9900
ME=$(id -u) MYG=$(id -g)

sudo umount -l $W/m 2>/dev/null; sudo umount -l $W/lower 2>/dev/null
sudo rm -rf --one-file-system /tmp/camelfs-bench
mkdir -p $W
(cd "$HERE" && go build -o $B .) || { echo "build failed"; exit 1; }
uname -r
$B serve -dir $W/blobd -addr 127.0.0.1:9900 -latency "$LAT" 2>$W/serve.log & SERVER=$!
trap 'kill $SERVER 2>/dev/null; sudo umount -l $W/m 2>/dev/null; sudo umount -l $W/lower 2>/dev/null' EXIT
sleep 0.5

result() { echo "RESULT $*"; }
ms() { date +%s%3N; }
drop() { sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null 2>&1 || true; }
setlat() { curl -s "$S/latency?d=$1" >/dev/null; }
MP=
# mount <manifest> <cache> [extra flags]: a FUSE view + overlay at $W/m; sets MOUNT_MS (until the first command ran)
mount_vol() {
  local name=$1 cache=$2; shift 2
  sudo rm -rf --one-file-system $W/up $W/work $W/ready $W/stats.json
  local t0; t0=$(ms)
  sudo $B mount -server $S -name "$name" -cache "$cache" -lower $W/lower -upper $W/up -work $W/work -merged $W/m \
    -uid "$ME" -gid "$MYG" -stats $W/stats.json -ready $W/ready "$@" 2>>$W/mount.log &
  MP=$!
  until [ -f $W/ready ]; do sleep 0.005; done
  ls $W/m >/dev/null   # the first command
  MOUNT_MS=$(( $(ms) - t0 ))
}
unmount_vol() { sudo kill -INT $MP; wait $MP 2>/dev/null; STATS=$(cat $W/stats.json); }

run_size() {
  local size=$1 files=$2 bytes=$3; local tree=$W/tree-$size
  if [ "$size" = repo ]; then
    # A real repo: this sprite's camelRun checkout with its node_modules (no .git, no Rust target).
    rsync -a --exclude .git --exclude target --exclude 'node_modules/.cache' ~/rt/ $tree/
  else
    $B gen -files "$files" -bytes "$bytes" -out "$tree" >/dev/null
  fi
  setlat 0
  local imp; imp=$($B import -server $S -name "$size" $tree); result "{\"size\":\"$size\",\"step\":\"import\",\"r\":$imp}"
  setlat "$LAT"
  local nfiles; nfiles=$(echo "$imp" | sed -E 's/.*"files":([0-9]+).*/\1/')

  # Baselines: today's camel-sync tar stream (each blob read in turn) and today's host-side pull (6 at a time).
  if [ "$size" = small ] || [ "$size" = medium ]; then
    rm -rf $W/copy; drop
    result "{\"size\":\"$size\",\"step\":\"tarcopy\",\"r\":$($B tarcopy -server $S -name $size -dest $W/copy)}"
  else
    result "{\"size\":\"$size\",\"step\":\"tarcopy-estimate\",\"files\":$nfiles,\"note\":\"files x latency, not run\"}"
  fi
  rm -rf $W/copy; drop
  result "{\"size\":\"$size\",\"step\":\"copy6\",\"r\":$($B copy -server $S -name $size -dest $W/copy -parallel 6)}"
  rm -rf $W/copy; drop
  result "{\"size\":\"$size\",\"step\":\"copy32\",\"r\":$($B copy -server $S -name $size -dest $W/copy -parallel 32)}"
  drop
  result "{\"size\":\"$size\",\"step\":\"native-read100\",\"r\":$($B read -dir $W/copy -pct 100)}"
  result "{\"size\":\"$size\",\"step\":\"native-read10\",\"r\":$($B read -dir $W/copy -pct 10)}"
  drop
  result "{\"size\":\"$size\",\"step\":\"native-lat\",\"r\":$($B lat -dir $W/copy -n 100)}"

  # Mount, cold cache, lazy only: first command, then 10% of files.
  local C=$W/cache-$size
  sudo rm -rf --one-file-system $C; drop
  mount_vol $size $C
  result "{\"size\":\"$size\",\"step\":\"mount-cold\",\"mountMs\":$MOUNT_MS,\"ready\":$(cat $W/ready)}"
  local t0; t0=$(ms); $B lat -dir $W/m -n 100 > $W/lat.json
  result "{\"size\":\"$size\",\"step\":\"cold-lat\",\"r\":$(cat $W/lat.json)}"
  result "{\"size\":\"$size\",\"step\":\"cold-lazy-read10\",\"r\":$($B read -dir $W/m -pct 10)}"
  unmount_vol; result "{\"size\":\"$size\",\"step\":\"cold-lazy-read10-stats\",\"s\":$STATS}"

  # Cold cache, lazy only, everything read (8 readers).
  sudo rm -rf --one-file-system $C; drop
  mount_vol $size $C
  result "{\"size\":\"$size\",\"step\":\"cold-lazy-read100\",\"mountMs\":$MOUNT_MS,\"r\":$($B read -dir $W/m -pct 100)}"
  unmount_vol; result "{\"size\":\"$size\",\"step\":\"cold-lazy-read100-stats\",\"s\":$STATS}"

  # Cold cache with 32 background fetchers walking the manifest.
  sudo rm -rf --one-file-system $C; drop
  mount_vol $size $C -prefetch 32
  result "{\"size\":\"$size\",\"step\":\"cold-prefetch-read100\",\"mountMs\":$MOUNT_MS,\"r\":$($B read -dir $W/m -pct 100)}"
  unmount_vol; result "{\"size\":\"$size\",\"step\":\"cold-prefetch-read100-stats\",\"s\":$STATS}"

  # Warm host cache (a new job on the same host), page cache dropped: passthrough and not.
  drop
  mount_vol $size $C
  result "{\"size\":\"$size\",\"step\":\"warm-read100\",\"mountMs\":$MOUNT_MS,\"r\":$($B read -dir $W/m -pct 100)}"
  result "{\"size\":\"$size\",\"step\":\"warm-read100-pagecache\",\"r\":$($B read -dir $W/m -pct 100)}"
  unmount_vol
  drop
  mount_vol $size $C -passthrough=false
  result "{\"size\":\"$size\",\"step\":\"warm-read100-nopassthrough\",\"r\":$($B read -dir $W/m -pct 100)}"
  unmount_vol
  drop
  mount_vol $size $C
  result "{\"size\":\"$size\",\"step\":\"warm-lat\",\"r\":$($B lat -dir $W/m -n 100)}"

  # A job edits 5% of files and adds 20, then commits; the commit is forked; a job on the fork reads everything with
  # the base's warm cache.
  if [ "$size" != repo ]; then
    local edited=0
    for f in $(find $W/m -type f | sort | awk 'NR % 20 == 0'); do echo edit >> "$f"; edited=$((edited+1)); done
    mkdir -p $W/m/new; for i in $(seq 20); do echo "new $i" > $W/m/new/n$i.txt; done
    unmount_vol
    result "{\"size\":\"$size\",\"step\":\"edit-job\",\"edited\":$edited,\"added\":20}"
    result "{\"size\":\"$size\",\"step\":\"commit\",\"r\":$(sudo $B commit -server $S -base $size -name $size-v2 -upper $W/up -cache $C)}"
    result "{\"size\":\"$size\",\"step\":\"fork\",\"r\":$($B fork -server $S -base $size-v2 -name $size-fork)}"
    drop
    mount_vol $size-fork $C
    result "{\"size\":\"$size\",\"step\":\"fork-warm-read100\",\"mountMs\":$MOUNT_MS,\"r\":$($B read -dir $W/m -pct 100)}"
    unmount_vol; result "{\"size\":\"$size\",\"step\":\"fork-warm-read100-stats\",\"s\":$STATS}"
  else
    unmount_vol
    repo_workload
  fi
  rm -rf $W/copy $tree
}

# A real workload on the real repo: tsc over the main project (reads sources and node_modules types), natively on a
# copy and through the mount, cold and warm.
repo_workload() {
  local C=$W/cache-repo cmd="node_modules/.bin/tsc -p tsconfig.json --noEmit"
  rm -rf $W/copy; $B copy -server $S -name repo -dest $W/copy -parallel 32 >/dev/null; drop
  local t0; t0=$(ms); (cd $W/copy && $cmd >/dev/null 2>&1); local rc=$?
  result "{\"size\":\"repo\",\"step\":\"tsc-native\",\"ms\":$(( $(ms) - t0 )),\"exit\":$rc}"
  for mode in cold-lazy cold-prefetch warm; do
    [ $mode = warm ] || sudo rm -rf --one-file-system $C
    drop
    if [ $mode = cold-prefetch ]; then mount_vol repo $C -prefetch 32; else mount_vol repo $C; fi
    t0=$(ms); (cd $W/m && $cmd >/dev/null 2>&1); rc=$?
    local took=$(( $(ms) - t0 ))
    unmount_vol
    result "{\"size\":\"repo\",\"step\":\"tsc-$mode\",\"mountMs\":$MOUNT_MS,\"ms\":$took,\"exit\":$rc,\"s\":$STATS}"
  done
}

IFS=, read -ra list <<<"$SIZES"
for s in "${list[@]}"; do
  case $s in
    small) run_size small 200 1048576 ;;
    medium) run_size medium 5000 52428800 ;;
    large) run_size large 50000 524288000 ;;
    repo) run_size repo 0 0 ;;
  esac
done
result "{\"step\":\"server\",\"r\":$(curl -s $S/stats)}"
