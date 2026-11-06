#!/usr/bin/env bash
# One contract file on Workers with the Pi subagents flag on, for debugging (from the repository root, on a Sprite):
#   scripts/sprite-test --dirty HEAD bash backends/workers/spikes/pi-subagents/contract-one.sh multi-agent.contract.test.ts ['name pattern']
set -euo pipefail
cd "$(dirname "$0")/../../../.."
source tests/contract/setup.sh workers
export CONTRACT_BACKEND=workers AGENT_PI_SUBAGENTS=${AGENT_PI_SUBAGENTS-1}
exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=1 \
  ${2:+--test-name-pattern="$2"} "tests/contract/areas/$1"
