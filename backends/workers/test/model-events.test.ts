import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { MessageProjection } from "../src/message-projection.ts";

test("failed response events carry the same provider classification as run errors", () => {
  const message = { role: "assistant", content: [], timestamp: 1, provider: "openrouter", model: "openai/gpt-4o-mini", stopReason: "error", errorMessage: "402 This request requires more credits" } as unknown as AssistantMessage;
  const events = new MessageProjection().events(message, true) as { type: string; failure?: unknown }[];
  assert.deepEqual(events.find(event => event.type === "message_end")?.failure, {
    errorClass: "billing", providerStatus: 402, retryable: false, model: "openrouter/openai/gpt-4o-mini",
  });
});
