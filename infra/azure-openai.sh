#!/usr/bin/env bash
# Store the Azure OpenAI resource that images and transcription on the platform's OpenAI key go to, then roll the ECS
# service. Optional: without it (or with an empty value) they stay on OpenAI, which is also Azure's fallback.
#
# Usage: infra/azure-openai.sh <endpoint> [imageDeployment] [transcriptionDeployment]   (reads the API key from stdin)
#   e.g. az cognitiveservices account keys list -g oai -n migue-ma8lkatg-eastus2 --query key1 -o tsv \
#          | infra/azure-openai.sh https://migue-ma8lkatg-eastus2.cognitiveservices.azure.com
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

[[ $# -ge 1 && $# -le 3 ]] || { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ ! -t 0 ]] || echo "Paste the Azure OpenAI API key and press Enter, then Ctrl-D:" >&2
umask 077
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 -c 'import json, re, sys
endpoint, image, transcription, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
if len(lines) != 1: sys.exit("Send one line: the Azure OpenAI API key")
if not re.fullmatch(r"https://[a-z0-9-]+\.(openai\.azure\.com|cognitiveservices\.azure\.com)/?", endpoint): sys.exit("The endpoint is https://<resource>.openai.azure.com or .cognitiveservices.azure.com")
value = {"endpoint": endpoint.rstrip("/"), "apiKey": lines[0], "imageDeployment": image, "transcriptionDeployment": transcription}
open(out, "w").write(json.dumps(value))' "$1" "${2:-gpt-image-2.5-flare}" "${3:-gpt-transcribe}" "$work/value"
id="$SECRET_PREFIX/azure-openai"
if ! aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
  echo "$id does not exist yet: apply the Terraform change that adds it (infra/terraform/secrets.tf) first." >&2
  exit 1
fi
aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/value" >/dev/null
echo "Stored $id."
# Tasks read this secret at startup. The running revision must name it (the Terraform change ships with a deploy of the
# running tag); then rolling the service is enough.
running=$(aws ecs describe-services --cluster "$NAME" --services "$NAME" --query 'services[0].taskDefinition' --output text)
if aws ecs describe-task-definition --task-definition "$running" --query 'taskDefinition.containerDefinitions[0].environment[].name' --output text | tr '\t' '\n' | grep -qx AGENT_AZURE_OPENAI_SECRET_ARN; then
  aws ecs update-service --cluster "$NAME" --service "$NAME" --force-new-deployment >/dev/null
  echo "Rolling the ECS service: platform-key images and transcription now go to Azure (\"via\":\"azure\" in images_generated and transcribed logs)."
else
  tag=$(aws ecs describe-task-definition --task-definition "$running" --query 'taskDefinition.containerDefinitions[0].image' --output text)
  echo "The running revision does not read the secret yet: apply the Terraform change, then deploy the running image (${tag##*:}) with infra/ecs-deploy.sh ${tag##*:}."
fi
