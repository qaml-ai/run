import { test } from "node:test";
import assert from "node:assert/strict";
import { Opus } from "../src/opus.ts";
import { HttpError } from "../src/http.ts";
import { opusFromPcm } from "../src/voice-audio.ts";
import { discordVoice, strictWelcome } from "../src/voice-discord.ts";
import type { VoiceCredit } from "../src/voice-sessions.ts";
import { fakeDiscordVoice } from "./fake-discord-voice.ts";
import { AGENT, discordGrant, fakeSynthesizer, sleep, speak, until, voiceCluster } from "./voice-fakes.ts";
import { speakable, SpokenReply } from "../src/voice-speech.ts";

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

test("a session that speaks: the app joins un-muted; speech plays on the connection, then its events and usage", async t => {
  const { fake, node, events, usage, speech } = await voiceCluster(t);
  const a = await node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000091" }), voice: "coral" }), /speak: true/);
  const quiet = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000092" }) });
  assert.deepEqual(quiet.join, { self_mute: true, self_deaf: false });
  await assert.rejects(a.voice.speak("alice", quiet.id, { text: "hello" }), (error: HttpError) => error.status === 409 && error.code === "VOICE_SPEAK_DISABLED");

  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, speak: true, voice: "coral", subject: "user-1" });
  assert.deepEqual(created.join, { self_mute: false, self_deaf: false });
  assert.match(created.notice.text, /may speak/);
  assert.deepEqual([created.speak, created.bargeIn, created.voice], [true, true, "coral"]);
  const connection = await until(() => fake.open().find(open => open.credentials.guildId === grant.guildId), "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const before = await a.voice.get("alice", created.id);

  // 1.2 s of speech: 60 packets of 20 ms.
  const queued = await a.voice.speak("alice", created.id, { text: "x".repeat(12), instructions: "Cheerful." });
  assert.match(queued.speechId, /^sp_[a-f0-9]{24}$/);
  assert.deepEqual([queued.state, queued.position, queued.voice, queued.characters], ["queued", 0, "coral", 12]);
  await until(async () => (await events("voice.speech.ended")).length === 1, "the speech to end");
  assert.equal(connection.played.length, 1);
  assert.equal(connection.played[0].length, 60);
  assert.deepEqual(speech.calls[0].input, { text: "x".repeat(12), voice: "coral", instructions: "Cheerful." });
  const [started] = await events("voice.speech.started");
  assert.equal(started.data.speechId, queued.speechId);
  assert.ok(started.data.latencyMs >= 0);
  const [ended] = await events("voice.speech.ended");
  assert.deepEqual([ended.data.speechId, ended.data.reason, ended.data.seconds], [queued.speechId, "done", 1.2]);
  assert.equal(ended.data.costUsd, 2 * 15_000 / 60 / 1_000_000, "billed per whole second made");
  const record = usage.find(entry => entry.usage.kind === "speech")!;
  assert.deepEqual([record.tenant, record.usage.provider, record.usage.model, record.usage.audioSeconds, record.usage.speeches], ["alice", "openai", "gpt-4o-mini-tts", 1.2, 1]);
  assert.deepEqual(record.usage.identity, { subject: "user-1", context: { voiceSession: created.id } });
  const after = await a.voice.get("alice", created.id);
  assert.deepEqual([after.speeches, after.spokenSeconds], [1, 1.2]);
  // The bot speaking is not speech in the call: no utterance, nothing for idleMinutes, and its own audio is not listened to.
  assert.deepEqual([after.utterances, after.lastSpeechAt], [before.utterances, before.lastSpeechAt]);
  speak(connection, grant.userId, 1);
  await sleep(1_000);
  assert.equal((await events("voice.utterance")).length, 0);
});

test("speeches queue in order; interrupt and DELETE stop what plays and clear the queue", async t => {
  const { fake, node, events } = await voiceCluster(t, { playEveryMs: 10 });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), speak: true, bargeIn: false });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  const first = await a.voice.speak("alice", created.id, { text: "a".repeat(20) });
  const second = await a.voice.speak("alice", created.id, { text: "b".repeat(20) });
  const third = await a.voice.speak("alice", created.id, { text: "c".repeat(20) });
  assert.deepEqual([first.position, second.position, third.position], [0, 1, 2]);
  await until(() => connection.playing && connection.played[0]?.length > 5, "the first to play");
  const urgent = await a.voice.speak("alice", created.id, { text: "d".repeat(5), interrupt: true });
  assert.equal(urgent.position, 0);
  await until(async () => (await events("voice.speech.ended")).length === 4, "all four to end");
  const endings = Object.fromEntries((await events("voice.speech.ended")).map(event => [event.data.speechId, [event.data.reason, event.data.by ?? null]]));
  assert.deepEqual(endings, {
    [first.speechId]: ["interrupted", "interrupt"], [second.speechId]: ["interrupted", "interrupt"],
    [third.speechId]: ["interrupted", "interrupt"], [urgent.speechId]: ["done", null],
  });
  assert.ok(connection.played[0].length < 40, "the first was cut short");
  assert.equal(connection.played.at(-1)!.length, 25);

  await a.voice.speak("alice", created.id, { text: "e".repeat(40) });
  await until(() => connection.playing, "it to play");
  assert.deepEqual(await a.voice.stopSpeaking("alice", created.id), { stopped: 1 });
  await until(async () => (await events("voice.speech.ended")).length === 5, "it to end");
  assert.equal((await events("voice.speech.ended")).at(-1)!.data.by, "requested");
});

test("barge-in: a person starting to talk stops the bot; with it off, the bot talks on", async t => {
  const { fake, node, events } = await voiceCluster(t, { playEveryMs: 10 });
  const a = await node("http://a");
  const on = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000081" }), speak: true, silenceMs: 200 });
  const off = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000082" }), speak: true, bargeIn: false, silenceMs: 200 });
  const connectionOn = await until(() => fake.open().find(open => open.credentials.guildId === "100000000000000081"), "a connection");
  const connectionOff = await until(() => fake.open().find(open => open.credentials.guildId === "100000000000000082"), "a connection");
  for (const [session, connection] of [[on, connectionOn], [off, connectionOff]] as const) {
    connection.handlers.ready();
    await a.voice.speak("alice", session.id, { text: "z".repeat(30) });
    await until(() => connection.playing, "it to play");
    speak(connection, "400000000000000004", 0.4);
  }
  await until(async () => (await events("voice.speech.ended")).length === 2, "both to end", 15_000);
  const ended = await events("voice.speech.ended");
  const bySession = Object.fromEntries(ended.map(event => [event.data.session, [event.data.reason, event.data.by ?? null]]));
  assert.deepEqual(bySession, { [on.id]: ["interrupted", "barge_in"], [off.id]: ["done", null] });
  assert.ok(connectionOn.played[0].length < 150 && connectionOff.played[0].length === 150);
});

test("speech is paid for: a tenant or end user out of credit ends the session; a hold settles at what was made", async t => {
  let refuse = false;
  const holds: string[] = [];
  const credit: VoiceCredit = {
    refusal: async () => undefined,
    hold: async (_tenant, endUser, bucket, usd, call) => {
      if (refuse) throw new HttpError(402, "no credit", "END_USER_CREDIT", { endUser, bucket, reason: "balance" });
      holds.push(`hold ${call} ${usd.toFixed(6)}`);
      return { settle: async actual => { holds.push(`settle ${actual.toFixed(6)}`); }, release: async () => { holds.push("release"); } };
    },
  };
  const { fake, node, events } = await voiceCluster(t, { credit });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), speak: true, subject: "ada" });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  // 28 characters: estimated 2 s; made 2.8 s, billed 3.
  await a.voice.speak("alice", created.id, { text: "q".repeat(28) });
  await until(() => holds.length === 2, "the hold to settle");
  assert.deepEqual(holds, [`hold voice_speech ${(2 * 15_000 / 60 / 1e6).toFixed(6)}`, `settle ${(3 * 15_000 / 60 / 1e6).toFixed(6)}`]);
  refuse = true;
  await a.voice.speak("alice", created.id, { text: "q".repeat(28) });
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  const session = await a.voice.get("alice", created.id);
  assert.deepEqual([session.endReason, session.limit, session.endUserReason], ["budget", "end_user", "balance"]);
  assert.equal(connection.played.length, 1, "the second never played");
  // Its speech's end is written apart from the session's: waited for, not read at once.
  const ended = await until(async () => { const found = await events("voice.speech.ended"); return found.length === 2 && found; }, "the second speech's end");
  assert.deepEqual(ended.map(event => event.data.by ?? null).sort(), ["budget", null]);
});

test("speech that cannot be made ends as an error, and costs nothing", async t => {
  const failing = fakeSynthesizer({ fail: true });
  const { fake, node, events, usage } = await voiceCluster(t, { synthesizer: failing.synthesizer });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), speak: true });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await a.voice.speak("alice", created.id, { text: "hello there" });
  const [ended] = await until(async () => { const found = await events("voice.speech.ended"); return found.length && found; }, "the end");
  assert.deepEqual([ended.data.reason, ended.data.seconds, ended.data.costUsd], ["error", 0, 0]);
  assert.equal(usage.filter(entry => entry.usage.kind === "speech").length, 0);
});

test("a session that moves cuts its speech (handoff); speak elsewhere is a 503 to retry", async t => {
  const { fake, node, events } = await voiceCluster(t, { playEveryMs: 10 });
  const a = await node("http://a"), b = await node("http://b");
  const created = await a.voice.create("alice", { discord: discordGrant(), speak: true });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await a.voice.speak("alice", created.id, { text: "w".repeat(40) });
  await assert.rejects(b.voice.speak("alice", created.id, { text: "elsewhere" }), (error: HttpError) => error.status === 503);
  await until(() => connection.playing, "it to play");
  await a.ownership.drain();
  await a.voice.release();
  await until(async () => (await events("voice.speech.ended")).length === 1, "the cut");
  assert.equal((await events("voice.speech.ended"))[0].data.by, "handoff");
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

test("an agent's reply as it may be spoken: markdown's marks, links' addresses, URLs and code left out", () => {
  assert.equal(speakable("## Plan\n- **First**, see [the docs](https://example.com) or https://x.y/z.\n> Use `npm test` _now_."),
    "Plan First, see the docs or Use npm test now.");
  assert.equal(speakable("| a | b |\n|---|---|\n| 1 | 2 |"), "a, b, 1, 2");
  assert.equal(speakable("```"), "");
  assert.equal(speakable("snake_case_name stays readable"), "snake_case_name stays readable");
});

test("a reply streamed in pieces is spoken sentence by sentence as each is whole, code blocks skipped, at most 400 characters", () => {
  const said: string[] = [];
  const reply = new SpokenReply(text => said.push(text));
  for (const delta of ["Hel", "lo there! How", " are you? Here", " is code:\n``", "`ts\nconst x = 1;\n", "```\nThat's ", "it"]) reply.push(delta);
  assert.deepEqual(said, ["Hello there!", "How are you?", "Here is code:"], "each sentence as soon as it is whole");
  reply.end();
  assert.deepEqual(said, ["Hello there!", "How are you?", "Here is code:", "That's it"]);

  const long: string[] = [];
  const capped = new SpokenReply(text => long.push(text));
  for (let i = 0; i < 30; i++) capped.push(`This is sentence number ${i} of a long answer. `);
  capped.end();
  assert.ok(long.join(" ").length <= 400 && long.join(" ").length > 350, "about 400 characters");
  assert.ok(capped.full);
  // A piece that does not fit is cut at a word, with an ellipsis, when there is room for one.
  const cut: string[] = [];
  const short = new SpokenReply(text => cut.push(text), 60);
  short.push("One two three four five six seven eight nine ten eleven twelve thirteen fourteen. ");
  short.end();
  assert.deepEqual(cut, ["One two three four five six seven eight nine ten eleven…"]);

  // A sentence that runs on is cut at a comma.
  const runOn: string[] = [];
  const reply2 = new SpokenReply(text => runOn.push(text));
  reply2.push(`${"word ".repeat(30)}, ${"more ".repeat(40)}`);
  assert.deepEqual(runOn, ["word ".repeat(30).trim()], "cut after the comma, which is not said");
});

test("barge-in stops an agent's reply mid-way: what was left of it is never said", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  async function* stream() { yield "First sentence here. Second one"; await gate; yield " follows. Third sentence too."; }
  const { fake, node, events } = await voiceCluster(t, { playEveryMs: 10, submitStreaming: () => stream() });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), speak: { agentReplies: true }, deliver: { agent: AGENT }, silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 0.5);
  await until(() => connection.playing, "the first sentence to play");
  speak(connection, "400000000000000004", 0.4);
  await until(async () => (await events("voice.speech.ended")).some(event => event.data.by === "barge_in"), "the barge-in");
  release();
  await sleep(500);
  const ended = await events("voice.speech.ended");
  assert.equal(ended.length, 1, "the rest of the reply was never queued");
  assert.deepEqual(ended[0].data.reply, { agent: AGENT, requestId: `voice_${created.id.slice(3)}_1` });
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
