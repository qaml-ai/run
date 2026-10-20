#!/usr/bin/env bash
# Deploy the runtime to the ECS service (infra/terraform/ecs.tf): build and push
# the image from this checkout, register a new task definition revision with it,
# roll the service, and wait until that deployment completes successfully.
# Usage: infra/ecs-deploy.sh           build and push this checkout, then deploy it
#        infra/ecs-deploy.sh <tag>     deploy an image already in ECR (no build)
#
# The new revision copies the family's latest revision and swaps only the image,
# so settings Terraform changed (environment, secrets, cpu/memory) ship with the
# next deploy. To ship a settings change alone, redeploy the running tag.
#
# Rolling: ECS starts new tasks first (maximumPercent 300) and waits for them to
# pass /healthz. Old tasks then retire once their protected turns reach a step
# boundary (AGENT_RETIRE_MAX_MS, default 20 min), followed by ALB deregistration
# (65 s) and SIGTERM draining (120 s). Deployment alarms can still roll back
# during this time and their bake window. Wait for this revision to COMPLETED,
# not just healthy targets or services-stable (which can mean a rollback won).
# Failure only exits: never resubmit the failed revision or undo ECS's rollback.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

cluster=$NAME
service=$NAME
family=$NAME
container=agent-runtime
registry="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

if [[ $# -gt 0 ]]; then
  tag=$1
  aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="$tag" >/dev/null \
    || { echo "No image $ECR_REPOSITORY:$tag in ECR" >&2; exit 1; }
else
  tag=$(git -C "$repo" rev-parse --short=12 HEAD)
  if [[ -n "$(git -C "$repo" status --porcelain -- src shared console package.json Dockerfile)" ]]; then
    tag="$tag-dirty-$(date +%Y%m%d%H%M%S)"
  fi
fi
image="$registry/$ECR_REPOSITORY:$tag"

if [[ $# -eq 0 ]]; then
  echo "==> Building the console"
  (cd "$repo" && npx --no-install vite build --config console/vite.config.ts >/dev/null)

  echo "==> Building $image"
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  if aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="$tag" >/dev/null 2>&1; then
    echo "image already pushed"
  else
    docker buildx build --platform linux/arm64 --provenance=false -t "$image" --push "$repo"
  fi
fi

echo "==> Registering a $family revision with $image"
current=$(aws ecs describe-task-definition --task-definition "$family" --include TAGS --output json)
input=$(CURRENT="$current" python3 - "$image" "$container" <<'PY'
import json, os, sys
image, container = sys.argv[1], sys.argv[2]
described = json.loads(os.environ["CURRENT"])
task = described["taskDefinition"]
for field in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
              "registeredAt", "registeredBy", "deregisteredAt"):
    task.pop(field, None)
matches = [c for c in task["containerDefinitions"] if c["name"] == container]
if len(matches) != 1:
    sys.exit(f"task definition has no container named {container}")
matches[0]["image"] = image
if described.get("tags"):
    task["tags"] = described["tags"]
print(json.dumps(task))
PY
)
arn=$(aws ecs register-task-definition --cli-input-json "$input" --query taskDefinition.taskDefinitionArn --output text)
echo "$arn"

echo "==> Rolling $service"
aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$arn" >/dev/null

# First wait for the new deployment's tasks, then its completed rollout.
# Leave time for protected turns, draining and the deployment-alarm bake window.
completion_deadline=$((SECONDS + 2700))
check_deployment() {
  local snapshot
  snapshot=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].[desiredCount, deployments[?status==`PRIMARY`] | [0].[id,taskDefinition,rolloutState]][]' --output text)
  read -r desired deployment primary rollout <<<"$(tr '\n' ' ' <<<"$snapshot")"
  if [[ "$primary" != "$arn" ]]; then
    echo "::error::rolled back: the primary deployment is $primary (circuit breaker/alarm or external deployment); expected $arn" >&2
    exit 1
  fi
  [[ "$rollout" != FAILED ]] || { echo "::error::rollout failed: $arn" >&2; exit 1; }
  [[ "$rollout" == IN_PROGRESS || "$rollout" == COMPLETED ]] || {
    echo "::error::missing or unexpected rollout state: $rollout" >&2; exit 1;
  }
}
tg=$(aws elbv2 describe-target-groups --names "$NAME" --query 'TargetGroups[0].TargetGroupArn' --output text)
deadline=$((SECONDS + 1800))
while :; do
  check_deployment

  # IPs of this deployment's running tasks, and of healthy targets.
  tasks=$(aws ecs list-tasks --cluster "$cluster" --started-by "$deployment" --desired-status RUNNING --query taskArns --output text)
  ips=()
  if [[ -n "$tasks" && "$tasks" != None ]]; then
    read -r -a ips <<<"$(aws ecs describe-tasks --cluster "$cluster" --tasks $tasks \
      --query 'tasks[?lastStatus==`RUNNING`].attachments[].details[?name==`privateIPv4Address`].value[]' --output text)"
  fi
  healthy=" $(aws elbv2 describe-target-health --target-group-arn "$tg" \
    --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`].Target.Id' --output text | tr '\t' ' ') "
  ready=0
  for ip in "${ips[@]}"; do [[ "$healthy" == *" $ip "* ]] && ready=$((ready + 1)); done
  echo "new tasks healthy: $ready/$desired (rollout $rollout)"
  ((ready >= desired && desired > 0)) && break
  ((SECONDS < deadline)) || { echo "new tasks not healthy after 30 minutes" >&2; exit 1; }
  sleep 5
done
# Healthy targets are only the readiness gate. ECS can still roll back while
# protected old tasks retire or deployment alarms bake. Do not update-service here.
while :; do
  check_deployment
  [[ "$rollout" == COMPLETED ]] && break
  ((SECONDS < completion_deadline)) || {
    echo "::error::deployment did not complete after 45 minutes; ECS remains in control: $arn" >&2
    exit 1
  }
  echo "waiting for deployment completion: $deployment ($rollout)"
  sleep 5
done

# Through Cloudflare to the ALB: the ALB admits only Cloudflare's addresses (infra/terraform/alb.tf).
# Retried: right after a rollout, old tasks are still deregistering, and one request may meet a connection the ALB had
# to an old task as it closed (a 502). Only a check that keeps failing fails the deploy.
echo "==> https://$HOSTNAME/healthz"
for attempt in 1 2 3 4 5; do
  curl -fsS --max-time 10 "https://$HOSTNAME/healthz" && { echo; break; }
  ((attempt < 5)) || { echo "!! /healthz failed 5 times" >&2; exit 1; }
  echo " (attempt $attempt failed; retrying in 5 s)" >&2
  sleep 5
done

# Check once more after the public smoke, before reporting success.
check_deployment
[[ "$rollout" == COMPLETED ]] || { echo "::error::deployment no longer completed: $arn" >&2; exit 1; }
echo "deployed: $image ($arn, rollout COMPLETED)"
