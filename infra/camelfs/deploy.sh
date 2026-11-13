#!/usr/bin/env bash
# Deploy camelfsd to the api tier (infra/camelfs/terraform/ecs.tf): build and push the image from this checkout,
# register a new task definition revision with it, roll the service, and wait for that deployment to complete.
# Modelled on infra/ecs-deploy.sh, without its commit-ordering guard (this service has no CI deploy to race).
# Usage: infra/camelfs/deploy.sh           build and push this checkout, then deploy it
#        infra/camelfs/deploy.sh <tag>     deploy an image already in ECR (no build)
#        DEPLOY_PUSH_ONLY=1 infra/camelfs/deploy.sh   build and push, print the tag, deploy nothing
#
# The first image: there is no service until api_image_tag is set, so push first (DEPLOY_PUSH_ONLY=1), then
# `infra/camelfs/apply.sh api_image_tag=<tag>` creates the service running it. Every later deploy is this script.
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
  log "Building $image (linux/arm64)"
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  docker buildx build --platform linux/arm64 -f "$here/Dockerfile" -t "$image" --push "$repo"
  log "Pushed $image"
fi
if [[ ${DEPLOY_PUSH_ONLY:-} == 1 ]]; then echo "$tag"; exit 0; fi

aws ecs describe-services --cluster "$cluster" --services "$service" --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE \
  || die "No service $cluster/$service yet: run infra/camelfs/apply.sh api_image_tag=$tag to create it running this image."

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

# Every running task runs exactly this image.
running=$(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING --query 'taskArns' --output json)
mismatched=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$(jq -r 'join(" ")' <<<"$running")" --output json \
  | jq -r --arg image "$image" --arg c "$container" '[.tasks[] | select(any(.containers[]; .name == $c and .image != $image))] | length')
[[ "$mismatched" == 0 ]] || die "$mismatched running task(s) run another image."
log "Deployed $image to $service"
