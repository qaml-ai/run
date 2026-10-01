#!/usr/bin/env bash
# Manage agent runtime tenants. Secrets never appear in arguments or output.
#
#   tenant.sh list
#   tenant.sh add <tenant>                      # creates an operator token (stored in Secrets Manager)
#   tenant.sh set-key <tenant> <provider>       # reads the provider API key from stdin, e.g. anthropic
#   tenant.sh rotate-token <tenant>             # replaces the operator token; the old one stops working
#   tenant.sh remove <tenant>                   # removes the tenant (its agents stay on disk, unreachable: delete them through the API first)
#   tenant.sh link-github <tenant> <login>      # console sign-in with that GitHub login uses this tenant
#   tenant.sh set-limit <tenant> <n|default>    # busy agents across the fleet for this tenant (default: its usage tier, or AGENT_MAX_AGENTS_PER_TENANT)
#   tenant.sh set-spend-limit <tenant> <usd|none>  # model spend per UTC month, e.g. 250 or 99.50 (default: none, unlimited)
#
# The operator token is stored at <SECRET_PREFIX>/operator-token/<tenant>. Share it
# through a password manager; anyone holding it controls every agent in that tenant.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }
usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

command=${1:-}; tenant=${2:-}
[[ -n "$command" ]] || usage
if [[ "$command" != list ]]; then
  [[ "$tenant" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "Tenant ids are lowercase letters, digits and dashes (max 40)" >&2; exit 2; }
fi

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
aws secretsmanager get-secret-value --secret-id "$SECRET_PREFIX/tenants" --query SecretString --output text > "$work/tenants.json"

cat > "$work/edit.py" <<'PY'
import json, os, sys
path, action = sys.argv[1], sys.argv[2]
data = json.load(open(path))
tenants, tenant = data["tenants"], os.environ["TENANT"]
if action == "add":
    if tenant in tenants: sys.exit(f"Tenant {tenant} already exists")
    tenants[tenant] = {"tokenSha256": os.environ["TOKEN_SHA"], "apiKeys": {}}
elif action == "token":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    tenants[tenant]["tokenSha256"] = os.environ["TOKEN_SHA"]
elif action == "key":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    key = sys.stdin.read().strip()
    if not key: sys.exit("No API key on stdin")
    tenants[tenant]["apiKeys"][os.environ["PROVIDER"]] = key
elif action == "github":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    tenants[tenant]["github"] = os.environ["GITHUB_LOGIN"]
elif action == "limit":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    if os.environ["LIMIT"] == "default": tenants[tenant].pop("maxAgents", None)
    else: tenants[tenant]["maxAgents"] = int(os.environ["LIMIT"])
elif action == "spend":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    if os.environ["LIMIT"] == "none": tenants[tenant].pop("maxMonthlyCost", None)
    else: tenants[tenant]["maxMonthlyCost"] = float(os.environ["LIMIT"])
elif action == "remove":
    if tenants.pop(tenant, None) is None: sys.exit(f"No tenant {tenant}")
json.dump(data, open(path, "w"))
PY
# edit <add|token|key|github|limit|spend|remove>: stdin stays free for the API key.
edit() { TENANT="$tenant" PROVIDER="${provider:-}" TOKEN_SHA="${token_sha:-}" GITHUB_LOGIN="${login:-}" LIMIT="${limit:-}" python3 "$work/edit.py" "$work/tenants.json" "$1"; }
save() { aws secretsmanager put-secret-value --secret-id "$SECRET_PREFIX/tenants" --secret-string "file://$work/tenants.json" >/dev/null; }
new_token() {
  printf 'art_%s' "$(openssl rand -hex 32)" > "$work/token"
  token_sha=$(shasum -a 256 < "$work/token" | cut -d' ' -f1)
}
store_token() {
  local id="$SECRET_PREFIX/operator-token/$tenant"
  if aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/token" >/dev/null
  else
    aws secretsmanager create-secret --name "$id" --description "Agent runtime operator token for tenant $tenant" --secret-string "file://$work/token" >/dev/null
  fi
  echo "Operator token stored in Secrets Manager: $id"
  echo "Retrieve it with: aws secretsmanager get-secret-value --region $REGION --secret-id $id --query SecretString --output text"
}
reload() {
  # ECS tasks re-read the tenants secret every minute (AGENT_TENANTS_SECRET_ARN).
  echo "The runtime picks this up within a minute (no restart, running agents unaffected)."
}

case "$command" in
  list)
    python3 -c 'import json,sys; t=json.load(open(sys.argv[1]))["tenants"]
for id, v in sorted(t.items()): print(id + "\tproviders: " + (", ".join(sorted(v["apiKeys"])) or "(none)") + "\tmax agents: " + str(v.get("maxAgents", "default")) + "\tmonthly spend limit: " + ("$%.2f" % v["maxMonthlyCost"] if "maxMonthlyCost" in v else "none"))' "$work/tenants.json" ;;
  add)
    new_token; edit add; save; store_token
    echo "Next: echo -n \"\$KEY\" | $0 set-key $tenant anthropic"
    reload ;;
  rotate-token)
    new_token; edit token; save; store_token; reload ;;
  set-key)
    provider=${3:-}
    [[ "$provider" =~ ^[a-z0-9*][a-z0-9-]*$ ]] || { echo "Usage: $0 set-key <tenant> <provider> < key" >&2; exit 2; }
    [[ ! -t 0 ]] || echo "Paste the $provider API key, then press Ctrl-D:" >&2
    edit key; save; echo "Stored $provider key for $tenant."; reload ;;
  link-github)
    login=${3:-}
    [[ "$login" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "Usage: $0 link-github <tenant> <github-login>" >&2; exit 2; }
    edit github; save; echo "GitHub user $login now signs in as $tenant."; reload ;;
  set-limit)
    limit=${3:-}
    [[ "$limit" == default || "$limit" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "Usage: $0 set-limit <tenant> <n|default>  (n: a positive integer)" >&2; exit 2; }
    edit limit; save
    if [[ "$limit" == default ]]; then echo "$tenant uses the default limit (its usage tier, or AGENT_MAX_AGENTS_PER_TENANT)."; else echo "$tenant may have $limit agents busy at once across the fleet."; fi
    echo "Agents already running above a lowered limit keep running; it gates new starts."
    reload ;;
  set-spend-limit)
    limit=${3:-}
    [[ "$limit" == none || "$limit" =~ ^[0-9]{1,9}(\.[0-9]{1,2})?$ ]] || { echo "Usage: $0 set-spend-limit <tenant> <usd|none>  (usd: e.g. 250 or 99.50)" >&2; exit 2; }
    edit spend; save
    if [[ "$limit" == none ]]; then echo "$tenant has no monthly spend limit."; else echo "$tenant may spend \$$limit per UTC month on models."; fi
    echo "At the limit, new model runs get 402 and a running turn ends after its current model response."
    reload ;;
  remove)
    edit remove; save; echo "Removed $tenant. Delete $SECRET_PREFIX/operator-token/$tenant when you no longer need it."; reload ;;
  *) usage ;;
esac
