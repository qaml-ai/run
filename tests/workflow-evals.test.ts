// The workflow evals' hidden scorers (evals/workflows): each task's reference solution scores near 1, the untouched
// input scores low, and each gamed solution (a stub with its test skipped, a deleted test file, ts-nocheck, a
// shotgun list of findings) is caught. No model or runtime: the trees are fixtures, run on this host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { guardUrl } from "../evals/workflows/lib/runtime.ts";
import { glob, integrity, tapCounts } from "../evals/workflows/lib/score.ts";
import { checkTask, loadTasks } from "../evals/workflows/lib/tasks.ts";

for (const task of loadTasks().filter(task => task.status === "ready")) {
  test(`${task.id}: reference, untouched and gamed fixtures score as expected`, async () => {
    const results = await checkTask(task, "host");
    assert.ok(results.length >= 3, `${task.id} has fixtures`);
    for (const result of results) assert.ok(result.ok, `${task.id} / ${result.fixture}: ${result.why}`);
    assert.ok(results.some(result => result.score.integrity.gamingSuspected), `${task.id} has a gamed fixture that is caught`);
  });
}

test("every task manifest is complete, and planned ones say where their input and judge come from", () => {
  for (const task of loadTasks()) {
    assert.ok(task.prompt && task.budget.usd > 0 && task.budget.wallMinutes > 0 && task.units > 0, task.id);
    if (task.status === "planned") assert.ok((task.source as { port?: unknown; judge?: unknown })?.port && (task.source as { judge?: unknown }).judge, `${task.id} names its port and judge`);
  }
  assert.deepEqual([...new Set(loadTasks().map(task => task.tier))].sort(), ["L", "M", "N", "S"]);
});

test("each reference workflow script runs against stand-in globals: every agent() has a unique key and a definition", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const task of loadTasks().filter(task => task.status === "ready")) {
    const calls: { key?: string; definition?: string; type?: string }[] = [];
    const args = { ...task.workflowArgs, definitions: { worker: "def-worker", critic: "def-critic", lead: "def-lead" }, workerClass: "fast" };
    const code = `const args = ${JSON.stringify(args)};\n${readFileSync(join(task.dir, "workflow.js"), "utf8").replace(/^export\s+/gm, "")}`;
    const globals = {
      agent: async (_prompt: string, options: { key?: string; definition?: string; type?: string; output?: unknown }) => { calls.push(options); return options.output ? { findings: calls.length % 3 ? [] : [{ file: "lib/m01.js", problem: "p", table: "t", column: "c", kind: "k", rows: [1] }] } : "done"; },
      parallel: (thunks: (() => unknown)[]) => Promise.all(thunks.map(thunk => thunk())),
      phase: () => {}, log: () => {},
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction(...Object.keys(globals), code)(...Object.values(globals));
    assert.ok(calls.length >= task.units, `${task.id} starts at least one agent per unit`);
    assert.equal(new Set(calls.map(call => call.key)).size, calls.length, `${task.id}: keys are unique`);
    for (const call of calls) assert.ok(call.key && call.definition?.startsWith("def-") && call.type, `${task.id}: ${JSON.stringify(call)}`);
  }
});

test("evals refuse production runtimes and unknown hosts", () => {
  assert.throws(() => guardUrl("https://run.camelai.com"), /production/);
  assert.throws(() => guardUrl("https://agents.camelai.dev/v1"), /production/);
  assert.throws(() => guardUrl("https://example.org"), /not a known eval runtime/);
  assert.equal(guardUrl("https://run-pilot.camelai.dev"), "run-pilot.camelai.dev");
  assert.equal(guardUrl("http://127.0.0.1:8788"), "127.0.0.1");
  assert.equal(guardUrl("https://dev.example.org", "dev.example.org"), "dev.example.org");
});

test("globs, TAP counts and the skip scan", async () => {
  assert.ok(glob("test/**/*.test.{js,ts}").test("test/a/b.test.ts") && glob("test/**/*.test.{js,ts}").test("test/b.test.js") && !glob("src/*.ts").test("src/a/b.ts"));
  assert.deepEqual(tapCounts("# tests 4\n# pass 2\n# fail 1\n# skipped 1\nnot ok 3 - parses\n"), { tests: 4, pass: 2, fail: 1, skipped: 1, todo: 0, cancelled: 0, failures: ["parses"] });
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const before = mkdtempSync(join(tmpdir(), "wf-eval-int-")), after = mkdtempSync(join(tmpdir(), "wf-eval-int-"));
  for (const root of [before, after]) mkdirSync(join(root, "tests"));
  writeFileSync(join(before, "tests", "a_test.rs"), "#[test]\nfn a() {}\n#[test]\nfn b() {}\n");
  writeFileSync(join(after, "tests", "a_test.rs"), "#[test]\n#[ignore]\nfn a() {}\n#[test]\nfn b() { todo!() }\n");
  const found = integrity(before, after, { tests: ["tests/**/*.rs"], source: ["tests/**/*.rs"] });
  assert.equal(found.skippedTests[0]?.rule, "rust-ignore");
  assert.equal(found.stubs[0]?.rule, "rust-todo");
  assert.ok(found.gamingSuspected);
});
