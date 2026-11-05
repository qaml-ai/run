#!/usr/bin/env bash
# Run through the repo's leased scripts/sprite-test, one validation job per sprite.
set -euo pipefail
mode=${1:?Expected unit, integration, compat, python, contract or checks}
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
artifact="$HOME/runs/workers-agents-$mode-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$artifact"
finish() {
  code=$?
  trap - EXIT
  cp measurements/compat*.tap measurements/compatibility.json measurements/python-compat.json "$artifact/" 2>/dev/null || true
  if [[ $mode == contract ]]; then
    cp measurements/parity-*.json measurements/parity-*.log "$artifact/" 2>/dev/null || true
  fi
  printf '%s\n' "$code" > "$artifact/exit"
  tar -czf "$artifact.tgz" -C "$artifact" .
  echo "SPRITE_ARTIFACT=$artifact.tgz"
  exit "$code"
}
trap finish EXIT
lock=$(sha256sum package-lock.json | cut -d' ' -f1)
if [[ ! -x node_modules/.bin/wrangler || $(cat "$HOME/.workers-lock" 2>/dev/null || true) != "$lock" ]]; then
  npm ci --no-audit --no-fund
  printf '%s' "$lock" > "$HOME/.workers-lock"
fi
if [[ $mode == integration || $mode == compat ]]; then
  if ! command -v docker >/dev/null || ! docker buildx version >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-buildx
  fi
  if ! docker info >/dev/null 2>&1; then
    if ! sudo service docker start; then
      sudo sh -c 'nohup dockerd --storage-driver=vfs > /tmp/workers-dockerd.log 2>&1 < /dev/null &'
      for _ in $(seq 60); do
        if sudo docker info >/dev/null 2>&1; then break; fi
        sleep 1
      done
      if ! sudo docker info >/dev/null 2>&1; then
        tail -40 /tmp/workers-dockerd.log >&2
        exit 1
      fi
    fi
    sudo chgrp "$(id -gn)" /var/run/docker.sock
    sudo chmod g+rw /var/run/docker.sock
  fi
  docker info >/dev/null
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
  integration) npm run test:integration 2>&1 | tee "$artifact/integration.tap" ;;
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
