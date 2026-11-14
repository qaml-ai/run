#!/usr/bin/env bash
# Prunes guest images the tier no longer allows (ledger L108). Every camelfsd merge publishes a ≈185 MB image
# under <guest_image_location>/<sha256>.{json,ext4.zst} and nothing else deletes them; the tier boots only the
# digests in `guest_images` (camelfsd api --guest-images). This script lists every published image and deletes
# those that are NOT allowed and are older than the grace period; it is run by the operator, with the same
# credentials as apply.sh, after an apply that changed guest_images (the CI publisher deliberately cannot list or
# delete, and widening an OIDC role to delete is the wrong trade; see README.md "Network and security").
#
# The allowed set is the union of guest_images in the bucket's prod.tfvars (what the next deploy ships) and
# --guest-images on the service's running task definition (what the tier accepts now), so an image is never
# pruned while either side still names it. An empty union means compute is not on yet: nothing is pruned.
#
# Dry run by default; it deletes only after you type "prune" (or CONFIRM=prune when not at a terminal). The bucket
# is versioned: a delete leaves a delete marker and the bytes stay recoverable for noncurrent_expiry_days (35),
# then go. Needs AWS credentials for the runtime's account and jq.
# Usage: infra/camelfs/prune-guest-images.sh                 list, then prune after confirmation
#        GRACE_DAYS=14 infra/camelfs/prune-guest-images.sh   keep anything published in the last 14 days (default 7)
#        DRY_RUN=1 infra/camelfs/prune-guest-images.sh       list only
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
aws() { command aws --region "$REGION" "$@"; }
die() { echo "error: $*" >&2; exit 1; }

name=camelfs-prod
bucket=$name-$ACCOUNT_ID
family=$name-api
grace_days=${GRACE_DAYS:-7}
[[ $grace_days =~ ^[0-9]+$ ]] || die "GRACE_DAYS is a whole number of days, not '$grace_days'."

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || die "AWS credentials are not for $ACCOUNT_ID."

work=$(mktemp -d -t camelfs-prune.XXXXXX)
trap 'rm -rf "$work"' EXIT

# The declared set, and the prefix, from the bucket's prod.tfvars (the same settings apply.sh plans with).
aws s3 cp --only-show-errors "s3://camelai-terraform-state-$ACCOUNT_ID/agent-runtime/camelfs/prod.tfvars" "$work/prod.tfvars" \
  || die "Could not read camelfs/prod.tfvars from the state bucket."
tfvar_list() { grep -E "^[[:space:]]*$1[[:space:]]*=" "$work/prod.tfvars" | sed 's/^[^=]*=//' | grep -oE '[0-9a-f]{64}' || true; }
prefix=$(grep -E '^[[:space:]]*guest_image_prefix[[:space:]]*=' "$work/prod.tfvars" | sed -E 's/^[^=]*=[[:space:]]*"(.*)"[[:space:]]*$/\1/' || true)
key_prefix="${prefix}guest/"
tfvar_list guest_images > "$work/allowed.tfvars"

# The running set: --guest-images on the service's current task definition (none when compute is off).
aws ecs describe-task-definition --task-definition "$family" --output json 2>/dev/null \
  | jq -r '.taskDefinition.containerDefinitions[0].command // [] | . as $c | [range(length)] | map(select($c[.] == "--guest-images") | $c[. + 1]) | .[]' 2>/dev/null \
  | tr ',' '\n' | grep -E '^[0-9a-f]{64}$' > "$work/allowed.running" || true

LC_ALL=C sort -u "$work/allowed.tfvars" "$work/allowed.running" > "$work/allowed"
echo "==> Allowed images: $(wc -l < "$work/allowed.tfvars") in prod.tfvars, $(wc -l < "$work/allowed.running") on the running task definition, $(wc -l < "$work/allowed") distinct"
if [[ ! -s "$work/allowed" ]]; then
  echo "    none: compute is not on (guest_images is empty and the service carries no --guest-images). Nothing to prune."
  exit 0
fi

# Every published image: one manifest per sha, its publish time, and the blob's size.
aws s3api list-objects-v2 --bucket "$bucket" --prefix "$key_prefix" --output json \
  | jq -r --arg p "$key_prefix" '[.Contents // [] | .[] | select(.Key | startswith($p))]
      | map({key: .Key, name: (.Key | ltrimstr($p)), modified: .LastModified, size: .Size})
      | (map(select(.name | test("^[0-9a-f]{64}\\.ext4\\.zst$"))) | map({(.name[:64]): .size}) | add // {}) as $blobs
      | map(select(.name | test("^[0-9a-f]{64}\\.json$"))) | .[]
      | "\(.name[:64])\t\(.modified)\t\($blobs[.name[:64]] // 0)"' | LC_ALL=C sort -t $'\t' -k2,2 > "$work/images"
[[ -s "$work/images" ]] || { echo "==> No images under s3://$bucket/$key_prefix"; exit 0; }

cutoff=$(date -u -d "-$grace_days days" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-"${grace_days}"d +%Y-%m-%dT%H:%M:%S)
echo "==> Images under s3://$bucket/$key_prefix (grace: published after $cutoff is kept)"
: > "$work/prune"
while IFS=$'\t' read -r sha modified size; do
  if grep -qx "$sha" "$work/allowed"; then verdict="keep (allowed)"
  elif [[ "${modified:0:19}" > "$cutoff" ]]; then verdict="keep (within grace)"
  else verdict="PRUNE"; printf '%s\t%s\n' "$sha" "$size" >> "$work/prune"
  fi
  printf '    %s  %s  %5d MB  %s\n' "$sha" "${modified:0:19}" "$((size / 1000000))" "$verdict"
done < "$work/images"

count=$(wc -l < "$work/prune")
total=$(awk -F'\t' '{s += $2} END {printf "%d", s / 1000000}' "$work/prune")
if [[ $count -eq 0 ]]; then echo "==> Nothing to prune."; exit 0; fi
echo "==> $count image(s) to prune, $total MB (recoverable for the bucket's noncurrent-version window, then gone)"
[[ ${DRY_RUN:-} == 1 ]] && exit 0
if [[ -t 0 ]]; then read -r -p 'Type "prune" to delete them: ' answer; else answer=${CONFIRM:-}; fi
[[ $answer == prune ]] || { echo "Not pruning."; exit 0; }

jq -Rn --arg p "$key_prefix" '{Objects: [inputs | split("\t")[0] | $p + . + ".json", $p + . + ".ext4.zst" | {Key: .}], Quiet: false}' "$work/prune" > "$work/delete.json"
aws s3api delete-objects --bucket "$bucket" --delete "file://$work/delete.json" --output json > "$work/deleted.json"
echo "==> Deleted $(jq '.Deleted | length' "$work/deleted.json") object(s)"
errors=$(jq '.Errors // [] | length' "$work/deleted.json")
[[ $errors -eq 0 ]] || { jq -r '.Errors[] | "    \(.Key): \(.Code) \(.Message)"' "$work/deleted.json" >&2; die "$errors object(s) were not deleted."; }
