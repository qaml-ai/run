import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { testDatabase } from "./database.ts";
import { balancer, cluster, fakeEcs, fakeModel, freePort, jsExec, lookup, sha, sleep, token, toolMessages, until } from "./cluster-helpers.ts";

test("on ECS a task is protected while turns run, and once superseded it retires: new work goes to peers, turns finish, idle agents move", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ecs = await fakeEcs(t);
  const a = await c.start("a", ecs.env);
  const b = await c.start("b");
  assert.equal(a.logs.find(entry => entry.type === "listening").node, a.url, "the node address came from the task metadata");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = { slow: tool({ description: "Wait", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "finished-on-a"; } }) };
  const viaA = new AgentRuntime({ url: a.url, apiKey: token });
  const busy = await viaA.createAgent({ tools, idempotencyKey: "long-turn" });
  t.after(() => busy.close());
  const running = busy.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;
  await until(() => ecs.state.protection.includes(true), "the task is protected while the turn runs");

  // A deployment replaces the task definition: A retires but stays healthy, so ECS does not replace it mid-turn.
  ecs.state.revision = 2;
  ecs.state.created = Date.now() / 1000;
  await until(() => a.logs.some(entry => entry.type === "retiring"), "A saw it was superseded");
  const health = await fetch(`${a.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, retiring: true });
  const fresh = await viaA.createAgent({ tools: {}, idempotencyKey: "created-while-retiring" });
  await fresh.close();
  assert.equal(await c.owner(fresh.session.id), b.url, "new agents start on a peer");
  await sleep(1_500);
  assert.equal(await c.owner(busy.session.id), a.url, "the running turn keeps its agent on A");
  assert.deepEqual(ecs.state.protection, [true], "no flapping while the turn runs");

  gate.resolve();
  assert.equal((await running).output[0], "finished-on-a");
  await until(() => a.logs.some(entry => entry.type === "retired"), "A gave everything up once idle");
  await until(() => ecs.state.protection.at(-1) === false, "protection cleared once nothing runs");
  // The agent's client reconnects and carries on, now served by B.
  assert.equal((await busy.execute('return "on b"', { timeoutMs: 30_000 })).output[0], "on b");
  assert.equal(await c.owner(busy.session.id), b.url);

  a.child.kill("SIGTERM");
  assert.equal((await once(a.child, "exit"))[0], 0);
  assert.deepEqual(a.logs.find(entry => entry.type === "drain_started")?.agents, 0, "the drain found nothing to do");
});

test("a turn still running when the drain times out is handed off and resumed by the next owner", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "resumed after the drain" });
  const a = await c.start("a", { ...model.env, AGENT_DRAIN_TIMEOUT_MS: "500" });
  const b = await c.start("b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "outlives-drain" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("think for a long time", { idempotencyKey: "turn-4", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "A called the model");

  a.child.kill("SIGTERM");
  assert.equal((await once(a.child, "exit"))[0], 0);
  assert.equal(a.logs.find(entry => entry.type === "drain_finished")?.unfinished, 1);
  const result = await run;
  assert.equal(result.reply, "resumed after the drain");
  assert.equal(model.bodies.length, 2);
  assert.equal(model.bodies[1].messages.filter((message: any) => message.role === "user").length, 1);
  assert.equal(await c.owner(created.session.id), b.url);
});

test("a prompt through a load balancer gets its result when its turn is handed off and finished on the next owner", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "finished on b" });
  const a = await c.start("a", { ...model.env, AGENT_DRAIN_TIMEOUT_MS: "500" });
  const b = await c.start("b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "handoff-new-owner" });
  await created.close();
  const lb = balancer([a, b]);
  const client = await new AgentRuntime({ url: a.url, fetch: lb.fetch }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "turn-new-owner", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "A called the model");

  a.child.kill("SIGTERM");
  assert.equal((await once(a.child, "exit"))[0], 0);
  assert.equal((await run).reply, "finished on b");
  assert.equal(await c.owner(created.session.id), b.url);
});

test("a prompt through a load balancer gets its result when its turn finishes on a node that is draining", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const answer = Promise.withResolvers<object>();
  const model = await fakeModel(t, (_body, index) => index === 0 ? answer.promise : undefined);
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "handoff-old-owner" });
  await created.close();
  const lb = balancer([a, b]);
  const client = await new AgentRuntime({ url: a.url, fetch: lb.fetch }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "turn-old-owner", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "A called the model");

  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  await until(() => a.logs.some(entry => entry.type === "drain_started"), "A is draining");
  answer.resolve({ role: "assistant", content: "finished on a" });
  assert.equal((await run).reply, "finished on a");
  assert.equal((await exited)[0], 0);
  assert.equal(a.logs.find(entry => entry.type === "drain_finished")?.unfinished, 0);
  assert.equal(model.bodies.length, 1, "the turn was not run again");
});

test("a prompt gets its result when the event stream drops mid-turn, and when its result event is lost", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  let answer = Promise.withResolvers<object>();
  const model = await fakeModel(t, () => answer.promise);
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "dropped-stream" });
  await created.close();
  let lose = false;
  const lb = balancer([a, b], frame => lose && frame.includes('"type":"response"') ? undefined : frame);
  const client = await new AgentRuntime({ url: a.url, fetch: lb.fetch, pollMs: 500 }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());

  // The stream drops while the turn runs; the client reconnects (through the other node) and replays.
  const first = client.prompt("go", { timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "the model was called");
  lb.drop();
  answer.resolve({ role: "assistant", content: "after the drop" });
  assert.equal((await first).reply, "after the drop");

  // The result's event never arrives, and the stream stays up: the client asks for the request's status.
  lose = true;
  answer = Promise.withResolvers<object>();
  answer.resolve({ role: "assistant", content: "event lost" });
  assert.equal((await client.prompt("again", { timeoutMs: 60_000 })).reply, "event lost");
});

test("the agent's files download through another node while their owner drains, and after it has gone", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = { slow: tool({ description: "Wait for the test", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "done"; } }) };
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools, idempotencyKey: "files-while-draining" });
  const report = "x".repeat(300_000);
  await created.files.upload("/workspace/out/report.md", report);
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const turn = client.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;

  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  await until(() => a.logs.some(entry => entry.type === "drain_started"), "A is draining");
  const text = async () => new TextDecoder().decode((await client.files.download("/workspace/out/report.md")).data);
  assert.equal(await text(), report, "served by A through B while A drains");
  gate.resolve();
  assert.equal((await turn).output[0], "done");
  assert.equal((await exited)[0], 0);
  assert.equal(await text(), report, "served by B once A has gone");
});

test("a turn suspended on human input survives its node: the answer, taken by another node, resumes it there", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ask = { questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes" }, { label: "No" }] }] };
  const model = await fakeModel(t, (body, index) => index === 0 ? { role: "assistant", tool_calls: [{ index: 0, id: "call_ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify(ask) } }] }
    : { role: "assistant", content: `answer: ${JSON.parse(toolMessages(body).at(-1)).answers["Proceed?"]}` });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const api = async (base: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as any };
  };
  const definition = (await api(a.url, "/v1/definitions", { name: "Asker", builtins: ["ask_user"] })).json;
  const agent = (await api(a.url, "/v1/agents", { definition: definition.id })).json.id;
  const prompted = (await api(a.url, `/v1/agents/${agent}/prompt`, { text: "go" })).json;
  let record: any;
  await until(async () => (record = (await api(a.url, `/v1/agents/${agent}/requests/${prompted.id}`)).json).state === "completed", "the turn to suspend");
  assert.equal(record.outcome.result.stopped, "input_required");
  const input = record.outcome.result.inputs[0];

  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 500);
  const answered = await api(b.url, `/v1/agents/${agent}/inputs/${input.id}`, { action: "accept", content: { answers: { "Proceed?": "Yes" } } });
  assert.equal(answered.status, 202, JSON.stringify(answered.json));
  await until(async () => (record = (await api(b.url, `/v1/agents/${agent}/requests/${answered.json.request.id}`)).json).state === "completed", "the turn to resume");
  assert.equal(record.outcome.result.reply, "answer: Yes");
  assert.equal(model.bodies.length, 2);
  assert.equal(await c.owner(agent), b.url);
});

test("an approved call whose node dies while it runs ends as outcome unknown on the next owner, never running twice", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (body, index) => index === 0 ? { role: "assistant", tool_calls: [{ index: 0, id: "call_wipe", type: "function", function: { name: "wipe", arguments: "{}" } }] }
    : { role: "assistant", content: toolMessages(body).some((content: string) => /outcome is unknown/.test(content)) ? "noted the unknown outcome" : "unexpected" });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  let executions = 0;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const tools = { wipe: tool({ description: "Wipe the disk", input: schema.Object({}, { additionalProperties: false }), needsApproval: async () => true, execute: async () => { executions++; entered.resolve(); await gate.promise; return "wiped"; } }) };
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools, idempotencyKey: "approved-crash" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const suspended = await client.prompt("wipe it", { timeoutMs: 60_000 });
  assert.equal(suspended.stopped, "input_required");
  assert.equal(suspended.inputs[0].kind, "approval");
  assert.equal(executions, 0, "the application's check asked first");

  const approve = await fetch(`${b.url}/v1/agents/${created.session.id}/inputs/${suspended.inputs[0].id}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
  assert.equal(approve.status, 202, await approve.clone().text());
  const resume = (await approve.json() as any).request.id;
  await entered.promise;
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 500);
  const result = await client.waitForRequest(resume, { timeoutMs: 60_000 });
  assert.equal(result.reply, "noted the unknown outcome");
  assert.equal(executions, 1, "the approved call was never sent again");
});
