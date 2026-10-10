import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, sleep } from "./runtime-server.ts";

// Apart from tests/runs.test.ts: twenty runs, each read every few ms for 400 ms so that some reads meet its agent's stop,
// take about 30 s on a loaded runner, which with the rest of runs.test.ts brought it near the shard's per-file limit.

test("a run's messages read as it ends are its messages, though its agent stops while answering", async t => {
  // A run that ends stops its agent: a read the agent was answering failed with "Agent stopped", and is read from its
  // log instead. Reads go out every few ms from the moment each run is made, so some meet the stop.
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }));
  const bad: string[] = [];
  for (let i = 0; i < 20; i++) {
    const created = await r.call("/v1/runs", { body: { input: `go ${i}` } });
    assert.ok([200, 202].includes(created.status), created.text);
    const reads: Promise<void>[] = [];
    for (const until = Date.now() + 400; Date.now() < until; await sleep(3)) {
      reads.push(r.call(`/v1/runs/${created.json.id}/messages`).then(read => {
        if (!Array.isArray(read.json?.messages)) bad.push(`run ${i}: ${read.status} ${read.text.slice(0, 200)}`);
      }));
    }
    await Promise.all(reads);
  }
  assert.deepEqual(bad, []);
});
