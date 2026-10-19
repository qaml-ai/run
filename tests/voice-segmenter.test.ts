import { test } from "node:test";
import assert from "node:assert/strict";
import { Opus } from "../src/opus.ts";
import { packetLevel, packetSamples, Segmenter, type Cut } from "../src/voice-audio.ts";
import { discordGrant, opusPacket, quietPacket, sleep, speak, speechPacket, until, voiceCluster } from "./voice-fakes.ts";

/** A call's audio cut into turns (src/voice-audio.ts's Segmenter), and what a turn does to its session. */

test("an Opus packet's length comes from its TOC byte", () => {
  assert.equal(packetSamples(opusPacket()), 960, "20 ms at 48 kHz");
  assert.equal(packetSamples(Uint8Array.from([0xfc, 1])), 960, "CELT 20 ms");
  assert.equal(packetSamples(Uint8Array.from([0x7b, 0x03])), 2880, "three 20 ms frames (code 3)");
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

test("an idle session counts from the last speech", async t => {
  const { fake, node } = await voiceCluster(t);
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200, idleMinutes: 1 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const started = (await a.voice.get("alice", created.id)).startedAt!;
  await sleep(50);
  // A turn keeps the session from idling, whatever the brain makes of it.
  connection.others = ["400000000000000004"];
  speak(connection, "400000000000000004", 0.5);
  const spoke = await until(async () => (await a.voice.get("alice", created.id)).lastSpeechAt, "the turn");
  assert.ok(spoke > started);
  await a.voice.scan(started + 60_000 + 1);
  assert.equal((await a.voice.get("alice", created.id)).state, "live", "speech since the start");
  await a.voice.scan(spoke + 60_000 + 1);
  assert.equal((await a.voice.get("alice", created.id)).endReason, "idle");
});
