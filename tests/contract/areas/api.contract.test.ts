import { contractTest, OPERATOR, OTHER_OPERATOR, free, lastUser, toolCall, toolResults, until, sleep, listen, watchEvents, type T } from '../support.ts';
import type { ContractFixture, ModelReply } from '../fixture.ts';

async function useFixture(f: ContractFixture, respond?: ModelReply, _env?: Record<string,string>, _tenants?: object) { if(respond) f.setModel(respond); return f; }

import assert from "node:assert/strict";

import { createHash, randomBytes } from "node:crypto";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const alice = "alice-operator-token-at-least-24-chars";

const bob = "bob-operator-token-at-least-24-chars";

const defaultTenants = {
  alice: { tokenSha256: sha(alice), apiKeys: {} },
  bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, github: "Bob-Builder" },
};

contractTest("models", "tests/api.test.ts:172", "agents can live until deleted, or for a chosen time", async (t, f) => {
  const { call } = await useFixture(f);
  await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "sk-ant-alice" } });
  const lasting = await call("/v1/agents", { token: alice, body: { name: "Always on", model: "anthropic/claude-sonnet-5", ttlSeconds: null } });
  assert.equal(lasting.status, 201);
  assert.equal(lasting.json.expiresAt, null);
  const hour = await call("/v1/agents", { token: alice, body: { name: "An hour", model: "anthropic/claude-sonnet-5", ttlSeconds: 3600 } });
  assert.ok(Math.abs(hour.json.expiresAt - (Date.now() + 3_600_000)) < 60_000);
  for (const ttlSeconds of [0, 59, 1.5, "3600", 400 * 86_400]) {
    assert.equal((await call("/v1/agents", { token: alice, body: { model: "anthropic/claude-sonnet-5", ttlSeconds } })).status, 400, String(ttlSeconds));
  }
  const listed = (await call("/v1/agents", { token: alice })).json as any[];
  assert.equal(listed.find(agent => agent.id === lasting.json.id).expiresAt, null);
  assert.equal((await call(`/clients/${lasting.json.id}/state`, { token: lasting.json.token })).status, 200);

}, {env:{AGENT_VERIFY_KEYS:"false"},tenants:{tenants:defaultTenants}});

contractTest("models", "tests/api.test.ts:188", "models are chosen by name over REST, at creation and mid-conversation", async (t, f) => {
  const { call } = await useFixture(f);
  const all = (await call("/v1/models?provider=anthropic", { token: alice })).json as any[];
  assert.ok(all.some(model => model.id === "anthropic/claude-sonnet-5" && model.contextWindow > 0 && model.cost.input >= 0));
  const none = await call("/v1/models?available=true", { token: alice });
  assert.deepEqual(none.json, []);
  assert.match(none.headers.get("x-camelrun-hint")!, /PUT \/v1\/providers\/<provider>\/key.*AGENT_TENANT_API_KEYS/, "an empty list says why");
  // An agent on a model with no key is made all the same: its runs say which key to set.
  const noKey = await call("/v1/agents", { token: alice, body: { name: "Scratch", model: "anthropic/claude-sonnet-5" } });
  assert.equal(noKey.status, 201, JSON.stringify(noKey.json));
  assert.equal((await call(`/v1/agents/${noKey.json.id}`, { method: "DELETE", token: alice })).status, 200);
  await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "sk-ant-alice" } });
  const keyed = await call("/v1/models?available=true", { token: alice });
  assert.ok(keyed.json.every((model: any) => model.provider === "anthropic"));
  assert.equal(keyed.headers.get("x-camelrun-hint"), null);
  assert.equal((await call("/v1/agents", { token: alice, body: { model: "anthropic/not-a-model" } })).status, 400);
  assert.equal((await call("/v1/agents", { token: alice, body: { model: "claude-sonnet-5" } })).status, 400);

  const created = await call("/v1/agents", { token: alice, body: { name: "Planner", model: "anthropic/claude-sonnet-5" }, headers: { "Idempotency-Key": "planner" } });
  assert.equal(created.status, 201);
  const agents = (await call("/v1/agents", { token: alice })).json as any[];
  assert.deepEqual(agents.map(agent => [agent.name, agent.model]), [["Planner", "anthropic/claude-sonnet-5"]]);
  const id = created.json.id;

  // Switch models with the agent's scoped token; a provider without a key is refused.
  const configure = (model: string, requestId: string) => call(`/clients/${id}/requests`, { token: created.json.token, body: { id: requestId, method: "configure", params: { model } } });
  assert.equal((await configure("anthropic/claude-haiku-4-5", "to-haiku")).status, 202);
  // Up to 30 s: a busy runner can take seconds, and a request still running then is returned as it is.
  const settle = async (requestId: string) => {
    for (const deadline = Date.now() + 30_000; ; await new Promise(resolve => setTimeout(resolve, 20))) {
      const record = (await call(`/clients/${id}/requests/${requestId}`, { token: created.json.token })).json;
      if (record.state !== "running" || Date.now() > deadline) return record;
    }
  };
  assert.equal((await settle("to-haiku")).outcome.error, undefined);
  assert.equal((await call("/v1/agents", { token: alice })).json[0].model, "anthropic/claude-haiku-4-5");
  await configure("openai/gpt-4o", "to-openai");
  assert.match((await settle("to-openai")).outcome.error, /No openai API key/);

  // Agents belong to their tenant.
  assert.deepEqual((await call("/v1/agents", { token: bob })).json, []);
  assert.equal((await call(`/v1/agents/${id}`, { token: bob })).status, 404);
  assert.equal((await call(`/v1/agents/${id}/history`, { token: bob })).status, 404);
  assert.equal((await call(`/v1/agents/${id}`, { method: "DELETE", token: bob })).status, 404);
  assert.deepEqual((await call(`/v1/agents/${id}/history`, { token: alice })).json, { messages: [] });
  assert.equal((await call(`/v1/agents/${id}`, { token: alice })).json.name, "Planner");
  assert.equal((await call(`/v1/agents/${id}`, { method: "DELETE", token: alice })).status, 200);
  assert.deepEqual((await call("/v1/agents", { token: alice })).json, []);

}, {env:{AGENT_VERIFY_KEYS:"false"},tenants:{tenants:defaultTenants}});
