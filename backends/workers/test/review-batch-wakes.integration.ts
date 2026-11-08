import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { startFixture } from "./fixture.ts";

async function fixture(t: TestContext) {
  const f = await startFixture({
    entrypoint: fileURLToPath(new URL("./alarm-entry.ts", import.meta.url)),
    vars: { PILOT_DB_PROFILE: "1" },
  });
  t.after(() => f.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(f.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  return { f, call };
}

/** Wakes (camel-wake jobs) an agent runs in 2 s while a slow turn runs and one prompt waits behind it. */
async function wakesWhileQueued(call: Awaited<ReturnType<typeof fixture>>["call"], queue: unknown) {
  const { id } = await call("/v1/agents", { model: "test/echo", ...(queue ? { queue } : {}) });
  await call(`/v1/agents/${id}/requests`, { id: "slow", method: "prompt", params: { text: "slow:8000:the long turn" } });
  await delay(800);
  await call(`/v1/agents/${id}/requests`, { id: "behind", method: "prompt", params: { text: "waits behind it" } });
  await delay(800);
  const before = await call(`/experimental/agents/${id}/__test/alarm-state`);
  await delay(2000);
  const after = await call(`/experimental/agents/${id}/__test/alarm-state`);
  return after.wakes - before.wakes;
}

test("review: a prompt held for a batch behind a running turn does not spin the watchdog", { timeout: 90000 }, async t => {
  const { call } = await fixture(t);
  const plain = await wakesWhileQueued(call, undefined);
  const batching = await wakesWhileQueued(call, { mode: "batch" });
  console.log(JSON.stringify({ type: "review_wakes", plain, batching }));
  assert.ok(batching <= Math.max(5, plain * 3), `wakes in 2 s: ${batching} with batching vs ${plain} without`);
});
