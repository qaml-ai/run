import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Opus } from "../src/opus.ts";
import { BargeIn, isBackchannel, realWords, type BargeInEvent } from "../src/voice/turns/barge-in.ts";
import { hostClient, startTurnModels, type TurnModels } from "../src/voice/turns/inference.ts";
import type { TurnClock, TurnEvent } from "../src/voice/turns/turn-taker.ts";
import { discordGrant, sleep, until, voiceCluster } from "./voice-fakes.ts";

/** Barge-in in group calls (src/voice/turns/barge-in.ts): its decisions on a simulated clock, then in a session. */

class SimClock implements TurnClock {
  time = 1_000_000;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private next = 0;
  now() { return this.time; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  advance(ms: number) {
    const to = this.time + ms;
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

function setup(policy = {}) {
  const clock = new SimClock();
  const barge = new BargeIn(policy, clock);
  const events: BargeInEvent["type"][] = [];
  barge.on(event => events.push(event.type));
  const start = (speaker = "a") => barge.turn({ type: "speech_start", speaker, at: clock.now() } as TurnEvent);
  const end = (speaker: string, speechMs: number) => barge.turn({ type: "turn_end", speaker, at: clock.now(), reason: "complete", startedAt: 0, speechMs, silenceMs: 500 } as TurnEvent);
  return { clock, barge, events, start, end };
}

test("backchannels, in many languages, are not words that take the turn", () => {
  for (const text of ["mm-hm", "Mhm.", "yeah yeah", "uh huh", "Okay!", "right, right", "sí", "vale", "ja genau", "oui d'accord", "да", "угу", "evet", "haan", "हाँ", "嗯", "嗯嗯", "うん", "はい", "네", "응", "vâng", "tá"]) {
    assert.ok(isBackchannel(text), text);
  }
  for (const text of ["wait", "no stop", "yeah but what about tomorrow", "hold on", "espera", "attends", "warte mal", "等一下", "ちょっと待って", ""]) {
    assert.ok(!isBackchannel(text), text);
  }
  assert.ok(isBackchannel("bet", ["bet"]), "a session's own backchannels");
});

test("echo: the bot's own words heard back through someone's speakers are not an interruption", () => {
  assert.equal(realWords("the weather in paris is", "The weather in Paris is sunny today.").echo, true);
  assert.deepEqual(realWords("wait what about london", "The weather in Paris is sunny today."), { words: ["wait", "what", "about", "london"], echo: false });
  assert.deepEqual(realWords("yeah ok", "Anything").words, []);
});

test("talking over the bot: it pauses at once, and stops only once it is real", () => {
  const { clock, barge, events, start } = setup();
  barge.botSpeaking("Here is the long answer you asked for.");
  start();
  assert.deepEqual(events, ["duck"]);
  clock.advance(300);
  barge.progress("a", 300);
  assert.deepEqual(events, ["duck"], "300 ms is not enough");
  clock.advance(500);
  barge.progress("a", 704);
  assert.deepEqual(events, ["duck", "barge_in"], "without transcripts, 700 ms of speech");
  assert.equal(barge.stats.bargeIns, 1);
});

test("with transcripts: a word beyond backchannels stops it at minMs; a backchannel resumes it", () => {
  const first = setup();
  first.barge.botSpeaking("Let me read you the list.");
  first.start();
  first.barge.interim("a", "wait");
  first.barge.progress("a", 200);
  assert.deepEqual(first.events, ["duck"], "under minMs");
  first.barge.progress("a", 420);
  assert.deepEqual(first.events, ["duck", "barge_in"]);

  const second = setup();
  second.barge.botSpeaking("Let me read you the list.");
  second.start();
  second.barge.interim("a", "mm-hm");
  second.barge.progress("a", 600);
  second.barge.progress("a", 900);
  second.end("a", 900);
  assert.deepEqual(second.events, ["duck", "backchannel", "unduck"]);
});

test("a cough, nothing real for resumeMs, or echo: it resumes; and two people hold it until both are done", () => {
  const cough = setup();
  cough.barge.botSpeaking("Something long.");
  cough.start();
  cough.end("a", 250);
  assert.deepEqual(cough.events, ["duck", "unduck"]);

  const quiet = setup({ resumeMs: 2_000 });
  quiet.barge.botSpeaking("Something long.");
  quiet.start();
  quiet.clock.advance(2_100);
  assert.deepEqual(quiet.events, ["duck", "unduck"]);

  const echo = setup();
  echo.barge.botSpeaking("The weather in Paris is sunny today.");
  echo.start();
  echo.barge.interim("a", "weather in paris is sunny");
  echo.barge.progress("a", 800);
  assert.deepEqual(echo.events, ["duck", "unduck"]);
  assert.equal(echo.barge.stats.echoes, 1);

  const two = setup();
  two.barge.botSpeaking("Something long.");
  two.start("a");
  two.start("b");
  two.end("a", 200);
  assert.deepEqual(two.events, ["duck"], "b still holds it");
  two.end("b", 300);
  assert.deepEqual(two.events, ["duck", "unduck"]);
});

test("nobody is interrupted when the bot is silent", () => {
  const { barge, events, start } = setup();
  start();
  barge.progress("a", 2_000);
  assert.deepEqual(events, []);
});

// In a session ------------------------------------------------------------------------------

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
/** `ms` of a clip's speech (from its first loud frame), as Discord's packets. */
function speech(name: string, ms: number): Uint8Array[] {
  const pcm = wav16(name);
  let from = 0;
  for (; from + 320 <= pcm.length; from += 320) {
    let sum = 0;
    for (let i = from; i < from + 320; i++) sum += pcm[i] * pcm[i];
    if (10 * Math.log10(sum / 320 / 32_768 ** 2 || 1e-12) > -35) break;
  }
  const encoder = new Opus(48_000, 2, "voip");
  const out: Uint8Array[] = [];
  for (let at = from; at + 320 <= Math.min(pcm.length, from + ms * 16); at += 320) {
    const frame = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) { const sample = pcm[at + Math.floor(i / 3)]; frame.writeInt16LE(sample, i * 4); frame.writeInt16LE(sample, i * 4 + 2); }
    out.push(new Uint8Array(encoder.encode(frame, 960)));
  }
  encoder.delete();
  return out;
}

let shared: { models: TurnModels; close(): Promise<void> } | undefined;
async function models(t: TestContext) {
  if (!shared) { const host = startTurnModels({ eotWorkers: 1 }); await host.ready; shared = { models: hostClient(host), close: () => host.close() }; }
  t.after(async () => { await shared?.close(); shared = undefined; });
  return shared.models;
}

test("in a session: a short sound pauses the bot and it goes on; talking over it stops it", { timeout: 120_000 }, async t => {
  const cluster = await voiceCluster(t, { turnModels: await models(t), playEveryMs: 20 });
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, speak: true });
  assert.deepEqual(created.interruption, { minMs: 400, minWords: 1, noTranscriptMs: 700, resumeMs: 2_000, backchannels: [] });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const play = async (list: Uint8Array[]) => { for (const packet of list) { connection.handlers.packet("400000000000000001", packet); await sleep(20); } };

  // The bot says something long (8 s); someone makes a short sound over it (~250 ms of speech).
  await a.voice.speak("alice", created.id, { text: "x".repeat(80) });
  await until(() => connection.playing && connection.played.at(-1)!.length > 10, "playing");
  let paused = false;
  const watch = setInterval(() => { paused ||= !!connection.paused; }, 5);
  t.after(() => clearInterval(watch));
  await play(speech("eng-c-0187c333.wav", 260));
  await sleep(1_500);
  assert.ok(paused, "paused while it was not known what the sound was");
  assert.ok(!connection.paused && connection.playing, "and went on");
  assert.equal((await cluster.events("voice.speech.ended")).length, 0, "not stopped");

  // Now someone talks over it for real: stopped (barge_in) about 0.7 s into their speech.
  const before = Date.now();
  await play(speech("spa-c-01d233b8.wav", 1_500));
  const [ended] = await until(async () => { const list = await cluster.events("voice.speech.ended"); return list.length && list; }, "stopped", 5_000);
  assert.equal(ended.data.reason, "interrupted");
  assert.equal(ended.data.by, "barge_in");
  assert.ok(Date.now() - before < 2_500);
});
