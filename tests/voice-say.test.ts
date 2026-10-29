import { test } from "node:test";
import assert from "node:assert/strict";
import { sayVerbatim, speakUp, type BrainHooks } from "../src/voice/realtime/brain.ts";
import { sleep, testBrain, tone, until, utter } from "./voice-realtime-fakes.ts";

/** What the bot's code has a realtime brain say (POST …/say) or speak up about (POST …/prompt). */

/** Text to speech that makes `ms` of audio for any text, in 20 ms chunks, and costs `usd`. */
function fakeTts(ms: number, usd = 0.001) {
  const asked: string[] = [];
  const synthesize: NonNullable<BrainHooks["synthesize"]> = async (text, signal, settled) => {
    asked.push(text);
    return (async function* () {
      for (let at = 0; at < ms && !signal.aborted; at += 20) { yield tone(20); await sleep(1); }
      settled(usd);
    })();
  };
  return { synthesize, asked };
}

test("say: the words are made by text to speech and played, the model is told it said them, and the speech says so", async () => {
  const tts = fakeTts(200, 0.0012);
  const speaking: boolean[] = [];
  const { brain, connection, playback, spoke } = testBrain({ synthesize: tts.synthesize, speaking: on => speaking.push(on) });
  await until(() => connection(), "the connection");
  const queued = brain.say("The raid starts in five minutes.");
  assert.equal(queued.queued, 0);
  assert.match(queued.id, /^say_/);
  await until(() => spoke.some(event => event.type === "ended"), "the speech to end");
  assert.deepEqual(tts.asked, ["The raid starts in five minutes."]);
  assert.equal(playback.plays.length, 1);
  assert.equal(playback.plays[0].ms, 200);
  const c = connection();
  assert.equal(c.of("respond").length, 0, "the model made none of it");
  assert.equal(c.of("cancel").length, 0);
  assert.match(c.of("note").at(-1)!.text, /^\[You said this aloud just now.*\] The raid starts in five minutes\.$/);
  const ended = spoke.find(event => event.type === "ended")!;
  assert.equal(ended.id, queued.id);
  assert.equal(ended.say, true);
  assert.equal(ended.type === "ended" && ended.costUsd, 0.0012);
  assert.deepEqual(speaking, [true, false], "music holds while it speaks");
  assert.equal(brain.stats.says, 1);
  brain.close();
});

test("say waits for the answer playing, and for someone mid-turn; their answer goes first", async () => {
  const tts = fakeTts(100);
  const { brain, connection, playback } = testBrain({ synthesize: tts.synthesize });
  await utter(brain, "1", 300);
  const c = connection();
  void c.answer("r1", { ms: 400 });
  await until(() => playback.plays[0]?.started, "the answer to play");
  assert.equal(brain.say("Announcement.").queued, 1);
  await sleep(20);
  assert.equal(playback.plays.length, 1, "behind the answer");
  await until(() => playback.plays.length === 2, "the words, after the answer");
  await until(() => !brain.speakingNow, "the words to end");
  // Someone is mid-turn: it waits for them, and the answer to their turn comes first.
  brain.speechStart("1");
  brain.pcm("1", tone(300));
  brain.say("Second announcement.");
  await sleep(30);
  assert.equal(playback.plays.length, 2, "nothing over them");
  brain.cut({ speaker: "1", packets: [], seconds: 0.3, startedAt: Date.now() - 300, endedAt: Date.now(), ended: "silence", live: true });
  await until(() => c.responses === 2, "their turn answered");
  await c.answer("r2", { ms: 100 });
  await until(() => playback.plays.length === 4, "the answer, then the words");
  assert.equal(playback.plays[2].ms, 100);
  assert.deepEqual(tts.asked, ["Announcement.", "Second announcement."]);
  brain.close();
});

test("say with interrupt cuts off the answer playing and says it now", async () => {
  const tts = fakeTts(100);
  const { brain, connection, playback } = testBrain({ synthesize: tts.synthesize });
  await utter(brain, "1", 300);
  const c = connection();
  void c.answer("r1", { ms: 3_000, said: "A very long answer" });
  await until(() => playback.plays[0]?.started, "the answer to play");
  brain.say("Fire drill!", { interrupt: true });
  await until(() => playback.plays.length === 2, "the words");
  assert.equal(playback.plays[0].stopped, true);
  assert.equal(c.of("truncate").length, 1, "the answer's item cut at what was heard");
  brain.close();
});

test("barge-in stops words being said, as it stops an answer, without cancelling the provider", async () => {
  const tts = fakeTts(3_000);
  const { brain, connection, playback } = testBrain({ synthesize: tts.synthesize, bargeIn: { minMs: 100, confirmMs: 0, resumeMs: 2_000 } });
  await until(() => connection(), "the connection");
  brain.say("A long announcement that someone talks over.");
  await until(() => playback.plays[0]?.started, "the words to play");
  brain.speechStart("1");
  brain.bargeIn("1", 100, Date.now());
  await until(() => playback.plays[0].stopped, "the words to stop");
  const c = connection();
  assert.equal(c.of("cancel").length, 0);
  assert.equal(c.of("truncate").length, 0);
  await until(() => c.of("note").some(note => /cut off/.test(note.text)), "the model told what was heard");
  brain.close();
});

test("say without text to speech, or when it fails before any audio, has the model read the words out", async () => {
  const plain = testBrain();
  await until(() => plain.connection(), "the connection");
  plain.brain.say("Hello everyone.");
  assert.deepEqual(plain.connection().of("respond"), [{ type: "respond", instructions: sayVerbatim("Hello everyone.") }]);
  plain.brain.close();

  const failing = testBrain({ synthesize: async () => { throw new Error("no key"); } });
  await until(() => failing.connection(), "the connection");
  failing.brain.say("Hello again.");
  await until(() => failing.connection().of("respond").length === 1, "the model asked");
  assert.equal(failing.connection().of("respond")[0].instructions, sayVerbatim("Hello again."));
  assert.ok(failing.logs.some(line => line.type === "voice_realtime_say_failed"));
  failing.brain.close();
});

test("prompt: the model speaks up when the floor is free; stopSpeaking drops what waits; the queue is bounded", async () => {
  const { brain, connection } = testBrain();
  await until(() => connection(), "the connection");
  const c = connection();
  brain.speechStart("1");
  brain.pcm("1", tone(100));
  brain.prompt("Remind them the stream starts soon.");
  await sleep(20);
  assert.equal(c.of("respond").length, 0, "not over someone mid-turn");
  brain.drop("1");
  await until(() => c.of("respond").length === 1, "the prompt answered");
  assert.equal(c.of("respond")[0].instructions, speakUp("Remind them the stream starts soon."));
  assert.equal(brain.stats.prompts, 1);
  // Waiting behind that response: stopSpeaking drops them too.
  brain.say("one"); brain.say("two");
  assert.equal(brain.stopSpeaking(), 3);
  await c.answer("r1", { ms: 0 });
  await sleep(20);
  assert.equal(c.of("respond").length, 1, "nothing was left to say");
  brain.speechStart("1");
  for (let i = 0; i < 10; i++) brain.say(`line ${i}`);
  assert.throws(() => brain.say("one too many"), (error: { status?: number }) => error.status === 429);
  brain.close();
  assert.throws(() => brain.say("after the end"), (error: { status?: number }) => error.status === 409);
});
