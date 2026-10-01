import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime } from "./runtime-server.ts";
import { AgentRuntime } from "../clients/typescript.ts";

test("a request read with ?wait answers as soon as it settles, or when the wait ends, still running", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `reply ${index}`, delayMs: index === 0 ? 1_500 : 6_000 }));
  const created = (await r.call("/v1/agents", { body: {} })).json;
  const accepted = await r.call(`/v1/agents/${created.id}/prompt`, { body: { text: "hi" } });
  assert.equal(accepted.status, 202, accepted.text);
  const started = Date.now();
  const settled = await r.call(`/v1/agents/${created.id}/requests/${accepted.json.id}?wait=25`);
  assert.equal(settled.status, 200, settled.text);
  assert.equal(settled.json.state, "completed");
  assert.equal(settled.json.outcome.result.reply, "reply 0");
  assert.ok(Date.now() - started < 10_000, "it answered as the run ended, not at the end of the wait");

  // A settled request answers at once; one still running answers when the wait ends, still running.
  const again = Date.now();
  assert.equal((await r.call(`/v1/agents/${created.id}/requests/${accepted.json.id}?wait=25`)).json.state, "completed");
  assert.ok(Date.now() - again < 1_000);
  const slow = await r.call(`/v1/agents/${created.id}/prompt`, { body: { text: "again" } });
  const waited = Date.now();
  const running = await r.call(`/v1/agents/${created.id}/requests/${slow.json.id}?wait=1`);
  assert.equal(running.json.state, "running");
  assert.ok(Date.now() - waited >= 900 && Date.now() - waited < 4_000, `waited ${Date.now() - waited} ms`);
  // The agent's own token reads it the same way.
  const own = await r.call(`/clients/${created.id}/requests/${slow.json.id}?wait=25`, { token: created.token });
  assert.equal(own.json.state, "completed");
  assert.equal(own.json.outcome.result.reply, "reply 1");

  assert.equal((await r.call(`/v1/agents/${created.id}/requests/${slow.json.id}?wait=soon`)).status, 400);
  assert.equal((await r.call(`/v1/agents/${created.id}/requests/nope?wait=1`)).status, 404);
});

test("the SDK's requestStatus takes wait: one call that waits for a request sent without waiting", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "late", delayMs: 1_000 }));
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).createAgent({});
  t.after(() => client.close());
  const accepted = await r.call(`/v1/agents/${client.id}/prompt`, { body: { text: "hi" } });
  assert.equal((await client.requestStatus(accepted.json.id)).state, "running");
  const waited = await client.requestStatus(accepted.json.id, { wait: 25 });
  assert.equal(waited.state, "completed");
  assert.equal(waited.outcome.result.reply, "late");
});
