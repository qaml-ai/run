import assert from "node:assert/strict";
import test from "node:test";
import { agentSpendRefusal, agentSpendView, pendingAgentSpend, readAgentSpendLimit, remainingAgentSpend, setAgentSpendLimit, spendInput, writeAgentSpend } from "../src/agent-spend.ts";
import { transaction } from "../src/postgres.ts";
import { startFixture } from "./fixture.ts";

test("agent spend uses the source input and refusal policy", () => {
  assert.equal(spendInput(null), null);
  assert.equal(spendInput({ usd: 0 }), 0);
  assert.equal(spendInput({ usd: 1_000_000 }), 1_000_000);
  for (const value of [undefined, [], -1, { usd: -1 }, { usd: Infinity }, { usd: NaN }, { usd: 1, extra: true }]) {
    assert.throws(() => spendInput(value), /spendLimit must be/);
  }
  const spend = { usd: 0.2, spent: 0.15, setAt: 123 };
  assert.equal(agentSpendRefusal("client_test", spend), undefined);
  assert.deepEqual(agentSpendRefusal("client_test", spend, 0.15), {
    error: 'This agent has reached its spend limit of $0.2 ($0.3 spent since it was set); raise it with PATCH /v1/agents/client_test/configuration {"spendLimit": {"usd": …}}',
    code: "spend_limit", stopped: "spend_limit", limit: "agent",
  });
  assert.equal(remainingAgentSpend(spend, 0.1), 0);
  assert.equal(remainingAgentSpend(null), Infinity);
  assert.equal(pendingAgentSpend(spend, 123, 0.1), 0.1);
  assert.equal(pendingAgentSpend(spend, 122, 0.1), 0);
  assert.deepEqual(agentSpendView(spend), { usd: 0.2, spent: 0.15 });
  assert.throws(() => agentSpendRefusal("client_test", { ...spend, spent: NaN }), /unavailable/);
  assert.throws(() => remainingAgentSpend(spend, NaN), /Invalid pending/);
});

test("agent spend persists cumulative usage, rolls back with settlement, and isolates reset epochs and tenants", { timeout: 120_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const response = await fetch(`${fixture.url}/v1/agents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test/echo", fileTools: false, codeMode: false }),
  });
  assert.equal(response.status, 201);
  const { id } = await response.json() as { id: string };
  const env = { HYPERDRIVE: { connectionString: fixture.databaseUrl } }, tenant = "camelrun-proto-local";
  assert.equal(await readAgentSpendLimit(env, tenant, id), null);
  const first = await setAgentSpendLimit(env, tenant, id, { usd: 2 }, 100);
  assert.deepEqual(first, { usd: 2, spent: 0, setAt: 100 });
  await transaction(env, sql => writeAgentSpend(sql, id, first!.setAt, 0.15));
  await transaction(env, sql => writeAgentSpend(sql, id, first!.setAt, 0.15));
  assert.deepEqual(await readAgentSpendLimit(env, tenant, id), { usd: 2, spent: 0.3, setAt: 100 });
  await assert.rejects(transaction(env, async sql => {
    await writeAgentSpend(sql, id, first!.setAt, 0.2);
    throw new Error("lost before settlement commit");
  }), /lost before/);
  assert.equal((await readAgentSpendLimit(env, tenant, id))?.spent, 0.3);
  await Promise.all(Array.from({ length: 8 }, () => transaction(env, sql => writeAgentSpend(sql, id, first!.setAt, 0.1))));
  assert.ok(Math.abs((await readAgentSpendLimit(env, tenant, id))!.spent - 1.1) < 1e-10);
  await assert.rejects(readAgentSpendLimit(env, "other-tenant", id), error => (error as { status?: number }).status === 404);
  await assert.rejects(setAgentSpendLimit(env, "other-tenant", id, { usd: 10 }), error => (error as { status?: number }).status === 404);
  const reset = await setAgentSpendLimit(env, tenant, id, { usd: 2 }, 200);
  assert.deepEqual(reset, { usd: 2, spent: 0, setAt: 200 }, "even assigning the same cap resets the counter");
  await transaction(env, sql => writeAgentSpend(sql, id, first!.setAt, 1));
  assert.equal((await readAgentSpendLimit(env, tenant, id))?.spent, 0, "late receipts cannot charge a new limit");
  await transaction(env, sql => writeAgentSpend(sql, id, reset!.setAt, 0.2));
  assert.equal((await readAgentSpendLimit(env, tenant, id))?.spent, 0.2);
  assert.equal(await setAgentSpendLimit(env, tenant, id, null), null);
  await transaction(env, sql => writeAgentSpend(sql, id, reset!.setAt, 1));
  assert.equal(await readAgentSpendLimit(env, tenant, id), null);
});
