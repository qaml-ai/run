#!/usr/bin/env bash
# Every scripts/bench-hosting.ts configuration in turn, one JSON line each (a run that dies says how).
# scripts/sprite-test HEAD scripts/bench-hosting.sh [agents] [busy]
agents=${1:-60}; busy=${2:-15}
run() {
  local out; out=$(node --experimental-strip-types --disable-warning=ExperimentalWarning --expose-gc scripts/bench-hosting.ts --agents "$agents" --busy "$busy" --turns 10 "$@" 2>/dev/null)
  local code=$?
  grep '^{"hosting' <<<"$out" || echo "{\"run\":\"$*\",\"died\":$code}"
}
run --hosting inline
run --hosting thread
run --hosting thread --young-mb 4
run --hosting process
run --hosting inline --fault spin
run --hosting thread --young-mb 4 --fault spin
run --hosting process --fault spin
run --hosting thread --young-mb 4 --fault grow
run --hosting process --fault grow
run --hosting inline --fault grow
run --hosting thread --young-mb 4 --quickjs
