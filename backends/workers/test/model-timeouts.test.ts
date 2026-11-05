import assert from "node:assert/strict";
import test from "node:test";
import { runtimeStreamTimeouts } from "../src/model-runtime-options.ts";
import { streamTimeouts, STREAM_TIMEOUTS, watchedStream } from "../src/model-stream.ts";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";

test("runtime stream defaults accept source environment options and per-agent limits take precedence", () => {
  const runtime = runtimeStreamTimeouts({ AGENT_MODEL_FIRST_TOKEN_SECONDS: "1", AGENT_MODEL_IDLE_SECONDS: "2" });
  assert.deepEqual(runtime, { firstTokenMs: 1000, idleMs: 2000 });
  assert.deepEqual(runtimeStreamTimeouts({}), { firstTokenMs: STREAM_TIMEOUTS.firstTokenMs, idleMs: STREAM_TIMEOUTS.idleMs });
  assert.deepEqual(streamTimeouts({ reasoning: false }, "off", null, runtime), runtime);
  assert.deepEqual(streamTimeouts({ reasoning: false }, "off", { firstTokenSeconds: 3, idleSeconds: 4 }, runtime), { firstTokenMs: 3000, idleMs: 4000 });
  for (const value of ["0", "3601", "NaN"]) assert.throws(() => runtimeStreamTimeouts({ AGENT_MODEL_IDLE_SECONDS: value }), /AGENT_MODEL_IDLE_SECONDS/);
});

test("a stalled provider closes without cooperation and exposes its source event details", async () => {
  const model = { provider: "test", id: "silent", api: "openai-completions" } as Model<Api>;
  const stalls: unknown[] = [];
  const stream = watchedStream(model, () => createAssistantMessageEventStream(), { firstTokenMs: 10, idleMs: 10 }, undefined, stall => stalls.push(stall));
  const result = await stream.result();
  assert.match(result.errorMessage!, /^Model stream stalled/);
  assert.equal(result.stopReason, "error");
  assert.equal(stalls.length, 1);
  assert.equal((stalls[0] as { phase: string }).phase, "first_token");
});
