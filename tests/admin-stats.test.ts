import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { passwordSession, runtime, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OPS = "ops-operator-token-at-least-24-chars";
const OTHER = "other-ops-token-at-least-24-chars";
const tenantsFile = {
  tenants: { ops: { tokenSha256: sha(OPS), apiKeys: {} }, other: { tokenSha256: sha(OTHER), apiKeys: {} } },
  platformKeys: { openrouter: "fixture-platform-key" },
};

test("the platform operator sees sign-ups, how far they got and usage; no one else does", { timeout: 120_000 }, async t => {
  const { call, prompt, base } = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    { AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0" }, tenantsFile);

  const empty = await call("/v1/admin/stats", { token: OPS });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.signups.total, 0);
  assert.equal(empty.json.daily.length, 30, "a row for each day, empty ones too");

  // One sign-up that made a token and an agent and ran it; another that did nothing.
  const lab = (await call("/v1/tenants", { body: { id: "lab-one" }, token: OPS })).json.token.token;
  assert.equal((await call("/v1/tenants", { body: { id: "lab-two" }, token: OPS })).status, 201);
  assert.equal((await call("/v1/billing/adjustments", { body: { tenant: "lab-one", amount: 5_000_000, reason: "test", idempotencyKey: "admin:lab-one" }, token: OPS })).status, 201);
  const agent = (await call("/v1/agents", { body: {}, token: lab })).json;
  await prompt(agent.id, "hello", lab);

  // Usage reaches the database in batched flushes.
  const stats = await until(async () => {
    const read = (await call("/v1/admin/stats?days=7", { token: OPS })).json;
    return read.activation.withUsage === 1 && read;
  }, "the turn's usage to be flushed", 60_000);
  assert.equal(stats.days, 7);
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.signups.total, 2);
  assert.equal(stats.signups.last24h, 2);
  assert.equal(stats.signups.operator, 2);
  assert.equal(stats.daily.at(-1).signups, 2);
  assert.ok(stats.daily.at(-1).responses >= 1);
  assert.deepEqual(stats.activation, { tenants: 2, withToken: 2, withAgent: 1, withUsage: 1, purchased: 0 });
  assert.equal(stats.agents.live, 1);
  const one = stats.recent.find((row: any) => row.tenant === "lab-one");
  assert.equal(one.agents, 1);
  assert.ok(one.responses >= 1);
  assert.equal(one.signIn, "operator");
  assert.ok(one.balance <= 5_000_000);
  assert.equal((await call("/v1/admin/stats?days=0", { token: OPS })).status, 400);

  // Only a billing admin, by operator token or signed in to the console: not another admin tenant, nor a tenant's own token.
  assert.equal((await call("/v1/admin/stats", { token: OTHER })).status, 403);
  assert.equal((await call("/v1/admin/stats", { token: lab })).status, 403);
  assert.equal((await call("/v1/me", { token: OPS })).json.admin, true);
  assert.equal((await call("/v1/me", { token: lab })).json.admin, undefined);
  const asOps = { Cookie: await passwordSession(base, OPS, "ops") };
  assert.equal((await call("/v1/me", { token: null, headers: asOps })).json.admin, true);
  assert.equal((await call("/v1/admin/stats", { token: null, headers: asOps })).json.signups.total, 2);
  const asLab = { Cookie: await passwordSession(base, OPS, "lab-one") };
  assert.equal((await call("/v1/admin/stats", { token: null, headers: asLab })).status, 403);
});
