import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Opus } from "../src/opus.ts";
import { opusStats } from "../src/opus.ts";
import { hostClient, startTurnModels, type TurnModels } from "../src/voice/turns/inference.ts";
import { discordGrant, sleep, until, voiceCluster } from "./voice-fakes.ts";

/**
 * Voice sessions that end turns with turn-taking (endOfTurn smart: Silero VAD and Smart Turn, src/voice/turns), on
 * recorded speech encoded as Discord sends it (20 ms Opus packets, 48 kHz stereo, nothing while silent).
 */

const FIXTURES = new URL("./fixtures/voice-turns/", import.meta.url);
function wav16(name: string): Int16Array {
  const b = readFileSync(new URL(name, FIXTURES));
  for (let off = 12; off < b.length;) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
    off += 8 + size;
  }
  throw new Error("no data chunk");
}

/** 16 kHz mono as Discord's packets: upsampled to 48 kHz stereo (linear), 20 ms each. */
function packets(pcm: Int16Array): Uint8Array[] {
  const encoder = new Opus(48_000, 2, "voip");
  const out: Uint8Array[] = [];
  for (let at = 0; at + 320 <= pcm.length; at += 320) {
    const frame = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) {
      const position = at + i / 3, base = Math.floor(position), next = Math.min(pcm.length - 1, base + 1);
      const sample = Math.round(pcm[base] + (pcm[next] - pcm[base]) * (position - base));
      frame.writeInt16LE(sample, i * 4); frame.writeInt16LE(sample, i * 4 + 2);
    }
    out.push(new Uint8Array(encoder.encode(frame, 960)));
  }
  encoder.delete();
  return out;
}
/** Steady noise at `db` dBFS, as an open mic in a noisy room sends it. */
const noise = (seconds: number, db: number) => Int16Array.from({ length: seconds * 16_000 }, () => Math.round((Math.random() * 2 - 1) * 32_767 * 10 ** (db / 20) * Math.sqrt(3)));

let shared: { models: TurnModels; close(): Promise<void> } | undefined;
async function turnModels(t: TestContext) {
  if (!shared) {
    const host = startTurnModels({ eotWorkers: 1 });
    await host.ready;
    shared = { models: hostClient(host), close: () => host.close() };
  }
  t.after(async () => { await shared?.close(); shared = undefined; });
  return shared.models;
}

async function liveSession(t: TestContext, options: Record<string, unknown> = {}, models?: TurnModels) {
  const cluster = await voiceCluster(t, models ? { turnModels: models } : {});
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, ...options });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  /** Packets in real time (20 ms each), as Discord delivers them. */
  const play = async (speaker: string, list: Uint8Array[]) => { for (const packet of list) { connection.handlers.packet(speaker, packet); await sleep(20); } };
  return { ...cluster, a, created, connection, play };
}

test("endOfTurn: smart by default where the runtime has turn models, silence otherwise; validated", { timeout: 60_000 }, async t => {
  const models = await turnModels(t);
  const { a, created } = await liveSession(t, {}, models);
  assert.deepEqual(created.endOfTurn, { mode: "smart", commitMs: 500, threshold: 0.5, maxSilenceMs: 1_400 });
  await a.voice.end("alice", created.id).catch(() => {});
  const tuned = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000009" }), endOfTurn: { commitMs: 700, threshold: 0.6 } });
  assert.deepEqual(tuned.endOfTurn, { mode: "smart", commitMs: 700, threshold: 0.6, maxSilenceMs: 1_400 });
  const silence = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000010" }), endOfTurn: "silence" });
  assert.equal(silence.endOfTurn.mode, "silence");
  for (const [endOfTurn, message] of [[{ threshold: 2 }, /threshold/], [{ commitMs: 50 }, /commitMs/], [{ mode: "fast" }, /mode/], [{ commitMs: 2_000, maxSilenceMs: 1_000 }, /maxSilenceMs/], [{ other: 1 }, /not a field/]] as const) {
    await assert.rejects(a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000011" }), endOfTurn }), (error: Error) => message.test(error.message), JSON.stringify(endOfTurn));
  }
  // A runtime without the models: sessions end turns on silence, and smart is refused.
  const { a: plain, created: legacy } = await liveSession(t);
  assert.equal(legacy.endOfTurn.mode, "silence");
  await assert.rejects(plain.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000012" }), endOfTurn: "smart" }), /not enabled/);
});

test("a recorded turn is one utterance, cut soon after the speaker is done; noise and a thinking pause are not cut", { timeout: 120_000 }, async t => {
  const models = await turnModels(t);
  // Up to 2 s of thinking, for the pause below.
  const { play, events, transcription } = await liveSession(t, { endOfTurn: { maxSilenceMs: 2_000 } }, models);
  const speaker = "400000000000000001";
  // A complete turn: cut once, within about commitMs (+ the VAD's lag) of the end of speech.
  const complete = packets(wav16("eng-c-0187c333.wav"));
  await play(speaker, complete);
  const spokeAt = Date.now();
  const [first] = await until(async () => { const utterances = await events("voice.utterance"); return utterances.length && utterances; }, "the utterance", 5_000);
  const cutAfterMs = Date.now() - spokeAt;
  assert.equal(first.data.ended, "silence");
  assert.ok(cutAfterMs < 1_200, `cut ${cutAfterMs} ms after the audio`);
  assert.ok(first.data.seconds > 1.5 && first.data.seconds < 4, `the turn's speech (${first.data.seconds} s)`);
  // Steady room noise at -35 dBFS (above the energy segmenter's -45): no utterance.
  await play(speaker, packets(noise(3, -35)));
  await sleep(2_000);
  assert.equal((await events("voice.utterance")).length, 1, "noise is not speech");
  // An incomplete turn, a pause of more than a second after its last word, then the rest: one utterance (the energy
  // segmenter, at 800 ms, cuts it in two).
  transcription.calls.length = 0;
  const incomplete = packets(wav16("eng-i-00d8ee40.wav"));
  await play(speaker, incomplete);
  await sleep(1_000);
  await play(speaker, complete);
  await until(async () => (await events("voice.utterance")).length >= 2, "the second utterance", 5_000);
  await sleep(1_500);
  const utterances = await events("voice.utterance");
  assert.equal(utterances.length, 2, `the pause did not cut the turn: ${JSON.stringify(utterances.map((u: any) => [u.data.seconds, u.data.ended, u.data.startedAt, u.data.endedAt]))}`);
  assert.ok(utterances[1].data.seconds > 5, `both parts in one utterance (${utterances[1].data.seconds} s)`);
});

test("the energy segmenter, for comparison: the same noise is an utterance, and the same pause cuts the turn", { timeout: 120_000 }, async t => {
  const { play, events } = await liveSession(t, { endOfTurn: "silence" });
  const speaker = "400000000000000001";
  await play(speaker, packets(noise(2, -35)));
  await sleep(1_200);
  assert.equal((await events("voice.utterance")).length, 1, "the energy segmenter takes noise for speech");
  await play(speaker, packets(wav16("eng-i-00d8ee40.wav")));
  await sleep(1_000);
  await play(speaker, packets(wav16("eng-c-0187c333.wav")));
  await until(async () => (await events("voice.utterance")).length >= 3, "cut in two", 5_000);
});

test("smart sessions free their decoders, and a session ending cuts what was being said", { timeout: 60_000 }, async t => {
  const models = await turnModels(t);
  const { a, created, play, events } = await liveSession(t, {}, models);
  const before = opusStats().live;
  const turn = packets(wav16("spa-c-01d233b8.wav"));
  await play("400000000000000001", turn.slice(0, 100));
  await a.voice.end("alice", created.id);
  await until(async () => (await events("voice.utterance")).length === 1, "the cut utterance", 5_000);
  assert.equal((await events("voice.utterance"))[0].data.ended, "end");
  assert.ok(opusStats().live <= before, `decoders freed (${before} -> ${opusStats().live})`);
});

test("in a media worker, smart end of turn reaches the node's models over a port; when the models restart, the worker gets another", { timeout: 120_000 }, async t => {
  const { MediaHost } = await import("../src/voice/media-host.ts");
  const { workerFakes } = await import("./voice-worker-transport.ts");
  const turnHost = startTurnModels({ eotWorkers: 1 });
  await turnHost.ready;
  const host = new MediaHost({ transport: { module: new URL("./voice-worker-transport.ts", import.meta.url).href, export: "workerFakeTransport" }, speaks: true, tickMs: 200, spare: 0, turnModels: turnHost });
  const fakes = workerFakes();
  t.after(async () => { fakes.close(); await host.close(); await turnHost.close(); });
  const cluster = await voiceCluster(t, { transports: { discord: host.transport() }, media: () => host.factory(), turnModels: hostClient(turnHost) });
  const a = await cluster.node("http://a");
  const guild = "100000000000000031";
  const created = await a.voice.create("alice", { discord: discordGrant({ guildId: guild }) });
  assert.equal(created.endOfTurn.mode, "smart");
  await until(() => fakes.reports.some(report => report.guild === guild && report.event === "connected"), "the connection in its worker");
  fakes.send({ guild, cmd: "ready" });
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const turn = packets(wav16("eng-c-0187c333.wav"));
  fakes.send({ guild, cmd: "send", speaker: "400000000000000001", packets: turn });
  const [first] = await until(async () => { const list = await cluster.events("voice.utterance"); return list.length && list; }, "the utterance, cut by turn-taking in the worker", 15_000);
  assert.ok(first.data.seconds > 1.5 && first.data.seconds < 4, `the turn's speech (${first.data.seconds} s)`);
  // The models' host thread dies: it restarts itself, the worker's port closes, and it asks for (and gets) another.
  await turnHost.thread?.terminate();
  await sleep(500);
  await turnHost.ready;
  fakes.send({ guild, cmd: "send", speaker: "400000000000000001", packets: turn });
  await until(async () => (await cluster.events("voice.utterance")).length === 2, "an utterance after the models restarted", 20_000);
  assert.ok(host.stats().modelPorts >= 1, "the worker was given a fresh port to the models");
});
