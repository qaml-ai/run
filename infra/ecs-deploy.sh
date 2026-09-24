#!/usr/bin/env bash
# Deploy the runtime to the ECS service (infra/terraform/ecs.tf): build and push
# the image from this checkout, register a new task definition revision with it,
# roll the service, and wait until the rollout completes.
# Usage: infra/ecs-deploy.sh           build and push this checkout, then deploy it
#        infra/ecs-deploy.sh <tag>     deploy an image already in ECR (no build)
#
# The new revision copies the family's latest revision and swaps only the image,
# so settings Terraform changed (environment, secrets, cpu/memory) ship with the
# next deploy. To ship a settings change alone, redeploy the running tag.
#
# Rolling: ECS starts new tasks first (maximumPercent 200), waits for them to
# pass /healthz, then deregisters old ones. Their connections get 110 s on the
# ALB, then SIGTERM and up to 120 s to drain. A rollout that fails health
# checks is rolled back automatically (circuit breaker); this script then fails.
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

# services-stable gives up after 10 minutes; a rollout with drains can take longer.
deadline=$((SECONDS + 1800))
while :; do
  read -r rollout primary <<<"$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].deployments[?status==`PRIMARY`] | [0].[rolloutState,taskDefinition]' --output text)"
  if [[ "$primary" != "$arn" ]]; then
    echo "rolled back: the primary deployment is $primary (circuit breaker)" >&2
    exit 1
  fi
  case "$rollout" in
    COMPLETED) break ;;
    FAILED) echo "rollout failed" >&2; exit 1 ;;
  esac
  ((SECONDS < deadline)) || { echo "rollout still $rollout after 30 minutes" >&2; exit 1; }
  sleep 15
done
aws ecs wait services-stable --cluster "$cluster" --services "$service"
echo "deployed: $image"

# Through the ALB whatever DNS points at (before the cutover it is the EC2 host).
alb=$(aws elbv2 describe-load-balancers --names "$NAME" --query 'LoadBalancers[0].DNSName' --output text)
echo "==> https://$HOSTNAME/healthz via $alb"
curl -fsS --connect-to "$HOSTNAME:443:$alb:443" "https://$HOSTNAME/healthz" && echo
