#!/usr/bin/env bash
# Compare the same 5k-file/3-edit test guest through ack and thaw on both trees.
set -euo pipefail
[[ -e /nvme/host-free ]] || { echo 'freeze before/after skipped: /nvme/host-free is absent';exit 0; }
[[ $EUID == 0 ]] || { echo 'run as root' >&2;exit 1; }
cd "$(dirname "$0")/.."
work=$(mktemp -d /nvme/bench/work/camelfsd-freeze.XXXXXX)
trap 'rm -rf "$work"' EXIT
# Parent of the isolated review-fix commit, containing the original freeze work.
baseline=30d90cc5^
git archive "$baseline" camelfsd | tar -xf - -C "$work"
# Keep the identical measurement harness and guest timer for both versions.
cp internal/image/loop_test.go "$work/camelfsd/internal/image/loop_test.go"
cp internal/testguest/guest.go "$work/camelfsd/internal/testguest/guest.go"
echo '5k-file freeze before (second generation changes exactly three files):'
(cd "$work/camelfsd"; go test ./internal/image -run '^TestLoopFreeze5000$' -count=1 -v)
echo '5k-file freeze after (second generation changes exactly three files):'
go test ./internal/image -run '^TestLoopFreeze5000$' -count=1 -v
