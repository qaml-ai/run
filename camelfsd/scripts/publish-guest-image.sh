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
aws s3api put-object --bucket "$bucket" --key "$key/$sha.ext4.zst" --body "$blob" --if-none-match '*' >/dev/null
aws s3api put-object --bucket "$bucket" --key "$key/$sha.json" --body "$manifest" --if-none-match '*' --content-type application/json >/dev/null
