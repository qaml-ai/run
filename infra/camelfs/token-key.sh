#!/usr/bin/env bash
# The camelFS token keys (infra/camelfs/terraform/secrets.tf). Tokens (camel-fs.md §1.10) are ES256 JWTs the
# runtime signs and the api tier verifies; two public keys are valid during a rollover.
#   infra/camelfs/token-key.sh new     generate a P-256 key pair; store the private key as the signing secret and
#                                      prepend its public JWK to the verify set (keeping the previous key, so tokens
#                                      it signed verify until they expire; older keys are dropped);
#                                      print the kid and the Workers secret command
#   infra/camelfs/token-key.sh show    print the verify set and the signing key's kid (never the private key)
#   infra/camelfs/token-key.sh prune   drop every verify key but the newest (after every signer uses it)
# Needs AWS credentials for the runtime's account, openssl, jq. The secrets must exist (apply.sh creates them).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
export AWS_REGION=$REGION
signing=camelfs/prod/token-signing-key
verify=camelfs/prod/token-verify-keys

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
current_verify() { aws secretsmanager get-secret-value --secret-id "$verify" --query SecretString --output text 2>/dev/null || echo '{"keys":[]}'; }

case "${1:-}" in
  new)
    work=$(mktemp -d -t camelfs-token-key.XXXXXX); trap 'rm -rf "$work"' EXIT
    openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$work/private.pem"
    openssl pkey -in "$work/private.pem" -pubout -out "$work/public.pem"
    # kid: the first 16 hex digits of SHA-256 over the SubjectPublicKeyInfo. x and y: the last 64 bytes of the DER
    # SPKI are the uncompressed point (04 || x || y) less its leading 04.
    kid=$(openssl pkey -pubin -in "$work/public.pem" -outform DER | openssl dgst -sha256 | awk '{print substr($NF, 1, 16)}')
    openssl pkey -pubin -in "$work/public.pem" -outform DER | tail -c 64 > "$work/xy"
    x=$(head -c 32 "$work/xy" | b64url); y=$(tail -c 32 "$work/xy" | b64url)
    jwk=$(jq -nc --arg kid "$kid" --arg x "$x" --arg y "$y" '{kid: $kid, kty: "EC", crv: "P-256", alg: "ES256", use: "sig", x: $x, y: $y}')
    # Newest first; the previous newest stays as the second key; anything older goes.
    set=$(current_verify | jq -c --argjson new "$jwk" '{keys: ([$new] + (.keys // [])[:1])}')
    signer=$(jq -nc --arg kid "$kid" --rawfile pem "$work/private.pem" '{kid: $kid, alg: "ES256", privateKeyPem: $pem}')
    aws secretsmanager put-secret-value --secret-id "$signing" --secret-string "$signer" >/dev/null
    aws secretsmanager put-secret-value --secret-id "$verify" --secret-string "$set" >/dev/null
    echo "Signing key $kid stored in $signing; verify set now has $(jq '.keys | length' <<<"$set") key(s)."
    echo "Give the runtime the signing key (it reads {kid, alg, privateKeyPem}):"
    echo "  aws secretsmanager get-secret-value --secret-id $signing --query SecretString --output text | wrangler secret put CAMELFS_TOKEN_SIGNING_KEY"
    echo "The api tasks pick the new verify set up at their next boot (redeploy the running tag) or SIGHUP."
    ;;
  show)
    echo "signing kid: $(aws secretsmanager get-secret-value --secret-id "$signing" --query SecretString --output text | jq -r .kid)"
    echo "verify set:"; current_verify | jq .
    ;;
  prune)
    set=$(current_verify | jq -c '{keys: (.keys // [])[:1]}')
    aws secretsmanager put-secret-value --secret-id "$verify" --secret-string "$set" >/dev/null
    echo "Verify set pruned to $(jq -r '.keys[0].kid' <<<"$set")."
    ;;
  *)
    sed -n '2,10p' "$0" >&2; exit 2 ;;
esac
