import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeAccountDeletion } from "../src/account-deletion-queue.ts";
import { eachLimited } from "../src/account-deletion.ts";
import type { DeliveryMessage } from "../src/webhooks.ts";

test("deletion continuation is durable before acknowledgement; a failed send can be redelivered", async () => {
  const events: string[] = [];
  let failSend = true;
  const env = { WEBHOOKS: { async send(body: DeliveryMessage, options: QueueSendOptions) {
    assert.deepEqual(body, { kind: "account_deletion", id: "deleted-account" });
    assert.equal(options.delaySeconds, 300, "interrupted lease determines the retry delay");
    events.push("send");
    if (failSend) throw new Error("queue interrupted");
  } } as Queue<DeliveryMessage> };
  const deletions = {
    async next(tenant?: string) { assert.equal(tenant, "deleted-account"); events.push("pass"); return false; },
    async retryAfter(tenant: string) { assert.equal(tenant, "deleted-account"); return 300; },
  };
  const message = { body: { kind: "account_deletion" as const, id: "deleted-account" }, ack() { events.push("ack"); } };
  await assert.rejects(consumeAccountDeletion(env, deletions, message), /queue interrupted/);
  assert.deepEqual(events, ["pass", "send"], "failed continuation leaves original delivery unacknowledged");
  failSend = false;
  await consumeAccountDeletion(env, deletions, message);
  assert.deepEqual(events, ["pass", "send", "pass", "send", "ack"]);
});

test("a completed or unknown deletion only acknowledges a duplicate queue delivery", async () => {
  let acknowledged = 0;
  await consumeAccountDeletion({}, { next: async () => false, retryAfter: async () => undefined }, {
    body: { kind: "account_deletion", id: "already-deleted" }, ack() { acknowledged++; },
  });
  assert.equal(acknowledged, 1);
});

test("a pass works on a bounded number of agents at once and starts no more after a failure", async () => {
  let active = 0, peak = 0;
  const started: number[] = [], finished: number[] = [];
  const work = async (n: number) => {
    started.push(n); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, n === 3 ? 1 : 20));
    active--;
    if (n === 3) throw new Error("agent 3 failed");
    finished.push(n);
  };
  await assert.rejects(eachLimited(Array.from({ length: 25 }, (_, n) => n), 5, work), /agent 3 failed/);
  assert.equal(peak, 5);
  assert.deepEqual(started, [0, 1, 2, 3, 4], "no agent starts after one failed");
  assert.deepEqual(finished.sort(), [0, 1, 2, 4], "those already started finish before the pass reports the failure");
  assert.equal(active, 0);

  const seen: number[] = [];
  await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async n => { seen.push(n); });
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await eachLimited([], 5, async () => { throw new Error("never called"); });
});
