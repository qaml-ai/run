import assert from "node:assert/strict";
import test from "node:test";
import { flushJourney } from "../src/journey-delivery.ts";

test("a concurrent journey flush drains events queued after the active batch", async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pending = ["first"], delivered: string[] = [];
  let active = false, calls = 0;
  const journey = {
    async send() {
      if (active) return;
      active = true;
      calls++;
      const batch = pending.splice(0);
      if (calls === 1) { started.resolve(); await release.promise; }
      delivered.push(...batch);
      active = false;
    },
  };
  const first = flushJourney(journey);
  await started.promise;
  pending.push("second");
  const second = flushJourney(journey);
  pending.push("third");
  assert.equal(flushJourney(journey), second, "overlapping requests share one follow-up flush");
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(delivered, ["first", "second", "third"]);
  assert.equal(calls, 2);
  pending.push("later");
  await flushJourney(journey);
  assert.deepEqual(delivered, ["first", "second", "third", "later"]);
});
