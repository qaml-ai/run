import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { listModels, toolCallStreaming } from "../src/catalog.ts";
import { ensureOpenRouterModel, setOpenRouterModels, startOpenRouterModels } from "../src/openrouter-models.ts";
import { getModel, reasoningFloor, temperatureRefusal } from "../src/pi-catalog.ts";
import { catalogCost, platformUsage } from "../src/platform-pricing.ts";
import { resolveModel } from "../src/session-config.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { listen, OPERATOR, runtime } from "./runtime-server.ts";

const listing = (id: string, extra: object = {}) => ({
  id, name: id, context_length: 400_000, supported_parameters: ["tools", "reasoning", "temperature"],
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, top_provider: { max_completion_tokens: 64_000 },
  reasoning: { mandatory: false, supported_efforts: ["none", "low", "high"] },
  pricing: { prompt: "0.000075", completion: "0.0003", input_cache_read: "0.0000075" }, ...extra,
});
const LIST = { data: [
  listing("new/dear"),
  listing("new/text-only", { architecture: { input_modalities: ["text"], output_modalities: ["text"] } }),
  listing("new/always-reasons", { reasoning: { mandatory: true, supported_efforts: ["medium", "high"] } }),
  listing("new/plain", { supported_parameters: ["tools"], reasoning: null, pricing: { prompt: "0.000001", completion: "0.000002" }, top_provider: {} }),
  listing("new/router", { pricing: { prompt: "-1", completion: "-1" } }),
  listing("new/no-tools", { supported_parameters: ["temperature"] }),
  listing("anthropic/claude-new", { supported_parameters: ["tools", "reasoning"] }),
  listing("deepseek/deepseek-new"),
  listing("particle-ai/particle-1", { pricing: { prompt: "0.009", completion: "0.009" } }),
] };

test("a listed model comes from OpenRouter's values; one Pi's catalog has stays as it is", () => {
  setOpenRouterModels(LIST);
  const dear = resolveModel("openrouter/new/dear");
  assert.deepEqual([dear.provider, dear.id, dear.contextWindow, dear.maxTokens, dear.input, dear.reasoning, dear.api], ["openrouter", "new/dear", 400_000, 64_000, ["text", "image"], true, "openai-responses"]);
  assert.deepEqual(dear.cost, { input: 75, output: 300, cacheRead: 7.5, cacheWrite: 0 });
  assert.deepEqual(catalogCost("openrouter", "new/dear")!.output, 300, "holds read the listed price");
  assert.equal(resolveModel("openrouter/new/dear:nitro").id, "new/dear:nitro", "a routing variant is its base's");
  assert.deepEqual(resolveModel("openrouter/new/text-only").input, ["text"]);
  // No longest reply listed: a bounded one. No cache price listed: a cached token is not estimated as free.
  const plain = getModel("openrouter", "new/plain")!;
  assert.deepEqual([plain.maxTokens, plain.reasoning, plain.cost.cacheRead, temperatureRefusal(plain, undefined)], [32_000, false, 1, "its provider refuses one for this model"]);
  // A router's price is unknown (-1): held as a mid-range model's, never as free.
  assert.deepEqual(getModel("openrouter", "new/router")!.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  // Claude keeps OpenRouter's Messages API, DeepSeek its Chat Completions, as the catalog's do.
  const claude = resolveModel("openrouter/anthropic/claude-new");
  assert.deepEqual([claude.api, claude.baseUrl], ["anthropic-messages", "https://openrouter.ai/api"]);
  assert.equal(resolveModel("openrouter/deepseek/deepseek-new").api, "openai-completions");
  // Pi's own entry wins, with our corrections.
  assert.notEqual(getModel("openrouter", "particle-ai/particle-1")!.cost.input, 9000);
  assert.equal(listModels("openrouter").filter(model => model.id === "openrouter/particle-ai/particle-1").length, 1, "listed once");
});

test("reasoning levels come from the listed efforts, and a model that cannot turn it off has a floor", () => {
  setOpenRouterModels(LIST);
  const free = getModel("openrouter", "new/dear")!;
  assert.deepEqual(free.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
  assert.equal(reasoningFloor(free), undefined);
  assert.equal(reasoningFloor(getModel("openrouter", "new/always-reasons")!), "low");
});

test("a model without tools fails clearly when named, is not listed, and an unknown one still says unknown", () => {
  setOpenRouterModels(LIST);
  assert.throws(() => resolveModel("openrouter/new/no-tools"), /cannot run an agent: OpenRouter lists no tool support/);
  assert.throws(() => resolveModel("openrouter/new/no-tools:nitro"), /cannot run an agent/);
  assert.ok(!listModels("openrouter").some(model => model.id === "openrouter/new/no-tools"));
  assert.throws(() => resolveModel("openrouter/new/nothing"), /Unknown model/);
});

test("unmeasured listed models say toolCallStreaming false; measured ones and other catalog models are as they were", () => {
  setOpenRouterModels(LIST);
  assert.equal(toolCallStreaming("openrouter/new/dear"), false);
  assert.equal(listModels("openrouter").find(model => model.id === "openrouter/new/dear")!.toolCallStreaming, false);
  assert.equal(toolCallStreaming("openrouter/anthropic/claude-sonnet-5.5"), true);
  assert.equal(toolCallStreaming("nope/model"), "unknown");
});

test("what OpenRouter reports is what a listed model bills, whatever its listed price", () => {
  setOpenRouterModels(LIST);
  const billed = platformUsage({ input: 1_000_000, output: 1_000, cacheRead: 0, cacheWrite: 0, providerCost: 0.42, cost: {} as Record<string, number> }, "openrouter", "new/dear");
  assert.equal(billed.known, true);
  assert.equal(billed.usage.providerCost, 0.42);
  assert.equal(billed.estimated, false);
});

test("an answer with no models leaves the list; the list is asked again for a new model, at most once a minute", async t => {
  setOpenRouterModels(LIST);
  assert.equal(setOpenRouterModels({ data: [] }), 0);
  assert.equal(setOpenRouterModels({ error: "down" }), 0);
  assert.ok(getModel("openrouter", "new/dear"));

  let calls = 0, answer: unknown = LIST, fail = false;
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  startOpenRouterModels("https://list.example.test/models", (async () => {
    calls++;
    if (fail) throw new Error("unreachable");
    return new Response(JSON.stringify(answer));
  }) as typeof fetch);
  const known = (id: string) => getModel("openrouter", id);
  await ensureOpenRouterModel("openrouter/new/dear", known);
  await new Promise(resolve => setImmediate(resolve));
  const started = calls;
  // Released since the list was read: too soon to ask again, then asked once.
  answer = { data: [...LIST.data, listing("new/released-today")] };
  await ensureOpenRouterModel("openrouter/new/released-today", known);
  assert.equal(calls, started, "within the minute");
  t.mock.timers.tick(61_000);
  await ensureOpenRouterModel("openrouter/new/released-today", known);
  assert.equal(calls, started + 1);
  assert.ok(resolveModel("openrouter/new/released-today"));
  await ensureOpenRouterModel("openrouter/new/released-today", known);
  assert.equal(calls, started + 1, "known now: not asked");
  await ensureOpenRouterModel("anthropic/claude-sonnet-5-5", known);
  assert.equal(calls, started + 1, "only openrouter/ models");
  // A list that cannot be read leaves what there is, and an unknown model fails as unknown.
  fail = true;
  t.mock.timers.tick(61_000);
  await ensureOpenRouterModel("openrouter/new/still-not-there", known);
  assert.ok(getModel("openrouter", "new/released-today"));
  assert.throws(() => resolveModel("openrouter/new/still-not-there"), /Unknown model/);
});

test("over the API: a listed model makes an agent that runs, one with no tools is a 400, and GET /v1/models lists it", async t => {
  const list = await listen(t, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(LIST)); });
  const provider = await gateway(t, () => responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "From the listed model." }] }]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_OPENROUTER_MODELS_URL: `${list}/models`,
  }, { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: { openrouter: "fixture-model-key" } } } });
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });

  const made = await r.call("/v1/agents", { body: { model: "openrouter/new/dear", keyScope: "hosted" } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await r.call(`/v1/agents/${made.json.id}`)).json.model, "openrouter/new/dear");
  assert.equal((await r.prompt(made.json.id, "Hi")).outcome.result.reply, "From the listed model.");
  assert.equal(provider.requests[0].body.model, "new/dear");
  assert.equal(provider.requests[0].body.provider, undefined, "OpenRouter's routing: nothing sent");

  const refused = await r.call("/v1/agents", { body: { model: "openrouter/new/no-tools" } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error?.message ?? refused.json.error ?? "", /cannot run an agent/);
  const models = (await r.call("/v1/models?provider=openrouter")).json;
  const entry = (models.data ?? models).find((model: any) => model.id === "openrouter/new/dear");
  assert.deepEqual([entry.contextWindow, entry.maxTokens, entry.cost.output, entry.toolCallStreaming], [400_000, 64_000, 300, false]);
});
