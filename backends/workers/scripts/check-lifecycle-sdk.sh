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
if [[ ${1:-} == --python ]]; then
  shift
  for contract_backend in node workers; do
    CONTRACT_BACKEND=$contract_backend python3 - "$@" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path("tests/contract").resolve()))
from python_runner import inventory, run_cases

wanted = set(sys.argv[1:])
manifest = inventory(Path("tests/python_sdk.py"))
selected = [row for row in manifest if not wanted or row["name"] in wanted or row["name"].split(".", 1)[1] in wanted]
matched = {name for name in wanted if any(row["name"] == name or row["name"].endswith("." + name) for row in selected)}
if matched != wanted:
    raise SystemExit(f"Unknown Python cases: {sorted(wanted - matched)}")
raise SystemExit(run_cases(selected, Path("tests/contract/python.py").resolve(), 2))
PY
  done
elif [[ ${1:-} == --files ]]; then
  shift
  CONTRACT_BACKEND=workers node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=2 "$@"
else
  npm run parity -- "$@"
fi
