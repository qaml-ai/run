import { test } from "node:test";
import assert from "node:assert/strict";
import { startFixture } from "./fixture.ts";

// A tenant's turn settlements take one advisory lock in turn (control.ts settleTurn). On the pilot, 30 agents of one
// tenant ending runs together queued past the 10 s query timeout, and a prompt to an agent with a spend limit (which
// settles that agent's pending receipts first) answered 500 INTERNAL; DELETE threw after revoking the agent.
test("a settlement that waits past its query timeout answers 503, and DELETE says the agent is revoked", { timeout: 180_000 }, async t => {
  const r = await startFixture();
  t.after(() => r.stop());
  const tenant = "camelrun-proto-local";
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(r.url + path, { method, headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const completed = async (agent: string, run: string) => {
    for (let i = 0; i < 60; i++) {
      const view = await call(`/v1/agents/${agent}/requests/${run}?wait=5`);
      if (view.json?.state === "completed") return view.json;
    }
    throw new Error(`run ${run} did not complete`);
  };
  const created = await call("/v1/agents", "POST", { model: "test/echo", spendLimit: { usd: 3 } });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const first = await call(`/v1/agents/${id}/prompt`, "POST", { text: "one" });
  assert.ok(first.status < 300, JSON.stringify(first.json));
  await completed(id, first.json.id);

  // Another settlement of the tenant holds the lock while this agent's next turn ends: its receipt stays pending.
  const holder = await r.db.connect();
  try {
    // A session lock (the test database ends idle transactions) conflicts with settleTurn's transaction lock.
    await holder.query("select pg_advisory_lock(hashtextextended($1,0))", [`turn-receipts:${tenant}`]);
    const second = await call(`/v1/agents/${id}/prompt`, "POST", { text: "two" });
    assert.ok(second.status < 300, JSON.stringify(second.json));
    await completed(id, second.json.id);
    const waited = await call(`/v1/agents/${id}/prompt`, "POST", { text: "three" });
    assert.equal(waited.status, 503, JSON.stringify(waited.json));
    assert.deepEqual(waited.json, { code: "UNAVAILABLE", error: "Backend operation failed" });
    const deleting = await call(`/v1/agents/${id}`, "DELETE");
    assert.equal(deleting.status, 503, JSON.stringify(deleting.json));
    assert.equal(deleting.json.code, "CLEANUP_PENDING");
  } finally {
    await holder.query("select pg_advisory_unlock(hashtextextended($1,0))", [`turn-receipts:${tenant}`]).catch(() => {});
    holder.release();
  }
  const deleted = await call(`/v1/agents/${id}`, "DELETE");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.deepEqual(deleted.json, { deleted: true });
  assert.equal((await call(`/v1/agents/${id}`)).status, 404);
});
