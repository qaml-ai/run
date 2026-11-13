#!/usr/bin/env bash
# Uses the caller's AWS identity. Both object writes are conditional.
set -euo pipefail
dir=${1:?usage: publish-guest-image.sh ARTIFACT-DIR S3-PREFIX}
prefix=${2:?s3://bucket/prefix}
[[ $prefix == s3://?* ]] || { echo 'Expected s3://bucket/prefix' >&2; exit 1; }
prefix=${prefix#s3://}
bucket=${prefix%%/*}
key=${prefix#"$bucket"}
key=${key#/}
key=${key%/}
key=${key:+"$key/"}guest
shopt -s nullglob
manifests=("$dir"/guest-*.json)
[[ ${#manifests[@]} == 1 ]] || { echo 'Expected exactly one guest manifest' >&2; exit 1; }
manifest=${manifests[0]}
sha=$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$manifest")
zsha=$(jq -er '.zstdSha256 | select(test("^[0-9a-f]{64}$"))' "$manifest")
[[ ${manifest##*/} == "guest-$sha.json" ]]
blob=$dir/guest-$sha.ext4.zst
[[ $(sha256sum "$blob" | cut -d ' ' -f1) == "$zsha" ]] || { echo 'Compressed image SHA-256 mismatch' >&2; exit 1; }
actual=$(zstd -qdc "$blob" | sha256sum | cut -d ' ' -f1)
[[ $actual == "$sha" ]] || { echo 'Raw image SHA-256 mismatch' >&2; exit 1; }
put_once() {
  local suffix=$1 body=$2 output
  shift 2
  if output=$(aws s3api put-object --bucket "$bucket" --key "$key/$sha.$suffix" \
    --body "$body" --if-none-match '*' "$@" 2>&1); then
    return
  fi
  # The write-only role cannot read the object. A 412 confirms that this
  # verified content-addressed key already exists. Other errors still fail.
  if [[ $output == *'An error occurred (PreconditionFailed) when calling the PutObject operation:'* ]]; then
    printf 'Already published: s3://%s/%s/%s.%s\n' "$bucket" "$key" "$sha" "$suffix"
    return
  fi
  printf '%s\n' "$output" >&2
  return 1
}

put_once ext4.zst "$blob"
put_once json "$manifest" --content-type application/json
