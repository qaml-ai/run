import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { opusStats } from "../src/opus.ts";
import { MediaHost } from "../src/voice/media-host.ts";
import { discordGrant, sleep, speechPacket, until, voiceCluster, type FakeConnection } from "./voice-fakes.ts";
import { workerFakes } from "./voice-worker-transport.ts";

/**
 * A node under voice load: SESSIONS sessions that speak, each with SPEAKERS people talking in turns of 0.4-2 s in real
 * time (a decoder each, made and freed per utterance), while each session's bot speaks every second or so (an encoder
 * each, and barge-in stopping some mid-way, so playback is abandoned too), for VOICE_LOAD_SECONDS (20 by default; run
 * VOICE_LOAD_SECONDS=600 by hand before turning voice on). Nothing may fail: no codec error, no utterance or speech that
 * errs, nothing thrown to the process (the test runner fails on that), and memory stays bounded.
 */
const SECONDS = Number(process.env.VOICE_LOAD_SECONDS ?? 20);
const SESSIONS = Number(process.env.VOICE_LOAD_SESSIONS ?? 4);
const SPEAKERS = Number(process.env.VOICE_LOAD_SPEAKERS ?? 8);

test(`voice under load: ${SESSIONS} sessions x ${SPEAKERS} speakers with speech playing, ${SECONDS} s`, { timeout: (SECONDS + 120) * 1_000 }, async t => {
  // What the node logs, for failures it reports rather than throws.
  const failures: string[] = [];
  // Each turn's latency line (src/voice/latency.ts): the app's speech after an utterance is that turn's reply.
  const turns: { outcome: string; stagesMs: Record<string, number> }[] = [];
  const watch = (line: unknown) => {
    const text = String(line);
    if (text.includes('"type":"voice_turn_latency"')) turns.push(JSON.parse(text));
    if (/voice_(segment_failed|audio_failed|speech_error|utterance_failed|utterance_dropped)|Opus|process_fatal/.test(text)) failures.push(text.slice(0, 300));
  };
  const { log, error } = console;
  console.log = (...args: unknown[]) => { watch(args[0]); log(...args); };
  console.error = (...args: unknown[]) => { watch(args[0]); error(...args); };
  t.after(() => { console.log = log; console.error = error; });

  const { fake, node, events, transcription, usage } = await voiceCluster(t, { playEveryMs: 20, perTenant: () => SESSIONS });
  const a = await node("http://a");
  const sessions: { id: string; connection: FakeConnection }[] = [];
  for (let index = 0; index < SESSIONS; index++) {
    const grant = discordGrant({ guildId: `1000000000000001${String(index).padStart(2, "0")}` });
    // Half the sessions barge in (speech stopped as people talk, its playback abandoned), half talk on to the end.
    const created = await a.voice.create("alice", { discord: grant, speak: true, voice: "coral", silenceMs: 300, bargeIn: index % 2 === 0 });
    const connection = await until(() => fake.open().find(open => open.credentials.guildId === grant.guildId), "the connection");
    connection.handlers.ready();
    await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
    sessions.push({ id: created.id, connection });
  }
  const rss = () => Math.round(process.memoryUsage().rss / 1_048_576);
  const startRss = rss();
  // The node's own thread, where agents' turns run: how long it was held up while voice ran on it.
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const deadline = Date.now() + SECONDS * 1_000;
  let packets = 0, spoken = 0, transcribed = 0, refused = 0;
  // The fakes keep each call's audio: counted and let go, so memory is the node's, not the test's.
  const letGo = setInterval(() => { transcribed += transcription.calls.length; transcription.calls.length = 0; usage.length = 0; for (const { connection } of sessions) connection.played.length = 0; }, 1_000);
  t.after(() => clearInterval(letGo));
  const sampler = process.env.VOICE_LOAD_TRACE ? setInterval(() => { (globalThis as any).gc?.(); console.log(JSON.stringify({ type: "voice_load_heap", heapMb: Math.round(process.memoryUsage().heapUsed / 1_048_576), externalMb: Math.round(process.memoryUsage().external / 1_048_576), arrayBuffersMb: Math.round(process.memoryUsage().arrayBuffers / 1_048_576), rssMb: rss(), codecs: opusStats() })); }, 30_000) : undefined;
  t.after(() => clearInterval(sampler));

  // Each speaker: a turn of speech, packet by packet every 20 ms, then quiet past the silence timer.
  const speaker = async (connection: FakeConnection, id: string) => {
    for (let turn = 0; Date.now() < deadline; turn++) {
      const count = 20 + Math.floor(Math.random() * 80);
      for (let index = 0; index < count && Date.now() < deadline; index++) {
        connection.handlers.packet(id, speechPacket(index));
        packets++;
        await sleep(20);
      }
      await sleep(400 + Math.floor(Math.random() * 1_000));
    }
  };
  // Each session's bot: something to say every second or so, sometimes interrupting what it says.
  const bot = async (session: { id: string }) => {
    while (Date.now() < deadline) {
      // Faster than a session that does not barge in can say it: past its queue's limit the speech is refused (a 429 to
      // wait on, as an app would), and the next is asked for later.
      try {
        await a.voice.speak("alice", session.id, { text: "x".repeat(10 + Math.floor(Math.random() * 30)), interrupt: Math.random() < 0.2 });
        spoken++;
      } catch (error) {
        if ((error as { code?: string }).code !== "VOICE_SPEECH_QUEUE_FULL") throw error;
        refused++;
      }
      await sleep(700 + Math.floor(Math.random() * 800));
    }
  };
  await Promise.all(sessions.flatMap(session => [
    bot(session),
    ...Array.from({ length: SPEAKERS }, (_, index) => speaker(session.connection, `4000000000000000${String(index).padStart(2, "0")}`)),
  ]));
  // What was cut is transcribed; what was queued finishes or is stopped.
  await sleep(2_000);
  clearInterval(letGo);
  transcribed += transcription.calls.length;
  const utterances = (await events("voice.utterance")).length;
  const ended = await events("voice.speech.ended");
  const endRss = rss();
  delay.disable();
  const codecs = opusStats();
  const firstAudio = turns.filter(turn => turn.outcome === "spoken").map(turn => turn.stagesMs.firstPacket).sort((x, y) => x - y);
  const percentile = (p: number) => firstAudio[Math.min(firstAudio.length - 1, Math.floor(firstAudio.length * p))];
  console.log(JSON.stringify({ type: "voice_load", seconds: SECONDS, sessions: SESSIONS, speakers: SPEAKERS, packets, utterances, transcriptions: transcribed,
    speeches: spoken, queueFull: refused, speechEnded: ended.length, reasons: ended.reduce((counts: Record<string, number>, event: any) => ({ ...counts, [event.data.reason]: (counts[event.data.reason] ?? 0) + 1 }), {}), rssMb: { start: startRss, end: endRss }, codecs,
    turns: { timed: turns.length, spoken: firstAudio.length, firstPacketMs: { p50: percentile(0.5), p95: percentile(0.95) } },
    eventLoopDelayMs: { p50: Math.round(delay.percentile(50) / 1e6), p99: Math.round(delay.percentile(99) / 1e6), max: Math.round(delay.max / 1e6) } }));

  assert.deepEqual(failures, [], "no codec, utterance or speech failure");
  assert.ok(utterances >= SESSIONS * SPEAKERS, `utterances were cut and delivered (${utterances})`);
  assert.ok(ended.length >= SESSIONS, `speech played (${ended.length} ended)`);
  assert.ok(!ended.some((event: any) => event.data.reason === "error"), "no speech ended in error");
  // Turns are timed under load, and every spoken one has each stage up to its first packet.
  assert.ok(firstAudio.length >= SESSIONS, `spoken turns were timed (${firstAudio.length})`);
  assert.ok(turns.filter(turn => turn.outcome === "spoken").every(turn => ["turnCommit", "transcript", "firstPiece", "ttsFirstAudio", "firstPacket"].every(stage => stage in turn.stagesMs)), "spoken turns have every stage");
  // Every utterance's decoder and every speech's encoder is freed: what is left is what is open now, at most one each.
  assert.ok(codecs.live <= SESSIONS * (SPEAKERS + 1), `codecs freed (${codecs.live} alive)`);
  assert.ok(endRss - startRss < 150, `memory stayed bounded (${startRss} -> ${endRss} MB)`);
  for (const session of sessions) assert.equal((await a.voice.get("alice", session.id)).state, "live", "every session still live");
});

/**
 * The same load with each session's media in a worker of its own (src/voice/media-host.ts), people talking from inside
 * the workers, and halfway through, one session's worker crashing as the 2026-10-18 bug crashed the node (a throw from
 * a timer). Only that session hears of it (voice.session.error) and restarts; every other session's utterances and
 * speech go on; a stream of an agent's tokens on the node's own thread (as a turn streams to its caller) never stalls;
 * and the node's thread is held up less than with the media on it.
 */
test(`voice under load in media workers: ${SESSIONS} sessions x ${SPEAKERS} speakers, one worker crashing halfway, ${SECONDS} s`, { timeout: (SECONDS + 120) * 1_000 }, async t => {
  const failures: string[] = [];
  const watch = (line: unknown) => {
    const text = String(line);
    if (/voice_(segment_failed|audio_failed|speech_error|utterance_failed|utterance_dropped|media_message_failed)|process_fatal/.test(text)) failures.push(text.slice(0, 300));
  };
  const { log, error } = console;
  console.log = (...args: unknown[]) => { watch(args[0]); log(...args); };
  console.error = (...args: unknown[]) => { watch(args[0]); error(...args); };
  t.after(() => { console.log = log; console.error = error; });

  const host = new MediaHost({ transport: { module: new URL("./voice-worker-transport.ts", import.meta.url).href, export: "workerFakeTransport", options: { playEveryMs: 20 } }, speaks: true, tickMs: 500, spare: 0 });
  const fakes = workerFakes();
  t.after(() => { fakes.close(); return host.close(); });
  const { node, events } = await voiceCluster(t, { transports: { discord: host.transport() }, media: () => host.factory(), perTenant: () => SESSIONS });
  const a = await node("http://a");
  const sessions: { id: string; guild: string }[] = [];
  for (let index = 0; index < SESSIONS; index++) {
    const guild = `1000000000000002${String(index).padStart(2, "0")}`;
    const created = await a.voice.create("alice", { discord: discordGrant({ guildId: guild }), speak: true, voice: "coral", silenceMs: 300, bargeIn: index % 2 === 0 });
    await until(() => fakes.reports.some(report => report.guild === guild && report.event === "connected"), "the connection");
    fakes.send({ guild, cmd: "ready" });
    await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
    sessions.push({ id: created.id, guild });
  }
  const startRss = Math.round(process.memoryUsage().rss / 1_048_576);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const deadline = Date.now() + SECONDS * 1_000;
  // An agent's turn streaming on the node's thread: a token every 20 ms; the longest wait between two is how long the
  // thread was held.
  let tokens = 0, longestGapMs = 0;
  const turn = (async () => {
    for (let last = performance.now(); Date.now() < deadline; tokens++) {
      await sleep(20);
      const now = performance.now();
      longestGapMs = Math.max(longestGapMs, now - last - 20);
      last = now;
    }
  })();
  const speaker = async (session: { guild: string }, id: string) => {
    while (Date.now() < deadline) {
      const seconds = 0.4 + Math.random() * 1.6;
      fakes.send({ guild: session.guild, cmd: "talk", speaker: id, seconds });
      await sleep(seconds * 1_000 + 400 + Math.floor(Math.random() * 1_000));
    }
  };
  let spoken = 0;
  const bot = async (session: { id: string }) => {
    while (Date.now() < deadline) {
      try { await a.voice.speak("alice", session.id, { text: "x".repeat(10 + Math.floor(Math.random() * 30)), interrupt: Math.random() < 0.2 }); spoken++; }
      catch (error) { if (!["VOICE_SPEECH_QUEUE_FULL"].includes((error as { code?: string }).code!) && (error as { status?: number }).status !== 503) throw error; }
      await sleep(700 + Math.floor(Math.random() * 800));
    }
  };
  const victim = sessions[0];
  const utterancesOf = async (id: string) => (await events("voice.utterance")).filter((event: any) => event.data.session === id).length;
  let atCrash: number[] = [];
  const crash = (async () => {
    await sleep(SECONDS * 500);
    atCrash = await Promise.all(sessions.map(session => utterancesOf(session.id)));
    fakes.send({ guild: victim.guild, cmd: "crash" });
    // It reconnects in a fresh worker: ready again, and its people go on talking to it.
    await until(() => fakes.reports.filter(report => report.guild === victim.guild && report.event === "connected").length === 2, "the victim's restart", 20_000);
    fakes.send({ guild: victim.guild, cmd: "ready" });
  })();
  await Promise.all([turn, crash, ...sessions.flatMap(session => [bot(session), ...Array.from({ length: SPEAKERS }, (_, index) => speaker(session, `4000000000000001${String(index).padStart(2, "0")}`))])]);
  await sleep(2_000);
  delay.disable();
  const after = await Promise.all(sessions.map(session => utterancesOf(session.id)));
  const errors = await events("voice.session.error");
  const ended = await events("voice.speech.ended");
  const workerRss = Math.round(process.memoryUsage().rss / 1_048_576);
  console.log(JSON.stringify({ type: "voice_load_workers", seconds: SECONDS, sessions: SESSIONS, speakers: SPEAKERS, utterances: after, atCrash, speeches: spoken, speechEnded: ended.length,
    errors: errors.map((event: any) => event.data.session === victim.id ? "victim" : "other"), host: host.stats(), rssMb: { start: startRss, end: workerRss },
    agentTurn: { tokens, longestGapMs: Math.round(longestGapMs) },
    eventLoopDelayMs: { p50: Math.round(delay.percentile(50) / 1e6), p99: Math.round(delay.percentile(99) / 1e6), max: Math.round(delay.max / 1e6) } }));

  assert.deepEqual(failures, [], "no codec, utterance or speech failure");
  assert.deepEqual(errors.map((event: any) => [event.data.session, event.data.restarting]), [[victim.id, true]], "only the crashed session's audio failed, and it restarted");
  for (let index = 1; index < sessions.length; index++) assert.ok(after[index] > atCrash[index], `session ${index} went on after the crash (${atCrash[index]} -> ${after[index]})`);
  assert.ok(after[0] > atCrash[0], `the crashed session went on after its restart (${atCrash[0]} -> ${after[0]})`);
  assert.ok(longestGapMs < 200, `the agent's turn on the node's thread never stalled (longest gap ${Math.round(longestGapMs)} ms)`);
  for (const session of sessions) assert.equal((await a.voice.get("alice", session.id)).state, "live", "every session still live");
});
