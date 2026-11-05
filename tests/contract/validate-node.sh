#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m pip install --quiet -r clients/python/requirements.txt
npm run typecheck
npm run docs
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern='llms.txt' tests/docs.test.ts
export CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-8}
npm run parity -- --backend=node
