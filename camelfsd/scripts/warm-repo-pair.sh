#!/usr/bin/env bash
set -euo pipefail

role=${1:?server or client}
origin=${2:-}
mkdir -p work/warmrepo-results
go build -C camelfsd -o ../work/warmrepo-results/warm-repo-probe ./cmd/warm-repo-probe
binary=$PWD/work/warmrepo-results/warm-repo-probe
# This credential protects random synthetic fixtures during a short public-URL
# experiment. It grants no access to any production or pilot data.
export WARM_REPO_TOKEN=synthetic-warm-repo-fixture-20261117

case "$role" in
  server|1)
    state=$(mktemp -d /tmp/warmrepo-pair.XXXXXX)
    server_pid=
    cleanup() {
      if [[ -n $server_pid ]]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
      fi
      rm -rf "$state"
    }
    trap cleanup EXIT
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('0.0.0.0', 8080))
s.close()
PY
    for size in 50 500; do
      "$binary" seed --data "$state/seed-$size" --mib "$size" | tee "work/warmrepo-results/seed-$size.jsonl"
      "$binary" fill --data "$state/$size" --manifest "$state/seed-$size/manifest.json" --store "$state/seed-$size/canonical" \
        | tee "work/warmrepo-results/fill-$size.jsonl"
      cp "$state/$size/manifest.json" "work/warmrepo-results/manifest-$size.json"
      du -sb "$state/$size/repo.git" > "work/warmrepo-results/git-bytes-$size.txt"
    done
    "$binary" serve --mib 0 --data "$state" --listen 0.0.0.0:8080 > work/warmrepo-results/server.jsonl 2>&1 &
    server_pid=$!
    echo warm_repo_server_started
    for second in $(seq 720); do
      kill -0 "$server_pid" || { cat work/warmrepo-results/server.jsonl; exit 1; }
      if [[ -f work/warmrepo-results/STOP ]]; then
        echo warm_repo_server_finished
        exit 0
      fi
      sleep 1
    done
    echo 'client did not finish within the benchmark window' >&2
    exit 1
    ;;
  client|2)
    [[ $origin == https://* ]] || { echo 'client needs explicit remote HTTPS Sprite origin' >&2; exit 1; }
    # Readiness is outside the measurement. Once the selected service becomes
    # ready, every benchmark call executes exactly once and errors are fatal.
    ready=0
    for second in $(seq 720); do
      if curl -fsS --max-time 5 -H "Authorization: Bearer $WARM_REPO_TOKEN" "$origin/50/manifest" \
        -o work/warmrepo-results/readiness.json 2>/dev/null; then ready=1; break; fi
      sleep 1
    done
    [[ $ready == 1 ]] || { echo 'selected warm service unavailable' >&2; exit 1; }
    for size in 50 500; do
      "$binary" client --url "$origin/$size" --trials 3 | tee "work/warmrepo-results/client-$size.jsonl"
    done
    echo warm_repo_client_finished
    ;;
  *) echo 'role must be server or client' >&2; exit 2 ;;
esac
