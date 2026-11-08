import { test } from "node:test";
import assert from "node:assert/strict";
import { errorClass } from "../src/observability.ts";

// The pilot's alarm wakes that ran startup past 30 s were counted as context_overflow ("waited for too long").
test("a startup reset is its own error class, not a context overflow", () => {
  assert.equal(errorClass("A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset."), "startup_reset");
  assert.equal(errorClass("prompt is too long: 250000 tokens > 200000 maximum"), "context_overflow");
});
