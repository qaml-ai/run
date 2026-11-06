import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeAccountDeletion } from "../src/account-deletion-queue.ts";
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
