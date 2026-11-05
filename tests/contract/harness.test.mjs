import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceKeys, selectCases, partitionFiles, greenFor, saveBaseline, loadBaseline, mergeReports } from "./harness.mjs";
import { groupFor, groups } from "./groups.mjs";

const row = (name, file, area = "tools") => ({ name, file, area, source: "tests/source.ts:1" });
const a = row("a", "a.ts"), b = row("b", "b.ts");
const green = (rows, extra = {}) => ({ backend: "node", nodeKey: "node-key", suiteHash: "suite-hash", rows: rows.map(item => ({ ...item, status: "pass", durationMs: 100 })), ...extra });

test("Node baseline key follows data/imports but excludes Worker-only changes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-keys-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ["package.json", "package-lock.json", "openapi.json", "tests/runtime-server.ts", "tests/fake-launcher.ts", "tests/database.ts", "tests/python_sdk.py", "tests/contract/fixture.ts", "tests/contract/fixtures/workers.ts", "src/a.ts", "src/data.txt", "backends/workers/package.json", "backends/workers/package-lock.json", "backends/workers/wrangler.test.jsonc", "backends/workers/codemode/wrangler.jsonc", "backends/workers/src/index.ts"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "initial");
  }
  await writeFile(path.join(root, "tests/runtime-server.ts"), 'import "../test-helper.ts";');
  await writeFile(path.join(root, "tests/contract/fixture.ts"), 'new URL("../../", import.meta.url);');
  await writeFile(path.join(root, "tests/contract/scopes.mjs"), 'new URL("../", import.meta.url);');
  await writeFile(path.join(root, "tests/contract/python_runner_test.py"), "harness meta-test");
  await writeFile(path.join(root, "tests/unrelated.test.ts"), "unrelated test");
  await writeFile(path.join(root, "unrelated.txt"), "unrelated repository root file");
  await writeFile(path.join(root, "test-helper.ts"), "helper");
  const initial = await sourceKeys(root);
  await writeFile(path.join(root, "tests/unrelated.test.ts"), "unrelated test changed");
  await writeFile(path.join(root, "tests/contract/python_runner_test.py"), "harness meta-test changed");
  await writeFile(path.join(root, "unrelated.txt"), "unrelated repository root file changed");
  assert.equal((await sourceKeys(root)).nodeKey, initial.nodeKey);
  await writeFile(path.join(root, "backends/workers/src/index.ts"), "fix");
  await writeFile(path.join(root, "tests/contract/fixtures/workers.ts"), "worker fixture fix");
  const workerChange = await sourceKeys(root);
  assert.equal(workerChange.nodeKey, initial.nodeKey);
  assert.notEqual(workerChange.suiteHash, initial.suiteHash);
  await writeFile(path.join(root, "src/data.txt"), "new runtime data");
  const dataChange = await sourceKeys(root);
  assert.notEqual(dataChange.nodeKey, initial.nodeKey);
  await writeFile(path.join(root, "test-helper.ts"), "helper changed");
  assert.notEqual((await sourceKeys(root)).nodeKey, dataChange.nodeKey);
  const details = await sourceKeys(root, { details: true });
  assert.ok(details.nodeFiles.includes("test-helper.ts"));
  assert.ok(!details.nodeFiles.includes("tests/unrelated.test.ts"));
  assert.ok(!details.nodeFiles.includes("tests/contract/python_runner_test.py"));
  assert.ok(!details.nodeFiles.includes("unrelated.txt"));
});

test("bare workspace imports add only the imported local package", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-workspaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ["package.json", "package-lock.json", "openapi.json", "tests/runtime-server.ts", "tests/fake-launcher.ts", "tests/database.ts", "tests/python_sdk.py", "tests/contract/fixtures/workers.ts", "backends/workers/package.json", "backends/workers/package-lock.json", "backends/workers/wrangler.test.jsonc", "backends/workers/codemode/wrangler.jsonc"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "initial");
  }
  for (const name of ["used", "unrelated"]) {
    await mkdir(path.join(root, "packages", name), { recursive: true });
    await writeFile(path.join(root, "packages", name, "package.json"), JSON.stringify({ name: `@test/${name}` }));
    await writeFile(path.join(root, "packages", name, "index.ts"), "initial");
  }
  await writeFile(path.join(root, "tests/runtime-server.ts"), 'import "@test/used";');
  const initial = await sourceKeys(root, { details: true });
  assert.ok(initial.nodeFiles.includes("packages/used/index.ts"));
  assert.ok(!initial.nodeFiles.includes("packages/unrelated/index.ts"));
  await writeFile(path.join(root, "packages/unrelated/index.ts"), "changed");
  assert.equal((await sourceKeys(root)).nodeKey, initial.nodeKey);
  await writeFile(path.join(root, "packages/used/index.ts"), "changed");
  assert.notEqual((await sourceKeys(root)).nodeKey, initial.nodeKey);
});

test("a matching full green baseline serves a subset and rejects stale or failing evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = green([a, b]);
  assert.equal(greenFor(report, [a], "node-key"), true);
  assert.equal(greenFor(report, [a], "changed-key"), false);
  assert.equal(greenFor(green([a, b], { rows: [{ ...a, status: "fail" }, { ...b, status: "pass" }] }), [b], "node-key"), false);
  await saveBaseline(root, green([a]));
  await saveBaseline(root, green([b]));
  assert.equal((await loadBaseline(root, "node-key", [a, b])).report.rows.length, 2);
  assert.equal(await loadBaseline(root, "changed-key", [a]), null);
});

test("groups are exhaustive, file overrides win, and filters intersect", () => {
  const file = row("mcp", "tests/contract/areas/agent-mcp.contract.test.ts", "agents");
  assert.equal(groupFor(file), "tools-mcp");
  assert.equal(groupFor(row("account", "future-account.ts", "accounts")), "accounts-auth");
  assert.equal(groupFor(row("oauth", "future-oauth.ts", "oauth")), "accounts-auth");
  assert.equal(groupFor(row("unknown", "test.ts", "new-area")), "other");
  assert.deepEqual(selectCases([file, a, b], { group: "tools-mcp", area: "agents" }), [file]);
  assert.deepEqual(selectCases([a, b], { files: "a.ts" }), [a]);
  assert.throws(() => selectCases([a], { group: "not-a-group" }), /Unknown group/);
  assert.equal(Object.keys(groups).length, 10);
});

test("sharding keeps each file together, balances measured durations and is deterministic", () => {
  const manifest = [a, row("a2", "a.ts"), b, row("c", "c.ts")];
  const durations = manifest.map(item => ({ ...item, durationMs: item.file === "b.ts" ? 5000 : 100 }));
  const shards = partitionFiles(manifest, 2, durations);
  assert.deepEqual(shards, [["b.ts"], ["a.ts", "c.ts"]]);
  assert.deepEqual(partitionFiles([...manifest].reverse(), 2, durations), shards);
  assert.deepEqual(partitionFiles([a], 3), [["a.ts"], [], []]);
});

test("merge preserves failures and rejects missing, duplicate, stale or extra results", () => {
  const first = green([a], { shard: { index: 1, total: 2 }, expectedCases: 1, durationMs: 200, recordedAt: "2026-01-01" });
  const second = green([b], { shard: { index: 2, total: 2 }, expectedCases: 1, durationMs: 300, recordedAt: "2026-01-02", rows: [{ ...b, status: "fail", reason: "assertion" }] });
  const context = { backend: "node", nodeKey: "node-key", suiteHash: "suite-hash" };
  const merged = mergeReports([second, first], [a, b], context);
  assert.deepEqual(merged.rows.map(item => item.status), ["pass", "fail"]);
  assert.equal(merged.durationMs, 300);
  assert.throws(() => mergeReports([first], [a, b], context), /Expected 2 shard reports/);
  assert.throws(() => mergeReports([first, first], [a, b], context), /duplicate shard identity/);
  assert.throws(() => mergeReports([first, { ...second, nodeKey: "stale" }], [a, b], context), /different source inputs/);
  assert.throws(() => mergeReports([first, second], [a], context), /Unexpected shard case/);
  assert.throws(() => mergeReports([first, { ...second, rows: [] }], [a, b], context), /incomplete inventory/);
});
