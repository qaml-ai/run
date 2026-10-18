import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFrom, startTurnModels, type TurnModels } from "../src/voice/turns/inference.ts";
import { TurnTaker, type TurnClock, type TurnEvent, type TurnPolicy } from "../src/voice/turns/turn-taker.ts";

/**
 * Turn-taking measured on labelled turns: each clip (16 kHz mono WAV) is played to a TurnTaker as a Discord user's
 * audio (20 ms frames, then no frames: silence), on a simulated clock (models answer before time moves on, so this
 * measures decisions; their CPU time is measured apart, in tests/voice-turns-load.test.ts).
 *
 *   node --experimental-strip-types scripts/voice-turns-eval.ts <clips dir> [--config name ...]
 *
 * The clips dir has index.json: [{ file, language, complete }], `complete` true when the clip ends a turn (the speaker
 * is done), false when it stops mid-thought. scripts/voice-turns-dataset.py makes one from pipecat's smart-turn test
 * set (CC-BY-4.0). For each config it reports:
 *
 * - midCut: clips with a turn_end before the end of speech (the last loud frame): cut off in a pause; unmended, those
 *   where they did not talk again within MERGE_MS (merging the turns mends the rest before a reply plays);
 * - incompleteCut: clips that stop mid-thought ended as `complete` (a reply would start while they think); under 1 s,
 *   those ended (for any reason) within a second of their last word; and how long they waited (median);
 * - complete: for clips that end a turn, end of speech to turn_end, median and p90, and how many took over 1 s;
 * - discard: likely_end events followed by `resume` (speculative work thrown away).
 */

type Clip = { file: string; language: string; complete: boolean };
type Outcome = {
  clip: Clip;
  /** A turn_end before the end of speech, and whether they spoke again within MERGE_MS of each (a merge would mend it). */
  midCuts: number; unmended: number;
  endedAs?: string; latencyMs?: number; likely: number; resumes: number;
};
/** A cut the speaker talks over this soon is mended by merging the two turns, before a reply plays. */
const MERGE_MS = 600;

function wav16(path: string): Int16Array {
  const b = readFileSync(path);
  for (let off = 12; off < b.length;) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
    off += 8 + size;
  }
  throw new Error(`${path}: no data chunk`);
}

class SimClock implements TurnClock {
  time = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 0;
  now() { return this.time; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  /** Move to `to`, running each timer due on the way, in order. */
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

/** Models that count what is in flight, so the simulation waits for answers before time moves on. */
function counted(models: TurnModels) {
  let inFlight = 0;
  const track = <T>(promise: Promise<T>) => { inFlight++; return promise.finally(() => inFlight--); };
  return {
    models: { vad: (input: Float32Array, state: Float32Array) => track(models.vad(input, state)), endOfTurn: (audio: Int16Array) => track(models.endOfTurn(audio)), close() {} } satisfies TurnModels,
    async settle() { while (inFlight) await new Promise(resolve => setImmediate(resolve)); },
  };
}

/** The end of speech: the last 20 ms frame louder than -40 dBFS. */
function speechEndMs(pcm: Int16Array) {
  for (let end = pcm.length; end >= 320; end -= 320) {
    let sum = 0;
    for (let i = end - 320; i < end; i++) sum += pcm[i] * pcm[i];
    if (10 * Math.log10(sum / 320 / 32_768 ** 2 || 1e-12) > -40) return end / 16;
  }
  return 0;
}

async function play(clip: Clip, pcm: Int16Array, policy: Partial<TurnPolicy>, models: ReturnType<typeof counted> | undefined): Promise<Outcome> {
  const clock = new SimClock();
  const turns = new TurnTaker(policy, { clock, ...(models ? { models: models.models } : {}) });
  const events: TurnEvent[] = [];
  turns.on(event => events.push(event));
  const start = clock.now();
  for (let at = 0; at + 320 <= pcm.length; at += 320) {
    clock.advance(start + (at + 320) / 16);
    turns.frame("speaker", pcm.subarray(at, at + 320), clock.now());
    await models?.settle();
  }
  const audioEnd = clock.now();
  // Then silence: no frames, for longer than any wait.
  for (let t = audioEnd + 20; t <= audioEnd + 3_000; t += 20) {
    clock.advance(t);
    await models?.settle();
  }
  turns.close();
  const ends = events.filter(event => event.type === "turn_end") as Extract<TurnEvent, { type: "turn_end" }>[];
  const starts = events.filter(event => event.type === "speech_start");
  const speechEnd = start + speechEndMs(pcm);
  const mid = ends.filter(event => event.at < speechEnd);
  const unmended = mid.filter(event => !starts.some(next => next.at >= event.at - 100 && next.at <= event.at + MERGE_MS)).length;
  const final = ends.find(event => event.at >= speechEnd);
  return {
    clip, midCuts: mid.length, unmended, ...(final ? { endedAs: final.reason, latencyMs: final.at - speechEnd } : {}),
    likely: events.filter(event => event.type === "likely_end").length, resumes: events.filter(event => event.type === "resume").length,
  };
}

const CONFIGS: Record<string, { policy: Partial<TurnPolicy>; models: boolean }> = {
  "energy+silence800 (before)": { policy: { endOfTurn: { mode: "silence", silenceMs: 800 } as TurnPolicy["endOfTurn"] }, models: false },
  "silero+silence800": { policy: { endOfTurn: { mode: "silence", silenceMs: 800 } as TurnPolicy["endOfTurn"] }, models: true },
  "silero+silence500": { policy: { endOfTurn: { mode: "silence", silenceMs: 500 } as TurnPolicy["endOfTurn"] }, models: true },
  "smart (200/300, 0.5)": { policy: { endOfTurn: { commitMs: 300 } as TurnPolicy["endOfTurn"] }, models: true },
  "smart fast (150/200, 0.5)": { policy: { endOfTurn: { checkMs: 150, commitMs: 200 } as TurnPolicy["endOfTurn"] }, models: true },
  "smart (200/400, 0.5)": { policy: { endOfTurn: { commitMs: 400 } as TurnPolicy["endOfTurn"] }, models: true },
  "smart default (200/500, 0.5, cap 1400)": { policy: {}, models: true },
  "smart patient (300/700, 0.5)": { policy: { endOfTurn: { checkMs: 300, commitMs: 700 } as TurnPolicy["endOfTurn"] }, models: true },
  "smart strict (200/500, 0.7)": { policy: { endOfTurn: { threshold: 0.7 } as TurnPolicy["endOfTurn"] }, models: true },
  "smart loose (200/500, 0.3)": { policy: { endOfTurn: { threshold: 0.3 } as TurnPolicy["endOfTurn"] }, models: true },
};

const LANES = 4;
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN; };
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "-";

function report(name: string, outcomes: Outcome[]) {
  const complete = outcomes.filter(o => o.clip.complete), incomplete = outcomes.filter(o => !o.clip.complete);
  const latencies = complete.filter(o => o.latencyMs !== undefined).map(o => o.latencyMs!);
  const waits = incomplete.filter(o => o.latencyMs !== undefined).map(o => o.latencyMs!);
  const likely = outcomes.reduce((n, o) => n + o.likely, 0), resumes = outcomes.reduce((n, o) => n + o.resumes, 0);
  return {
    config: name, clips: outcomes.length,
    // Cut in a pause before they finished: any, and those they did not talk over within MERGE_MS.
    midCut: pct(outcomes.filter(o => o.midCuts).length, outcomes.length),
    midCutUnmended: pct(outcomes.filter(o => o.unmended).length, outcomes.length),
    // Stopped mid-thought, and ended as complete (a reply would start while they think).
    incompleteCut: pct(incomplete.filter(o => o.endedAs === "complete").length, incomplete.length),
    incompleteUnder1s: pct(incomplete.filter(o => (o.latencyMs ?? Infinity) < 1_000).length, incomplete.length),
    incompleteWaitP50: Math.round(percentile(waits, 0.5)),
    completeP50: Math.round(percentile(latencies, 0.5)), completeP90: Math.round(percentile(latencies, 0.9)),
    completeLate: pct(complete.filter(o => (o.latencyMs ?? Infinity) > 1_000).length, complete.length),
    discard: pct(resumes, likely),
  };
}

async function main() {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) throw new Error("usage: voice-turns-eval.ts <clips dir> [--config name] [--by-language]");
  const only = rest.filter((_, i) => rest[i - 1] === "--config");
  const byLanguage = rest.includes("--by-language");
  const clips = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Clip[];
  const host = startTurnModels({ eotWorkers: LANES });
  await host.ready;
  const client = clientFrom(host.port());
  const rows = [];
  const languageRows = [];
  for (const [name, config] of Object.entries(CONFIGS)) {
    if (only.length && !only.includes(name)) continue;
    // A few clips at a time, each on its own clock and models' counter.
    const outcomes: Outcome[] = new Array(clips.length);
    await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
      const mine = counted(client);
      for (let i = lane; i < clips.length; i += LANES) outcomes[i] = await play(clips[i], wav16(join(dir, clips[i].file)), config.policy, config.models ? mine : undefined);
    }));
    rows.push(report(name, outcomes));
    if (byLanguage) for (const language of [...new Set(clips.map(c => c.language))].sort()) languageRows.push({ ...report(name, outcomes.filter(o => o.clip.language === language)), language });
  }
  console.table(rows);
  if (languageRows.length) console.table(languageRows);
  await host.close();
}

await main();
