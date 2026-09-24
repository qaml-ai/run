#!/usr/bin/env bash
# Deploy the runtime to the ECS service (infra/terraform/ecs.tf): build and push
# the image from this checkout, register a new task definition revision with it,
# roll the service, and wait until the new tasks are healthy.
# Usage: infra/ecs-deploy.sh           build and push this checkout, then deploy it
#        infra/ecs-deploy.sh <tag>     deploy an image already in ECR (no build)
#
# The new revision copies the family's latest revision and swaps only the image,
# so settings Terraform changed (environment, secrets, cpu/memory) ship with the
# next deploy. To ship a settings change alone, redeploy the running tag.
#
# Rolling: ECS starts new tasks first (maximumPercent 200) and waits for them to
# pass /healthz. This script returns then: every new task is healthy in the
# target group. Old tasks retire in the background. A task running turns
# protects itself from being stopped, and ECS waits for that protection to end,
# up to AGENT_RETIRE_MAX_MS (default 6 h). Each old task is then deregistered
# (110 s on the ALB), gets SIGTERM, and has 120 s to drain. The service's
# rolloutState stays IN_PROGRESS until the last one is gone. A rollout whose
# new tasks fail is rolled back automatically (circuit breaker); this script
# then fails.
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

# Wait for the new deployment's tasks, not for the old ones to stop.
tg=$(aws elbv2 describe-target-groups --names "$NAME" --query 'TargetGroups[0].TargetGroupArn' --output text)
deadline=$((SECONDS + 1800))
while :; do
  read -r deployment primary rollout desired <<<"$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].deployments[?status==`PRIMARY`] | [0].[id,taskDefinition,rolloutState,desiredCount]' --output text)"
  if [[ "$primary" != "$arn" ]]; then
    echo "rolled back: the primary deployment is $primary (circuit breaker)" >&2
    exit 1
  fi
  [[ "$rollout" != FAILED ]] || { echo "rollout failed" >&2; exit 1; }

  # IPs of this deployment's running tasks, and of healthy targets.
  tasks=$(aws ecs list-tasks --cluster "$cluster" --started-by "$deployment" --desired-status RUNNING --query taskArns --output text)
  ips=()
  if [[ -n "$tasks" && "$tasks" != None ]]; then
    read -r -a ips <<<"$(aws ecs describe-tasks --cluster "$cluster" --tasks $tasks \
      --query 'tasks[?lastStatus==`RUNNING`].attachments[0].details[?name==`privateIPv4Address`].value[]' --output text)"
  fi
  healthy=" $(aws elbv2 describe-target-health --target-group-arn "$tg" \
    --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`].Target.Id' --output text | tr '\t' ' ') "
  ready=0
  for ip in "${ips[@]}"; do [[ "$healthy" == *" $ip "* ]] && ready=$((ready + 1)); done
  echo "new tasks healthy: $ready/$desired (rollout $rollout)"
  ((ready >= desired && desired > 0)) && break
  ((SECONDS < deadline)) || { echo "new tasks not healthy after 30 minutes" >&2; exit 1; }
  sleep 15
done
echo "deployed: $image"
echo "old tasks retire in the background; follow with:"
echo "  aws ecs describe-services --region $REGION --cluster $cluster --services $service --query 'services[0].deployments[].[status,rolloutState,runningCount,taskDefinition]'"

# Through the ALB whatever DNS points at (before the cutover it is the EC2 host).
alb=$(aws elbv2 describe-load-balancers --names "$NAME" --query 'LoadBalancers[0].DNSName' --output text)
echo "==> https://$HOSTNAME/healthz via $alb"
curl -fsS --connect-to "$HOSTNAME:443:$alb:443" "https://$HOSTNAME/healthz" && echo
