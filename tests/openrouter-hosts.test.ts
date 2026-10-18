import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, openRouterHosts, withOpenRouterHosts } from "../src/pi-catalog.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { runtime } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const HOSTS = ["morph", "fireworks", "together", "parasail", "coreweave", "nebius"];
const FLASH = getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
/** Never an order or sort: either turns off OpenRouter's load balancing. */
const balanced = (bodies: any[]) => {
  for (const body of bodies) assert.ok(!body.provider || (!("order" in body.provider) && !("sort" in body.provider)), JSON.stringify(body.provider));
};

test("DeepSeek V4.1 Flash on OpenRouter may be served only by its listed hosts; other models by any", () => {
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash"), HOSTS);
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash:nitro"), HOSTS, "a routing variant is its base model's");
  for (const id of ["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash:batch-x", "moonshotai/kimi-k3", "z-ai/glm-5.3-flash"]) assert.equal(openRouterHosts(id), undefined, id);

  const request = { model: FLASH.id, input: [] };
  assert.deepEqual((withOpenRouterHosts(FLASH, request) as any).provider, { only: HOSTS });
  // A request's own routing is kept.
  assert.deepEqual((withOpenRouterHosts(FLASH, { ...request, provider: { ignore: ["deepseek"] } }) as any).provider, { only: HOSTS, ignore: ["deepseek"] });
  // Other models, and the same id on a tenant's own endpoint (its provider is the endpoint's name): as they were.
  const kimi = getModel("openrouter", "moonshotai/kimi-k3")!;
  assert.equal(withOpenRouterHosts(kimi, request), request);
  assert.equal(withOpenRouterHosts({ ...FLASH, provider: "chiridion" }, request), request);
});

test("an agent's calls on DeepSeek V4.1 Flash send provider.only, on 1017 no provider field, never an order or sort", async t => {
  const provider = await gateway(t, () => responses([message("Done.")]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  for (const [model, expected] of [["deepseek/deepseek-v4.1-flash", { only: HOSTS }], ["deepseek/deepseek-v4.1-flash-1017", undefined]] as const) {
    const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${model}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
    assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Done.");
    const sent = provider.requests.at(-1)!;
    assert.match(sent.path, /\/responses$/, "OpenRouter's Responses API");
    assert.deepEqual(sent.body.provider, expected, model);
  }
  balanced(provider.requests.map(request => request.body));
});

test("with a turn that had no reasoning, V4.1 Flash's call keeps its hosts and stays off DeepSeek's endpoint too", async t => {
  const provider = await gateway(t, (_body, index) => [
    responses([{ type: "function_call", id: "fc_1", call_id: "call_1", name: "js_exec", arguments: JSON.stringify({ code: "return 1 + 1;" }), status: "completed" }]),
    responses([message("2.")]),
  ][index] ?? responses([message("Again.")]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH.id}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "1 + 1?")).outcome.result.reply, "2.");
  assert.deepEqual(provider.requests.map(request => request.body.provider), [{ only: HOSTS }, { only: HOSTS, ignore: ["deepseek"] }]);
  balanced(provider.requests.map(request => request.body));
});
