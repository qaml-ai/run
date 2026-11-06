import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationAgentKey } from "../src/channels.ts";
import { validId } from "../src/client-sessions/state.ts";

test("a conversation's agent key is always a valid provisioning key, and the same one each time", () => {
  // Slack thread ids carry a dot; webhook keys may carry dots or run long. The agent's provisioning key refuses both,
  // which failed every Slack thread agent with 400 "Invalid provisioning idempotency key".
  const channel = "ch_0123456789abcdef0123";
  for (const conversation of ["C1-100.0001", "1699999999.123456", "x".repeat(62), "order/42?#"]) {
    for (const generation of [0, 3]) {
      const key = conversationAgentKey("slack", channel, conversation, generation);
      assert.ok(validId(key), `${key} is a valid provisioning key`);
      assert.equal(conversationAgentKey("slack", channel, conversation, generation), key, "the same conversation keeps its key");
    }
    assert.notEqual(conversationAgentKey("slack", channel, conversation, 0), conversationAgentKey("slack", channel, conversation, 1), "a new generation gets a new agent");
  }
  // Keys that already fit are unchanged, so no existing conversation moves to a new agent.
  assert.equal(conversationAgentKey("telegram", channel, "12345"), `telegram-${channel}-12345`);
  assert.equal(conversationAgentKey("webhook", channel, "default", 2), `webhook-${channel}-default-2`);
  assert.notEqual(conversationAgentKey("slack", channel, "C1-100.0001"), conversationAgentKey("slack", channel, "C1-100.0002"), "threads stay apart");
});
