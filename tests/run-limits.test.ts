import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CAPPED = "capped-operator-token-at-least-24-chars";

// The model never stops calling tools: only a limit ends its turn.
const looping = (_body: unknown, index: number) => ({ ...toolCall("js_exec", { code: `return ${index}` }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 1 } });

test("a run stops at its agent's limit of model responses with stopped turn_limit, and the next message continues", async t => {
  const r = await runtime(t, looping);
  for (const runLimits of [{ maxResponses: 0 }, { maxResponses: 1.5 }, { maxSeconds: -1 }, { other: 1 }]) {
    assert.equal((await r.call("/v1/agents", { body: { runLimits } })).status, 400, JSON.stringify(runLimits));
  }
  const { id, token } = (await r.call("/v1/agents", { body: { runLimits: { maxResponses: 3 } } })).json;
  assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.runLimits, { maxResponses: 3 });

  const first = await r.prompt(id, "go");
  assert.equal(first.stopped, "turn_limit");
  assert.equal(first.outcome.result.stopped, "turn_limit");
  assert.equal(first.outcome.result.code, "turn_limit");
  assert.equal(first.outcome.result.error, "This run stopped at its limit of 3 model responses. Send another message to continue");
  assert.equal(r.model.bodies.length, 3, "the turn ended after the third response's tool calls");
  // The history holds the last response's tool result, so the next message continues from there.
  const second = await r.prompt(id, "go on");
  assert.equal(second.outcome.result.stopped, "turn_limit");
  assert.equal(r.model.bodies.length, 6, "each run counts its own responses");

  // Only the tenant sets them; null returns to the runtime's.
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: "self", method: "configure", params: { runLimits: { maxResponses: 100 } } } })).status, 403);
  assert.equal((await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { runLimits: { maxResponses: 1 } } })).status, 202);
  assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.runLimits, { maxResponses: 1 });
  assert.equal((await r.prompt(id, "once")).outcome.result.stopped, "turn_limit");
  assert.equal(r.model.bodies.length, 7);
  assert.equal((await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { runLimits: null } })).status, 202);
  assert.equal((await r.call(`/v1/agents/${id}`)).json.runLimits, null);
});

test("self-serve tenants get the runtime's maximums (or the operator's per tenant); admin tenants none unless their entry sets one", { timeout: 120_000 }, async t => {
  const tenantsFile = {
    tenants: {
      // Like chiridion-prod: an unbilled admin tenant, with no run limits of its own.
      alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
      capped: { tokenSha256: sha(CAPPED), apiKeys: { openrouter: "fixture-model-key" }, maxRunResponses: 3 },
    },
    platformKeys: { openrouter: "fixture-platform-key" },
  };
  // Each agent's model calls tools until its turn has 12 tool results, then answers.
  const r = await runtime(t, (body: any, index) => body.messages.filter((message: any) => message.role === "tool").length >= 12
    ? { role: "assistant", content: "done", usage: { prompt_tokens: 10, completion_tokens: 1 } } : looping(body, index), { AGENT_MAX_RUN_RESPONSES: "4", AGENT_BILLING_ADMINS: "alice" }, tenantsFile);

  // The admin tenant's long run is not stopped: 13 responses, past the runtime's 4.
  const admin = (await r.call("/v1/agents", { body: {} })).json;
  const long = await r.prompt(admin.id, "go");
  assert.equal(long.outcome.result.stopped, undefined);
  assert.equal(long.outcome.result.reply, "done");
  assert.equal(r.model.bodies.length, 13);
  // Its agents may still set their own.
  const own = (await r.call("/v1/agents", { body: { runLimits: { maxResponses: 2 } } })).json;
  assert.equal((await r.prompt(own.id, "go")).outcome.result.stopped, "turn_limit");
  assert.equal(r.model.bodies.length, 15);
  // An admin tenant whose entry sets maxRunResponses: that, whatever its agents ask.
  const capped = (await r.call("/v1/agents", { body: { runLimits: { maxResponses: 50 } }, token: CAPPED })).json;
  assert.equal((await r.prompt(capped.id, "go", CAPPED)).outcome.result.error, "This run stopped at its limit of 3 model responses. Send another message to continue");
  assert.equal(r.model.bodies.length, 18);

  // A self-serve tenant: the runtime's maximum, or the operator's for it.
  const made = await r.call("/v1/tenants", { body: { id: "lab-runs" } });
  assert.equal(made.status, 201, made.text);
  const token = made.json.token.token;
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "lab-runs", amount: 5_000_000, reason: "test", idempotencyKey: "runs:1" } })).status, 201);
  const selfServe = (await r.call("/v1/agents", { body: {}, token })).json;
  assert.equal((await r.prompt(selfServe.id, "go", token)).outcome.result.error, "This run stopped at its limit of 4 model responses. Send another message to continue");
  assert.equal(r.model.bodies.length, 22);
  const set = await r.call("/v1/tenants/lab-runs/limits", { method: "PUT", body: { maxRunResponses: 6, maxRunSeconds: 600 } });
  assert.deepEqual(set.json.limits, { maxRunResponses: 6, maxRunSeconds: 600 });
  const raised = (await r.call("/v1/agents", { body: {}, token })).json;
  assert.equal((await r.prompt(raised.id, "go", token)).outcome.result.error, "This run stopped at its limit of 6 model responses. Send another message to continue");
  assert.equal(r.model.bodies.length, 28);
});

test("a definition's run limits reach its agents, and an agent's own stay when the definition is applied", async t => {
  const r = await runtime(t, looping);
  assert.equal((await r.call("/v1/definitions", { body: { name: "bad", runLimits: { maxResponses: "2" } } })).status, 400);
  const definition = await r.call("/v1/definitions", { body: { name: "short", runLimits: { maxResponses: 2 } } });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.runLimits, { maxResponses: 2 });
  const made = (await r.call("/v1/agents", { body: { definition: definition.json.id } })).json;
  assert.deepEqual((await r.call(`/v1/agents/${made.id}`)).json.runLimits, { maxResponses: 2 });
  assert.equal((await r.prompt(made.id, "go")).outcome.result.stopped, "turn_limit");
  assert.equal(r.model.bodies.length, 2, "the definition's limit");
  const mine = (await r.call("/v1/agents", { body: { definition: definition.json.id, runLimits: { maxResponses: 3 } } })).json;
  const updated = await r.call(`/v1/definitions/${definition.json.id}`, { method: "PATCH", body: { runLimits: { maxResponses: 1 }, apply: "all" } });
  assert.equal(updated.status, 200, updated.text);
  await until(async () => (await r.call(`/v1/agents/${made.id}`)).json.runLimits?.maxResponses === 1, "the definition to be applied");
  assert.deepEqual((await r.call(`/v1/agents/${mine.id}`)).json.runLimits, { maxResponses: 3 }, "its own");
});

test("a run stops at its time limit before its next model request", async t => {
  // Each step takes a little over half a second of tool time.
  const r = await runtime(t, (_body, index) => ({ ...toolCall("js_exec", { code: "const start = Date.now(); while (Date.now() - start < 600) {} return 1" }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  const { id } = (await r.call("/v1/agents", { body: { runLimits: { maxSeconds: 1 } } })).json;
  const run = await r.prompt(id, "go");
  assert.equal(run.outcome.result.stopped, "turn_limit");
  assert.equal(run.outcome.result.error, "This run stopped at its time limit of 1 second. Send another message to continue");
  assert.ok(r.model.bodies.length >= 2 && r.model.bodies.length <= 3, `stopped after about a second (${r.model.bodies.length} responses)`);
});
