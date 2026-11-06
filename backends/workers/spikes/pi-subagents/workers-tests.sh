#!/usr/bin/env bash
# Workers typecheck, unit and integration tests for one shard (from the repository root, on a Sprite):
#   scripts/sprite-test --shards=4 HEAD bash backends/workers/spikes/pi-subagents/workers-tests.sh '{shard}/{shards}'
set -euo pipefail
cd "$(dirname "$0")/../.."
npm ci --no-audit --no-fund >/dev/null
npm run typecheck
npm test -- --test-shard="$1"
npm run test:integration -- --test-shard="$1"
