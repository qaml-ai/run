#!/usr/bin/env bash
# The camelFS service's own Ed25519 key (infra/camelfs/terraform/secrets.tf): the tier signs its boot/stop tokens
# to the hosts' compute listeners with it (camelfs-host+jwt, K4); hosts verify against its public JWKS. Separate
# from the runtime's signer (jwks.sh), which the tier only verifies.
#   infra/camelfs/service-key.sh new     generate a key pair; store the private key as service-signing-key and
#                                        prepend its public JWK to service-verify-keys (keeping the previous key,
#                                        so tokens it signed verify until they expire; older keys are dropped);
#                                        then roll the api service so it signs with the new key
#   infra/camelfs/service-key.sh show    print the verify JWKS and the signing key's kid (never the private key)
#   infra/camelfs/service-key.sh prune   drop every verify key but the newest (after every task signs with it)
# Needs AWS credentials for the runtime's account, openssl (3.x), jq. The secrets must exist (apply.sh creates them).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
export AWS_REGION=$REGION
signing=camelfs/prod/service-signing-key
verify=camelfs/prod/service-verify-keys
cluster=camelfs-prod
service=camelfs-prod-api

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
current_verify() { aws secretsmanager get-secret-value --secret-id "$verify" --query SecretString --output text 2>/dev/null || echo '{"keys":[]}'; }

case "${1:-}" in
  new)
    work=$(mktemp -d -t camelfs-service-key.XXXXXX); trap 'rm -rf "$work"' EXIT
    openssl genpkey -algorithm ed25519 -out "$work/private.pem"
    openssl pkey -in "$work/private.pem" -pubout -out "$work/public.pem"
    # kid: the first 16 hex digits of SHA-256 over the SubjectPublicKeyInfo. x: the raw 32-byte public key, which is
    # the tail of the 44-byte Ed25519 SPKI DER.
    kid=$(openssl pkey -pubin -in "$work/public.pem" -outform DER | openssl dgst -sha256 | awk '{print substr($NF, 1, 16)}')
    x=$(openssl pkey -pubin -in "$work/public.pem" -outform DER | tail -c 32 | b64url)
    jwk=$(jq -nc --arg kid "$kid" --arg x "$x" '{kty: "OKP", crv: "Ed25519", x: $x, kid: $kid, alg: "EdDSA", use: "sig"}')
    # Newest first; the previous newest stays as the second key; anything older goes.
    set=$(current_verify | jq -c --argjson new "$jwk" '{keys: ([$new] + (.keys // [])[:1])}')
    signer=$(jq -nc --arg kid "$kid" --rawfile pem "$work/private.pem" '{kid: $kid, alg: "EdDSA", privateKeyPem: $pem}')
    aws secretsmanager put-secret-value --secret-id "$signing" --secret-string "$signer" >/dev/null
    aws secretsmanager put-secret-value --secret-id "$verify" --secret-string "$set" >/dev/null
    echo "Signing key $kid stored in $signing; $verify now has $(jq '.keys | length' <<<"$set") key(s)."
    if aws ecs describe-services --cluster "$cluster" --services "$service" --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
      aws ecs update-service --cluster "$cluster" --service "$service" --force-new-deployment >/dev/null
      echo "Rolling $service so every task signs with $kid. Hosts read $verify at their next start (or SIGHUP)."
    else
      echo "No api service yet: tasks will read the key when the service is created."
    fi
    ;;
  show)
    echo "signing kid: $(aws secretsmanager get-secret-value --secret-id "$signing" --query SecretString --output text | jq -r .kid)"
    echo "verify JWKS:"; current_verify | jq .
    ;;
  prune)
    set=$(current_verify | jq -c '{keys: (.keys // [])[:1]}')
    aws secretsmanager put-secret-value --secret-id "$verify" --secret-string "$set" >/dev/null
    echo "$verify pruned to $(jq -r '.keys[0].kid' <<<"$set")."
    ;;
  *)
    sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
