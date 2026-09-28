import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime, until, watchEvents } from "./runtime-server.ts";

const auth = { Authorization: `Bearer ${OPERATOR}` };

test("a prompt's requestId and metadata are kept on its user message and its request: in history, the stream and snapshots, never shown to the model", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: "ok", ...(index === 0 ? { delayMs: 1_500 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;
  const plain = await watchEvents(t, events, auth, { query: "" });

  const metadata = { source: "web", bubble: "b-1" };
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi", requestId: "bubble-1", metadata } });
  assert.deepEqual(accepted.json.metadata, metadata, "the request carries it too");
  assert.equal(accepted.status, 202, accepted.text);
  await until(() => r.model.bodies.length === 1, "the model call");
  const late = await watchEvents(t, events, auth, { query: "snapshot=1" });
  const snapshot = (await until(() => late.frames.find(frame => frame.data.type === "snapshot"), "a snapshot")).data;
  assert.deepEqual(snapshot.turn.messages.map((message: any) => [message.role, message.requestId, message.metadata]), [["user", "bubble-1", metadata]]);

  await until(() => plain.frames.some(frame => frame.data.type === "response" && frame.data.id === "bubble-1"), "the outcome");
  const ended = plain.frames.filter(frame => frame.data.type === "event" && frame.data.event.type === "message_end").map(frame => frame.data.event.message);
  assert.deepEqual([ended[0].role, ended[0].requestId, ended[0].metadata], ["user", "bubble-1", metadata]);
  assert.equal(ended[1].metadata, undefined, "only the user's message carries them");

  const whole = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual([whole[0].requestId, whole[0].metadata], ["bubble-1", metadata]);
  const page = (await r.call(`/v1/agents/${agent}/history?limit=10`)).json;
  assert.deepEqual([page.entries[0].message.requestId, page.entries[0].message.metadata], ["bubble-1", metadata]);
  assert.doesNotMatch(JSON.stringify(r.model.bodies[0].messages), /bubble/, "the model sees neither");

  // Without metadata, the message still names its request, generated or given.
  const next = await r.prompt(agent, "again");
  const messages = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual([messages[2].requestId, messages[2].metadata], [next.id, undefined]);

  const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]));
  for (const bad of [["a"], "text", { nested: { tab: 3 } }, { count: 3 }, many, { ["k".repeat(65)]: "v" }, { note: "x".repeat(513) }]) {
    const refused = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "no", metadata: bad } });
    assert.equal(refused.status, 400, JSON.stringify(bad).slice(0, 40));
    assert.match(refused.json.error, /metadata/);
  }
});

const byId = async (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) => (await r.call(`/v1/agents/${agent}/requests/${id}`)).json;
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));

test("whileRunning: steer hands a running turn the message; with no turn running it starts one; retries are idempotent", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).at(-1)}`, ...(index === 0 ? { delayMs: 1_500 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const first = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the turn's model call");
  const steer = { text: "also this", requestId: "steer-1", whileRunning: "steer", metadata: { via: "composer" } };
  const steered = await r.call(`/v1/agents/${agent}/prompt`, { body: steer });
  assert.equal(steered.status, 202, steered.text);
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: steer })).json.startedAt, steered.json.startedAt, "a retry returns the same request");
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { ...steer, text: "else" } })).status, 409);

  const done = await until(async () => { const record = await byId(r, agent, "steer-1"); return record.state === "completed" && record; }, "the steered request");
  const turn = await byId(r, agent, first.json.id);
  assert.equal(done.steeredInto, "turn-1");
  assert.deepEqual(done.outcome, turn.outcome, "it ends with the turn that took it");
  assert.equal(turn.outcome.result.reply, "answer 1: also this");
  assert.equal(r.model.bodies.length, 2, "the running turn answered it; no turn of its own");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => [message.role, message.requestId, message.metadata?.via]),
    [["user", "turn-1", undefined], ["assistant", undefined, undefined], ["user", "steer-1", "composer"], ["assistant", undefined, undefined]]);

  // Idle: it starts a turn, as a queued prompt would.
  const idle = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "idle now", requestId: "steer-2", whileRunning: "steer" } });
  assert.equal(idle.status, 202, idle.text);
  const own = await until(async () => { const record = await byId(r, agent, "steer-2"); return record.state === "completed" && record; }, "its own turn");
  assert.equal(own.steeredInto, undefined);
  assert.equal(own.outcome.result.reply, "answer 2: idle now");

  for (const bad of ["now", 1]) assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "x", whileRunning: bad } })).status, 400);
});

test("a steered message the running turn did not take (it was aborted) runs once, as a turn of its own", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).at(-1)}`, ...(index === 0 ? { delayMs: 3_000 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the turn's model call");
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "also this", requestId: "steer-1", whileRunning: "steer" } })).status, 202);
  assert.equal((await r.call(`/v1/agents/${agent}/abort`, { body: {} })).status, 200);
  const own = await until(async () => { const record = await byId(r, agent, "steer-1"); return record.state === "completed" && record; }, "the steered request");
  assert.equal(own.steeredInto, undefined);
  assert.equal(own.outcome.result.reply, "answer 1: also this");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(history.filter((message: any) => message.requestId === "steer-1").length, 1, "the message is recorded once");
});
