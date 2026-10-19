import { test } from "node:test";
import assert from "node:assert/strict";
import { Opus } from "../src/opus.ts";
import { opusFromPcm } from "../src/voice-audio.ts";
import { discordVoice, strictWelcome } from "../src/voice-discord.ts";
import { fakeDiscordVoice } from "./fake-discord-voice.ts";
import { discordGrant, sleep, until } from "./voice-fakes.ts";

/** Speech played on a connection (the realtime brain's answers): PCM to Opus as it comes, and the Discord transport's player. */

/** A 300 Hz tone as 24 kHz mono PCM, in chunks of these many samples. */
async function* chunks(...sizes: number[]) {
  let at = 0;
  for (const size of sizes) {
    const chunk = Buffer.alloc(size * 2);
    for (let i = 0; i < size; i++, at++) chunk.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 300 * at / 24_000)), i * 2);
    yield chunk;
  }
}

test("speech PCM (24 kHz mono) becomes 20 ms Opus packets at 48 kHz stereo, one per 20 ms as it comes, the last padded", async () => {
  let samples = 0;
  const packets: Buffer[] = [];
  // One second in odd-sized chunks, plus 10 ms.
  for await (const packet of opusFromPcm(chunks(1_000, 7_001, 15_999, 240), count => { samples += count; })) packets.push(packet);
  assert.equal(packets.length, 51);
  assert.equal(samples, 24_240);
  const decoder = new Opus(48_000, 2, "audio");
  assert.equal(decoder.decode(packets[0]).length, 960 * 2 * 2, "20 ms of 48 kHz stereo");
  decoder.delete();
});

test("a Welcome into a group with a member the voice gateway never named is refused at once, as libdave refuses it", () => {
  const recovered: number[] = [];
  let members = ["self", "ada"];
  const dave: any = {
    session: { getUserIds: () => members },
    processWelcome: (payload: Buffer) => ({ transitionId: payload.readUInt16BE(0), success: true }),
    recoverFromInvalidTransition(id: number) { recovered.push(id); },
  };
  const refused: number[] = [];
  strictWelcome(dave, "self", () => new Set(["ada"]), strangers => refused.push(strangers));
  strictWelcome(dave, "self", () => new Set(["ada"]), strangers => refused.push(strangers));
  const welcome = (id: number) => { const payload = Buffer.alloc(4); payload.writeUInt16BE(id, 0); return dave.processWelcome(payload); };
  assert.deepEqual(welcome(7), { transitionId: 7, success: true });
  members = ["self", "ada", "eve"];
  assert.deepEqual(welcome(8), { transitionId: 8, success: false });
  assert.deepEqual(recovered, [8]);
  assert.deepEqual(refused, [1], "wrapped once");
});

test("speech plays through the Discord transport: the voice server hears every packet, encrypted as Discord's are", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const seen = { ready: 0 };
  const connection = discordVoice().connect(grant, { ready: () => { seen.ready++; }, packet: () => {}, broken: () => {}, lost: () => {}, diagnostic: () => {} });
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  let started = 0;
  const playback = connection.play!(opusFromPcm(chunks(24_000)), () => { started++; });
  assert.equal(await playback.done, "done");
  assert.equal(started, 1);
  // Its 50 packets, then the few silence frames a player ends on (Discord's 3-byte frame).
  const speech = () => voice.spoken().filter(packet => packet.length > 3);
  await until(() => speech().length >= 50, "the server to hear it");
  assert.equal(speech().length, 50);
  // A playback stopped partway is "stopped".
  const long = connection.play!(opusFromPcm(chunks(24_000 * 5)), () => {});
  await sleep(200);
  long.stop();
  assert.equal(await long.done, "stopped");
});

test("no speech goes out while the DAVE group holds a member the voice gateway has not named", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  voice.members(["400000000000000004"]);
  let ready = 0;
  // The group as davey would report it: someone the gateway never named, inside the guard's (long) grace.
  const connection = discordVoice({ roster: { graceMs: 60_000, members: () => [grant.userId, "400000000000000004", "666000000000000666"] } })
    .connect(grant, { ready: () => { ready++; }, packet: () => {}, broken: () => {}, lost: () => {}, diagnostic: () => {} });
  t.after(() => connection.close());
  await until(() => ready === 1, "ready");
  let started = 0;
  const playback = connection.play!(opusFromPcm(chunks(24_000)), () => { started++; });
  await sleep(800);
  assert.equal(started, 0, "held back");
  assert.equal(voice.spoken().filter(packet => packet.length > 3).length, 0, "nothing reached the voice server");
  playback.stop();
  assert.equal(await playback.done, "stopped");
});

test("speech whose making stalls (a first chunk, then nothing for seconds, as OpenAI may stream) still plays whole", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  let ready = 0;
  const connection = discordVoice().connect(grant, { ready: () => { ready++; }, packet: () => {}, broken: () => {}, lost: () => {}, diagnostic: () => {} });
  t.after(() => connection.close());
  await until(() => ready === 1, "ready");
  // 0.2 s of speech at once, then a 6 s wait, then the other 1.8 s.
  async function* stalling() {
    yield* chunks(4_800);
    await sleep(6_000);
    yield* chunks(43_200);
  }
  let made = 0;
  const playback = connection.play!(opusFromPcm(stalling(), count => { made += count; }), () => {});
  assert.equal(await playback.done, "done");
  assert.equal(made, 48_000);
  const speech = voice.spoken().filter(packet => packet.length > 3);
  assert.equal(speech.length, 100, "every packet went out");
  assert.equal(playback.stats!().packets, 100);
});

test("speech made only 1.7 times faster than it plays, in uneven bursts (as OpenAI streamed it in a live check), plays without gaps", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  let ready = 0;
  const connection = discordVoice().connect(grant, { ready: () => { ready++; }, packet: () => {}, broken: () => {}, lost: () => {}, diagnostic: () => {} });
  t.after(() => connection.close());
  await until(() => ready === 1, "ready");
  // 3 s of speech in chunks of about 65 ms of audio, one every 22 to 54 ms (38 on average: 1.7x), after a first byte at 0.5 s.
  async function* bursty() {
    await sleep(500);
    for (let at = 0, index = 0; at < 72_000; index++) {
      const size = Math.min(1_565, 72_000 - at);
      at += size;
      yield* chunks(size);
      await sleep([22, 54, 30, 46, 38][index % 5]);
    }
  }
  const asked = Date.now();
  let firstAudioMs = 0;
  const playback = connection.play!(opusFromPcm(bursty()), () => { firstAudioMs = Date.now() - asked; });
  assert.equal(await playback.done, "done");
  const stats = playback.stats!();
  assert.equal(stats.packets, 150);
  // As the listener heard it: the speech packets' arrival span, less their length (Discord's silence frames are 3 bytes).
  const heard = voice.spokenTimes().filter(packet => packet.bytes > 3);
  const heardGapMs = Math.round(heard.at(-1)!.at - heard[0].at - (heard.length - 1) * 20);
  assert.ok(heardGapMs <= 100, `the listener heard ${heardGapMs} ms of gaps (${JSON.stringify(stats)})`);
  assert.ok(stats.gapMs <= 100, `${stats.gapMs} ms of gaps (${JSON.stringify(stats)})`);
  assert.ok(firstAudioMs < 800, `first audio ${firstAudioMs} ms after asking: 0.5 s to the first byte, then about 0.1 s`);
});

test("speech made slower than it plays at first, then all at once, waits for a longer lead instead of stuttering", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  let ready = 0;
  const connection = discordVoice().connect(grant, { ready: () => { ready++; }, packet: () => {}, broken: () => {}, lost: () => {}, diagnostic: () => {} });
  t.after(() => connection.close());
  await until(() => ready === 1, "ready");
  // 3 s of speech: its first 1.6 s at 0.8x (65 ms of audio every 81 ms), then the rest at once.
  async function* backLoaded() {
    let at = 0;
    for (; at < 38_400; at += 1_565) {
      yield* chunks(Math.min(1_565, 38_400 - at));
      await sleep(81);
    }
    yield* chunks(72_000 - 38_400);
  }
  const playback = connection.play!(opusFromPcm(backLoaded()), () => {});
  assert.equal(await playback.done, "done");
  const heard = voice.spokenTimes().filter(packet => packet.bytes > 3);
  assert.equal(heard.length, 150);
  const heardGapMs = Math.round(heard.at(-1)!.at - heard[0].at - (heard.length - 1) * 20);
  assert.ok(heardGapMs <= 100, `the listener heard ${heardGapMs} ms of gaps (${JSON.stringify(playback.stats!())})`);
});
