#!/usr/bin/env bash
# One-time cutover of the runtime's durable state from the instance disk to S3.
# Stops the runtime, copies /opt/agent-runtime/data into the state bucket using the
# image already on the instance, then deploys, which installs runtime.defaults.env
# (AGENT_STORAGE=s3) and restarts. The disk copy stays in place: to go back, drop the
# storage lines from instance/runtime.defaults.env and run deploy.sh.
# Usage: infra/migrate-to-s3.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }
defaults="$here/instance/runtime.defaults.env"
setting() { sed -n "s/^$1=//p" "$defaults"; }
bucket=$(setting AGENT_S3_BUCKET); prefix=$(setting AGENT_S3_PREFIX)
[[ "$(setting AGENT_STORAGE)" == s3 && -n "$bucket" && -n "$prefix" ]] || { echo "Set AGENT_STORAGE=s3, AGENT_S3_BUCKET and AGENT_S3_PREFIX in $defaults first" >&2; exit 1; }

instance=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
remote=$(cat <<SH
set -euo pipefail
image=\$(cat /opt/agent-runtime/image)
docker run --rm --entrypoint test "\$image" -f src/migrate-storage.ts || { echo "the installed image has no migration tool; run deploy.sh first" >&2; exit 1; }
systemctl stop agent-runtime.service
docker run --rm --user 1000:1000 --volume /opt/agent-runtime/data:/data:ro \
  -e AGENT_STORAGE=s3 -e AGENT_S3_BUCKET=$bucket -e AGENT_S3_PREFIX=$prefix -e AWS_REGION=$REGION \
  "\$image" node --experimental-strip-types --disable-warning=ExperimentalWarning src/migrate-storage.ts /data
SH
)
echo "==> Stopping the runtime and copying its state to s3://$bucket/$prefix"
params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$(printf 'echo %s | base64 -d | bash' "$(printf '%s' "$remote" | base64 | tr -d '\n')")")
command_id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --comment "migrate state to s3" --parameters "$params" --query Command.CommandId --output text)
for _ in $(seq 1 90); do
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)
  [[ "$status" == Pending || "$status" == InProgress || "$status" == Delayed ]] || break
  sleep 2
done
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query '[StandardOutputContent,StandardErrorContent]' --output text
if [[ "$status" != Success ]]; then
  echo "migration failed ($status). If the runtime was stopped, revert the storage lines in $defaults and run deploy.sh to restart it on disk state." >&2
  exit 1
fi
echo "==> Deploying with S3 storage"
exec "$here/deploy.sh"
