#!/usr/bin/env bash
# The Pi migration sweep's operator mode (docs/operations/pi-durable.md). Secrets never appear in arguments or output.
#
#   pi-sweep.sh status             # the mode, the answering node's AGENT_PI_SWEEP, the cursors, and agents left on legacy
#   pi-sweep.sh off                # every node stops before its next agent (seconds); no deploy
#   pi-sweep.sh dry-run            # report what migrating each agent would do (pi_sweep_agent lines), writing nothing
#   pi-sweep.sh on                 # migrate: needs AGENT_PI_SWEEP=on (infra/apply.sh agent_pi_sweep=on)
#   pi-sweep.sh <mode> --restart   # and start every pass again from the first agent
#   pi-sweep.sh large on|off       # the large pass: sessions too large to copy, one at a time, after the on pass
#
# Calls the runtime (AGENT_URL, default https://run.camelai.com) with the operator token of ADMIN_TENANT (default
# miguel, in AGENT_BILLING_ADMINS).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

command=${1:-}; restart=false
if [[ "$command" == large ]]; then
  [[ "${2:-}" =~ ^(on|off)$ && -z "${3:-}" ]] || usage
  body=$(printf '{"large":"%s"}' "$2")
else
  [[ "${2:-}" == --restart ]] && restart=true
  [[ "$command" =~ ^(status|off|dry-run|on)$ && ( -z "${2:-}" || "$restart" == true ) ]] || usage
  [[ "$command" == status && "$restart" == true ]] && usage
  body=$(printf '{"mode":"%s","restart":%s}' "$command" "$restart")
fi

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
url=${AGENT_URL:-https://run.camelai.com}
# The admin's token goes to curl in a header file, never in arguments.
printf 'Authorization: Bearer %s\n' "$(aws secretsmanager get-secret-value --secret-id "$SECRET_PREFIX/operator-token/${ADMIN_TENANT:-miguel}" --query SecretString --output text)" > "$work/auth"
if [[ "$command" == status ]]; then
  curl -sS --fail-with-body -H @"$work/auth" "$url/v1/operations/pi-sweep" > "$work/reply" || { cat "$work/reply" >&2; echo >&2; exit 1; }
else
  printf '%s' "$body" > "$work/body"
  curl -sS --fail-with-body -X PUT -H @"$work/auth" -H "Content-Type: application/json" --data-binary @"$work/body" "$url/v1/operations/pi-sweep" > "$work/reply" || { cat "$work/reply" >&2; echo >&2; exit 1; }
fi
cat "$work/reply"; echo
