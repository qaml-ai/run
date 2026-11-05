import assert from "node:assert/strict";
import { portedTest } from "../ported.ts";
import { OPERATOR as token, runtime, sleep, toolCall, until } from "../support.ts";

portedTest("history", "tests/pi-durable-context-guard.test.ts:79")("a newly seeded oversized range fails startup with a coded outcome", async t => {
  const r = await runtime(t, () => { throw new Error("model must not be called"); }, { AGENT_CONTEXT_RANGE_MAX_BYTES: "1" });
  const agent = (await r.call("/v1/agents", { body: {} })).json;
  for (const text of ["first", "again"]) {
    const run = await r.prompt(agent.id, text);
    assert.equal(run.outcome.result.code, "context_too_large", JSON.stringify(run));
    assert.match(run.outcome.result.error, /past the 1 bytes a run can load/);
  }
  assert.equal(r.model.bodies.length, 0);
});

portedTest("history", "tests/pi-durable-context-guard.test.ts:90")("a live range stops with context_too_large and does not retry the model", { timeout: 60_000 }, async t => {
  const r = await runtime(t, (_body, index) => toolCall("codemode", { code: 'return "x".repeat(8192)' }, `call_${index}`), {
    AGENT_CONTEXT_RANGE_MAX_BYTES: "65536", AGENT_IDLE_MS: "1000",
  });
  const agent = (await r.call("/v1/agents", { body: {} })).json;
  const run = await r.prompt(agent.id, "go");
  assert.equal(run.outcome.result.code, "context_too_large", JSON.stringify(run));
  assert.equal(run.outcome.result.stopped, "turn_limit");
  // Every request checks: the first past 64 KiB (~8 KiB of tool result a step) is stopped before it reaches the provider,
  // and the model is not asked again.
  const asked = r.model.bodies.length;
  assert.ok(asked >= 4, `${asked} requests`);
  await sleep(500);
  assert.equal(r.model.bodies.length, asked, "the request past the bound is stopped before contacting the provider");
  await r.waitForAgentIdle(agent.id);
});


portedTest("history", "tests/pi-durable-context-guard.test.ts:107")("an oversized resumed range fails once, clears pending work, and remains readable and abortable", { timeout: 90_000 }, async t => {
  const pending = Promise.withResolvers<void>();
  const r = await runtime(t, () => ({ wait: pending.promise }), { AGENT_HOSTING: "inline", AGENT_STORAGE: "shared-file", AGENT_LEASE_TTL_MS: "1500" });
  const model = r.model;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const created = await fetch(`${r.base}/v1/agents`, { method: "POST", headers, body: "{}" });
  const agent = await created.json() as { id: string; token: string };
  assert.equal(created.status, 201);
  const accepted = await fetch(`${r.base}/v1/agents/${agent.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) });
  const run = await accepted.json() as { id: string };
  assert.equal(accepted.status, 202);
  await until(() => model.bodies.length === 1, "the original model request");
  await r.restart({ crash: true, env: { AGENT_CONTEXT_RANGE_MAX_BYTES: "1", AGENT_IDLE_MS: "1000" } });
  const getRun = async () => await (await fetch(`${r.base}/v1/agents/${agent.id}/requests/${run.id}`, { headers })).json() as any;
  const ended = await until(async () => { const value = await getRun(); return value.state === "completed" && value; }, "the oversized resumed run to fail");
  assert.equal(ended.outcome?.result?.code, "context_too_large", JSON.stringify(ended));
  await r.waitForAgentIdle(agent.id);
  const recovery = await r.agentRecovery(agent.id);
  const state = { resume_failures: recovery.failures, resume_after: recovery.retryAt || null };
  assert.deepEqual(state, { resume_failures: 0, resume_after: null });
  assert.equal(model.bodies.length, 1, "no model call on the replacement node");
  const history = await fetch(`${r.base}/v1/agents/${agent.id}/history`, { headers });
  assert.equal(history.status, 200, await history.text());
  const abort = await fetch(`${r.base}/clients/${agent.id}/requests`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${agent.token}` }, body: JSON.stringify({ id: "abort-large", method: "abort", params: {} }) });
  assert.equal(abort.status, 202, await abort.text());
  const next = await fetch(`${r.base}/v1/agents/${agent.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "again" }) });
  const nextId = (await next.json() as any).id;
  assert.equal(next.status, 202);
  const failed = await until(async () => { const value = await (await fetch(`${r.base}/v1/agents/${agent.id}/requests/${nextId}`, { headers })).json() as any; return value.state === "completed" && value; }, "a new oversized run to fail");
  assert.equal(failed.outcome.result.code, "context_too_large");
});
