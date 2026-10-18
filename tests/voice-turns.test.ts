import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { logMel, Resampler24To16, WHISPER } from "../src/voice/turns/features.ts";
import { clientFrom, startTurnModels, TurnModelsUnavailable, type TurnModels } from "../src/voice/turns/inference.ts";
import { TurnTaker, type TurnClock, type TurnEvent, type TurnPolicy } from "../src/voice/turns/turn-taker.ts";

/**
 * Turn-taking (src/voice/turns): Whisper features as Hugging Face computes them, the models in their worker threads,
 * and TurnTaker's decisions, on recorded speech (tests/fixtures/voice-turns: clips from pipecat's smart-turn test set,
 * CC-BY-4.0) and on a simulated clock.
 */

const FIXTURES = new URL("./fixtures/voice-turns/", import.meta.url);
const REFERENCE = JSON.parse(readFileSync(new URL("reference.json", FIXTURES), "utf8")) as Record<string, { probability: number; mean: number; indices: number[]; values: number[] }>;

function wav16(name: string): Int16Array {
  const b = readFileSync(new URL(name, FIXTURES));
  for (let off = 12; off < b.length;) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
    off += 8 + size;
  }
  throw new Error("no data chunk");
}

/** A clock whose time moves only when told; timers due on the way run in order. */
class SimClock implements TurnClock {
  time = 1_000_000;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private next = 0;
  now() { return this.time; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  advance(to: number) {
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= to && (!first || entry[1].at < first[1].at)) first = entry;
      if (!first) break;
      this.timers.delete(first[0]);
      this.time = Math.max(this.time, first[1].at);
      first[1].fn();
    }
    this.time = to;
  }
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

/**
 * Models that answer at once: speech wherever a chunk is louder than -40 dBFS, and the end-of-turn probability the
 * test sets (or a failure).
 */
function fakeModels(endOfTurn: () => number | Error = () => 0.9) {
  const calls = { vad: 0, eot: 0 };
  const models: TurnModels = {
    async vad(input, state) {
      calls.vad++;
      let sum = 0;
      for (let i = 64; i < input.length; i++) sum += input[i] * input[i];
      return { probability: 10 * Math.log10(sum / 512 || 1e-12) > -40 ? 0.95 : 0.02, state };
    },
    async endOfTurn() {
      calls.eot++;
      const answer = endOfTurn();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    close() {},
  };
  return { models, calls };
}

/** 20 ms frames of a tone (speech, to the fake VAD) for `ms`, then nothing (a Discord user who stopped talking). */
const tone = (ms: number, amplitude = 8_000) => Int16Array.from({ length: ms * 16 }, (_, i) => Math.round(amplitude * Math.sin(2 * Math.PI * 220 * i / 16_000)));

async function play(turns: TurnTaker, clock: SimClock, speaker: string, pcm: Int16Array) {
  for (let at = 0; at + 320 <= pcm.length; at += 320) {
    clock.advance(clock.now() + 20);
    turns.frame(speaker, pcm.subarray(at, at + 320), clock.now());
    await settle();
  }
}
async function wait(clock: SimClock, ms: number) {
  const end = clock.now() + ms;
  while (clock.now() < end) { clock.advance(Math.min(end, clock.now() + 20)); await settle(); }
}
function recorder(turns: TurnTaker, start: () => number) {
  const events: (TurnEvent & { t: number })[] = [];
  turns.on(event => events.push({ ...event, t: event.at - start() }));
  return events;
}

test("Whisper features match Hugging Face's WhisperFeatureExtractor (chunk_length 8, normalized)", () => {
  for (const [file, reference] of Object.entries(REFERENCE)) {
    const pcm = wav16(file);
    const features = logMel(Float32Array.from(pcm, sample => sample / 32_768));
    assert.equal(features.length, WHISPER.mels * WHISPER.frames);
    let max = 0;
    reference.indices.forEach((index, i) => { max = Math.max(max, Math.abs(features[index] - reference.values[i])); });
    assert.ok(max < 1e-4, `${file}: sampled features within 1e-4 (${max})`);
    const mean = features.reduce((sum, value) => sum + value, 0) / features.length;
    assert.ok(Math.abs(mean - reference.mean) < 1e-5, `${file}: mean ${mean} vs ${reference.mean}`);
  }
});

test("resampling 24 kHz to 16 kHz keeps 20 ms frames 20 ms and passes speech-band tones", () => {
  const resampler = new Resampler24To16();
  const out: number[] = [];
  for (let frame = 0; frame < 50; frame++) {
    const pcm = Int16Array.from({ length: 480 }, (_, i) => Math.round(10_000 * Math.sin(2 * Math.PI * 1_000 * (frame * 480 + i) / 24_000)));
    const resampled = resampler.push(pcm);
    assert.ok(Math.abs(resampled.length - 320) <= 1, `frame ${frame}: ${resampled.length} samples`);
    out.push(...resampled);
  }
  // A 1 kHz tone keeps its level (after the filter's start).
  const tail = out.slice(1_000);
  const rms = Math.sqrt(tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length);
  assert.ok(Math.abs(rms - 10_000 / Math.SQRT2) < 300, `rms ${rms}`);
});

test("the models: Smart Turn agrees with the reference on recorded turns, Silero hears speech and not silence or noise", { timeout: 120_000 }, async t => {
  const host = startTurnModels({ eotWorkers: 1 });
  t.after(() => host.close());
  await host.ready;
  const models = clientFrom(host.port());
  for (const [file, reference] of Object.entries(REFERENCE)) {
    const probability = await models.endOfTurn(wav16(file));
    assert.equal(probability >= 0.5, reference.probability >= 0.5, `${file}: ${probability} vs reference ${reference.probability}`);
    assert.ok(Math.abs(probability - reference.probability) < 0.1, `${file}: ${probability} vs reference ${reference.probability}`);
  }
  const speechShare = async (pcm: Int16Array) => {
    let state: Float32Array = new Float32Array(256), context = new Float32Array(64), speech = 0, chunks = 0;
    for (let at = 0; at + 512 <= pcm.length; at += 512, chunks++) {
      const input = new Float32Array(576);
      input.set(context);
      for (let i = 0; i < 512; i++) input[64 + i] = pcm[at + i] / 32_768;
      context = input.slice(512);
      const out = await models.vad(input, state);
      state = out.state;
      if (out.probability >= 0.5) speech++;
    }
    return speech / chunks;
  };
  assert.ok(await speechShare(wav16("eng-c-0187c333.wav")) > 0.4, "speech is heard");
  assert.equal(await speechShare(new Int16Array(16_000)), 0, "digital silence is not speech");
  // Steady noise at -35 dBFS: louder than the energy segmenter's -45 dBFS bar, but not speech.
  const noise = Int16Array.from({ length: 32_000 }, () => Math.round((Math.random() * 2 - 1) * 32_768 * 10 ** (-35 / 20) * Math.sqrt(3)));
  assert.ok(await speechShare(noise) < 0.05, "noise is not speech");
  const stats = await models.stats();
  assert.ok(stats.vadChunks > 0);
  assert.equal(process.env.ORT_DISABLE_TELEMETRY, "1", "onnxruntime's telemetry is off");
  models.close();
});

test("a turn: speech_start, likely_end at checkMs (200 ms) of silence, turn_end at commitMs (500 ms)", async () => {
  const clock = new SimClock();
  const { models, calls } = fakeModels(() => 0.9);
  const turns = new TurnTaker({}, { models, clock });
  const start = clock.now();
  const events = recorder(turns, () => start);
  await play(turns, clock, "alice", tone(1_000));
  const spokeUntil = clock.now() - start;
  await wait(clock, 2_000);
  assert.deepEqual(events.map(event => event.type), ["speech_start", "likely_end", "turn_end"]);
  assert.ok(events[0].t <= 120, `speech_start at ${events[0].t}`);
  const likely = events[1].t - spokeUntil, end = events[2].t - spokeUntil;
  assert.ok(likely >= 150 && likely <= 280, `likely_end ${likely} ms after speech`);
  assert.ok(end >= 460 && end <= 580, `turn_end ${end} ms after speech`);
  assert.equal((events[2] as Extract<TurnEvent, { type: "turn_end" }>).reason, "complete");
  assert.equal(calls.eot, 1);
});

test("an incomplete turn waits for the speaker: they go on (one turn), or it ends at maxSilenceMs", async () => {
  const clock = new SimClock();
  const turns = new TurnTaker({}, { models: fakeModels(() => 0.1).models, clock });
  const start = clock.now();
  const events = recorder(turns, () => start);
  await play(turns, clock, "bob", tone(800));
  await wait(clock, 900);
  await play(turns, clock, "bob", tone(600));
  const spokeUntil = clock.now() - start;
  await wait(clock, 2_000);
  assert.deepEqual(events.map(event => event.type), ["speech_start", "turn_end"], "a pause it judged incomplete does not end the turn");
  const end = events[1] as Extract<TurnEvent, { type: "turn_end" }> & { t: number };
  assert.equal(end.reason, "timeout");
  assert.ok(end.t - spokeUntil >= 1_350 && end.t - spokeUntil <= 1_500, `ended ${end.t - spokeUntil} ms after speech`);
});

test("speaking again after likely_end, before the commit, is resume (and the turn goes on)", async () => {
  const clock = new SimClock();
  const turns = new TurnTaker({ endOfTurn: { commitMs: 600 } as TurnPolicy["endOfTurn"] }, { models: fakeModels(() => 0.8).models, clock });
  const events = recorder(turns, () => 0);
  await play(turns, clock, "carol", tone(600));
  await wait(clock, 400);
  await play(turns, clock, "carol", tone(400));
  await wait(clock, 2_000);
  assert.deepEqual(events.map(event => event.type), ["speech_start", "likely_end", "resume", "likely_end", "turn_end"]);
  assert.equal(turns.stats.resumes, 1);
});

test("speakers are independent: each has its own turn", async () => {
  const clock = new SimClock();
  const turns = new TurnTaker({}, { models: fakeModels(() => 0.9).models, clock });
  const events = recorder(turns, () => 0);
  const a = tone(600), b = tone(900);
  for (let at = 0; at + 320 <= b.length; at += 320) {
    clock.advance(clock.now() + 20);
    if (at + 320 <= a.length) turns.frame("a", a.subarray(at, at + 320), clock.now());
    turns.frame("b", b.subarray(at, at + 320), clock.now());
    await settle();
  }
  await wait(clock, 1_000);
  const ends = events.filter(event => event.type === "turn_end");
  assert.deepEqual(ends.map(event => event.speaker), ["a", "b"]);
});

test("without the models (failing, busy or none) turns end on silence alone", async () => {
  for (const models of [fakeModels(() => new TurnModelsUnavailable("busy", true)).models, undefined]) {
    const clock = new SimClock();
    const turns = new TurnTaker({ endOfTurn: { silenceMs: 700 } as TurnPolicy["endOfTurn"] }, { ...(models ? { models } : {}), clock });
    const start = clock.now();
    const events = recorder(turns, () => start);
    await play(turns, clock, "dan", tone(500));
    const spokeUntil = clock.now() - start;
    await wait(clock, 1_500);
    const end = events.find(event => event.type === "turn_end") as Extract<TurnEvent, { type: "turn_end" }> & { t: number };
    assert.equal(end?.reason, "silence");
    assert.ok(end.t - spokeUntil >= 650 && end.t - spokeUntil <= 800, `ended ${end.t - spokeUntil} ms after speech`);
  }
});

test("a short click is not a turn, and a turn longer than maxTurnMs is cut (max)", async () => {
  const clock = new SimClock();
  const turns = new TurnTaker({ maxTurnMs: 2_000 }, { models: fakeModels(() => 0.9).models, clock });
  const events = recorder(turns, () => 0);
  await play(turns, clock, "eve", tone(40));
  await wait(clock, 1_000);
  assert.equal(events.length, 0, "40 ms is not speech");
  await play(turns, clock, "eve", tone(3_000));
  await wait(clock, 1_000);
  const reasons = events.filter(event => event.type === "turn_end").map(event => (event as Extract<TurnEvent, { type: "turn_end" }>).reason);
  assert.equal(reasons[0], "max");
});

test("recorded turns end as they should through the real models: complete ones fast, incomplete ones held", { timeout: 120_000 }, async t => {
  const host = startTurnModels({ eotWorkers: 1 });
  t.after(() => host.close());
  await host.ready;
  const client = clientFrom(host.port());
  // Answers before time moves on: what is measured is the decision.
  let inFlight = 0;
  const track = <T>(promise: Promise<T>) => { inFlight++; return promise.finally(() => inFlight--); };
  const models: TurnModels = { vad: (input, state) => track(client.vad(input, state)), endOfTurn: audio => track(client.endOfTurn(audio)), close() {} };
  for (const [file, reference] of Object.entries(REFERENCE)) {
    const clock = new SimClock();
    const turns = new TurnTaker({}, { models, clock });
    const events: TurnEvent[] = [];
    turns.on(event => events.push(event));
    const pcm = wav16(file);
    for (let at = 0; at + 320 <= pcm.length; at += 320) {
      clock.advance(clock.now() + 20);
      turns.frame("speaker", pcm.subarray(at, at + 320), clock.now());
      while (inFlight) await new Promise(resolve => setImmediate(resolve));
    }
    const audioEnd = clock.now();
    for (let ms = 0; ms < 2_000; ms += 20) { clock.advance(clock.now() + 20); while (inFlight) await new Promise(resolve => setImmediate(resolve)); }
    const end = events.findLast(event => event.type === "turn_end") as Extract<TurnEvent, { type: "turn_end" }> | undefined;
    assert.ok(end, `${file}: the turn ended`);
    if (reference.probability >= 0.5) assert.equal(end.reason, "complete", `${file}: complete`);
    else {
      assert.equal(end.reason, "timeout", `${file}: held for the speaker`);
      assert.ok(end.at - audioEnd >= 1_000, `${file}: waited ${end.at - audioEnd} ms`);
    }
  }
  client.close();
});

test("the models' worker dying fails pending calls at once, and it is started again", { timeout: 60_000 }, async t => {
  const exits: number[] = [];
  const host = startTurnModels({ eotWorkers: 1, restartMs: 50, onExit: code => exits.push(code) });
  t.after(() => host.close());
  await host.ready;
  const models = clientFrom(host.port());
  const pending = assert.rejects(models.endOfTurn(wav16("eng-c-0187c333.wav")), TurnModelsUnavailable);
  // End the host thread, as a crash would.
  await host.thread!.terminate();
  await pending;
  await assert.rejects(models.vad(new Float32Array(576), new Float32Array(256)), TurnModelsUnavailable, "a dead client fails fast");
  assert.equal(exits.length, 1);
  // Started again: a new port works.
  await host.ready;
  const again = clientFrom(host.port());
  assert.ok((await again.endOfTurn(wav16("eng-c-0187c333.wav"))) > 0.5);
  again.close();
});
