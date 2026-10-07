#!/usr/bin/env bash
# Run inside a ci-run checkout: build the production image for this machine's arch (amd64 here) as CI does,
# then the isolation test in both hostings and v8-exec's tests (seccomp included) inside the image.
set -uo pipefail
npm run -s build:console >/dev/null || exit 1
docker build -q -t agent-runtime:amd64-check . >/dev/null || exit 1
echo "built agent-runtime:amd64-check ($(uname -m))"
status=0
for h in inline process; do
  echo "== image-isolation hosting=$h"
  ISOLATION_PORT=${ISOLATION_PORT:-18791} IMAGE=agent-runtime:amd64-check DATABASE_URL=$AGENT_TEST_DATABASE_URL AGENT_HOSTING=$h \
    node --experimental-strip-types --disable-warning=ExperimentalWarning tests/image-isolation.ts > /tmp/iso-$h.log 2>&1 || status=1
  tail -3 /tmp/iso-$h.log
done
echo "== v8-exec tests in the image"
docker run --rm --user node --entrypoint node -v "$PWD:/w:ro" -w /w agent-runtime:amd64-check \
  --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-timeout=300000 tests/v8-exec.test.ts 2>&1 \
  | grep -E "^# (tests|pass|fail|skipped)|^not ok" || status=1
docker rm -f runtime >/dev/null 2>&1 || true
exit $status
