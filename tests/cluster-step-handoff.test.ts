import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { balancer, cluster, fakeEcs, fakeModel, sleep, token, toolMessages, until } from "./cluster-helpers.ts";

// A periodic sweep too slow to matter: what moves a turn below is the leaving node telling its peers. AGENT_HOSTING=inline
// runs them as on ECS.
const QUIET = { AGENT_ORPHAN_SWEEP_MS: "600000", ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}) };
type Node = Awaited<ReturnType<Awaited<ReturnType<typeof cluster>>["start"]>> & { ecs?: Awaited<ReturnType<typeof fakeEcs>> };
type T = Parameters<typeof cluster>[0];

const api = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
};
const unknown = (body: any) => toolMessages(body).some((content: string) => /outcome is unknown|may or may not have/.test(content));
const handedOff = (node: Node) => node.logs.filter(entry => entry.type === "turn_handed_off");

/** A node with an ECS of its own, so each can be superseded (retired) by a deploy on its own. */
async function ecsNode(t: T, c: Awaited<ReturnType<typeof cluster>>, name: string, env: Record<string, string>): Promise<Node> {
  const ecs = await fakeEcs(t);
  return { ...await c.start(name, { ...ecs.env, ...QUIET, ...env }), ecs };
}
/** A newer deploy supersedes `node`: it retires once it sees it (a peer has joined). */
async function retire(node: Node) {
  node.ecs!.state.revision++;
  node.ecs!.state.created = Date.now() / 1000;
  await until(() => node.logs.some(entry => entry.type === "retiring"), `${node.name} to retire`);
}

/** The application's tool: each call waits for the test to let it go, and says which call it was. */
function gatedTool() {
  const calls: number[] = [];
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const entered = new Map<number, PromiseWithResolvers<void>>();
  const gate = (step: number) => { if (!gates.has(step)) gates.set(step, Promise.withResolvers()); return gates.get(step)!; };
  const enter = (step: number) => { if (!entered.has(step)) entered.set(step, Promise.withResolvers()); return entered.get(step)!; };
  const tools = {
    slow: tool({
      description: "A slow step", input: schema.Object({ step: schema.Number() }, { additionalProperties: false }),
      execute: async ({ step }) => { calls.push(step); enter(step).resolve(); await gate(step).promise; return `done-${step}`; },
    }),
  };
  return { tools, calls, entered: (step: number) => enter(step).promise, release: (step: number) => gate(step).resolve(), releaseAll: () => { for (let step = 0; step < 10; step++) gate(step).resolve(); } };
}
const slowCall = (step: number) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: "slow", arguments: JSON.stringify({ step }) } }] });

/**
 * Follow an agent's event stream as a watcher does, reconnecting with Last-Event-ID wherever the load balancer sends
 * it: every frame it got, and every 409 (a gap: events it would have missed). Other refusals (a node on its way out) are retried.
 */
function watch(nodes: Node[], agent: string) {
  const frames: { id: number; data: any }[] = [];
  const refusals: number[] = [];
  const stop = new AbortController();
  let cursor = 0, turn = 0;
  const done = (async () => {
    while (!stop.signal.aborted) {
      const up = nodes.filter(node => node.child.exitCode === null && !node.logs.some(entry => entry.type === "drain_started"));
      const node = up[turn++ % up.length];
      try {
        const response = await fetch(`${node.url}/v1/agents/${agent}/events?snapshot=0`, { headers: { Authorization: `Bearer ${token}`, ...(cursor ? { "Last-Event-ID": String(cursor) } : {}) }, signal: stop.signal });
        if (!response.ok || !response.body) { if (response.status === 409) refusals.push(response.status); await response.body?.cancel(); await sleep(100); continue; }
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
            const lines = buffer.slice(0, end).split("\n");
            const id = Number(lines.find(line => line.startsWith("id:"))?.slice(3));
            const text = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!text || lines.includes("event: ready") || !Number.isSafeInteger(id)) continue;
            frames.push({ id, data: JSON.parse(text) });
            cursor = id;
          }
        }
      } catch { /* cut off, or stopped */ }
      await sleep(50);
    }
  })();
  return { frames, refusals, stop: async () => { stop.abort(); await done; } };
}

test("(a) a retiring node lets the tool call in flight finish, and the turn goes on on the new node: three deploys in a row, no outcome unknown, one model call per step, no resumes spent", { timeout: 180_000 }, async t => {
  const c = await cluster(t);
  const steps = 3;
  const model = await fakeModel(t, (_body, index) => index < steps ? slowCall(index) : { role: "assistant", content: "finished after three deploys" });
  const gated = gatedTool();
  t.after(() => gated.releaseAll());
  const nodes: Node[] = [await ecsNode(t, c, "a", model.env), await ecsNode(t, c, "b", model.env)];
  const created = await new AgentRuntime({ url: nodes[0].url, apiKey: token }).createAgent({ tools: gated.tools, idempotencyKey: "three-deploys" });
  await created.close();
  const agent = created.session.id;
  const client = await new AgentRuntime({ url: nodes[0].url, fetch: balancer(nodes).fetch }).connectAgent(created.session, { tools: gated.tools });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "long-turn", timeoutMs: 150_000 });

  for (let step = 0; step < steps; step++) {
    const [old, next] = [nodes[step], nodes[step + 1]];
    await gated.entered(step);
    assert.equal(await c.owner(agent), old.url, `step ${step} runs on ${old.name}`);
    await retire(old);
    // Retiring does not cut the call off: it finishes on the old node, whenever it does.
    await sleep(500);
    assert.equal(await c.owner(agent), old.url, `${old.name} keeps the agent while its step runs`);
    assert.equal(model.bodies.length, step + 1, "no model call while the step runs");
    const released = Date.now();
    gated.release(step);
    await until(() => handedOff(next).length === 1, `${next.name} to continue the turn`, 30_000);
    const line = handedOff(next)[0];
    assert.equal(line.Reason, "retire");
    assert.equal(line.Step, "tool");
    assert.equal(line.request, "long-turn");
    assert.ok(line.BoundaryWaitMs >= 500, JSON.stringify(line));
    assert.ok(line.HandoffLatencyMs < 3_000, JSON.stringify(line));
    assert.ok(Date.now() - released < 5_000, "continued within seconds of the boundary");
    t.diagnostic(`hand-off ${step + 1}: ${old.name} to ${next.name}, waited ${line.BoundaryWaitMs} ms for the boundary, continued ${line.HandoffLatencyMs} ms after it`);
    await until(() => model.bodies.length === step + 2, `the next model call, from ${next.name}`);
    assert.equal(await c.owner(agent), next.url);
    assert.equal(handedOff(old).length, step === 0 ? 0 : 1, "the old node did not continue it");
    // The next deploy needs a node to go to.
    if (step + 2 < steps + 1) nodes.push(await ecsNode(t, c, String.fromCharCode(99 + step), model.env));
  }
  const result = await run;
  assert.equal(result.reply, "finished after three deploys");
  assert.deepEqual(gated.calls, [0, 1, 2], "each tool call ran once");
  assert.equal(model.bodies.length, steps + 1, "one model call per step");
  for (const [index, body] of model.bodies.entries()) {
    assert.ok(!unknown(body), `model call ${index} heard of no unknown outcome`);
    if (index) assert.ok(toolMessages(body).some((content: string) => content.includes(`done-${index - 1}`)), `model call ${index} has step ${index - 1}'s result`);
  }
  const record = (await api(nodes.at(-1)!.url, `/v1/agents/${agent}/requests/long-turn`)).json;
  assert.equal(record.state, "completed");
  assert.equal(record.resumes, undefined, "hand-offs at a boundary are not resumes");
  assert.deepEqual(record.handoffs.map((entry: any) => entry.reason), ["retire", "retire", "retire"]);
  assert.equal(record.handedOff, undefined);
  assert.equal(record.carried, undefined);
  assert.equal(record.outcome.result.usage.responses, steps + 1, "usage counts every node's responses");
  assert.deepEqual(record.outcome.result.toolCalls.map((call: any) => call.toolCallId), ["call_0", "call_1", "call_2"], "tool calls from every node");
});

test("(b) a retiring node lets the model stream in flight complete (and its tool calls run), and the next step's model call is made on the new node", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const answer = Promise.withResolvers<object>();
  t.after(() => answer.resolve({ role: "assistant", content: "unused" }));
  const model = await fakeModel(t, (_body, index) => index === 0 ? answer.promise : { role: "assistant", content: "next step on b" });
  const gated = gatedTool();
  gated.release(0);
  const a = await ecsNode(t, c, "a", model.env);
  const b = await ecsNode(t, c, "b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: gated.tools, idempotencyKey: "mid-stream" });
  await created.close();
  const client = await new AgentRuntime({ url: a.url, fetch: balancer([a, b]).fetch }).connectAgent(created.session, { tools: gated.tools });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "streaming-turn", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "A to call the model");
  await retire(a);
  await sleep(500);
  answer.resolve(slowCall(0));
  assert.equal((await run).reply, "next step on b");
  assert.equal(model.bodies.length, 2, "the stream was not asked again");
  assert.ok(!unknown(model.bodies[1]));
  assert.ok(toolMessages(model.bodies[1]).some((content: string) => content.includes("done-0")), "its tool call ran on A");
  const [line] = handedOff(b);
  assert.equal(line?.Step, "model", JSON.stringify(line));
  assert.ok(line.BoundaryWaitMs >= 500);
  assert.equal(handedOff(a).length, 0);
  const record = (await api(b.url, `/v1/agents/${created.session.id}/requests/streaming-turn`)).json;
  assert.equal(record.resumes, undefined);
  assert.equal(record.handoffs.length, 1);
});

test("(b2) a model call that fails while its node retires is not retried there: the failed attempt is taken back and the new node asks again", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let b: Node | undefined;
  // Every call fails (503, retryable) until B has taken the turn over; A's first one waits for the retirement.
  const model = await fakeModel(t, async (_body, index) => {
    if (b && handedOff(b).length) return { role: "assistant", content: "asked again on b" };
    if (index === 0) await gate.promise;
    return { status: 503 };
  });
  const a = await ecsNode(t, c, "a", model.env);
  b = await ecsNode(t, c, "b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "fails-while-retiring" });
  await created.close();
  const client = await new AgentRuntime({ url: a.url, fetch: balancer([a, b]).fetch }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "failing-turn", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "A to call the model");
  await retire(a);
  gate.resolve();
  const result = await run;
  assert.equal(result.reply, "asked again on b");
  assert.equal(result.error ?? null, null);
  const [line] = handedOff(b);
  assert.equal(line?.Step, "model", JSON.stringify(line));
  const record = (await api(b.url, `/v1/agents/${created.session.id}/requests/failing-turn`)).json;
  assert.equal(record.resumes, undefined);
  assert.equal(record.handoffs.length, 1);
  const history = (await api(b.url, `/v1/agents/${created.session.id}/history`)).json.messages;
  assert.ok(!history.some((message: any) => message.stopReason === "error"), "the failed attempt is not history");
});

test("(c) a step that outlasts the retire cap is handed off mid-step: its call in flight is closed as of unknown outcome", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (body, index) => index === 0 ? slowCall(0) : { role: "assistant", content: unknown(body) ? "noted the unknown outcome" : "unexpected" });
  const gated = gatedTool();
  t.after(() => gated.releaseAll());
  const a = await ecsNode(t, c, "a", { ...model.env, AGENT_RETIRE_MAX_MS: "1500" });
  const b = await ecsNode(t, c, "b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: gated.tools, idempotencyKey: "outlives-cap" });
  await created.close();
  const client = await new AgentRuntime({ url: a.url, fetch: balancer([a, b]).fetch }).connectAgent(created.session, { tools: gated.tools });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "capped-turn", timeoutMs: 60_000 });
  await gated.entered(0);
  await retire(a);
  await until(() => a.logs.some(entry => entry.type === "retire_cap_reached"), "the cap to pass", 10_000);
  assert.equal((await run).reply, "noted the unknown outcome");
  assert.equal(await c.owner(created.session.id), b.url);
  await until(() => a.logs.some(entry => entry.type === "retired"), "A to have nothing left");
  await until(() => a.ecs!.state.protection.at(-1) === false, "A to drop its protection");
  const record = (await api(b.url, `/v1/agents/${created.session.id}/requests/capped-turn`)).json;
  assert.equal(record.resumes, 1, "a mid-step hand-off is a resume, as before");
  assert.equal(record.handoffs, undefined);
  assert.equal(handedOff(b).length, 0);
});

test("(d) SIGTERM: the draining node finishes the step in flight and hands the turn off at the boundary, then exits well within its drain timeout", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? slowCall(0) : { role: "assistant", content: "continued after the drain" });
  const gated = gatedTool();
  t.after(() => gated.releaseAll());
  const a = await c.start("a", { ...model.env, ...QUIET });
  const b = await c.start("b", { ...model.env, ...QUIET });
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: gated.tools, idempotencyKey: "drained-at-boundary" });
  await created.close();
  const client = await new AgentRuntime({ url: a.url, fetch: balancer([a, b]).fetch }).connectAgent(created.session, { tools: gated.tools });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "drained-turn", timeoutMs: 60_000 });
  await gated.entered(0);
  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  await until(() => a.logs.some(entry => entry.type === "drain_started"), "A to drain");
  await sleep(500);
  gated.release(0);
  assert.equal((await run).reply, "continued after the drain");
  assert.equal((await exited)[0], 0);
  const finished = a.logs.find(entry => entry.type === "drain_finished");
  assert.equal(finished.unfinished, 0, "nothing was cut off");
  assert.ok(finished.ms < 15_000, `the drain took ${finished.ms} ms of its 100 s`);
  assert.equal(model.bodies.length, 2);
  assert.ok(!unknown(model.bodies[1]));
  const [line] = handedOff(b);
  assert.equal(line?.Reason, "drain", JSON.stringify(line));
  assert.equal(line.Step, "tool");
  const record = (await api(b.url, `/v1/agents/${created.session.id}/requests/drained-turn`)).json;
  assert.equal(record.resumes, undefined);
  assert.deepEqual(record.handoffs.map((entry: any) => entry.reason), ["drain"]);
});

test("(e) a watcher following the agent across a deploy and a drain sees every event once, in order, and the run's outcome once", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index < 2 ? slowCall(index) : { role: "assistant", content: "watched to the end" });
  const gated = gatedTool();
  t.after(() => gated.releaseAll());
  const nodes: Node[] = [await ecsNode(t, c, "a", model.env), await ecsNode(t, c, "b", model.env), await ecsNode(t, c, "c", model.env)];
  const [a, b, third] = nodes;
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: gated.tools, idempotencyKey: "watched" });
  await created.close();
  const agent = created.session.id;
  const watcher = watch(nodes, agent);
  t.after(() => watcher.stop());
  const client = await new AgentRuntime({ url: a.url, fetch: balancer(nodes).fetch }).connectAgent(created.session, { tools: gated.tools });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "watched-turn", timeoutMs: 90_000 });

  await gated.entered(0);
  await retire(a);
  gated.release(0);
  await gated.entered(1);
  // The second hand-off is a drain of whichever node took the turn.
  const owner = await c.owner(agent);
  assert.ok(owner === b.url || owner === third.url, `owned by ${owner}`);
  const second = owner === b.url ? b : third;
  second.child.kill("SIGTERM");
  await until(() => second.logs.some(entry => entry.type === "drain_started"), "the drain to start");
  gated.release(1);
  assert.equal((await run).reply, "watched to the end");
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === "watched-turn"), "the watcher to see the outcome");
  await sleep(500);
  await watcher.stop();

  assert.deepEqual(watcher.refusals, [], "never behind the buffer");
  const ids = watcher.frames.map(frame => frame.id);
  for (let index = 1; index < ids.length; index++) assert.ok(ids[index] > ids[index - 1], `ids rise: ${ids[index - 1]} then ${ids[index]}`);
  const events = watcher.frames.filter(frame => frame.data.type === "event" && frame.data.requestId === "watched-turn").map(frame => frame.data.event);
  assert.equal(watcher.frames.filter(frame => frame.data.type === "response").length, 1, "the outcome once");
  assert.equal(events.filter(event => event.type === "agent_end").length, 1, "the turn ends once, at its end");
  assert.equal(watcher.frames.filter(frame => frame.data.event?.type === "turn_resumed" && frame.data.event.handoff).length, 2);
  // What the watcher folded is the turn as history has it: every message once, in order.
  const start = events.find(event => event.type === "turn_opened").index;
  const ended = events.filter(event => event.type === "message_end").map(event => event.message);
  const history = (await api(nodes.find(node => node.child.exitCode === null && node !== a)!.url, `/v1/agents/${agent}/history`)).json.messages.slice(start);
  const shape = (message: any) => `${message.role}:${message.toolCallId ?? (message.content?.find?.((part: any) => part.type === "toolCall")?.id ?? "")}`;
  assert.deepEqual(ended.map(shape), history.map(shape));
  assert.equal(new Set(ended.map(shape)).size, ended.length, "no message twice");
});

test("(f) a draining node gives up an agent waiting on human input at once, while another agent's step still runs there", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ask = { questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes" }, { label: "No" }] }] };
  const model = await fakeModel(t, (body, index) => {
    if (JSON.stringify(body.messages).includes("ask me")) return toolMessages(body).length ? { role: "assistant", content: `answer: ${JSON.parse(toolMessages(body).at(-1)).answers["Proceed?"]}` }
      : { role: "assistant", tool_calls: [{ index: 0, id: "call_ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify(ask) } }] };
    return toolMessages(body).length ? { role: "assistant", content: "busy turn done" } : slowCall(0);
  });
  const gated = gatedTool();
  t.after(() => gated.releaseAll());
  const a = await c.start("a", { ...model.env, ...QUIET });
  const b = await c.start("b", { ...model.env, ...QUIET });
  const definition = (await api(a.url, "/v1/definitions", { name: "Asker", builtins: ["ask_user"] })).json;
  const asker = (await api(a.url, "/v1/agents", { definition: definition.id })).json.id;
  const prompted = (await api(a.url, `/v1/agents/${asker}/prompt`, { text: "ask me" })).json;
  let record: any;
  await until(async () => (record = (await api(a.url, `/v1/agents/${asker}/requests/${prompted.id}`)).json).state === "completed", "the turn to suspend");
  assert.equal(record.outcome.result.stopped, "input_required");
  assert.equal(await c.owner(asker), a.url);

  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: gated.tools, idempotencyKey: "keeps-a-busy" });
  await created.close();
  const client = await new AgentRuntime({ url: a.url, fetch: balancer([a, b]).fetch }).connectAgent(created.session, { tools: gated.tools });
  t.after(() => client.close());
  const busy = client.prompt("work", { idempotencyKey: "busy-turn", timeoutMs: 60_000 });
  await gated.entered(0);
  assert.equal(await c.owner(created.session.id), a.url);

  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  await until(() => a.logs.some(entry => entry.type === "drain_started"), "A to drain");
  const signalled = Date.now();
  await until(async () => await c.owner(asker) !== a.url, "A to give up the suspended agent", 5_000);
  assert.ok(Date.now() - signalled < 3_000, "at once, not after the busy step");
  assert.equal(await c.owner(created.session.id), a.url, "the busy agent's step still runs on A");
  const answered = await api(b.url, `/v1/agents/${asker}/inputs/${record.outcome.result.inputs[0].id}`, { action: "accept", content: { answers: { "Proceed?": "Yes" } } });
  assert.equal(answered.status, 202, JSON.stringify(answered.json));
  await until(async () => (record = (await api(b.url, `/v1/agents/${asker}/requests/${answered.json.request.id}`)).json).state === "completed", "the answer to resume the turn on B");
  assert.equal(record.outcome.result.reply, "answer: Yes");
  assert.equal(await c.owner(asker), b.url);

  gated.release(0);
  assert.equal((await busy).reply, "busy turn done");
  assert.equal((await exited)[0], 0);
  assert.equal(a.logs.find(entry => entry.type === "drain_finished").unfinished, 0);
});
