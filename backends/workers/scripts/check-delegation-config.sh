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
    test/delegation-charges.test.ts test/delegation-notifications.test.ts test/delegation-progress.test.ts \
    test/steering-placement.test.ts test/message-admission.test.ts test/event-visibility.test.ts \
    test/run-limits.test.ts
  node --import ./test/compat-register.mjs --experimental-strip-types --test \
    test/keyed-tool-sources.integration.ts
)
contract_status=0
CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4} npm run parity -- --area=definitions,delegation || contract_status=$?
# A released pool checkout can be replaced immediately by another task.
contract_reports="$HOME/runs/delegation-config-${CONTRACT_REVISION:-latest}"
mkdir -p "$contract_reports"
for contract_report in backends/workers/measurements/parity-{node,workers}-definitions_delegation.json; do
  if [[ -f "$contract_report" ]]; then cp "$contract_report" "$contract_reports/"; fi
done
printf 'Contract reports: %s\n' "$contract_reports"
exit "$contract_status"
