import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { HttpError } from "../src/http.ts";
import { Opus } from "../src/opus.ts";
import { oggOpus, packetSamples } from "../src/voice-audio.ts";
import { assemble, Recorder } from "../src/voice/recorder.ts";
import { discordGrant, sleep, speechPacket, until, voiceCluster } from "./voice-fakes.ts";

/**
 * Voice recordings (src/voice/recorder.ts, src/voice-sessions.ts): a session's audio kept as Ogg Opus only while the
 * tenant records it, in chunks in storage, made into files when it ends, and gone when they expire.
 */

/** An Ogg stream's pages: each page's granule position, its packets (by lacing), and the OpusHead's channel count. */
function readOgg(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  const pages: { granule: bigint; packets: Buffer[]; segments: number }[] = [];
  for (let at = 0; at < buffer.length;) {
    assert.equal(buffer.toString("ascii", at, at + 4), "OggS", "a page starts with OggS");
    const segments = buffer[at + 26];
    const lacing = [...buffer.subarray(at + 27, at + 27 + segments)];
    let offset = at + 27 + segments;
    const packets: Buffer[] = [];
    let current: Buffer[] = [];
    for (const size of lacing) {
      current.push(buffer.subarray(offset, offset + size));
      offset += size;
      if (size < 255) { packets.push(Buffer.concat(current)); current = []; }
    }
    pages.push({ granule: buffer.readBigInt64LE(at + 6), packets, segments });
    at = offset;
  }
  const head = pages[0].packets[0];
  assert.equal(head.toString("ascii", 0, 8), "OpusHead");
  return { pages, channels: head[9], audio: pages.slice(2).flatMap(page => page.packets), seconds: Number(pages.at(-1)!.granule) / 48_000 };
}

test("Ogg pages never hold more than 255 lacing segments, however large the packets", () => {
  const big = Array.from({ length: 60 }, () => Uint8Array.from([0x78, ...Array.from({ length: 1_000 }, () => 7)]));
  const { pages, audio, seconds } = readOgg(oggOpus(big));
  assert.ok(pages.every(page => page.segments <= 255));
  assert.equal(audio.length, 60);
  assert.equal(seconds, 1.2);
});

test("tracks line up from the recording's start: each speaker's packets in their slots, silence between", () => {
  const start = 1_000_000;
  const recorder = new Recorder({ startedAt: start, tracks: "speakers", maxBytes: 1024 * 1024, maxMinutes: 60, now: start });
  // Ana speaks at once; Bo a second in, two packets that arrived together (a jitter burst) go to consecutive slots.
  recorder.add([{ speaker: "ana", at: start, packet: speechPacket(0) }, { speaker: "ana", at: start + 20, packet: speechPacket(1) }]);
  recorder.add([{ speaker: "bo", at: start + 1_000, packet: speechPacket(2) }, { speaker: "bo", at: start + 1_000, packet: speechPacket(3) }]);
  const { files, seconds } = assemble([recorder.chunk(true, start + 2_000)!], "speakers");
  recorder.close();
  assert.equal(seconds, 1.04);
  assert.deepEqual(files.map(file => [file.name, file.speakerId, file.seconds]), [["ana.ogg", "ana", 1.04], ["bo.ogg", "bo", 1.04]]);
  const ana = readOgg(files[0].data), bo = readOgg(files[1].data);
  assert.equal(ana.channels, 2, "a speaker's track is as Discord sent it: stereo");
  assert.equal(ana.audio.length, 52);
  assert.deepEqual([...ana.audio[0]], [...speechPacket(0)]);
  assert.deepEqual([...ana.audio[2]], [0xf8, 0xff, 0xfe], "silence where Ana said nothing");
  assert.deepEqual([...bo.audio[50]], [...speechPacket(2)]);
  assert.deepEqual([...bo.audio[51]], [...speechPacket(3)]);
  assert.equal(ana.seconds, bo.seconds);
});

test("a mix is everyone decoded, summed and encoded again: one mono file as long as the call", () => {
  const start = 2_000_000;
  const recorder = new Recorder({ startedAt: start, tracks: "mixed", maxBytes: 1024 * 1024, maxMinutes: 60, now: start });
  const packets = [];
  for (let index = 0; index < 50; index++) {
    packets.push({ speaker: "ana", at: start + index * 20, packet: speechPacket(index) });
    packets.push({ speaker: "300000000000000003", at: start + index * 20, packet: speechPacket(index + 3) });
  }
  recorder.add(packets);
  const first = recorder.chunk(false, start + 1_000)!;
  const last = recorder.chunk(true, start + 1_100)!;
  recorder.close();
  const { files, seconds } = assemble([first, last], "mixed");
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "recording.ogg");
  assert.equal(seconds, 1);
  const ogg = readOgg(files[0].data);
  assert.equal(ogg.channels, 1);
  assert.equal(ogg.seconds, 1);
  // It decodes, and is loud where they spoke.
  const decoder = new Opus(48_000, 1, "voip");
  const pcm = Buffer.concat(ogg.audio.map(packet => decoder.decode(packet)));
  decoder.delete();
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 3_000, `the mix is loud (peak ${peak})`);
  assert.equal(ogg.audio.reduce((sum, packet) => sum + packetSamples(packet), 0), 48_000);
});

test("a recorder says when it is past its limits, and keeps no more than maxBytes", () => {
  const start = 3_000_000;
  const recorder = new Recorder({ startedAt: start, tracks: "speakers", maxBytes: 1024 * 1024, maxMinutes: 1, now: start });
  assert.equal(recorder.full(start + 59_000), undefined);
  assert.equal(recorder.full(start + 60_000), "max_duration");
  const huge = Uint8Array.from([0x78, ...Array.from({ length: 1_200 }, () => 1)]);
  recorder.add(Array.from({ length: 1_000 }, (_, index) => ({ speaker: "ana", at: start + index * 20, packet: huge })));
  assert.equal(recorder.full(start), "max_size");
  assert.ok(recorder.bytes < 1024 * 1024 + 1_300);
  recorder.close();
});

/** A cluster whose nodes keep recordings in one object store, with an endpoint for voice.recording.ended. */
async function recordingCluster(t: Parameters<typeof voiceCluster>[0], options: Parameters<typeof voiceCluster>[1] = {}) {
  const made = await voiceCluster(t, options);
  await made.db.query("insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we_rec', 'alice', 'https://example.test/rec', $1, '{}', 0)", [["voice.recording.ended"]]);
  return made;
}

const ANA = "400000000000000001", BO = "400000000000000002";

test("a session records only once asked: its owner keeps what it hears and plays, and stop answers the files", async t => {
  const { fake, node, events, db, storage } = await recordingCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const grant = discordGrant();
  const session = await a.voice.create("alice", { discord: grant, brain: "listen" });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  // Before a recording, nothing is kept.
  for (let index = 0; index < 10; index++) connection.handlers.packet(ANA, speechPacket(index));
  await sleep(300);
  assert.equal((await db.query("select count(*)::int as count from voice_recordings")).rows[0].count, 0);

  // Started on another node: the owner hears of it.
  const started = await b.voice.startRecording("alice", session.id, { tracks: "speakers", metadata: { by: "test" } });
  assert.match(started.id, /^vr_[a-f0-9]{24}$/);
  assert.equal(started.state, "recording");
  assert.deepEqual(started.notice, { required: true, channelId: grant.channelId, text: `<@${grant.userId}> is recording this voice channel: what is said here is saved as audio until the recording stops.` });
  await assert.rejects(a.voice.startRecording("alice", session.id, {}), (error: HttpError) => error.status === 409 && error.code === "VOICE_RECORDING_EXISTS" && error.details?.recording === started.id);
  a.voice.heard(`http://b ${session.id}`);
  await sleep(200);
  for (let index = 0; index < 25; index++) connection.handlers.packet(ANA, speechPacket(index));
  for (let index = 0; index < 25; index++) connection.handlers.packet(BO, speechPacket(index));
  // The bot's own speech, as it went out.
  for (let index = 0; index < 10; index++) connection.handlers.played?.(speechPacket(index));
  await sleep(300);

  const stopping = b.voice.stopRecording("alice", session.id);
  await sleep(100);
  a.voice.heard(`http://b ${session.id}`);
  const stopped = await stopping;
  assert.equal(stopped.state, "ready");
  assert.equal(stopped.endReason, "stopped");
  assert.deepEqual(stopped.files.map(file => file.speakerId).sort(), [grant.userId, ANA, BO].sort());
  assert.ok(stopped.seconds! >= 0.5 && stopped.seconds! < 3, `${stopped.seconds} seconds`);
  assert.ok(stopped.expiresAt! - stopped.endedAt! === 24 * 3_600_000, "kept a day by default");
  const ana = await a.voice.recordingFile("alice", started.id, `${ANA}.ogg`);
  assert.equal(ana.contentType, "audio/ogg");
  const ogg = readOgg(ana.data);
  assert.equal(ogg.audio.filter(packet => packet.length > 3).length, 25, "Ana's 25 packets, none from before the recording");
  assert.equal(ogg.seconds, stopped.seconds);
  assert.equal(readOgg((await a.voice.recordingFile("alice", started.id, `${grant.userId}.ogg`)).data).audio.filter(packet => packet.length > 3).length, 10);
  // The chunks are gone; the files stay.
  assert.deepEqual([...storage.blobs.keys()].filter(key => key.includes("/chunks/")), []);
  await assert.rejects(a.voice.recordingFile("bob", started.id, `${ANA}.ogg`), (error: HttpError) => error.status === 404);
  await assert.rejects(a.voice.stopRecording("alice", session.id), (error: HttpError) => error.status === 409 && error.code === "VOICE_NOT_RECORDING");

  const ended = await events("voice.recording.ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.session, session.id);
  assert.equal(ended[0].data.recording.id, started.id);
  assert.deepEqual(ended[0].data.recording.metadata, { by: "test" });

  // Deleted: its files go.
  assert.deepEqual(await a.voice.deleteRecording("alice", started.id), { id: started.id, deleted: true });
  assert.deepEqual([...storage.blobs.keys()].filter(key => key.includes(started.id)), []);
  await assert.rejects(a.voice.getRecording("alice", started.id), (error: HttpError) => error.status === 404);
});

test("a recording ends with its session, and at its size limit, its files made either way", async t => {
  const { fake, node, events } = await recordingCluster(t);
  const a = await node("http://a");
  const session = await a.voice.create("alice", { discord: discordGrant(), brain: "listen" });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  const first = await a.voice.startRecording("alice", session.id, {});
  for (let index = 0; index < 50; index++) connection.handlers.packet(ANA, speechPacket(index));
  await sleep(300);
  await a.voice.end("alice", session.id);
  const done = await until(async () => { const row = await a.voice.getRecording("alice", first.id); return row.state === "ready" && row; }, "the recording's files");
  assert.equal(done.endReason, "session_ended");
  assert.deepEqual(done.files.map(file => file.name), ["recording.ogg"]);
  assert.ok(done.seconds! >= 0.9, `${done.seconds} seconds`);
  await assert.rejects(a.voice.startRecording("alice", session.id, {}), (error: HttpError) => error.status === 409 && error.code === "VOICE_SESSION_ENDED");

  const other = await a.voice.create("alice", { discord: discordGrant(), brain: "listen" });
  const next = await until(() => fake.open()[0], "the second connection");
  next.handlers.ready();
  const small = await a.voice.startRecording("alice", other.id, { tracks: "speakers", maxBytes: 1024 * 1024 });
  await sleep(200);
  const huge = Uint8Array.from([0x78, ...Array.from({ length: 1_200 }, () => 3)]);
  for (let index = 0; index < 1_000; index++) next.handlers.packet(ANA, huge);
  const full = await until(async () => { const row = await a.voice.getRecording("alice", small.id); return row.state === "ready" && row; }, "the full recording");
  assert.equal(full.endReason, "max_size");
  assert.equal((await a.voice.get("alice", other.id)).state === "ended", false, "the call goes on");
  assert.equal((await events("voice.recording.ended")).length, 2);
});

test("a session handed to another node goes on recording into the same recording", async t => {
  const { fake, node } = await recordingCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const session = await a.voice.create("alice", { discord: discordGrant(), brain: "listen" });
  const first = await until(() => fake.open()[0], "a's connection");
  first.handlers.ready();
  const recording = await a.voice.startRecording("alice", session.id, { tracks: "speakers" });
  await sleep(100);
  for (let index = 0; index < 20; index++) first.handlers.packet(ANA, speechPacket(index));
  await sleep(300);
  await a.voice.release();
  await b.voice.scan();
  const second = await until(() => fake.open().find(connection => connection !== first), "b's connection");
  second.handlers.ready();
  await until(() => b.voice.holds(session.id), "b holding it");
  await sleep(200);
  for (let index = 0; index < 30; index++) second.handlers.packet(ANA, speechPacket(index));
  await sleep(300);
  // Asked on a: b, the owner now, hears of it (pg_notify, here by hand).
  const stopping = a.voice.stopRecording("alice", session.id);
  await sleep(100);
  b.voice.heard(`http://a ${session.id}`);
  const stopped = await stopping;
  assert.equal(stopped.state, "ready");
  const ogg = readOgg((await a.voice.recordingFile("alice", recording.id, `${ANA}.ogg`)).data);
  assert.equal(ogg.audio.filter(packet => packet.length > 3).length, 50, "both nodes' packets");
});

test("recording needs object storage, and checks what it is asked", async t => {
  const { fake, node } = await recordingCluster(t, { storage: undefined });
  const a = await node("http://a");
  const session = await a.voice.create("alice", { discord: discordGrant(), brain: "listen" });
  await until(() => fake.open()[0], "the connection");
  await assert.rejects(a.voice.startRecording("alice", session.id, {}), (error: HttpError) => error.status === 404);
  const { node: withStorage } = await recordingCluster(t);
  const b = await withStorage("http://b");
  const other = await b.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000077" }), brain: "listen" });
  const refused = async (input: Record<string, unknown>, pattern: RegExp) => assert.rejects(b.voice.startRecording("alice", other.id, input), (error: HttpError) => error.status === 400 && pattern.test(error.message));
  await refused({ tracks: "stereo" }, /tracks/);
  await refused({ maxMinutes: 241 }, /maxMinutes/);
  await refused({ maxBytes: 10 }, /maxBytes/);
  await refused({ retentionHours: 721 }, /retentionHours/);
  await refused({ extra: true }, /body.extra is not a field/);
  await assert.rejects(b.voice.startRecording("bob", other.id, {}), (error: HttpError) => error.status === 404);
});

test("a recording's files are deleted when they expire", async t => {
  const { fake, node, db, storage } = await recordingCluster(t);
  const a = await node("http://a");
  const session = await a.voice.create("alice", { discord: discordGrant(), brain: "listen" });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  const recording = await a.voice.startRecording("alice", session.id, { retentionHours: 1 });
  await sleep(100);
  for (let index = 0; index < 10; index++) connection.handlers.packet(ANA, speechPacket(index));
  await sleep(300);
  await a.voice.stopRecording("alice", session.id);
  assert.ok([...storage.blobs.keys()].some(key => key.includes(recording.id)));
  await db.query("update voice_recordings set expires_at = 1 where id = $1", [recording.id]);
  await a.voice.scan(Date.now() + 2 * 3_600_000);
  assert.deepEqual([...storage.blobs.keys()].filter(key => key.includes(recording.id)), []);
  assert.equal((await db.query("select count(*)::int as count from voice_recordings")).rows[0].count, 0);
});
