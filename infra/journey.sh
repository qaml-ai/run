#!/usr/bin/env bash
# Store the two journey signing secrets, then roll the ECS service: journey events (src/journey.ts) and the admin
# site's reports (src/admin-report.ts) stay off until both have values. Each is a Standard Webhooks secret,
# whsec_<base64 of 16 bytes or more>, and the same value must be set on the analytics store's side: the first as
# its event secret, the second as its report secret. They must differ.
#
# Usage: infra/journey.sh <file with the event secret> <file with the report secret>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

[[ $# -eq 2 && -r $1 && -r $2 ]] || { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
umask 077
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 -c 'import base64, re, sys
values = [open(path).read().strip() for path in sys.argv[1:3]]
for name, value in zip(("event", "report"), values):
    if not re.fullmatch(r"whsec_[A-Za-z0-9+/]+={0,2}", value) or len(base64.b64decode(value[6:])) < 16:
        sys.exit(f"The {name} secret is not whsec_<base64 of 16 bytes or more>")
if values[0] == values[1]: sys.exit("The two secrets must differ")
for value, out in zip(values, sys.argv[3:5]): open(out, "w").write(value)' "$1" "$2" "$work/journey" "$work/journey-report"
for name in journey journey-report; do
  id="$SECRET_PREFIX/$name"
  aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/$name" >/dev/null
  echo "Stored $id."
done
# Tasks read these secrets at startup; roll the service so new tasks pick them up.
aws ecs update-service --region "$REGION" --cluster "$NAME" --service "$NAME" --force-new-deployment >/dev/null
echo "Rolling the ECS service to turn on journey events."
