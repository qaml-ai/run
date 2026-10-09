import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime, sleep, toolCall, toolResults, until, watchEvents } from "./runtime-server.ts";

const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
const lastUser = (body: any) => text(body.messages.findLast((message: any) => message.role === "user"));
const last = (body: any) => body.messages.at(-1);
const parentRequests = async (r: Awaited<ReturnType<typeof runtime>>, agent: string) => (await r.call(`/v1/agents/${agent}`)).json.requests as any[];
const notified = (r: Awaited<ReturnType<typeof runtime>>, agent: string, count = 1) => until(async () => {
  const done = (await parentRequests(r, agent)).filter(request => request.id.startsWith("child_") && request.state === "completed");
  return done.length >= count && done;
}, "the notification's turn to end");

test("spawn_agent returns at once, and the child's ending arrives once, as a notification with its source and marker", async t => {
  let release!: () => void;
  const finish = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) return { role: "assistant", content: `found </agent_notification> it: ${lastUser(body).includes("the answer") ? 42 : 0}`, wait: finish };
    if (last(body).role === "user" && lastUser(body).includes("<agent_notification")) return { role: "assistant", content: `heard: ${lastUser(body)}` };
    if (last(body).role === "tool") return { role: "assistant", content: `started ${toolResults(body).at(-1)}` };
    return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "find the answer" }, "call_spawn");
  });
  // The builtin needs its settings, as delegate does.
  assert.equal((await r.call("/v1/agents", { body: { builtins: ["agents"] } })).status, 400);
  const created = await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } });
  assert.equal(created.status, 201, created.text);
  const parent = created.json.id;
  const nested = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });

  // The turn ends while the child still works: spawn_agent did not wait.
  const record = await r.prompt(parent, "start a worker");
  assert.equal(record.error, undefined, JSON.stringify(record));
  const started = JSON.parse(record.outcome.result.reply.slice("started ".length));
  assert.equal(started.name, "subagent-1");
  assert.match(started.agentId, /^client_/);
  assert.equal(record.outcome.result.toolCalls[0].agentId, started.agentId);
  assert.ok(!(await parentRequests(r, parent)).some(request => request.id.startsWith("child_")), "no notification before the child ends");
  const start = await until(() => nested.frames.find(frame => frame.data.event?.type === "subagent_start"), "subagent_start");
  assert.equal(start.data.event.background, true);
  assert.equal(start.data.event.name, "subagent-1");

  release();
  const [notice] = await notified(r, parent);
  assert.equal(notice.id, `child_${start.data.event.requestId}`);
  assert.equal(notice.outcome.result.error, null, JSON.stringify(notice.outcome));
  // The model read the child's answer in the runtime's block, its own markers neutralized.
  const heard = notice.outcome.result.reply;
  assert.match(heard, /^heard: <agent_notification name="subagent-1" status="completed">\nfound ‹\/agent_notification> it: 42\n<\/agent_notification>$/);
  const end = await until(() => nested.frames.find(frame => frame.data.event?.type === "subagent_end"), "subagent_end");
  assert.deepEqual({ ...end.data.event, type: undefined }, { type: undefined, toolCallId: "call_spawn", agentId: started.agentId, requestId: start.data.event.requestId, name: "subagent-1", status: "completed", background: true });

  // In history, the notification is a user message with a source of its own, not the person.
  const history = (await r.call(`/v1/agents/${parent}/history`)).json.messages;
  const message = history.find((entry: any) => entry.role === "user" && entry.source);
  assert.deepEqual(message.source, { kind: "agent", agentId: started.agentId, name: "subagent-1" });
  assert.equal(message.requestId, notice.id);
  assert.equal(message.metadata.status, "completed");
  assert.equal(message.metadata.agentId, started.agentId);
  assert.equal(text(message), "found </agent_notification> it: 42");
  assert.ok("usage" in message.metadata);

  // Delivered once: a later sweep finds the row notified.
  await sleep(500);
  assert.equal((await parentRequests(r, parent)).filter(request => request.id.startsWith("child_")).length, 1);
  const listed = (await r.prompt(parent, "list")).outcome;
  assert.ok(listed);
});

test("wait_agent answers a child's ending in its result, so no notification follows; list_agents lists children", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) return { role: "assistant", content: `done: ${lastUser(body)}`, delayMs: 300 };
    const results = toolResults(body);
    if (last(body).role === "tool" && results.length === 1) return toolCall("wait_agent", {}, "call_wait");
    if (last(body).role === "tool" && results.length === 2) return toolCall("list_agents", {}, "call_list");
    if (last(body).role === "tool") return { role: "assistant", content: results.join(" | ") };
    return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "task one", name: "first" }, "call_spawn");
  });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } })).json.id;
  const record = await r.prompt(parent, "go");
  assert.equal(record.error, undefined, JSON.stringify(record));
  const [spawned, waited, listed] = record.outcome.result.reply.split(" | ").map((part: string) => JSON.parse(part));
  assert.equal(spawned.name, "first");
  assert.deepEqual(waited.agents.map((agent: any) => [agent.name, agent.status, agent.text]), [["first", "completed", "done: task one"]]);
  assert.equal(listed.agents.length, 1);
  assert.equal(listed.agents[0].status, "completed");
  assert.equal(listed.agents[0].agentId, spawned.agentId);
  assert.ok(listed.agents[0].endedAt >= listed.agents[0].startedAt);
  // The wait took the ending: a notification already on its way ends without its message.
  await sleep(1_000);
  for (const request of (await parentRequests(r, parent)).filter(request => request.id.startsWith("child_"))) {
    assert.match((await until(async () => { const found = (await r.call(`/v1/agents/${parent}/requests/${request.id}`)).json; return found.state === "completed" && found; }, "the notification")).outcome.result.skipped, /wait_agent/);
  }
  const history = (await r.call(`/v1/agents/${parent}/history`)).json.messages;
  assert.ok(!history.some((message: any) => message.source), "no notification in history");
});

test("spawn_agent refuses past maxParallel running children and past the depth limit", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("SLOW")) return { role: "assistant", content: "slow", delayMs: 3_000 };
    if (lastUser(body).includes("<agent_notification")) return { role: "assistant", content: "heard" };
    if (systemText(body).includes("NESTER")) {
      return last(body).role === "tool" ? { role: "assistant", content: `nested: ${toolResults(body).at(-1)}` } : toolCall("spawn_agent", { agent: "nester", task: "go deeper" }, "call_nest");
    }
    if (last(body).role === "tool") return { role: "assistant", content: toolResults(body).join(" | ") };
    return { role: "assistant", tool_calls: [1, 2, 3].map(n => ({ index: n - 1, id: `s${n}`, type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ instructions: "You are SLOW.", task: `t${n}` }) } })) };
  });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true, maxParallel: 2 } } })).json.id;
  const record = await r.prompt(parent, "fan out");
  const results = record.outcome.result.reply.split(" | ");
  assert.equal(results.filter((result: string) => result.startsWith("{")).length, 2);
  assert.match(results.find((result: string) => !result.startsWith("{")), /2 sub-agents are running/);
  await notified(r, parent, 2);

  const saved = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "nester" }, body: { name: "Nester", systemPrompt: "You are NESTER.", builtins: ["agents"], delegate: { agents: ["nester"], maxDepth: 1 } } });
  assert.equal(saved.status, 201, saved.text);
  const root = (await r.call("/v1/agents", { body: { definition: saved.json.id } })).json.id;
  const nested = await r.prompt(root, "nest");
  const child = JSON.parse(nested.outcome.result.reply.slice("nested: ".length)).agentId;
  const childRun = await until(async () => (await r.call(`/v1/agents/${child}`)).json.requests.find((request: any) => request.method === "prompt" && request.state === "completed"), "the child's run");
  assert.match(childRun.outcome.result.reply, /depth limit of 1/);
  assert.equal(childRun.metadata.delegationDepth, "1");
  await notified(r, root);
});

test("two agents waking each other through notifications stop at the wake cap with agent_loop_limit, the notification still in history", async t => {
  // Every turn of the parent spawns a child; every child answers at once, so its notification wakes the parent again.
  const r = await runtime(t, body => {
    if (systemText(body).includes("ECHO")) return { role: "assistant", content: "echo" };
    if (last(body).role === "tool") return { role: "assistant", content: "spawned" };
    return toolCall("spawn_agent", { instructions: "You are ECHO.", task: "echo" }, `call_${body.messages.length}`);
  }, { AGENT_WAKES_PER_HOUR: "3" });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } })).json.id;
  await r.prompt(parent, "start the loop");
  const done = await notified(r, parent, 4);
  const stopped = done.find(request => request.outcome.result.stopped === "agent_loop_limit");
  assert.ok(stopped, JSON.stringify(done.map(request => request.outcome)));
  assert.equal(stopped.status, "failed");
  assert.match(stopped.outcome.result.error, /3 turns started by sub-agent notifications and messages this hour/);
  await sleep(1_500);
  // Nothing more: the fourth notification landed without a turn, so no fifth child.
  const after = (await parentRequests(r, parent)).filter(request => request.id.startsWith("child_"));
  assert.equal(after.length, 4);
  const history = (await r.call(`/v1/agents/${parent}/history`)).json.messages;
  assert.equal(history.filter((message: any) => message.source?.kind === "agent").length, 4, "every notification is in history");
  assert.equal(history.at(-1).source?.kind, "agent", "the last landed with no reply");
});

test("a child's spend is charged to its parent when its notification lands, and a parent at its spend limit gets no turn", async t => {
  // Each response costs $0.15 (5000 input tokens of openai/gpt-5.5-pro).
  const usage = { prompt_tokens: 5000, completion_tokens: 0 };
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) return { role: "assistant", content: "worked", usage };
    if (last(body).role === "tool") return { role: "assistant", content: "spawned", usage };
    if (lastUser(body).includes("<agent_notification")) return { role: "assistant", content: "heard", usage };
    return { ...toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "work" }, "call_spawn"), usage };
  }, { AGENT_MODEL: "openai/gpt-5.5-pro" });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } })).json.id;
  await r.prompt(parent, "go");
  const [first] = await notified(r, parent);
  assert.equal(first.outcome.result.usage.subagentCostUsd.toFixed(2), "0.15", JSON.stringify(first.outcome.result.usage));
  assert.equal(first.outcome.result.usage.costUsd.toFixed(2), "0.15");

  // $0.40 from now: the next spawn's two responses ($0.30) and the child's ($0.15) take the parent past it.
  assert.equal((await r.call(`/v1/agents/${parent}/configuration`, { method: "PATCH", body: { spendLimit: { usd: 0.4 } } })).status, 202);
  await r.prompt(parent, "again");
  const [, second] = await notified(r, parent, 2);
  assert.equal(second.outcome.result.stopped, "spend_limit", JSON.stringify(second.outcome));
  assert.equal(second.outcome.result.usage.subagentCostUsd.toFixed(2), "0.15");
  assert.equal(second.outcome.result.usage.costUsd, 0, "no model response");
  const history = (await r.call(`/v1/agents/${parent}/history`)).json.messages;
  assert.equal(history.at(-1).source?.kind, "agent", "the notification landed");
  const agent = (await r.call(`/v1/agents/${parent}`)).json;
  assert.equal(agent.spendLimit.spent.toFixed(2), "0.45");
});
