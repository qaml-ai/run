#!/usr/bin/env bash
# Build the executor AMI with the pins in versions.env and print its id.
# Needs packer and AWS credentials that can run EC2 in $REGION; the build instance
# needs internet access (the default VPC, or pass -var subnet_id=subnet-...).
# Usage: infra/executor/build-ami.sh [packer build flags]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
source "$here/versions.env"
packer init "$here/ami.pkr.hcl" >&2
packer build -machine-readable \
  -var "region=$REGION" -var "gvisor_release=$GVISOR_RELEASE" -var "gvisor_sha512=$GVISOR_SHA512" \
  -var "node_version=$NODE_VERSION" -var "node_sha256=$NODE_SHA256" \
  "$@" "$here/ami.pkr.hcl" \
  | tee /dev/stderr | awk -F, '$3 == "artifact" && $5 == "id" { split($6, ids, ":"); print ids[2] }'
