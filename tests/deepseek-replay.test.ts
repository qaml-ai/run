import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { openRouterApi } from "../src/catalog.ts";
import { explicitKeyStream } from "../src/compaction.ts";
import { deepseekContext, deepseekTarget, refusedReasoningReplay } from "../src/deepseek-replay.ts";
import { errorClass, observeTurns, setMetricSink } from "../src/metrics.ts";
import { retriesModelError } from "../src/model-errors.ts";
import { getModel } from "../src/pi-catalog.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { fakeModel, listen, runtime, toolCall } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const FLASH = getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017")!;
const OLD = getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;
// DeepSeek's own API's words, as OpenRouter passes them on.
const REFUSAL = "invalid_prompt: The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 5b23edce-9ac2-410b-9257-e11eb8b8ea61)";

/**
 * DeepSeek's own endpoint as it checks a Chat Completions request: reasoning on, every assistant message must carry
 * `reasoning_content`, and every tool result must answer a tool call made before it.
 */
function deepseekRefusal(body: any): { httpStatus: number; message: string } | undefined {
  const reasons = !!body.reasoning?.effort && body.reasoning.effort !== "none";
  const calls = new Set<string>();
  for (const message of body.messages) {
    if (message.role === "assistant") {
      if (reasons && typeof message.reasoning_content !== "string") return { httpStatus: 400, message: REFUSAL };
      for (const call of message.tool_calls ?? []) calls.add(call.id);
    }
    if (message.role === "tool" && !calls.has(message.tool_call_id)) return { httpStatus: 400, message: `tool_call_id ${message.tool_call_id} answers no call` };
  }
  return undefined;
}
/**
 * OpenRouter's routing is its own beyond a model's hosts (pi-catalog.ts OPENROUTER_HOSTS): a request of ours has at most
 * a `provider.only`, never an order or sort (either turns off its load balancing).
 */
const unrouted = (bodies: any[]) => assert.ok(bodies.every(body => !("provider" in body) || JSON.stringify(Object.keys(body.provider)) === '["only"]'), JSON.stringify(bodies.map(body => body.provider)));
const assistants = (body: any) => body.messages.filter((message: any) => message.role === "assistant");

test("DeepSeek's models on OpenRouter are called on Chat Completions, agents made on Responses included; others keep Responses", () => {
  assert.equal(openRouterApi(FLASH.api, FLASH), "openai-completions");
  assert.equal(openRouterApi(OLD.api, OLD), "openai-completions");
  const kimi = getModel("openrouter", "moonshotai/kimi-k3")!;
  assert.equal(openRouterApi(kimi.api, kimi), "openai-responses");
  assert.equal(deepseekTarget({ ...FLASH, api: "openai-responses" as Api }).api, "openai-completions");
  assert.equal(deepseekTarget({ ...kimi, api: "openai-responses" as Api }).api, "openai-responses");
  // A tenant's own endpoint (provider: its name) is the tenant's to route: as it was.
  const endpoint = { ...FLASH, provider: "chiridion", id: `openrouter/${FLASH.id}`, api: "openai-responses" as Api };
  assert.equal(deepseekTarget(endpoint), endpoint);
});

test("a Responses-era DeepSeek history replays as DeepSeek's own API takes it: every turn's reasoning, paired tool ids", async t => {
  // Turns as an agent made before this held them: OpenRouter Responses, the old id, one turn with no reasoning at all.
  const item = (text: string) => JSON.stringify({ id: "rs_1", type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text }], summary: [] });
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const turn = (content: any[], model = OLD.id) => ({ role: "assistant" as const, content, api: "openai-responses" as Api, provider: "openrouter", model, usage, stopReason: "toolUse" as const, timestamp: 1 });
  const result = (toolCallId: string) => ({ role: "toolResult" as const, toolCallId, toolName: "js_exec", content: [{ type: "text" as const, text: "2" }], isError: false, timestamp: 1 });
  const context: Context = {
    systemPrompt: "You add.",
    messages: [
      { role: "user", content: "1 + 1, twice?", timestamp: 1 },
      turn([{ type: "thinking", thinking: "First sum.", thinkingSignature: item("First sum.") }, { type: "toolCall", id: "call_a|fc_1", name: "js_exec", arguments: { code: "1+1" } }]),
      result("call_a|fc_1"),
      // Another host's turn: no reasoning item.
      turn([{ type: "toolCall", id: "call_b|fc_2", name: "js_exec", arguments: { code: "1+1" } }], FLASH.id),
      result("call_b|fc_2"),
    ],
  };
  const replayed = deepseekContext(deepseekTarget({ ...FLASH, api: "openai-responses" as Api }), context);
  assert.deepEqual(replayed.messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []), ["call_a", "call_b"]);

  const host = await fakeModel(t, body => deepseekRefusal(body) ?? { role: "assistant", content: "Both are 2." });
  const model: Model<Api> = { ...FLASH, api: "openai-responses" as Api, baseUrl: host.url };
  const answer = await (await explicitKeyStream()(model, context as never, { apiKey: "sk-or", reasoning: "high" } as never)).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(answer.api, "openai-completions");
  const [sent] = host.bodies;
  assert.deepEqual(assistants(sent).map((message: any) => message.reasoning_content), ["First sum.", ""], "the reasoning text, and an empty one where there was none");
  assert.deepEqual(assistants(sent).map((message: any) => message.content ?? null), [null, null], "no reasoning leaks into the reply text");
  unrouted(host.bodies);
});

test("a multi-turn tool conversation, then a turn on DeepSeek's own endpoint: never refused", async t => {
  // 1: a tool call from a host that sent no reasoning; 2: reasoning and another tool call; 3: the answer. DeepSeek's
  // endpoint checks every request; it refuses none.
  const host = await fakeModel(t, (body, index) => deepseekRefusal(body) ?? [
    toolCall("js_exec", { code: "return 1 + 1;" }, "call_1"),
    { ...toolCall("js_exec", { code: "return 2 + 2;" }, "call_2"), reasoning_content: "Now the second." },
    { role: "assistant", content: "2 and 4." },
  ][index] ?? { role: "assistant", content: "Again." });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: host.url } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH.id}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "1 + 1, then 2 + 2?")).outcome.result.reply, "2 and 4.");
  assert.equal((await r.prompt(agent, "And again?")).outcome.result.reply, "Again.");
  assert.equal(host.bodies.length, 4, "no refusal, no retry");
  assert.deepEqual(assistants(host.bodies[3]).map((message: any) => message.reasoning_content), ["", "Now the second.", ""]);
  unrouted(host.bodies);
});

test("if DeepSeek's endpoint refuses anyway, the same request is asked again: no host kept off, no order", async t => {
  const host = await fakeModel(t, (_body, index) => index === 0 ? { httpStatus: 400, message: REFUSAL } : { role: "assistant", content: index === 1 ? "Retried." : "Later." });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: host.url } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH.id}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Retried.");
  assert.equal((await r.prompt(agent, "Hi again")).outcome.result.reply, "Later.");
  assert.equal(host.bodies.length, 3, "one retry");
  assert.deepEqual(host.bodies[1], host.bodies[0], "the retry is the refused request as it was");
  unrouted(host.bodies);
});

test("the refusal is its own error class (alarmed), retried on OpenRouter, not from a tenant's endpoint", () => {
  assert.equal(errorClass(`400 ${REFUSAL}`), "reasoning_replay");
  assert.equal(refusedReasoningReplay(`400 ${REFUSAL}`), true);
  const failed = { stopReason: "error" as const, errorMessage: `400 ${REFUSAL}`, provider: "openrouter", model: FLASH.id };
  assert.equal(retriesModelError(failed, { ownEndpoint: false }), true);
  assert.equal(retriesModelError(failed, { ownEndpoint: true }), false);
  assert.equal(retriesModelError({ ...failed, errorMessage: "400 invalid_prompt: something else" }, { ownEndpoint: false }), false);
});

test("a request for a model with no hosts listed (Kimi, on Responses) carries no provider field", async t => {
  const provider = await gateway(t, () => responses([{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hi.", annotations: [] }] }]));
  const kimi = getModel("openrouter", "moonshotai/kimi-k3")!;
  const context = { systemPrompt: "Greet.", messages: [{ role: "user" as const, content: "Hi", timestamp: 1 }] };
  const answer = await (await explicitKeyStream()({ ...kimi, api: "openai-responses" as Api, baseUrl: provider.url }, context as never, { apiKey: "sk-or", reasoning: "high" } as never)).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.match(provider.requests[0].path, /\/responses$/);
  unrouted(provider.requests.map(request => request.body));
});

// As OpenRouter's Chat Completions API gives DeepSeek's refusal (2026-10-18 08:16 UTC, 1017:nitro): DeepSeek's words
// without its `invalid_prompt:` prefix (127 characters), the host in the error's metadata.
const REFUSAL_CHAT = "The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 5b23edce-9ac2-410b-9257-e11eb8b8ea61)";

test("DeepSeek's refusal as OpenRouter's Chat Completions gives it (127 characters) is classed and retried as it was; the answer names its host", async t => {
  assert.equal(REFUSAL_CHAT.length, 127);
  assert.equal(errorClass(REFUSAL_CHAT), "reasoning_replay");
  assert.equal(retriesModelError({ stopReason: "error", errorMessage: REFUSAL_CHAT, provider: "openrouter", model: `${FLASH.id}:nitro` }, { ownEndpoint: false }), true);

  const bodies: any[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    if (bodies.length === 1) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: REFUSAL_CHAT, code: 400, metadata: { provider_name: "DeepSeek", raw: REFUSAL_CHAT } } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "gen-2", provider: "Parasail", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 } } : {}) })}\n\n`;
    res.write(chunk({ role: "assistant", content: "Retried." }, null));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${url}/v1` } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH.id}:nitro`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Retried.");
  assert.equal(bodies.length, 2, "one retry");
  assert.deepEqual(bodies[1], bodies[0], "the same request");
  // The answer says who served it (Parasail); the refused call, retracted for the retry, said DeepSeek (below).
  const history = (await r.call(`/v1/agents/${agent}/history`)).json;
  const answer = (Array.isArray(history) ? history : history.messages).findLast((message: any) => message.role === "assistant");
  assert.equal(answer.usage.providerHost, "Parasail");
});

test("a refused call carries the host OpenRouter named, and its model_error line logs it (a name, never the text)", async t => {
  const url = await listen(t, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: REFUSAL_CHAT, code: 400, metadata: { provider_name: "DeepSeek" } } }));
  });
  const model: Model<Api> = { ...FLASH, id: `${FLASH.id}:nitro`, baseUrl: `${url}/v1` };
  const context = { systemPrompt: "Greet.", messages: [{ role: "user" as const, content: "Hi", timestamp: 1 }] };
  const failed = await (await explicitKeyStream()(model, context as never, { apiKey: "sk-or", reasoning: "high" } as never)).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(errorClass(failed.errorMessage), "reasoning_replay", failed.errorMessage);
  assert.equal((failed.usage as { providerHost?: string }).providerHost, "DeepSeek");

  const lines: any[] = [];
  setMetricSink(line => lines.push(JSON.parse(line)));
  try { observeTurns(() => ({ provider: "openrouter", id: model.id })).event({ type: "message_end", message: failed } as never); } finally { setMetricSink(); }
  const line = lines.find(entry => entry.type === "model_error");
  assert.deepEqual([line.ErrorClass, line.host, line.error], ["reasoning_replay", "DeepSeek", `reasoning_replay (${failed.errorMessage!.length} chars)`]);
});
