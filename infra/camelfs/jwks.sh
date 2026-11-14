#!/usr/bin/env bash
# The camelFS token verification keys (infra/camelfs/terraform/secrets.tf). Tokens are EdDSA/Ed25519 JWTs the
# runtime signs with its existing signer (backends/workers/src/runtime-identity.ts; private keys sealed in its
# Postgres, public keys at <runtime>/.well-known/jwks.json). The api tier verifies against a copy of that public
# JWKS, injected into its tasks as CAMELFS_JWKS from the secret this script fills; it never fetches keys itself.
#   infra/camelfs/jwks.sh set [<file or URL>]   store the JWKS (default: the runtime's /.well-known/jwks.json, the
#                                                runtime being token_issuer in prod.tfvars, or TOKEN_ISSUER), then
#                                                roll the api service so every task restarts with it
#   infra/camelfs/jwks.sh show                   print the stored JWKS and its kids
# A rotation on the runtime side publishes the new key beside the old one; run `set` then, and again after the old
# key is retired. Needs AWS credentials for the runtime's account, curl, jq.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
export AWS_REGION=$REGION
secret=camelfs/prod/token-verify-keys
cluster=camelfs-prod
service=camelfs-prod-api

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }

issuer_from_tfvars() {
  aws s3 cp --only-show-errors "s3://camelai-terraform-state-$ACCOUNT_ID/agent-runtime/camelfs/prod.tfvars" - 2>/dev/null \
    | sed -nE 's/^[[:space:]]*token_issuer[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -1
}

case "${1:-}" in
  set)
    source=${2:-}
    if [[ -z "$source" ]]; then
      issuer=${TOKEN_ISSUER:-$(issuer_from_tfvars)}
      [[ -n "$issuer" ]] || issuer=$(sed -nE '/variable "token_issuer"/,/}/ s/^[[:space:]]*default[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$here/terraform/variables.tf")
      source="$issuer/.well-known/jwks.json"
    fi
    if [[ "$source" == https://* ]]; then jwks=$(curl -fsS "$source"); else jwks=$(cat "$source"); fi
    # The shape the daemon expects: a JWKS of Ed25519 OKP signing keys, each with a kid. Nothing else is stored.
    jwks=$(jq -ce '{keys: [.keys[] | select(.kty == "OKP" and .crv == "Ed25519" and (.use // "sig") == "sig" and (.alg // "EdDSA") == "EdDSA" and (.kid | type) == "string") | {kty, crv, x, kid, alg: "EdDSA", use: "sig"}]} | select((.keys | length) > 0)' <<<"$jwks") \
      || { echo "$source holds no Ed25519 signing key with a kid." >&2; exit 1; }
    aws secretsmanager put-secret-value --secret-id "$secret" --secret-string "$jwks" >/dev/null
    echo "Stored $(jq -r '.keys | length' <<<"$jwks") key(s) from $source: $(jq -r '[.keys[].kid] | join(", ")' <<<"$jwks")"
    if aws ecs describe-services --cluster "$cluster" --services "$service" --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
      aws ecs update-service --cluster "$cluster" --service "$service" --force-new-deployment >/dev/null
      echo "Rolling $service so every task restarts with the new JWKS (watch: aws ecs describe-services --cluster $cluster --services $service)."
    else
      echo "No api service yet: tasks will read the JWKS when the service is created."
    fi
    ;;
  show)
    aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text | jq .
    ;;
  *)
    sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
