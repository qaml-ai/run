import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const commit = "c".repeat(40);

function changes(options: { event?: string; paths?: string[]; apiFailure?: boolean; success?: boolean; artifact?: boolean; sameTree?: boolean; sameHead?: boolean; merged?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
  try {
    writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { base: { sha }, head: { sha: head } } }));
    writeFileSync(join(dir, "git"), `#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  diff) printf '%s' '${(options.paths ?? ["src/server.ts"]).join("|")}' | tr '|' '\\0' ;;
  rev-parse)
    case "$2" in
      *^2) echo '${options.sameHead === false ? sha : head}' ;;
      HEAD*) echo tree ;;
      *) echo '${options.sameTree === false ? "different" : "tree"}' ;;
    esac ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
${options.apiFailure ? "exit 1" : ""}
case "$*" in
  *commits*) echo '${JSON.stringify(options.merged === false ? [] : [{ merged_at: "today", merge_commit_sha: sha, base: { ref: "main" }, head: { sha: head }, number: 1 }])}' ;;
  *workflows*) echo '${JSON.stringify({ workflow_runs: [{ id: 42, conclusion: options.success === false ? "failure" : "success", head_repository: { full_name: "qaml-ai/run" } }] })}' ;;
  "run download"*)
    ${options.artifact === false ? "exit 1" : `printf '%s' '${JSON.stringify({ commit, head, pr: 1 })}' > "\u0024{!#}/merge.json"`}
    ;;
esac
`, { mode: 0o755 });
    const result = spawnSync("bash", [fileURLToPath(new URL("ci-changes.sh", import.meta.url))], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, "output"), GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_EVENT_NAME: options.event ?? "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "qaml-ai/run", GITHUB_SHA: sha },
      encoding: "utf8",
    });
    // The workflow defaults to full CI when the script fails without producing outputs.
    return result.status === 0 ? readFileSync(join(dir, "output"), "utf8") : "tests=true\nreuse=false\n";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reuse only a successful PR run testing the same head and merge tree", () => {
  assert.equal(changes(), "tests=false\nreuse=true\n");
  for (const options of [{ apiFailure: true }, { success: false }, { artifact: false }, { sameTree: false }, { sameHead: false }, { merged: false }]) {
    assert.equal(changes(options), "tests=true\nreuse=false\n", JSON.stringify(options));
  }
});

test("only allowlisted PR paths skip expensive tests", () => {
  for (const paths of [["docs/guide.md", "infra/terraform/main.tf", "deploy/selfhost/docker-compose.yml", ".github/ISSUE_TEMPLATE/bug.yml", "README.md"], ["docs/page.ts"]]) {
    assert.equal(changes({ event: "pull_request", paths }), "tests=false\nreuse=false\n");
  }
  for (const paths of [[], ["README.md", "src/server.ts"], [".github/workflows/ci.yml"], ["docs/moved.ts", "src/deleted.ts"]]) {
    assert.equal(changes({ event: "pull_request", paths }), "tests=true\nreuse=false\n");
  }
});

test("manual runs always test", () => {
  assert.equal(changes({ event: "workflow_dispatch" }), "tests=true\nreuse=false\n");
});
