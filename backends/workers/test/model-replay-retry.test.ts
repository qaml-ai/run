import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ModelReplayRetry, type ModelRetryEvent } from "../src/model-replay-retry.ts";

test("DeepSeek replay retries stop after three backoffs and report the source lifecycle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ModelRetryEvent[] = [];
  const retries = new ModelReplayRetry(event => { events.push(event); });
  const message = {
    provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", stopReason: "error",
    errorMessage: "400 The `reasoning_content` in the thinking mode must be passed back to the API.",
  } as AssistantMessage;
  retries.begin("first-run");
  for (const delay of [2000, 4000, 8000]) {
    const decision = retries.retry(message);
    await Promise.resolve();
    t.mock.timers.tick(delay - 1);
    let settled = false;
    void decision.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "the request waits for its complete backoff");
    t.mock.timers.tick(1);
    assert.equal(await decision, true);
  }
  assert.equal(await retries.retry(message), false, "the fourth failed request ends the run");
  const failure = { errorClass: "other", providerStatus: 400, retryable: true, model: "openrouter/deepseek/deepseek-v4.1-flash-1017" };
  assert.deepEqual(events, [
    ...[2000, 4000, 8000].map((delayMs, index) => ({
      type: "auto_retry_start", attempt: index + 1, maxAttempts: 3, delayMs,
      errorMessage: message.errorMessage, failure,
    })),
    { type: "auto_retry_end", success: false, attempt: 3, finalError: message.errorMessage, failure },
  ]);

  retries.begin("second-run");
  const decision = retries.retry(message);
  await Promise.resolve();
  t.mock.timers.tick(2000);
  assert.equal(await decision, true, "another run gets a fresh retry budget");
  await retries.success();
  assert.deepEqual(events.at(-1), { type: "auto_retry_end", success: true, attempt: 1 });
  const completed = events.length;
  await retries.success();
  assert.equal(events.length, completed, "a retry completion is emitted once");
});
