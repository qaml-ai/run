import { portedTest } from '../ported.ts';
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { openRouterApi } from "../../../src/catalog.ts";
import { explicitKeyStream } from "../../../src/compaction.ts";
import { deepseekContext, deepseekTarget, refusedReasoningReplay } from "../../../src/deepseek-replay.ts";
import { errorClass, observeTurns, setMetricSink } from "../../../src/metrics.ts";
import { retriesModelError } from "../../../src/model-errors.ts";
import { getModel } from "../../../src/pi-catalog.ts";
import { gateway, responses } from "../../provider-fixtures.ts";
import { fakeModel, listen, runtime, toolCall } from "../support.ts";

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
 * OpenRouter's routing is its own: no request of ours has a `provider` field (an order or sort turns off its load balancing),
 * except 1017's hosts it is never served by (pi-catalog.ts OPENROUTER_IGNORED_HOSTS), a filter.
 */
const unrouted = (bodies: any[]) => assert.ok(bodies.every(body => !("provider" in body) || (body.model.startsWith("deepseek/deepseek-v4.1-flash-1017") && JSON.stringify(body.provider) === JSON.stringify({ ignore: ["inference-net", "wafer", "relace", "coreweave"] }))), JSON.stringify(bodies.map(body => body.provider)));
const assistants = (body: any) => body.messages.filter((message: any) => message.role === "assistant");





portedTest('models', 'tests/deepseek-replay.test.ts:85')("a multi-turn tool conversation, then a turn on DeepSeek's own endpoint: never refused", async t => {
  // 1: a tool call from a host that sent no reasoning; 2: reasoning and another tool call; 3: the answer. DeepSeek's
  // endpoint checks every request; it refuses none.
  const host = await fakeModel(t, (body, index) => deepseekRefusal(body) ?? [
    toolCall("codemode", { code: "return 1 + 1;" }, "call_1"),
    { ...toolCall("codemode", { code: "return 2 + 2;" }, "call_2"), reasoning_content: "Now the second." },
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

portedTest('models', 'tests/deepseek-replay.test.ts:103')("if DeepSeek's endpoint refuses anyway, the same request is asked again: no host kept off, no order", async t => {
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



// As OpenRouter's Chat Completions API gives DeepSeek's refusal (2026-10-18 08:16 UTC, 1017:nitro): DeepSeek's words
// without its `invalid_prompt:` prefix (127 characters), the host in the error's metadata.
const REFUSAL_CHAT = "The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 5b23edce-9ac2-410b-9257-e11eb8b8ea61)";

portedTest('models', 'tests/deepseek-replay.test.ts:138')("DeepSeek's refusal as OpenRouter's Chat Completions gives it (127 characters) is classed and retried as it was; the answer names its host", async t => {
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


