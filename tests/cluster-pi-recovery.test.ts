import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { cluster, fakeModel, jsExec, lookup, token, toolMessages, until } from "./cluster-helpers.ts";

// AGENT_PI_RECOVERY_TENANTS: Pi resumes the run a lost node left from its own checkpoint, instead of the host aborting it
// and repairing the turn itself.
const recovery = { AGENT_PI_RECOVERY_TENANTS: "alice" };

test("Pi recovery: a turn whose node died mid-request is resumed by Pi, which asks the model again", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec('return await tools.lookup({ key: "k" })') : index === 1 ? undefined : { role: "assistant", content: "all done" });
  const a = await c.start("a", { ...model.env, ...recovery });
  const b = await c.start("b", { ...model.env, ...recovery });
  const calls: string[] = [];
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup(calls), idempotencyKey: "pi-resumed-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: lookup(calls) });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "turn-1", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 2, "A made the second model call");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.error, null);
  assert.equal(result.reply, "all done");
  assert.equal(model.bodies.length, 3, "the request in flight was made again, once");
  const resumed = model.bodies[2];
  assert.equal(resumed.messages.filter((message: any) => message.role === "user").length, 1, "the prompt was not submitted again");
  assert.ok(toolMessages(resumed).some((content: string) => content.includes("value-of-k")), "the finished step's tool result carried over");
  assert.deepEqual(calls, ["k"]);
  const history = await (await fetch(`${b.url}/v1/agents/${created.session.id}/history`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
  assert.equal(history.messages.filter((message: any) => message.role === "assistant" && message.stopReason === "aborted").length, 0, "the cut-off response is not history");
});

test("Pi recovery: a turn whose node died during a tool call goes on with the call interrupted, never made again", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec("return await tools.slow({})") : { role: "assistant", content: "noted" });
  const lease = { AGENT_LEASE_TTL_MS: "6000" };
  const a = await c.start("a", { ...model.env, ...lease, ...recovery });
  const b = await c.start("b", { ...model.env, ...lease, ...recovery });
  let executions = 0;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const tools = { slow: tool({ description: "A side effect", input: schema.Object({}, { additionalProperties: false }), execute: async () => { executions++; entered.resolve(); await gate.promise; return "effect-done"; } }) };
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools, idempotencyKey: "pi-tool-in-flight" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const run = client.prompt("do it", { idempotencyKey: "turn-2", timeoutMs: 60_000 });
  await entered.promise;
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.reply, "noted");
  assert.equal(executions, 1, "the call was never sent again");
  assert.equal(model.bodies.length, 2);
  assert.ok(toolMessages(model.bodies[1]).some((content: string) => /was interrupted and may have partially run/.test(content)), "the model was told the call was interrupted");
});
