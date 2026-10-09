import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime } from "./runtime-server.ts";

// Apart from tests/runs.test.ts: a stalled model is waited out through every retry and its backoff (about 20 s), which
// with the rest of runs.test.ts brought it near the shard's per-file limit on a loaded runner.

test("a run whose model stalls ends failed with model_stream_stalled, never hanging busy", { timeout: 60_000 }, async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "never", delayMs: 15_000 }));
  const started = Date.now();
  const created = (await r.call("/v1/runs", { body: { input: "hello?", runLimits: { firstTokenSeconds: 1 } } })).json;
  let run = created;
  while (run.status === "running" && Date.now() - started < 45_000) run = (await r.call(`/v1/runs/${created.id}?wait=10`)).json;
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.error.code, "model_stream_stalled");
  assert.ok(Date.now() - started < 30_000);
  assert.ok(r.model.bodies.length >= 3, "the first request and its retries");
  // Not busy any more: the next run is accepted.
  assert.equal((await r.call("/v1/runs", { body: { input: "again" } })).status, 202);
});
