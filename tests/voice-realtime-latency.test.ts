import { test } from "node:test";
import assert from "node:assert/strict";
import { setMetricSink } from "../src/metrics.ts";
import { testBrain, until, utter } from "./voice-realtime-fakes.ts";

function metrics(t: { after(fn: () => void): void }) {
  const lines: any[] = [];
  setMetricSink(line => lines.push(JSON.parse(line)));
  t.after(() => setMetricSink());
  return { lines, spoken: () => lines.filter(line => line.VoiceFirstPacketMs !== undefined) };
}

for (const ownsTurns of [false, true]) for (const filler of [false, true]) {
  test(`first audio: ${ownsTurns ? "provider" : "local"} turns, ask_agent ${filler ? "with" : "without"} filler`, async t => {
    const { lines, spoken } = metrics(t);
    let finish!: (reply: string) => void;
    const state = testBrain({ ownsTurns, askAgent: () => new Promise(resolve => { finish = resolve; }) });
    t.after(() => state.brain.close());
    await utter(state.brain, "1", 300);
    const c = state.connection();
    if (ownsTurns) c.events.heard("", "hello", 0.3);
    await c.answer("r1", { ms: filler ? 100 : 0, tool: { id: "call_1", name: "ask_agent", args: { request: "check" } } });
    if (filler) await until(() => spoken().length === 1, "filler played");
    finish("done");
    await until(() => c.of("tool_result").length === 1, "agent completed");
    await c.answer("r2", { ms: 100 });
    await until(() => state.spoke.filter(e => e.type === "ended").length === (filler ? 2 : 1), "answers played");
    assert.equal(spoken().length, filler ? 1 : 0, "tool answers do not inherit the speech endpoint");
    if (filler) assert.equal(spoken()[0].Answer, "direct");
    const agent = lines.find(line => line.type === "voice_realtime_ask_agent");
    assert.equal(agent.Provider, "openai");
    assert.equal(agent.Outcome, "ok");
    assert.ok(agent.VoiceAskAgentMs >= 0);
    assert.deepEqual(agent._aws.CloudWatchMetrics[0].Dimensions, [[], ["Provider"], ["Outcome"]]);
    // A new utterance gets its own clock even after the tool continuation.
    await utter(state.brain, "1", 300);
    if (ownsTurns) c.events.heard("", "hello again", 0.3);
    await c.answer("r3", { ms: 100 });
    await until(() => spoken().length === (filler ? 2 : 1), "new direct answer");
  });
}

test("silent and cancelled responses publish no first-audio latency", async t => {
  const { spoken } = metrics(t);
  const state = testBrain();
  t.after(() => state.brain.close());
  await utter(state.brain, "1", 300);
  await state.connection().answer("silent", { tool: { id: "silent_1", name: "stay_silent" } });
  await utter(state.brain, "1", 300);
  state.connection().events.responseStarted("cancelled");
  state.brain.stopSpeaking();
  await state.connection().answer("cancelled", { ms: 100 });
  assert.deepEqual(spoken(), []);
});

test("late ask_agent replies never publish direct latency", async t => {
  const { spoken } = metrics(t);
  let finish!: (reply: string) => void;
  const state = testBrain({ limits: { askAgentMs: 10 }, askAgent: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => state.brain.close());
  await utter(state.brain, "1", 300);
  const c = state.connection();
  await c.answer("r1", { tool: { id: "call_1", name: "ask_agent", args: { request: "check" } } });
  await until(() => c.responses === 2, "pending answer");
  await c.answer("r2", { ms: 100 });
  await until(() => state.spoke.some(e => e.type === "ended"), "pending audio played");
  finish("done");
  await until(() => c.responses === 3, "late answer");
  await c.answer("r3", { ms: 100 });
  await until(() => state.spoke.filter(e => e.type === "ended").length === 2, "late audio played");
  assert.deepEqual(spoken(), []);
});

test("provider audio before its transcript consumes the endpoint only once", async t => {
  const { spoken } = metrics(t);
  const state = testBrain({ ownsTurns: true });
  t.after(() => state.brain.close());
  await utter(state.brain, "1", 300);
  const c = state.connection();
  await c.answer("r1", { ms: 100 });
  await until(() => spoken().length === 1, "direct answer");
  c.events.heard("", "hello", 0.3);
  assert.equal(state.heard.length, 1, "the late transcript is still delivered");
  await until(() => state.spoke.some(e => e.type === "ended"), "first audio ended");
  await c.answer("r2", { ms: 100 });
  await until(() => state.spoke.filter(e => e.type === "ended").length === 2, "second audio ended");
  assert.equal(spoken().length, 1);
});

test("dropping a short utterance discards its held speculative answer", async t => {
  const { spoken } = metrics(t);
  const state = testBrain({ speculative: true });
  t.after(() => state.brain.close());
  await utter(state.brain, "1", 200, { open: true });
  state.brain.turnEvent({ type: "likely_end", speaker: "1", at: Date.now(), silenceMs: 200, probability: 1 });
  const c = state.connection();
  await c.answer("stale", { ms: 100 });
  assert.equal(state.playback.plays.length, 0, "speculative audio is held");
  state.brain.drop("1");
  assert.equal(state.brain.stats.speculativeDiscarded, 1);
  assert.equal(c.of("truncate")[0].response, "stale");
  await utter(state.brain, "1", 300);
  assert.equal(c.responses, 2, "a new turn asks for a new response");
  await c.answer("fresh", { ms: 100 });
  await until(() => spoken().length === 1, "only the new answer played");
  assert.equal(spoken()[0].speculative, false);
});
