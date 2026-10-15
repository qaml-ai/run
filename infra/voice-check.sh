#!/usr/bin/env bash
# Proves Discord voice works from the runtime's own network before voice sessions are turned on (AGENT_VOICE): runs
# scripts/voice-check.ts once as a one-off Fargate task with the service's image, in its subnets, with its task security
# group and a public IP, as its tasks run (infra/terraform/ecs.tf: no NAT, egress open, replies come back through the
# stateful security group; agent-launcher's seccomp filter confines js_exec and file parsing, not the runtime's node
# process, which opens the UDP socket). Two test bots join a voice channel; one listens through the runtime's Discord
# transport and segmenter, the other plays three bursts of tone. PASS needs the voice WebSocket, UDP both ways and DAVE.
#
# It touches no service: its own task definition family (<name>-voice-check, no task role, no secrets, none of the
# runtime's environment) and its own log group (/ecs/<name>-voice-check, 1-day retention). The image is the one the
# service runs now (it must contain scripts/voice-check.ts: a release from this change on), or IMAGE=<uri>.
#
#   VOICE_BOT_TOKEN=… SPEAKER_TOKEN=… GUILD=… CHANNEL=… infra/voice-check.sh     # run it and print its log
#   infra/voice-check.sh cleanup                                                # delete the task definitions and log group
#
# Use two test applications (never a production bot): a second gateway session on a token in use would see its
# traffic. The tokens go in as environment overrides, which anyone who can describe the task sees; reset them after if
# that matters. Needs: aws (the runtime's account), jq.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

cluster=$NAME
service=$NAME
family=$NAME-voice-check
log_group=/ecs/$family

if [[ ${1:-} == cleanup ]]; then
  for arn in $(aws ecs list-task-definitions --family-prefix "$family" --query 'taskDefinitionArns[]' --output text); do
    aws ecs deregister-task-definition --task-definition "$arn" >/dev/null
    aws ecs delete-task-definitions --task-definitions "$arn" >/dev/null || true
  done
  aws logs delete-log-group --log-group-name "$log_group" 2>/dev/null || true
  echo "deleted $family's task definitions and log group"
  exit 0
fi

for var in VOICE_BOT_TOKEN SPEAKER_TOKEN GUILD CHANNEL; do
  [[ -n ${!var:-} ]] || { echo "$var is not set" >&2; exit 2; }
done

# The service's network, image and execution role, read from it (nothing is changed there).
read -r task_definition subnets security_groups public_ip < <(aws ecs describe-services --cluster "$cluster" --services "$service" \
  --query 'services[0].[taskDefinition, join(`,`, networkConfiguration.awsvpcConfiguration.subnets), join(`,`, networkConfiguration.awsvpcConfiguration.securityGroups), networkConfiguration.awsvpcConfiguration.assignPublicIp]' --output text)
read -r service_image execution_role < <(aws ecs describe-task-definition --task-definition "$task_definition" \
  --query 'taskDefinition.[containerDefinitions[0].image, executionRoleArn]' --output text)
image=${IMAGE:-$service_image}
echo "image $image"
echo "network: subnets $subnets, security groups $security_groups, public IP $public_ip"

aws logs create-log-group --log-group-name "$log_group" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$log_group" --retention-in-days 1

container=$(jq -n --arg image "$image" --arg group "$log_group" --arg region "$REGION" '[{
  name: "voice-check", image: $image, essential: true,
  command: ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/voice-check.ts"],
  linuxParameters: { initProcessEnabled: true },
  logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": $group, "awslogs-region": $region, "awslogs-stream-prefix": "voice-check" } }
}]')
revision=$(aws ecs register-task-definition --family "$family" --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 512 --memory 1024 --runtime-platform cpuArchitecture=ARM64,operatingSystemFamily=LINUX --execution-role-arn "$execution_role" \
  --container-definitions "$container" --query 'taskDefinition.taskDefinitionArn' --output text)

overrides=$(jq -n --arg a "$VOICE_BOT_TOKEN" --arg b "$SPEAKER_TOKEN" --arg g "$GUILD" --arg c "$CHANNEL" \
  '{ containerOverrides: [{ name: "voice-check", environment: [
    { name: "VOICE_BOT_TOKEN", value: $a }, { name: "SPEAKER_TOKEN", value: $b }, { name: "GUILD", value: $g }, { name: "CHANNEL", value: $c } ] }] }')
task=$(aws ecs run-task --cluster "$cluster" --launch-type FARGATE --task-definition "$revision" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_groups],assignPublicIp=$public_ip}" \
  --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
echo "started $task; waiting for it to stop (about a minute)"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].{stopped: stoppedReason, exitCode: containers[0].exitCode, reason: containers[0].reason}' --output json
aws logs get-log-events --log-group-name "$log_group" --log-stream-name "voice-check/voice-check/${task##*/}" \
  --start-from-head --query 'events[].message' --output text | tr '\t' '\n'
echo "Done: exit code 0 and a PASS summary mean voice works from here. 'infra/voice-check.sh cleanup' removes what it made."
