#!/usr/bin/env bash
# Build (or update) the managed-computer MicroVM image from sandbox/microvm, with production's settings.
#   infra/microvm-image.sh            show what it will build, ask, then build and print the image ARN and version
# It reads the source bucket, build role and log group from the infra outputs (apply with microvm_enabled=true first),
# and uses an AWS CLI that has `lambda-microvms` (an older one gets a private copy under ~/.cache/camelrun/awscli).
# Then: infra/apply.sh microvm_image_arn=<arn> [microvm_image_version=<version>]
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=${AWS_REGION:-us-west-2} AWS_DEFAULT_REGION=${AWS_REGION:-us-west-2}

if ! aws lambda-microvms help >/dev/null 2>&1; then
  cli=~/.cache/camelrun/awscli
  if ! "$cli/bin/aws" lambda-microvms help >/dev/null 2>&1; then
    echo "==> Installing an AWS CLI with lambda-microvms under $cli"
    python3 -m venv "$cli" && "$cli/bin/pip" install -q --upgrade awscli
  fi
  export PATH="$cli/bin:$PATH"
fi

outputs=$(tofu -chdir=infra/terraform output -json)
value() { jq -r --arg k "$1" '.[$k].value // empty' <<<"$outputs"; }
export MICROVM_SOURCE_BUCKET=$(value microvm_source_bucket) MICROVM_BUILD_ROLE_ARN=$(value microvm_build_role_arn) MICROVM_BUILD_LOG_GROUP=$(value microvm_build_log_group)
[[ -n $MICROVM_SOURCE_BUCKET && -n $MICROVM_BUILD_ROLE_ARN ]] || { echo "No MicroVM infra outputs: run infra/apply.sh microvm_enabled=true first" >&2; exit 1; }
export MICROVM_BASE_IMAGE_ARN=${MICROVM_BASE_IMAGE_ARN:-arn:aws:lambda:$AWS_REGION:aws:microvm-image:al2023-1}
export MICROVM_IMAGE_ARN=${MICROVM_IMAGE_ARN:-$(value microvm_image_arn)}

echo "Source:  sandbox/microvm at $(git rev-parse --short HEAD) -> s3://$MICROVM_SOURCE_BUCKET"
echo "Base:    $MICROVM_BASE_IMAGE_ARN"
echo "Image:   ${MICROVM_IMAGE_ARN:-new}"
if [[ ${CONFIRM:-} != build ]]; then
  [[ -t 0 ]] || { echo "Set CONFIRM=build when not at a terminal" >&2; exit 1; }
  read -r -p 'Type "build" to build: ' answer
  [[ $answer == build ]] || { echo "Not built."; exit 1; }
fi
CONFIRM=build exec bash scripts/microvm-image.sh
