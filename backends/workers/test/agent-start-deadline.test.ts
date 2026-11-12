import assert from "node:assert/strict";
import test from "node:test";
import { startDeadline } from "../src/start-deadline.ts";

test("a startup step past its deadline fails the start at once (503), never waits into the 30 s reset; one in time answers", async t => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => { errors.push(line); });
  assert.equal(await startDeadline("quick", Promise.resolve(7), 50), 7);
  const began = Date.now();
  await assert.rejects(startDeadline("custom providers", new Promise(() => {}), 50), (error: Error & { status?: number }) => error.status === 503 && /custom providers took over 50 ms/.test(error.message));
  assert.ok(Date.now() - began < 1_000);
  assert.ok(errors.some(line => line.includes('"agent_start_deadline"') && line.includes("custom providers")));
});

test("startup's cancellation restore hands abortPending to after-start: it never waits on the send that started the object", async () => {
  const { restoreCancellationsImpl } = await import("../src/agent-cancellation.ts");
  let aborts = 0;
  const runtime = {
    records: async () => [{ id: "a", state: "running", noticeQueued: true }, { id: "b", state: "running", noticeQueued: true }],
    ctx: { storage: { get: async (key: string) => key.startsWith("cancelled-request:") ? true : undefined } },
    // As with a send in flight that waits on this startup: never settles.
    notifications: { abortPending: () => { aborts++; return new Promise(() => {}); } },
  } as never;
  const later: (() => Promise<unknown>)[] = [];
  await restoreCancellationsImpl.call(runtime, task => { later.push(task); });
  assert.equal(aborts, 0, "nothing awaited inside startup");
  assert.equal(later.length, 1, "queued notices are aborted once, after startup");
  void later[0]();
  assert.equal(aborts, 1);
});
