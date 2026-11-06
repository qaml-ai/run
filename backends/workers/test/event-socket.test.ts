import assert from "node:assert/strict";
import test from "node:test";
import { subscribedEvent, type EventSubscription } from "../src/event-socket.ts";

const browser: EventSubscription = { type: "camel.watcher", browser: {
  scopes: ["events"], events: ["message_end"], redact: ["usage.cost"], exp: 2000,
} };

test("hibernating browser subscriptions preserve event filters and cost redaction", () => {
  assert.equal(subscribedEvent(browser, { type: "event", event: { type: "message_update" } }, 1000), undefined);
  const visible = subscribedEvent(browser, { type: "event", event: { type: "message_end", message: {
    usage: { input: 10, cost: 12, providerCost: 11, nested: { usage: { output: 1, cost: 8 } } },
  } } }, 1000) as any;
  assert.deepEqual(visible.event.message.usage, { input: 10, nested: { usage: { output: 1 } } });
  assert.deepEqual(subscribedEvent(browser, { type: "response", id: "run", outcome: { result: { secret: "hidden" } } }, 1000),
    { type: "response", id: "run", outcome: {} });
  assert.equal(subscribedEvent(browser, { type: "event", event: { type: "message_end" } }, 2000), undefined);
});

test("socket request and child filters apply before browser projection", () => {
  const subscription: EventSubscription = { type: "camel.watcher", request: "wanted" };
  assert.equal(subscribedEvent(subscription, { type: "event", requestId: "other", event: { type: "agent_start" } }), undefined);
  assert.equal(subscribedEvent(subscription, { type: "response", id: "other" }), undefined);
  const own = { type: "event", requestId: "wanted", event: { type: "agent_start" } };
  assert.equal(subscribedEvent(subscription, own), own);
  assert.equal(subscribedEvent(subscription, { ...own, event: { type: "subagent_event", agentId: "child", event: { type: "agent_start" } } }), undefined);
});
