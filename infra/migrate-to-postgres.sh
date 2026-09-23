#!/usr/bin/env bash
# One-time cutover of the runtime's coordination state (accounts, agent records,
# schedules, channels, volume metadata) from S3 documents to the control-plane Postgres.
#   1. Push and install the new image without restarting (deploy.sh PREPARE_ONLY=1).
#   2. Stop the runtime, then run the migration with the image and the runtime's own
#      configuration, so nothing is recorded in Postgres before the old documents are.
#   3. Deploy, which restarts on Postgres.
# The S3 documents are left in place. Re-running is safe: the migration inserts nothing twice.
# Usage: infra/migrate-to-postgres.sh [--dry-run]   (--dry-run prepares, then reports counts without stopping or writing)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }
flags=${1:-}

echo "==> Preparing the new image (no restart; the running runtime is untouched)"
PREPARE_ONLY=1 "$here/deploy.sh"

instance=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
remote=$(cat <<SH
set -euo pipefail
dir=/opt/agent-runtime
image=\$(cat \$dir/image)
docker run --rm --entrypoint test "\$image" -f src/migrate-coordination.ts || { echo "the installed image has no coordination migration" >&2; exit 1; }
if [[ "$flags" != --dry-run ]]; then systemctl stop agent-runtime.service; fi
\$dir/refresh-config.sh
docker run --rm --user 1000:1000 --env-file \$dir/runtime.env "\$image" \
  node --experimental-strip-types --disable-warning=ExperimentalWarning src/migrate-coordination.ts $flags
SH
)
echo "==> ${flags:+Dry run: }Migrating coordination state into Postgres"
params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$(printf 'echo %s | base64 -d | bash' "$(printf '%s' "$remote" | base64 | tr -d '\n')")")
command_id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --comment "migrate coordination to postgres" --parameters "$params" --query Command.CommandId --output text)
for _ in $(seq 1 90); do
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)
  [[ "$status" == Pending || "$status" == InProgress || "$status" == Delayed ]] || break
  sleep 2
done
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query '[StandardOutputContent,StandardErrorContent]' --output text
if [[ "$status" != Success ]]; then
  echo "migration failed ($status). The runtime may be stopped; fix and re-run this script (it is idempotent)." >&2
  exit 1
fi
[[ "$flags" == --dry-run ]] && exit 0
echo "==> Starting the runtime on Postgres"
exec "$here/deploy.sh"
