#!/usr/bin/env bash
# Run on a Sprite: scripts/sprite-test HEAD bash backends/workers/scripts/check-tools-mcp.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

npm ci --prefix backends/workers --no-audit --no-fund
npm run typecheck
npm run typecheck --prefix backends/workers
(
  cd backends/workers
  node --import ./test/sdk-deps.mjs --experimental-strip-types --test \
    test/agent-builtins.test.ts test/agent-tools.test.ts
)

tools_mcp_python=$(mktemp -d /tmp/camelrun-tools-mcp-python.XXXXXX)
trap 'rm -rf "$tools_mcp_python"' EXIT
python3 -m venv "$tools_mcp_python"
"$tools_mcp_python/bin/pip" install --quiet -r clients/python/requirements.txt
export PATH="$tools_mcp_python/bin:$PATH"
export CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4}
if [[ $# -eq 0 ]]; then
  set -- --area=tools,mcp
fi
npm run parity -- "$@"
