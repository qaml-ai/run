#!/bin/zsh
# Second round: the middle ground, evictions with Pi's model retries on (as camelRun runs), the 100k-context errors in
# detail, and CPU per invocation when nothing but alarms opens one (no polling). Writes one JSON line per run to $1.
out=$1
run() { node spikes/pi-subagents/run.mjs "$@" >> $out; }
run ctx=0 n=1,10,25,100 remote=1
run ctx=0 n=10 crashAt=20000 retry=1
run ctx=0 n=10 crashAt=20000 remote=1
run ctx=100000 n=25
run ctx=0 n=25,100 pollMs=240000 limitMs=480000
run ctx=100000 n=50 pollMs=240000 limitMs=480000
