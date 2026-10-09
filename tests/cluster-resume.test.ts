import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { cluster, fakeModel, jsExec, lookup, token, toolMessages, until } from "./cluster-helpers.ts";

test("a turn whose node died between model steps resumes on the next owner, calling the model once more", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec('return await tools.lookup({ key: "k" })') : index === 1 ? undefined : { role: "assistant", content: "all done" });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const calls: string[] = [];
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup(calls), idempotencyKey: "resumed-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: lookup(calls) });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "turn-1", timeoutMs: 60_000 });

  await until(() => model.bodies.length === 2, "A made the second model call");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.reply, "all done");
  assert.equal(result.error, null);
  await client.close();

  const observer = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: lookup([]) });
  t.after(() => observer.close());
  assert.equal((await observer.waitForRequest("turn-1", { timeoutMs: 10_000 })).reply, "all done");
  assert.equal(model.bodies.length, 3, "one more model call, not a new turn");
  const resumed = model.bodies[2];
  assert.equal(resumed.messages.filter((message: any) => message.role === "user").length, 1, "the prompt was not submitted again");
  assert.ok(toolMessages(resumed).some((content: string) => content.includes("value-of-k")), "the finished step's tool result carried over");
  assert.deepEqual(calls, ["k"]);
  assert.equal(await c.owner(created.session.id), b.url);
  const state = await (await fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  assert.equal(state.requests.find((request: any) => request.id === "turn-1").resumes, 1);
});

test("a structured run whose node died between model steps resumes with final_output still declared, and ends with its output", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const answer = { role: "assistant", tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "final_output", arguments: JSON.stringify({ value: "value-of-k" }) } }] };
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec('return await tools.lookup({ key: "k" })') : index === 1 ? undefined : answer);
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const calls: string[] = [];
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup(calls), idempotencyKey: "structured-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: lookup(calls) });
  t.after(() => client.close());
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
  // A new agent's first turn: final_output is declared by its transcript alone, which the next owner reads.
  const run = client.prompt("go", { idempotencyKey: "structured-turn", timeoutMs: 60_000, output: { schema } });
  await until(() => model.bodies.length === 2, "A made the second model call");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.error, null);
  assert.deepEqual(result.output, { value: "value-of-k" });
  assert.equal(model.bodies.length, 3);
  assert.deepEqual(model.bodies[2].tools.find((tool: any) => tool.function.name === "final_output")?.function.parameters, schema);
});

test("a turn whose node died during a tool call continues with the outcome unknown, without calling the tool again", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec("return await tools.slow({})") : { role: "assistant", content: "noted the unknown outcome" });
  // A lease that outlasts a database or CPU stall on a loaded runner: under the cluster's 1.5 s, a stall fenced both nodes
  // on CI and moved the agent mid-run beyond the one death this is about, spending its resumes. B still takes over soon
  // after A dies: it ends a dead peer's late heartbeat (Ownership.reap).
  const lease = { AGENT_LEASE_TTL_MS: "6000" };
  const a = await c.start("a", { ...model.env, ...lease });
  const b = await c.start("b", { ...model.env, ...lease });
  let executions = 0;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const tools = { slow: tool({ description: "A side effect", input: schema.Object({}, { additionalProperties: false }), execute: async () => { executions++; entered.resolve(); await gate.promise; return "effect-done"; } }) };
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools, idempotencyKey: "tool-in-flight" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const run = client.prompt("do it", { idempotencyKey: "turn-2", timeoutMs: 60_000 });

  await entered.promise;
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.reply, "noted the unknown outcome");
  assert.equal(executions, 1, "the call was never sent again");
  assert.equal(model.bodies.length, 2);
  assert.ok(toolMessages(model.bodies[1]).some((content: string) => /outcome is unknown/.test(content)), "the model was told the outcome is unknown");
});

test("a turn that keeps killing its node is resumed at most twice, then fails as uncertain", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, () => undefined);
  let node = await c.start("a", model.env);
  // Each restart comes back at the same address, as a replaced task on its host would.
  const port = Number(new URL(node.url).port);
  const created = await new AgentRuntime({ url: node.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "doomed-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: node.url, apiKey: token }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("hang", { idempotencyKey: "turn-3", timeoutMs: 100_000 });
  run.catch(() => {});
  for (let restart = 1; restart <= 3; restart++) {
    await until(() => model.bodies.length === restart, `model call ${restart}`);
    node.child.kill("SIGKILL");
    await once(node.child, "close");
    // The same address takes the old heartbeat over, so the restarted node owns the agent at once.
    node = await c.start(`a${restart}`, model.env, port);
  }
  await assert.rejects(run, /runtime restarted during this request/);
  assert.equal(model.bodies.length, 3, "the first attempt and two resumes");
  const state = await (await fetch(`${node.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  const request = state.requests.find((entry: any) => entry.id === "turn-3");
  assert.equal(request.resumes, 2);
  assert.equal(request.outcome.uncertain, true);
});
