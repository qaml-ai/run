#!/usr/bin/env bash
# loop.sh: keep camel-devbox testing camelRun's main around the clock, one job at a time.
# Each cycle, on the latest origin/main:
#   1. a soak round (soak-seq.sh: property tests at PROP_SCALE=50, then the full suite);
#   2. a simulator batch of SIM_BATCH seeds (sim-nightly.sh), continuing from the last batch's seeds, with
#      SIM_POSTGRES_SEEDS of them also against real Postgres;
#   3. every IMAGE_EVERY cycles, the image check (image-check.sh: the amd64 image's isolation and v8-exec tests).
# Results: soak/rounds.tsv and soak/failures.tsv, sim/nights.tsv and sim-failures/<stamp>/, soak/images.tsv, and one
# line per cycle in loop/cycles.tsv. cron starts it (every 10 minutes, a no-op while it runs: it holds loop/lock);
# stop it with: touch ~/camelrun-ci/loop/stop (it ends after the step in progress). Not with kill: a child still waiting on
# the simulator's lock keeps loop/lock, and cron cannot start it again until that child ends.
set -uo pipefail
home=$HOME/camelrun-ci; dir=$home/loop; mkdir -p $dir
exec 8>$dir/lock
flock -n 8 || exit 0
echo $$ > $dir/pid
batch=${SIM_BATCH:-5000}; pg=${SIM_POSTGRES_SEEDS:-100}; every=${IMAGE_EVERY:-3}
# The simulator is deterministic, so it can use most of the box (the soak, timing-sensitive, runs alone before it).
export SIM_SHARDS=${SIM_SHARDS:-12}
cycle=$(cat $dir/cycle 2>/dev/null || echo 0)
while [ ! -e $dir/stop ]; do
  cycle=$((cycle + 1)); echo $cycle > $dir/cycle
  started=$(date +%s)
  # A batch started by hand holds the simulator's lock: wait for it rather than skip.
  flock $home/sim/lock true
  ( cd $home && PROP_SCALE=50 ./soak-seq.sh 1 >> $dir/soak.out 2>&1 ); soak=$?
  [ -e $dir/stop ] && break
  from=$(cat $dir/next-seed 2>/dev/null || echo 15001)
  ( cd $home && SIM_NOWAIT=1 SIM_POSTGRES_SEEDS=$pg ./sim-nightly.sh $from $((from + batch - 1)) origin/main >> $dir/sim.out 2>&1 ); sim=$?
  echo $((from + batch)) > $dir/next-seed
  image=-
  if [ $((cycle % every)) -eq 0 ] && [ ! -e $dir/stop ]; then
    log=$dir/image-$cycle.out
    $home/ci-run origin/main bash $home/image-check.sh > $log 2>&1; image=$?
    printf '%s\t%s\texit=%s\tisolation_passed=%s\tv8=%s\n' "$(date -u +%FT%TZ)" "$(grep -m1 -oE '^   at [0-9a-f]{7}' $log | awk '{print $2}')" $image \
      "$(grep -c 'image isolation test passed' $log)" "$(grep -E '^# (pass|fail) ' $log | tr '\n' ' ')" >> $home/soak/images.tsv
    ls -1t $dir/image-*.out | tail -n +8 | xargs -r rm -f
  fi
  printf '%s\tcycle %s\tsoak=%s\tsim=%s seeds %s-%s\timage=%s\t%ss\n' "$(date -u +%FT%TZ)" $cycle $soak $sim $from $((from + batch - 1)) $image $(( $(date +%s) - started )) >> $dir/cycles.tsv
  # Old run logs and worktrees: ci-run removes worktrees; keep a week of logs and simulator failures.
  find $home/runs -maxdepth 1 -name '*.log' -mtime +7 -delete 2>/dev/null
  find $home/sim-failures -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
done
rm -f $dir/pid
