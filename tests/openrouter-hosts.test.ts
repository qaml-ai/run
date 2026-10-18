import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, openRouterHosts, withOpenRouterHosts } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { resolveModel } from "../src/session-config.ts";
import { fakeModel, runtime, toolCall } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const HOSTS = ["fireworks", "together", "parasail", "coreweave", "nebius"];
const HOSTS_1017 = ["baseten", "parasail", "relace", "deepseek"];
/** camel-builder's 1017:nitro: 1017's hosts without Relace. */
const HOSTS_NITRO = ["parasail", "baseten", "deepseek"];
const FLASH = getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;
const FLASH_1017 = getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017")!;
/** Never an order or sort: either turns off OpenRouter's load balancing. Nor an ignore, a quantization or anything else. */
const onlyOnly = (bodies: any[]) => {
  for (const body of bodies) assert.ok(!body.provider || JSON.stringify(Object.keys(body.provider)) === '["only"]', JSON.stringify(body.provider));
};

test("DeepSeek V4.1 Flash and 1017 on OpenRouter may be served only by their listed hosts; other models by any", () => {
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash"), HOSTS);
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash:nitro"), HOSTS, "a routing variant with no entry of its own is its base model's");
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash-1017:nitro"), HOSTS_NITRO);
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash-1017:floor"), HOSTS_1017, "another variant of 1017: 1017's");
  assert.deepEqual(openRouterHosts("deepseek/deepseek-v4.1-flash-1017"), HOSTS_1017);
  for (const id of ["deepseek/deepseek-v4-flash", "moonshotai/kimi-k3", "z-ai/glm-5.3-flash"]) assert.equal(openRouterHosts(id), undefined, id);

  const request = { model: FLASH.id, messages: [] };
  assert.deepEqual((withOpenRouterHosts(FLASH, request) as any).provider, { only: HOSTS });
  assert.deepEqual((withOpenRouterHosts(FLASH_1017, request) as any).provider, { only: HOSTS_1017 });
  // Other models, and the same id on a tenant's own endpoint (its provider is the endpoint's name): as they were.
  const kimi = getModel("openrouter", "moonshotai/kimi-k3")!;
  assert.equal(withOpenRouterHosts(kimi, request), request);
  assert.equal(withOpenRouterHosts({ ...FLASH_1017, provider: "chiridion" }, request), request);
});

test("an agent's calls send their model's hosts: V4.1 Flash five, 1017 four with at most 262,144 tokens; nothing else", async t => {
  const host = await fakeModel(t, (_body, index) => index % 2 === 0 ? toolCall("js_exec", { code: "return 1 + 1;" }, `call_${index}`) : { role: "assistant", content: "2." });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: host.url } });
  for (const [model, only] of [[FLASH.id, HOSTS], [FLASH_1017.id, HOSTS_1017]] as const) {
    const from = host.bodies.length;
    const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${model}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
    assert.equal((await r.prompt(agent, "1 + 1?")).outcome.result.reply, "2.");
    const sent = host.bodies.slice(from);
    assert.equal(sent.length, 2, "a tool call and the answer");
    for (const body of sent) {
      assert.deepEqual(body.provider, { only }, model);
      assert.ok(Array.isArray(body.messages), "Chat Completions (deepseek-replay.ts)");
    }
    const most = sent[0].max_completion_tokens ?? sent[0].max_tokens;
    if (model === FLASH_1017.id) assert.ok(most <= 262_144, String(most));
    else assert.ok(most > 393_216, `V4.1 Flash keeps Pi's longest reply: ${most}`);
  }
  onlyOnly(host.bodies);
});

test("1017:nitro resolves as 1017 does (catalog, price, 262,144, Chat Completions), has its own hosts without Relace, and is sent with its variant", async t => {
  const nitro = resolveModel(`openrouter/${FLASH_1017.id}:nitro`);
  assert.deepEqual([nitro.id, nitro.api, nitro.maxTokens, nitro.contextWindow], [`${FLASH_1017.id}:nitro`, "openai-completions", 262_144, 1_048_576]);
  assert.deepEqual(nitro.cost, FLASH_1017.cost);
  assert.equal(platformUsage({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } as never, "openrouter", nitro.id).known, true);
  assert.deepEqual(openRouterHosts(nitro.id), HOSTS_NITRO, "its own entry: no Relace");
  assert.ok(!HOSTS_NITRO.includes("relace") && HOSTS_1017.includes("relace"), "plain 1017 keeps Relace");

  const host = await fakeModel(t, () => ({ role: "assistant", content: "Fast." }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: host.url } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH_1017.id}:nitro`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Fast.");
  const [sent] = host.bodies;
  assert.equal(sent.model, `${FLASH_1017.id}:nitro`, "the variant goes to OpenRouter as given: its throughput sort");
  assert.deepEqual(sent.provider, { only: HOSTS_NITRO }, "and nothing of ours beyond its hosts");
  assert.equal(sent.reasoning?.effort, "high");
  assert.ok((sent.max_completion_tokens ?? sent.max_tokens) <= 262_144);
});
