import { test } from "node:test";
import assert from "node:assert/strict";
import { Floor, mentions } from "../src/voice/turns/floor.ts";
import { AGENT, discordGrant, speak, until, voiceCluster } from "./voice-fakes.ts";

/** Floor control (src/voice/turns/floor.ts): which turns in a group call are the bot's. */

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

test("addressed: named, in a conversation, or alone; others are not the bot's", () => {
  let now = 0;
  const floor = new Floor({ mode: "addressed", names: ["camel"], conversationMs: 20_000 }, () => now);
  assert.deepEqual(floor.decide("bob", "what's for lunch", 3), { addressed: false, reason: "not_addressed" });
  assert.deepEqual(floor.decide("ada", "camel, what's the weather", 3), { addressed: true, reason: "named" });
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
  // Before its words are known: always, alone, or in a conversation; else only its words can say.
  assert.equal(always.standing("bob", 4), "always");
  assert.equal(floor.standing("bob", 1), "alone");
  assert.equal(floor.standing("bob", 3), "conversation");
  assert.equal(floor.standing("ada", 3), undefined);
});

test("in a session: only the bot's turns are answered; others go out as events, not addressed", { timeout: 60_000 }, async t => {
  const cluster = await voiceCluster(t);
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, deliver: { agent: AGENT }, addressing: { names: ["camel"] }, silenceMs: 200 });
  assert.deepEqual(created.addressing, { mode: "addressed", names: ["camel"], conversationMs: 20_000 });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.others = ["400000000000000001", "400000000000000002", "400000000000000003"];
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const model = await until(() => cluster.realtime.connections[0], "the model");
  const bob = "400000000000000002", ada = "400000000000000001";
  const turns: [string, string, boolean][] = [[bob, "what's for lunch", false], [ada, "hey camel, what should we order", true], [ada, "and to drink?", true], [bob, "I think so", false]];
  let answered = 0;
  for (const [index, [speaker, text, answers]] of turns.entries()) {
    speak(connection, speaker, 0.5);
    const commit = await until(() => model.of("commit")[index], `turn ${index + 1} committed`);
    model.events.heard(commit.tag, text, 0.5);
    await until(async () => (await cluster.events("voice.utterance")).length === index + 1, `utterance ${index + 1}`);
    if (!answers) continue;
    await until(() => model.responses === ++answered, `turn ${index + 1} answered`);
    await model.answer(`resp_${answered}`, { ms: 100 });
    await until(() => connection.played.length === answered && !connection.playing, `answer ${answered} played`);
  }
  const utterances = (await cluster.events("voice.utterance")).map(event => [event.data.text, event.data.addressed, event.data.addressedBy]);
  assert.deepEqual(utterances, [
    ["what's for lunch", false, "not_addressed"], ["hey camel, what should we order", true, "named"],
    ["and to drink?", true, "conversation"], ["I think so", false, "not_addressed"],
  ]);
  assert.equal(model.responses, 2, "Bob's turns were only heard");
});
