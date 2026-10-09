import { test } from "node:test";
import assert from "node:assert/strict";
import { toPiMessages } from "../clients/history-formats.ts";
import { validateInitialMessages } from "../src/history.ts";
import { runtime } from "./runtime-server.ts";

const PNG = "iVBORw0KGgo=";
/** Roles and content, without the fields the converter fills in. */
const shape = (messages: any[]) => messages.map(({ role, content, toolCallId, toolName, isError, provider, model }) =>
  ({ role, content, ...(toolCallId ? { toolCallId, toolName, isError } : {}), ...(role === "assistant" ? { provider, model } : {}) }));

test("an Anthropic Messages conversation imports with its tool calls, results, images and signed thinking", () => {
  const messages = toPiMessages({ format: "anthropic", model: "anthropic/claude-sonnet-5", messages: [
    { role: "user", content: [{ type: "text", text: "What is in this chart?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Look it up.", signature: "sig-1" }, { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "chart" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "sales" }], is_error: false }, { type: "text", text: "And?" }] },
    { role: "assistant", content: "It shows sales." },
  ] });
  validateInitialMessages(messages as never);
  assert.deepEqual(shape(messages), [
    { role: "user", content: [{ type: "text", text: "What is in this chart?" }, { type: "image", mimeType: "image/png", data: PNG }] },
    { role: "assistant", provider: "anthropic", model: "claude-sonnet-5", content: [
      { type: "thinking", thinking: "Look it up.", thinkingSignature: "sig-1" }, { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
      { type: "text", text: "Checking." }, { type: "toolCall", id: "toolu_1", name: "lookup", arguments: { q: "chart" } },
    ] },
    { role: "toolResult", toolCallId: "toolu_1", toolName: "lookup", isError: false, content: [{ type: "text", text: "sales" }] },
    { role: "user", content: [{ type: "text", text: "And?" }] },
    { role: "assistant", provider: "anthropic", model: "claude-sonnet-5", content: [{ type: "text", text: "It shows sales." }] },
  ]);
  assert.equal((messages[1] as any).stopReason, "toolUse");
  assert.ok(messages.every((message, index) => index === 0 || message.timestamp > messages[index - 1].timestamp), "in order");
});

test("an OpenAI Responses input imports: messages, function calls and outputs, and reasoning as thinking it can replay", () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Need the weather." }], encrypted_content: "enc" };
  const messages = toPiMessages({ format: "openai-responses", model: "openai/gpt-6-sol", messages: [
    { role: "developer", content: "Be brief." },
    { role: "user", content: "Weather in Paris?" },
    reasoning,
    { type: "function_call", call_id: "call_1", name: "weather", arguments: "{\"city\":\"Paris\"}" },
    { type: "function_call_output", call_id: "call_1", output: "18C" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "18C in Paris." }] },
  ] });
  validateInitialMessages(messages as never);
  assert.deepEqual(shape(messages), [
    { role: "user", content: "Weather in Paris?" },
    { role: "assistant", provider: "openai", model: "gpt-6-sol", content: [
      { type: "thinking", thinking: "Need the weather.", thinkingSignature: JSON.stringify(reasoning) },
      { type: "toolCall", id: "call_1", name: "weather", arguments: { city: "Paris" } },
    ] },
    { role: "toolResult", toolCallId: "call_1", toolName: "weather", isError: false, content: [{ type: "text", text: "18C" }] },
    { role: "assistant", provider: "openai", model: "gpt-6-sol", content: [{ type: "text", text: "18C in Paris." }] },
  ]);
});

test("an OpenAI Chat Completions conversation imports, with tool calls and data: images; the system message is left out", () => {
  const messages = toPiMessages({ format: "openai-chat", messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "Read this" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "ocr", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_a", content: "HELLO" },
    { role: "assistant", content: "It says HELLO." },
    { role: "assistant", content: "Anything else?" },
  ] });
  validateInitialMessages(messages as never);
  assert.deepEqual(shape(messages), [
    { role: "user", content: [{ type: "text", text: "Read this" }, { type: "image", mimeType: "image/png", data: PNG }] },
    { role: "assistant", provider: "openai", model: "unknown", content: [{ type: "toolCall", id: "call_a", name: "ocr", arguments: {} }] },
    { role: "toolResult", toolCallId: "call_a", toolName: "ocr", isError: false, content: [{ type: "text", text: "HELLO" }] },
    { role: "assistant", provider: "openai", model: "unknown", content: [{ type: "text", text: "It says HELLO." }] },
    { role: "assistant", provider: "openai", model: "unknown", content: [{ type: "text", text: "Anything else?" }] },
  ]);
});

test("what cannot be imported is refused, naming the message", () => {
  const refused = (input: any, pattern: RegExp) => assert.throws(() => toPiMessages(input), (error: Error) => pattern.test(error.message), JSON.stringify(input));
  refused({ format: "gemini", messages: [] }, /format is anthropic, openai-responses, openai-chat/);
  refused({ format: "anthropic", messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }] }, /messages\[0\]: an image must be a base64 data: URL/);
  refused({ format: "openai-chat", messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "nope", content: "x" }] }, /messages\[1\]: a tool result for "nope", which no earlier tool call has/);
  refused({ format: "openai-responses", messages: [{ type: "function_call", call_id: "c", name: "f", arguments: "[1]" }] }, /messages\[0\]: a function call's arguments are not a JSON object/);
  refused({ format: "openai-responses", messages: [{ type: "web_search_call", id: "ws" }] }, /messages\[0\]: an input item of type "web_search_call" cannot be imported/);
  refused({ format: "anthropic", model: "claude", messages: [] }, /model is "provider\/model-id"/);
});

test("an agent made with importMessages begins with the conversation, and a refused import makes no agent", async t => {
  const bodies: any[] = [];
  const r = await runtime(t, body => { bodies.push(body); return { role: "assistant", content: "Noted." }; });
  const created = await r.call("/v1/agents", { body: { importMessages: { format: "openai-chat", messages: [
    { role: "user", content: "My order is A-17." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "track", arguments: "{\"order\":\"A-17\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "SHIPPED-TUESDAY" },
    { role: "assistant", content: "It shipped Tuesday." },
  ] } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await r.prompt(created.json.id, "When did it ship?")).outcome.result.reply, "Noted.");
  const sent = JSON.stringify(bodies[0].messages);
  for (const seen of ["My order is A-17.", "SHIPPED-TUESDAY", "It shipped Tuesday.", "When did it ship?"]) assert.ok(sent.includes(seen), seen);
  assert.deepEqual((await r.call(`/v1/agents/${created.json.id}/history`)).json.messages.slice(0, 4).map((message: any) => message.role), ["user", "assistant", "toolResult", "assistant"]);

  const refused = await r.call("/v1/agents", { body: { importMessages: { format: "openai-chat", messages: [{ role: "tool", tool_call_id: "x", content: "y" }] } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "INVALID_HISTORY");
  assert.match(refused.json.error, /importMessages\.messages\[0\]/);
  assert.equal((await r.call("/v1/agents", { body: { initialMessages: [], importMessages: { format: "anthropic", messages: [] } } })).status, 400);
  assert.equal((await r.call("/v1/agents")).json.length, 1);
});
