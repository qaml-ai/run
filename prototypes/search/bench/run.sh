#!/usr/bin/env bash
# run.sh [corpora]: every measurement in RESULTS.md, on one sprite:
#   scripts/sprite-test --dirty HEAD bash prototypes/search/bench/run.sh gen,k8s,linux
# corpora: gen (the sibling prototypes' 200/5k/50k trees), k8s (kubernetes), linux (torvalds/linux). Each result is one
# JSON line prefixed "RESULT". Clones are kept in ~/corpora between runs; everything else is rebuilt.
set -uo pipefail
CORPORA=${1:-gen,k8s,linux}
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=${SEARCH_BENCH_DIR:-$HOME/search-bench} C=${CORPORA_DIR:-$HOME/corpora}
mkdir -p "$W" "$C"
result() { echo "RESULT $*"; }
now() { date +%s%N; }
msince() { echo $(( ($(now) - $1) / 1000000 )); }
drop() { sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null 2>&1 || true; }
export GIT_AUTHOR_NAME=bench GIT_AUTHOR_EMAIL=bench@x GIT_COMMITTER_NAME=bench GIT_COMMITTER_EMAIL=bench@x

command -v go >/dev/null || { echo "Go is required; install Go before running this benchmark." >&2; exit 1; }
command -v rg >/dev/null || sudo apt-get install -y -q ripgrep >/dev/null 2>&1
if [ -n "${S3_URI:-}" ]; then
  command -v aws >/dev/null || { echo "S3_URI requires the AWS CLI." >&2; exit 1; }
  [[ $S3_URI == s3://?*/* ]] || { echo "S3_URI must name an S3 bucket and prefix." >&2; exit 1; }
fi
command -v rg >/dev/null || { echo "no ripgrep"; exit 1; }
(cd "$HERE" && go build -o "$W/cs" .) || exit 1
(cd "$HERE/bench/camelfs" && go build -o "$W/camelfs" .) || exit 1
CS="$W/cs"
result "{\"step\":\"host\",\"cpus\":$(nproc),\"memGB\":$(free -g | awk '/Mem/{print $2}'),\"kernel\":\"$(uname -r)\",\"rg\":\"$(rg --version | head -1)\",\"git\":\"$(git --version)\"}"

sizes() { # <store> <label>: bytes by kind
  local s=$1
  local idx dat paths
  idx=$(find "$s/shards" -name '*.idx' -printf '%s\n' | awk '{t+=$1} END{print t+0}')
  dat=$(find "$s/shards" -name '*.dat' -printf '%s\n' | awk '{t+=$1} END{print t+0}')
  paths=$(find "$s/paths" -type f -printf '%s\n' | awk '{t+=$1} END{print t+0}')
  result "{\"corpus\":\"$CORPUS\",\"step\":\"sizes-$2\",\"idx\":$idx,\"dat\":$dat,\"paths\":$paths}"
}

edit_commit() { # <repo> <n> <glob> <msg>: append a line to n tracked files, commit; prints the new commit
  local r=$1 n=$2 g=$3
  git -C "$r" ls-files -- "$g" | shuf -n "$n" --random-source=<(yes "$4") | while read -r f; do echo "// bench edit $4 $RANDOM" >> "$r/$f"; done
  git -C "$r" commit -qam "$4" && git -C "$r" rev-parse HEAD
}

index() { # <label> <args...>: time a camelsearch index call, print its stats
  local label=$1; shift
  local t0 out; t0=$(now)
  out=$("$CS" index "$@") || { echo "index failed: $label"; return 1; }
  result "{\"corpus\":\"$CORPUS\",\"step\":\"index-$label\",\"wallMs\":$(msince $t0),\"r\":$out}"
}

# rg over a cold lazy mount (proto/mount's camelfs, 20 ms per blob fetch from its fake R2), lazy and with prefetch.
lazy_rg() { # <tree> <pattern>
  local tree=$1 pat=$2 S=http://127.0.0.1:9900 M=${LAZY_MOUNT_DIR:-/tmp/search-mnt}  # overlayfs needs upper/work off the overlay root
  sudo umount -l "$M/m" 2>/dev/null; sudo umount -l "$M/lower" 2>/dev/null; sudo rm -rf --one-file-system "$M"; mkdir -p "$M"
  "$W/camelfs" serve -dir "$M/blobd" -addr 127.0.0.1:9900 -latency 0ms 2>"$M/serve.log" & local SV=$!
  sleep 0.5
  "$W/camelfs" import -server "$S" -name t "$tree" >/dev/null
  curl -s "$S/latency?d=20ms" >/dev/null
  for mode in lazy prefetch32 warmcache; do
    [ $mode = warmcache ] || sudo rm -rf --one-file-system "$M/cache"
    sudo rm -rf --one-file-system "$M/up" "$M/work" "$M/ready"; drop
    local extra=""; [ $mode = prefetch32 ] && extra="-prefetch 32"
    local t0; t0=$(now)
    sudo "$W/camelfs" mount -server "$S" -name t -cache "$M/cache" -lower "$M/lower" -upper "$M/up" -work "$M/work" -merged "$M/m" \
      -uid $(id -u) -gid $(id -g) -stats "$M/stats.json" -ready "$M/ready" $extra 2>>"$M/mount.log" & local MP=$!
    until [ -f "$M/ready" ]; do sleep 0.01; kill -0 $MP 2>/dev/null || { echo "mount failed: $(tail -n 3 "$M/mount.log")"; break; }; done
    [ -f "$M/ready" ] || continue
    local t1; t1=$(now)
    local files; files=$(rg --no-ignore --hidden -l -F -e "$pat" "$M/m" | wc -l)
    result "{\"corpus\":\"$CORPUS\",\"step\":\"rg-mount-$mode\",\"q\":\"$pat\",\"mountMs\":$(( (t1 - t0) / 1000000 )),\"rgMs\":$(msince $t1),\"files\":$files}"
    sudo kill -INT $MP; wait $MP 2>/dev/null
  done
  kill $SV 2>/dev/null; wait $SV 2>/dev/null
}

# Each repetition starts a fresh process after dropping the page cache.
cold_query() { # <step> <store> <pattern> [-n repeats]
  local step=$1 store=$2 lit=$3 repeats=3
  shift 3
  if [ "${1:-}" = -n ]; then repeats=$2; fi
  local i t0 r
  for ((i=1; i<=repeats; i++)); do
    drop; t0=$(now)
    r=$("$CS" search -store "$store" -snap base -limit 20 "$lit") || return 1
    result "$(python3 -I -c 'import json,sys; d=json.loads(sys.argv[5]); print(json.dumps({"corpus":sys.argv[1],"step":sys.argv[2],"run":int(sys.argv[3]),"wallMs":int(sys.argv[4]),"openMs":d["openMs"],"searchMs":d["result"]["stats"]["ms"]}))' "$CORPUS" "$step" "$i" "$(msince "$t0")" "$r")"
  done
}

s3_cold() ( # Subshell trap restores the original shards even if a transfer/query fails.
  local store=$1 lit=$2 t0 bytes
  bytes=$(find "$store/shards" -type f -printf '%s\n' | awk '{t+=$1} END{print t+0}')
  t0=$(now)
  aws s3 sync "$store/shards/" "${S3_URI%/}/$CORPUS/shards/" --only-show-errors || exit 1
  result "{\"corpus\":\"$CORPUS\",\"step\":\"s3-upload\",\"bytes\":$bytes,\"ms\":$(msince "$t0")}"
  mv "$store/shards" "$store/shards-local" || exit 1
  trap 'rm -rf -- "$store/shards"; mv "$store/shards-local" "$store/shards"' EXIT
  mkdir -p "$store/shards"; drop; t0=$(now)
  aws s3 sync "${S3_URI%/}/$CORPUS/shards/" "$store/shards/" --only-show-errors || exit 1
  result "{\"corpus\":\"$CORPUS\",\"step\":\"s3-download\",\"bytes\":$bytes,\"ms\":$(msince "$t0")}"
  cold_query s3-cold-first-query "$store" "$lit" -n 3
)

corpus() ( # <name> <repo> <glob for edits> <queries> <lazy pattern|->
  CORPUS=$1; local R=$2 G=$3 Q="$HERE/bench/$4" LP=$5
  local S="$W/store-$CORPUS"
  if [ -n "${S3_URI:-}" ]; then
    trap 'status=$?; aws s3 rm --recursive "${S3_URI%/}/$CORPUS/" --only-show-errors || status=1; exit "$status"' EXIT
  fi
  rm -rf "$S"
  git -C "$R" rev-parse -q --verify bench-base >/dev/null || git -C "$R" branch -f bench-base HEAD
  git -C "$R" checkout -q -f --detach bench-base
  local base; base=$(git -C "$R" rev-parse HEAD)
  local files bytes; files=$(git -C "$R" ls-files | wc -l); bytes=$(git -C "$R" ls-tree -r -l HEAD | awk '{t+=$4} END{print t}')
  result "{\"corpus\":\"$CORPUS\",\"step\":\"corpus\",\"files\":$files,\"bytes\":$bytes,\"commit\":\"$base\"}"

  # Base build, page cache cold for the git objects.
  drop; index base -store "$S" -repo "$R" -commit $base -ref base || return 1
  sizes "$S" base

  local lit; lit=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[1]['q'])" "$Q")
  if [ -n "${S3_URI:-}" ]; then
    s3_cold "$S" "$lit" || return 1
  fi

  # Queries: in-process latency over the warm index; then a cold first query (new process, page cache dropped).
  "$CS" bench -store "$S" -snap base -queries "$Q" -n 20 | sed "s/^/RESULT {\"corpus\":\"$CORPUS\",\"r\":/; s/\$/}/"
  cold_query cold-first-query "$S" "$lit" -n 3 || return 1
  # Ranking: the top five files for a few queries.
  python3 -I -c "import json,sys; [print(q['q']) for q in json.load(open(sys.argv[1])) if q.get('q') and not q.get('regex')][:3]" "$Q" | head -3 | while read -r rq; do
    result "{\"corpus\":\"$CORPUS\",\"step\":\"top5\",\"r\":$("$CS" search -store "$S" -snap base -limit 5 "$rq" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"q": sys.argv[1], "top": [f["path"] for f in d["result"]["files"]]}))' "$rq")}"
  done

  # The HTTP tool surface: a few queries through the service, timed by curl.
  "$CS" serve -store "$S" -addr 127.0.0.1:7700 2>/dev/null & local SP=$!
  sleep 0.5; curl -s "http://127.0.0.1:7700/v1/snapshots/base/search?q=x" >/dev/null
  for i in 1 2 3; do
    local tt; tt=$(curl -s -o /dev/null -w '%{time_total}' --get "http://127.0.0.1:7700/v1/snapshots/base/search" --data-urlencode "q=$lit" --data "limit=20&context=2")
    result "{\"corpus\":\"$CORPUS\",\"step\":\"http-search\",\"q\":\"$lit\",\"s\":$tt}"
  done
  kill $SP; wait $SP 2>/dev/null

  # Incremental: a 1-file checkpoint, a 100-file checkpoint on top, a fork (a ref), a 1-file change on the fork.
  local c1 c100 cf
  c1=$(edit_commit "$R" 1 "$G" one); index 1file -store "$S" -repo "$R" -commit $c1 -parent base -ref v1
  c100=$(edit_commit "$R" 100 "$G" hundred); index 100files -store "$S" -repo "$R" -commit $c100 -parent v1 -ref v2
  t0=$(now); r=$("$CS" fork -store "$S" -from v2 -name fork1)
  result "{\"corpus\":\"$CORPUS\",\"step\":\"fork\",\"wallMs\":$(msince $t0),\"r\":$r}"
  cf=$(edit_commit "$R" 1 "$G" forkedit); index fork-1file -store "$S" -repo "$R" -commit $cf -parent fork1 -ref fork1
  "$CS" bench -store "$S" -snap fork1 -queries "$Q" -n 10 | grep '"class"' | grep '"event":"class"' | sed "s/^/RESULT {\"corpus\":\"$CORPUS\",\"snap\":\"fork1\",\"r\":/; s/\$/}/"

  # Twenty more small checkpoints (5 files each): query cost as delta shards pile up, then a compaction.
  local prev=fork1
  for k in $(seq 20); do
    local ck; ck=$(edit_commit "$R" 5 "$G" chain$k)
    "$CS" index -store "$S" -repo "$R" -commit $ck -parent $prev -ref chain >/dev/null; prev=chain
  done
  "$CS" bench -store "$S" -snap chain -queries "$Q" -n 10 | grep '"event":"class"\|"event":"open"' | sed "s/^/RESULT {\"corpus\":\"$CORPUS\",\"snap\":\"chain-23-deltas\",\"r\":/; s/\$/}/"
  r=$("$CS" compact -store "$S" -snap chain); result "{\"corpus\":\"$CORPUS\",\"step\":\"compact\",\"r\":$r}"
  "$CS" bench -store "$S" -snap chain -queries "$Q" -n 10 | grep '"event":"class"\|"event":"open"' | sed "s/^/RESULT {\"corpus\":\"$CORPUS\",\"snap\":\"chain-compacted\",\"r\":/; s/\$/}/"
  sizes "$S" after-chain

  # Baselines on the base checkout: ripgrep (warm page cache), git grep over the commit, then cold local disk.
  git -C "$R" checkout -q -f $base
  python3 -I "$HERE/bench/baseline.py" "$Q" "$R" "$R" $base 5 rg,gitgrep | sed "s/^/RESULT {\"corpus\":\"$CORPUS\",\"r\":/; s/\$/}/"
  drop; t0=$(now); local n; n=$(rg --no-ignore --hidden -g '!.git' -l -F -e "$lit" "$R" | wc -l)
  result "{\"corpus\":\"$CORPUS\",\"step\":\"rg-cold-disk\",\"q\":\"$lit\",\"ms\":$(msince $t0),\"files\":$n}"
  drop; t0=$(now); n=$(git -C "$R" grep -l -F -e "$lit" $base | wc -l)
  result "{\"corpus\":\"$CORPUS\",\"step\":\"gitgrep-cold\",\"q\":\"$lit\",\"ms\":$(msince $t0),\"files\":$n}"
  if [ "$LP" != - ]; then
    rm -rf "$W/tree"; mkdir -p "$W/tree"; git -C "$R" archive $base | tar -x -C "$W/tree"
    lazy_rg "$W/tree" "$LP"; rm -rf "$W/tree"
  fi
  git -C "$R" checkout -q -f bench-base
)

if [[ ,$CORPORA, == *,gen,* ]]; then
  for spec in small:200:5000 medium:5000:10000 large:50000:10000; do
    IFS=: read -r nm nf nb <<<"$spec"
    R="$C/gen-$nm"
    if [ ! -d "$R/.git" ]; then
      rm -rf "$R"; "$CS" gen -name "$R" -n $nf -limit-bytes $nb && git -C "$R" init -q && git -C "$R" add -A && git -C "$R" commit -qm gen
    fi
    lp=-; [ $nm = medium ] && lp="finally super readonly"
    corpus gen-$nm "$R" 'src/*' queries-gen.json "$lp" || exit 1
  done
fi
if [[ ,$CORPORA, == *,k8s,* ]]; then
  git -C "$C/kubernetes" rev-parse -q --verify HEAD >/dev/null 2>&1 || { rm -rf "$C/k.tmp" "$C/kubernetes"; git clone -q --depth 1 --single-branch https://github.com/kubernetes/kubernetes "$C/k.tmp" && mv "$C/k.tmp" "$C/kubernetes"; }
  corpus k8s "$C/kubernetes" '*.go' queries-k8s.json "NewSharedInformerFactory" || exit 1
fi
if [[ ,$CORPORA, == *,linux,* ]]; then
  git -C "$C/linux" rev-parse -q --verify HEAD >/dev/null 2>&1 || { rm -rf "$C/l.tmp" "$C/linux"; t0=$(now); git clone -q --depth 1 --single-branch https://github.com/torvalds/linux "$C/l.tmp" && mv "$C/l.tmp" "$C/linux"; result "{\"step\":\"clone-linux\",\"ms\":$(msince $t0)}"; }
  corpus linux "$C/linux" '*.c' queries-linux.json "kmem_cache_create" || exit 1
fi
echo "== done"
