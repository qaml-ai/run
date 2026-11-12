import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error: a plain .mjs script, without types
import { GATES, readLog, verdict, describe, report } from "../scripts/sprite-ci.mjs";

// scripts/sprite-ci.mjs reads sprite-test logs the way a person does: each gate's exit is its verdict, the TAP totals
// and top-level failures are its summary. These logs are shaped as sprite-test prints them (sharded runs prefix [i/n]).
const sharded = [
  "[1/3] # Subtest: a",
  "[1/3] ok 1 - a",
  "[1/3]     not ok 1 - a subtest, counted by its parent",
  "[1/3] # pass 58",
  "[1/3] # fail 0",
  "[1/3] == exit 0 in 299s on rt-pool-1; log ~/runs/x-1.log there",
  "[3/3] not ok 7 - the native computer in local Docker",
  "[3/3] # pass 42",
  "[3/3] # fail 1",
  "[3/3] # pass 1",
  "[3/3] # fail 0",
  "[3/3] == exit 1 in 1409s on rt-pool-3; log ~/runs/x-3.log there",
].join("\n");

test("a sharded log sums its totals over shards and runs, and keeps only top-level failures", () => {
  const log = readLog(sharded);
  assert.deepEqual(log.totals, { pass: 101, fail: 1, cancelled: 0 });
  assert.deepEqual(log.failures, ["the native computer in local Docker"]);
  assert.deepEqual(log.exits, [{ code: 0, seconds: 299, sprite: "rt-pool-1" }, { code: 1, seconds: 1409, sprite: "rt-pool-3" }]);
});

test("the exit decides a gate; a failure its run retried into a pass is noted, not failed", () => {
  const retried = verdict("full", 0, readLog("[7/8] not ok 45 - busy limit\n[7/8] # pass 10\n[7/8] # fail 1\n[7/8] ok 1 - busy limit\n[7/8] # pass 1\n[7/8] == exit 0 in 304s on rt-pool-14; log y"));
  assert.equal(retried.ok, true);
  assert.equal(retried.counts, "11/1");
  assert.equal(retried.note, " (1 retried)");
  const failed = verdict("workers-integration", 1, readLog(sharded));
  assert.equal(failed.ok, false);
  // A gate with no TAP (a build, a typecheck) is its exit alone.
  assert.equal(verdict("checks", 0, readLog("vite v6 building...\n== exit 0 in 90s on rt-pool-2; log z")).counts, "ok");
  assert.equal(verdict("checks", 2, readLog("error TS2554")).counts, "failed");
});

test("the status description puts failures first and fits GitHub's 140 characters", () => {
  const results = [verdict("full", 0, readLog("# pass 2886\n# fail 0")), verdict("workers-integration", 1, readLog(sharded)), verdict("checks", 0, readLog(""))];
  const text = describe(results);
  assert.equal(text, "1/3 gates failed: workers-integration FAILED 101/1, full 2886/0, checks ok");
  const many = Array.from({ length: 12 }, (_, i) => verdict(`gate-with-a-long-name-${i}`, 0, readLog("# pass 1000\n# fail 0")));
  assert.ok(describe(many).length <= 140);
  assert.match(describe(many), /^12\/12 gates passed: /);
});

test("the report names each gate's shards and lists the failing tests", () => {
  const body = report("0123456789abcdef", [verdict("workers-integration", 1, readLog(sharded))], "/tmp/out");
  assert.match(body, /\| \*\*FAIL\*\* \| `workers-integration` \| 101\/1 \| 0 in 299s on rt-pool-1<br>1 in 1409s on rt-pool-3 \|/);
  assert.match(body, /- the native computer in local Docker/);
});

test("the gates cover CI's required jobs, and each Workers gate is a validate-sprite.sh mode that exists", () => {
  assert.deepEqual(Object.keys(GATES).sort(), ["checks", "docs", "full", "python", "sim", "workers-integration", "workers-unit"]);
  const validate = readFileSync(new URL("../backends/workers/scripts/validate-sprite.sh", import.meta.url), "utf8");
  for (const gate of Object.values(GATES) as { args: string[] }[]) {
    const at = gate.args.indexOf("backends/workers/scripts/validate-sprite.sh");
    if (at >= 0) assert.match(validate, new RegExp(`^  ${gate.args[at + 1]}\\)`, "m"));
  }
  // CI's docs job runs these files; the docs gate runs the same list.
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const files = /--test (scripts\/ci-reuse\.test\.cjs[^\n]*)/.exec(ci)![1]!.trim();
  assert.ok(GATES.docs.args.at(-1).endsWith(files), "the docs gate's files are CI's docs job's");
});

test("a shard that reported no exit is a dead shard, said as such, not a failure count", () => {
  const log = readLog([
    "[1/3] == sprite-test abc on rt-pool-29: rsync, started in 9s",
    "[2/3] # pass 50",
    "[2/3] # fail 0",
    "[2/3] == exit 0 in 200s on rt-pool-31; log a",
    "[3/3] # pass 40",
    "[3/3] # fail 0",
    "[3/3] == exit 0 in 210s on rt-pool-32; log b",
    "== the coordinator lease on rt-pool-29 was lost (not renewed for 300s); the job still holds the sprite's lock",
  ].join("\n"));
  assert.deepEqual([log.shards, log.lost], [[2, 3], ["rt-pool-29"]]);
  const dead = verdict("workers-integration", 1, log, 3);
  assert.equal(dead.ok, false);
  assert.deepEqual(dead.died, [1]);
  assert.equal(dead.counts + dead.note, "shard 1 died: no result (lease lost on rt-pool-29); the others 90/0");
  assert.equal(describe([dead]), "1/1 gates failed: workers-integration shard 1 died: no result (lease lost on rt-pool-29)");
  // Every shard reported: the exit decides, as before; a gate run unsharded expects none.
  assert.equal(verdict("workers-integration", 0, readLog(sharded.replace("[3/3] == exit 1", "[3/3] == exit 0").replace("[1/3]", "[2/3]")), 0).ok, true);
  assert.deepEqual(verdict("full", 0, log, 8).died, [1, 4, 5, 6, 7, 8]);
  assert.equal(GATES.full.expectShards, 8);
});
