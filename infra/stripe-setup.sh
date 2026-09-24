#!/usr/bin/env zsh
# Set up Stripe for credit purchases with as little dashboard as Stripe allows:
#   1. opens the dashboard's "create restricted key" page, prefilled (name and the two
#      permissions the runtime needs); click Create, copy the key, paste it here (hidden)
#   2. creates the webhook endpoint with the Stripe CLI (already logged in) and takes
#      its signing secret from the response
#   3. hands both to infra/stripe.sh, which stores them in Secrets Manager and rolls the service
# Nothing secret is printed.
#
# Usage: infra/stripe-setup.sh [test|live]   (default test)
set -euo pipefail
mode=${1:-test}
[[ $mode == test || $mode == live ]] || { echo "usage: $0 [test|live]"; exit 2; }
here=${0:A:h}
url=https://agents.camelai.dev/v1/billing/stripe/webhook
cli=(stripe); [[ $mode == live ]] && cli+=(--live)
dash=https://dashboard.stripe.com; [[ $mode == test ]] && dash+=/test

existing=$("${cli[@]}" webhook_endpoints list --limit 100 2>/dev/null | jq -r --arg url $url '.data[] | select(.url == $url) | .id')
if [[ -n $existing ]]; then
  echo "A $mode webhook for $url already exists ($existing); Stripe shows its secret only at creation."
  echo "Delete it (${cli[*]} webhook_endpoints delete $existing) and run this again, or use infra/stripe.sh directly."
  exit 1
fi

open "$dash/apikeys/create?name=agent-runtime%20credit&permissions%5B%5D=rak_customer_write&permissions%5B%5D=rak_checkout_session_write"
echo "In the page that opened: check the key has Customers: Write and Checkout Sessions: Write, click Create key, copy it."
read -rs "key?Paste the $mode key (hidden), then Enter: "; echo
prefix=rk_${mode}_; [[ $key == $prefix* || $key == sk_${mode}_* ]] || { echo "That isn't a $mode secret or restricted key"; exit 1; }

created=$("${cli[@]}" webhook_endpoints create --url $url \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=checkout.session.async_payment_succeeded" \
  -d "enabled_events[]=charge.refunded" \
  -d "description=agent runtime credit purchases" 2>/dev/null)
secret=$(print -r -- $created | jq -r '.secret // empty')
[[ $secret == whsec_* ]] || { echo "Creating the webhook failed: $(print -r -- $created | jq -c '.error // .' | cut -c1-200)"; exit 1; }
echo "Created the $mode webhook $(print -r -- $created | jq -r .id)."

printf '%s\n%s\n' $key $secret | $here/stripe.sh
unset key secret created
