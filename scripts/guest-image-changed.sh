#!/usr/bin/env bash
# Exit 0 when <base>..<head> touches a guest image input (camelfsd/scripts/guest-inputs.txt: exact paths; a trailing /
# is a directory), 1 when it does not. An unknown range (no base, or a base git cannot resolve) counts as changed.
set -euo pipefail
base=${1:-} head=${2:?usage: guest-image-changed.sh <base> <head> [range-operator]}
op=${3:-..}
[[ -n $base && $base != 0000000000000000000000000000000000000000 ]] || exit 0
paths=$(git diff --no-renames --name-only "$base$op$head") || exit 0
inputs=$(grep -Ev '^(#|$)' camelfsd/scripts/guest-inputs.txt)
python3 -c '
import sys
inputs = sys.argv[1].split()
paths = [p for p in sys.argv[2].split("\n") if p]
sys.exit(0 if any(p == i or (i.endswith("/") and p.startswith(i)) for p in paths for i in inputs) else 1)
' "$inputs" "$paths"
