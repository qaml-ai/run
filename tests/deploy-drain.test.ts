import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents, schema, tool } from "../clients/node.ts";
import { OPERATOR, runtime, sleep, toolCall, toolResults, until } from "./runtime-server.ts";

/** A model that calls `slow` once per message, then says what it answered. */
const model = (body: any) => body.messages.at(-1).role === "user" ? toolCall("slow", { value: "go" }) : { role: "assistant", content: `Tool said: ${toolResults(body).at(-1)}` };

/** A process that runs the agent without serving its tools. */
function caller(t: { after(fn: () => Promise<void>): void }, url: string) {
  const agents = new Agents({ url, apiKey: OPERATOR });
  t.after(() => agents.close());
  return agents;
}

/** A `slow` tool that answers `answer` once `gate` opens, and says when it started. */
function slowTool(answer: string, gate: Promise<unknown> = Promise.resolve()) {
  const calls = { started: 0 };
  const slow = tool({
    description: "Do something slowly", input: schema.Object({ value: schema.String() }),
    execute: async () => { calls.started++; await gate; return { answer }; },
  });
  return { slow, calls };
}

test("a rolling deploy loses no tool call: the new process takes over, and the old one finishes its call as it closes", async t => {
  const r = await runtime(t, model);
  const old = new Agents({ url: r.base, apiKey: OPERATOR }), fresh = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(async () => { await old.close({ drainMs: 0 }); await fresh.close({ drainMs: 0 }); });
  const gate = Promise.withResolvers<void>();
  const before = slowTool("from the old process", gate.promise);
  const agent = await old.upsert("deploy", { tools: { slow: before.slow } });
  // The run's caller is elsewhere (a web request, say): the process serving the tools is the one deployed.
  const running = (await caller(t, r.base).agent(agent.client.session)).run("go");
  await until(() => before.calls.started === 1, "the call to start in the old process");

  // The deploy: the new process starts and takes over, then the old one gets SIGTERM and drains.
  const after = slowTool("from the new process");
  const replacement = await fresh.upsert("deploy", { tools: { slow: after.slow }, takeover: true });
  let closed = false;
  const closing = old.close().then(() => { closed = true; });
  await sleep(300);
  assert.equal(closed, false, "close() waits for the call it has");
  gate.resolve();

  const run = await running;
  assert.match(run.text, /from the old process/);
  assert.deepEqual(run.toolErrors, []);
  await closing;
  // The agent's next call goes to the new process.
  assert.match((await replacement.run("again")).text, /from the new process/);
  assert.deepEqual([before.calls.started, after.calls.started], [1, 1]);
});

test("a stop-then-start deploy loses no tool call: close() finishes the call, and the next process connects without a takeover even while it drains", async t => {
  const r = await runtime(t, model);
  const old = new Agents({ url: r.base, apiKey: OPERATOR }), fresh = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(async () => { await old.close({ drainMs: 0 }); await fresh.close({ drainMs: 0 }); });
  const gate = Promise.withResolvers<void>();
  const before = slowTool("finished while draining", gate.promise);
  const agent = await old.upsert("stop-start", { tools: { slow: before.slow } });
  // The run's caller is elsewhere (a web request, say): the process serving the tools is the one deployed.
  const running = (await caller(t, r.base).agent(agent.client.session)).run("go");
  await until(() => before.calls.started === 1, "the call to start");

  const closing = old.close();
  // A draining connection holds the tools no longer: the next process takes them without takeover.
  await sleep(150);
  const replacement = await fresh.upsert("stop-start", { tools: { slow: slowTool("from the next process").slow } });
  gate.resolve();
  const run = await running;
  assert.match(run.text, /finished while draining/);
  assert.deepEqual(run.toolErrors, []);
  await closing;
  assert.match((await replacement.run("again")).text, /from the next process/);
});

test("a call cut off with its connection tells the model, in plain words, that it may or may not have run", async t => {
  const r = await runtime(t, model);
  const old = new Agents({ url: r.base, apiKey: OPERATOR });
  const { slow, calls } = slowTool("never", new Promise(() => {}));
  const agent = await old.upsert("cut", { tools: { slow } });
  const running = (await caller(t, r.base).agent(agent.client.session)).run("go", { throwOnError: false });
  await until(() => calls.started === 1, "the call to start");
  await old.close({ drainMs: 0 });

  const run = await running;
  assert.equal(run.toolErrors.length, 1);
  const [lost] = run.toolErrors as { code: string; outcomeUnknown?: boolean; message: string }[];
  assert.equal(lost.code, "connection_lost");
  assert.equal(lost.outcomeUnknown, true);
  assert.match(lost.message, /disconnected during the call.*may or may not have taken effect/);
  assert.doesNotMatch(lost.message, /MCP error|-32000|Connection closed/);
  assert.match(run.text, /may or may not have taken effect/, "the model was told the same");
});

test("a takeover while a call runs lets the replaced process answer it, then tells it it was replaced", async t => {
  const r = await runtime(t, model);
  const old = new Agents({ url: r.base, apiKey: OPERATOR }), fresh = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(async () => { await old.close({ drainMs: 0 }); await fresh.close({ drainMs: 0 }); });
  const gate = Promise.withResolvers<void>();
  const before = slowTool("answered after the takeover", gate.promise);
  const errors: Error[] = [];
  const agent = await old.upsert("takeover", { tools: { slow: before.slow }, onError: error => errors.push(error) });
  const running = (await caller(t, r.base).agent(agent.client.session)).run("go");
  await until(() => before.calls.started === 1, "the call to start");
  await fresh.upsert("takeover", { tools: { slow: slowTool("new").slow }, takeover: true });
  await sleep(200);
  assert.equal(errors.length, 0, "the replaced process keeps its connection while its call runs");
  gate.resolve();
  const run = await running;
  assert.match(run.text, /answered after the takeover/);
  assert.deepEqual(run.toolErrors, []);
  await until(() => errors.some((error: any) => error.code === "APPLICATION_REPLACED"), "the replaced process to hear it");
});

test("close() waits for no call the runtime gave up on, nor when there is nothing to finish", async t => {
  const r = await runtime(t, model);
  const old = new Agents({ url: r.base, apiKey: OPERATOR });
  // A tool that ignores its abort signal, past a 1 s deadline: the runtime cancels it and moves on.
  const stuck = tool({ description: "Never answer", input: schema.Object({ value: schema.String() }), timeoutMs: 1000, execute: () => new Promise(() => {}) });
  const agent = await old.upsert("stuck", { tools: { slow: stuck } });
  const run = await (await caller(t, r.base).agent(agent.client.session)).run("go", { throwOnError: false });
  assert.equal((run.toolErrors[0] as { code: string }).code, "timeout");
  const started = Date.now();
  await old.close();
  assert.ok(Date.now() - started < 1000, `close() took ${Date.now() - started} ms`);
});
