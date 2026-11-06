import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";

test("one database connection admits agent creation and purges its spend limit with the account", { timeout: 90_000 }, async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {
    AGENT_DATABASE_POOL_SIZE: "1", AGENT_PURGE_INTERVAL_MS: "1000", AGENT_BILLING_ADMINS: "alice",
  });
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db: r.db });
  const tenant = await accounts.tenantForGithub({ login: "port-audit", id: 987654, createdAt: 1 }, { minAccountAgeMs: 0 });
  const { token } = await accounts.createToken(tenant, "audit");
  const made = await r.call("/v1/agents", { token, body: { spendLimit: { usd: 3 } } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  assert.equal((await r.db.query("select count(*)::int as n from agent_spend_limits where agent = $1", [id])).rows[0].n, 1);
  assert.equal((await r.call(`/v1/tenants/${tenant}`, { method: "DELETE", token: OPERATOR })).status, 202);
  await until(async () => (await r.call(`/v1/tenants/${tenant}/deletion`, { token: OPERATOR })).json.state === "deleted", "single-connection account deletion", 60_000);
  assert.equal((await r.db.query("select count(*)::int as n from agent_spend_limits where agent = $1", [id])).rows[0].n, 0);
});

test("a changed end user is refused before a running turn and queued configurations finish", { timeout: 60_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const r = await runtime(t, async () => { await gate.promise; return { role: "assistant", content: "ok" }; });
  const headers = { "Idempotency-Key": "queued-identity-audit" };
  const first = await r.call("/v1/agents", { headers, body: { subject: "first-person", systemPrompt: "A" } });
  assert.equal(first.status, 201, first.text);
  await r.call(`/v1/agents/${first.json.id}/prompt`, { body: { text: "hold" } });
  await until(() => r.model.bodies.length === 1, "blocked model call");
  for (const systemPrompt of ["B", "A"]) {
    const queued = await r.call("/v1/agents", { headers, body: { subject: "first-person", systemPrompt } });
    assert.equal(queued.status, 201, queued.text);
    assert.equal(queued.json.reconfigured.state, "running");
  }
  const response = await fetch(`${r.base}/v1/agents`, {
    method: "POST", headers: { ...headers, Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subject: "second-person", systemPrompt: "C" }), signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 409, await response.text());
  assert.equal(r.model.bodies.length, 1);
  gate.resolve();
});
