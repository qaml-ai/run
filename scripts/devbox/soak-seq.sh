#!/usr/bin/env bash
# soak.sh [hours]: keep the devbox testing camelRun's main until stopped (or for <hours>, default 10).
# Each round, on the latest origin/main:
#   - property tests at a high scale with fresh seeds (PROP_SCALE, default 50), whose failures print a replay line;
#   - then one full suite (each in its own checkout and Postgres, via ci-run), one job at a time so the box keeps
#     headroom for other runs: these tests are timing-sensitive, and a starved machine only reports noise.
# Every failing test goes to ~/camelrun-ci/soak/failures.tsv (time, commit, kind, test, log), and a one-line
# summary per round to ~/camelrun-ci/soak/rounds.tsv. Stop it with: kill $(cat ~/camelrun-ci/soak/pid)
set -uo pipefail
hours=${1:-10}; scale=${PROP_SCALE:-50}
dir=$HOME/camelrun-ci/soak; mkdir -p $dir; echo $$ > $dir/pid
end=$(( $(date +%s) + hours * 3600 ))
touch $dir/failures.tsv $dir/rounds.tsv
record() { # kind log
  local commit; commit=$(grep -m1 -oE '^   at [0-9a-f]{7}' "$2" | awk '{print $2}')
  grep -E '^not ok ' "$2" | grep -v '# TODO' | sed -E 's/^not ok [0-9]+ - //' | while read -r name; do
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$commit" "$1" "$name" "$2" >> $dir/failures.tsv
  done
  grep -E 'PROP_SEED=' "$2" | head -5 | sed "s|^|$(date -u +%FT%TZ)\treplay\t|" >> $dir/failures.tsv || true
}
round=0
while [ "$(date +%s)" -lt "$end" ]; do
  round=$((round + 1))
  logs=()
  PROP_SCALE=$scale ~/camelrun-ci/ci-run origin/main node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=4 --test-timeout=7200000 tests/prop-*.test.ts > $dir/r$round-props.out 2>&1; s1=$?
  env -u PROP_SCALE ~/camelrun-ci/ci-run origin/main > $dir/r$round-full-a.out 2>&1; s2=$?
  s3=-; : > $dir/r$round-full-b.out
  for kind in props full-a full-b; do record $kind $dir/r$round-$kind.out; done
  commit=$(grep -m1 -oE '^   at [0-9a-f]{7}' $dir/r$round-full-a.out | awk '{print $2}')
  fails=$(grep -cE '^not ok ' $dir/r$round-*.out | awk -F: '{s+=$2} END{print s+0}')
  printf '%s\tround %s\t%s\tprops=%s full-a=%s full-b=%s\tnot_ok=%s\n' "$(date -u +%FT%TZ)" $round "$commit" $s1 $s2 $s3 $fails >> $dir/rounds.tsv
  # Keep only the last 20 rounds of raw output.
  ls -1t $dir/r*-*.out 2>/dev/null | tail -n +61 | xargs -r rm -f
  find $HOME/camelrun-ci/runs -maxdepth 1 -name '*.log' -mmin +720 -delete 2>/dev/null
done
rm -f $dir/pid
