#!/usr/bin/env bash
# Store the Google OAuth client used for console sign-in, then roll the ECS service.
#
# Create the client first in Google Cloud Console (APIs & Services > Credentials):
#   Application type:              Web application
#   Authorized redirect URI:       https://agents.camelai.dev/console/auth/google/callback
#   Scopes (OAuth consent screen): openid, email, profile
# Terraform creates the secret (google-oauth); until it has a value, Google sign-in is off.
#
# Usage: infra/google-oauth.sh <client-id>   (the client secret is read from stdin)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

client_id=${1:-}
[[ "$client_id" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ ! -t 0 ]] || echo "Paste the client secret, then press Ctrl-D:" >&2
umask 077
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
CLIENT_ID="$client_id" python3 -c 'import json, os, sys
secret = sys.stdin.read().strip()
if not secret: sys.exit("No client secret on stdin")
if secret == os.environ["CLIENT_ID"]: sys.exit("That is the client ID, not the client secret")
if not secret.startswith("GOCSPX-"): sys.exit("That does not look like a Google client secret (GOCSPX-...)")
json.dump({"clientId": os.environ["CLIENT_ID"], "clientSecret": secret}, open(sys.argv[1], "w"))' "$work/google.json"
id="$SECRET_PREFIX/google-oauth"
aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1 || { echo "No secret $id yet: apply Terraform first." >&2; exit 1; }
aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/google.json" >/dev/null
echo "Stored $id."
# Tasks read this secret at startup; roll the service so new tasks pick it up.
aws ecs update-service --region "$REGION" --cluster "$NAME" --service "$NAME" --force-new-deployment >/dev/null
echo "Rolling the ECS service to pick up Google sign-in."
