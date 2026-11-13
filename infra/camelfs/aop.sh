#!/usr/bin/env bash
# Authenticated Origin Pulls for fs.camelai.dev (camel-fs-files.md §9.12, infra/camelfs/terraform/mtls.tf): our own
# small offline CA signs the client certificate Cloudflare presents to the public ALB, and the ALB trusts only that
# CA. Never Cloudflare's shared origin-pull certificate.
#   infra/camelfs/aop.sh init              generate the AOP CA (RSA 4096, 10 years) into Secrets Manager
#                                          camelfs/prod/aop-ca, upload its PUBLIC certificate to the trust bucket as
#                                          aop-ca.pem, and print the VersionId to pass as `apply.sh aop_ca_version=…`
#                                          (which creates the trust store and puts the public listener in verify mode)
#   infra/camelfs/aop.sh issue [--zone]    sign a one-year client leaf and upload it to Cloudflare. Default: PER-HOSTNAME
#                                          AOP on fs.camelai.dev only. --zone: ZONE-LEVEL AOP on camelai.dev, which
#                                          changes the certificate Cloudflare presents to EVERY proxied origin in the
#                                          zone (agents.camelai.dev, run-pilot, …): refused if the zone already has a
#                                          custom certificate unless --replace is also given, and then every other
#                                          origin that verifies client certificates must trust this CA first.
#   infra/camelfs/aop.sh status            what Cloudflare reports for the zone and the hostname
#   infra/camelfs/aop.sh test              prove enforcement: the public listener is in verify mode with the AOP
#                                          trust store; a request through Cloudflare answers 200; a request straight
#                                          to the ALB without the certificate is refused (a TLS alert from an allowed
#                                          address, a timeout from anywhere else: the ranges group)
# Needs AWS credentials for the runtime's account, openssl, jq, curl, and CLOUDFLARE_API_TOKEN with
# Zone › SSL and Certificates › Edit on camelai.dev (DNS Edit alone is NOT enough: the origin_tls_client_auth
# endpoints are under SSL and Certificates). The token is checked first and the missing permission named.
# Private keys never touch disk outside a mktemp directory removed on exit, and are never echoed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
export AWS_REGION=$REGION
secret=camelfs/prod/aop-ca
trust_bucket=camelfs-prod-trust-$ACCOUNT_ID
hostname=${AOP_HOSTNAME:-fs.camelai.dev}
zone_name=${AOP_ZONE:-camelai.dev}
api=https://api.cloudflare.com/client/v4

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }
work=$(mktemp -d -t camelfs-aop.XXXXXX); chmod 700 "$work"; trap 'rm -rf "$work"' EXIT

cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
cf_check() {
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || { echo "Set CLOUDFLARE_API_TOKEN (Zone › SSL and Certificates › Edit on $zone_name)." >&2; exit 1; }
  zone=$(cf "$api/zones?name=$zone_name" | jq -r '.result[0].id // empty')
  [[ -n "$zone" ]] || { echo "The token cannot read zone $zone_name (needs Zone › Zone › Read)." >&2; exit 1; }
  # The AOP endpoints live under SSL and Certificates; a token with DNS Edit alone gets 403/10000 here.
  if ! settings=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/zones/$zone/origin_tls_client_auth/settings") || [[ "$(jq -r .success <<<"$settings")" != true ]]; then
    echo "The token cannot read Authenticated Origin Pulls settings for $zone_name: it is missing Zone › SSL and Certificates › Edit (errors: $(jq -c '.errors // empty' <<<"${settings:-{}}"))." >&2; exit 1
  fi
}

case "${1:-}" in
  init)
    if aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text >/dev/null 2>&1; then
      echo "$secret already holds a CA; a new one is a rotation: add it to the trust bundle first, then issue, then retire the old. Not done by this script." >&2; exit 1
    fi
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$work/ca.key" 2>/dev/null
    openssl req -x509 -new -key "$work/ca.key" -sha256 -days 3650 -subj "/O=camelAI/CN=camelFS origin pulls CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$work/ca.pem"
    not_after=$(openssl x509 -in "$work/ca.pem" -noout -enddate | cut -d= -f2)
    jq -n --rawfile cert "$work/ca.pem" --rawfile key "$work/ca.key" --arg notAfter "$not_after" '{caCertPem: $cert, caKeyPem: $key, notAfter: $notAfter}' > "$work/secret.json"
    aws secretsmanager put-secret-value --secret-id "$secret" --secret-string "file://$work/secret.json" >/dev/null
    version=$(aws s3api put-object --bucket "$trust_bucket" --key aop-ca.pem --body "$work/ca.pem" --content-type application/x-pem-file --query VersionId --output text)
    echo "AOP CA stored in $secret (expires $not_after); public certificate at s3://$trust_bucket/aop-ca.pem version $version."
    echo "Next: PLAN_ONLY=1 infra/camelfs/apply.sh aop_ca_version=$version   # creates the trust store, public listener → verify"
    ;;
  issue)
    shift; mode=hostname; replace=
    for arg in "$@"; do case "$arg" in --zone) mode=zone ;; --replace) replace=1 ;; *) echo "unknown option $arg" >&2; exit 2 ;; esac; done
    cf_check
    aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text > "$work/secret.json" || { echo "No AOP CA yet: run aop.sh init." >&2; exit 1; }
    jq -r .caCertPem "$work/secret.json" > "$work/ca.pem"; jq -r .caKeyPem "$work/secret.json" > "$work/ca.key"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$work/leaf.key" 2>/dev/null
    # A slash in the CN would start a new RDN and openssl refuses it; a dot does the naming.
    openssl req -new -key "$work/leaf.key" -subj "/O=camelAI/CN=cloudflare-origin-pull.$hostname" -out "$work/leaf.csr"
    printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > "$work/leaf.ext"
    openssl x509 -req -in "$work/leaf.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -days 365 -sha256 -extfile "$work/leaf.ext" -out "$work/leaf.pem" 2>/dev/null
    openssl verify -purpose sslclient -CAfile "$work/ca.pem" "$work/leaf.pem" >/dev/null
    jq -n --rawfile certificate "$work/leaf.pem" --rawfile private_key "$work/leaf.key" '{certificate: $certificate, private_key: $private_key}' > "$work/upload.json"
    if [[ $mode == hostname ]]; then
      cert_id=$(cf -X POST "$api/zones/$zone/origin_tls_client_auth/hostnames/certificates" --data @"$work/upload.json" | jq -r .result.id)
      cf -X PUT "$api/zones/$zone/origin_tls_client_auth/hostnames" --data "$(jq -nc --arg h "$hostname" --arg id "$cert_id" '{config: [{hostname: $h, cert_id: $id, enabled: true}]}')" >/dev/null
      echo "Per-hostname AOP enabled on $hostname with certificate $cert_id (expires in 365 days: diary it)."
    else
      existing=$(cf "$api/zones/$zone/origin_tls_client_auth" | jq -r '[.result[]? | select(.status != "deleted") | .id] | join(" ")')
      if [[ -n "$existing" && -z "$replace" ]]; then
        echo "Zone-level AOP on $zone_name already has certificate(s) $existing: replacing them changes what Cloudflare presents to EVERY proxied origin in the zone. Make sure each origin that verifies client certificates (the runtime's ALB, infra/terraform/origin-mtls.tf) trusts this CA first, then re-run with --zone --replace." >&2; exit 1
      fi
      cert_id=$(cf -X POST "$api/zones/$zone/origin_tls_client_auth" --data @"$work/upload.json" | jq -r .result.id)
      cf -X PUT "$api/zones/$zone/origin_tls_client_auth/settings" --data '{"enabled": true}' >/dev/null
      echo "Zone-level AOP enabled on $zone_name with certificate $cert_id (expires in 365 days: diary it)."
    fi
    echo "Verify from an allowed path: curl --connect-to $hostname:443:<public ALB dns>:443 https://$hostname/v0/health must fail without the certificate and succeed through Cloudflare."
    ;;
  test)
    alb=$(aws elbv2 describe-load-balancers --names camelfs-prod-public --query 'LoadBalancers[0].[LoadBalancerArn,DNSName]' --output text)
    alb_arn=${alb%%	*}; alb_dns=${alb##*	}
    listener=$(aws elbv2 describe-listeners --load-balancer-arn "$alb_arn" --query 'Listeners[?Port==`443`].MutualAuthentication | [0]' --output json)
    mode=$(jq -r '.Mode // "off"' <<<"$listener"); store=$(jq -r '.TrustStoreArn // ""' <<<"$listener"); ignore=$(jq -r '.IgnoreClientCertificateExpiry // false' <<<"$listener")
    echo "listener 443: mode=$mode trust_store=${store##*/} ignore_expiry=$ignore"
    [[ $mode == verify && $store == *":truststore/camelfs-prod-aop/"* && $ignore == false ]] || { echo "FAIL: the public listener is not verifying against the AOP trust store (apply aop_ca_version first)." >&2; exit 1; }
    # Through Cloudflare. 200: the whole path works. 503 from the ALB with no healthy target (the service at
    # api_min_count 0) still proves Cloudflare's certificate passed the handshake, since a TLS failure at the origin
    # is Cloudflare's own 525 (handshake failed) or 526 (invalid certificate), never the ALB's 503.
    running=$(aws ecs describe-services --cluster camelfs-prod --services camelfs-prod-api --query 'services[0].runningCount' --output text 2>/dev/null || echo 0)
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$hostname/v0/health" || true)
    echo "through Cloudflare: HTTP $code (running tasks: $running)"
    case "$code" in
      200) ;;
      503) [[ "$running" == 0 ]] && echo "503 from the ALB with no healthy target: mTLS OK, no tasks yet (api_min_count 0)." \
             || { echo "FAIL: 503 through Cloudflare with $running task(s) running: the targets are unhealthy, not a certificate problem." >&2; exit 1; } ;;
      525|526) echo "FAIL: Cloudflare could not complete the TLS handshake with the origin ($code): the leaf is not what the listener's trust store expects (aop.sh status; aop_ca_version)." >&2; exit 1 ;;
      *) echo "FAIL: https://$hostname/v0/health answered $code through Cloudflare (is the leaf uploaded and enabled? aop.sh status)." >&2; exit 1 ;;
    esac
    # Straight at the ALB with the hostname as SNI and no client certificate. From an address the ranges group
    # admits this ends in a TLS alert (curl 35/56): the handshake itself is refused. From anywhere else the
    # connection times out (curl 28): that proves the security group, not mTLS; say which.
    set +e; curl -sS -o /dev/null --max-time 10 --connect-to "$hostname:443:$alb_dns:443" "https://$hostname/v0/health" 2>"$work/direct.err"; rc=$?; set -e
    case $rc in
      0) echo "FAIL: the ALB answered a request without a client certificate." >&2; exit 1 ;;
      35|56) echo "direct to the ALB without the certificate: refused at the TLS handshake (curl $rc). PASS." ;;
      28|7) echo "direct to the ALB: no connection from here (curl $rc), which is the Cloudflare-ranges group, not mTLS. Re-run from an address the group admits to see the handshake refused." ;;
      *) echo "direct to the ALB: curl exit $rc: $(cat "$work/direct.err")" ;;
    esac
    ;;
  status)
    cf_check
    echo "zone-level: $(cf "$api/zones/$zone/origin_tls_client_auth/settings" | jq -c .result)"
    echo "zone certificates: $(cf "$api/zones/$zone/origin_tls_client_auth" | jq -c '[.result[]? | {id, status, expires_on}]')"
    echo "hostname $hostname: $(cf "$api/zones/$zone/origin_tls_client_auth/hostnames/$hostname" | jq -c .result)"
    ;;
  *)
    sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
