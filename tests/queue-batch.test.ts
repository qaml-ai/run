import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, until } from "./runtime-server.ts";

const byId = async (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) => (await r.call(`/v1/agents/${agent}/requests/${id}`)).json;
const ended = (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) => until(async () => { const record = await byId(r, agent, id); return record.state === "completed" && record; }, `${id} to end`);
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));
/** A model that answers with every user message of the request, the first call slowly so that prompts queue behind it. */
const echo = (slowMs = 1_500) => (body: any, index: number) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}`, ...(index === 0 ? { delayMs: slowMs } : {}) });

test("an agent whose queue batches runs the prompts that waited behind a turn as one turn, each its own message in order", async t => {
  const r = await runtime(t, echo());
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  assert.deepEqual((await r.call(`/v1/agents/${agent}`)).json.queue, { mode: "batch" });
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  for (const [index, text] of ["a", "b", "c"].entries()) {
    const queued = await r.call(`/v1/agents/${agent}/prompt`, { body: { text, requestId: `burst-${index}`, metadata: { n: String(index) } } });
    assert.equal(queued.status, 202, queued.text);
  }
  const lead = await ended(r, agent, "burst-0");
  assert.deepEqual(lead.batch, ["burst-1", "burst-2"]);
  assert.equal(lead.outcome.result.reply, "answer 1: first + a + b + c", "one model call read the three");
  assert.equal(lead.outcome.result.usage.responses, 1);
  for (const id of ["burst-1", "burst-2"]) {
    const member = await ended(r, agent, id);
    // It ends with the turn, with the turn's answer, naming its first prompt; the turn's usage is that prompt's alone.
    assert.equal(member.batchedInto, "burst-0");
    assert.equal(member.outcome.result.batchedInto, "burst-0");
    assert.equal(member.outcome.result.reply, lead.outcome.result.reply);
    assert.equal(member.outcome.result.usage, undefined);
    assert.equal(member.status, "completed");
  }
  await ended(r, agent, "turn-1");
  assert.equal(r.model.bodies.length, 2, "two turns for four prompts");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => [message.role, message.requestId, message.metadata?.n]), [
    ["user", "turn-1", undefined], ["assistant", undefined, undefined],
    ["user", "burst-0", "0"], ["user", "burst-1", "1"], ["user", "burst-2", "2"], ["assistant", undefined, undefined],
  ]);

  // A retry of a merged request is the same request: answered with its record, never run again.
  const again = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "b", requestId: "burst-1", metadata: { n: "1" } } });
  assert.ok([200, 202].includes(again.status), again.text);
  assert.equal(again.json.batchedInto, "burst-0");
  assert.equal(again.json.endedAt, (await byId(r, agent, "burst-1")).endedAt);
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "else", requestId: "burst-1" } })).status, 409);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(r.model.bodies.length, 2, "the retry started nothing");
  // Charged once: the usage counts two model responses for the four prompts.
  await until(async () => Number((await r.call("/v1/usage")).json.totals?.responses) === 2, "the usage of two responses");
});

test("a batch ends at the first prompt that cannot join it: one with limits of its own, or for another actor", async t => {
  const r = await runtime(t, echo());
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  const send = (requestId: string, extra: Record<string, unknown> = {}) => r.call(`/v1/agents/${agent}/prompt`, { body: { text: requestId, requestId, ...extra } });
  await send("p1");
  await send("p2");
  await send("limited", { runLimits: { maxResponses: 5 } });
  await send("p3", { actor: "alice" });
  await send("p4", { actor: "alice" });
  await send("p5", { actor: "bob" });
  for (const id of ["p1", "limited", "p3", "p5"]) assert.equal((await ended(r, agent, id)).batchedInto, undefined, `${id} leads a turn`);
  assert.equal((await ended(r, agent, "p2")).batchedInto, "p1");
  assert.equal((await ended(r, agent, "p4")).batchedInto, "p3");
  assert.deepEqual(r.model.bodies.slice(1).map(body => userTexts(body).slice(1).join(",")), ["p1,p2", "p1,p2,limited", "p1,p2,limited,p3,p4", "p1,p2,limited,p3,p4,p5"]);
});

test("with a window, a burst that reaches an idle agent merges too; without batching, each prompt is its own turn", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}` }));
  const windowed = (await r.call("/v1/agents", { body: { queue: { mode: "batch", windowMs: 1_000 } } })).json.id as string;
  for (const text of ["x", "y", "z"]) await r.call(`/v1/agents/${windowed}/prompt`, { body: { text, requestId: `w-${text}` } });
  for (const text of ["x", "y"]) await ended(r, windowed, `w-${text}`);
  // At most two turns for the three, the last of them merged (on Workers the window's first prompt runs alone).
  assert.notEqual((await ended(r, windowed, "w-z")).batchedInto, undefined);
  const turns = r.model.bodies.length;
  assert.ok(turns <= 2, `${turns} turns`);
  const said = (await r.call(`/v1/agents/${windowed}/history`)).json.messages.filter((message: any) => message.role === "user").map((message: any) => message.requestId);
  assert.deepEqual(said, ["w-x", "w-y", "w-z"]);

  // The default: one turn per prompt, as before.
  const plain = (await r.call("/v1/agents", { body: {} })).json.id as string;
  assert.equal((await r.call(`/v1/agents/${plain}`)).json.queue, null);
  for (const text of ["x", "y", "z"]) await r.call(`/v1/agents/${plain}/prompt`, { body: { text, requestId: `p-${text}` } });
  for (const text of ["x", "y", "z"]) assert.equal((await ended(r, plain, `p-${text}`)).batchedInto, undefined);
  assert.equal(r.model.bodies.length, turns + 3);

  // Turned off again, and refused when malformed.
  assert.equal((await r.call(`/v1/agents/${windowed}/configuration`, { method: "PATCH", body: { queue: null } })).status, 202);
  await until(async () => (await r.call(`/v1/agents/${windowed}`)).json.queue === null, "the queue setting to go");
  for (const bad of [{ mode: "all" }, { mode: "batch", windowMs: 5_000 }, { mode: "each", windowMs: 10 }, "batch"]) {
    assert.equal((await r.call("/v1/agents", { body: { queue: bad } })).status, 400, JSON.stringify(bad));
  }
});

test("a stop cancels the prompts waiting to be batched; with queued: keep they run after it, as one turn", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).at(-1)}`, ...(userTexts(body).at(-1)?.startsWith("slow") ? { delayMs: 3_000 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "slow one", requestId: "s-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  for (const id of ["q-1", "q-2"]) await r.call(`/v1/agents/${agent}/prompt`, { body: { text: id, requestId: id } });
  const stopped = await r.call(`/v1/agents/${agent}/abort`, { body: {} });
  assert.equal(stopped.status, 200, stopped.text);
  assert.deepEqual([...stopped.json.cancelled].sort(), ["q-1", "q-2"]);
  for (const id of ["q-1", "q-2"]) assert.equal((await ended(r, agent, id)).outcome.result.code, "cancelled");

  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "slow two", requestId: "s-2" } });
  await until(() => r.model.bodies.length === 2, "the second turn's model call");
  for (const id of ["k-1", "k-2"]) await r.call(`/v1/agents/${agent}/prompt`, { body: { text: id, requestId: id } });
  assert.equal((await r.call(`/v1/agents/${agent}/abort`, { body: { queued: "keep" } })).status, 200);
  assert.equal((await ended(r, agent, "k-2")).batchedInto, "k-1");
  const lead = await ended(r, agent, "k-1");
  assert.deepEqual(lead.batch, ["k-2"]);
  assert.equal(lead.outcome.result.reply, "answer 2: k-2");
  assert.equal(r.model.bodies.length, 3);
});

test("with a window, a burst that reaches an idle agent is one turn", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}` }));
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch", windowMs: 1_000 } } })).json.id as string;
  for (const text of ["x", "y", "z"]) await r.call(`/v1/agents/${agent}/prompt`, { body: { text, requestId: `w-${text}` } });
  const lead = await ended(r, agent, "w-x");
  assert.equal(lead.outcome.result.reply, "answer 0: x + y + z");
  assert.deepEqual(lead.batch, ["w-y", "w-z"]);
  assert.equal(r.model.bodies.length, 1);
});

test("on an agent whose queue batches, the steers waiting at a step's end are read together there", async t => {
  const r = await runtime(t, (body, index) => index === 0
    ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "missing.txt" }) } }], delayMs: 1_500 }
    : { role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}` });
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first model call");
  for (const text of ["also a", "also b"]) assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text, requestId: text.replace(" ", "-"), whileRunning: "steer" } })).json.steer, "accepted");
  const turn = await ended(r, agent, "turn-1");
  assert.equal(turn.outcome.result.reply, "answer 1: first + also a + also b", "one response read both steers");
  assert.equal(r.model.bodies.length, 2);
});

test("each prompt of a batch reaches the model with its own sender", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}`, ...(index === 0 ? { delayMs: 1_500 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  // One actor (a channel acting for its owner), three people, each in their own thread.
  for (const [index, name] of ["Ann", "Bob", "Cid"].entries())
    await r.call(`/v1/agents/${agent}/prompt`, { body: { text: `message from ${name}`, requestId: `m-${index}`, actor: "channel-owner", from: { id: `u-${name}`, name, thread: `thread-${name}` } } });
  const lead = await ended(r, agent, "m-0");
  assert.deepEqual(lead.batch, ["m-1", "m-2"]);
  const users = r.model.bodies[1].messages.filter((message: any) => message.role === "user").slice(1).map(text);
  console.log(JSON.stringify({ type: "review_batch_users", users }));
  for (const [index, name] of ["Ann", "Bob", "Cid"].entries()) {
    assert.match(users[index], new RegExp(`message from ${name}`));
    assert.match(users[index], new RegExp(`thread-${name}`), `message ${index} rendered with its own sender: ${users[index]}`);
  }
});

test("a parent's delegate call to a named agent whose queue batches gets that agent's answer", async t => {
  const system = (body: any) => JSON.stringify(body.messages.filter((message: any) => message.role === "system" || message.role === "developer"));
  const users = (body: any) => body.messages.filter((message: any) => message.role === "user").map(text);
  const tools = (body: any) => body.messages.filter((message: any) => message.role === "tool").map(text);
  const r = await runtime(t, body => {
    if (system(body).includes("You are SPEC")) {
      const said = users(body).at(-1) ?? "";
      return { role: "assistant", content: `spec read: ${users(body).slice(1).join(" + ")}`, ...(said.includes("slow") ? { delayMs: 4_000 } : {}) };
    }
    if (body.messages.at(-1).role === "tool") return { role: "assistant", content: `parent got: ${tools(body).at(-1)}` };
    return { role: "assistant", tool_calls: [{ index: 0, id: "call_delegate", type: "function", function: { name: "delegate", arguments: JSON.stringify({ agent: "spec", task: "what is 2+2" }) } }] };
  });
  const spec = (await r.call("/v1/agents", { headers: { "Idempotency-Key": "spec" }, body: { systemPrompt: "You are SPEC.", queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${spec}/prompt`, { body: { text: "slow warm-up", requestId: "warm" } });
  await until(() => r.model.bodies.length === 1, "the specialist's first turn");
  await r.call(`/v1/agents/${spec}/prompt`, { body: { text: "an API question", requestId: "api-q" } });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { agents: [{ agent: "spec" }] } } })).json.id as string;
  await r.call(`/v1/agents/${parent}/prompt`, { body: { text: "go", requestId: "parent-go" } });
  const done = await ended(r, parent, "parent-go");
  const specRequests = (await r.call(`/v1/agents/${spec}`)).json.requests.map((request: any) => ({ id: request.id, batchedInto: request.batchedInto, batch: request.batch }));
  console.log(JSON.stringify({ type: "review_delegate", reply: done.outcome.result.reply, specRequests }));
  assert.match(done.outcome.result.reply, /spec read: .*what is 2\+2/, "the delegate call carries the specialist's answer");
});
