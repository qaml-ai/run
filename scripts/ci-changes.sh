#!/usr/bin/env bash
# Errors leave the expensive checks enabled.
set -euo pipefail

tests=true
image=true
draft=false
quick=
if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
  base=$(jq -r '.pull_request.base.sha' "$GITHUB_EVENT_PATH")
  head=$(jq -r '.pull_request.head.sha' "$GITHUB_EVENT_PATH")
  git fetch --no-tags origin "$base" "$head"
  if git diff --no-renames --name-only -z "$base...$head" | python3 -c '
import sys
paths = sys.stdin.buffer.read().decode().split("\0")
paths = [p for p in paths if p]
allowed = lambda p: not p.startswith(".github/") and (p.startswith(("infra/terraform/", "docs/", "deploy/selfhost/")) or p.endswith(".md"))
sys.exit(0 if paths and all(map(allowed, paths)) else 1)
'; then
    tests=false
  fi
  # Keep this list aligned with Dockerfile COPYs, the console build, and image smoke tests.
  # Diff with renames disabled so deletions/renames of inputs still trigger a build.
  if git diff --no-renames --name-only -z "$base...$head" | python3 -c '
import sys
paths = [p for p in sys.stdin.buffer.read().decode().split("\0") if p]
inputs = ("src/", "shared/", "sandbox/", "migrations/", "console/", "docs/", "packages/cli/", "packages/registry/public/r/", ".github/actions/", "vendor/")
files = {"Dockerfile", ".dockerignore", "package.json", "package-lock.json", ".npmrc", "clients/history-formats.ts", ".github/workflows/ci.yml", "scripts/ci-changes.sh", "scripts/backfill-pins.ts", "scripts/verify-gc.ts", "scripts/check-storage.ts", "scripts/voice-check.ts", "tests/image-isolation.ts", "tests/v8-exec.test.ts"}
sys.exit(0 if paths and not any(p in files or p.startswith(inputs) for p in paths) else 1)
'; then
    image=false
  fi
  # A draft runs the fast checks and the test files its change names; ready_for_review runs the rest.
  # Ask for the PR's state now, not the event's: a push just before "ready for review" sends a draft
  # event that supersedes the ready one, and a rerun replays its event.
  number=$(jq -r '.pull_request.number' "$GITHUB_EVENT_PATH")
  live_draft=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$number" --jq .draft) || exit 1
  if [ "$live_draft" != true ] && [ "$live_draft" != false ]; then exit 1; fi
  if [ "$live_draft" = true ]; then
    draft=true
    tests=false
    image=false
    quick=$(git diff --no-renames --name-only --diff-filter=d -z "$base...$head" | python3 -c '
import os, re, sys
paths = [p for p in sys.stdin.buffer.read().decode().split("\0") if p]
tests = set(os.listdir("tests")) if os.path.isdir("tests") else set()
picked = set()
for path in paths:
    name = os.path.basename(path)
    if path == "tests/" + name and name.endswith(".test.ts"):
        picked.add(name)
    elif path.startswith(("src/", "shared/", "clients/")) and name.endswith(".ts"):
        stem = re.escape(name[:-3])
        picked.update(t for t in tests if re.fullmatch(stem + r"(-[^/]*)?\.test\.ts", t))
# Beyond this, a draft is a broad change: the full run on ready_for_review covers it.
print(" ".join("tests/" + t for t in sorted(picked)[:40]))
')
  elif [ "$tests" = true ]; then
    selection=$(node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-select.ts --base "$base" --head "$head")
    echo "::notice::Test selection: $(jq -r '(.files | length | tostring) + " files; " + .reason' <<< "$selection")"
    # Empty means all files. JSON travels in an environment variable, never as shell arguments.
    if [ "$(jq -r .full <<< "$selection")" = false ]; then
      printf 'selected=%s\n' "$(jq -c .files <<< "$selection")" >> "$GITHUB_OUTPUT"
    fi
  fi
fi
printf 'tests=%s\nimage=%s\n' "$tests" "$image" >> "$GITHUB_OUTPUT"
if [ "$draft" = true ]; then printf 'draft=true\nquick=%s\n' "$quick" >> "$GITHUB_OUTPUT"; fi
