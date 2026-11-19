#!/usr/bin/env bash
# loop.sh: keep camel-devbox testing camelRun's main around the clock, one job at a time.
# Each cycle runs a soak round on main, then an image check every IMAGE_EVERY cycles (default 1).
# Cron starts it every 10 minutes. The lock allows only one copy to run.
# To stop after the current step, create ~/camelrun-ci/loop/stop.
set -uo pipefail
home=$HOME/camelrun-ci; dir=$home/loop; mkdir -p $dir
exec 8>$dir/lock
flock -n 8 || exit 0
echo $$ > $dir/pid
every=${IMAGE_EVERY:-1}
cycle=$(cat $dir/cycle 2>/dev/null || echo 0)
while [ ! -e $dir/stop ]; do
  cycle=$((cycle + 1)); echo $cycle > $dir/cycle
  started=$(date +%s)
  ( cd $home && PROP_SCALE=50 ./soak-seq.sh 1 >> $dir/soak.out 2>&1 ); soak=$?
  [ -e $dir/stop ] && break
  image=-
  if [ $((cycle % every)) -eq 0 ] && [ ! -e $dir/stop ]; then
    log=$dir/image-$cycle.out
    $home/ci-run origin/main bash $home/image-check.sh > $log 2>&1; image=$?
    printf '%s\t%s\texit=%s\tisolation_passed=%s\tv8=%s\n' "$(date -u +%FT%TZ)" "$(grep -m1 -oE '^   at [0-9a-f]{7}' $log | awk '{print $2}')" $image \
      "$(grep -c 'image isolation test passed' $log)" "$(grep -E '^# (pass|fail) ' $log | tr '\n' ' ')" >> $home/soak/images.tsv
    ls -1t $dir/image-*.out | tail -n +8 | xargs -r rm -f
  fi
  printf '%s\tcycle %s\tsoak=%s\timage=%s\t%ss\n' "$(date -u +%FT%TZ)" $cycle $soak $image $(( $(date +%s) - started )) >> $dir/cycles.tsv
  # Keep a week of run logs. ci-run removes its own worktrees.
  find $home/runs -maxdepth 1 -name '*.log' -mtime +7 -delete 2>/dev/null
done
rm -f $dir/pid
