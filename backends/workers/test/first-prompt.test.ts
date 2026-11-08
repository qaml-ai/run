import assert from "node:assert/strict";
import test from "node:test";
import { firstPrompt } from "../src/first-prompt.ts";

test("first prompts reject malformed requests before provisioning", () => {
  assert.throws(() => firstPrompt({ requestId: "empty" }), /Send/);
  assert.throws(() => firstPrompt({ text: "hi", metadata: { count: 3 } }), /metadata/);
  const request = firstPrompt({ text: "hi", requestId: "first", metadata: { source: "web" } })!;
  assert.deepEqual(request, { id: "first", method: "prompt", params: { text: "hi", metadata: { source: "web" } } });
});

test("first prompts accept the tenant's run payer", () => {
  assert.deepEqual(firstPrompt({ text: 'hi', endUser: 'guest', requestId: 'paid' }), {
    id: 'paid', method: 'prompt', params: { text: 'hi', endUser: 'guest' },
  });
});
