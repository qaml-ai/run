#!/usr/bin/env bash
# Run through the repo's leased scripts/sprite-test, one validation job per sprite.
set -euo pipefail
mode=${1:?Expected unit, integration [I/N], compat, python, contract or checks}
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
artifact="$HOME/runs/workers-agents-$mode-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$artifact"
# A SIGSEGV on a sprite (never seen in CI) is made diagnosable: cores go to ~/cores, and the kernel's lines, memory and
# load from the run are printed and kept with the artifact when a test process dies of one.
mkdir -p "$HOME/cores"; ulimit -c unlimited 2>/dev/null || true
# Keep the two newest cores only: each can be gigabytes.
{ ls -t "$HOME"/cores/core.* 2>/dev/null || true; } | tail -n +3 | xargs -r rm -f
sudo -n sysctl -q -w kernel.core_pattern="$HOME/cores/core.%e.%p.%t" 2>/dev/null || true
dmesg_from=$(dmesg 2>/dev/null | wc -l || echo 0)
segv_report() {
  grep -rqs "signal: 'SIGSEGV'" "$artifact" || return 0
  {
    echo "== SIGSEGV on $(hostname) ($(nproc) cpus, uptime $(cut -d' ' -f1 /proc/uptime)s): node $(node -v)"
    grep -rh -B8 "signal: 'SIGSEGV'" "$artifact" | grep -E "^not ok|location:" || true
    echo "== kernel since the run started"; dmesg 2>/dev/null | tail -n +"$((dmesg_from + 1))" | tail -50 || true
    echo "== memory"; free -m; echo "== load $(cat /proc/loadavg)"
    echo "== cores"; ls -la "$HOME/cores" 2>/dev/null | tail -5
  } | tee "$artifact/sigsegv.txt"
}
finish() {
  code=$?
  trap - EXIT
  segv_report || true
  cp measurements/compat*.tap measurements/compatibility.json measurements/python-compat.json "$artifact/" 2>/dev/null || true
  if [[ $mode == contract ]]; then
    cp "$repo"/backends/workers/measurements/parity-*.json "$repo"/backends/workers/measurements/parity-*.log "$artifact/" 2>/dev/null || true
  fi
  printf '%s\n' "$code" > "$artifact/exit"
  tar -czf "$artifact.tgz" -C "$artifact" .
  echo "SPRITE_ARTIFACT=$artifact.tgz"
  exit "$code"
}
trap finish EXIT
# scripts/sprite-test-core.sh installs every package-lock.json in the tree (this one included) before the command.
[[ -x node_modules/.bin/wrangler ]] || { echo "backends/workers/node_modules is not installed; run this through scripts/sprite-test" >&2; exit 1; }
if [[ $mode == integration || $mode == compat ]]; then
  # scripts/sprite-test sets Docker up on every pool sprite (docker_up in scripts/sprite-test-core.sh; README.md, "Docker on a sprite"), so the
  # native computer tests run here as on CI, which allows them no skip.
  if ! docker info >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
    echo "Docker with Buildx is not running on this sprite; run this through scripts/sprite-test, which sets it up." >&2
    exit 1
  fi
  export WORKERS_REQUIRE_DOCKER=1
fi
if [[ $mode == python || $mode == contract ]]; then
  if [[ ! -x "$HOME/.workers-python/bin/python3" ]]; then
    python3 -m venv "$HOME/.workers-python"
  fi
  "$HOME/.workers-python/bin/pip" install -q -r "$repo/clients/python/requirements.txt"
  export PATH="$HOME/.workers-python/bin:$PATH"
fi
case "$mode" in
  unit) npm test 2>&1 | tee "$artifact/unit.tap" ;;
  integration) npm run test:integration ${2:+-- --test-shard=$2} 2>&1 | tee "$artifact/integration.tap" ;;
  compat) npm run test:compat 2>&1 | tee "$artifact/compatibility-run.log" ;;
  python) npm run test:python 2>&1 | tee "$artifact/python-compat.log" ;;
  contract)
    cd "$repo"
    CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4} npm run parity -- --area="${2:?Expected contract areas}" 2>&1 | tee "$artifact/contract.log"
    ;;
  checks)
    {
    npm run typecheck
    for file in scripts/reuse-*.mjs; do
      # The fs shim compares to origin/main, which git archive does not include.
      # Run that one sub-second check in the source checkout; the others use files.
      if [[ $file == scripts/reuse-fs-shim.mjs ]]; then continue; fi
      node "$file" --check
    done
    npm run build 2>&1 | tee "$artifact/build.log"
    if [[ -n ${2:-} ]]; then
      WORKERS_MEASURE_COMMIT="$2" node scripts/report.mjs
      cp ELEGANCE.md measurements/code-size.json "$artifact/"
    fi
    cd "$repo"
    npm run docs
    node --experimental-strip-types --test --test-name-pattern='^llms.txt' tests/docs.test.ts
    npm run openapi
    } 2>&1 | tee "$artifact/checks.log"
    ;;
  *) echo "Unknown validation: $mode" >&2; exit 2 ;;
esac
