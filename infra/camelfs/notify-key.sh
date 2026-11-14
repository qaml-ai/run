#!/usr/bin/env bash
# The camelFS notify webhook HMAC key (camel-fs-files.md §9.11; infra/camelfs/terraform/secrets.tf): the tier signs
# every delivery to <runtime>/v1/internal/camelfs/notify with it (Camel-Signature: t=…,v1=hex hmac-sha256(key,
# t + "." + body)) and the runtime verifies with the same value. Separate from every token key.
#   infra/camelfs/notify-key.sh new     generate 32 random bytes (hex), store them as camelfs/prod/notify-key, roll the
#                                       api service so every task signs with it, and print the runtime's command
#   infra/camelfs/notify-key.sh show    print the key's length and age, never the key
# A rotation is `new` followed by the runtime's `wrangler secret put` with the printed value; between the two, the
# runtime rejects deliveries (the tier retries them, §9.11: at least once).
# Needs AWS credentials for the runtime's account, openssl, jq.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
export AWS_REGION=$REGION
secret=camelfs/prod/notify-key
cluster=camelfs-prod
service=camelfs-prod-api

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }

case "${1:-}" in
  new)
    key=$(openssl rand -hex 32)
    aws secretsmanager put-secret-value --secret-id "$secret" --secret-string "$key" >/dev/null
    echo "Stored a new notify key in $secret."
    if aws ecs describe-services --cluster "$cluster" --services "$service" --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
      aws ecs update-service --cluster "$cluster" --service "$service" --force-new-deployment >/dev/null
      echo "Rolling $service so every task signs with it."
    fi
    echo "Give the runtime the same value (it verifies with it), without echoing it anywhere else:"
    echo "  aws secretsmanager get-secret-value --secret-id $secret --query SecretString --output text | (cd backends/workers && npx wrangler secret put CAMELFS_NOTIFY_KEY --config wrangler.pilot.jsonc)"
    ;;
  show)
    aws secretsmanager describe-secret --secret-id "$secret" --query '{created: CreatedDate, lastChanged: LastChangedDate}' --output json
    echo "length: $(aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text | tr -d '\n' | wc -c) hex chars"
    ;;
  *)
    sed -n '2,10p' "$0" >&2; exit 2 ;;
esac
