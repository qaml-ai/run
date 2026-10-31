#!/usr/bin/env bash
# Vendor Pi (github.com/earendil-works/pi, MIT) at one commit: build the packages camelRun uses and pack them into
# vendor/pi/, which package.json installs from (file:vendor/pi/<package>.tgz). See docs/operations/pi-vendoring.md.
#
#   scripts/vendor-pi.sh <commit sha>     then: npm install, review, test, PR
#
# The checkout and build happen in a temporary directory outside this repository, with Pi's own lockfile (npm ci).
# Our own changes to Pi, vendor/pi/patches/*.patch (git format-patch, applied in name order with git am), go on top of
# the commit before the build; one that does not apply stops the script, so a bump rebases or drops it (dropped once
# upstream has it). Every package is versioned <its version>-main.<short sha>, plus -camel.<number of patches> when
# patched, so a build of ours never passes for an upstream one.
set -euo pipefail

usage() { echo "usage: scripts/vendor-pi.sh <40-character Pi commit sha>" >&2; exit 2; }
[ $# -eq 1 ] || usage
commit="$1"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || usage

repo_url=https://github.com/earendil-works/pi
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/vendor/pi"
patches=()
for patch in "$out"/patches/*.patch; do [ -e "$patch" ] && patches+=("$patch"); done
# Pi package directory, npm name and our tarball name, in build order (each after the packages it depends on).
# pi-agent-core is a devDependency: camelRun imports only its types (AgentMessage, AgentTool, StreamFn).
packages=(
  "telemetry @earendil-works/pi-telemetry pi-telemetry"
  "chord @earendil-works/chord chord"
  "codemode @earendil-works/pi-codemode pi-codemode"
  "ai @earendil-works/pi-ai pi-ai"
  "agent @earendil-works/pi-agent-core pi-agent-core"
  "durable @earendil-works/pi-durable pi-durable"
)

# Its physical path: on macOS the temp directory is behind a symlink (/var -> /private/var), and tsc then sees
# Pi's sibling packages twice, under both paths, as different types.
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/vendor-pi.XXXXXX")" && pwd -P)"
trap 'rm -rf "$work"' EXIT
src="$work/pi"
mkdir -p "$src" "$work/packed"

echo "Fetching $repo_url at $commit"
git -C "$src" init -q
git -C "$src" fetch -q --depth 1 "$repo_url" "$commit"
git -C "$src" checkout -q --detach FETCH_HEAD
[ "$(git -C "$src" rev-parse HEAD)" = "$commit" ] || { echo "fetched the wrong commit" >&2; exit 1; }
date="$(git -C "$src" log -1 --format=%cI)"

for patch in ${patches[@]+"${patches[@]}"}; do
  echo "Applying $(basename "$patch")"
  if ! git -C "$src" -c user.name=vendor-pi -c user.email=vendor-pi@localhost am --quiet --3way "$patch"; then
    echo >&2
    echo "vendor/pi/patches/$(basename "$patch") does not apply to Pi $commit." >&2
    echo "Rebase it onto that commit (or delete it when upstream has the change), then run this again." >&2
    exit 1
  fi
done
short="${commit:0:12}"
suffix="main.$short${patches[0]+-camel.${#patches[@]}}"

# Every @earendil-works dependency of the packages we ship must be one we ship: a new sibling fails here.
names=()
for entry in "${packages[@]}"; do read -r _ name _ <<< "$entry"; names+=("$name"); done
for entry in "${packages[@]}"; do
  read -r dir name _ <<< "$entry"
  node -e '
    const [file, expected, ...shipped] = process.argv.slice(1);
    const manifest = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    if (manifest.name !== expected) { console.error(`${file} is ${manifest.name}, expected ${expected}`); process.exit(1); }
    if (manifest.license !== "MIT") { console.error(`${expected} is ${manifest.license}, not MIT`); process.exit(1); }
    const missing = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
      .filter((dependency) => dependency.startsWith("@earendil-works/") && !shipped.includes(dependency));
    if (missing.length) { console.error(`${expected} depends on ${missing.join(", ")}: add it to scripts/vendor-pi.sh`); process.exit(1); }
  ' "$src/packages/$dir/package.json" "$name" "${names[@]}"
done

echo "Installing Pi's dependencies (npm ci, its lockfile)"
# No install scripts: the packages we build need only tsc, and Pi's prepare (husky) wants a full clone.
(cd "$src" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)

# Stamp the version as `<upstream version>-main.<short sha>`, plus `-camel.<number of patches>` when patched (and the
# dependencies among them to match), so the lockfile, User-Agent and telemetry tell a vendored build from the npm
# release of the same number, and a patched build from an unpatched one.
dirs=()
for entry in "${packages[@]}"; do read -r dir _ _ <<< "$entry"; dirs+=("$src/packages/$dir/package.json"); done
node -e '
  const fs = require("node:fs");
  const [suffix, ...files] = process.argv.slice(1);
  const manifests = files.map(file => ({ file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) }));
  const versions = Object.fromEntries(manifests.map(({ manifest }) => [manifest.name, `${manifest.version}-${suffix}`]));
  for (const { file, manifest } of manifests) {
    manifest.version = versions[manifest.name];
    for (const field of ["dependencies", "peerDependencies", "devDependencies"])
      for (const name of Object.keys(manifest[field] ?? {})) if (versions[name]) manifest[field][name] = versions[name];
    fs.writeFileSync(file, JSON.stringify(manifest, null, "\t") + "\n");
  }
' "$suffix" "${dirs[@]}"

for entry in "${packages[@]}"; do
  read -r dir name file <<< "$entry"
  echo "Building $name"
  # pi-ai's build generates its model catalog from upstream sources (models.dev, OpenRouter, Vercel AI Gateway) at
  # this moment, so it needs the network; the tarball keeps that snapshot. PI_KEEP_CATALOG=1 builds it with the
  # catalog of the pi-ai tarball vendored now instead (a rebuild that must not change models or prices).
  build=build
  if [ "$dir" = ai ] && [ "${PI_KEEP_CATALOG:-}" = 1 ]; then
    tar -xzf "$out/pi-ai.tgz" -C "$work" package/dist/providers/data
    rm -rf "$src/packages/ai/src/providers/data" && mv "$work/package/dist/providers/data" "$src/packages/ai/src/providers/data"
    build=build:offline
  fi
  (cd "$src/packages/$dir" && npm run "$build" > "$work/build.log" 2>&1) || { cat "$work/build.log" >&2; exit 1; }
  json="$(cd "$src/packages/$dir" && npm pack --ignore-scripts --json --pack-destination "$work/packed")"
  packed="$(node -e 'const r = JSON.parse(process.argv[1]); console.log((r.filename ? r : Object.values(r)[0]).filename)' "$json")"
  mv "$work/packed/$packed" "$work/packed/$file.tgz"
done

# vendor/pi/patches stays: it is the input.
rm -f "$out"/*.tgz "$out/LICENSE" "$out/PI_COMMIT"
mkdir -p "$out"
mv "$work/packed/"*.tgz "$out/"
cp "$src/LICENSE" "$out/LICENSE"
# npm install keeps a locked file: dependency whose integrity it has cached, so it would not pick up the new tarballs:
# drop their entries from package-lock.json, which the install writes again, and from node_modules.
node -e '
  const fs = require("node:fs");
  const [file, ...shipped] = process.argv.slice(1);
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of Object.keys(lock.packages ?? {})) {
    if (shipped.some((name) => key === `node_modules/${name}` || key.startsWith(`node_modules/${name}/`))) delete lock.packages[key];
  }
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
' "$root/package-lock.json" "${names[@]}"
for name in "${names[@]}"; do rm -rf "${root:?}/node_modules/$name"; done
# The upstream changes since the commit vendored before (v1.4.0, the npm release, before the first vendoring).
previous="$(git -C "$root" show HEAD:vendor/pi/PI_COMMIT 2>/dev/null | sed -n 's/^commit //p' || true)"
previous="${previous:-v1.4.0}"
{
  echo "commit $commit"
  echo "date $date"
  echo "source $repo_url/commit/$commit"
  if [ -n "$previous" ] && [ "$previous" != "$commit" ]; then
    echo "changes $repo_url/compare/$previous...$commit"
  fi
  echo "packages ${names[*]}"
  echo "version $suffix"
  for patch in ${patches[@]+"${patches[@]}"}; do
    echo "patch $(basename "$patch") $(git hash-object "$patch")"
  done
} > "$out/PI_COMMIT"

echo
echo "vendor/pi now holds Pi $commit ($date), versioned -$suffix, with ${#patches[@]} patches:"
(cd "$out" && ls -l *.tgz | awk '{ printf "  %-22s %8.1f KiB\n", $9, $5 / 1024 }')
echo
echo "Next: npm install (updates package-lock.json), read the upstream changes (PI_COMMIT), npm run typecheck, test, PR."
