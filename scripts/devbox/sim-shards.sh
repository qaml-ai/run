#!/usr/bin/env bash
# sim-shards.sh <from> <to> <shards> <outdir>: run inside a ci-run checkout. Splits seeds from..to over <shards>
# processes of `npm run sim` (PGlite, deterministic); then, when the checkout's simulator has the real-Postgres mode
# and SIM_POSTGRES_SEEDS is set (a count, e.g. 200), that many seeds from <from> on ci-run's own Postgres. Every
# failing seed's plan (sim-failures/<seed>.json: replay with `npm run sim -- --replay <file>`) is copied to <outdir>
# and minimized there (<seed>.min.json); shard and minimizer logs go there too. Exits 1 if any seed failed.
set -uo pipefail
from=$1; to=$2; shards=$3; out=$4
mkdir -p "$out"
total=$(( to - from + 1 )); per=$(( (total + shards - 1) / shards ))
pids=()
for (( i = 0; i < shards; i++ )); do
  a=$(( from + i * per )); b=$(( a + per - 1 )); (( b > to )) && b=$to; (( a > to )) && break
  npm run -s sim -- --seeds $a-$b > /dev/null 2> "$out/shard-$a-$b.log" &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait $pid || status=1; done
if [ -n "${SIM_POSTGRES_SEEDS:-}" ] && grep -q -- '--postgres' scripts/sim.ts; then
  last=$(( from + SIM_POSTGRES_SEEDS - 1 ))
  npm run -s sim -- --postgres --seeds $from-$last --jobs $shards --out sim-failures/postgres > /dev/null 2> "$out/postgres-$from-$last.log" || status=1
fi
for dir in sim-failures sim-failures/postgres; do
  compgen -G "$dir/*.json" > /dev/null || continue
  target="$out"; [ "$dir" = sim-failures/postgres ] && target="$out/postgres" && mkdir -p "$target"
  cp $dir/*.json "$target/"
done
for file in $(find "$out" -name '[0-9]*.json' ! -name '*.min.json' 2>/dev/null); do
  case "$file" in */postgres/*) continue ;; esac   # Postgres runs are not deterministic: keep them as they are.
  npm run -s sim -- --minimize "$file" > /dev/null 2>> "$out/minimize.log"
done
exit $status
