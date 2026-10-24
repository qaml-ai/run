import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { errorClass } from "../src/metrics.ts";
import { MODEL_INTERRUPTED, modelFailure, providerStatus, retriesModelError, isImageRejection } from "../src/model-errors.ts";
import { isStalled } from "../src/model-stream.ts";

const failed = (errorMessage: string, rawStopReason?: string) =>
  ({ role: "assistant", stopReason: "error", errorMessage, ...(rawStopReason ? { rawStopReason } : {}), provider: "openrouter", model: "anthropic/claude-sonnet-5", content: [], timestamp: 0 }) as unknown as AssistantMessage;

/** Provider errors as pi-ai words them, and how each is classified: [message, rawStopReason, errorClass, providerStatus, retryable]. */
const FIXTURES: [string, string | undefined, string, number | undefined, boolean][] = [
  ["402 This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 9120.", undefined, "billing", 402, false],
  ["402 Insufficient credits", undefined, "billing", 402, false],
  ["429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)", undefined, "billing", 429, false],
  ["429 Too Many Requests", undefined, "rate_limit", 429, true],
  ["429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Number of request tokens has exceeded your per-minute rate limit\"}}", undefined, "rate_limit", 429, true],
  ["Mistral API error (429): {\"message\":\"Requests rate limit exceeded\"}", undefined, "rate_limit", 429, true],
  ["500 Internal Server Error", undefined, "server", 500, true],
  ["502 Bad Gateway", undefined, "server", 502, true],
  ["503 Service Unavailable", undefined, "server", 503, true],
  ["529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", undefined, "server", 529, true],
  ["fetch failed: ECONNRESET", undefined, "server", undefined, true],
  ["Request timed out.", undefined, "timeout", undefined, true],
  ["Model stream stalled: openrouter/anthropic/claude-sonnet-5 sent nothing within 120s of the request (timed out before its first token)", undefined, "timeout", undefined, true],
  ["The model refused to complete the request", "refusal", "refusal", undefined, false],
  ["I can't help with that request.", "refusal", "refusal", undefined, false],
  ["Provider finish_reason: content_filter", "content_filter", "refusal", undefined, false],
  ["Provider stopped with: sensitive", "sensitive", "refusal", undefined, false],
  ["Response incomplete: content_filter", "incomplete.content_filter", "refusal", undefined, false],
  ["401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}", undefined, "auth", 401, false],
  ["403 Forbidden", undefined, "auth", 403, false],
  ["No anthropic API key is configured for this agent's model, anthropic/claude-sonnet-5; set one with PUT /v1/providers/anthropic/key", undefined, "auth", undefined, false],
  ["400 prompt is too long: 250000 tokens > 200000 maximum", undefined, "other", 400, false],
  ["400 Invalid request: tools.0.name is invalid", undefined, "other", 400, false],
];

test("a failed response's class, status and retryability, from what each provider's error says", () => {
  for (const [message, raw, errorClass, status, retryable] of FIXTURES) {
    assert.deepEqual(modelFailure(failed(message, raw), { ownEndpoint: false, contextWindow: 200_000 }), {
      errorClass, ...(status !== undefined ? { providerStatus: status } : {}), retryable, model: "openrouter/anthropic/claude-sonnet-5",
    }, message);
  }
});

test("retryable is exactly the rule the host retried by before: pi-ai's transient errors, none on a tenant's own endpoint but a stall", () => {
  // agent-host.ts recoverFailedResponses before model-errors.ts: a context overflow went to compaction (never this
  // retry), then this predicate, inline. Retry behaviour is unchanged.
  const before = (message: AssistantMessage, ownEndpoint: boolean) =>
    message.errorMessage === MODEL_INTERRUPTED || (isRetryableAssistantError(message) && (!ownEndpoint || isStalled(message.errorMessage)));
  const messages = [...FIXTURES.map(([message, raw]) => failed(message, raw)), failed(MODEL_INTERRUPTED), failed("Provider returned error"), failed("socket hang up")];
  for (const message of messages) {
    for (const ownEndpoint of [false, true]) {
      const context = { ownEndpoint, contextWindow: 200_000 };
      const overflow = isContextOverflow(message, context.contextWindow);
      assert.equal(retriesModelError(message, context), !overflow && before(message, ownEndpoint), `${message.errorMessage} (own endpoint: ${ownEndpoint})`);
      assert.equal(modelFailure(message, context).retryable, retriesModelError(message, context));
    }
  }
  // An overflow pi-ai's retry patterns match (its "500" matches 250000): reported as not retryable, as the host never retries it.
  const overflow = failed("400 prompt is too long: 250000 tokens > 200000 maximum");
  assert.ok(isContextOverflow(overflow) && isRetryableAssistantError(overflow));
  assert.equal(modelFailure(overflow, { ownEndpoint: false }).retryable, false);
  // On a tenant's own endpoint (which retried already) a 429 is not retried here, nor reported retryable; a stall is.
  assert.equal(modelFailure(failed("429 Too Many Requests"), { ownEndpoint: true }).retryable, false);
  assert.equal(modelFailure(failed("Model stream stalled: openrouter/anthropic/claude-sonnet-5 sent nothing within 120s of the request (timed out before its first token)"), { ownEndpoint: true }).retryable, true);
});

test("the API's class is the metric's: a refusal and a quota used up are their own metric classes too", () => {
  assert.equal(errorClass("I can't help with that.", "refusal"), "refusal");
  assert.equal(errorClass("Provider finish_reason: content_filter"), "refusal");
  assert.equal(errorClass("429 You exceeded your current quota (insufficient_quota)"), "billing");
  assert.equal(errorClass("429 Too Many Requests"), "rate_limit");
  assert.equal(errorClass("Overloaded"), "overloaded");
});

test("a provider's HTTP status, wherever its error puts it", () => {
  assert.equal(providerStatus("429 Too Many Requests"), 429);
  assert.equal(providerStatus("402: {\"error\":\"credits\"}"), 402);
  assert.equal(providerStatus("Azure OpenAI API error (503): upstream"), 503);
  assert.equal(providerStatus("Request failed with status code 502"), 502);
  assert.equal(providerStatus("HTTP 504 from upstream"), 504);
  assert.equal(providerStatus("Request timed out."), undefined);
  assert.equal(providerStatus("used 1500 tokens"), undefined, "a number that is no status");
  assert.equal(providerStatus(undefined), undefined);
});


test("image-load errors have a private metric class and a separate one-shot recovery", () => {
  for (const message of ["Failed to load image: cannot identify image file", "CANNOT IDENTIFY IMAGE", "invalid image", "could not process image", "unable to process image", "image could not be decoded", "cannot decode image"]) {
    assert.equal(isImageRejection(message), true);
    assert.equal(errorClass(message), "image_rejected");
    assert.equal(retriesModelError(failed(message), { ownEndpoint: false }), false);
  }
  assert.equal(isImageRejection("too many images"), true);
  const limit = 'openrouter API error (400): {"message":"Provider returned error","metadata":{"raw":"Exceeded maximum number of images (50) allowed in the request."}}';
  assert.equal(errorClass(limit), "image_limit");
  assert.equal(isImageRejection(limit), true);
  assert.equal(modelFailure(failed(limit), { ownEndpoint: false }).errorClass, "image_limit");
  assert.equal(isImageRejection("400 invalid request"), false);
});
