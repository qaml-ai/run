#!/usr/bin/env bash
# Upload a source archive and build a version. Run only with operator approval.
set -euo pipefail
: "${AWS_REGION:?Set AWS_REGION}"
: "${MICROVM_SOURCE_BUCKET:?Set MICROVM_SOURCE_BUCKET from the infra output}"
: "${MICROVM_BUILD_ROLE_ARN:?Set MICROVM_BUILD_ROLE_ARN from the infra output}"
: "${MICROVM_BASE_IMAGE_ARN:?Select an ARM64 base with aws lambda-microvms list-managed-microvm-images}"
: "${MICROVM_BUILD_LOG_GROUP:?Set MICROVM_BUILD_LOG_GROUP from the infra output}"
if [[ ${CONFIRM:-} != build ]]; then
  echo 'This uploads source and creates a billable image version. Set CONFIRM=build after reviewing the configuration.' >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$root/sandbox/microvm" && zip -q "$work/source.zip" Dockerfile agent.py)
digest=$(shasum -a 256 "$work/source.zip" | cut -d ' ' -f 1)
uri="s3://${MICROVM_SOURCE_BUCKET}/${digest}.zip"
aws s3 cp --only-show-errors "$work/source.zip" "$uri"
export MICROVM_CODE_URI=$uri
python3 - "$work/request.json" <<'PY'
import json, os, sys
request = {
    "baseImageArn": os.environ["MICROVM_BASE_IMAGE_ARN"],
    "buildRoleArn": os.environ["MICROVM_BUILD_ROLE_ARN"],
    "codeArtifact": {"uri": os.environ["MICROVM_CODE_URI"]},
    "logging": {"cloudWatch": {"logGroup": os.environ["MICROVM_BUILD_LOG_GROUP"]}},
    "cpuConfigurations": [{"architecture": "ARM_64"}],
    "resources": [{"minimumMemoryInMiB": 2048}],
    "hooks": {"port": 8080, "microvmImageHooks": {"ready": "ENABLED", "readyTimeoutInSeconds": 60}, "microvmHooks": {name: "ENABLED" for name in ["run", "resume", "suspend", "terminate"]}},
}
if os.environ.get("MICROVM_IMAGE_ARN"):
    request["imageIdentifier"] = os.environ["MICROVM_IMAGE_ARN"]
else:
    request["name"] = os.environ.get("MICROVM_IMAGE_NAME", "camelrun-computers")
json.dump(request, open(sys.argv[1], "w"))
PY
operation=create-microvm-image
[[ -z ${MICROVM_IMAGE_ARN:-} ]] || operation=update-microvm-image
aws lambda-microvms "$operation" --cli-input-json "file://$work/request.json" > "$work/result.json"
image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageArn"])' "$work/result.json")
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageVersion"])' "$work/result.json")
# A successful create response only starts the asynchronous build.
for ((attempt=0; attempt<180; attempt++)); do
  aws lambda-microvms get-microvm-image-version --image-identifier "$image" --image-version "$version" > "$work/state.json"
  state=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$work/state.json")
  case "$state" in
    SUCCESSFUL) printf 'AGENT_MICROVM_IMAGE=%s\nAGENT_MICROVM_IMAGE_VERSION=%s\n' "$image" "$version"; exit 0 ;;
    FAILED|DELETE_FAILED) echo "Image build failed; see $MICROVM_BUILD_LOG_GROUP" >&2; exit 1 ;;
  esac
  sleep 10
done
echo "Image build is still pending: $image version $version" >&2
exit 1
