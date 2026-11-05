#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

# Run through scripts/sprite-test. Both backends use one isolated local database.
contract_python=$(mktemp -d /tmp/camelrun-lifecycle-python.XXXXXX)
trap 'rm -rf "$contract_python"' EXIT
python3 -m venv "$contract_python"
export PATH="$contract_python/bin:$PATH"
python3 -m pip install --quiet -r clients/python/requirements.txt
npm ci --prefix backends/workers --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run typecheck --prefix backends/workers
export AGENT_TEST_DATABASE_URL=${AGENT_TEST_DATABASE_URL:-postgres://postgres:test@127.0.0.1:55432/postgres}
export CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-2}
if [[ ${1:-} == --files ]]; then
  shift
  CONTRACT_BACKEND=workers node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=2 "$@"
else
  npm run parity -- "$@"
fi
