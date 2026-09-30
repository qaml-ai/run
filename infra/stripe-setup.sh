#!/usr/bin/env zsh
# Set up Stripe for credit purchases with as little dashboard as Stripe allows:
#   1. opens the dashboard's restricted key page; select the six permissions in the
#      billing runbook, create and copy the key: it is read from the clipboard
#   2. creates the webhook endpoint with the Stripe CLI (already logged in) and takes
#      its signing secret from the response
#   3. stages the webhook disabled and stores keys without rolling the service
# Nothing secret is printed.
#
# Usage: infra/stripe-setup.sh [test|live]   (default test)
set -euo pipefail
mode=${1:-test}
[[ $mode == test || $mode == live ]] || { echo "usage: $0 [test|live]"; exit 2; }
here=${0:A:h}
# Stays on the first address (served for good): one endpoint, so each event is delivered once.
url=https://agents.camelai.dev/v1/billing/stripe/webhook
# The CLI takes --live after the subcommand.
live=(); [[ $mode == live ]] && live=(--live)
dash=https://dashboard.stripe.com; [[ $mode == test ]] && dash+=/test

existing=$(stripe webhook_endpoints list --limit 100 "${live[@]}" 2>/dev/null | jq -r --arg url $url '.data[] | select(.url == $url) | .id')
if [[ -n $existing ]]; then
  echo "A $mode webhook for $url already exists ($existing); Stripe shows its secret only at creation."
  echo "Keep the current endpoint until the coordinated cutover. Prepare a disabled replacement in the dashboard if its API version is old, then use infra/stripe.sh --no-deploy."
  exit 1
fi

open "$dash/apikeys/create"
echo "Create a key with Customers, Checkout Sessions, Customer Portal and Invoices Write; Payment Intents and Payment Methods Read. All others and Connect permissions: None. Copy the key."
# Read from the clipboard rather than a prompt, so this also works where stdin isn't a terminal.
echo "Waiting for a $mode key on the clipboard (15 minutes)..."
key=
for i in {1..900}; do
  clip=$(pbpaste 2>/dev/null | tr -d '[:space:]')
  if [[ $clip == rk_${mode}_* || $clip == sk_${mode}_* ]]; then key=$clip; break; fi
  sleep 1
done
unset clip
[[ -n $key ]] || { echo "No $mode key appeared on the clipboard"; exit 1; }
print -n | pbcopy
echo "Got the key (clipboard cleared)."

created=$(stripe webhook_endpoints create --url $url "${live[@]}" \
  -d "api_version=2026-08-26.dahlia" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=checkout.session.async_payment_succeeded" \
  -d "enabled_events[]=charge.refunded" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed" \
  -d "enabled_events[]=invoice.payment_action_required" \
  -d "enabled_events[]=invoice.voided" \
  -d "description=agent runtime credit purchases" 2>/dev/null)
secret=$(print -r -- $created | jq -r '.secret // empty')
[[ $secret == whsec_* ]] || { echo "Creating the webhook failed: $(print -r -- $created | jq -c '.error // .' | cut -c1-200)"; exit 1; }
echo "Created the $mode webhook $(print -r -- $created | jq -r .id)."
stripe webhook_endpoints update "$(print -r -- $created | jq -r .id)" "${live[@]}" -d "status=disabled" >/dev/null

printf '%s\n%s\n' $key $secret | $here/stripe.sh --no-deploy
echo "The webhook is disabled. Enable it during the billing cutover after the new application is ready."
unset key secret created
