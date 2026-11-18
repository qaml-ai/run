#!/usr/bin/env bash
# Run as the benchmark user from the repo root on the NVMe host.
set -euo pipefail
base=$(realpath "$1")
mkdir "$base/npm-source" "$base/fuse-build"
git archive HEAD package.json package-lock.json vendor src clients backends/workers/src plugins shared packages tsconfig.core.json tsconfig.json | tar -x -C "$base/npm-source"
cat > "$base/npm-source/bench.json" <<'JSON'
{"extends":"./tsconfig.json","compilerOptions":{"noEmit":false,"rewriteRelativeImportExtensions":true,"rootDir":".","outDir":"dist"},"include":["src/**/*.ts"]}
JSON
cp prototypes/block/fuse-loop/main.go "$base/fuse-build/main.go"
(cd "$base/fuse-build" && go mod init comparison && go get github.com/hanwen/go-fuse/v2/fs@v2.12.1 && go build -o "$base/fuse-loop" .)
cp -a "$base/npm-source" "$base/prime"
(cd "$base/prime" && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --no-audit --no-fund --cache "$base/npm-cache")
