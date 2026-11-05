#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

contract_python=$(mktemp -d /tmp/camelrun-delegation-config.XXXXXX)
trap 'rm -rf "$contract_python"' EXIT
python3 -m venv "$contract_python"
export PATH="$contract_python/bin:$PATH"
python3 -m pip install --quiet -r clients/python/requirements.txt
npm ci --prefix backends/workers --silent
npm run typecheck
npm --prefix backends/workers run typecheck
(
  cd backends/workers
  node --import ./test/sdk-deps.mjs --experimental-strip-types --test \
    test/child-config.test.ts test/configuration-targets.test.ts \
    test/delegation-charges.test.ts test/delegation-notifications.test.ts \
    test/run-limits.test.ts
)
CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4} npm run parity -- --area=definitions,delegation
