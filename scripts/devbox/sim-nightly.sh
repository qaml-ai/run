#!/usr/bin/env bash
# sim-nightly.sh [from] [to] [ref]: the deterministic simulator (npm run sim) over seeds from..to (default 1..5000) at
# <ref> (default origin/main), in SIM_SHARDS processes (default 4), in a ci-run checkout. It waits until no other
# ci-run is running, so it never competes with a timing-sensitive suite, and holds ~/camelrun-ci/sim/lock so two
# never run at once. Every failing seed's plan, and its minimized plan, go to ~/camelrun-ci/sim-failures/<stamp>/
# (replay: npm run sim -- --replay <file>); shard and minimizer logs beside them. One line per run goes to
# ~/camelrun-ci/sim/nights.tsv. Exits 1 if any seed failed. SIM_NOWAIT=1 skips the wait (a short manual run).
set -uo pipefail
from=${1:-1}; to=${2:-5000}; ref=${3:-origin/main}; shards=${SIM_SHARDS:-4}
root=$HOME/camelrun-ci; dir=$root/sim; mkdir -p $dir $root/sim-failures
exec 9> $dir/lock
flock -n 9 || { echo "sim-nightly is already running"; exit 2; }
# Another ci-run: a process named ci-run (run as a script), or bash running it. Matched on process names and the
# parsed argument list, never a pattern over whole command lines, so this script never matches itself.
busy() {
  pgrep -x ci-run > /dev/null && return 0
  ps -eo pid=,args= | awk -v self=$$ '$1 != self && $2 ~ /(^|\/)bash$/ && $3 ~ /(^|\/)ci-run$/ { found = 1 } END { exit !found }'
}
[ -n "${SIM_NOWAIT:-}" ] || while busy; do sleep 60; done
stamp=$(date -u +%Y%m%dT%H%M%SZ); out=$root/sim-failures/$stamp
started=$(date +%s)
$root/ci-run "$ref" $root/sim-shards.sh $from $to $shards $out > $dir/$stamp.log 2>&1; status=$?
commit=$(grep -m1 -oE "^   at [0-9a-f]{7}" $dir/$stamp.log | awk '{print $2}')
failed=$(( $(ls $out 2>/dev/null | grep -E '^[0-9]+\.json$' | wc -l) + $(ls $out/fuzz 2>/dev/null | grep -E '^[0-9a-f]{8}\.json$' | wc -l) ))
# The coverage goals no shard reached.
never=$(python3 -c 'import json,sys; s=[set(json.loads(open(f).read().strip().splitlines()[-1]).get("neverReached",[])) for f in sys.argv[1:]]; print(json.dumps(sorted(set.intersection(*s)) if s else []))' $out/shard-*.log 2>/dev/null)
printf "%s\t%s\tseeds %s-%s\tstatus=%s\tfailed=%s\t%ss\tnever reached: %s\tfailures: %s\n" "$stamp" "$commit" $from $to $status $failed $(( $(date +%s) - started )) "$never" "$out" >> $dir/nights.tsv
exit $status
