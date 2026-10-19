import { test } from "node:test";
import assert from "node:assert/strict";
import { Floor, mentions, withContext } from "../src/voice/turns/floor.ts";
import { AGENT, discordGrant, fakeTranscriber, sleep, speak, until, voiceCluster } from "./voice-fakes.ts";

/** Floor control (src/voice/turns/floor.ts): which turns in a group call are the bot's, and one reply at a time. */

test("names are heard as speech recognition writes them", () => {
  assert.ok(mentions("Hey Camel, what's the weather?", ["camel"]));
  assert.ok(mentions("camel's turn now", ["camel"]));
  assert.ok(mentions("ok jarvys can you", ["jarvis"]), "a near miss of a 5+ letter name");
  assert.ok(mentions("hey professor oak what's up", ["Professor Oak"]), "a phrase");
  assert.ok(mentions("Hola, Camila", ["camila"]));
  assert.ok(mentions("ねえキャメル、教えて", ["キャメル"]), "no spaces");
  assert.ok(!mentions("the camera is broken", ["camel"]), "a short name must be the word");
  assert.ok(!mentions("my dog max", ["jarvis"]));
  assert.ok(!mentions("anything", []));
});

test("addressed: named, in a conversation, or alone; others overheard and passed on as context", () => {
  let now = 0;
  const floor = new Floor({ mode: "addressed", names: ["camel"], conversationMs: 20_000 }, () => now);
  assert.deepEqual(floor.decide("bob", "what's for lunch", 3), { addressed: false, reason: "not_addressed" });
  floor.overheard("bob", "what's for lunch");
  assert.deepEqual(floor.decide("ada", "camel, what's the weather", 3), { addressed: true, reason: "named" });
  assert.deepEqual(floor.takeContext().map(turn => turn.text), ["what's for lunch"]);
  now += 5_000;
  assert.deepEqual(floor.decide("ada", "and tomorrow?", 3), { addressed: true, reason: "conversation" });
  assert.deepEqual(floor.decide("bob", "I think so", 3), { addressed: false, reason: "not_addressed" }, "bob is not in the conversation");
  // Bob names it: the bot talks with bob now, and ada must name it again.
  assert.equal(floor.decide("bob", "camel, settle this", 3).reason, "named");
  assert.equal(floor.decide("ada", "no wait", 3).addressed, false);
  now += 30_000;
  assert.equal(floor.decide("bob", "so?", 3).addressed, false, "the conversation lapsed");
  assert.equal(floor.decide("bob", "so?", 1).reason, "alone");
  const always = new Floor({}, () => now);
  assert.equal(always.decide("bob", "anything", 4).reason, "always");
  assert.equal(withContext("hi", []), "hi");
  assert.match(withContext("camel, and you?", [{ speaker: "1", text: "pizza" }]), /<@1>: pizza\n\[To you\]\ncamel, and you\?$/);
});

test("in a session: only the bot's turns prompt the agent, with what was said around them", { timeout: 60_000 }, async t => {
  const texts = ["what's for lunch", "hey camel, what should we order", "and to drink?", "I think so"];
  const transcriber = fakeTranscriber(({ index }) => texts[index]);
  const cluster = await voiceCluster(t, { transcriber: transcriber.transcriber });
  const a = { ...cluster, n: await cluster.node("http://a") };
  const grant = discordGrant();
  const created = await a.n.voice.create("alice", { discord: grant, deliver: { agent: AGENT }, addressing: { names: ["camel"] }, silenceMs: 200 });
  assert.deepEqual(created.addressing, { mode: "addressed", names: ["camel"], conversationMs: 20_000, contextTurns: 8, contextMs: 120_000 });
  const connection = await until(() => a.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.others = ["400000000000000001", "400000000000000002", "400000000000000003"];
  connection.handlers.ready();
  await until(async () => (await a.n.voice.get("alice", created.id)).state === "live", "live");
  const bob = "400000000000000002", ada = "400000000000000001";
  for (const [index, speaker] of [bob, ada, ada, bob].entries()) {
    speak(connection, speaker, 0.5);
    await until(async () => (await a.events("voice.utterance")).length === index + 1, `utterance ${index + 1}`);
  }
  const utterances = (await a.events("voice.utterance")).map(event => [event.data.text, event.data.addressed, event.data.addressedBy]);
  assert.deepEqual(utterances, [
    ["what's for lunch", false, "not_addressed"], ["hey camel, what should we order", true, "named"],
    ["and to drink?", true, "conversation"], ["I think so", false, "not_addressed"],
  ]);
  await sleep(100);
  assert.deepEqual(a.prompts.map(prompt => prompt.request.params.text), [
    `[Said in the call before this, not to you]\n<@${bob}>: what's for lunch\n[To you]\nhey camel, what should we order`,
    "and to drink?",
  ]);
  assert.equal((a.prompts[0].request.params.metadata as Record<string, string>).addressedBy, "named");
});

test("one reply at a time: a newer turn's reply supersedes one not yet heard", { timeout: 60_000 }, async t => {
  const transcriber = fakeTranscriber(({ index }) => ["first question", "and a second thing"][index] ?? "more");
  // The agent writes slowly: the first reply is not heard before the second turn comes.
  const submitStreaming = async function* (_agent: string, _tenant: string, request: { id: string }, signal: AbortSignal) {
    await sleep(request.id.endsWith("_1") ? 1_500 : 50);
    if (signal.aborted) return;
    yield `Answer to ${request.id.slice(-1)}.`;
  };
  const cluster = await voiceCluster(t, { transcriber: transcriber.transcriber, submitStreaming, playEveryMs: 5 });
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, deliver: { agent: AGENT }, speak: { agentReplies: true }, silenceMs: 200 });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  speak(connection, "400000000000000001", 0.5);
  await until(async () => (await cluster.events("voice.utterance")).length === 1, "first");
  speak(connection, "400000000000000001", 0.5);
  await until(async () => (await cluster.events("voice.speech.ended")).some(event => event.data.reason === "done"), "a reply spoken", 10_000);
  await sleep(1_800);
  const started = (await cluster.events("voice.speech.started")).map(event => event.data.text ?? event.data.reply?.requestId);
  assert.equal(started.length, 1, `one reply heard (${JSON.stringify(started)})`);
  const ended = await cluster.events("voice.speech.ended");
  assert.ok(ended.every(event => event.data.reply?.requestId?.endsWith("_2") || event.data.reason !== "done"), "the first reply was not said");
});
