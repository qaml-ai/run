import { test } from "node:test";
import assert from "node:assert/strict";
import { setMetricSink } from "../src/metrics.ts";
import { Synthesizer } from "../src/speech.ts";
import { SpokenReply } from "../src/voice-speech.ts";
import type { VoiceTransport } from "../src/voice-sessions.ts";
import { AGENT, discordGrant, fakeTransport, sleep, speechPacket, until, voiceCluster, type FakeConnection } from "./voice-fakes.ts";

/** A speech provider that takes `firstByteMs` before its first audio (as a real one does), then makes it 5x faster than it plays. */
function slowStartSynthesizer(firstByteMs: number) {
  const calls: { text: string; at: number }[] = [];
  const synthesizer = new Synthesizer({
    provider: {
      id: "openai", model: "gpt-4o-mini-tts",
      async *stream(input, _credentials, signal) {
        calls.push({ text: input.text, at: performance.now() });
        await sleep(firstByteMs);
        const total = Math.round(input.text.length / 20 * 24_000);
        for (let at = 0; at < total; at += 2_400) {
          if (signal.aborted) throw signal.reason;
          const chunk = Buffer.alloc(Math.min(2_400, total - at) * 2);
          for (let i = 0; i < chunk.length / 2; i++) chunk.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 220 * (at + i) / 24_000)), i * 2);
          yield chunk;
          await sleep(20);
        }
      },
    },
    key: async () => ({ apiKey: "fixture-key", platform: true }),
    price: () => 15_000,
  });
  return { synthesizer, calls };
}

/** The fake transport, with when each playback's first and last packets went out (packets go out every 20 ms, as a player sends them). */
function timedTransport() {
  const fake = fakeTransport(20);
  const plays: { first?: number; last?: number }[] = [];
  const transport: VoiceTransport = {
    speaks: true,
    connect(credentials, handlers) {
      const connection = fake.transport.connect(credentials, handlers);
      return {
        ...connection,
        play(packets, started) {
          const timing: { first?: number; last?: number } = {};
          plays.push(timing);
          async function* timed() { for await (const packet of packets) { timing.first ??= performance.now(); timing.last = performance.now(); yield packet; } }
          return connection.play!(timed(), started);
        },
      };
    },
  };
  return { fake, transport, plays };
}

async function talk(connection: FakeConnection, speaker: string, seconds: number) {
  for (let index = 0; index < Math.round(seconds * 50); index++) { connection.handlers.packet(speaker, speechPacket(index)); await sleep(20); }
}

test("a reply's next sentence is made while the one before plays: no provider round trip falls between them", { timeout: 60_000 }, async t => {
  const FIRST_BYTE_MS = 300;
  const { synthesizer, calls } = slowStartSynthesizer(FIRST_BYTE_MS);
  const { transport, fake, plays } = timedTransport();
  async function* reply() { yield "The first sentence is right here. The second one comes next. And a third to end on."; }
  const { node, events } = await voiceCluster(t, { transports: { discord: transport }, synthesizer, submitStreaming: () => reply() });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), speak: { agentReplies: true }, deliver: { agent: AGENT }, silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await talk(connection, "400000000000000004", 0.5);
  await until(async () => (await events("voice.speech.ended")).length === 3, "the three sentences", 30_000);
  const ended = await events("voice.speech.ended");
  assert.deepEqual(ended.map((event: any) => event.data.reason), ["done", "done", "done"]);
  const gaps = [plays[1].first! - plays[0].last!, plays[2].first! - plays[1].last!].map(Math.round);
  console.log(JSON.stringify({ type: "voice_sentence_gaps", firstByteMs: FIRST_BYTE_MS, gapsMs: gaps }));
  // Each sentence's making began while the one before it played (after the one before was all made).
  assert.ok(calls[1].at < plays[0].last!, "the second was asked for before the first finished playing");
  assert.ok(calls[2].at < plays[1].last!, "the third before the second finished");
  for (const gap of gaps) assert.ok(gap < FIRST_BYTE_MS, `no provider round trip between sentences (gap ${gap} ms)`);
});

test("a speech made ahead and then stopped (barge-in) ends interrupted, billed for what it made, and never plays", { timeout: 60_000 }, async t => {
  const { synthesizer } = slowStartSynthesizer(50);
  const { transport, fake, plays } = timedTransport();
  async function* reply() { yield "This is the first sentence of it, long enough to take a while to say out loud. Then a second sentence."; }
  // The barge-in is an utterance too: the agent says nothing to it.
  async function* nothing() {}
  let replies = 0;
  const { node, events, usage } = await voiceCluster(t, { transports: { discord: transport }, synthesizer, submitStreaming: () => replies++ ? nothing() : reply() });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), speak: { agentReplies: true }, deliver: { agent: AGENT }, silenceMs: 200, bargeIn: true });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await talk(connection, "400000000000000004", 0.4);
  await until(() => plays[0]?.first, "the first sentence playing");
  await sleep(1_500);
  // Long enough to pause the bot (bargeIn's minMs, 300 ms), and words that are not its own: it stops.
  await talk(connection, "400000000000000004", 0.5);
  await until(async () => (await events("voice.speech.ended")).length === 2, "both ended", 30_000);
  const ended = await events("voice.speech.ended");
  assert.deepEqual(ended.map((event: any) => [event.data.reason, event.data.by]), [["interrupted", "barge_in"], ["interrupted", "barge_in"]]);
  assert.ok(ended[1].data.seconds > 0, "the second was made ahead, and its making is billed");
  assert.equal(plays.length, 1, "the second never played");
  await until(() => usage.filter(entry => entry.usage.kind === "speech").length === 2, "both speeches' usage");
});

test("a reply's first piece goes at its first clause; the rest are whole sentences", () => {
  const said: string[] = [];
  const reply = new SpokenReply(text => said.push(text));
  reply.push("Sure, that is a really good question to ask,");
  assert.deepEqual(said, [], "a clause is whole only once more follows it");
  reply.push(" and here is the");
  assert.deepEqual(said, ["Sure, that is a really good question to ask"]);
  reply.push(" answer, in two parts, which follow. Next");
  assert.deepEqual(said, ["Sure, that is a really good question to ask", "and here is the answer, in two parts, which follow."]);
  // A first clause too short to be worth speaking alone waits for its sentence.
  const short: string[] = [];
  const brief = new SpokenReply(text => short.push(text));
  brief.push("Yes, I can do that for you now. ");
  assert.deepEqual(short, ["Yes, I can do that for you now."]);
});

test("the first audio of a reply waits only for its first clause: the turn's first piece is queued before the sentence is whole", { timeout: 60_000 }, async t => {
  const lines: any[] = [];
  setMetricSink(line => { const parsed = JSON.parse(line); if (parsed.type === "voice_turn_latency") lines.push(parsed); });
  t.after(() => setMetricSink());
  const { synthesizer, calls } = slowStartSynthesizer(10);
  const { transport, fake } = timedTransport();
  // The model writes a long first sentence slowly: its first clause is whole 200 ms before its end.
  async function* reply() { yield "Well, let me think about that for a second,"; yield " because"; await sleep(400); yield " it matters. Done."; }
  const { node } = await voiceCluster(t, { transports: { discord: transport }, synthesizer, submitStreaming: () => reply() });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), speak: { agentReplies: true }, deliver: { agent: AGENT }, silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await talk(connection, "400000000000000004", 0.5);
  await until(() => lines.length === 1, "the turn's line", 20_000);
  assert.equal(calls[0].text, "Well, let me think about that for a second");
  const { stagesMs } = lines[0];
  assert.ok(stagesMs.firstPacket - stagesMs.llmFirstToken < 400, `first audio before the sentence was whole (${stagesMs.firstPacket - stagesMs.llmFirstToken} ms after the first token)`);
});
