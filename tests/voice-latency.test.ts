import { test } from "node:test";
import assert from "node:assert/strict";
import { setMetricSink } from "../src/metrics.ts";
import { TurnClock, turnLatencyLine, WaitingTurns } from "../src/voice/latency.ts";
import { Webhooks } from "../src/webhooks.ts";
import { AGENT, discordGrant, sleep, speak, speechPacket, until, voiceCluster, type FakeConnection } from "./voice-fakes.ts";

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
  const turn = new TurnClock(1_000, { session: "vs_1", tenant: "alice", ttsModel: "tts" }).via("agent_reply");
  turn.mark("turnCommit", 1_800).mark("transcript", 2_100).mark("llmFirstToken", 2_600).mark("firstPiece", 2_900)
    .mark("ttsFirstAudio", 3_200).mark("ttsFirstAudio", 9_999).mark("firstPacket", 3_400);
  turn.end("spoken");
  turn.end("error");
  turn.mark("firstPacket", 1);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.outcome, "spoken");
  assert.equal(line.Path, "agent_reply");
  assert.deepEqual(line.stagesMs, { turnCommit: 800, transcript: 1_100, llmFirstToken: 1_600, firstPiece: 1_900, ttsFirstAudio: 2_200, firstPacket: 2_400 });
  assert.deepEqual([line.VoiceFirstPacketMs, line.VoiceSttMs, line.VoiceLlmMs, line.VoiceTtsMs, line.VoicePlayoutMs, line.VoiceTurns], [2_400, 300, 500, 300, 200, 1]);
  const metrics = line._aws.CloudWatchMetrics[0];
  assert.deepEqual(metrics.Dimensions, [[], ["Path"]]);
  assert.equal(metrics.Metrics.find((metric: any) => metric.Name === "VoiceFirstPacketMs").Unit, "Milliseconds");

  // A turn that never reached audio publishes no headline.
  const silent = JSON.parse(turnLatencyLine(new TurnClock(0, { session: "vs_1", tenant: "alice" }).mark("transcript", 400).mark("firstPacket", 900), "interrupted"));
  assert.equal(silent.VoiceFirstPacketMs, undefined);
  assert.equal(silent.VoiceTranscriptMs, 400);
  assert.equal(silent.Path, "none");
});

test("a turn waiting for the app's speech: the next one taken; a newer one replaces it; nobody's ends no_reply", async t => {
  const lines = turnLines(t);
  const waiting = new WaitingTurns(50);
  const first = new TurnClock(0, { session: "vs_1", tenant: "alice" });
  const second = new TurnClock(0, { session: "vs_1", tenant: "alice" });
  waiting.wait("vs_1", first);
  waiting.wait("vs_1", second);
  assert.equal(lines.at(-1).outcome, "no_reply");
  assert.ok(waiting.holds(second) && !waiting.holds(first));
  assert.equal(waiting.take("vs_1"), second);
  assert.equal(waiting.take("vs_1"), undefined);
  const third = new TurnClock(0, { session: "vs_2", tenant: "alice" });
  waiting.wait("vs_2", third);
  await sleep(100);
  assert.ok(third.ended);
  waiting.wait("vs_3", new TurnClock(0, { session: "vs_3", tenant: "alice" }));
  waiting.forget("vs_3");
  assert.equal(waiting.size, 0);
  assert.equal(lines.length, 2, "a forgotten turn writes nothing");
});

test("an agent's reply spoken: one line per turn, every stage from commit to first packet, in order", async t => {
  const lines = turnLines(t);
  async function* reply() { await sleep(30); yield "Sure, I can help with that. "; await sleep(30); yield "Here is more."; }
  const { fake, node } = await voiceCluster(t, { playEveryMs: 5, submitStreaming: () => reply() });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), speak: { agentReplies: true }, deliver: { agent: AGENT }, silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await talk(connection, "400000000000000004", 0.6);
  await until(() => lines.length === 1, "the turn's line");
  const [line] = lines;
  assert.equal(line.outcome, "spoken");
  assert.equal(line.Path, "agent_reply");
  assert.equal(line.seq, 1);
  assert.equal(line.sttModel, "gpt-transcribe");
  const stages = ["turnCommit", "transcript", "llmFirstToken", "firstPiece", "ttsFirstAudio", "firstPacket"];
  assert.deepEqual(Object.keys(line.stagesMs), stages);
  for (let i = 1; i < stages.length; i++) assert.ok(line.stagesMs[stages[i]] >= line.stagesMs[stages[i - 1]], `${stages[i]} after ${stages[i - 1]}`);
  // The segmenter waited out the silence (200 ms) before the cut.
  assert.ok(line.stagesMs.turnCommit >= 150, `commit after the silence (${line.stagesMs.turnCommit} ms)`);
  assert.ok(line.stagesMs.llmFirstToken - line.stagesMs.transcript >= 25, "the agent's 30 ms before its first text");
  await sleep(300);
  assert.equal(lines.length, 1, "the reply's second piece ends no other turn");
});

test("the app speaks after the transcript (POST …/speak): Path speak; an unanswered turn ends no_reply; a quiet session times nothing", async t => {
  const lines = turnLines(t);
  const { fake, node, events } = await voiceCluster(t, { playEveryMs: 5 });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), speak: true, silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 0.5);
  await until(async () => (await events("voice.utterance")).length === 1, "the utterance");
  await a.voice.speak("alice", created.id, { text: "a reply" });
  await until(() => lines.length === 1, "the turn's line");
  assert.equal(lines[0].Path, "speak");
  assert.equal(lines[0].outcome, "spoken");
  assert.ok(lines[0].stagesMs.firstPiece >= lines[0].stagesMs.transcript);
  // A speech nobody's turn waits for is not a turn.
  await a.voice.speak("alice", created.id, { text: "unprompted" });
  await until(async () => (await events("voice.speech.ended")).length === 2, "the second speech");
  assert.equal(lines.length, 1);
  // Two utterances, one answer: the first is replaced by the second, unanswered.
  speak(connection, "400000000000000004", 0.5);
  await until(async () => (await events("voice.utterance")).length === 2, "the second utterance");
  speak(connection, "400000000000000005", 0.5);
  await until(async () => (await events("voice.utterance")).length === 3, "the third utterance");
  await until(() => lines.length === 2, "the replaced turn");
  assert.equal(lines[1].outcome, "no_reply");

  const quiet = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000077" }) });
  const other = await until(() => fake.open().find(open => open.credentials.guildId === "100000000000000077"), "the quiet session's connection");
  other.handlers.ready();
  speak(other, "400000000000000004", 0.5);
  await until(async () => (await events("voice.utterance")).filter((event: any) => event.data.session === quiet.id).length === 1, "its utterance");
  await sleep(100);
  assert.equal(lines.length, 2, "a session that does not speak times no turns");
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
  const { fake, node, events } = await voiceCluster(t, { kickWebhooks: () => { kicks++; } });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 0.5);
  await until(async () => (await events("voice.utterance")).length === 1, "the utterance");
  await until(() => kicks === 1, "the kick");
});
