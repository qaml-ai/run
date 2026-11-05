#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export CONTRACT_ON_SPRITE=1
backend=node; [[ ${1:-} != --compare ]] || backend=both
source tests/contract/setup.sh "$backend"
npm run typecheck
node tests/contract/check-assertions.mjs
node tests/contract/check-product-assertions.mjs
npm run docs
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern='llms.txt' tests/docs.test.ts
export CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4}
npm run parity -- --backend=node
if [[ ${1:-} == --compare ]]; then
  CONTRACT_CONCURRENCY=${CONTRACT_WORKER_CONCURRENCY:-4} npm run parity -- --backend=workers
fi
