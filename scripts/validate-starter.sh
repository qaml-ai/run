#!/usr/bin/env bash
# Build and test generated apps using this checkout's SDK, without publishing it.
set -euo pipefail
repo=$PWD
version=$(node -p 'require("./sdk/package.json").version')
npm --prefix sdk run build
npm --prefix packages/react run build
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
(cd sdk && npm pack --quiet --ignore-scripts --pack-destination "$scratch")
(cd packages/react && npm pack --quiet --ignore-scripts --pack-destination "$scratch")
for platform in node cloudflare; do
  args=()
  [[ $platform == cloudflare ]] && args+=(--cloudflare)
  node packages/create-run-app/index.js "$scratch/$platform" --no-install "${args[@]}"
  cd "$scratch/$platform"
  npm pkg set "dependencies.@camelai/run=file:$scratch/camelai-run-$version.tgz" "dependencies.@camelai/run-react=file:$scratch/camelai-run-react-$version.tgz"
  npm install --no-audit --no-fund
  node --experimental-strip-types --test test/auth.test.ts
  npm run build
  if [[ $platform == cloudflare ]]; then
    npm run build:worker
    npx wrangler deploy --dry-run
  fi
  cd "$repo"
done
