import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { explicitKeyStream } from "../src/compaction.ts";
import { resolveModel } from "../src/session-config.ts";
import { gateway, responses } from "./provider-fixtures.ts";

test("OpenRouter Responses can replay distinct rounds whose provider returned the same tool call id", async t => {
  const model = resolveModel("openrouter/meta/muse-ember");
  assert.equal(model.api, "openai-responses");
  const host = await gateway(t, body => {
    const pending = new Set<string>(), answered = new Set<string>();
    for (const item of body.input) {
      if (item.type === "function_call") pending.add(item.call_id);
      if (item.type !== "function_call_output") continue;
      if (!pending.delete(item.call_id) || answered.has(item.call_id))
        return { status: 400, error: { message: "Duplicate or unmatched function_call_output" } };
      answered.add(item.call_id);
    }
    return responses([{ type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "All results received.", annotations: [] }] }]);
  });
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const call = (id: string, value: string): AssistantMessage => ({
    role: "assistant", model: model.id, provider: model.provider, api: model.api, stopReason: "toolUse", usage,
    timestamp: 1, content: [{ type: "toolCall", id, name: "lookup", arguments: { value } }],
  });
  const result = (toolCallId: string, text: string): ToolResultMessage => ({
    role: "toolResult", toolCallId, toolName: "lookup", isError: false, timestamp: 1, content: [{ type: "text", text }],
  });
  const original = "call_0_same|fc_1", later = "call_0_same|fc_2";
  const context = normalizeContext({ messages: [
    { role: "user", content: "Look up three things", timestamp: 1 },
    call(original, "first"), result(original, "result one"),
    call(later, "second"), result(later, "result two"),
    call(later, "third"), result(later, "result three"),
    { role: "user", content: "What did you find?", timestamp: 2 },
  ] });
  const before = structuredClone(context);
  const request = () => explicitKeyStream()({ ...model, baseUrl: host.url }, context, { apiKey: "fixture", maxRetries: 0 });
  for (let i = 0; i < 2; i++) {
    const reply = await (await request()).result();
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
  }
  const [sent, replay] = host.requests.map(request => request.body.input);
  const calls = sent.filter((item: { type: string }) => item.type === "function_call");
  const results = sent.filter((item: { type: string }) => item.type === "function_call_output");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].call_id, "call_0_same");
  assert.equal(new Set(calls.map((item: { call_id: string }) => item.call_id)).size, 3);
  assert.deepEqual(results.map((item: { call_id: string }) => item.call_id), calls.map((item: { call_id: string }) => item.call_id));
  assert.deepEqual(results.map((item: { output: string }) => item.output), ["result one", "result two", "result three"]);
  assert.deepEqual(replay, sent, "identical history keeps identical wire IDs");
  assert.deepEqual(context, before, "the stored transcript is not rewritten");
});
