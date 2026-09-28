#!/usr/bin/env bash
# Publish an empty 0.0.0 placeholder of each new package of the release train, once, so npm can be told
# to trust .github/workflows/publish-sdk.yml for it (npm trust needs the package to exist). Run it as an
# owner of the @camelai scope, signed in to npm (npm login); npm asks for your 2FA code. Packages that
# already exist are skipped. Then run the `npm trust github …` commands it prints, and push the tag.
set -euo pipefail
packages=(@camelai/agent-runtime-react @camelai/agent-runtime-vue @camelai/agent-runtime-svelte @camelai/agent-runtime-solid @camelai/create-agent-app)
for name in "${packages[@]}"; do
  if npm view "$name" name >/dev/null 2>&1; then echo "$name exists: skipped"; continue; fi
  dir="$(mktemp -d)"
  cat > "$dir/package.json" <<JSON
{ "name": "$name", "version": "0.0.0", "description": "Placeholder: the real release is coming.", "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/qaml-ai/agent-runtime.git" } }
JSON
  printf '# %s\n\nPlaceholder: the real release is coming. See https://agents.camelai.dev.\n' "$name" > "$dir/README.md"
  (cd "$dir" && npm publish --access public)
  rm -rf "$dir"
done
echo
echo "Now let the publish workflow publish them:"
for name in "${packages[@]}"; do
  echo "  npm trust github $name --repo qaml-ai/agent-runtime --file publish-sdk.yml --env npm --allow-publish"
done
echo "Then tag a commit on main: git tag sdk-v<version> <commit> && git push origin sdk-v<version>"
