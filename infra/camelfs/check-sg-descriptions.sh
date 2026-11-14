#!/usr/bin/env bash
# Security group rule descriptions must use only the characters AWS accepts (EC2 InvalidParameterValue otherwise):
# a-z A-Z 0-9, space and . _ - : / ( ) # , @ [ ] + = & ; { } ! $ *. A plan does not catch this; only the apply does,
# halfway through. apply.sh runs this before init/plan; run it by hand from infra/camelfs after editing terraform/.
set -euo pipefail
cd "$(dirname "$0")/terraform"
bad=$(awk '
  /^resource "aws_(vpc_)?security_group(_ingress|_egress)?(_rule)?"/ { in_sg = 1 }
  in_sg && /^}/ { in_sg = 0 }
  in_sg && match($0, /^[[:space:]]*description[[:space:]]*=[[:space:]]*"(.*)"[[:space:]]*$/) {
    value = $0; sub(/^[[:space:]]*description[[:space:]]*=[[:space:]]*"/, "", value); sub(/"[[:space:]]*$/, "", value)
    if (value !~ /^[a-zA-Z0-9. _:\/()#,@+=&;{}!$*\[\]-]*$/) printf "%s:%d: %s\n", FILENAME, FNR, value
  }' ./*.tf)
if [[ -n $bad ]]; then
  echo "Security group descriptions with characters AWS refuses (allowed: a-zA-Z0-9 space . _ - : / ( ) # , @ [ ] + = & ; { } ! \$ *):" >&2
  echo "$bad" >&2
  exit 1
fi
