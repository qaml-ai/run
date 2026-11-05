#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Pool images may contain unrelated or partial user-site Python packages.
contract_python=$(mktemp -d /tmp/camelrun-contract-python.XXXXXX)
trap 'rm -rf "$contract_python"' EXIT
python3 -m venv "$contract_python"
export PATH="$contract_python/bin:$PATH"
python3 -m pip install --quiet -r clients/python/requirements.txt
npm run typecheck
node tests/contract/check-assertions.mjs
node tests/contract/check-product-assertions.mjs
npm run docs
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern='llms.txt' tests/docs.test.ts
export CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4}
npm run parity -- --backend=node
