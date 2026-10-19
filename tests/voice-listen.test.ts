import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import { AGENT, discordGrant, sleep, speak, until, voiceCluster } from "./voice-fakes.ts";

/**
 * Listening sessions (brain listen): muted, each utterance transcribed after it is cut and sent as voice.utterance,
 * nothing answering. No realtime model is opened for them.
 */

const ANA = "400000000000000001";

test("a listening session joins muted, takes none of answering's settings, and needs a transcriber and its key", async t => {
  const { node, transcription } = await voiceCluster(t);
  const a = await node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, brain: "listen", language: "en", prompt: "camelRun" });
  assert.equal(created.brain, "listen");
  assert.deepEqual(created.join, { self_mute: true, self_deaf: false }, "nothing speaks: its app joins muted");
  assert.equal(created.notice.text, `<@${grant.userId}> is listening and transcribing speech in this channel. Audio is not stored.`);
  assert.equal(created.realtime, undefined);
  assert.equal(created.voice, undefined);
  assert.equal(created.interruption, undefined);

  const refused = async (input: Record<string, unknown>, pattern: RegExp) =>
    assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "listen", ...input }), (error: HttpError) => error.status === 400 && pattern.test(error.message), JSON.stringify(input));
  for (const answering of [{ speak: true }, { bargeIn: false }, { voice: "coral" }, { realtime: {} }, { speakers: { [ANA]: "Ana" } }, { addressing: { names: ["camel"] } }]) {
    await refused(answering, /a listening session only transcribes/);
  }
  await refused({ deliver: { agent: AGENT } }, /deliver.agent is for a session that answers/);
  await refused({ deliver: { webhooks: false } }, /leave deliver.webhooks on/);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "cascade" }), (error: HttpError) => error.status === 400 && /realtime \(the default\) or listen/.test(error.message));
  assert.equal(transcription.calls.length, 0);

  const without = await voiceCluster(t, { transcriber: undefined });
  const b = await without.node("http://b");
  await assert.rejects(b.voice.create("alice", { discord: discordGrant(), brain: "listen" }), (error: HttpError) => error.status === 404 && /brain listen/.test(error.message));
});

test("what people say in a listening session is transcribed, billed to its subject and sent as voice.utterance; nothing answers", async t => {
  const { node, fake, realtime, transcription, usage, events } = await voiceCluster(t);
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), brain: "listen", subject: "user-1", silenceMs: 200, language: "en", prompt: "camelRun" });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = [ANA];
  connection.handlers.ready();
  speak(connection, ANA, 0.6);
  const [utterance] = await until(async () => { const found = await events("voice.utterance"); return found.length ? found : undefined; }, "the utterance");
  assert.equal(utterance.data.brain, "listen");
  assert.equal(utterance.data.speakerId, ANA);
  assert.equal(utterance.data.seq, 1);
  assert.match(utterance.data.text, /^heard \d\.\d seconds$/);
  assert.equal(utterance.data.language, "en");
  assert.equal(utterance.data.addressed, undefined, "no bot, so no addressing");
  assert.ok(utterance.data.costUsd > 0);
  assert.deepEqual(transcription.calls[0].options, { language: "en", prompt: "camelRun" });
  assert.equal(transcription.calls[0].header.format, "ogg", "the cut, packed as Ogg Opus");
  const record = usage.find(entry => entry.usage.kind === "transcription");
  assert.ok(record, "its transcription is recorded");
  assert.equal(record.usage.identity?.subject, "user-1");
  assert.equal((record.usage.identity?.context as Record<string, unknown>).voiceSession, created.id);
  const session = await until(async () => { const found = await a.voice.get("alice", created.id); return found.utterances === 1 ? found : undefined; }, "counted");
  assert.ok(session.costUsd > 0 && session.lastSpeechAt);

  assert.equal(realtime.connections.length, 0, "no realtime model is opened");
  assert.equal(connection.played.length, 0, "and nothing plays");
  assert.equal((await events("voice.speech.started")).length, 0);
  await assert.rejects(a.voice.stopSpeaking("alice", created.id), (error: HttpError) => error.status === 409 && error.code === "VOICE_SPEAK_DISABLED");
});

test("a listening session whose tenant may not spend ends (budget) at its next utterance, without transcribing it", async t => {
  let spent = false;
  const { node, fake, transcription, events } = await voiceCluster(t, { admit: async () => { if (spent) throw new HttpError(402, "spent", "SPEND_LIMIT"); } });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), brain: "listen", silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = [ANA];
  connection.handlers.ready();
  spent = true;
  speak(connection, ANA, 0.6);
  const [ended] = await until(async () => { const found = await events("voice.session.ended"); return found.length ? found : undefined; }, "the end");
  assert.deepEqual([ended.data.reason, ended.data.limit], ["budget", "tenant"]);
  await sleep(50);
  assert.equal(transcription.calls.length, 0);
  assert.equal((await a.voice.get("alice", created.id)).state, "ended");
});
