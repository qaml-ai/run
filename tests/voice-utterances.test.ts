import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import { checkedAudio } from "../src/transcription.ts";
import { Opus } from "../src/opus.ts";
import { oggOpus, packetLevel, packetSamples, Segmenter, type Cut } from "../src/voice-audio.ts";
import { AGENT, discordGrant, fakeTranscriber, opusPacket, quietPacket, sleep, speak, speechPacket, until, voiceCluster } from "./voice-fakes.ts";

/** The packets of an Ogg file, page by page (lacing values joined), without OpusHead and OpusTags. */
function oggPackets(file: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let pending: Buffer[] = [];
  for (let offset = 0; offset < file.length;) {
    assert.equal(file.toString("ascii", offset, offset + 4), "OggS");
    const segments = file[offset + 26];
    let data = offset + 27 + segments;
    for (const size of file.subarray(offset + 27, offset + 27 + segments)) {
      pending.push(file.subarray(data, data + size));
      data += size;
      if (size < 255) { packets.push(Buffer.concat(pending)); pending = []; }
    }
    offset = data;
  }
  return packets.slice(2);
}

test("Opus packets become Ogg Opus as they are: transcription reads its length, and the packets come back out", () => {
  assert.equal(packetSamples(opusPacket()), 960, "20 ms at 48 kHz");
  assert.equal(packetSamples(Uint8Array.from([0xfc, 1])), 960, "CELT 20 ms");
  assert.equal(packetSamples(Uint8Array.from([0x7b, 0x03])), 2880, "three 20 ms frames (code 3)");
  const packets = Array.from({ length: 130 }, (_, index) => Uint8Array.from([0x78, ...Array.from({ length: 300 + index }, () => index)]));
  const file = oggOpus(packets);
  const header = checkedAudio(file);
  assert.equal(header.format, "ogg");
  assert.equal(header.seconds, 2.6);
  assert.deepEqual(oggPackets(file).map(packet => [...packet]), packets.map(packet => [...packet]), "packets longer than 255 bytes span lacing values intact");
});

test("each speaker's packets are cut into utterances: at a silence, at the longest length, when their stream breaks or on a flush", async () => {
  const cuts: Cut[] = [];
  const segmenter = new Segmenter({ silenceMs: 80, maxMs: 1_000, minMs: 300, cut: cut => cuts.push(cut) });
  const send = (speaker: string, count: number) => { for (let index = 0; index < count; index++) segmenter.packet(speaker, speechPacket(index)); };
  send("ada", 20);
  // Discord's silence frames are not speech.
  segmenter.packet("ada", Uint8Array.from([0xf8, 0xff, 0xfe]));
  send("bob", 10);
  await sleep(200);
  // Bob's 200 ms is under the 300 ms an utterance needs.
  assert.deepEqual(cuts.map(cut => [cut.speaker, cut.seconds, cut.packets.length, cut.ended]), [["ada", 0.4, 20, "silence"]]);
  cuts.length = 0;
  // 1.4 s without a pause: cut at 1 s, the rest its own utterance.
  send("ada", 70);
  assert.deepEqual(cuts.map(cut => [cut.seconds, cut.ended]), [[1, "max"]]);
  await sleep(200);
  assert.deepEqual(cuts.map(cut => [cut.seconds, cut.ended]), [[1, "max"], [0.4, "silence"]]);
  cuts.length = 0;
  send("ada", 20);
  segmenter.broken("ada");
  send("bob", 30);
  send("cy", 30);
  assert.equal(segmenter.open, 2);
  segmenter.flush("handoff");
  assert.equal(segmenter.open, 0);
  assert.deepEqual(cuts.map(cut => [cut.speaker, cut.ended]), [["ada", "error"], ["bob", "handoff"], ["cy", "handoff"]]);
  assert.ok(cuts.every(cut => cut.endedAt >= cut.startedAt + cut.seconds * 1000 - 1));
  await sleep(150);
  assert.equal(cuts.length, 3, "nothing fires after a flush");
});

test("a sender that never stops is cut at its quiet packets, and quiet past the padding is neither sent nor billed", () => {
  const cuts: Cut[] = [];
  const segmenter = new Segmenter({ silenceMs: 400, minMs: 300, padMs: 200, cut: cut => cuts.push(cut) });
  assert.ok(packetLevel(new Opus(16_000, 1, "voip"), speechPacket()) > -20, "the tone is loud");
  const send = (count: number, packet: (index: number) => Uint8Array) => { for (let index = 0; index < count; index++) segmenter.packet("bot", packet(index)); };
  // A bot playing a file: 1 s of encoded silence, 0.6 s of speech, 1 s of silence, 0.4 s of speech, 1 s of silence, with no gap.
  send(50, quietPacket);
  send(30, speechPacket);
  send(50, quietPacket);
  send(20, speechPacket);
  send(50, quietPacket);
  // Each speech is its own utterance, ended by 400 ms of quiet, with 200 ms of quiet kept on each side (and a packet or
  // two more where the codec's tail of the speech still sounds).
  assert.deepEqual(cuts.map(cut => cut.ended), ["silence", "silence"]);
  for (const [cut, seconds] of [[cuts[0], 1], [cuts[1], 0.8]] as const) assert.ok(cut.seconds >= seconds && cut.seconds <= seconds + 0.06, `${cut.seconds} s, about ${seconds}`);
  // Quiet alone, or too little speech, is no utterance.
  send(100, quietPacket);
  send(10, speechPacket);
  segmenter.flush("end");
  assert.equal(cuts.length, 2);
});

test("utterances are transcribed, billed to the session's subject, and delivered to webhooks and an agent in order", async t => {
  const { fake, node, events, usage, prompts, transcription, db } = await voiceCluster(t);
  const a = await node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", {
    discord: grant, subject: "user-1", context: { bot: "42" }, deliver: { agent: AGENT }, silenceMs: 200, language: "en", prompt: "camelRun",
    ignoreUserIds: ["500000000000000005"], metadata: { bot: 42 },
  });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 1.5);
  speak(connection, "400000000000000009", 0.6);
  // The bot itself and an ignored user are not listened to.
  speak(connection, grant.userId, 1);
  speak(connection, "500000000000000005", 1);
  await until(async () => (await events("voice.utterance")).length === 2, "two utterances");
  assert.equal(transcription.calls.length, 2);
  assert.deepEqual(transcription.calls[0].options, { language: "en", prompt: "camelRun" });
  const utterances = (await events("voice.utterance")).map(event => event.data).sort((x, y) => x.seq - y.seq);
  assert.deepEqual(utterances.map(data => data.seq), [1, 2]);
  const ada = utterances.find(data => data.speakerId === "400000000000000004")!;
  assert.equal(ada.text, "heard 1.5 seconds");
  assert.equal(ada.seconds, 1.5);
  assert.equal(ada.language, "en");
  assert.equal(ada.ended, "silence");
  assert.equal(ada.session, created.id);
  assert.equal(ada.subject, "user-1");
  assert.deepEqual(ada.metadata, { bot: 42 });
  assert.equal(ada.costUsd, 2 * 6_000 / 60 / 1_000_000, "billed per whole second, as the provider bills");

  // Usage: as POST /v1/transcriptions records it, for the session's subject, with the session in its context.
  assert.equal(usage.length, 2);
  assert.equal(usage[0].tenant, "alice");
  assert.equal(usage[0].usage.kind, "transcription");
  assert.deepEqual(usage[0].usage.identity, { subject: "user-1", context: { bot: "42", voiceSession: created.id } });
  const session = await a.voice.get("alice", created.id);
  assert.equal(session.utterances, 2);
  assert.equal(session.speechSeconds, 3);
  assert.ok(Math.abs(session.costUsd - 3 * 6_000 / 60 / 1_000_000) < 1e-9);
  assert.ok(session.lastSpeechAt);

  // The agent: each utterance a prompt from its speaker, idempotent by session and number.
  await until(() => prompts.length === 2, "the prompts");
  const prompt = prompts.find(entry => (entry.request.params.from as { id: string }).id === "400000000000000004")!;
  assert.equal(prompt.agent, AGENT);
  assert.equal(prompt.request.method, "prompt");
  assert.equal(prompt.request.params.text, "heard 1.5 seconds");
  assert.equal(prompt.request.id, `voice_${created.id.slice(3)}_${ada.seq}`);
  assert.deepEqual(prompt.request.params.metadata, { voiceSession: created.id, utterance: String(ada.seq) });
  assert.equal(Number((await db.query("select count(*) as count from voice_sessions where id = $1 and sealed is not null", [created.id])).rows[0].count), 1);
});

test("an empty transcript is billed but not delivered; a speaker's utterances go one at a time, in order", async t => {
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const transcription = fakeTranscriber(async ({ index }) => {
    order.push(`start ${index}`);
    if (index === 0) await held;
    order.push(`end ${index}`);
    return index === 1 ? "" : `utterance ${index}`;
  });
  const { fake, node, events, usage } = await voiceCluster(t, { transcriber: transcription.transcriber });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 0.5);
  await until(() => order.length === 1, "the first transcription");
  speak(connection, "400000000000000004", 0.5);
  await sleep(400);
  assert.deepEqual(order, ["start 0"], "the second waits for the first");
  release();
  await until(() => usage.length === 2, "both transcribed");
  assert.deepEqual(order, ["start 0", "end 0", "start 1", "end 1"]);
  await sleep(100);
  assert.deepEqual((await events("voice.utterance")).map(event => event.data.text), ["utterance 0"]);
});

test("a tenant out of credit ends the session (budget) at its next utterance; so does a key that went away", async t => {
  let refuse = false;
  const { fake, node, events, transcription } = await voiceCluster(t, {
    admit: async () => { if (refuse) throw new HttpError(402, "Out of credit", "SPEND_LIMIT"); },
  });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  refuse = true;
  speak(connection, "400000000000000004", 0.5);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  const session = await a.voice.get("alice", created.id);
  assert.equal(session.endReason, "budget");
  assert.equal(session.limit, "tenant");
  assert.equal(transcription.calls.length, 0, "nothing transcribed past the limit");
  assert.ok(connection.closed);
  const [ended] = await events("voice.session.ended");
  assert.equal(ended.data.reason, "budget");
  assert.equal(ended.data.limit, "tenant");

  const keyless = fakeTranscriber();
  keyless.transcriber.options.key = async () => undefined;
  const other = await voiceCluster(t, { transcriber: keyless.transcriber });
  const b = await other.node("http://b");
  const second = await b.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  const secondConnection = await until(() => other.fake.open()[0], "the connection");
  speak(secondConnection, "400000000000000004", 0.5);
  await until(async () => (await b.voice.get("alice", second.id)).state === "ended", "the end");
  assert.equal((await b.voice.get("alice", second.id)).endReason, "error");
});

test("no transcription key, no session", async t => {
  const { node } = await voiceCluster(t, { canTranscribe: async () => false });
  const a = await node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), keyScope: "team" }),
    (error: HttpError) => error.status === 400 && error.code === "TRANSCRIPTION_UNAVAILABLE" && /key scope team/.test(error.message));
});

test("speech under way when a node hands its call over is cut there and still delivered; the peer goes on from the next", async t => {
  const { fake, node, events } = await voiceCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const created = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 2_000 });
  const first = await until(() => fake.open()[0], "a's connection");
  first.handlers.ready();
  speak(first, "400000000000000004", 0.8);
  await a.ownership.drain();
  await a.voice.release();
  await until(async () => (await events("voice.utterance")).length === 1, "the cut utterance");
  assert.equal((await events("voice.utterance"))[0].data.ended, "handoff");
  await b.voice.scan();
  const second = await until(() => fake.open()[0], "b's connection");
  speak(second, "400000000000000004", 0.5);
  await b.voice.end("alice", created.id);
  await until(async () => (await events("voice.utterance")).length === 2, "the utterance cut by the end");
  const last = (await events("voice.utterance"))[1].data;
  assert.equal(last.ended, "end");
  assert.equal(last.seq, 2);
});

test("an idle session counts from the last speech", async t => {
  const { fake, node } = await voiceCluster(t);
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200, idleMinutes: 1 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const started = (await a.voice.get("alice", created.id)).startedAt!;
  await sleep(50);
  speak(connection, "400000000000000004", 0.5);
  await until(async () => (await a.voice.get("alice", created.id)).utterances === 1, "the utterance");
  const spoke = (await a.voice.get("alice", created.id)).lastSpeechAt!;
  assert.ok(spoke > started);
  await a.voice.scan(started + 60_000 + 1);
  assert.equal((await a.voice.get("alice", created.id)).state, "live", "speech since the start");
  await a.voice.scan(spoke + 60_000 + 1);
  assert.equal((await a.voice.get("alice", created.id)).endReason, "idle");
});
