import { test } from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "../src/node-context.ts";
import { BargeInGuard, isBackchannel, type BargeInOutcome } from "../src/voice/echo-guard.ts";
import { discordGrant, speak, until, voiceCluster } from "./voice-fakes.ts";

/**
 * Barge-in's backchannels (src/voice/echo-guard.ts): someone saying "mm-hm" over the bot shows they listen, and does not
 * take the turn; a turn too short to be words ends the pause it made.
 */

const BOT = "The forecast for tomorrow is sunny with a light breeze from the west, and highs near seventy degrees.";

function manualClock() {
  let now = 1_000_000;
  const timers = new Set<{ at: number; callback: () => void }>();
  const clock = {
    now: () => now, monotonic: () => now,
    setTimeout: (callback: () => void, ms: number) => { const timer = { at: now + ms, callback }; timers.add(timer); return timer as never; },
    clearTimeout: (timer: unknown) => { timers.delete(timer as never); },
  } as unknown as Clock;
  return { clock, advance: (ms: number) => { now += ms; for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now) { timers.delete(timer); timer.callback(); } } };
}
function guarded(policy = {}) {
  const { clock, advance } = manualClock();
  const outcomes: BargeInOutcome[] = [];
  const guard = new BargeInGuard(policy, { speaking: () => true, spoken: () => [BOT], stop: outcome => { outcomes.push(outcome); }, resume: outcome => { outcomes.push(outcome); } }, clock);
  return { guard, outcomes, advance, clock };
}

test("backchannels, in many languages, are not words that take the turn", () => {
  for (const text of ["mm-hm", "Mhm.", "yeah yeah", "uh huh", "Okay!", "right, right", "sí", "vale", "ja genau", "oui d'accord", "да", "угу", "evet", "haan", "हाँ", "嗯", "嗯嗯", "うん", "はい", "네", "응", "vâng", "tá"]) {
    assert.ok(isBackchannel(text), text);
  }
  for (const text of ["wait", "stop", "no stop", "yeah but what about tomorrow", "hold on", "espera", "attends", "warte mal", "等一下", "ちょっと待って", ""]) {
    assert.ok(!isBackchannel(text), text);
  }
  assert.ok(isBackchannel("bet", ["bet"]), "a session's own");
});

test("the guard: a backchannel resumes the bot and is not a turn; a partial one waits; words after it stop the bot", () => {
  let { guard, outcomes } = guarded();
  guard.candidate("u1", 300);
  assert.equal(guard.heard("u1", "yeah", false), undefined, "a partial 'yeah' may go on");
  assert.equal(guard.heard("u1", "mm-hm yeah", true), "backchannel");
  assert.deepEqual(outcomes.map(o => [o.type, o.why]), [["echo_rejected", "backchannel"]]);

  ({ guard, outcomes } = guarded());
  guard.candidate("u1", 300);
  assert.equal(guard.heard("u1", "yeah", false), undefined);
  assert.equal(guard.heard("u1", "yeah but wait", false), "speech", "it went on: someone taking the turn");
  assert.deepEqual(outcomes.map(o => [o.type, o.why]), [["confirmed", "words"]]);

  ({ guard, outcomes } = guarded({ backchannels: ["bet"] }));
  guard.candidate("u1", 300);
  assert.equal(guard.heard("u1", "bet", true), "backchannel", "the session's own backchannel");
});

test("the guard: a turn too short to be words ends its pause at once; a longer one waits for its words", () => {
  let { guard, outcomes } = guarded();
  guard.candidate("u1", 300);
  guard.ended("u1", 180);
  assert.deepEqual(outcomes.map(o => [o.type, o.why]), [["echo_rejected", "ended"]]);

  ({ guard, outcomes } = guarded());
  guard.candidate("u1", 300);
  guard.ended("u1", 900);
  assert.deepEqual(outcomes, [], "its words decide");
  assert.equal(guard.heard("u1", "wait stop", true), "speech");
  // Two people over the bot: one's cough does not resume it while the other is undecided.
  ({ guard, outcomes } = guarded());
  guard.candidate("u1", 300);
  guard.candidate("u2", 300);
  guard.ended("u1", 150);
  assert.deepEqual(outcomes, []);
  guard.ended("u2", 120);
  assert.deepEqual((outcomes as BargeInOutcome[]).map(o => o.why), ["ended"]);
});

test("in a session: a short sound over the bot pauses it, and it goes on (no words came); what was said over it is not answered; bargeIn's timing is taken and shown", { timeout: 60_000 }, async t => {
  const { fake, realtime, node, events } = await voiceCluster(t, { playEveryMs: 10 });
  const a = await node("http://a");
  const session = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200, bargeIn: { resumeMs: 1_000 } });
  assert.deepEqual(session.interruption, { minMs: 300, confirmMs: 1_000, resumeMs: 1_000 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  const model = await until(() => realtime.connections[0], "the model");
  speak(connection, "400000000000000004", 0.6);
  await until(() => model.responses === 1, "a response asked for");
  await model.answer("resp_1", { ms: 8_000, said: BOT });
  await until(() => connection.played[0]?.length >= 20, "the answer to play");
  let paused = false;
  const watch = setInterval(() => { paused ||= !!connection.paused; }, 2);
  t.after(() => clearInterval(watch));
  speak(connection, "400000000000000004", 0.4);
  const [ended] = await until(async () => { const found = await events("voice.speech.ended"); return found.length ? found : undefined; }, "the answer to end", 30_000);
  assert.equal(paused, true, "it paused while deciding");
  assert.deepEqual([ended.data.reason, ended.data.by], ["done", undefined], "and went on to the end");
  assert.equal(model.responses, 1, "no answer to what was said over it");
  assert.equal(model.of("cancel").length, 0);
  for (const bargeIn of [{ backchannels: ["yeah"] }, { resumeMs: 100 }, { minMs: "300" }]) {
    await assert.rejects(a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000094" }), bargeIn }), (error: { status?: number }) => error.status === 400, JSON.stringify(bargeIn));
  }
});
