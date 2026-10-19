import { test } from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "../src/node-context.ts";
import { BargeInGuard, DEFAULT_BARGE_IN, echoVerdict, type BargeInOutcome } from "../src/voice/echo-guard.ts";
import { MediaSession, type MediaEvents } from "../src/voice/media.ts";
import { discordGrant, fakeTransport, sleep, speak, speechPacket, until, voiceCluster, type FakeConnection } from "./voice-fakes.ts";

const BOT = "The forecast for tomorrow is sunny with a light breeze from the west, and highs near seventy degrees.";

test("echo: the bot's words coming back are echo, in its order, even through transcription slips; other words are speech", () => {
  const spoken = ["Sure, I can help with that.", BOT];
  // Echo, as a transcript of it comes back: in order, with a slip or a dropped word.
  for (const heard of ["the forecast for tomorrow is sunny", "forecast for tomorow is sunny with light breeze", "a light breeze from the west and highs", "sure I can help", "highs near seventy"]) {
    assert.equal(echoVerdict(heard, spoken).verdict, "echo", heard);
  }
  // Someone else talking, though some of their words are also the bot's.
  // "what is the forecast for sunday": half of it is a run of the bot's words, under the 60% that is echo.
  for (const heard of ["wait stop", "no, I asked about the weekend", "can you repeat that", "what is the forecast for sunday", "hold on a second", "stop"]) {
    assert.equal(echoVerdict(heard, spoken).verdict, "speech", heard);
  }
  // Too little to say.
  assert.equal(echoVerdict("", spoken).verdict, "unsure");
  assert.equal(echoVerdict("sunny", spoken).verdict, "unsure", "one word the bot said");
  assert.equal(echoVerdict("anything", []).verdict, "speech", "the bot said nothing");
  const scored = echoVerdict("the forecast for tomorrow is sunny", spoken);
  assert.deepEqual([scored.heard, scored.matched, scored.score], [6, 6, 1]);
});

/** A clock tests move by hand. */
function manualClock() {
  let now = 1_000_000;
  const timers = new Set<{ at: number; callback: () => void }>();
  const clock = {
    now: () => now, monotonic: () => now,
    setTimeout: (callback: () => void, ms: number) => { const timer = { at: now + ms, callback }; timers.add(timer); return timer as never; },
    clearTimeout: (timer: unknown) => { timers.delete(timer as never); },
  } as unknown as Clock;
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
  };
  return { clock, advance };
}

function guarded(speaking = true) {
  const { clock, advance } = manualClock();
  const outcomes: BargeInOutcome[] = [];
  const guard = new BargeInGuard({}, {
    speaking: () => speaking, spoken: () => [BOT],
    stop: outcome => { outcomes.push(outcome); }, resume: outcome => { outcomes.push(outcome); },
  }, clock);
  return { guard, outcomes, advance, clock };
}

test("the guard: echo resumes; other words stop; speech going on after the pause stops; nothing said resumes at resumeMs", () => {
  assert.deepEqual(DEFAULT_BARGE_IN, { minMs: 300, confirmMs: 1_000, resumeMs: 3_000 });

  // Its own words: resumed, with how long it paused.
  let { guard, outcomes, advance } = guarded();
  assert.equal(guard.candidate("u1", 300), true);
  assert.equal(guard.pausing, true);
  advance(250);
  assert.equal(guard.heard("u1", "the forecast", false), undefined, "an unfinished partial waits");
  advance(150);
  assert.equal(guard.heard("u1", "the forecast for tomorrow is", false), "echo");
  assert.deepEqual(outcomes, [{ type: "echo_rejected", why: "echo", pausedMs: 400, speechMs: 300, score: 1 }]);
  assert.equal(guard.pausing, false);

  // Someone else's words: stopped.
  ({ guard, outcomes, advance } = guarded());
  guard.candidate("u1", 300);
  advance(450);
  assert.equal(guard.heard("u1", "wait stop", false), "speech");
  assert.deepEqual(outcomes, [{ type: "confirmed", why: "words", pausedMs: 450, speechMs: 300 }]);

  // One word: a partial waits for the whole; the whole decides.
  ({ guard, outcomes, advance } = guarded());
  guard.candidate("u1", 300);
  assert.equal(guard.heard("u1", "stop", false), undefined);
  advance(900);
  assert.equal(guard.heard("u1", "stop", true), "speech");
  assert.equal(outcomes[0].type, "confirmed");

  // No words, but they keep talking after the pause (echo cannot: the pause silenced what it echoes).
  ({ guard, outcomes, advance } = guarded());
  guard.candidate("u1", 300);
  for (let ms = 320; ms <= 1_300; ms += 20) { advance(20); guard.progress("u1", ms); }
  assert.deepEqual(outcomes.map(outcome => [outcome.type, outcome.why]), [["confirmed", "sustained"]]);

  // A short tail of echo after the pause, then nothing: resumed at resumeMs.
  ({ guard, outcomes, advance } = guarded());
  guard.candidate("u1", 300);
  for (let ms = 320; ms <= 600; ms += 20) { advance(20); guard.progress("u1", ms); }
  advance(2_600);
  assert.equal(outcomes.length, 0);
  advance(100);
  assert.deepEqual(outcomes.map(outcome => [outcome.type, outcome.why, outcome.pausedMs]), [["echo_rejected", "timeout", 3_000]]);

  // An empty transcript: resumed.
  ({ guard, outcomes, advance } = guarded());
  guard.candidate("u1", 300);
  guard.heard("u1", "", true);
  assert.deepEqual(outcomes.map(outcome => [outcome.type, outcome.why]), [["echo_rejected", "no_words"]]);
});

test("the guard: two speakers hold one pause until both are echo; one real stops it; an earlier utterance's transcript is not this one's; a silent bot is no candidate", () => {
  let { guard, outcomes, advance, clock } = guarded();
  guard.candidate("u1", 300);
  advance(100);
  guard.candidate("u2", 300);
  guard.heard("u1", "sunny with a light breeze", true);
  assert.equal(outcomes.length, 0, "u2 still holds the pause");
  advance(100);
  guard.heard("u2", "highs near seventy degrees", true);
  assert.deepEqual(outcomes.map(outcome => [outcome.type, outcome.pausedMs]), [["echo_rejected", 200]], "the pause, from its start");

  ({ guard, outcomes, advance, clock } = guarded());
  guard.candidate("u1", 300);
  guard.candidate("u2", 300);
  guard.heard("u1", "sunny with a light breeze", true);
  guard.heard("u2", "hang on, my turn", true);
  assert.deepEqual(outcomes.map(outcome => outcome.type), ["confirmed"]);
  assert.equal(guard.pausing, false);

  ({ guard, outcomes, advance, clock } = guarded());
  const startedAt = clock.now();
  guard.candidate("u1", 300, startedAt);
  assert.equal(guard.heard("u1", "something else entirely", true, startedAt - 2_000), undefined, "a transcript of their utterance before");
  assert.equal(outcomes.length, 0);

  ({ guard, outcomes } = guarded(false));
  assert.equal(guard.candidate("u1", 300), false);
  assert.equal(guard.pausing, false);

  // confirmMs 0: no pause, the bot stops at minMs.
  const immediate: BargeInOutcome[] = [];
  const unguarded = new BargeInGuard({ confirmMs: 0 }, { speaking: () => true, spoken: () => [BOT], stop: outcome => { immediate.push(outcome); }, resume: () => assert.fail() }, manualClock().clock);
  unguarded.candidate("u1", 300);
  assert.deepEqual(immediate, [{ type: "confirmed", why: "immediate", pausedMs: 0, speechMs: 300 }]);
});

/** A media session's events, recorded. */
function recorder() {
  const seen = { bargeIns: [] as [string, number][], progress: [] as number[] };
  const events: MediaEvents = {
    ready: () => {}, lost: () => {}, diagnostic: () => {}, speechStart: () => {}, pcm: () => {}, drop: () => {}, cut: () => {},
    bargeIn: (speaker, speechMs) => { seen.bargeIns.push([speaker, speechMs]); }, speechProgress: (_speaker, speechMs) => { seen.progress.push(speechMs); },
  };
  return { seen, events };
}

async function* tone(seconds: number) {
  for (let at = 0; at < seconds * 10; at++) { yield Buffer.alloc(4_800, 1); await sleep(1); }
}

test("media: under minMs nothing happens; at minMs playback pauses (not stops) and the session hears; resume goes on where it was", async () => {
  const fake = fakeTransport(20);
  const { seen, events } = recorder();
  const media = new MediaSession(fake.transport, discordGrant(), { silenceMs: 200, ignoreUserIds: [], bargeIn: true, bargeInMinMs: 300, bargeInPause: true, live: false }, events);
  const [connection] = fake.connections;
  const playback = media.play(tone(2), () => {});
  await until(() => connection.played[0]?.length >= 3, "speech playing");
  speak(connection, "400000000000000004", 0.2);
  assert.deepEqual(seen.bargeIns, [], "a sound under minMs");
  assert.equal(connection.paused, false);
  // The same utterance goes on past minMs.
  for (let index = 10; index < 20; index++) connection.handlers.packet("400000000000000004", speechPacket(index));
  assert.deepEqual(seen.bargeIns, [["400000000000000004", 300]]);
  assert.equal(connection.paused, true, "paused at once, in the media");
  assert.equal(seen.progress.length, 5, "the rest of the utterance, while paused");
  const before = connection.played[0].length;
  await sleep(200);
  assert.ok(connection.played[0].length <= before + 1, "nothing more goes out while paused");
  media.resume();
  assert.equal(await playback.done, "done", "resumed and played whole");
  assert.equal(connection.played[0].length, 100);
  await media.close("end");
});

/** A session whose brain is saying `BOT` (about 8 s of it, a packet each 10 ms here), and a person who talks over it. */
async function overTheBot(t: Parameters<typeof voiceCluster>[0], talk: (connection: FakeConnection) => Promise<void> | void) {
  const { fake, realtime, node, events } = await voiceCluster(t, { playEveryMs: 10 });
  const a = await node("http://a");
  const session = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200 });
  assert.deepEqual(session.interruption, DEFAULT_BARGE_IN);
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  const model = await until(() => realtime.connections[0], "the model");
  speak(connection, "400000000000000004", 0.6);
  await until(() => model.responses === 1, "a response asked for");
  await model.answer("resp_1", { ms: 8_000, said: BOT });
  await until(() => connection.played[0]?.length >= 20, "it to play");
  let paused = false;
  const watch = setInterval(() => { paused ||= connection.paused; }, 2);
  await talk(connection);
  const [ended] = await until(async () => { const found = await events("voice.speech.ended"); return found.length ? found : undefined; }, "the speech to end", 30_000);
  clearInterval(watch);
  return { ended: ended.data, paused, played: connection.played[0].length, model };
}

test("barge-in, someone talking on: speech going on after the pause stops the bot (by: barge_in), and the model's item is cut at what was heard", { timeout: 60_000 }, async t => {
  const { ended, paused, played, model } = await overTheBot(t, async connection => {
    for (let index = 0; index < 100; index++) { connection.handlers.packet("400000000000000004", speechPacket(index)); await sleep(15); }
  });
  assert.equal(paused, true, "it paused while deciding");
  assert.deepEqual([ended.reason, ended.by], ["interrupted", "barge_in"]);
  assert.ok(played < 400, "not all of it");
  const [truncated] = model.of("truncate");
  assert.equal(truncated?.response, "resp_1");
  assert.ok(truncated.heardMs > 0 && truncated.heardMs < 8_000, `cut at ${truncated?.heardMs} ms`);
});

test("bargeIn takes its timing: shown as interruption; out of range or unknown is a 400; off shows none", async t => {
  const { node } = await voiceCluster(t);
  const a = await node("http://a");
  const tuned = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000091" }), bargeIn: { minMs: 200, confirmMs: 0 } });
  assert.deepEqual([tuned.bargeIn, tuned.interruption], [true, { minMs: 200, confirmMs: 0, resumeMs: 3_000 }]);
  const off = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000092" }), bargeIn: false });
  assert.deepEqual([off.bargeIn, off.interruption], [false, undefined]);
  for (const bargeIn of [{ minMs: -1 }, { resumeMs: 100 }, { confirmMs: 1.5 }, { other: 1 }, "yes"]) {
    await assert.rejects(a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000093" }), bargeIn }), (error: { status?: number }) => error.status === 400, JSON.stringify(bargeIn));
  }
});

test("the guard: an utterance its partials showed to be echo is echo when its final transcript comes; the next utterance is not", () => {
  const { guard, outcomes, clock } = guarded();
  const startedAt = clock.now();
  guard.candidate("u1", 300, startedAt);
  assert.equal(guard.heard("u1", "sunny with a light breeze", false), "echo");
  assert.deepEqual(outcomes.map(outcome => outcome.type), ["echo_rejected"]);
  assert.equal(guard.heard("u1", "sunny with a light breeze from the west", true, startedAt - 20), "echo", "its final transcript");
  assert.equal(guard.heard("u1", "sunny with a light breeze", true, startedAt + 5_000), undefined, "no candidate, nothing judged: delivered as theirs");
});
