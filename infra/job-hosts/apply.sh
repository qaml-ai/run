#!/usr/bin/env bash
# Guarded Terraform apply for the job-host pools (infra/job-hosts/terraform), modelled on infra/apply.sh. Every run:
#   1. fetches the pools' settings (job-hosts/prod.tfvars in the state bucket; none yet on the first run) and applies
#      any <variable>=<value> arguments to them, showing the change;
#   2. plans against them and lists every resource change;
#   3. refuses a plan that deletes or replaces anything, unless ALLOW_DESTROY names every such address (space
#      separated);
#   4. applies the saved plan only after you type "apply" (or CONFIRM=apply when not at a terminal), and only then
#      uploads the changed prod.tfvars.
# Without "apply" (PLAN_ONLY=1 skips the prompt) it changes nothing.
# Usage: PLAN_ONLY=1 infra/job-hosts/apply.sh                  plan only
#        infra/job-hosts/apply.sh                              plan and apply main's configuration as it is
#        infra/job-hosts/apply.sh build_ami_id=ami-0123...     change a setting (it is saved to prod.tfvars)
# Needs AWS credentials for the runtime's account, tofu and jq. No Cloudflare token: this module is AWS only.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
export AWS_REGION=$REGION
tfvars_s3=s3://camelai-terraform-state-$ACCOUNT_ID/agent-runtime/job-hosts/prod.tfvars
cd "$here/terraform"

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }
# A stale copy would be loaded too (*.auto.tfvars); the settings come from the bucket, every time.
for stale in *.auto.tfvars terraform.tfvars; do [[ -e $stale ]] && { echo "Remove infra/job-hosts/terraform/$stale first: this script uses the bucket's prod.tfvars." >&2; exit 1; }; done

work=$(mktemp -d -t job-hosts-apply.XXXXXX)
trap 'rm -rf "$work"' EXIT
tfvars=$work/prod.tfvars
echo "==> Fetching job-hosts prod.tfvars"
if head_error=$(aws s3api head-object --bucket "camelai-terraform-state-$ACCOUNT_ID" --key agent-runtime/job-hosts/prod.tfvars 2>&1 >/dev/null); then
  aws s3 cp --only-show-errors "$tfvars_s3" "$tfvars"
elif [[ $head_error == *"Not Found"* || $head_error == *"404"* ]]; then
  echo "    none yet (first run): starting from the module's defaults"
  : > "$tfvars"
else
  echo "Could not read $tfvars_s3: $head_error" >&2; exit 1
fi
cp "$tfvars" "$tfvars.orig"
for setting in "$@"; do
  [[ $setting =~ ^([a-z][a-z0-9_]*)=(.*)$ ]] || { echo "Arguments are <variable>=<value>, not '$setting'." >&2; exit 2; }
  key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
  [[ $value =~ ^[0-9]+$|^true$|^false$|^\".*\"$|^\[.*\]$ ]] || value="\"$value\""
  grep -Ev "^[[:space:]]*${key}[[:space:]]*=" "$tfvars" > "$tfvars.new" || true
  mv "$tfvars.new" "$tfvars"
  echo "$key = $value" >> "$tfvars"
done
if ! diff -q "$tfvars.orig" "$tfvars" >/dev/null; then echo "    prod.tfvars change:"; diff "$tfvars.orig" "$tfvars" | sed 's/^/      /' || true; fi

echo "==> tofu init"; tofu init -input=false >/dev/null
plan=$work/plan
echo "==> tofu plan"
tofu plan -input=false -no-color -lock-timeout=60s -var-file="$tfvars" -out="$plan" >"$work/plan.log" 2>&1 || { cat "$work/plan.log"; exit 1; }
# Check-block warnings (the live trust-policy check) are worth seeing even when the plan succeeds.
grep -A4 '^Warning:' "$work/plan.log" || true
tofu show -json "$plan" > "$plan.json"
jq -r '.resource_changes[] | select(.change.actions != ["no-op"] and .change.actions != ["read"]) | "\(.change.actions | join("+"))\t\(.address)"' "$plan.json" | LC_ALL=C sort > "$plan.changes"
echo; echo "==> Changes"
if [[ -s "$plan.changes" ]]; then column -t -s $'\t' "$plan.changes"; else echo "    none"; fi
grep -E '^Plan:|No changes' "$work/plan.log" || true

# Deletes and replacements only by name.
allowed=" ${ALLOW_DESTROY:-} "
for address in $(awk -F'\t' '$1 ~ /delete/ {print $2}' "$plan.changes"); do
  [[ "$allowed" == *" $address "* ]] || { echo "!! The plan deletes or replaces $address. Not applying (name it in ALLOW_DESTROY if that is intended)." >&2; exit 1; }
done

if [[ ! -s "$plan.changes" ]] && diff -q "$tfvars.orig" "$tfvars" >/dev/null; then echo "Nothing to do."; exit 0; fi
[[ ${PLAN_ONLY:-} == 1 ]] && { echo "PLAN_ONLY=1: not applied; prod.tfvars unchanged."; exit 0; }
if [[ -t 0 ]]; then read -r -p "Type apply to apply this plan and save prod.tfvars: " answer; else answer=${CONFIRM:-}; fi
[[ $answer == apply ]] || { echo "Not applied; prod.tfvars unchanged."; exit 0; }
tofu apply -input=false "$plan"
if ! diff -q "$tfvars.orig" "$tfvars" >/dev/null; then
  aws s3 cp --only-show-errors "$tfvars" "$tfvars_s3"; echo "    prod.tfvars saved"
fi
echo; echo "==> Outputs"; tofu output
