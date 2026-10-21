import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const gate = workflow.split("      - name: Require successful checks or intentional skips\n")[1]
  .split("        run: |\n")[1].split("      - name:")[0];

function passes({ tests = true, image = true, event = "push", ref = "refs/heads/main", results = {} as Record<string, string> } = {}) {
  const states = { changes: "success", checks: "success", quick: "skipped", python: "success", test: "success", sim: "success", image: "success", docs: "success", publish: "success", ...results };
  const needs = workflow.split("  ci:\n")[1].match(/needs: \[(.+)\]/)![1].split(", ");
  assert.deepEqual(Object.keys(states).sort(), needs.sort(), "every required job has a fake state");
  const script = gate.replaceAll("${{ needs.changes.outputs.tests }}", String(tests))
    .replaceAll("${{ needs.changes.outputs.image }}", String(image))
    .replaceAll("${{ github.event_name }}", event).replaceAll("${{ github.ref }}", ref);
  assert.ok(!script.includes("${{"));
  return spawnSync("bash", ["-e", "-c", script], {
    env: { ...process.env, RESULTS: JSON.stringify(Object.fromEntries(Object.entries(states).map(([key, result]) => [key, { result }]))) },
    encoding: "utf8",
  }).status === 0;
}

test("CI gate requires every check and main publication", () => {
  assert.ok(passes());
  for (const job of ["changes", "checks", "python", "test", "sim", "image", "docs", "publish"]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.equal(passes({ results: { [job]: result } }), false, `${job}: ${result}`);
    }
  }
  for (const result of ["success", "failure", "cancelled"]) {
    assert.equal(passes({ results: { quick: result } }), false, `a draft's changed tests never stand for the suite: ${result}`);
  }
});

test("drafts never report CI success, so no merge can rest on their fast checks", () => {
  const job = workflow.split("  ci:\n")[1];
  assert.match(job, /if: always\(\) && needs\.changes\.outputs\.draft != 'true'\n/);
  assert.match(workflow, /draft: \$\{\{ steps\.changes\.outputs\.draft \|\| 'false' \}\}/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
});

test("PRs require images only when image inputs changed", () => {
  const options = { tests: false, event: "pull_request", ref: "refs/pull/303/merge", results: { python: "skipped", test: "skipped", sim: "skipped", publish: "skipped" } };
  assert.ok(passes(options));
  assert.equal(passes({ ...options, results: { ...options.results, image: "skipped" } }), false);
  assert.ok(passes({ ...options, image: false, results: { ...options.results, image: "skipped" } }));
  for (const result of ["failure", "cancelled"]) {
    assert.equal(passes({ ...options, image: false, results: { ...options.results, image: result } }), false);
  }
  assert.equal(passes({ image: false, results: { image: "skipped" } }), false, "main always needs images");
});


test("superseded PR cancellation covers the workflow and only PR matrices fail fast", () => {
  const concurrency = workflow.split("concurrency:\n")[1].split("jobs:\n")[0];
  assert.match(concurrency, /github\.event\.pull_request\.number/);
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
  const matrix = workflow.split("  test:\n")[1].split("  sim:\n")[0];
  assert.match(matrix, /fail-fast: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  const nightly = readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8");
  assert.match(nightly, /cancel-in-progress: false/);
});

test("ready PR gate reports failed and cancelled dependencies rather than skipping", () => {
  const options = { event: "pull_request", ref: "refs/pull/7/merge", results: { publish: "skipped" } };
  assert.ok(passes(options));
  for (const job of ["changes", "checks", "python", "test", "sim", "image", "docs"]) {
    for (const result of ["failure", "cancelled", "skipped"]) assert.equal(passes({ ...options, results: { ...options.results, [job]: result } }), false, `${job}: ${result}`);
  }
  assert.doesNotMatch(workflow, /outputs\.reuse|tested-tree/);
  const matrix = workflow.split("  test:\n")[1].split("  sim:\n")[0];
  assert.ok(matrix.includes("hosting: ${{ fromJSON(github.event_name == 'pull_request' && '[\"process\"]' || '[\"process\",\"inline\"]') }}"));
  assert.match(matrix, /TEST_FILES: \$\{\{ needs\.changes\.outputs\.selected \}\}/);
  assert.match(matrix, /TEST_INCLUDE_SIM: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("main failure summary names the commit, PR and last earlier green run", () => {
  const job = workflow.split("  ci:\n")[1];
  const summary = job.split("      - name: Identify failed main commit\n")[1];
  assert.match(summary, /if: failure\(\) && github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  const script = summary.split("        run: |\n")[1];
  const dir = mkdtempSync(join(tmpdir(), "ci-summary-"));
  try {
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
if [ "\${FAIL_API:-}" = true ]; then exit 1; fi
case "$*" in
  *commits/*/pulls*) echo '#375 https://github.com/qaml-ai/run/pull/375' ;;
  *actions/workflows/ci.yml/runs*) echo '{"workflow_runs":[{"run_number":12,"head_sha":"newer"},{"run_number":9,"head_sha":"last-green"},{"run_number":8,"head_sha":"older"}]}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    for (const fail of [false, true]) {
      const path = join(dir, `summary-${fail}`);
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "qaml-ai/run", GITHUB_SHA: "failing-sha", GITHUB_RUN_NUMBER: "10", GITHUB_STEP_SUMMARY: path, FAIL_API: String(fail) },
      });
      assert.equal(result.status, 0, result.stderr);
      const text = readFileSync(path, "utf8");
      assert.match(text, /Commit: failing-sha/);
      if (fail) assert.match(text, /Last green main SHA: unavailable \(API error\)/);
      else {
        assert.match(text, /PR: #375 https:\/\/github.com\/qaml-ai\/run\/pull\/375/);
        assert.match(text, /Last green main SHA: last-green/);
        assert.doesNotMatch(text, /newer|older/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
