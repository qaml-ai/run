#!/usr/bin/env bash
# Store the Stripe keys used for credit purchases, then roll the ECS service.
#
# In the Stripe dashboard (test mode first, then live):
#   1. Developers > API keys: a secret key (sk_...) or a restricted key (rk_...)
#      with Customers, Checkout Sessions, Customer Portal and Invoices write;
#      Payment Intents and Payment Methods read. See docs/operations/billing.md.
#   2. Developers > Webhooks > Add endpoint:
#        URL:    https://agents.camelai.dev/v1/billing/stripe/webhook
#                (the runtime's first address, served for good: keep the one endpoint there, since a
#                second one at run.camelai.com would deliver, and credit, every event twice)
#        API: 2026-08-26.dahlia. Events: checkout.session.completed,
#        checkout.session.async_payment_succeeded, charge.refunded, charge.dispute.created,
#        charge.dispute.closed, invoice.paid, invoice.payment_failed,
#        invoice.payment_action_required, invoice.voided
#      then reveal its signing secret (whsec_...).
#
# Usage: infra/stripe.sh [--no-deploy] (reads the key and webhook secret from stdin)
# Use --no-deploy for the coordinated billing migration cutover.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

[[ $# -eq 0 || ( $# -eq 1 && $1 == --no-deploy ) ]] || { echo "Usage: $0 [--no-deploy]" >&2; exit 2; }
deploy=true
[[ ${1:-} != --no-deploy ]] || deploy=false
[[ ! -t 0 ]] || echo "Paste the secret key and press Enter, then the webhook signing secret and press Enter, then Ctrl-D:" >&2
umask 077
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 -c 'import json, sys
lines = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
if len(lines) != 2: sys.exit("Send two lines: the secret key, then the webhook signing secret")
key, webhook = lines
if not (key.startswith("sk_") or key.startswith("rk_")): sys.exit("The first line must be a secret (sk_) or restricted (rk_) key, not a publishable key")
if not webhook.startswith("whsec_"): sys.exit("The second line must be the webhook signing secret (whsec_...)")
json.dump({"secretKey": key, "webhookSecret": webhook}, open(sys.argv[1], "w"))
print("Stored a " + ("LIVE" if "_live_" in key else "test") + " mode key.", file=sys.stderr)' "$work/stripe.json"
id="$SECRET_PREFIX/stripe"
if aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/stripe.json" >/dev/null
else
  aws secretsmanager create-secret --name "$id" --description "Stripe secret key and webhook signing secret for agent runtime credit purchases. Set with infra/stripe.sh." --secret-string "file://$work/stripe.json" >/dev/null
fi
echo "Stored $id."
if [[ $deploy == false ]]; then
  echo "Service unchanged. Deploy with the coordinated billing cutover procedure."
  exit 0
fi
# Tasks read this secret at startup; roll the service so new tasks pick it up.
aws ecs update-service --region "$REGION" --cluster "$NAME" --service "$NAME" --force-new-deployment >/dev/null
echo "Rolling the ECS service to turn on credit purchases."
