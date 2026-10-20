import { test } from "node:test";
import assert from "node:assert/strict";
import { modeMatrix } from "./test-mode-matrix.ts";
test("PR matrix keeps the entire inline suite and selects only process-sensitive files", () => {
  const matrix = modeMatrix(5).include;
  assert.equal(matrix.length, 9);
  assert.equal(matrix.filter(job => job.hosting === "inline" && job.scope === "full").length, 5);
  assert.deepEqual(matrix.filter(job => job.hosting === "process").map(job => [job.shard, job.count, job.scope]), [1, 2, 3, 4].map(shard => [shard, 4, "sensitive"]));
  assert.equal(modeMatrix(12).include.length, 24);
});
test("measurement and nightly retain full coverage in both modes", () => {
  assert.equal(modeMatrix(5, true).include.length, 10);
  assert.ok(modeMatrix(5, true).include.every(job => job.scope === "full"));
  assert.throws(() => modeMatrix(0));
});
