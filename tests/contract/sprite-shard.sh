#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
backend=both
for arg in "$@"; do
  case $arg in --backend=*) backend=${arg#*=} ;; esac
done
source tests/contract/setup.sh "$backend"
export CONTRACT_ON_SPRITE=1
export CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-6}
exec node tests/contract/run.mjs "$@"
