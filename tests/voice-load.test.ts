import { test } from "node:test";
import assert from "node:assert/strict";
import { opusStats } from "../src/opus.ts";
import { discordGrant, sleep, speechPacket, until, voiceCluster, type FakeConnection } from "./voice-fakes.ts";

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
  const watch = (line: unknown) => {
    const text = String(line);
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
  const codecs = opusStats();
  console.log(JSON.stringify({ type: "voice_load", seconds: SECONDS, sessions: SESSIONS, speakers: SPEAKERS, packets, utterances, transcriptions: transcribed,
    speeches: spoken, queueFull: refused, speechEnded: ended.length, reasons: ended.reduce((counts: Record<string, number>, event: any) => ({ ...counts, [event.data.reason]: (counts[event.data.reason] ?? 0) + 1 }), {}), rssMb: { start: startRss, end: endRss }, codecs }));

  assert.deepEqual(failures, [], "no codec, utterance or speech failure");
  assert.ok(utterances >= SESSIONS * SPEAKERS, `utterances were cut and delivered (${utterances})`);
  assert.ok(ended.length >= SESSIONS, `speech played (${ended.length} ended)`);
  assert.ok(!ended.some((event: any) => event.data.reason === "error"), "no speech ended in error");
  // Every utterance's decoder and every speech's encoder is freed: what is left is what is open now, at most one each.
  assert.ok(codecs.live <= SESSIONS * (SPEAKERS + 1), `codecs freed (${codecs.live} alive)`);
  assert.ok(endRss - startRss < 150, `memory stayed bounded (${startRss} -> ${endRss} MB)`);
  for (const session of sessions) assert.equal((await a.voice.get("alice", session.id)).state, "live", "every session still live");
});
