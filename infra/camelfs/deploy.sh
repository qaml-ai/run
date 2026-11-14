#!/usr/bin/env bash
# Deploy camelfsd to the api tier (infra/camelfs/terraform/ecs.tf): build and push the image from this checkout,
# register a new task definition revision with it, roll the service, and wait for that deployment to complete.
# Modelled on infra/ecs-deploy.sh, without its commit-ordering guard (this service has no CI deploy to race).
# Usage: infra/camelfs/deploy.sh           build and push this checkout, then deploy it
#        infra/camelfs/deploy.sh <tag>     deploy an image already in ECR (no build)
#        DEPLOY_PUSH_ONLY=1 infra/camelfs/deploy.sh   build and push, print the tag, deploy nothing
#
# The first image: the service exists at 0 tasks with a placeholder tag, so this script registers the real image
# (a deployment at 0 tasks completes at once), then `infra/camelfs/apply.sh api_min_count=2` starts the tasks and
# the autoscaling. Every later deploy is this script alone.
#
# After a COMPLETED deployment the revision's ARN is saved as service_task_definition_arn in camelfs/prod.tfvars
# (the state bucket), so the next Terraform plan pins the revision this script chose instead of rolling the
# service back to Terraform's own (which the service runs only until the first deploy). A failed or rolled-back
# deployment saves nothing: the service is back on the revision prod.tfvars already names.
#
# The new revision copies the family's latest revision and swaps only the image, so settings Terraform changed
# (environment, cpu/memory) ship with the next deploy. To ship a settings change alone, redeploy the running tag.
# Wait for the deployment to COMPLETED, not just services-stable (which a rollback also reaches).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
source "$here/../config.sh"
aws() { command aws --region "$REGION" "$@"; }

name=camelfs-prod
cluster=$name
service=$name-api
family=$name-api
container=camelfsd
repository=$name
registry="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
poll=${DEPLOY_POLL_SECONDS:-5}

log() { printf '[%dm%02ds] %s\n' $((SECONDS / 60)) $((SECONDS % 60)) "$*"; }
die() { echo "error: $*" >&2; exit 1; }

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || die "AWS credentials are not for $ACCOUNT_ID."

if [[ $# -gt 0 ]]; then
  tag=$1
  aws ecr describe-images --repository-name "$repository" --image-ids imageTag="$tag" >/dev/null || die "No image $repository:$tag in ECR"
else
  tag=$(git -C "$repo" rev-parse --short=12 HEAD)
  [[ -z "$(git -C "$repo" status --porcelain -- camelfsd infra/camelfs/Dockerfile)" ]] || tag="$tag-dirty-$(date +%Y%m%d%H%M%S)"
fi
image="$registry/$repository:$tag"

if [[ $# -eq 0 ]]; then
  # The final image stage runs arm64 binaries (apt, useradd), so the builder needs arm64 emulation unless the host
  # is arm64 itself: Docker Desktop ships it; on Linux, `docker run --privileged --rm tonistiigi/binfmt --install arm64`.
  docker buildx inspect --bootstrap 2>/dev/null | grep -qE 'Platforms:.*linux/arm64' \
    || die "This docker builder cannot run linux/arm64 (the image's final stage does): on Linux run 'docker run --privileged --rm tonistiigi/binfmt --install arm64' once, or build on an arm64 host."
  log "Building $image (linux/arm64)"
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  docker buildx build --platform linux/arm64 -f "$here/Dockerfile" -t "$image" --push "$repo"
  log "Pushed $image"
fi
if [[ ${DEPLOY_PUSH_ONLY:-} == 1 ]]; then echo "$tag"; exit 0; fi

aws ecs describe-services --cluster "$cluster" --services "$service" --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE \
  || die "No service $cluster/$service yet: it is created by the second apply (certificate_issued=true); see infra/camelfs/README.md."

log "Registering a new $family revision with $image"
definition=$(aws ecs describe-task-definition --task-definition "$family" --output json \
  | jq --arg image "$image" --arg c "$container" '.taskDefinition
      | .containerDefinitions |= map(if .name == $c then .image = $image else . end)
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)')
revision=$(aws ecs register-task-definition --cli-input-json "$definition" --query 'taskDefinition.taskDefinitionArn' --output text)
log "Registered $revision"

deployment=$(aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$revision" \
  --query 'service.deployments[?status==`PRIMARY`].id | [0]' --output text)
log "Rolling $service (deployment $deployment)"
while :; do
  state=$(aws ecs describe-services --cluster "$cluster" --services "$service" --output json \
    | jq -r --arg id "$deployment" '.services[0].deployments[] | select(.id == $id) | "\(.rolloutState) running=\(.runningCount) desired=\(.desiredCount) \(.rolloutStateReason // "")"')
  [[ -n "$state" ]] || die "Deployment $deployment is gone: another deployment or a rollback replaced it."
  log "$state"
  case "$state" in
    COMPLETED*) break ;;
    FAILED*) die "Deployment failed (the circuit breaker or an alarm rolled it back)." ;;
  esac
  sleep "$poll"
done

# Pin the revision for Terraform (see the header). Same file and format apply.sh uses.
tfvars_s3=s3://camelai-terraform-state-$ACCOUNT_ID/agent-runtime/camelfs/prod.tfvars
tfvars=$(mktemp -t camelfs-tfvars.XXXXXX)
aws s3 cp --only-show-errors "$tfvars_s3" "$tfvars" 2>/dev/null || : > "$tfvars"
grep -Ev '^[[:space:]]*service_task_definition_arn[[:space:]]*=' "$tfvars" > "$tfvars.new" || true
echo "service_task_definition_arn = \"$revision\"" >> "$tfvars.new"
aws s3 cp --only-show-errors "$tfvars.new" "$tfvars_s3"; rm -f "$tfvars" "$tfvars.new"
log "Saved service_task_definition_arn = $revision to prod.tfvars"

# Every running task runs exactly this image (none at all while api_min_count is 0).
mapfile -t running < <(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING --query 'taskArns[]' --output text | tr '\t' '\n' | sed '/^$/d')
if [[ ${#running[@]} -eq 0 ]]; then log "Registered $image; the service runs no task yet (api_min_count 0): raise it with infra/camelfs/apply.sh api_min_count=2"; exit 0; fi
mismatched=$(aws ecs describe-tasks --cluster "$cluster" --tasks "${running[@]}" --output json \
  | jq -r --arg image "$image" --arg c "$container" '[.tasks[] | select(any(.containers[]; .name == $c and .image != $image))] | length')
[[ "$mismatched" == 0 ]] || die "$mismatched running task(s) run another image."
log "Deployed $image to $service"
