#!/usr/bin/env bash
# Deploy the runtime to the ECS service (infra/terraform/ecs.tf): build and push
# the image from this checkout, register a new task definition revision with it,
# roll the service, and wait until that deployment completes successfully.
# Usage: infra/ecs-deploy.sh           build and push this checkout, then deploy it
#        infra/ecs-deploy.sh <tag>     deploy an image already in ECR (no build)
# Environment (all optional):
#   DEPLOY_SHA          the full commit <tag> names (default: the commit the tag resolves to in git)
#   DEPLOY_ALLOW_OLDER  1: deploy even when production runs a newer commit (a rollback on purpose)
#   DEPLOY_GIT_DIR      the git checkout that orders commits (default: this one)
#
# Never an older commit over a newer one: image tags are commit prefixes, and
# right before the update the script compares its commit with the image of the
# service's primary deployment. When that deployment already includes this
# commit (the same image, or a newer commit), the script registers nothing and
# follows that deployment to completion instead. A newer deployment that
# replaces this one mid-rollout is followed the same way; anything else that
# replaces it (a rollback, an older commit) fails the deploy.
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
# not just healthy targets or services-stable (which can mean a rollback won),
# then check every running task runs exactly this image.
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
git_dir=${DEPLOY_GIT_DIR:-$repo}
allow_older=${DEPLOY_ALLOW_OLDER:-}
[[ "$allow_older" == 1 || "$allow_older" == true ]] || allow_older=
poll=${DEPLOY_POLL_SECONDS:-5}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

log() { printf '[%dm%02ds] %s\n' $((SECONDS / 60)) $((SECONDS % 60)) "$*"; }
die() { echo "::error::$*" >&2; exit 1; }
# The commit an image tag names: 12 hex digits that resolve in git. Dirty and other tags name none.
commit_of() {
  local tag=${1##*:}
  [[ "$tag" =~ ^[0-9a-f]{12}$ ]] || return 0
  git -C "$git_dir" rev-parse --verify -q "$tag^{commit}" 2>/dev/null || true
}
image_of() {
  aws ecs describe-task-definition --task-definition "$1" --output json \
    | jq -r --arg c "$container" '.taskDefinition.containerDefinitions[] | select(.name == $c) | .image'
}

if [[ $# -gt 0 ]]; then
  tag=$1
  aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="$tag" >/dev/null \
    || { echo "No image $ECR_REPOSITORY:$tag in ECR" >&2; exit 1; }
  sha=${DEPLOY_SHA:-$(commit_of "$tag")}
else
  tag=$(git -C "$repo" rev-parse --short=12 HEAD)
  sha=$(git -C "$repo" rev-parse HEAD)
  if [[ -n "$(git -C "$repo" status --porcelain -- src shared console package.json Dockerfile)" ]]; then
    tag="$tag-dirty-$(date +%Y%m%d%H%M%S)"
  fi
fi
[[ -z "$sha" || "${tag%%-dirty-*}" == "${sha::12}" ]] || die "DEPLOY_SHA $sha does not match the tag $tag"
image="$registry/$ECR_REPOSITORY:$tag"

# How the image in $1 relates to ours: same, newer (its commit includes ours), older (ours includes its),
# diverged, or unknown (a tag that names no commit here).
relation() {
  local other
  [[ "${1##*:}" == "$tag" ]] && { echo same; return; }
  other=$(commit_of "$1")
  if [[ -z "$sha" || -z "$other" ]]; then echo unknown
  elif [[ "$other" == "$sha" ]]; then echo same
  elif git -C "$git_dir" merge-base --is-ancestor "$sha" "$other"; then echo newer
  elif git -C "$git_dir" merge-base --is-ancestor "$other" "$sha"; then echo older
  else echo diverged
  fi
}

# The service: $svc (JSON), $desired, and its primary deployment ($deployment, $primary, $rollout).
seen_events=
snapshot() {
  svc=$(aws ecs describe-services --cluster "$cluster" --services "$service" --output json | jq -c '.services[0]')
  desired=$(jq -r '.desiredCount' <<<"$svc")
  deployment='' primary='' rollout=''
  read -r deployment primary rollout <<<"$(jq -r '.deployments[] | select(.status == "PRIMARY")
    | "\(.id) \(.taskDefinition) \(.rolloutState // "NONE")"' <<<"$svc")" || true
  [[ -n "$primary" ]] || die "the service has no primary deployment"
}
# ECS's service events since the last call, oldest first.
print_events() {
  local id message
  while IFS=$'\t' read -r id message; do
    [[ -n "$id" && "$seen_events" != *"|$id|"* ]] || continue
    seen_events+="|$id|"
    log "ecs: ${message#"(service $service) "}"
  done <<<"$(jq -r '.events[:25] | reverse | .[] | "\(.id)\t\(.message)"' <<<"$svc")"
}

# Deploy, or follow the primary deployment because it already has this commit ($action, $arn, $image).
decide() {
  snapshot
  local live latest
  live=$(image_of "$primary")
  case "$(relation "$live")" in
    same)
      # The same image under an older revision: deploy, to ship the settings Terraform changed since.
      latest=$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition.taskDefinitionArn --output text)
      if [[ "$primary" == "$latest" ]]; then
        echo "::notice::production's primary deployment already runs $tag ($primary): following it"
        action=follow arn=$primary
      else
        action=deploy
      fi ;;
    newer)
      if [[ -n "$allow_older" ]]; then
        log "rolling back: production runs $live, which is newer than $tag"
        action=deploy
      else
        echo "::notice::production's primary deployment runs $live, which includes $tag: following it instead of deploying an older commit"
        action=follow arn=$primary image=$live
      fi ;;
    diverged)
      [[ -n "$allow_older" ]] || die "production runs $live, which is neither older nor newer than $tag; deploy with DEPLOY_ALLOW_OLDER=1 (rollback) to replace it"
      action=deploy ;;
    *) action=deploy ;;
  esac
}

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

register() {
  log "==> Registering a $family revision with $image"
  local current input registered
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
  registered=$(image_of "$arn")
  [[ "$registered" == "$image" ]] || die "registered $arn with image $registered, expected $image"
  log "$arn"
}

decide
seen_events=$(jq -r '"|" + ([.events[:25][].id] | join("||")) + "|"' <<<"$svc")
if [[ "$action" == deploy ]]; then
  register
  registered=$arn guarded=$deployment
  # Another deploy may have rolled the service while this one registered: decide again right before the update.
  snapshot
  if [[ "$deployment" != "$guarded" ]]; then
    decide
    if [[ "$action" == deploy ]]; then arn=$registered; else log "not using $registered"; fi
  fi
fi
if [[ "$action" == deploy ]]; then
  log "==> Rolling $service to $arn"
  aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$arn" >/dev/null
  echo "- $(date -u +%H:%M:%S) rolled $service to ${arn##*/} (\`$tag\`)" >>"$summary"
else
  log "==> Following deployment $deployment ($arn, $image)"
  echo "- $(date -u +%H:%M:%S) following ${arn##*/} (\`${image##*:}\`), which includes \`$tag\`" >>"$summary"
fi

# First wait for the new deployment's tasks, then its completed rollout.
# Leave time for protected turns, draining and the deployment-alarm bake window.
completion_deadline=$((SECONDS + 2700))
check_deployment() {
  snapshot
  print_events
  if [[ "$primary" != "$arn" ]]; then
    local now
    now=$(image_of "$primary")
    case "$(relation "$now")" in
      same|newer) if [[ -z "$allow_older" ]]; then
          echo "::notice::superseded: deployment $deployment rolls out $now, which includes $tag; following it"
          arn=$primary image=$now
          return
        fi ;;
    esac
    die "the primary deployment is now $primary ($now): rolled back (circuit breaker or alarm) or replaced by a deployment without $tag; expected $arn"
  fi
  [[ "$rollout" != FAILED ]] || die "rollout failed: $arn"
  [[ "$rollout" == IN_PROGRESS || "$rollout" == COMPLETED ]] || die "missing or unexpected rollout state: $rollout"
}
# A line when anything changes: healthy new tasks, and each deployment's revision, state and running/desired tasks.
progress=
print_progress() {
  local line
  line="new tasks healthy: $1/$desired; $(jq -r '[.deployments[] | "\(.taskDefinition | split(":") | last) \(.status | ascii_downcase) \(.rolloutState // "" | ascii_downcase) \(.runningCount)/\(.desiredCount)"] | join(", ")' <<<"$svc")"
  [[ "$line" == "$progress" ]] || log "$line"
  progress=$line
}
tg=$(aws elbv2 describe-target-groups --names "$NAME" --query 'TargetGroups[0].TargetGroupArn' --output text)
deadline=$((SECONDS + 1800))
while :; do
  check_deployment

  # IPs of this deployment's running tasks, and of healthy targets.
  tasks=$(aws ecs list-tasks --cluster "$cluster" --started-by "$deployment" --desired-status RUNNING --output json | jq -r '.taskArns | join(" ")')
  ips=()
  if [[ -n "$tasks" ]]; then
    read -r -a ips <<<"$(aws ecs describe-tasks --cluster "$cluster" --tasks $tasks --output json | jq -r '[.tasks[]
      | select(.lastStatus == "RUNNING") | .attachments[].details[] | select(.name == "privateIPv4Address") | .value] | join(" ")')"
  fi
  healthy=" $(aws elbv2 describe-target-health --target-group-arn "$tg" --output json \
    | jq -r '[.TargetHealthDescriptions[] | select(.TargetHealth.State == "healthy") | .Target.Id] | join(" ")') "
  ready=0
  for ip in ${ips[@]+"${ips[@]}"}; do [[ "$healthy" == *" $ip "* ]] && ready=$((ready + 1)); done
  print_progress "$ready"
  if ((ready >= desired && desired > 0)) || [[ "$rollout" == COMPLETED ]]; then break; fi
  ((SECONDS < deadline)) || die "new tasks not healthy after 30 minutes"
  sleep "$poll"
done
log "new tasks serving $image"
echo "- $(date -u +%H:%M:%S) new tasks healthy" >>"$summary"
# Healthy targets are only the readiness gate. ECS can still roll back while
# protected old tasks retire or deployment alarms bake. Do not update-service here.
while :; do
  check_deployment
  [[ "$rollout" == COMPLETED ]] && break
  ((SECONDS < completion_deadline)) || die "deployment did not complete after 45 minutes; ECS remains in control: $arn"
  print_progress "$ready"
  sleep "$poll"
done
log "rollout COMPLETED"

# Through Cloudflare to the ALB: the ALB admits only Cloudflare's addresses (infra/terraform/alb.tf).
# Retried: right after a rollout, old tasks are still deregistering, and one request may meet a connection the ALB had
# to an old task as it closed (a 502). Only a check that keeps failing fails the deploy.
echo "==> https://$HOSTNAME/healthz"
for attempt in 1 2 3 4 5; do
  curl -fsS --max-time 10 "https://$HOSTNAME/healthz" && { echo; break; }
  ((attempt < 5)) || die "/healthz failed 5 times"
  echo " (attempt $attempt failed; retrying in 5 s)" >&2
  sleep "$poll"
done

# Check once more after the public smoke, before reporting success: the service is on this revision alone, and
# every running task runs this image, by tag and by ECR digest.
check_deployment
[[ "$rollout" == COMPLETED ]] || die "deployment no longer completed: $arn"
[[ "$(jq '.deployments | length' <<<"$svc")" == 1 ]] || die "other deployments are still active beside $arn"
digest=$(aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="${image##*:}" --output json | jq -r '.imageDetails[0].imageDigest')
tasks=$(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING --output json | jq -r '.taskArns | join(" ")')
[[ -n "$tasks" ]] || die "the service runs no tasks"
running=$(aws ecs describe-tasks --cluster "$cluster" --tasks $tasks --output json | jq -c --arg c "$container" '[.tasks[]
  | select(.lastStatus == "RUNNING") | {arn: .taskArn, def: .taskDefinitionArn} + (.containers[] | select(.name == $c) | {image, digest: .imageDigest})]')
wrong=$(jq -r --arg arn "$arn" --arg image "$image" --arg digest "$digest" '.[]
  | select(.def != $arn or .image != $image or (.digest != null and .digest != $digest))
  | "\(.arn | split("/") | last): \(.def | split("/") | last) \(.image) \(.digest)"' <<<"$running")
[[ -z "$wrong" ]] || die "running tasks not on $image ($digest): $(tr '\n' ';' <<<"$wrong")"
count=$(jq length <<<"$running")
((count > 0)) || die "no running task to verify"
((count >= desired)) || echo "::warning::$count running tasks for a desired count of $desired (scaling?); all run $image"
log "running image verified: $count/$desired tasks on $image ($digest)"
echo "- $(date -u +%H:%M:%S) rollout completed; $count tasks verified on \`${image##*:}\`" >>"$summary"
echo "deployed: $image ($arn, rollout COMPLETED)"
