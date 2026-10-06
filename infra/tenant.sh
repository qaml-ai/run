#!/usr/bin/env bash
# Manage agent runtime tenants. Secrets never appear in arguments or output.
#
#   tenant.sh list
#   tenant.sh add <tenant>                      # creates an operator token (stored in Secrets Manager)
#   tenant.sh set-key <tenant> <provider>       # reads the provider API key from stdin, e.g. anthropic
#   tenant.sh rotate-token <tenant>             # replaces the operator token; the old one stops working
#   tenant.sh remove <tenant>                   # removes the tenant (its agents stay on disk, unreachable: delete them through the API first)
#   tenant.sh link-github <tenant> <login>      # console sign-in as that GitHub account (by its numeric id, looked up now) uses this tenant
#   tenant.sh set-limit <tenant> <n|default>    # busy agents across the fleet for this tenant (default: its usage tier, or AGENT_MAX_AGENTS_PER_TENANT)
#   tenant.sh set-spend-limit <tenant> <usd|none>  # model spend per UTC month, e.g. 250 or 99.50 (default: none, unlimited)
#   tenant.sh set-engine <tenant> <quickjs|v8|default>  # what runs its js_exec (default: the runtime's, AGENT_JS_EXEC)
#   tenant.sh set-password <tenant> <email>     # console sign-in with this email and a password: read from stdin, else generated into a 0600 file
#   tenant.sh set-password <tenant> --clear     # no more password sign-in for this tenant
#
# The operator token is stored at <SECRET_PREFIX>/operator-token/<tenant>. Share it
# through a password manager; anyone holding it controls every agent in that tenant.
# set-password calls the runtime (AGENT_URL, default https://run.camelai.com) with the operator token of
# ADMIN_TENANT (default miguel, in AGENT_BILLING_ADMINS); a generated password goes to PASSWORD_FILE
# (default ~/.config/camelrun/password-<tenant>). Setting or clearing it ends the tenant's password sessions.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

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
    # The account's numeric id: a login can be renamed or freed and taken by someone else.
    tenants[tenant]["githubId"] = int(os.environ["GITHUB_ID"])
elif action == "limit":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    if os.environ["LIMIT"] == "default": tenants[tenant].pop("maxAgents", None)
    else: tenants[tenant]["maxAgents"] = int(os.environ["LIMIT"])
elif action == "spend":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    if os.environ["LIMIT"] == "none": tenants[tenant].pop("maxMonthlyCost", None)
    else: tenants[tenant]["maxMonthlyCost"] = float(os.environ["LIMIT"])
elif action == "engine":
    if tenant not in tenants: sys.exit(f"No tenant {tenant}")
    if os.environ["LIMIT"] == "default": tenants[tenant].pop("codeEngine", None)
    else: tenants[tenant]["codeEngine"] = os.environ["LIMIT"]
elif action == "remove":
    if tenants.pop(tenant, None) is None: sys.exit(f"No tenant {tenant}")
json.dump(data, open(path, "w"))
PY
# edit <add|token|key|github|limit|spend|engine|remove>: stdin stays free for the API key.
edit() { TENANT="$tenant" PROVIDER="${provider:-}" TOKEN_SHA="${token_sha:-}" GITHUB_LOGIN="${login:-}" GITHUB_ID="${github_id:-}" LIMIT="${limit:-}" python3 "$work/edit.py" "$work/tenants.json" "$1"; }
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
for id, v in sorted(t.items()): print(id + "\tproviders: " + (", ".join(sorted(v["apiKeys"])) or "(none)") + "\tmax agents: " + str(v.get("maxAgents", "default")) + "\tmonthly spend limit: " + ("$%.2f" % v["maxMonthlyCost"] if "maxMonthlyCost" in v else "none") + "\tjs_exec engine: " + v.get("codeEngine", "default"))' "$work/tenants.json" ;;
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
    github_id=$(curl -sf "https://api.github.com/users/$login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') || { echo "No GitHub account $login" >&2; exit 1; }
    edit github; save; echo "GitHub user $login (id $github_id) now signs in as $tenant."; reload ;;
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
  set-engine)
    limit=${3:-}
    [[ "$limit" == quickjs || "$limit" == v8 || "$limit" == default ]] || { echo "Usage: $0 set-engine <tenant> <quickjs|v8|default>" >&2; exit 2; }
    edit engine; save
    if [[ "$limit" == default ]]; then echo "$tenant's js_exec runs on the runtime's engine (AGENT_JS_EXEC)."; else echo "$tenant's js_exec runs on $limit."; fi
    echo "Its agents take it as they next load (an agent already loaded keeps its engine until it is)."
    reload ;;
  remove)
    edit remove; save; echo "Removed $tenant. Delete $SECRET_PREFIX/operator-token/$tenant when you no longer need it."; reload ;;
  set-password)
    email=${3:-}
    [[ "$email" == --clear || "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "Usage: $0 set-password <tenant> <email|--clear>  (password on stdin, or generated)" >&2; exit 2; }
    url=${AGENT_URL:-https://run.camelai.com}
    # The admin's token goes to curl in a header file, never in arguments.
    printf 'Authorization: Bearer %s\n' "$(aws secretsmanager get-secret-value --secret-id "$SECRET_PREFIX/operator-token/${ADMIN_TENANT:-miguel}" --query SecretString --output text)" > "$work/auth"
    if [[ "$email" == --clear ]]; then
      curl -sS --fail-with-body -X DELETE -H @"$work/auth" "$url/v1/tenants/$tenant/password" > "$work/reply" || { cat "$work/reply" >&2; echo >&2; exit 1; }
      python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("%s no longer signs in with a password; %d password session(s) ended." % (r["tenant"], r["signedOut"]))' "$work/reply"
      exit 0
    fi
    if [[ ! -t 0 ]]; then cat > "$work/password"; fi
    if [[ ! -s "$work/password" ]]; then
      # About 190 bits: 32 letters and digits. Written before it is set, so a password in use is never lost.
      generated=${PASSWORD_FILE:-$HOME/.config/camelrun/password-$tenant}
      mkdir -p "$(dirname "$generated")"
      python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(32)), end="")' > "$work/password"
      # umask 077 (above) makes a new file 0600; an existing one is made so too.
      cp "$work/password" "$generated"; chmod 600 "$generated"
      echo "Generated password written to $generated (mode 0600). Share it through a password manager, then delete the file."
    fi
    EMAIL="$email" python3 -c 'import json,os,sys; p=open(sys.argv[1]).read().rstrip("\r\n"); json.dump({"email": os.environ["EMAIL"], "password": p}, open(sys.argv[2], "w"))' "$work/password" "$work/body"
    curl -sS --fail-with-body -X PUT -H @"$work/auth" -H "Content-Type: application/json" --data-binary @"$work/body" "$url/v1/tenants/$tenant/password" > "$work/reply" || { cat "$work/reply" >&2; echo >&2; exit 1; }
    python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("%s signs in as %s at the console and the MCP consent page; %d password session(s) ended." % (r["tenant"], r["email"], r["signedOut"]))' "$work/reply" ;;
  *) usage ;;
esac
