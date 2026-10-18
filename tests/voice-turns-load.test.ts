import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { clientFrom, startTurnModels, type TurnModels } from "../src/voice/turns/inference.ts";
import { TurnTaker, type TurnEvent } from "../src/voice/turns/turn-taker.ts";

/**
 * Turn-taking under load: SESSIONS sessions of SPEAKERS people (80 by default, as tests/voice-load.test.ts), every one
 * of them talking in real time (recorded turns, with pauses of 0.3-1.5 s between), each session's TurnTaker on one
 * node's shared models, for TURNS_LOAD_SECONDS (20 by default). Everyone talking at once is far past a real call (where
 * one or two speak at a time), so this bounds the cost. Reported: CPU (all threads, in cores), the event loop's delay,
 * VAD and Smart Turn round trips, and memory; asserted: no failure, VAD answers in time, memory bounded.
 */
const SECONDS = Number(process.env.TURNS_LOAD_SECONDS ?? 20);
const SESSIONS = Number(process.env.TURNS_LOAD_SESSIONS ?? 10);
const SPEAKERS = Number(process.env.TURNS_LOAD_SPEAKERS ?? 8);

function wav16(path: URL): Int16Array {
  const b = readFileSync(path);
  for (let off = 12; off < b.length;) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
    off += 8 + size;
  }
  throw new Error("no data chunk");
}
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN; };

test(`turn-taking under load: ${SESSIONS} sessions x ${SPEAKERS} speakers all talking, ${SECONDS} s`, { timeout: (SECONDS + 120) * 1_000 }, async t => {
  const fixtures = new URL("./fixtures/voice-turns/", import.meta.url);
  const clips = readdirSync(fixtures).filter(file => file.endsWith(".wav")).map(file => wav16(new URL(file, fixtures)));
  const host = startTurnModels();
  t.after(() => host.close());
  await host.ready;
  const vadMs: number[] = [], eotMs: number[] = [];
  const failures: string[] = [];
  const timed = (models: TurnModels): TurnModels => ({
    vad: async (input, state) => { const started = performance.now(); try { return await models.vad(input, state); } finally { vadMs.push(performance.now() - started); } },
    endOfTurn: async audio => { const started = performance.now(); try { return await models.endOfTurn(audio); } catch (error) { failures.push(`eot: ${(error as Error).message}`); throw error; } finally { eotMs.push(performance.now() - started); } },
    close: () => models.close(),
  });
  const counts: Record<string, number> = {};
  const sessions = Array.from({ length: SESSIONS }, () => {
    const turns = new TurnTaker({}, { models: timed(clientFrom(host.port())) });
    turns.on((event: TurnEvent) => { const key = event.type === "turn_end" ? `turn_end:${event.reason}` : event.type; counts[key] = (counts[key] ?? 0) + 1; });
    return turns;
  });
  type Talker = { session: number; id: string; clip?: Int16Array; at: number; silentUntil: number };
  const talkers: Talker[] = [];
  for (let s = 0; s < SESSIONS; s++) for (let p = 0; p < SPEAKERS; p++) talkers.push({ session: s, id: `4000000000000000${String(p).padStart(2, "0")}`, at: 0, silentUntil: performance.now() + Math.random() * 1_000 });

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const rss = () => Math.round(process.memoryUsage().rss / 1_048_576);
  const startRss = rss();
  // The model threads grow to their working set in the first seconds (each run's buffers, native), then stay.
  let warmRss = 0;
  const cpu = process.cpuUsage();
  const started = performance.now();
  let frames = 0;
  await new Promise<void>(resolve => {
    // Every 20 ms, each talker's next frame, or nothing while they pause (as Discord sends).
    let tick = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      // Catch up on ticks a slow loop skipped, so audio stays real-time.
      const due = Math.floor((now - started) / 20) - tick;
      for (let step = 0; step < due; step++, tick++) {
        for (const talker of talkers) {
          if (!talker.clip) {
            if (now < talker.silentUntil) continue;
            talker.clip = clips[Math.floor(Math.random() * clips.length)];
            talker.at = 0;
          }
          sessions[talker.session].frame(talker.id, talker.clip.subarray(talker.at, talker.at + 320));
          frames++;
          talker.at += 320;
          if (talker.at + 320 > talker.clip.length) { talker.clip = undefined; talker.silentUntil = now + 300 + Math.random() * 1_200; }
        }
      }
      if (!warmRss && now - started >= SECONDS * 300) warmRss = rss();
      if (now - started >= SECONDS * 1_000) { clearInterval(timer); resolve(); }
    }, 20);
  });
  await new Promise(resolve => setTimeout(resolve, 2_000));
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  delay.disable();
  for (const turns of sessions) turns.close();
  const stats = await clientFrom(host.port()).stats();
  const report = {
    type: "voice_turns_load", seconds: SECONDS, speakers: SESSIONS * SPEAKERS, frames,
    cores: Number(((used.user + used.system) / 1_000 / wallMs).toFixed(2)),
    loopDelayMs: { p50: Number((delay.percentile(50) / 1e6).toFixed(1)), p99: Number((delay.percentile(99) / 1e6).toFixed(1)), max: Number((delay.max / 1e6).toFixed(1)) },
    vadMs: { count: vadMs.length, p50: Number(percentile(vadMs, 0.5).toFixed(2)), p99: Number(percentile(vadMs, 0.99).toFixed(2)) },
    vadBatch: Number((stats.vadChunks / stats.vadBatches).toFixed(1)),
    eotMs: { count: eotMs.length, p50: Math.round(percentile(eotMs, 0.5)), p99: Math.round(percentile(eotMs, 0.99)) }, eotRefused: stats.eotRefused,
    events: counts, rssMb: { start: startRss, warm: warmRss, end: rss() }, heapMb: Math.round(process.memoryUsage().heapUsed / 1_048_576), externalMb: Math.round(process.memoryUsage().external / 1_048_576),
  };
  console.log(JSON.stringify(report));
  assert.ok(vadMs.length > SESSIONS * SPEAKERS * SECONDS * 10, `VAD ran (${vadMs.length} chunks)`);
  // A chunk is 32 ms of audio: answers well inside that keep up (CI runners are slower and shared, so with room).
  assert.ok(percentile(vadMs, 0.99) < 250, `VAD answers in time (p99 ${percentile(vadMs, 0.99)} ms)`);
  assert.ok((counts["turn_end:complete"] ?? 0) + (counts["turn_end:timeout"] ?? 0) > SESSIONS * SPEAKERS, "turns ended");
  assert.deepEqual(failures.filter(failure => !failure.includes("busy")), [], "no model failure but busy refusals");
  assert.ok(rss() - warmRss < 100, `memory bounded once warm (${startRss} -> ${warmRss} -> ${rss()} MB)`);
});
