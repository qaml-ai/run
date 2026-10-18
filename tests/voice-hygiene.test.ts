import { test } from "node:test";
import assert from "node:assert/strict";
import { Opus } from "../src/opus.ts";
import { JitterBuffer, JITTER } from "../src/voice/jitter.ts";
import { opusFromPcm, Segmenter, type Cut } from "../src/voice-audio.ts";
import { discordVoice } from "../src/voice-discord.ts";
import type { VoiceHandlers } from "../src/voice-sessions.ts";
import { fakeDiscordVoice } from "./fake-discord-voice.ts";
import { discordGrant, quietPacket, sleep, speechPacket, until } from "./voice-fakes.ts";

const packet = (n: number) => Uint8Array.of(n & 0xff);

/** A jitter buffer over one SSRC, recording what it releases: [sequence tag, lost before it]. */
function jitter(options: { holdMs?: number; maxHeld?: number } = {}) {
  const out: [number, number][] = [];
  const buffer = new JitterBuffer<Uint8Array>((_ssrc, released, lost) => out.push([released[0], lost]), options);
  return { out, push: (sequence: number) => buffer.push(7, sequence & 0xffff, packet(sequence)), buffer };
}

test("the jitter buffer: in order goes on at once; reordered packets go back in order; a gap is waited out, then counted lost", async () => {
  const inOrder = jitter();
  for (const sequence of [10, 11, 12]) inOrder.push(sequence);
  assert.deepEqual(inOrder.out, [[10, 0], [11, 0], [12, 0]], "no delay when nothing is wrong");

  const swapped = jitter();
  for (const sequence of [1, 3, 2, 4]) swapped.push(sequence);
  assert.deepEqual(swapped.out, [[1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.equal(swapped.buffer.stats.reordered, 1);

  const lost = jitter();
  for (const sequence of [1, 2, 4, 5]) lost.push(sequence);
  assert.deepEqual(lost.out, [[1, 0], [2, 0]], "4 and 5 wait for 3");
  await sleep(JITTER.holdMs + 30);
  assert.deepEqual(lost.out, [[1, 0], [2, 0], [4, 1], [5, 0]], "3 is given up on: 4 goes on after a gap of one");
  // 3, arriving after all, is late: its place was concealed.
  lost.push(3);
  assert.equal(lost.out.length, 4);
  assert.equal(lost.buffer.stats.late, 1);

  // More waiting than it holds goes on at once, without waiting out the time.
  const burst = jitter();
  for (const sequence of [1, 3, 4, 5, 6]) burst.push(sequence);
  assert.deepEqual(burst.out, [[1, 0], [3, 1], [4, 0], [5, 0], [6, 0]]);

  // Sequence numbers wrap; a jump far away is a new stream, not loss.
  const wrap = jitter();
  for (const sequence of [65_534, 65_535, 65_536, 65_537]) wrap.push(sequence);
  assert.deepEqual(wrap.out.map(([, gap]) => gap), [0, 0, 0, 0]);
  wrap.push(30_000);
  assert.deepEqual(wrap.out.at(-1), [30_000 & 0xff, 0]);
  wrap.buffer.close();
});

test("libopus conceals a lost packet: 20 ms of audio at the decoder's rate, from what came before", () => {
  const decoder = new Opus(24_000, 1, "voip");
  decoder.decode(speechPacket(0));
  decoder.decode(speechPacket(1));
  const concealed = decoder.conceal(20);
  assert.equal(concealed.length, 480 * 2, "20 ms at 24 kHz, 16-bit");
  assert.ok(concealed.some(byte => byte !== 0), "not silence: it carries on the tone");
  // The next packet decodes as usual after it.
  assert.equal(decoder.decode(speechPacket(2)).length, 480 * 2);
  decoder.delete();
});

test("the segmenter conceals lost packets in what it streams live, but not in what it cuts", () => {
  const streamed: number[] = [];
  const cuts: Cut[] = [];
  const segmenter = new Segmenter({ silenceMs: 200, cut: cut => cuts.push(cut), live: { audio: (_speaker, pcm) => streamed.push(pcm.length), drop: () => {} } });
  for (let index = 0; index < 20; index++) segmenter.packet("4", speechPacket(index), index === 10 ? 2 : 0);
  segmenter.flush("end");
  assert.equal(streamed.reduce((sum, bytes) => sum + bytes, 0), 22 * 960, "20 packets and 2 concealed, 20 ms each");
  assert.equal(cuts[0].packets.length, 20);
});

function connect(credentials: ReturnType<typeof discordGrant>) {
  const seen = { ready: 0, packets: [] as { packet: Uint8Array; lost: number }[] };
  const handlers: VoiceHandlers = {
    ready: () => { seen.ready++; }, packet: (_speaker, packet, lost) => seen.packets.push({ packet, lost: lost ?? 0 }),
    broken: () => {}, lost: () => {}, diagnostic: () => {},
  };
  return { connection: discordVoice().connect(credentials, handlers), seen };
}

test("Discord packets out of order reach the speaker's stream in order; lost ones are counted for concealment", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  const sent = Array.from({ length: 12 }, (_, index) => Uint8Array.from([0x78, index, 1, 2, 3]));
  // The network swaps 2 and 3, holds 6 behind 8, and loses 10.
  await voice.speak("400000000000000004", 7_001, sent, 5, { order: [0, 1, 3, 2, 4, 5, 7, 8, 6, 9, 11], drop: [10] });
  await until(() => seen.packets.length === 11, "the packets", 5_000);
  assert.deepEqual(seen.packets.map(entry => entry.packet[1]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11], "in order");
  assert.deepEqual(seen.packets.map(entry => entry.lost), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], "one lost before the last");
});

test("speech stopped partway still ends with Discord's five silence frames, and the next plays after", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  async function* tone(seconds: number) {
    for (let chunk = 0, at = 0; chunk < seconds * 10; chunk++) {
      const pcm = Buffer.alloc(4_800);
      for (let i = 0; i < 2_400; i++, at++) pcm.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 300 * at / 24_000)), i * 2);
      yield pcm;
    }
  }
  const long = connection.play!(opusFromPcm(tone(5)), () => {});
  await until(() => voice.spoken().length > 20, "speech playing");
  long.stop();
  assert.equal(await long.done, "stopped");
  await sleep(200);
  const heard = voice.spoken();
  const tail = heard.slice(-5);
  assert.ok(tail.every(frame => frame.length === 3 && frame[0] === 0xf8), `five silence frames after the cut (${heard.slice(-7).map(frame => frame.length).join(",")})`);
  const before = heard.length;
  const next = connection.play!(opusFromPcm(tone(0.4)), () => {});
  assert.equal(await next.done, "done");
  await until(() => voice.spoken().length >= before + 20 + 5, "the next speech, and its silence frames");
  // Speaking (op 5): set as each speech starts, cleared after its silence frames, the stopped one's too.
  await until(() => voice.speakingStates.at(-1) === 0, "speaking cleared");
  assert.deepEqual(voice.speakingStates, [1, 0, 1, 0]);
});

test("a resumed voice socket keeps each speaker's stream: what they say after it is heard, in order, nothing counted lost", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  const packets = (from: number) => Array.from({ length: 5 }, (_, index) => Uint8Array.from([0x78, from + index, 1, 2, 3]));
  await voice.speak("400000000000000004", 7_002, packets(0), 5);
  await until(() => seen.packets.length === 5, "before the resume");
  voice.close(4015);
  await until(() => voice.resumes.length === 1 && seen.ready === 2, "the resume");
  await voice.speak("400000000000000004", 7_002, packets(5), 5);
  await until(() => seen.packets.length === 10, "after the resume");
  assert.deepEqual(seen.packets.map(entry => entry.packet[1]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(seen.packets.every(entry => entry.lost === 0));
  assert.equal(voice.identifies.length, 1, "resumed, not identified again");
});
test("silence is counted from the last loud packet: a client's trailing quiet packets do not put the cut off", async () => {
  const cuts: { cut: Cut; at: number }[] = [];
  const segmenter = new Segmenter({ silenceMs: 400, cut: cut => cuts.push({ cut, at: performance.now() }) });
  for (let index = 0; index < 25; index++) { segmenter.packet("4", speechPacket(index)); await sleep(20); }
  const lastLoud = performance.now();
  // 300 ms of quiet packets as a client's voice activity lets go, then nothing.
  for (let index = 0; index < 15; index++) { segmenter.packet("4", quietPacket(index)); await sleep(20); }
  await until(() => cuts.length === 1, "the cut", 3_000);
  const after = Math.round(cuts[0].at - lastLoud);
  assert.ok(after < 600, `cut ${after} ms after the last loud packet (silenceMs 400; it was 700 when timed from the last packet)`);
  assert.equal(cuts[0].cut.ended, "silence");
});

