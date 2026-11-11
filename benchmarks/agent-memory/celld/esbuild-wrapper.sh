#!/bin/sh
# celld's bundler (CELLD_ESBUILD) for the memory benchmark: the Workers backend's own esbuild, with node:net aliased to
# shims for what celld does not implement: node:net (the backend imports only isIP) and node:http(s) (Agent subclassed
# at load by agent-base).
here=$(cd "$(dirname "$0")" && pwd)
"$here/../../../backends/workers/node_modules/.bin/esbuild" "$@" "--alias:node:net=$here/net-shim.ts" \
  "--alias:http=$here/http-shim.ts" "--alias:https=$here/http-shim.ts" "--alias:node:http=$here/http-shim.ts" "--alias:node:https=$here/http-shim.ts" || exit $?
# Keep the last bundle for debugging (gitignored).
for a in "$@"; do case $a in --outdir=*) rm -rf "$here/.last-bundle"; cp -r "${a#--outdir=}" "$here/.last-bundle" ;; esac; done
