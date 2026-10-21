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
  # Index by immutable tree, not PR head: a rerun, rebase, or a different PR can
  # have tested the same tree. The artifact is only a candidate; verify its run
  # and the aggregate check before trusting its recorded checkout tree.
  tree=$(git rev-parse 'HEAD^{tree}')
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  page=1
  while :; do
    artifacts=$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=tested-tree-$tree&per_page=100&page=$page")
    while read -r artifact; do
      [ -n "$artifact" ] || continue
      id=$(jq -r '.workflow_run.id' <<< "$artifact")
      run=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id")
      if ! jq -e --arg repo "$GITHUB_REPOSITORY" '
        .event == "pull_request" and .conclusion == "success" and
        .path == ".github/workflows/ci.yml" and .head_repository.full_name == $repo
      ' <<< "$run" >/dev/null; then continue; fi
      # Use the current attempt only; a failed rerun cannot borrow an old green gate.
      attempt=$(jq -r '.run_attempt' <<< "$run")
      jobs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$id/attempts/$attempt/jobs?per_page=100")
      if ! jq -se 'any(.[].jobs[]; .name == "CI success" and .conclusion == "success")' <<< "$jobs" >/dev/null; then continue; fi
      artifact_id=$(jq -r '.id' <<< "$artifact")
      gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact_id/zip" > "$dir/artifact.zip"
      unzip -p "$dir/artifact.zip" merge.json > "$dir/merge.json"
      head=$(jq -r '.head_sha' <<< "$run")
      if jq -e --arg tree "$tree" --arg head "$head" '
        .tree == $tree and .head == $head and
        (.commit | test("^[0-9a-f]{40}$")) and (.pr | type == "number")
      ' "$dir/merge.json" >/dev/null; then
        tests=false
        reuse=true
        echo "::notice::Reusing successful PR CI run $id: tested tree $tree equals main"
        break
      fi
    done < <(jq -c '.artifacts[] | select(.expired == false)' <<< "$artifacts")
    if [ "$reuse" = true ] || [ "$(jq '.artifacts | length' <<< "$artifacts")" -lt 100 ]; then break; fi
    page=$((page + 1))
  done
fi
printf 'tests=%s\nreuse=%s\n' "$tests" "$reuse" >> "$GITHUB_OUTPUT"
