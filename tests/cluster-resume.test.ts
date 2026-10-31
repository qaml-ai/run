import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { listen } from "./runtime-server.ts";
import { MAX_RESUMES } from "../src/client-sessions.ts";
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
  assert.ok(toolMessages(model.bodies[1]).some((content: string) => /was interrupted and may have partially run/.test(content)), "the model was told the outcome is unknown");
});

test("node-loss resumes preserve growing backoff; the loss after the limit fails and new work can run", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const events: any[] = [];
  const hookUrl = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    events.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  let finish = false;
  const model = await fakeModel(t, () => finish ? { role: "assistant", content: "new turn finished" } : undefined);
  const sweepMs = 500;
  const env = { ...model.env, AGENT_ORPHAN_SWEEP_MS: String(sweepMs), AGENT_LEASE_TTL_MS: "6000", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100", AGENT_SECRETS_KEY: randomBytes(32).toString("hex") };
  let node = await c.start("a", env);
  const registered = await fetch(`${node.url}/v1/webhooks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ url: hookUrl, events: ["run.failed"] }) });
  assert.equal(registered.status, 201);
  await registered.body?.cancel();
  const port = Number(new URL(node.url).port);
  const created = await new AgentRuntime({ url: node.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "doomed-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: node.url, apiKey: token }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("hang", { idempotencyKey: "poison", timeoutMs: 100_000 });
  run.catch(() => {});
  const row = async () => (await c.db.query("select turn_resumes, resume_failures, resume_after from agents where id = $1", [created.session.id])).rows[0];
  // The earliest the next reservation can be made: once its node is lost, and once the backoff before it has passed.
  let notBefore = 0;
  for (let loss = 1; loss <= MAX_RESUMES + 1; loss++) {
    await until(() => model.bodies.length === loss, `model call ${loss}`);
    const before = await row();
    assert.equal(before.turn_resumes, loss - 1);
    assert.equal(before.resume_failures, loss - 1);
    const deadline = Number(before.resume_after ?? 0);
    if (loss > 1) {
      const delay = sweepMs * 2 ** (loss - 2);
      assert.ok(deadline - notBefore >= delay, `backoff grows: ${deadline - notBefore} >= ${delay}`);
    }
    notBefore = Math.max(deadline, Date.now());
    node.child.kill("SIGKILL");
    await once(node.child, "close");
    node = await c.start(`a${loss}`, env, port);
    if (loss <= MAX_RESUMES) {
      await until(() => model.bodies.length === loss + 1, `resumed call ${loss}`);
      assert.ok(Date.now() >= deadline, "even a client-triggered load waits for resume_after");
    }
  }
  const result = await run;
  assert.equal(result.code, "resume_limit");
  assert.match(result.error!, new RegExp(`${MAX_RESUMES} node-loss resumes`));
  assert.equal(model.bodies.length, MAX_RESUMES + 1, "the first attempt and allowed resumes, with no call past the limit");
  await until(async () => (await row()).turn_resumes === 0, "terminal reset");
  assert.equal((await row()).resume_failures, 0);
  assert.equal((await row()).resume_after, null);
  assert.ok(node.logs.some(entry => entry.type === "turn_resume_limit" && entry.agent === created.session.id && entry.tenant === "alice" && entry.resumes === MAX_RESUMES));
  finish = true;
  const next = await client.prompt("fresh prompt", { idempotencyKey: "fresh" });
  assert.equal(next.reply, "new turn finished");
  await until(() => events.some(event => event.type === "run.failed" && event.data.code === "resume_limit" && event.data.requestId === "poison"), "delivered run.failed webhook with resume_limit");
});

test("a successful resumed turn resets the count and the next turn starts at zero", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index % 2 === 0 ? undefined : { role: "assistant", content: "done" });
  const env = { ...model.env, AGENT_ORPHAN_SWEEP_MS: "100", AGENT_LEASE_TTL_MS: "6000" };
  let node = await c.start("reset", env);
  const port = Number(new URL(node.url).port);
  const client = await new AgentRuntime({ url: node.url, apiKey: token }).createAgent({ tools: {} });
  t.after(() => client.close());
  for (let turn = 0; turn < 2; turn++) {
    const run = client.prompt("go", { idempotencyKey: `turn-${turn}`, timeoutMs: 60_000 });
    await until(() => model.bodies.length === turn * 2 + 1, "new turn's first call");
    const before = (await c.db.query("select turn_resumes, resume_failures from agents where id = $1", [client.session.id])).rows[0];
    assert.equal(before.turn_resumes, 0);
    assert.equal(before.resume_failures, 0);
    node.child.kill("SIGKILL");
    await once(node.child, "close");
    node = await c.start(`reset-${turn}`, env, port);
    assert.equal((await run).reply, "done");
    const record = await client.waitForRequest(`turn-${turn}`);
    assert.equal(record.reply, "done");
    await until(async () => (await c.db.query("select turn_resumes from agents where id = $1", [client.session.id])).rows[0].turn_resumes === 0, "successful end resets resumes");
  }
});
