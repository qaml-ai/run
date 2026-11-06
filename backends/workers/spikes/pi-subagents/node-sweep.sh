#!/bin/zsh
# Node heap sweep: one process per N, so peaks do not mix. Usage: node-sweep.sh <ctx> [n ...]
# Run from backends/workers. Prints one JSON line per run.
ctx=${1:-0}; shift
levels=($@); (( $#levels )) || levels=(1 5 10 25 50 100)
for n in $levels; do
  node --expose-gc --max-old-space-size=4096 --experimental-strip-types --disable-warning=ExperimentalWarning \
    spikes/pi-subagents/node-bench.ts n=$n tps=50 tokens=2000 tools=3 ctx=$ctx
done
