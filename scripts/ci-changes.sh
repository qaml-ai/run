#!/usr/bin/env bash
# Errors leave the expensive checks enabled. A reused result must cover this exact tree.
set -euo pipefail

tests=true
reuse=false
if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
  base=$(jq -r '.pull_request.base.sha' "$GITHUB_EVENT_PATH")
  head=$(jq -r '.pull_request.head.sha' "$GITHUB_EVENT_PATH")
  git fetch --no-tags origin "$base" "$head"
  if git diff --no-renames --name-only -z "$base...$head" | python3 -c '
import sys
paths = sys.stdin.buffer.read().decode().split("\0")
paths = [p for p in paths if p]
allowed = lambda p: p.startswith(("infra/terraform/", "docs/", "deploy/selfhost/", ".github/ISSUE_TEMPLATE/")) or p.endswith(".md")
sys.exit(0 if paths and all(map(allowed, paths)) else 1)
'; then
    tests=false
  fi
elif [ "$GITHUB_EVENT_NAME" = push ] && [ "$GITHUB_REF" = refs/heads/main ]; then
  # Only squash merges of a single PR qualify. Never use a green run from an older PR head.
  prs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls")
  matches=$(jq --arg sha "$GITHUB_SHA" '[.[] | select(.merged_at != null and .merge_commit_sha == $sha and .base.ref == "main")]' <<< "$prs")
  if [ "$(jq length <<< "$matches")" = 1 ]; then
    head=$(jq -r '.[0].head.sha' <<< "$matches")
    number=$(jq -r '.[0].number' <<< "$matches")
    run=$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs" -f event=pull_request -f head_sha="$head" -f per_page=1)
    id=$(jq -r --arg repo "$GITHUB_REPOSITORY" '.workflow_runs[0] | select(.conclusion == "success" and .head_repository.full_name == $repo) | .id' <<< "$run")
    if [ -n "$id" ]; then
      dir=$(mktemp -d)
      gh run download "$id" --repo "$GITHUB_REPOSITORY" --name tested-merge --dir "$dir"
      commit=$(jq -r --arg head "$head" --argjson number "$number" 'select(.head == $head and .pr == $number) | .commit' "$dir/merge.json")
      if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
        git fetch --no-tags origin "$commit"
        if [ "$(git rev-parse "$commit^2")" = "$head" ] && [ "$(git rev-parse "$commit^{tree}")" = "$(git rev-parse 'HEAD^{tree}')" ]; then
          tests=false
          reuse=true
          echo "::notice::Reusing successful PR #$number CI run $id: merge tree equals main"
        fi
      fi
    fi
  fi
fi
printf 'tests=%s\nreuse=%s\n' "$tests" "$reuse" >> "$GITHUB_OUTPUT"
