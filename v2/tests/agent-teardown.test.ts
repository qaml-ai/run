import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

test("agent deletion fences stale queue continuations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-agent-teardown-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({
    name: "agent-teardown-test",
    main: fileURLToPath(new URL("./fixtures/agent-teardown-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-01",
    compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    durable_objects: { bindings: [{ name: "TEST_AGENT", class_name: "TeardownTestAgent" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TeardownTestAgent"] }],
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const call = async (mode: string) => {
    const response = await worker.fetch(`https://agent-teardown.test/${mode}`, { signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  await t.test("an alarm resumed after deletion leaves SQLite empty", async () => {
    assert.deepEqual(await call("alarm"), { deleted: true, alarmFinished: true, storageEmpty: true });
  });
  await t.test("an accepted waiting run receives its cancellation after deletion", async () => {
    assert.deepEqual(await call("admission"), { deleted: true, status: "cancelled", storageEmpty: true });
  });
  await t.test("a terminal turn's queue drain settles before deletion clears SQLite", async () => {
    assert.deepEqual(await call("drain"), { deleted: true, deletedEarly: false, storageEmpty: true });
  });
});
