#!/bin/zsh
# The deployed measurements, one after another so each window's telemetry is its own. Run from backends/workers with
# SPIKE_URL and SPIKE_TOKEN_FILE set; writes one JSON line per run to $1.
out=$1
run() { node spikes/pi-subagents/run.mjs "$@" >> $out; }
run ctx=0 n=1,5,10,25,50,100
run ctx=100000 n=1,5,10,25,50,100
run ctx=0 n=1,10,25,100 remote=1
run ctx=0 n=10 crashAt=20000
run ctx=0 n=10 crashAt=20000 remote=1
