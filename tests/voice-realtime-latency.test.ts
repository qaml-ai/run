import { test } from "node:test";
import assert from "node:assert/strict";
import { setMetricSink } from "../src/metrics.ts";
import { HttpError } from "../src/http.ts";
import { cut, testBrain, until, utter } from "./voice-realtime-fakes.ts";

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
  assert.equal(c.responses, 1, "speculative dispatch is immediate");
  await c.answer("stale", { ms: 100 });
  assert.equal(state.playback.plays.length, 0, "speculative audio is held");
  state.brain.drop("1");
  assert.equal(state.brain.stats.speculativeDiscarded, 1);
  assert.equal(c.of("truncate")[0].response, "stale");
  await utter(state.brain, "1", 300);
  await until(() => c.responses === 2, "new turn response dispatch");
  await c.answer("fresh", { ms: 100 });
  await until(() => spoken().length === 1, "only the new answer played");
  assert.equal(spoken()[0].speculative, false);
});

for (const refusal of [undefined, new HttpError(429, "Rate limited"), new HttpError(429, "Out of free credit", "FREE_HOURLY_LIMIT")]) {
  test(`speculation dispatches before credit settles and waits to play (${refusal?.message ?? "admitted"})`, async t => {
    let finish!: () => void;
    const credit = new Promise<void>((resolve, reject) => {
      finish = () => refusal ? reject(refusal) : resolve();
    });
    let checks = 0;
    const debits: number[] = [];
    const state = testBrain({
      speculative: true,
      refusal: () => ++checks === 1 ? credit : Promise.resolve(),
      debit: async usd => { debits.push(usd); },
    });
    t.after(() => state.brain.close());
    await utter(state.brain, "1", 300, { open: true });
    const c = state.connection();
    state.brain.turnEvent({ type: "likely_end", speaker: "1", at: Date.now(), silenceMs: 200, probability: 1 });
    assert.equal(c.responses, 1, "provider received the request before the credit read");
    await until(() => checks === 1, "credit read started");
    await c.answer("held", { ms: 100, usage: { outputAudio: 100 } });
    state.brain.cut(cut("1", Date.now() - 300, 300));
    assert.equal(state.playback.plays.length, 0, "turn ended while admission was pending");
    finish();
    if (!refusal) {
      await until(() => state.spoke.some(event => event.type === "ended"), "admitted audio played");
    } else {
      await until(() => c.of("truncate").length === 1, "refused audio discarded");
      assert.equal(state.playback.plays.length, 0);
      assert.deepEqual(c.of("truncate"), [{ type: "truncate", response: "held", heardMs: 0 }]);
      if (refusal.code === "FREE_HOURLY_LIMIT") {
        await until(() => state.budget.length === 1, "budget ending");
      } else {
        assert.deepEqual(state.budget, []);
        await utter(state.brain, "1", 300);
        await until(() => c.responses === 2, "next response after rate refusal");
      }
    }
    await until(() => debits.length === 1, "provider usage debited");
    assert.deepEqual(debits, [state.usage[0].costUsd]);
  });
}
