import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, memoryJournalStore } from "../clients/typescript.ts";
import { listen, OPERATOR, runtime, sleep, toolCall, until, watchEvents } from "./runtime-server.ts";

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

test("message_update carries its delta alone; a subscriber that asks gets a snapshot of the running turn where it cannot replay, and one that does not a replay gap", async t => {
  const words = Array.from({ length: 12 }, (_, index) => `w${index} `);
  const model = await streamingModel(t, words, 6);
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;
  const auth = { Authorization: `Bearer ${OPERATOR}` };

  const plain = await watchEvents(t, events, auth, { query: "" });
  const asking = await watchEvents(t, events, auth, { query: "snapshot=1" });
  // With nothing to replay from, a subscriber that asks starts from a snapshot: no turn runs yet.
  const idle = await until(() => asking.frames.find(frame => frame.data.type === "snapshot"), "the first snapshot");
  assert.equal(idle.data.turn, null);
  assert.equal(plain.frames.some(frame => frame.data.type === "snapshot"), false, "one that does not ask gets none");

  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go" } });
  const requestId = accepted.json.id;
  await until(() => deltaText(asking.frames) === words.slice(0, 6).join(""), "the first half to stream");

  // Mid-turn, a new subscriber, one behind the buffer, and a poll, each asking, get the turn so far, then what follows.
  const late = await watchEvents(t, events, auth, { query: "snapshot=1" });
  const behind = await watchEvents(t, events, auth, { query: "snapshot=1", cursor: 1 });
  const polled = await (await fetch(`${events}?poll=1&snapshot=1`, { headers: auth })).json() as any;
  assert.equal((await watchEvents(t, events, auth, { query: "", cursor: 1 })).status, 409, "without asking, a gap is a 409, as it always was");
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
  await until(() => [plain, asking, late, behind].every(watcher => done(watcher.frames)), "every subscriber to see the outcome");
  const final = plain.frames.find(frame => frame.data.type === "event" && frame.data.event.type === "message_end" && frame.data.event.message.role === "assistant")!.data.event.message;
  assert.equal(text(final).trim(), words.join("").trim());

  // No update carries the message it updates; folded from the start, or from a snapshot, they give the whole answer.
  for (const event of [...updates(plain.frames), ...updates(asking.frames)]) {
    assert.equal(event.message, undefined);
    assert.equal(event.assistantMessageEvent.partial, undefined);
    // Nothing is added: a toolcall_start is as Pi sent it, less the partial message.
    assert.deepEqual(Object.keys(event.assistantMessageEvent).filter(key => !["type", "contentIndex", "delta", "content", "toolCall", "reason"].includes(key)), []);
  }
  assert.equal(deltaText(plain.frames), text(final));
  for (const watcher of [late, behind]) {
    const snapshot = watcher.frames.find(frame => frame.data.type === "snapshot")!.data;
    assert.equal(text(snapshot.turn.partial) + deltaText(watcher.frames), text(final));
  }
  assert.ok(plain.frames.some(frame => frame.data.type === "event" && frame.data.event.type === "turn_opened" && frame.data.event.index === 0));

  // After the turn a snapshot has no turn.
  const after = await (await fetch(`${events}?poll=1&snapshot=1`, { headers: auth })).json() as any;
  assert.equal(after.events[0].data.turn, null);
});

test("the SDK's events carry no partial message, and it starts from a snapshot", async t => {
  const words = ["one ", "two ", "three"];
  const model = await streamingModel(t, words, words.length);
  model.release();
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const created = (await r.call("/v1/agents", { body: {} })).json;
  const seen: any[] = [];
  const agent = await new AgentRuntime({ url: r.base, apiKey: OPERATOR, journalStore: memoryJournalStore() })
    .connectAgent({ id: created.id, token: created.token, expiresAt: created.expiresAt }, { tools: {}, onEvent: event => { seen.push(event); } });
  t.after(() => agent.close());
  assert.equal((await agent.prompt("go")).reply, words.join(""));
  assert.equal(seen[0].type, "snapshot");
  assert.equal(seen[0].turn, null);
  const streamed = seen.filter(event => event.type === "message_update");
  assert.ok(streamed.length >= words.length);
  for (const event of streamed) assert.equal(event.message, undefined);
  assert.equal(streamed.filter(event => event.assistantMessageEvent.type === "text_delta").map(event => event.assistantMessageEvent.delta).join(""), words.join(""));
});

test("a snapshot too large for one frame drops the turn's finished messages first, keeping the message still streaming", async t => {
  const words = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")}${"y".repeat(9_998)}`);
  const model = await streamingModel(t, words, 15);
  // A model with a context large enough to take the prompt whole, without compacting.
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url, AGENT_MODEL: "openai/gpt-4.1-mini" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  // A 950 KB prompt and 150 KB streamed so far: together past a frame, apart each fits.
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "z".repeat(950_000) } })).status, 202);
  const watching = await watchEvents(t, events, auth, { query: "watch=1" });
  await until(() => deltaText(watching.frames).length >= 150_000, "half the answer to stream");
  const snapshot = (await (await fetch(`${events}?poll=1&snapshot=1`, { headers: auth })).json() as any).events[0].data;
  assert.equal(snapshot.turn.truncated, true);
  assert.deepEqual(snapshot.turn.messages, []);
  assert.equal(text(snapshot.turn.partial), words.slice(0, 15).join(""));
  model.release();
});

test("a tool call's updates are Pi's, less the message: toolcall_start adds nothing, toolcall_end carries the call", async t => {
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("js_exec", { code: "return 1" }) : { content: "done" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "" });
  const done = await r.prompt(agent, "go");
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === done.id), "the outcome");
  const calls = updates(watcher.frames).map(event => event.assistantMessageEvent).filter(delta => delta.type.startsWith("toolcall_"));
  assert.deepEqual(calls.find(delta => delta.type === "toolcall_start"), { type: "toolcall_start", contentIndex: 0 });
  assert.equal(calls.find(delta => delta.type === "toolcall_end").toolCall.name, "js_exec");
  for (const delta of updates(watcher.frames).map(event => event.assistantMessageEvent)) assert.equal(delta.partial ?? delta.message ?? delta.error, undefined);
});
