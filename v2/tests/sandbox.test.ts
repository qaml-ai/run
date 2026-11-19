import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

test("code mode enforces the deadline when JavaScript or a host tool never settles", async t => {
  const main = fileURLToPath(new URL("./fixtures/sandbox-worker.ts", import.meta.url));
  const runtime = await unstable_startWorker({
    entrypoint: main,
    compatibilityDate: "2026-03-01",
    dev: { logLevel: "none" },
  });
  t.after(() => runtime.dispose());
  const run = async (path: string) =>
    (await runtime.fetch(`http://sandbox.test${path}`, { signal: AbortSignal.timeout(5_000) })).json();

  assert.deepEqual(await run("/complete"), { result: 42, logs: [] });
  assert.deepEqual(await run("/unresolved"), { error: "Sandbox timed out after 150 ms", stopped: false });
  assert.deepEqual(await run("/host"), { error: "Sandbox timed out after 150 ms", stopped: true });
  assert.deepEqual(await run("/cancel"), { error: "Run cancelled", stopped: true });
  assert.deepEqual(await run("/complete"), { result: 42, logs: [] });
});
