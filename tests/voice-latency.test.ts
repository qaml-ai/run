import { test } from "node:test";
import assert from "node:assert/strict";
import { setMetricSink } from "../src/metrics.ts";
import { TurnClock, turnLatencyLine } from "../src/voice/latency.ts";
import { Webhooks } from "../src/webhooks.ts";
import { discordGrant, sleep, speak, speechPacket, until, voiceCluster, type FakeConnection } from "./voice-fakes.ts";

/** `seconds` of speech in real time, a packet every 20 ms, as a person's client sends it. */
async function talk(connection: FakeConnection, speaker: string, seconds: number) {
  for (let index = 0; index < Math.round(seconds * 50); index++) { connection.handlers.packet(speaker, speechPacket(index)); await sleep(20); }
}

/** voice_turn_latency lines written while `t` runs. */
function turnLines(t: { after(fn: () => void): void }) {
  const lines: any[] = [];
  setMetricSink(line => { const parsed = JSON.parse(line); if (parsed.type === "voice_turn_latency") lines.push(parsed); });
  t.after(() => setMetricSink());
  return lines;
}

test("a turn's line: each stage in ms since the end of speech, the stages' own lengths, by Path; marked once, ended once", t => {
  const lines = turnLines(t);
  const turn = new TurnClock(1_000, { session: "vs_1", tenant: "alice", ttsProvider: "openai", ttsModel: "gpt-realtime-2.1", speculative: false }).via("realtime");
  turn.mark("turnCommit", 1_800).mark("ttsFirstAudio", 2_500).mark("ttsFirstAudio", 9_999).mark("firstPacket", 2_700);
  turn.end("spoken");
  turn.end("error");
  turn.mark("firstPacket", 1);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.outcome, "spoken");
  assert.equal(line.Path, "realtime");
  assert.deepEqual([line.ttsProvider, line.ttsModel, line.speculative], ["openai", "gpt-realtime-2.1", false]);
  assert.deepEqual(line.stagesMs, { turnCommit: 800, ttsFirstAudio: 1_500, firstPacket: 1_700 });
  assert.deepEqual([line.VoiceFirstPacketMs, line.VoiceRealtimeMs, line.VoicePlayoutMs, line.VoiceTurns], [1_700, 700, 200, 1]);
  const metrics = line._aws.CloudWatchMetrics[0];
  assert.deepEqual(metrics.Dimensions, [[], ["Path"], ["Path", "Answer"], ["Path", "Answer", "Provider"]]);
  assert.equal(line.Answer, "direct");
  assert.equal(line.Provider, "openai");
  assert.equal(metrics.Metrics.find((metric: any) => metric.Name === "VoiceFirstPacketMs").Unit, "Milliseconds");

  // A turn that never reached audio publishes no headline.
  const silent = JSON.parse(turnLatencyLine(new TurnClock(0, { session: "vs_1", tenant: "alice" }).mark("turnCommit", 400).mark("firstPacket", 900), "interrupted"));
  assert.equal(silent.VoiceFirstPacketMs, undefined);
  assert.equal(silent.VoiceTurnCommitMs, 400);
  assert.equal(silent.VoiceRealtimeMs, undefined);
  assert.equal(silent.Path, "none");
});

test("an answer spoken: one line per turn, every stage from commit to first packet, in order, and on the speech's webhook", async t => {
  const lines = turnLines(t);
  const { fake, realtime, node, events } = await voiceCluster(t, { playEveryMs: 5 });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  const model = await until(() => realtime.connections[0], "the model");
  await talk(connection, "400000000000000004", 0.6);
  await until(() => model.responses === 1, "the answer asked for");
  await sleep(30);
  await model.answer("resp_1", { ms: 200 });
  await until(() => lines.length === 1, "the turn's line");
  const [line] = lines;
  assert.equal(line.outcome, "spoken");
  assert.equal(line.Path, "realtime");
  assert.deepEqual([line.ttsProvider, line.ttsModel], ["openai", "gpt-realtime-2.1"], "the realtime model made its audio");
  const stages = ["turnCommit", "ttsFirstAudio", "firstPacket"];
  assert.deepEqual(Object.keys(line.stagesMs), stages);
  for (let i = 1; i < stages.length; i++) assert.ok(line.stagesMs[stages[i]] >= line.stagesMs[stages[i - 1]], `${stages[i]} after ${stages[i - 1]}`);
  // The segmenter waited out the silence (200 ms) before the cut; the model took 30 ms more.
  assert.ok(line.stagesMs.turnCommit >= 150, `commit after the silence (${line.stagesMs.turnCommit} ms)`);
  assert.ok(line.stagesMs.ttsFirstAudio - line.stagesMs.turnCommit >= 25, "the model's 30 ms before its first audio");
  const [started] = await until(async () => { const list = await events("voice.speech.started"); return list.length === 1 && list; }, "the speech started");
  assert.deepEqual(started.data.turn, { path: "realtime", stagesMs: line.stagesMs });
  assert.ok(started.data.startedAt > 0);
});

test("a kick sends the outbox now, and a kick during a send makes another follow it", async () => {
  let sends = 0;
  const webhooks = new Webhooks({ db: {} as never, accounts: {} as never, outbound: {} as never });
  let finish!: () => void;
  (webhooks as any).sendFrom = async () => { sends++; if (sends === 1) await new Promise<void>(resolve => { finish = resolve; }); };
  webhooks.kick();
  await until(() => finish, "the first send");
  webhooks.kick();
  webhooks.kick();
  assert.equal(sends, 1, "one send at a time");
  finish();
  await until(() => sends === 4, "the follow-up send (two outboxes each)");
  await sleep(20);
  assert.equal(sends, 4, "two kicks during a send make one more, not two");
});

test("an utterance's webhook is kicked at once, not left to the outbox's scan", async t => {
  let kicks = 0;
  const { fake, realtime, node, events } = await voiceCluster(t, { kickWebhooks: () => { kicks++; } });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  const model = await until(() => realtime.connections[0], "the model");
  speak(connection, "400000000000000004", 0.5);
  const commit = await until(() => model.of("commit")[0], "the turn committed");
  model.events.heard(commit.tag, "hello", 0.5);
  await until(async () => (await events("voice.utterance")).length === 1, "the utterance");
  await until(() => kicks === 1, "the kick");
});
