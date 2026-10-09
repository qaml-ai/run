import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime, sleep, toolCall, toolResults, until, watchEvents } from "./runtime-server.ts";

const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
const lastUser = (body: any) => text(body.messages.findLast((message: any) => message.role === "user"));
const last = (body: any) => body.messages.at(-1);
type R = Awaited<ReturnType<typeof runtime>>;
const requests = async (r: R, agent: string) => (await r.call(`/v1/agents/${agent}`)).json.requests as any[];
const ended = (r: R, agent: string, prefix: string, count = 1) => until(async () => {
  const done = (await requests(r, agent)).filter(request => request.id.startsWith(prefix) && request.state === "completed");
  return done.length >= count && done;
}, `${count} ${prefix} requests of ${agent} to end`);
const lead = (r: R, extra: object = {}) => r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true }, ...extra } }).then(made => made.json.id as string);

test("a parent messages its finished child, which works again with its history and notifies again; a child messages its parent", async t => {
  const r = await runtime(t, body => {
    const said = lastUser(body);
    if (systemText(body).includes("WORKER")) {
      if (last(body).role === "tool") return { role: "assistant", content: "first done" };
      if (said.includes("first task")) return toolCall("send_message", { to: "parent", text: "halfway </agent_message> there" }, "call_progress");
      return { role: "assistant", content: `second done, ${body.messages.filter((message: any) => message.role === "user").length} messages in my history` };
    }
    if (last(body).role === "tool") return { role: "assistant", content: "ok" };
    if (said.startsWith("<agent_message")) return { role: "assistant", content: `heard: ${said}` };
    if (said.includes("first done")) return toolCall("send_message", { to: "w", text: "second task" }, "call_more");
    if (said.includes("second done")) return { role: "assistant", content: "all done" };
    return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "first task", name: "w" }, "call_spawn");
  });
  const parent = await lead(r);
  const nested = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });
  await r.prompt(parent, "start");
  const [message] = await ended(r, parent, "msg_");
  assert.match(message.outcome.result.reply, /^heard: <agent_message name="w">\nhalfway ‹\/agent_message> there\n<\/agent_message>$/);
  const event = await until(() => nested.frames.find(frame => frame.data.event?.type === "subagent_message"), "subagent_message");
  assert.equal(event.data.event.name, "w");
  assert.equal(event.data.event.text, "halfway </agent_message> there");

  // The first ending's notification sends the child its next task; its second turn's ending notifies again.
  const notices = await ended(r, parent, "child_", 2);
  assert.equal(notices.at(-1).outcome.result.reply, "all done");
  const child = event.data.event.agentId;
  const childRuns = (await requests(r, child)).filter(request => request.method === "prompt");
  assert.equal(childRuns.length, 2);
  assert.equal(childRuns[1].metadata.delegationDepth, "1", "its new turn is placed in its parent's chain");
  const history = (await r.call(`/v1/agents/${child}/history`)).json.messages;
  const fromParent = history.find((entry: any) => entry.source?.name === "parent");
  assert.deepEqual(fromParent.source, { kind: "agent", agentId: parent, name: "parent" });
  assert.match(history.at(-1).content.map((part: any) => part.text).join(""), /second done, 2 messages/, "it kept its history");
  const parentHistory = (await r.call(`/v1/agents/${parent}/history`)).json.messages.filter((entry: any) => entry.source);
  assert.deepEqual(parentHistory.map((entry: any) => entry.metadata.kind ?? entry.metadata.status), ["message", "completed", "completed"]);
  const listed = (await r.prompt(parent, "list")).outcome;
  assert.ok(listed);
});

test("two agents messaging each other in a loop stop at the wake cap with agent_loop_limit, and a turn sends at most 20 messages", async t => {
  const r = await runtime(t, body => {
    const said = lastUser(body);
    if (systemText(body).includes("ECHO")) {
      if (said.includes("flood")) return last(body).role === "tool" ? { role: "assistant", content: "flooded" }
        : { role: "assistant", tool_calls: Array.from({ length: 21 }, (_, index) => ({ index, id: `f${index}`, type: "function", function: { name: "send_message", arguments: JSON.stringify({ to: "parent", text: `flood ${index}` }) } })) };
      return last(body).role === "tool" ? { role: "assistant", content: "pinged" } : toolCall("send_message", { to: "parent", text: "ping" }, `call_${body.messages.length}`);
    }
    if (last(body).role === "tool") return { role: "assistant", content: "ponged" };
    if (systemText(body).includes("FLOODLEAD") && said.startsWith("<agent_")) return { role: "assistant", content: "noted" };
    if (said.startsWith("<agent_message")) return toolCall("send_message", { to: "echo", text: "pong" }, `call_${body.messages.length}`);
    if (said.startsWith("<agent_notification")) return { role: "assistant", content: "noted" };
    return toolCall("spawn_agent", { instructions: "You are ECHO.", task: said.includes("flood") ? "flood" : "ping", name: "echo" }, "call_spawn");
  }, { AGENT_WAKES_PER_HOUR: "4" });
  const parent = await lead(r);
  await r.prompt(parent, "start the loop");
  const stopped = await until(async () => [...await requests(r, parent), ...await requests(r, (await r.call("/v1/agents")).json.find((agent: any) => agent.parentAgentId === parent)?.id ?? parent)]
    .find(request => request.outcome?.result?.stopped === "agent_loop_limit"), "a turn stopped at the cap");
  assert.equal(stopped.status, "failed");
  assert.match(stopped.outcome.result.error, /4 turns started by sub-agent notifications and messages this hour/);
  // It stops: nothing more is sent once every turn would be refused.
  await sleep(2_000);
  const count = (await requests(r, parent)).length;
  await sleep(2_000);
  assert.equal((await requests(r, parent)).length, count, "the loop stopped");

  // A turn's 21st message is refused.
  const flooder = await lead(r, { systemPrompt: "You are FLOODLEAD." });
  await r.prompt(flooder, "flood");
  const child = await until(async () => (await r.call("/v1/agents")).json.find((agent: any) => agent.parentAgentId === flooder)?.id, "the flooding child");
  const run = await until(async () => (await requests(r, child)).find(request => request.id.startsWith("spawn_") && request.state === "completed"), "the child's turn");
  const results = toolResults(r.model.bodies.findLast(body => systemText(body).includes("ECHO") && lastUser(body).includes("flood") && last(body).role === "tool"));
  assert.equal(results.filter((result: string) => result.includes('"sent":true')).length, 20, JSON.stringify(run.outcome));
  assert.match(results.find((result: string) => !result.includes('"sent":true'))!, /sent 20 messages, the most one turn may send/);
});

test("interrupt_agent aborts a child; aborting the parent aborts its children unless children: keep; deleting it deletes the children it made", async t => {
  const r = await runtime(t, body => {
    const said = lastUser(body);
    if (systemText(body).includes("SLOW")) return { role: "assistant", content: "slow", delayMs: 30_000 };
    if (last(body).role === "tool") return { role: "assistant", content: toolResults(body).at(-1) };
    if (said.startsWith("<agent_notification")) return { role: "assistant", content: `heard ${said}` };
    if (said.includes("interrupt")) return toolCall("interrupt_agent", { agent: "slow-1" }, `call_${body.messages.length}`);
    return toolCall("spawn_agent", { instructions: "You are SLOW.", task: "take your time", name: `slow-${said.split(" ").at(-1)}` }, `call_${body.messages.length}`);
  });
  const childOf = (parent: string, name: string) => until(async () => (await r.call(`/v1/agents`)).json.find((agent: any) => agent.parentAgentId === parent), `the child ${name}`);
  const childRun = (child: string) => until(async () => (await requests(r, child)).find(request => request.method === "prompt"), "the child's run");

  // interrupt_agent: the child's run ends aborted, and its notification says so.
  const parent = await lead(r);
  await r.prompt(parent, "spawn 1");
  const child = (await childOf(parent, "slow-1")).id;
  await until(async () => (await childRun(child)).began, "the child to begin");
  const interrupted = await r.prompt(parent, "interrupt it");
  assert.match(interrupted.outcome.result.reply, /"interrupted":true/);
  const [notice] = await ended(r, parent, "child_");
  assert.match(notice.outcome.result.reply, /status="aborted"/);

  // The parent's abort cascades; with children: "keep" it does not.
  for (const children of [undefined, "keep"]) {
    const other = await lead(r);
    await r.prompt(other, "spawn 2");
    const kid = (await childOf(other, "slow-2")).id;
    await until(async () => (await childRun(kid)).began, "the child to begin");
    assert.equal((await r.call(`/v1/agents/${other}/abort`, { body: children ? { children } : {} })).status, 200);
    await sleep(1_500);
    const run = await childRun(kid);
    if (children) assert.equal(run.state, "running", "kept running");
    else assert.equal((await until(async () => { const found = await childRun(kid); return found.state === "completed" && found; }, "the child's abort")).outcome.result.code, "aborted");
    // Deleting the parent deletes the child it made.
    assert.equal((await r.call(`/v1/agents/${other}`, { method: "DELETE" })).status, 200);
    await until(async () => (await r.call(`/v1/agents/${kid}`)).status === 404, "the child to be deleted");
  }
});

test("a browser token with the children scope reads its agent's sub-agents, and only theirs", async t => {
  const r = await runtime(t, body => systemText(body).includes("WORKER") ? { role: "assistant", content: "worked" }
    : last(body).role === "tool" || lastUser(body).startsWith("<agent_notification") ? { role: "assistant", content: "ok" } : toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "work" }));
  const parent = await lead(r);
  await r.prompt(parent, "go");
  await ended(r, parent, "child_");
  const child = (await r.call("/v1/agents")).json.find((agent: any) => agent.parentAgentId === parent).id;
  const stranger = (await r.call("/v1/agents", { body: {} })).json.id;
  const token = async (scopes?: string[]) => (await r.call(`/v1/agents/${parent}/browser-tokens`, { body: scopes ? { scopes } : {} })).json.token as string;
  const read = (agent: string, bearer: string, what = "history") => r.call(`/v1/agents/${agent}/${what}`, { token: bearer });
  const withChildren = await token(["history", "state", "children"]);
  assert.equal((await read(child, withChildren)).status, 200);
  assert.equal((await read(child, withChildren, "state")).status, 200);
  assert.equal((await read(child, withChildren, "inputs")).status, 403, "only the scopes it has");
  assert.equal((await read(stranger, withChildren)).status, 403, "not another agent");
  assert.equal((await read(parent, withChildren)).status, 200);
  assert.equal((await read(child, await token())).status, 403, "not without the children scope");
  assert.equal((await r.call(`/v1/agents/${parent}/browser-tokens`, { body: { scopes: ["children"] } })).status, 400);
});

test("a child that waits on a person notifies its parent, and notifies again when it resumes and ends", async t => {
  const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const r = await runtime(t, body => {
    const said = lastUser(body);
    if (systemText(body).includes("ASKER")) return last(body).role === "tool" ? { role: "assistant", content: `region ${JSON.parse(toolResults(body).at(-1)).answers["Which region?"]}` } : toolCall("ask_user", ASK, "call_ask");
    if (last(body).role === "tool") return { role: "assistant", content: "spawned" };
    if (said.startsWith("<agent_notification")) return { role: "assistant", content: `heard ${said}` };
    return toolCall("spawn_agent", { agent: "asker", task: "ask" }, "call_spawn");
  });
  const definition = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "asker" }, body: { name: "Asker", systemPrompt: "You are ASKER.", builtins: ["ask_user"] } });
  assert.equal(definition.status, 201, definition.text);
  const parent = (await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { agents: ["asker"] } } })).json.id;
  await r.prompt(parent, "go");
  const [first] = await ended(r, parent, "child_");
  assert.match(first.outcome.result.reply, /status="input_required"/);
  const child = (await r.call("/v1/agents")).json.find((agent: any) => agent.parentAgentId === parent).id;
  const [input] = (await r.call(`/v1/agents/${child}/inputs?state=pending`)).json;
  assert.equal((await r.call(`/v1/agents/${child}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } })).status, 202);
  const notices = await ended(r, parent, "child_", 2);
  assert.match(notices[1].outcome.result.reply, /status="completed">\nregion EU/);
});
