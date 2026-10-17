#!/usr/bin/env bash
# Guarded Terraform apply for the hosted runtime (infra/terraform). Every run:
#   1. fetches production's settings (prod.tfvars, in the state bucket; infra/terraform/README.md, "Plan and apply")
#      and applies any <variable>=<value> arguments to them, showing the change;
#   2. plans against them and lists every resource change, and the task definition's environment changes;
#   3. refuses a plan that deletes or replaces anything, unless ALLOW_DESTROY names every such address (space
#      separated); the Terraform-registered task definition revision is replaced by any change to it and is allowed
#      (the service runs the revision infra/ecs-deploy.sh registered; the change ships with the next deploy);
#   4. applies the saved plan only after you type "apply" (or CONFIRM=apply when not at a terminal), and only then
#      uploads the changed prod.tfvars.
# Without "apply" (PLAN_ONLY=1 skips the prompt) it changes nothing.
# Usage: infra/apply.sh                                  plan and apply main's configuration as it is
#        infra/apply.sh service_min_count=3              change a setting (it is saved to prod.tfvars)
# Needs AWS credentials for the runtime's account, CLOUDFLARE_API_TOKEN (DNS edit on camelai.dev and camelai.com),
# tofu and jq.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
export AWS_REGION=$REGION
tfvars_s3=s3://camelai-terraform-state-$ACCOUNT_ID/agent-runtime/prod.tfvars
cd "$here/terraform"

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }
[[ -n "${CLOUDFLARE_API_TOKEN:-}" && ${#CLOUDFLARE_API_TOKEN} -ge 20 && $CLOUDFLARE_API_TOKEN =~ ^[A-Za-z0-9_-]+$ ]] \
  || { echo "Set CLOUDFLARE_API_TOKEN to a Cloudflare API token with DNS edit on camelai.dev and camelai.com (not a placeholder)." >&2; exit 1; }
# A stale copy would be loaded too (*.auto.tfvars); the settings come from the bucket, every time.
for stale in *.auto.tfvars; do [[ -e $stale ]] && { echo "Remove infra/terraform/$stale first: this script uses the bucket's prod.tfvars." >&2; exit 1; }; done

work=$(mktemp -d -t agent-runtime-apply.XXXXXX)
trap 'rm -rf "$work"' EXIT
tfvars=$work/prod.tfvars
echo "==> Fetching prod.tfvars"
aws s3 cp --only-show-errors "$tfvars_s3" "$tfvars"
cp "$tfvars" "$tfvars.orig"
for setting in "$@"; do
  [[ $setting =~ ^([a-z_]+)=(.*)$ ]] || { echo "Arguments are <variable>=<value>, not '$setting'." >&2; exit 2; }
  key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
  [[ $value =~ ^[0-9]+$|^true$|^false$|^\".*\"$ ]] || value="\"$value\""
  grep -Ev "^[[:space:]]*${key}[[:space:]]*=" "$tfvars" > "$tfvars.new" || true
  mv "$tfvars.new" "$tfvars"
  echo "$key = $value" >> "$tfvars"
done
if ! diff -q "$tfvars.orig" "$tfvars" >/dev/null; then echo "    prod.tfvars change:"; diff "$tfvars.orig" "$tfvars" | sed 's/^/      /' || true; fi

echo "==> tofu init"; tofu init -input=false >/dev/null
plan=$work/plan
echo "==> tofu plan"
tofu plan -input=false -no-color -lock-timeout=60s -var-file="$tfvars" -out="$plan" >"$work/plan.log" 2>&1 || { cat "$work/plan.log"; exit 1; }
tofu show -json "$plan" > "$plan.json"
jq -r '.resource_changes[] | select(.change.actions != ["no-op"] and .change.actions != ["read"]) | "\(.change.actions | join("+"))\t\(.address)"' "$plan.json" | LC_ALL=C sort > "$plan.changes"
echo; echo "==> Changes"
if [[ -s "$plan.changes" ]]; then column -t -s $'\t' "$plan.changes"; else echo "    none"; fi
grep -E '^Plan:|No changes' "$work/plan.log" || true

# The environment is where most settings land; show it as name changes, not one JSON string.
jq -r '.resource_changes[] | select(.address == "aws_ecs_task_definition.runtime" and .change.actions != ["no-op"])
  | [.change.before, .change.after] | map(if . == null then {} else (.container_definitions // "[]" | fromjson | .[0].environment // [] | map({(.name): .value}) | add // {}) end)
  | . as [$before, $after] | ($before + $after | keys[]) as $name | select($before[$name] != $after[$name])
  | "    \($name): \($before[$name] // "(unset)") -> \($after[$name] // "(unset)")"' "$plan.json" > "$plan.env" 2>/dev/null || true
if [[ -s "$plan.env" ]]; then echo; echo "==> Task definition environment (ships with the next infra/ecs-deploy.sh)"; cat "$plan.env"; fi

# Deletes and replacements only by name.
allowed="aws_ecs_task_definition.runtime ${ALLOW_DESTROY:-}"
for address in $(awk -F'\t' '$1 ~ /delete/ {print $2}' "$plan.changes"); do
  [[ " $allowed " == *" $address "* ]] || { echo "!! The plan deletes or replaces $address. Not applying (name it in ALLOW_DESTROY if that is intended)." >&2; exit 1; }
done

if [[ ! -s "$plan.changes" ]] && diff -q "$tfvars.orig" "$tfvars" >/dev/null; then echo "Nothing to do."; exit 0; fi
[[ ${PLAN_ONLY:-} == 1 ]] && { echo "PLAN_ONLY=1: not applied; prod.tfvars unchanged."; exit 0; }
if [[ -t 0 ]]; then read -r -p "Type apply to apply this plan and save prod.tfvars: " answer; else answer=${CONFIRM:-}; fi
[[ $answer == apply ]] || { echo "Not applied; prod.tfvars unchanged."; exit 0; }
tofu apply -input=false "$plan"
if ! diff -q "$tfvars.orig" "$tfvars" >/dev/null; then
  aws s3 cp --only-show-errors "$tfvars" "$tfvars_s3"; echo "    prod.tfvars saved"
fi
