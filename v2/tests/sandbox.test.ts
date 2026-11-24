import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

test("RemoteCodemodeSandbox enforces the deadline when JavaScript or a host tool never settles", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-sandbox-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "sandbox-remote-test",
      main: fileURLToPath(new URL("./fixtures/sandbox-worker.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [{ name: "CODEMODE_SANDBOX", class_name: "CodemodeSandbox" }],
      },
      migrations: [{ tag: "v1", new_classes: ["CodemodeSandbox"] }],
    }),
  );

  const runtime = await unstable_startWorker({
    config,
    dev: { persist: false, logLevel: "none" },
  });
  t.after(() => runtime.dispose());

  const run = async (path: string) =>
    (await (await runtime.fetch(`http://sandbox.test${path}`, { signal: AbortSignal.timeout(10_000) })).json()) as Record<string, unknown>;

  assert.deepEqual(await run("/complete"), { result: 42, logs: [] });

  const unresolved = await run("/unresolved");
  assert.equal(unresolved.kind, "script", JSON.stringify(unresolved));
  assert.equal(unresolved.stopped, false);

  const host = await run("/host");
  assert.equal(host.kind, "timeout", JSON.stringify(host));
  assert.equal(host.stopped, true);

  const cancel = await run("/cancel");
  assert.equal(cancel.kind, "aborted", JSON.stringify(cancel));
  assert.equal(cancel.stopped, true);

  assert.deepEqual(await run("/complete"), { result: 42, logs: [] });
});
