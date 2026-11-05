import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractTest, OPERATOR, OTHER_OPERATOR, attachSilently, toolCall } from "../support.ts";

const alice = OPERATOR, bob = OTHER_OPERATOR;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const apiTenants = { tenants: {
  alice: { tokenSha256: sha(alice), apiKeys: {} },
  bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, github: "Bob-Builder" },
} };
const anonymous = (r: any) => (path: string, init: any = {}) => r.call(path, { token: null, ...init });

contractTest("quotas", "tests/api.test.ts:584","a tenant at its agent quota gets 429 with Retry-After and nothing half-created; the same key succeeds once a slot frees", async (t, r) => {
  const base = r.base, call = anonymous(r);
  const hold = { name: "hold", description: "Never answered", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const busy = await call("/v1/agents", { token: bob, body: { mcp: { tools: [hold] } }, headers: { "Idempotency-Key": "busy" } });
  assert.equal(busy.status, 201);
  // A call sent to an application that never answers keeps the agent busy until the tool timeout, so it cannot be evicted.
  const app = await attachSilently(t, base, busy.json.id, busy.json.token);
  const run = await call(`/clients/${busy.json.id}/requests`, { token: busy.json.token, body: { id: "hold-1", method: "execute", params: { code: "return await tools.hold({})" } } });
  assert.equal(run.status, 202);
  for (const deadline = Date.now() + 30_000; !app.calls.length; await new Promise(resolve => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < deadline, "the call was sent");
  }
  const agents = async () => (await call("/v1/agents", { token: bob })).json.length;
  for (const key of ["second", "third"]) {
    const refused = await call("/v1/agents", { token: bob, body: {}, headers: { "Idempotency-Key": key } });
    assert.equal(refused.status, 429, key);
    assert.equal(refused.headers.get("retry-after"), "5");
    assert.match(JSON.stringify(refused.json), /already has 1 agents running/);
  }
  assert.equal(await agents(), 1, "a refused create persists nothing");
  // Other statuses keep theirs too: a reused key for someone else conflicts, not "bad request".
  assert.equal((await call("/v1/agents", { token: bob, body: { mcp: { tools: [hold] }, subject: "someone-else" }, headers: { "Idempotency-Key": "busy" } })).status, 409);
  // The tool times out, the busy agent goes idle, and the refused create's retry takes its slot.
  let retried;
  for (const deadline = Date.now() + 30_000; (retried = await call("/v1/agents", { token: bob, body: {}, headers: { "Idempotency-Key": "second" } })).status === 429; await new Promise(resolve => setTimeout(resolve, 100))) {
    assert.ok(Date.now() < deadline, "the slot frees");
  }
  assert.equal(retried.status, 201);
  assert.equal(await agents(), 2);
}, { tenants: apiTenants, env: { AGENT_MAX_AGENTS: "4", AGENT_MAX_AGENTS_PER_TENANT: "1", AGENT_TOOL_TIMEOUT_MS: "3000" } });

contractTest("quotas", "tests/api.test.ts:615","a tenant's own maxAgents replaces the default limit, and a change applies at the next tenants reload without a restart", async (t, r) => {
  const base = r.base, call = anonymous(r);
  const hold = { name: "hold", description: "Never answered", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const create = (token: string, key: string) => call("/v1/agents", { token, body: { mcp: { tools: [hold] } }, headers: { "Idempotency-Key": key } });
  const statuses = (results: { status: number }[]) => results.map(result => result.status).sort();

  // Three concurrent starts for bob (his own limit, 2), two for alice (the default, 1).
  const [bobs, alices] = await Promise.all([Promise.all(["b1", "b2", "b3"].map(key => create(bob, key))), Promise.all(["a1", "a2"].map(key => create(alice, key)))]);
  assert.deepEqual(statuses(bobs), [201, 201, 429]);
  assert.deepEqual(statuses(alices), [201, 429]);
  const refused = ["b1", "b2", "b3"][bobs.findIndex(result => result.status === 429)];

  // Bob's two agents are busy, each with a call delivered to an application that never answers, so nothing can be evicted for the refused one.
  for (const agent of bobs.filter(result => result.status === 201).map(result => result.json)) {
    const app = await attachSilently(t, base, agent.id, agent.token);
    assert.equal((await call(`/clients/${agent.id}/requests`, { token: agent.token, body: { id: "hold", method: "execute", params: { code: "return await tools.hold({})" } } })).status, 202);
    for (const deadline = Date.now() + 30_000; !app.calls.length; await new Promise(resolve => setTimeout(resolve, 50))) {
      assert.ok(Date.now() < deadline, "the call was sent");
    }
  }
  assert.equal((await create(bob, refused)).status, 429);

  // Raise bob's limit in the tenants file and reload, as the secret's refresh does: no restart.
  await r.seedTenant("bob", { token: bob, config: { apiKeys: { anthropic: "bob-admin-anthropic-key" }, maxAgents: 3 } });
  assert.equal((await create(bob, refused)).status, 201);
  // Her one agent is idle once it has settled after creation, which a loaded runner can take a moment to see.
  let status = 0;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && (status = (await create(alice, "a3")).status) === 429;) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(status, 201, "alice's idle agent makes room under the default");
}, { tenants: { tenants: {
  alice: { tokenSha256: sha(alice), apiKeys: { anthropic: "alice-admin-anthropic-key" } },
  bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, maxAgents: 2 },
} }, env: { AGENT_MAX_AGENTS: "10", AGENT_MAX_AGENTS_PER_TENANT: "1", AGENT_TOOL_TIMEOUT_MS: "20000", AGENT_DRAIN_TIMEOUT_MS: "0" } });

contractTest("quotas", "tests/api.test.ts:656","a tenant's monthly spend cap ends a turn after the response that crosses it, refuses new runs, and a reload raising it lets the turn continue", async (t, r) => {
  // Each response costs $0.15: 5000 input tokens of openai/gpt-5.5-pro, far below its context window.
  const bodies = r.model.bodies, call = anonymous(r);
  r.setModel((_body, index) => ({
    ...(index < 2 ? toolCall("codemode", { code: `return ${index}` }, `call_${index}`) : { role: "assistant", content: "finished" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 },
  }));
  const agent = (await call("/v1/agents", { token: alice, body: {} })).json;
  const settled = async (requestId: string) => {
    for (const deadline = Date.now() + 30_000; ; await new Promise(resolve => setTimeout(resolve, 50))) {
      const record = (await call(`/v1/agents/${agent.id}/requests/${requestId}`, { token: alice })).json;
      if (record.state === "completed") return record.outcome;
      assert.ok(Date.now() < deadline, "the run settles");
    }
  };
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { token: alice, body: { text: "go", requestId: "first" } })).status, 202);
  const first = await settled("first");
  assert.equal(first.result.stopped, "spend_limit");
  assert.equal(first.result.limit, "tenant");
  assert.match(first.result.error, /monthly spend limit of \$0\.25/);
  assert.equal(bodies.length, 2, "the turn ended after the response that crossed the cap");
  const history = (await call(`/v1/agents/${agent.id}/history`, { token: alice })).json.messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant", "toolResult", "assistant", "toolResult"], "every tool call has its result");

  const refused = await call(`/v1/agents/${agent.id}/prompt`, { token: alice, body: { text: "again", requestId: "refused" } });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error, /spend limit/);
  assert.equal(bodies.length, 2);

  await r.seedTenant("alice", { token: alice, config: { apiKeys: { openrouter: "fixture-key" }, maxMonthlyCost: 10 } });
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { token: alice, body: { text: "carry on", requestId: "after" } })).status, 202);
  const after = await settled("after");
  assert.equal(after.result.error, null);
  assert.equal(after.result.reply, "finished");
  assert.deepEqual(bodies[2].messages.map((message: any) => message.role).filter((role: string) => !["system", "developer"].includes(role)), ["user", "assistant", "tool", "assistant", "tool", "user"]);
  const usage = (await call("/v1/usage", { token: alice })).json;
  assert.equal(usage.totals.responses, 3);
}, { tenants: { tenants: { alice: { tokenSha256: sha(alice), apiKeys: { openrouter: "fixture-key" }, maxMonthlyCost: 0.25 } } }, env: { AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-5.5-pro" } });
