import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, toolCall, until } from "./runtime-server.ts";

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

test("the runtime's maximums cap what agents and definitions ask for; a definition's run limits reach its agents", async t => {
  const r = await runtime(t, looping, { AGENT_MAX_RUN_RESPONSES: "4" });
  const own = (await r.call("/v1/agents", { body: { runLimits: { maxResponses: 50 } } })).json;
  assert.equal((await r.prompt(own.id, "go")).outcome.result.error, "This run stopped at its limit of 4 model responses. Send another message to continue");
  assert.equal(r.model.bodies.length, 4, "50 asked, 4 allowed");
  const unset = (await r.call("/v1/agents", { body: {} })).json;
  assert.equal((await r.prompt(unset.id, "go")).outcome.result.stopped, "turn_limit");
  assert.equal(r.model.bodies.length, 8, "the runtime's maximum is the default");

  assert.equal((await r.call("/v1/definitions", { body: { name: "bad", runLimits: { maxResponses: "2" } } })).status, 400);
  const definition = await r.call("/v1/definitions", { body: { name: "short", runLimits: { maxResponses: 2 } } });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.runLimits, { maxResponses: 2 });
  const made = (await r.call("/v1/agents", { body: { definition: definition.json.id } })).json;
  assert.deepEqual((await r.call(`/v1/agents/${made.id}`)).json.runLimits, { maxResponses: 2 });
  assert.equal((await r.prompt(made.id, "go")).outcome.result.stopped, "turn_limit");
  assert.equal(r.model.bodies.length, 10, "the definition's limit");
  // An agent's own run limits stay when its definition is applied.
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
