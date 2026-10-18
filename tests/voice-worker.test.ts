import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { MediaHost } from "../src/voice/media-host.ts";
import { MEDIA_CRASHES } from "../src/voice-sessions.ts";
import type { Cut } from "../src/voice-audio.ts";
import { fakeDiscordVoice } from "./fake-discord-voice.ts";
import { discordGrant, sleep, speechPacket, until, voiceCluster } from "./voice-fakes.ts";
import { workerFakes, type Report } from "./voice-worker-transport.ts";

const TRANSPORT = { module: new URL("./voice-worker-transport.ts", import.meta.url).href, export: "workerFakeTransport" };

/** A cluster whose sessions' media run in workers of `host`, driven through the workers' fake transport. */
async function workerCluster(t: { after(fn: () => unknown): void }, host: MediaHost) {
  const fakes = workerFakes();
  t.after(() => { fakes.close(); return host.close(); });
  const cluster = await voiceCluster(t, { transports: { discord: host.transport() }, media: () => host.factory() });
  const a = await cluster.node("http://a");
  /** A live session in guild `guild`, its connection made in a worker: which thread. */
  const session = async (guild: string, input: Record<string, unknown> = {}) => {
    const created = await a.voice.create("alice", { discord: discordGrant({ guildId: guild }), silenceMs: 200, ...input });
    const connected = await until(() => fakes.reports.find(report => report.guild === guild && report.event === "connected"), `${guild}'s connection`);
    fakes.send({ guild, cmd: "ready" });
    await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
    return { id: created.id, guild, thread: (connected as Extract<Report, { event: "connected" }>).thread };
  };
  const utterances = async (id: string) => (await cluster.events("voice.utterance")).filter((event: any) => event.data.session === id).length;
  return { ...cluster, a, fakes, session, utterances };
}

for (const failure of ["crash", "oom", "hang"] as const) {
  test(`a media worker that fails (${failure}) ends only its own session's audio: it says so, restarts and goes on; other sessions and the node's thread carry on`, { timeout: 120_000 }, async t => {
    const host = new MediaHost({ transport: TRANSPORT, speaks: true, heapMb: 64, tickMs: 200, stallMs: 1_500, spare: 0 });
    const { a, fakes, session, utterances, events } = await workerCluster(t, host);
    const one = await session("100000000000000001");
    const two = await session("100000000000000002");
    assert.notEqual(one.thread, two.thread, "each session's media has a worker of its own");

    // The node's own thread, timed throughout: an agent's turn runs here.
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    // Session two talks on, utterance after utterance, while session one's worker fails.
    let talking = true;
    const talker = (async () => { while (talking) { fakes.send({ guild: two.guild, cmd: "talk", speaker: "400000000000000004", seconds: 0.4 }); await sleep(800); } })();
    await until(async () => await utterances(two.id) >= 1, "session two's first utterance");
    const before = await utterances(two.id);
    fakes.send({ guild: one.guild, cmd: failure });
    const [error] = await until(async () => { const list = await events("voice.session.error"); return list.length && list; }, "voice.session.error", 30_000);
    assert.equal(error.data.session, one.id);
    assert.deepEqual([error.data.code, error.data.restarting, error.data.attempt], ["media_crashed", true, 1]);
    // It restarts in a fresh worker, with the same credentials, and listens again.
    const again = await until(() => fakes.reports.filter(report => report.guild === one.guild && report.event === "connected")[1], "session one reconnected", 30_000);
    assert.notEqual((again as Extract<Report, { event: "connected" }>).thread, one.thread);
    fakes.send({ guild: one.guild, cmd: "ready" });
    fakes.send({ guild: one.guild, cmd: "talk", speaker: "400000000000000005", seconds: 0.5 });
    await until(async () => await utterances(one.id) >= 1, "session one's utterance after the restart", 20_000);
    await until(async () => await utterances(two.id) >= before + 2, "session two's utterances went on", 20_000);
    talking = false;
    await talker;
    delay.disable();
    assert.equal((await events("voice.session.error")).length, 1, "only session one's audio failed");
    assert.equal((await a.voice.get("alice", one.id)).state, "live");
    assert.equal((await a.voice.get("alice", two.id)).state, "live");
    // A worker that never yields is ended by its supervisor, never stalling the node's thread.
    assert.ok(delay.max / 1e6 < 250, `the node's thread was never held up (event loop delay max ${Math.round(delay.max / 1e6)} ms)`);
    assert.equal(host.stats().crashes, 1);
  });
}

test(`a session whose media fails ${MEDIA_CRASHES.max} times in ${MEDIA_CRASHES.windowMs / 60_000} minutes ends (error, media_crashed)`, { timeout: 120_000 }, async t => {
  const host = new MediaHost({ transport: TRANSPORT, speaks: true, tickMs: 200, stallMs: 1_500, spare: 0 });
  const { a, fakes, session, events } = await workerCluster(t, host);
  const one = await session("100000000000000003");
  for (let attempt = 1; attempt <= MEDIA_CRASHES.max; attempt++) {
    await until(() => fakes.reports.filter(report => report.guild === one.guild && report.event === "connected").length === attempt, `connection ${attempt}`, 20_000);
    fakes.send({ guild: one.guild, cmd: "crash" });
    await until(async () => (await events("voice.session.error")).length === attempt, `failure ${attempt}`, 20_000);
  }
  const errors = await events("voice.session.error");
  assert.deepEqual(errors.map((event: any) => [event.data.attempt, event.data.restarting]), [[1, true], [2, true], [3, false]]);
  await until(async () => (await a.voice.get("alice", one.id)).state === "ended", "the session to end");
  const [ended] = await events("voice.session.ended");
  assert.equal(ended.data.reason, "error");
});

test("speech plays through a media worker: PCM down, encoded and played there; a person talking stops it (barge-in); a session's close flushes its speakers", { timeout: 120_000 }, async t => {
  const host = new MediaHost({ transport: TRANSPORT, speaks: true, tickMs: 200, spare: 1 });
  const { a, fakes, session, events, utterances } = await workerCluster(t, host);
  const one = await session("100000000000000004", { speak: true, bargeIn: true });
  // 1.2 s of speech (12 characters at a tenth of a second each): 60 packets.
  await a.voice.speak("alice", one.id, { text: "x".repeat(12) });
  await until(async () => (await events("voice.speech.ended")).length === 1, "the speech to end");
  const [started] = await events("voice.speech.started");
  assert.ok(started.data.latencyMs >= 0);
  const [ended] = await events("voice.speech.ended");
  assert.deepEqual([ended.data.reason, ended.data.seconds], ["done", 1.2]);
  assert.equal((fakes.reports.find(report => report.guild === one.guild && report.event === "played") as Extract<Report, { event: "played" }>).packets, 60);

  // A long speech, cut short by someone talking.
  await a.voice.speak("alice", one.id, { text: "x".repeat(200) });
  await until(async () => (await events("voice.speech.started")).length === 2, "the second speech to start");
  fakes.send({ guild: one.guild, cmd: "talk", speaker: "400000000000000006", seconds: 3 });
  await until(async () => (await events("voice.speech.ended")).length === 2, "the barge-in");
  const stopped = (await events("voice.speech.ended"))[1];
  assert.deepEqual([stopped.data.reason, stopped.data.by], ["interrupted", "barge_in"]);
  // Ending the session mid-sentence: what was said so far is cut and transcribed.
  await sleep(300);
  await a.voice.end("alice", one.id);
  await until(async () => await utterances(one.id) === 1, "the flushed utterance");
  const [utterance] = await events("voice.utterance");
  assert.equal(utterance.data.ended, "end");
  await until(() => host.stats().sessions === 0, "the session to leave its worker");
  assert.equal(host.stats().workers, 1, "its worker ended; the spare waits");
});

test("past maxWorkers, a session shares the worker holding fewest; that worker's crash is both sessions', and only theirs", { timeout: 120_000 }, async t => {
  const host = new MediaHost({ transport: TRANSPORT, speaks: true, maxWorkers: 2, tickMs: 200, spare: 0 });
  const { session, fakes, events } = await workerCluster(t, host);
  const one = await session("100000000000000011");
  const two = await session("100000000000000012");
  const three = await session("100000000000000013");
  assert.notEqual(one.thread, two.thread);
  assert.ok([one.thread, two.thread].includes(three.thread), "the third shares a worker");
  assert.equal(host.stats().workers, 2);
  const shared = three.thread === one.thread ? one : two;
  const alone = shared === one ? two : one;
  fakes.send({ guild: three.guild, cmd: "crash" });
  await until(async () => (await events("voice.session.error")).length === 2, "both sessions told");
  const told = (await events("voice.session.error")).map((event: any) => event.data.session).sort();
  assert.deepEqual(told, [shared.id, three.id].sort());
  await sleep(300);
  assert.ok(!(await events("voice.session.error")).some((event: any) => event.data.session === alone.id));
});

test("the Discord transport in a media worker, against a voice server: a person's speech is cut into an utterance here, and speech made here is heard there", { timeout: 120_000 }, async t => {
  const voice = await fakeDiscordVoice(t);
  const host = new MediaHost({ transport: { module: new URL("../src/voice-discord.ts", import.meta.url).href, export: "discordVoice" }, speaks: true, tickMs: 200, spare: 0 });
  t.after(() => host.close());
  const grant = discordGrant({ endpoint: voice.endpoint });
  const cuts: Cut[] = [];
  let ready = 0;
  const media = host.factory()("vs_test", grant, { silenceMs: 200, ignoreUserIds: [], bargeIn: false, live: false }, {
    ready: () => { ready++; }, lost: () => {}, diagnostic: () => {}, speechStart: () => {}, pcm: () => {}, drop: () => {}, cut: cut => { cuts.push(cut); },
  });
  await until(() => ready === 1, "ready");
  await voice.speak("400000000000000004", 2001, Array.from({ length: 30 }, (_, index) => speechPacket(index)), 20);
  await until(() => cuts.length === 1, "the utterance");
  assert.equal(cuts[0].speaker, "400000000000000004");
  assert.equal(cuts[0].packets.length, 30);
  let started = 0;
  // A second of a 300 Hz tone, 24 kHz mono, in ten chunks.
  async function* second() {
    for (let chunk = 0, at = 0; chunk < 10; chunk++) {
      const pcm = Buffer.alloc(4_800);
      for (let i = 0; i < 2_400; i++, at++) pcm.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 300 * at / 24_000)), i * 2);
      yield pcm;
    }
  }
  const playback = media.play(second(), () => { started++; });
  assert.equal(await playback.done, "done");
  assert.equal(started, 1);
  await until(() => voice.spoken().filter(packet => packet.length > 3).length >= 50, "the voice server to hear a second of speech");
  await media.close("end");
});

test("a node with voice on holds each session's media in a worker by default: the Discord connection is made there, and goes live", { timeout: 120_000 }, async t => {
  const voice = await fakeDiscordVoice(t);
  const root = await mkdtemp(join(tmpdir(), "agent-voice-worker-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "fixture-key" } } } }));
  const { url: databaseUrl } = await testDatabase();
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_VOICE: "true",
    });
    assert.equal(config.voice.isolation, "worker");
    const made = await createNode(config, { ...await nodeDeps(config), voiceEndpoints: /^127\.0\.0\.1$/ });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
    return { status: response.status, json: await response.json() as any };
  };
  const created = await call("POST", "/v1/voice/sessions", { discord: discordGrant({ endpoint: voice.endpoint }), speak: true });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await until(async () => (await call("GET", `/v1/voice/sessions/${created.json.id}`)).json.state === "live", "live, connected from its worker", 30_000);
  assert.equal(voice.identifies.length, 1);
  const ended = await call("DELETE", `/v1/voice/sessions/${created.json.id}`);
  assert.equal(ended.status, 200);
  await until(() => !voice.connected(), "its worker's connection to close", 10_000);
});
