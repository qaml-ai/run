#!/usr/bin/env bash
# sim-shards.sh <from> <to> <shards> <outdir>: run inside a ci-run checkout. Splits seeds from..to over <shards>
# processes of `npm run sim` (PGlite, deterministic); then, when the checkout's simulator has the real-Postgres mode
# and SIM_POSTGRES_SEEDS is set (a count, e.g. 200), that many seeds from <from> on ci-run's own Postgres. Every
# failing seed's plan (sim-failures/<seed>.json: replay with `npm run sim -- --replay <file>`) is copied to <outdir>
# and minimized there (<seed>.min.json); shard and minimizer logs go there too. Then, when the checkout has the fuzzer,
# as long again of coverage-guided fuzzing (`--fuzz`, on <shards> workers) from the corpus kept across batches
# (SIM_CORPUS, default ~/camelrun-ci/sim/corpus); each new kind of failure it finds, minimized, goes to <outdir>/fuzz.
# SIM_FUZZ=0 skips it. Exits 1 if any seed failed or the fuzzer found a failure.
set -uo pipefail
from=$1; to=$2; shards=$3; out=$4
mkdir -p "$out"
seeded=$(date +%s)
total=$(( to - from + 1 )); per=$(( (total + shards - 1) / shards ))
pids=()
for (( i = 0; i < shards; i++ )); do
  a=$(( from + i * per )); b=$(( a + per - 1 )); (( b > to )) && b=$to; (( a > to )) && break
  npm run -s sim -- --seeds $a-$b > /dev/null 2> "$out/shard-$a-$b.log" &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait $pid || status=1; done
if [ "${SIM_FUZZ:-1}" != 0 ] && grep -q -- '--fuzz' scripts/sim.ts; then
  # Half the batch's time: as long as the seeds took, at least a minute.
  minutes=$(( ($(date +%s) - seeded + 59) / 60 ))
  corpus=${SIM_CORPUS:-$HOME/camelrun-ci/sim/corpus}; mkdir -p "$corpus"
  npm run -s sim -- --fuzz $minutes --jobs $shards --corpus "$corpus" > /dev/null 2> "$out/fuzz.log"
  if compgen -G "sim-failures/fuzz/*.json" > /dev/null; then
    mkdir -p "$out/fuzz" && cp sim-failures/fuzz/*.json "$out/fuzz/" && status=1
  fi
fi
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
  # Postgres runs are not deterministic: kept as they are. The fuzzer minimized its own.
  case "$file" in */postgres/*|*/fuzz/*) continue ;; esac
  npm run -s sim -- --minimize "$file" > /dev/null 2>> "$out/minimize.log"
done
exit $status
