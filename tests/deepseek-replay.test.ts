import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel } from "../src/pi-catalog.ts";
import { deepseekPayload, refusedReasoningReplay, turnWithoutReasoning } from "../src/deepseek-replay.ts";
import { retriesModelError } from "../src/model-errors.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { runtime } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const FLASH = getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017")!;
// As DeepSeek's own API words it, through OpenRouter.
const REFUSED = "400 invalid_prompt: The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 5b23edce)";
const reasoning = (id: string) => ({ type: "reasoning", id, summary: [], content: [{ type: "reasoning_text", text: "Thinking." }] });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "js_exec", arguments: "{}" });
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "2" });
const user = { role: "user", content: [{ type: "input_text", text: "Hi" }] };
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

test("an assistant turn without reasoning is found, wherever it is in the input", () => {
  assert.equal(turnWithoutReasoning([user]), false);
  assert.equal(turnWithoutReasoning([user, reasoning("rs_1"), call("a"), output("a"), reasoning("rs_2"), message("Done.")]), false);
  assert.equal(turnWithoutReasoning([user, reasoning("rs_1"), call("a"), output("a"), call("b"), output("b"), reasoning("rs_3"), call("c")]), true, "the middle turn");
  assert.equal(turnWithoutReasoning([user, reasoning("rs_1"), call("a"), output("a"), message("Done.")]), true, "the last turn");
  assert.equal(turnWithoutReasoning(undefined), false);
});

test("a reasoning call to a DeepSeek model on OpenRouter keeps off DeepSeek's endpoint only when that endpoint would refuse it", () => {
  const missing = { model: FLASH.id, reasoning: { effort: "high" }, input: [user, call("a"), output("a")] };
  assert.deepEqual((deepseekPayload(FLASH, missing) as any).provider, { ignore: ["deepseek"] });
  // Other routing is kept, and nothing is added twice.
  assert.deepEqual((deepseekPayload(FLASH, { ...missing, provider: { ignore: ["parasail", "deepseek"], sort: "price" } }) as any).provider, { ignore: ["parasail", "deepseek"], sort: "price" });
  // Every turn reasoned, reasoning off, or another model: as it was.
  const whole = { ...missing, input: [user, reasoning("rs_1"), call("a"), output("a")] };
  assert.equal(deepseekPayload(FLASH, whole), whole);
  const off = { ...missing, reasoning: { effort: "none" } };
  assert.equal(deepseekPayload(FLASH, off), off);
  const kimi = getModel("openrouter", "moonshotai/kimi-k3")!;
  assert.equal(deepseekPayload(kimi, missing), missing);
  // After a refusal (`avoid`), every reasoning call keeps off it.
  assert.deepEqual((deepseekPayload(FLASH, whole, true) as any).provider, { ignore: ["deepseek"] });
  assert.equal(deepseekPayload(FLASH, off, true), off);
});

test("DeepSeek's refusal is retried on OpenRouter, not from a tenant's own endpoint", () => {
  const failed = { stopReason: "error" as const, errorMessage: REFUSED, provider: "openrouter", model: FLASH.id };
  assert.equal(refusedReasoningReplay(REFUSED), true);
  assert.equal(retriesModelError(failed, { ownEndpoint: false }), true);
  assert.equal(retriesModelError(failed, { ownEndpoint: true }), false);
  assert.equal(retriesModelError({ ...failed, errorMessage: "400 invalid_prompt: something else" }, { ownEndpoint: false }), false);
});

test("an agent on 1017 keeps off DeepSeek's endpoint once a turn has no reasoning, and after a refusal retries elsewhere", async t => {
  // 1: a tool call without reasoning (another host's); 2: kept off DeepSeek, and refused anyway (as if routing hadn't);
  // 3: the retry answers.
  const provider = await gateway(t, (_body, index) => [
    responses([{ type: "function_call", id: "fc_1", call_id: "call_1", name: "js_exec", arguments: JSON.stringify({ code: "return 1 + 1;" }), status: "completed" }]),
    { status: 400, error: { message: REFUSED.slice(4), code: 400 } },
    responses([message("2.")]),
  ][index] ?? responses([message("Again.")]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH.id}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  const done = await r.prompt(agent, "1 + 1?");
  assert.equal(done.outcome.result.reply, "2.");
  const [first, second, third] = provider.requests;
  assert.equal(first.body.provider, undefined, "nothing to give back yet");
  assert.deepEqual(second.body.provider, { ignore: ["deepseek"] }, "the tool-call turn has no reasoning");
  assert.deepEqual(third.body.provider, { ignore: ["deepseek"] });
  assert.equal(provider.requests.length, 3, "one retry");
});

test("after a refusal, an agent's calls keep off DeepSeek's endpoint even when every turn reasoned", async t => {
  const provider = await gateway(t, (_body, index) => [
    responses([reasoning("rs_1"), message("Hello.")]),
    { status: 400, error: { message: REFUSED.slice(4), code: 400 } },
    responses([message("Again.")]),
  ][index] ?? responses([message("Later.")]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH.id}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Hello.");
  assert.equal((await r.prompt(agent, "Hi again")).outcome.result.reply, "Again.");
  assert.equal((await r.prompt(agent, "And again")).outcome.result.reply, "Later.");
  const sent = provider.requests.map(request => request.body.provider);
  assert.deepEqual(sent, [undefined, undefined, { ignore: ["deepseek"] }, { ignore: ["deepseek"] }]);
});
