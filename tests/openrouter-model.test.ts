import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultModels } from "../src/model.ts";
import { passthroughModel, withOpenRouterDetails } from "../src/openrouter-model.ts";
import { reasoningFloor } from "../src/pi-catalog.ts";
import { resolveModel } from "../src/session-config.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { listen, runtime } from "./runtime-server.ts";

const endpoint = (extra: object = {}) => ({ context_length: 400_000, max_completion_tokens: 64_000, supported_parameters: ["tools", "reasoning", "temperature"], pricing: { prompt: "0.000075", completion: "0.0003", input_cache_read: "0.0000075" }, ...extra });
const answers: Record<string, () => [number, object]> = {
  "/models/new/dear/endpoints": () => [200, { data: { name: "New: Dear", architecture: { input_modalities: ["text"] }, endpoints: [endpoint(), endpoint({ context_length: 200_000, max_completion_tokens: 32_000, pricing: { prompt: "0.000001", completion: "0.000002" } })] } }],
  "/models/new/no-tools/endpoints": () => [200, { data: { endpoints: [endpoint({ supported_parameters: ["temperature"] })] } }],
  "/models/new/down/endpoints": () => [503, {}],
  "/models/new/plain/endpoints": () => [200, { data: { endpoints: [endpoint({ supported_parameters: ["tools"], max_completion_tokens: null })] } }],
};
const server = async (t: Parameters<typeof runtime>[0]) => listen(t, (req, res) => {
  const [status, body] = answers[req.url!]?.() ?? [404, { error: { code: 404, message: "No model found" } }];
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
});

test("an uncatalogued openrouter id resolves to safe defaults; another provider's stays unknown; an operator's typo stops the node", () => {
  const model = resolveModel("openrouter/new/dear:nitro") as any;
  assert.deepEqual([model.id, model.provider, model.api, model.contextWindow, model.maxTokens, model.passthrough], ["new/dear:nitro", "openrouter", "openai-responses", 128_000, 8_192, true]);
  assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.equal(passthroughModel("anthropic/claude-new").api, "anthropic-messages");
  assert.equal((resolveModel("openrouter/deepseek/deepseek-v4.1-flash-1017") as any).passthrough, undefined, "the catalog's stays the catalog's");
  assert.throws(() => resolveModel("nope/thing"), /Unknown model/);
  assert.throws(() => defaultModels(resolveModel("anthropic/claude-sonnet-5-5"), "openrouter/typo/model"), /AGENT_MODEL_FALLBACKS.*Unknown model/);
});

test("one lookup fills in what the runtime needs; no such model and no tools are 400s; out of reach leaves the defaults", async t => {
  process.env.AGENT_OPENROUTER_API_URL = await server(t);
  t.after(() => { delete process.env.AGENT_OPENROUTER_API_URL; });
  const known = resolveModel("openrouter/deepseek/deepseek-v4.1-flash-1017");
  assert.equal(await withOpenRouterDetails(known), known, "a catalog model makes no lookup");
  const dear = await withOpenRouterDetails(passthroughModel("new/dear:nitro"));
  assert.deepEqual([dear.id, dear.name, dear.contextWindow, dear.maxTokens, dear.input, dear.reasoning, (dear as any).passthrough], ["new/dear:nitro", "New: Dear", 400_000, 32_000, ["text"], true, undefined]);
  assert.deepEqual(dear.cost, { input: 75, output: 300, cacheRead: 7.5, cacheWrite: 0 }, "the dearest host's, for holds");
  assert.equal(reasoningFloor(dear), "low", "never asks for reasoning off, which a model that always reasons refuses");
  const plain = await withOpenRouterDetails(passthroughModel("new/plain"));
  assert.equal(reasoningFloor(plain), undefined);
  assert.deepEqual([plain.reasoning, plain.maxTokens, (plain.compat as any).supportsTemperature], [false, 8_192, false]);
  await assert.rejects(withOpenRouterDetails(passthroughModel("new/nothing")), /OpenRouter has no model "new\/nothing": No model found/);
  await assert.rejects(withOpenRouterDetails(passthroughModel("new/no-tools")), /cannot run an agent: OpenRouter lists no tool support/);
  const down = await withOpenRouterDetails(passthroughModel("new/down"));
  assert.deepEqual([down.contextWindow, down.maxTokens, down.cost.input, (down as any).passthrough], [128_000, 8_192, 3, undefined]);
});

test("over the API: an agent keeps what the lookup said, a move looks up too, and its calls name the id and add no routing", async t => {
  const list = await server(t);
  const provider = await gateway(t, () => responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Passed through." }] }]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_OPENROUTER_API_URL: list });
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  const made = await r.call("/v1/agents", { body: { model: "openrouter/new/plain", keyScope: "hosted" } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await r.call(`/v1/agents/${made.json.id}`)).json.model, "openrouter/new/plain");
  const stored = (await r.db.query("select header->'config'->'model' as model from agents where id = $1", [made.json.id])).rows[0].model;
  assert.deepEqual([stored.contextWindow, stored.cost.input, stored.passthrough], [400_000, 75, undefined], "kept with the agent");
  const refused = await r.call("/v1/agents", { body: { model: "openrouter/new/nothing" } });
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.json), /OpenRouter has no model/);
  const moved = await r.call(`/v1/agents/${made.json.id}/configuration`, { method: "PATCH", body: { model: "openrouter/new/dear" } });
  assert.equal(moved.status, 202, JSON.stringify(moved.json));
  assert.equal((await r.prompt(made.json.id, "Hi")).outcome.result.reply, "Passed through.");
  const stored2 = (await r.db.query("select header->'config'->'model' as model from agents where id = $1", [made.json.id])).rows[0].model;
  assert.deepEqual([stored2.id, stored2.contextWindow, stored2.maxTokens], ["new/dear", 400_000, 32_000], "a move looks up too");
  const body = provider.requests.at(-1)!.body;
  assert.equal(body.model, "new/dear");
  assert.equal(body.provider, undefined);
  assert.equal(body.reasoning?.effort, "low", "an agent with no level, on a model the lookup can't say can turn it off");
});
