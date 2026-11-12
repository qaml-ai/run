#!/bin/sh
# The m-toml-go judge, run in the judge image with the output tree at /work and no network. Builds the port's two
# commands with the standard library only (no module proxy, no toolchain download), then runs toml-test v2.2.0's
# decoder (valid, invalid) and encoder suites for TOML 1.0 and prints its JSON report between markers.
export GOPROXY=off GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=mod HOME=/tmp GOCACHE=/tmp/gocache
mkdir -p /tmp/bin
if [ ! -f /work/go/go.mod ]; then echo "BUILD decoder fail: no go/go.mod"; echo "BUILD encoder fail: no go/go.mod"; exit 0; fi
cd /work/go
flags=""
for cmd in decoder encoder; do
  if go build -o /tmp/bin/toml-$cmd ./cmd/toml-$cmd >/tmp/build-$cmd.log 2>&1; then echo "BUILD $cmd ok"; flags="$flags -$cmd=/tmp/bin/toml-$cmd"
  else echo "BUILD $cmd fail"; head -c 3000 /tmp/build-$cmd.log; echo; fi
done
[ -z "$flags" ] && exit 0
echo "REPORT-BEGIN"
toml-test test -toml 1.0 -json -timeout 2s -parallel 4 $flags 2>/dev/null
echo "REPORT-END"
