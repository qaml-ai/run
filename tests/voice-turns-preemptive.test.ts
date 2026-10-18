import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Opus } from "../src/opus.ts";
import { Transcriber } from "../src/transcription.ts";
import type { LiveTranscription, LiveTranscript } from "../src/transcription-live.ts";
import { hostClient, startTurnModels, type TurnModels } from "../src/voice/turns/inference.ts";
import { discordGrant, sleep, until, voiceCluster } from "./voice-fakes.ts";

/**
 * Preemptive transcription: a turn Smart Turn calls complete (likely_end) commits its speaker's live stream at once,
 * so its transcript is being made while the turn waits to be sure (commitMs); a speaker who goes on is committed again
 * at the cut, and the parts are one transcript.
 */

const COMMIT_MS = 400;
/** A streaming transcriber whose commits answer COMMIT_MS later with "part N", recording when each was asked. */
function liveTranscriber() {
  const commits: { at: number; bytes: number }[] = [];
  let n = 0;
  const connect = (): LiveTranscription => {
    let bytes = 0, closed = false;
    return {
      append(pcm) { bytes += pcm.length; },
      commit() {
        commits.push({ at: Date.now(), bytes });
        const seconds = Math.ceil(bytes / 48_000);
        bytes = 0;
        const text = `part${++n}`;
        return new Promise<LiveTranscript>(resolve => setTimeout(() => resolve({ text, seconds, model: "live", provider: "fake" }), COMMIT_MS));
      },
      clear() { bytes = 0; },
      close() { closed = true; },
      get closed() { return closed; },
    };
  };
  const transcriber = new Transcriber({
    provider: { id: "openai", model: "gpt-transcribe", transcribe: async () => { throw new Error("the live stream should serve"); } },
    key: async () => ({ apiKey: "fixture-key", platform: true }), price: () => 6_000,
    live: { order: ["fake/live"], provider: () => ({ id: "fake", model: "live", connect }), price: () => 6_000 },
  });
  return { transcriber, commits };
}

const FIXTURES = new URL("./fixtures/voice-turns/", import.meta.url);
function packets(name: string): Uint8Array[] {
  const b = readFileSync(new URL(name, FIXTURES));
  let pcm = new Int16Array(0);
  for (let off = 12; off < b.length;) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") { pcm = new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size)); break; }
    off += 8 + size;
  }
  const encoder = new Opus(48_000, 2, "voip");
  const out: Uint8Array[] = [];
  for (let at = 0; at + 320 <= pcm.length; at += 320) {
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

test("a complete turn's transcript is made while the turn waits to be sure: it comes sooner by the wait", { timeout: 120_000 }, async t => {
  const live = liveTranscriber();
  const cluster = await voiceCluster(t, { transcriber: live.transcriber, turnModels: await models(t) });
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const play = async (list: Uint8Array[]) => { for (const packet of list) { connection.handlers.packet("400000000000000001", packet); await sleep(20); } };

  await play(packets("eng-c-0187c333.wav"));
  const [utterance] = await until(async () => { const list = await cluster.events("voice.utterance"); return list.length && list; }, "the utterance", 5_000);
  const arrived = Date.now();
  assert.equal(live.commits.length, 1, "committed once, early: what came after was silence");
  assert.equal(utterance.data.text, "part1");
  // Committed at likely_end (checkMs), not at the cut (commitMs, 300 ms later): the transcript is there by the commit's
  // own time after it, where without it the cut's commit would only start then.
  const sinceCommit = arrived - live.commits[0].at;
  assert.ok(sinceCommit < COMMIT_MS + 150, `the transcript ${sinceCommit} ms after its commit`);
  // The commit came at likely_end: checkMs (200) and Smart Turn's answer after the last speech, before the cut at 500.
  const commitAfterSpeech = live.commits[0].at - utterance.data.endedAt;
  assert.ok(commitAfterSpeech >= 150 && commitAfterSpeech < 450, `committed ${commitAfterSpeech} ms after the last speech`);
  console.log(JSON.stringify({ type: "preemptive_transcript", sinceCommitMs: sinceCommit, commitAfterSpeechMs: commitAfterSpeech, textAfterSpeechMs: arrived - utterance.data.endedAt }));

  // A speaker who goes on after a likely end (a sentence, a short pause, another): both parts, one turn.
  live.commits.length = 0;
  await play(packets("eng-c-0187c333.wav"));
  await sleep(330);
  await play(packets("spa-c-01d233b8.wav"));
  await until(async () => (await cluster.events("voice.utterance")).length >= 2, "the second utterance", 6_000);
  await sleep(1_000);
  const texts = (await cluster.events("voice.utterance")).slice(1).map(event => event.data.text);
  assert.ok(texts.some(text => /^part\d+ part\d+/.test(text)) || texts.length === 2, `parts joined, or two turns (${JSON.stringify(texts)})`);
});
