import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { origins, PIPELINES, PROFILES, runPipeline } from "./voice-eval/harness.ts";
import { SCENARIOS } from "./voice-eval/scenarios.ts";
import { scoreboard, scorePipeline, type PipelineScore } from "./voice-eval/score.ts";

/**
 * The voice eval (tests/voice-eval/): scripted calls through the real voice pipeline, scored. In CI it runs with fake
 * providers and checks the harness itself works (every scenario runs, the plain Q&A is answered, nothing in the
 * pipeline fails); the scoreboard is printed. `npm run eval:voice` runs it alone; choose with
 * VOICE_EVAL_PIPELINES=bots-say,run-agent, VOICE_EVAL_SCENARIOS=qa-single,barge-in, VOICE_EVAL_PROFILE=instant,
 * VOICE_EVAL_PROVIDERS=openai (with OPENAI_API_KEY: real transcription and speech), VOICE_EVAL_OUT=path (writes
 * path.md and path.json).
 */
const list = (value: string | undefined) => value?.split(",").map(entry => entry.trim()).filter(Boolean);
const pipelines = list(process.env.VOICE_EVAL_PIPELINES)?.map(name => {
  const found = PIPELINES.find(pipeline => pipeline.name === name);
  if (!found) throw new Error(`No pipeline ${name}: ${PIPELINES.map(pipeline => pipeline.name).join(", ")}`);
  return found;
}) ?? PIPELINES;
const scenarios = list(process.env.VOICE_EVAL_SCENARIOS)?.map(name => {
  const found = SCENARIOS.find(scenario => scenario.name === name);
  if (!found) throw new Error(`No scenario ${name}: ${SCENARIOS.map(scenario => scenario.name).join(", ")}`);
  return found;
}) ?? SCENARIOS;
const profile = PROFILES[process.env.VOICE_EVAL_PROFILE ?? "realistic"];
if (!profile) throw new Error(`No profile ${process.env.VOICE_EVAL_PROFILE}: ${Object.keys(PROFILES).join(", ")}`);
const providers = process.env.VOICE_EVAL_PROVIDERS === "openai" ? "openai" as const : "fake" as const;
/** VOICE_EVAL_SPEAKERS=clips: real people's speech (VOICE_EVAL_CLIPS, a directory; tests/fixtures/voice-turns by default). */
const speakers = process.env.VOICE_EVAL_SPEAKERS === "clips" ? "clips" as const : "tones" as const;
const clips = process.env.VOICE_EVAL_CLIPS;

// CI runs every file under both hostings; the eval does not depend on how agents are hosted, so it runs under one.
const skip = process.env.AGENT_HOSTING === "inline" ? "the voice eval runs in the process-hosted shards" : false;

test(`voice eval: ${pipelines.length} pipelines x ${scenarios.length} scenarios (${providers} providers, ${profile.name}, ${speakers})`, { timeout: 20 * 60_000, skip }, async () => {
  // Each pipeline's scenarios at once (each a session). Pipelines too, in CI; one at a time with VOICE_EVAL_SERIAL=1
  // (npm run eval:voice), so that no pipeline's numbers share the node with another's.
  const scores: PipelineScore[] = [];
  if (process.env.VOICE_EVAL_SERIAL) for (const pipeline of pipelines) scores.push(scorePipeline(await runPipeline({ pipeline, scenarios, profile, providers, speakers, ...(clips ? { clips } : {}) })));
  else scores.push(...(await Promise.all(pipelines.map(pipeline => runPipeline({ pipeline, scenarios, profile, providers, speakers, ...(clips ? { clips } : {}) })))).map(scorePipeline));
  const board = scoreboard(scores);
  console.log(`\n${board}\n`);
  if (process.env.VOICE_EVAL_OUT) {
    mkdirSync(dirname(process.env.VOICE_EVAL_OUT), { recursive: true });
    writeFileSync(`${process.env.VOICE_EVAL_OUT}.md`, `${board}\n`);
    writeFileSync(`${process.env.VOICE_EVAL_OUT}.json`, `${JSON.stringify(scores, null, 2)}\n`);
  }
  assert.equal(origins.collisions, 0, "every packet the speakers sent can be told apart");
  for (const score of scores) {
    assert.equal(score.scenarios.length, scenarios.length, `${score.pipeline}: every scenario ran`);
    assert.equal(score.errors, 0, `${score.pipeline}: the harness's app saw nothing unexpected`);
    const failures = Object.entries(score.logs).filter(([type]) => /voice_(utterance_failed|utterance_dropped|segment_failed|audio_failed|reply_failed|reply_stream_failed|speech_event_failed)/.test(type));
    assert.deepEqual(failures, [], `${score.pipeline}: nothing in the pipeline failed`);
    const qa = score.scenarios.find(scenario => scenario.name === "qa-single");
    if (qa) assert.equal(qa.answered, qa.addressed, `${score.pipeline}: one person's plain questions are all answered (${qa.notes.join("; ")})`);
  }
});
