import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, memoryJournalStore } from "../clients/typescript.ts";
import { listen, OPERATOR, runtime, sleep, until, watchEvents } from "./runtime-server.ts";

/** A model that streams its answer a word at a time, holding the rest back until `release`. */
async function streamingModel(t: { after(fn: () => Promise<void> | void): void }, words: string[], holdAfter: number) {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const url = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the request body */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    for (const [index, word] of words.entries()) {
      if (index === holdAfter) await gate.promise;
      chunk({ content: word });
      await sleep(5);
    }
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, release: () => gate.resolve() };
}

const text = (message: any) => message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") ?? "";
const updates = (frames: { data: any }[]) => frames.filter(frame => frame.data.type === "event" && frame.data.event.type === "message_update").map(frame => frame.data.event);
const deltaText = (frames: { data: any }[]) => updates(frames).filter(event => event.assistantMessageEvent.type === "text_delta").map(event => event.assistantMessageEvent.delta).join("");

test("subscribers that ask for deltas get message_update without the partial message, and a snapshot of the running turn where they cannot replay", async t => {
  const words = Array.from({ length: 12 }, (_, index) => `w${index} `);
  const model = await streamingModel(t, words, 6);
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;
  const auth = { Authorization: `Bearer ${OPERATOR}` };

  const legacy = await watchEvents(t, events, auth, { query: "" });
  const deltas = await watchEvents(t, events, auth, { query: "deltas=1" });
  // With nothing to replay from, a deltas subscriber starts from a snapshot: no turn runs yet.
  const idle = await until(() => deltas.frames.find(frame => frame.data.type === "snapshot"), "the first snapshot");
  assert.equal(idle.data.turn, null);
  assert.equal(deltas.frames[0].data.deltas, true);

  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go" } });
  const requestId = accepted.json.id;
  await until(() => deltaText(deltas.frames) === words.slice(0, 6).join(""), "the first half to stream");

  // Mid-turn, a new deltas subscriber, one behind the buffer, and a poll each get the turn so far, then what follows.
  const late = await watchEvents(t, events, auth, { query: "deltas=1" });
  const behind = await watchEvents(t, events, auth, { query: "deltas=1", cursor: 1 });
  const polled = await (await fetch(`${events}?poll=1&deltas=1`, { headers: auth })).json() as any;
  assert.equal((await watchEvents(t, events, auth, { query: "", cursor: 1 })).status, 409, "without deltas, a gap is still a 409");
  for (const watcher of [late, behind]) {
    const snapshot = (await until(() => watcher.frames.find(frame => frame.data.type === "snapshot"), "a snapshot")).data;
    assert.equal(snapshot.requestId, requestId);
    assert.equal(snapshot.turn.start, 0, "the turn's first message is the agent's first");
    assert.deepEqual(snapshot.turn.messages.map((message: any) => message.role), ["user"]);
    assert.equal(text(snapshot.turn.partial), words.slice(0, 6).join(""));
  }
  assert.equal(polled.events[0].data.type, "snapshot");
  assert.equal(text(polled.events[0].data.turn.partial), words.slice(0, 6).join(""));

  model.release();
  const done = (frames: { data: any }[]) => frames.some(frame => frame.data.type === "response" && frame.data.id === requestId);
  await until(() => [legacy, deltas, late, behind].every(watcher => done(watcher.frames)), "every subscriber to see the outcome");
  const answer = words.join("");
  const final = legacy.frames.find(frame => frame.data.type === "event" && frame.data.event.type === "message_end" && frame.data.event.message.role === "assistant")!.data.event.message;
  assert.equal(text(final).trim(), answer.trim());

  // Deltas carry no partial message; folded from the start, or from a snapshot, they give the whole answer.
  for (const event of updates(deltas.frames)) {
    assert.equal(event.message, undefined);
    assert.equal(event.assistantMessageEvent.partial, undefined);
  }
  assert.equal(deltaText(deltas.frames), text(final));
  for (const watcher of [late, behind]) {
    const snapshot = watcher.frames.find(frame => frame.data.type === "snapshot")!.data;
    assert.equal(text(snapshot.turn.partial) + deltaText(watcher.frames), text(final));
  }
  // Without deltas, each update is as Pi sent it: the message so far, twice.
  const whole = updates(legacy.frames).filter(event => event.assistantMessageEvent.type === "text_delta");
  assert.equal(whole.length, updates(deltas.frames).filter(event => event.assistantMessageEvent.type === "text_delta").length);
  let sofar = "";
  for (const event of whole) {
    sofar += event.assistantMessageEvent.delta;
    assert.equal(text(event.message), sofar);
    assert.equal(text(event.assistantMessageEvent.partial), sofar);
  }
  const bytes = (frames: { data: any }[]) => updates(frames).reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  assert.ok(bytes(deltas.frames) * 3 < bytes(legacy.frames), "deltas are a fraction of the whole updates");
  assert.ok(legacy.frames.some(frame => frame.data.type === "event" && frame.data.event.type === "turn_opened" && frame.data.event.index === 0));

  // Replayed without deltas, an update carries its message as it ended.
  const replayed = await (await fetch(`${events}?poll=1`, { headers: { ...auth, "Last-Event-ID": String(legacy.frames.find(frame => frame.id)!.id! - 1) } })).json() as any;
  const replayedUpdates = replayed.events.filter((event: any) => event.data.type === "event" && event.data.event.type === "message_update");
  assert.ok(replayedUpdates.length > 0);
  for (const event of replayedUpdates) assert.equal(text(event.data.event.message), text(final));

  // After the turn a snapshot has no turn.
  const after = await (await fetch(`${events}?poll=1&deltas=1`, { headers: auth })).json() as any;
  assert.equal(after.events[0].data.turn, null);
});

test("the SDK streams deltas when asked: its events carry no partial message, and it starts from a snapshot", async t => {
  const words = ["one ", "two ", "three"];
  const model = await streamingModel(t, words, words.length);
  model.release();
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const created = (await r.call("/v1/agents", { body: {} })).json;
  const seen: any[] = [];
  const agent = await new AgentRuntime({ url: r.base, apiKey: OPERATOR, journalStore: memoryJournalStore() })
    .connectAgent({ id: created.id, token: created.token, expiresAt: created.expiresAt }, { tools: {}, deltas: true, onEvent: event => { seen.push(event); } });
  t.after(() => agent.close());
  assert.equal((await agent.prompt("go")).reply, words.join(""));
  assert.equal(seen[0].type, "snapshot");
  assert.equal(seen[0].turn, null);
  const streamed = seen.filter(event => event.type === "message_update");
  assert.ok(streamed.length >= words.length);
  for (const event of streamed) assert.equal(event.message, undefined);
  assert.equal(streamed.filter(event => event.assistantMessageEvent.type === "text_delta").map(event => event.assistantMessageEvent.delta).join(""), words.join(""));
});

test("a legacy subscriber whose replay would re-expand past the buffer's size gets a replay gap, not a cut connection", async t => {
  // 150 updates of a 30 KB answer: re-expanded, each carries the whole message twice.
  const words = Array.from({ length: 150 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(197)}`);
  const model = await streamingModel(t, words, words.length);
  model.release();
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const first = (await r.call(`/v1/agents/${agent}/state`)).json.cursor;
  await r.prompt(agent, "go");
  const legacy = await watchEvents(t, events, auth, { query: "", cursor: first });
  assert.equal(legacy.status, 409, "the old invariant: a replay larger than the buffer is a gap to recover from history");
  const poll = await fetch(`${events}?poll=1`, { headers: { ...auth, "Last-Event-ID": String(first) } });
  assert.equal(poll.status, 409);
  await poll.body?.cancel();
  // A replay that fits is still sent whole, ready frame first.
  const last = (await r.call(`/v1/agents/${agent}/state`)).json.cursor;
  const small = await watchEvents(t, events, auth, { query: "", cursor: last - 2 });
  assert.equal(small.status, 200);
  await until(() => small.frames.length === 3, "the ready frame and two replayed events");
  // With deltas the same replay is small and whole.
  const deltas = await (await fetch(`${events}?poll=1&deltas=1`, { headers: { ...auth, "Last-Event-ID": String(first) } })).json() as any;
  assert.ok(deltas.events.length > 150);
});
