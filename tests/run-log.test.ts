import { test } from "node:test";
import assert from "node:assert/strict";
import { runLog, logOptions, LOG_PAGE_BYTES, LOG_ITEM_BYTES } from "../shared/run-log.ts";

test("run log caps page and item bytes, marks truncation and advances without losing entries", () => {
  const history = { entries: Array.from({ length: 100 }, (_, index) => ({ index, message: { role: "toolResult", content: [{ text: "界".repeat(30000) }] } })), total: 100 };
  const run = { id: "run_test", startedAt: 1, endedAt: 5, text: "x".repeat(100000) };
  let after = 0;
  const indices: number[] = [];
  while (after < history.total) {
    const page = runLog(run, { ...history, entries: history.entries.slice(after) }, { after, limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= LOG_PAGE_BYTES);
    assert.equal(page.run.truncated, true);
    assert.equal(page.truncated, true);
    assert.ok(page.events.length > 0);
    for (const event of page.events) {
      assert.equal(event.truncated, true);
      assert.ok(Buffer.byteLength(JSON.stringify(event.message)) <= LOG_ITEM_BYTES);
      indices.push(event.index);
    }
    after = page.next === undefined ? history.total : Number(page.next);
  }
  assert.deepEqual(indices, history.entries.map(e => e.index));
  assert.throws(() => logOptions(new URLSearchParams("limit=101")), /limit/);
  assert.throws(() => logOptions(new URLSearchParams("cursor=-1")), /cursor/);
});
