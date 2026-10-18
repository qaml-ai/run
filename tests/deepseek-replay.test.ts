import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { openRouterApi } from "../src/catalog.ts";
import { explicitKeyStream } from "../src/compaction.ts";
import { deepseekContext, deepseekTarget, refusedReasoningReplay } from "../src/deepseek-replay.ts";
import { errorClass } from "../src/metrics.ts";
import { retriesModelError } from "../src/model-errors.ts";
import { getModel } from "../src/pi-catalog.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { fakeModel, runtime, toolCall } from "./runtime-server.ts";

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
/** OpenRouter's routing is its own: no request of ours has a `provider` field (an order or sort turns off its load balancing). */
const unrouted = (bodies: any[]) => assert.ok(bodies.every(body => !("provider" in body)), JSON.stringify(bodies.map(body => body.provider)));
/** 1017's requests name its hosts (`provider.only`, pi-catalog.ts OPENROUTER_HOSTS), and nothing else of routing. */
const HOSTS_1017 = ["baseten", "morph", "parasail", "relace", "deepseek"];
const onlyHosts = (bodies: any[]) => { for (const body of bodies) assert.deepEqual(body.provider, { only: HOSTS_1017 }); };
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
  onlyHosts(host.bodies);
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
  onlyHosts(host.bodies);
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
  onlyHosts(host.bodies);
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
