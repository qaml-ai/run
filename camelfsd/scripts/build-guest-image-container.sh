#!/usr/bin/env bash
# Builds the guest image (build-guest-image.sh) in the pinned amazonlinux:2023 container, with the caller's Go
# toolchain mounted read-only. CI (ci.yml for pull requests, guest-image.yml for camelfs/files-model pushes) runs
# this, so the base digest and build-container packages live here, in a guest input, and not in a workflow file:
# an unrelated workflow edit must not change SOURCE_DATE_EPOCH and publish a new image.
set -euo pipefail
out=$(realpath -m "${1:?usage: build-guest-image-container.sh OUT-DIR}")
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
base=amazonlinux:2023@sha256:3ccfbe800f864982b0a4e124a614b2382518cbd04b3c1cd35202bd46f392675b
mkdir -p "$out"
docker run --rm --platform linux/amd64 \
  -v "$src:/src:ro" -v "$(go env GOROOT):/opt/go:ro" -v "$out:/out" -w /src "$base" bash -euc '
    dnf -y -q install git gcc e2fsprogs jq zstd findutils
    git config --global --add safe.directory /src
    export PATH="/opt/go/bin:$PATH"
    camelfsd/scripts/build-guest-image.sh /out
  '
