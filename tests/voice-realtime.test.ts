import { test } from "node:test";
import assert from "node:assert/strict";
import { Mixer } from "../src/voice/realtime/mixer.ts";
import { realtimeCost, realtimeTranscriptionCost, realtimeVoice } from "../src/voice/realtime/provider.ts";
import { NOT_ADDRESSED_HINT, realtimeInstructions } from "../src/voice/realtime/brain.ts";
import { fakeRealtimeProvider, sleep, testBrain, tone, until, utter } from "./voice-realtime-fakes.ts";

/** The realtime brain (src/voice/realtime): a speech-to-speech model behind our media plane, turn-taking and floor. */

test("the mixer passes one speaker straight through, and sums speakers who talk at once", async () => {
  const out: { bytes: number; speakers: string[]; peak: number }[] = [];
  const mixer = new Mixer((pcm, speakers) => {
    let peak = 0;
    for (let i = 0; i + 1 < pcm.byteLength; i += 2) peak = Math.max(peak, Math.abs(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).readInt16LE(i)));
    out.push({ bytes: pcm.byteLength, speakers, peak });
  }, { tickMs: 10, overlapMs: 60 });
  mixer.push("a", tone(20));
  assert.deepEqual(out.map(entry => entry.speakers), [["a"]], "alone: at once, no tick");
  // b talks while a does: both are queued and mixed at the tick.
  mixer.push("b", tone(20));
  mixer.push("a", tone(20));
  assert.equal(out.length, 1);
  await sleep(30);
  assert.deepEqual(out[1].speakers.sort(), ["a", "b"]);
  assert.equal(out[1].bytes, 960);
  assert.ok(out[1].peak > 12_000, "the two tones add up");
  // A loud overlap clips rather than wrapping.
  mixer.push("a", tone(20, 30_000)); mixer.push("b", tone(20, 30_000));
  mixer.flush();
  assert.ok(out.at(-1)!.peak >= 32_767, "at full scale");
  mixer.quiet("b");
  await sleep(80);
  mixer.push("a", tone(20));
  assert.deepEqual(out.at(-1)!.speakers, ["a"], "b quiet again: a passes straight through");
  mixer.close();
});

test("prices: tokens at OpenAI's list price, cached input at the cached rate; transcription per second; voices mapped", () => {
  // A minute of a turn-based call: 1,000 audio tokens in (300 of them cached), 200 text in, 600 audio out, 50 text out.
  const usd = realtimeCost("openai/gpt-realtime-2.1", { inputAudio: 1_000, cachedAudio: 300, inputText: 200, cachedText: 0, outputAudio: 600, outputText: 50 });
  assert.equal(Math.round(usd * 1e6), Math.round((700 * 32 + 300 * 0.4 + 200 * 4 + 600 * 64 + 50 * 24)));
  assert.equal(realtimeCost("openai/unknown", { inputAudio: 1, cachedAudio: 0, inputText: 0, cachedText: 0, outputAudio: 0, outputText: 0 }), 0);
  assert.equal(realtimeTranscriptionCost(60), 0.0045);
  const { provider } = fakeRealtimeProvider();
  assert.equal(realtimeVoice(provider, "coral"), "coral");
  assert.equal(realtimeVoice(provider, "nova"), "marin");
  assert.equal(realtimeVoice(provider, "onyx"), "cedar");
  assert.equal(realtimeVoice(provider, "fable"), "ballad");
  assert.equal(realtimeVoice(provider, "whatever"), "alloy");
  const instructions = realtimeInstructions("You are Mochi, a cheerful cat.", { agent: true, group: true });
  assert.match(instructions, /^You are Mochi, a cheerful cat\./);
  assert.match(instructions, /ask_agent/);
  assert.match(instructions, /stay_silent/);
  assert.doesNotMatch(realtimeInstructions(undefined, { agent: false, group: false }), /ask_agent|stay_silent/);
});

test("speaker notes: each change of speaker commits what came before and names who speaks next", async () => {
  const { brain, connection, turns } = testBrain({ humans: 2 });
  await utter(brain, "1", 400);
  const first = connection();
  assert.deepEqual(first.sent.map(entry => entry.type), ["note", "append", "commit", "respond"]);
  assert.deepEqual(first.of("note").map(note => note.text), ["[Ana]"]);
  assert.equal(first.of("commit")[0].ms, 400);
  await first.answer("r1", { ms: 100 });
  await until(() => !brain.speakingNow && first.responses === 1, "the reply");
  // Ben talks, then Ana goes on while he still is (at once), then Ana alone again.
  brain.speechStart("2");
  brain.pcm("2", tone(200));
  brain.speechStart("1");
  brain.pcm("1", tone(20));
  brain.pcm("2", tone(20));
  await sleep(40);
  const notes = first.of("note").map(note => note.text);
  assert.deepEqual(notes, ["[Ana]", "[Ben]", "[Ana and Ben, at once]"]);
  const types = first.sent.map(entry => entry.type);
  // Ben's own audio is kept as an item before the mixed one begins.
  assert.deepEqual(types.slice(types.lastIndexOf("respond") + 1, types.lastIndexOf("note") + 1), ["note", "append", "commit", "note"]);
  assert.equal(turns.length, 1);
  brain.close();
});

test("a turn ends: committed and answered; the answer plays, and its usage is priced and recorded", async () => {
  const { brain, connection, playback, usage, spoke, logs } = testBrain();
  await utter(brain, "1", 300);
  const c = connection();
  await c.answer("r1", { ms: 200, said: "Hello there.", usage: { inputAudio: 30, outputAudio: 40, inputText: 500, cachedText: 400 } });
  await until(() => spoke.some(event => event.type === "ended"), "the speech to end");
  assert.equal(playback.plays.length, 1);
  assert.equal(playback.plays[0].ms, 200);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].audioSeconds, 2);
  assert.ok(Math.abs(usage[0].costUsd - (30 * 32 + 40 * 64 + 100 * 4 + 400 * 0.4) / 1e6) < 1e-12);
  const ended = spoke.find(event => event.type === "ended")!;
  assert.equal(ended.type === "ended" && ended.reason, "done");
  brain.close();
  const stats = logs.find(line => line.type === "voice_realtime_stats")!.fields!;
  assert.equal(stats.responses, 1);
  assert.equal(stats.spoken, 1);
  assert.ok(!JSON.stringify(logs).includes("Hello there"), "no words in logs");
});

test("barge-in: someone talks over the answer, the echo guard confirms, and the model's item is cut at what was heard", async () => {
  const { brain, connection, playback, logs } = testBrain({ bargeIn: { minMs: 100, confirmMs: 150, resumeMs: 2_000 } });
  await utter(brain, "1", 300);
  const c = connection();
  // A long answer, made faster than it plays.
  void c.answer("r1", { ms: 3_000 });
  await until(() => playback.plays[0]?.started, "the answer to play");
  await sleep(60);
  // The media paused playback at minMs; speech goes on past confirmMs: it was a person.
  playback.plays[0].paused = true;
  brain.speechStart("1");
  brain.bargeIn("1", 100, Date.now());
  for (let i = 0; i < 10; i++) { brain.speechProgress("1", 100 + (i + 1) * 20); await sleep(20); }
  const truncate = await until(() => c.of("truncate")[0], "the truncate");
  assert.ok(truncate.heardMs > 0 && truncate.heardMs < 1_000, `cut at what was heard (${truncate.heardMs} ms), not the 3 s made`);
  assert.equal(playback.plays[0].stopped, true);
  const confirmed = logs.find(line => line.type === "voice_barge_in_confirmed")!.fields!;
  assert.equal(confirmed.why, "sustained");
  assert.equal(confirmed.brain, "realtime");
  // Their turn ends: it is answered.
  brain.pcm("1", tone(300));
  brain.cut({ speaker: "1", packets: [], seconds: 0.5, startedAt: Date.now() - 500, endedAt: Date.now(), ended: "silence", live: true });
  await until(() => c.responses === 2, "the answer to the interruption");
  assert.equal(brain.stats.bargeIns, 1);
  brain.close();
});

test("echo: speech over the bot that the guard rejects resumes it, and is dropped rather than committed", async () => {
  const { brain, connection, playback } = testBrain({ bargeIn: { minMs: 100, confirmMs: 1_000, resumeMs: 500 } });
  await utter(brain, "1", 300);
  const c = connection();
  void c.answer("r1", { ms: 2_000 });
  await until(() => playback.plays[0]?.started, "the answer to play");
  // Ana's speakers send the bot back, briefly: no sustained speech, so at resumeMs it resumes.
  brain.speechStart("1");
  brain.pcm("1", tone(200));
  playback.plays[0].paused = true;
  brain.bargeIn("1", 100, Date.now());
  // Nothing loud since, past STILL_TALKING_MS: resumed at resumeMs.
  await sleep(650);
  assert.equal(playback.plays[0].paused, false, "resumed");
  brain.cut({ speaker: "1", packets: [], seconds: 0.2, startedAt: Date.now() - 200, endedAt: Date.now(), ended: "silence", live: true });
  assert.equal(c.of("discard").length, 1, "the echo is dropped");
  assert.equal(c.of("commit").length, 1, "only the first turn was committed");
  assert.equal(c.responses, 1);
  assert.equal(brain.stats.echoRejected, 1);
  brain.close();
});

test("ask_agent: the model fills, the agent's reply comes back as the tool's output, and the model speaks it", async () => {
  const asked: { request: string; speaker?: string }[] = [];
  const { brain, connection, spoke, logs } = testBrain({
    askAgent: async (request, speaker) => { asked.push({ request, ...(speaker ? { speaker } : {}) }); await sleep(50); return "It is 18 degrees and sunny in Austin."; },
  });
  await utter(brain, "1", 300);
  const c = connection();
  // "Let me check" and the call, in one response.
  await c.answer("r1", { ms: 100, said: "Let me check.", tool: { id: "call_1", name: "ask_agent", args: { request: "Weather in Austin now, for Ana" } } });
  await until(() => c.responses === 2, "the follow-up response");
  assert.deepEqual(asked, [{ request: "Weather in Austin now, for Ana", speaker: "1" }]);
  const result = c.of("tool_result")[0];
  assert.equal(result.callId, "call_1");
  assert.deepEqual(JSON.parse(result.output), { reply: "It is 18 degrees and sunny in Austin." });
  await c.answer("r2", { ms: 100, said: "Eighteen and sunny." });
  await until(() => spoke.filter(event => event.type === "ended").length === 2, "both spoken");
  assert.equal(brain.stats.askAgent, 1);
  const tool = logs.find(line => line.type === "voice_realtime_tool" && line.fields?.tool === "ask_agent")!.fields!;
  assert.equal(tool.outcome, "ok");
  assert.ok(!JSON.stringify(logs).includes("Austin"), "the request and reply are not logged");
  brain.close();
});

test("ask_agent that times out or fails: the model is told so, and still answers", async () => {
  const { brain, connection } = testBrain({ askAgent: async () => { throw new Error("agent exploded with secret words"); } });
  await utter(brain, "1", 300);
  const c = connection();
  await c.answer("r1", { tool: { id: "call_1", name: "ask_agent", args: { request: "do it" } } });
  await until(() => c.responses === 2, "the follow-up");
  assert.match(c.of("tool_result")[0].output, /could not do it/);
  assert.equal(brain.stats.askAgentFailed, 1);
  brain.close();
});

test("ask_agent past its wait: the model says it is still working, and the late reply is said when it comes", async () => {
  let finish!: (reply: string) => void;
  const { brain, connection, logs } = testBrain({
    limits: { askAgentMs: 40, askAgentLateMs: 2_000 },
    askAgent: () => new Promise<string>(resolve => { finish = resolve; }),
  });
  await utter(brain, "1", 300);
  const c = connection();
  await c.answer("r1", { said: "One sec.", tool: { id: "call_1", name: "ask_agent", args: { request: "Top story on Hacker News" } } });
  await until(() => c.responses === 2, "the still-working response");
  assert.match(JSON.parse(c.of("tool_result")[0].output).pending, /still working/);
  await c.answer("r2", { ms: 50, said: "Still looking." });
  finish("A post about bees.");
  await until(() => c.responses === 3, "the late answer's response");
  assert.equal(c.of("tool_result").length, 1, "the call was answered once");
  assert.ok(c.of("note").some(note => /late reply/.test(note.text) && /bees/.test(note.text)));
  assert.equal(brain.stats.askAgentLate, 1);
  assert.equal(logs.find(line => line.type === "voice_realtime_tool" && line.fields?.tool === "ask_agent")!.fields!.outcome, "late");
  brain.close();
});

test("ask_agent that never answers: told it is still working, then let go at the late wait, with nothing more said", async () => {
  const { brain, connection } = testBrain({
    limits: { askAgentMs: 20, askAgentLateMs: 80 },
    askAgent: (_request, _speaker, signal) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  });
  await utter(brain, "1", 300);
  const c = connection();
  await c.answer("r1", { tool: { id: "call_1", name: "ask_agent", args: { request: "slow thing" } } });
  await until(() => brain.stats.askAgentFailed === 1, "let go");
  await sleep(30);
  assert.equal(c.of("tool_result").length, 1);
  assert.equal(c.responses, 2, "only the still-working response");
  brain.close();
});

test("stay_silent: the model answers nothing; the tool's result is given and no response follows", async () => {
  const { brain, connection, playback } = testBrain();
  await utter(brain, "1", 300);
  const c = connection();
  await c.answer("r1", { tool: { id: "call_9", name: "stay_silent" } });
  await sleep(30);
  assert.deepEqual(JSON.parse(c.of("tool_result")[0].output), { ok: true });
  assert.equal(c.responses, 1);
  assert.equal(playback.plays.length, 0);
  assert.equal(brain.stats.staySilent, 1);
  brain.close();
});

test("addressing in a group call: named turns are answered, others only heard; alone or in conversation, at once", async () => {
  const { brain, connection, heard, state } = testBrain({ humans: 3, addressing: { mode: "addressed", names: ["mochi"] } });
  const c = connection();
  // Ben talks to Cy: the brain waits for the words, which do not name the bot.
  await utter(brain, "2", 300);
  assert.equal(c.responses, 0);
  c.events.heard(c.of("commit")[0].tag, "what's for lunch", 1);
  await sleep(20);
  assert.equal(c.responses, 0, "not the bot's turn");
  assert.deepEqual(heard.map(entry => [entry.text, entry.addressed?.reason]), [["what's for lunch", "not_addressed"]]);
  // Ana names it.
  await utter(brain, "1", 300);
  c.events.heard(c.of("commit")[1].tag, "Mochi, what should we order?", 1);
  await until(() => c.responses === 1, "the named turn answered");
  assert.equal(c.of("respond")[0].instructions, undefined);
  await c.answer("r1", { ms: 60 });
  await until(() => !brain.speakingNow && heard.length === 2, "the reply played");
  // Ana goes on: she is in a conversation with it, so it answers before any words.
  await utter(brain, "1", 300);
  await until(() => c.responses === 2, "the conversation goes on");
  await c.answer("r2", { ms: 20 });
  await until(() => !brain.speakingNow, "played");
  // Alone in the call: every turn.
  state.humans = 1;
  await utter(brain, "3", 300);
  await until(() => c.responses === 3, "alone");
  brain.close();
});

test("addressing without names: the model decides, told the turn did not name it", async () => {
  const { brain, connection } = testBrain({ humans: 3, addressing: { mode: "addressed", names: [] } });
  await utter(brain, "2", 300);
  const c = connection();
  await until(() => c.responses === 1, "a response");
  assert.equal(c.of("respond")[0].instructions, NOT_ADDRESSED_HINT);
  brain.close();
});

test("speculative: the answer begins at likely_end, held; a resume takes it back unheard, and the turn's end plays the next", async () => {
  const { brain, connection, playback } = testBrain({ speculative: true });
  await utter(brain, "1", 300, { open: true });
  const c = connection();
  brain.turnEvent({ type: "likely_end", speaker: "1", at: Date.now(), probability: 0.9, silenceMs: 200 });
  assert.equal(c.responses, 1, "asked at likely_end");
  void c.answer("r1", { ms: 200, status: "completed" });
  await sleep(30);
  assert.equal(playback.plays.length, 0, "held until the turn ends");
  // They go on: it is cancelled and its item removed (0 ms heard).
  brain.turnEvent({ type: "resume", speaker: "1", at: Date.now() });
  assert.deepEqual(c.of("truncate"), [{ type: "truncate", response: "r1", heardMs: 0 }]);
  assert.equal(brain.stats.speculativeDiscarded, 1);
  brain.pcm("1", tone(300));
  brain.turnEvent({ type: "likely_end", speaker: "1", at: Date.now(), probability: 0.9, silenceMs: 200 });
  assert.equal(c.responses, 2);
  void c.answer("r2", { ms: 200 });
  await sleep(30);
  assert.equal(playback.plays.length, 0);
  brain.cut({ speaker: "1", packets: [], seconds: 0.9, startedAt: Date.now() - 900, endedAt: Date.now() - 200, ended: "silence", live: true });
  await until(() => playback.plays[0]?.started, "played at the turn's end");
  assert.equal(c.responses, 2, "no third response: the held one was used");
  brain.close();
});

test("someone starts talking before the answer is heard: it waits for them, and their turn replaces it", async () => {
  const { brain, connection, playback } = testBrain({ humans: 2 });
  await utter(brain, "1", 300);
  const c = connection();
  brain.speechStart("2");
  void c.answer("r1", { ms: 200 });
  await sleep(30);
  assert.equal(playback.plays.length, 0, "held: Ben is talking");
  brain.pcm("2", tone(300));
  brain.cut({ speaker: "2", packets: [], seconds: 0.3, startedAt: Date.now() - 300, endedAt: Date.now(), ended: "silence", live: true });
  await until(() => c.responses === 2, "one answer to both");
  assert.equal(brain.stats.superseded, 1);
  await c.answer("r2", { ms: 100 });
  await until(() => playback.plays[0]?.started, "the new answer plays");
  assert.equal(playback.plays.length, 1);
  brain.close();
});

test("a cough: too short to keep, its audio is dropped and nothing is answered", async () => {
  const { brain, connection } = testBrain();
  brain.speechStart("1");
  brain.pcm("1", tone(60));
  brain.drop("1");
  const c = connection();
  assert.equal(c.of("discard").length, 1);
  assert.equal(c.responses, 0);
  brain.close();
});

test("the money: a refused admission cancels the response and ends the session (budget)", async () => {
  const { brain, connection, budget } = testBrain({ refuse: true });
  await utter(brain, "1", 300);
  await until(() => budget.length === 1, "budget");
  assert.deepEqual(budget, ["tenant"]);
  assert.ok(connection().of("cancel").length >= 1);
  brain.close();
});

test("two people at once: one turn ends while the other talks; one answer, to both, once both are done", async () => {
  const { brain, connection } = testBrain({ humans: 2 });
  brain.speechStart("1");
  brain.pcm("1", tone(300));
  brain.speechStart("2");
  brain.pcm("2", tone(200));
  brain.cut({ speaker: "1", packets: [], seconds: 0.3, startedAt: Date.now() - 300, endedAt: Date.now(), ended: "silence", live: true });
  const c = connection();
  assert.equal(c.responses, 0, "Ben is still talking");
  brain.pcm("2", tone(200));
  brain.cut({ speaker: "2", packets: [], seconds: 0.4, startedAt: Date.now() - 400, endedAt: Date.now(), ended: "silence", live: true });
  assert.equal(c.responses, 1);
  await c.answer("r1", { ms: 60 });
  await until(() => !brain.speakingNow, "played");
  await sleep(30);
  assert.equal(c.responses, 1, "not a second answer to Ana's turn");
  brain.close();
});
