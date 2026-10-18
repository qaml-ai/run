import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, withOpenRouterHosts } from "../src/pi-catalog.ts";
import { dataCollectionInput } from "../src/session-config.ts";
import { gateway, responses } from "./provider-fixtures.ts";
import { fakeModel, runtime, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const NITRO = "deepseek/deepseek-v4.1-flash-1017:nitro";
/** 1017's hosts, its :nitro variant's too (pi-catalog.ts OPENROUTER_HOSTS). */
const HOSTS_1017 = ["baseten", "parasail", "relace", "deepseek", "fireworks", "deepinfra", "primeintellect", "crusoe", "inference-net"];
const FLASH_1017 = getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017")!;
const KIMI = getModel("openrouter", "moonshotai/kimi-k3")!;
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

test("an OpenRouter request asks for hosts that do not collect its data only when its agent says so, merged with its hosts", () => {
  const request = { model: FLASH_1017.id, messages: [] };
  // Default: nothing of data collection.
  assert.deepEqual((withOpenRouterHosts(FLASH_1017, request) as any).provider, { only: HOSTS_1017 });
  assert.equal(withOpenRouterHosts(KIMI, request), request, "a model with no hosts listed: as it was");
  // "deny": merged with the model's only, or alone.
  assert.deepEqual((withOpenRouterHosts(FLASH_1017, request, "deny") as any).provider, { only: HOSTS_1017, data_collection: "deny" });
  assert.deepEqual((withOpenRouterHosts(KIMI, request, "deny") as any).provider, { data_collection: "deny" });
  // The agent's setting wins over a request's own; never an order or sort.
  assert.deepEqual((withOpenRouterHosts(KIMI, { ...request, provider: { data_collection: "allow", zdr: true } }, "deny") as any).provider, { zdr: true, data_collection: "deny" });
  // A tenant's own endpoint (its provider is the endpoint's name) is the tenant's to route.
  assert.equal(withOpenRouterHosts({ ...KIMI, provider: "chiridion" }, request, "deny"), request);

  assert.equal(dataCollectionInput("deny"), "deny");
  assert.equal(dataCollectionInput(null), null);
  for (const bad of ["allow", "DENY", true, {}]) assert.throws(() => dataCollectionInput(bad), /dataCollection must be "deny", or null/);
});

test("agents, runs, definitions and configure: data_collection deny sent when set, on Chat Completions and Responses; nothing by default", async t => {
  const chat = await fakeModel(t, () => ({ role: "assistant", content: "Chat." }));
  const responsesHost = await gateway(t, () => responses([message("Responses.")]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/chat/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: chat.url } });
  await r.call("/v1/key-scopes/responses/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${responsesHost.url}/openrouter` } });
  const make = async (body: object) => (await r.call("/v1/agents", { body })).json;

  // Chat Completions (DeepSeek), default and denied.
  const plain = await make({ model: `openrouter/${NITRO}`, keyScope: "chat", thinkingLevel: "high" });
  assert.equal(plain.dataCollection ?? null, null);
  await r.prompt(plain.id, "Hi");
  assert.deepEqual(chat.bodies.at(-1).provider, { only: HOSTS_1017 }, "default: its hosts alone");
  const denied = await make({ model: `openrouter/${NITRO}`, keyScope: "chat", thinkingLevel: "high", dataCollection: "deny" });
  await r.prompt(denied.id, "Hi");
  assert.deepEqual(chat.bodies.at(-1).provider, { only: HOSTS_1017, data_collection: "deny" });

  // Responses (Kimi, no hosts listed), default and denied.
  const kimi = await make({ model: "openrouter/moonshotai/kimi-k3", keyScope: "responses" });
  await r.prompt(kimi.id, "Hi");
  assert.match(responsesHost.requests.at(-1)!.path, /\/responses$/);
  assert.equal(responsesHost.requests.at(-1)!.body.provider, undefined, "default: no provider field");
  const kimiDenied = await make({ model: "openrouter/moonshotai/kimi-k3", keyScope: "responses", dataCollection: "deny" });
  await r.prompt(kimiDenied.id, "Hi");
  assert.deepEqual(responsesHost.requests.at(-1)!.body.provider, { data_collection: "deny" });

  // configure turns it on, and null off.
  const configure = async (agent: string, body: object) => {
    const accepted = await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
    await until(async () => (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json.state === "completed", "configured");
  };
  await configure(plain.id, { dataCollection: "deny" });
  await r.prompt(plain.id, "Again");
  assert.deepEqual(chat.bodies.at(-1).provider, { only: HOSTS_1017, data_collection: "deny" });
  assert.equal((await r.call(`/v1/agents/${plain.id}`)).json.dataCollection, "deny");
  await configure(plain.id, { dataCollection: null });
  await r.prompt(plain.id, "Once more");
  assert.deepEqual(chat.bodies.at(-1).provider, { only: HOSTS_1017 });

  // A stateless run, and an agent made from a definition.
  const beforeRun = chat.bodies.length;
  const run = await r.call("/v1/runs", { body: { model: `openrouter/${NITRO}`, keyScope: "chat", input: "Hi", wait: true, dataCollection: "deny" } });
  assert.deepEqual([run.status, run.json.status, run.json.text], [200, "completed", "Chat."], JSON.stringify(run.json));
  assert.equal(chat.bodies.length, beforeRun + 1);
  assert.deepEqual(chat.bodies.at(-1).provider, { only: HOSTS_1017, data_collection: "deny" }, "the run's call");
  const definition = (await r.call("/v1/definitions", { body: { name: "Private", model: `openrouter/${NITRO}`, systemPrompt: "Be brief.", dataCollection: "deny" } })).json;
  assert.equal(definition.dataCollection, "deny", JSON.stringify(definition));
  const fromDefinition = await make({ definition: definition.id, keyScope: "chat" });
  const before = chat.bodies.length;
  await r.prompt(fromDefinition.id, "Hi");
  assert.ok(chat.bodies.length > before);
  assert.deepEqual(chat.bodies.at(-1).provider, { only: HOSTS_1017, data_collection: "deny" });

  // Refused: anything but "deny" or null.
  assert.equal((await r.call("/v1/agents", { body: { model: `openrouter/${NITRO}`, dataCollection: "allow" } })).status, 400);
  for (const body of [...chat.bodies, ...responsesHost.requests.map(request => request.body)]) {
    assert.ok(!body.provider || (!("order" in body.provider) && !("sort" in body.provider)), JSON.stringify(body.provider));
  }
});

test("compaction summaries carry the agent's data policy too", async t => {
  const host = await fakeModel(t, () => ({ role: "assistant", content: "Summary: they said hello." }));
  const { runCompaction } = await import("../src/compaction.ts");
  const turn = (text: string, i: number) => [
    { role: "user", content: `${text} ${"x".repeat(400)}`, timestamp: i },
    { role: "assistant", content: [{ type: "text", text: `Reply ${i} ${"y".repeat(400)}` }], api: "openai-completions", provider: "openrouter", model: FLASH_1017.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: i },
  ];
  const context = [0, 1, 2, 3, 4, 5].flatMap(i => turn("Hello", i));
  const model = { ...FLASH_1017, baseUrl: host.url };
  for (const dataCollection of [undefined, "deny"] as const) {
    const before = host.bodies.length;
    await runCompaction({ context: context as never, offset: 0, model, apiKey: "sk-or", keepRecentTokens: 1, ...(dataCollection ? { dataCollection } : {}) });
    assert.ok(host.bodies.length > before, "a summary was asked for");
    for (const body of host.bodies.slice(before)) assert.deepEqual(body.provider, { only: HOSTS_1017, ...(dataCollection ? { data_collection: "deny" } : {}) });
  }
});
