import { test } from "node:test";
import assert from "node:assert/strict";
import { startFixture } from "./fixture.ts";

// A create writes the agent's directory row, then the agent applies the configuration. The apply's database work can
// wait past the 10 s query timeout (here: setting its spend limit while the table is locked). The agent's PUT
// /configuration returned its mutation unawaited, so the failure rejected the stub's fetch, and a keyed retry was queued
// as a change on an agent with no configuration (404).
test("a configuration apply that fails after the directory commit answers 503, and a keyed retry creates the agent", { timeout: 180_000 }, async t => {
  const r = await startFixture();
  t.after(() => r.stop());
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(r.url + path, { method, headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const create = () => call("/v1/agents", "POST", { model: "test/echo", spendLimit: { usd: 3 } }, { "idempotency-key": "apply-wait" });

  const holder = await r.db.connect();
  try {
    // Held under the role's 30 s idle-in-transaction timeout; the agent's insert into it waits out its query timeout.
    await holder.query("begin");
    await holder.query("lock table agent_spend_limits in access exclusive mode");
    const waited = await create();
    assert.equal(waited.status, 503, JSON.stringify(waited.json));
    assert.equal(waited.json.code, "CONFIGURATION_PENDING");
  } finally {
    await holder.query("rollback").catch(() => {});
    holder.release();
  }
  const created = await create();
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;
  assert.equal((await call(`/v1/agents/${id}`)).json.spendLimit?.usd, 3);
  const run = await call(`/v1/agents/${id}/prompt`, "POST", { text: "hello" });
  assert.ok(run.status < 300, JSON.stringify(run.json));
});
