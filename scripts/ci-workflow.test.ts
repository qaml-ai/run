import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const gate = workflow.split("      - name: Require successful checks or intentional skips\n")[1]
  .split("        run: |\n")[1].split("      - uses:")[0];

function passes({ reuse = false, tests = true, image = true, event = "push", ref = "refs/heads/main", results = {} as Record<string, string> } = {}) {
  const states = { changes: "success", checks: "success", quick: "skipped", python: "success", test: "success", sim: "success", image: "success", docs: "success", publish: "success", ...results };
  const script = gate.replaceAll("${{ needs.changes.outputs.reuse }}", String(reuse))
    .replaceAll("${{ needs.changes.outputs.tests }}", String(tests))
    .replaceAll("${{ needs.changes.outputs.image }}", String(image))
    .replaceAll("${{ github.event_name }}", event).replaceAll("${{ github.ref }}", ref);
  assert.ok(!script.includes("${{"));
  return spawnSync("bash", ["-e", "-c", script], {
    env: { ...process.env, RESULTS: JSON.stringify(Object.fromEntries(Object.entries(states).map(([key, result]) => [key, { result }]))) },
    encoding: "utf8",
  }).status === 0;
}

test("CI gate requires every non-reused check and main publication", () => {
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

test("drafts never report CI success, so no merge or main reuse can rest on their fast checks", () => {
  const job = workflow.split("  ci:\n")[1];
  assert.match(job, /if: always\(\) && !github\.event\.pull_request\.draft\n/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
});

test("proven reuse accepts only main with successful publication and intentional skips", () => {
  const results = Object.fromEntries(["checks", "python", "test", "sim", "docs"].map(job => [job, "skipped"]));
  assert.ok(passes({ reuse: true, tests: false, results }));
  assert.equal(passes({ reuse: false, tests: false, results }), false);
  assert.equal(passes({ reuse: true, tests: false, results, event: "pull_request", ref: "refs/pull/303/merge" }), false);
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(passes({ reuse: true, tests: false, results: { ...results, publish: result } }), false);
  }
  assert.equal(passes({ reuse: true, tests: false, results: { ...results, image: "failure" } }), false);
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
