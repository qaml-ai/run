import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { defaultModels } from "../src/model.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import { Tenants } from "../src/tenants.ts";
import { passthroughModel, withOpenRouterDetails } from "../src/openrouter-model.ts";
import { reasoningFloor } from "../src/pi-catalog.ts";
import { resolveModel } from "../src/session-config.ts";
import { testDatabase } from "./database.ts";
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

const USD = 1_000_000;

test("a pass-through model's looked-up price is what a call on the platform's key holds, of the tenant's credit and its end user's, not the mid-range one", async () => {
  const { db } = await testDatabase();
  const key = createHash("sha256").update("fixture").digest("hex");
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: key, billing: "prepaid" } }, platformKeys: { openrouter: "fixture" } }) });
  await tenants.reload();
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', $1, $1)", [100 * USD]);
  const service = new EndUserCredits(db);
  await service.setSettings("payg", { enabled: true });
  await service.post("payg", "person", { kind: "grant", amount: 50 * USD, key: "pay" });
  const attempts = new ModelAttempts(db, new Accounts({ tenants, db }), undefined, 0, undefined, service);
  const hold = async (rates?: { input: number; output: number }) => {
    const id = randomUUID();
    await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: "new/dear", kind: "response", at: Date.now(), keyHash: key,
      estimate: { inputTokens: 100_000, maxOutputTokens: 1_000, rates: rates ?? { input: 0, output: 0 } }, endUser: { id: "person", bucket: "b" } } as never);
    const held = Number((await db.query("select paid + allowance as n from end_user_holds where id = $1", [id])).rows[0].n);
    const tenantHeld = Number((await db.query("select amount from credit_holds where id = $1", [id])).rows[0].amount);
    await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { input: 0, output: 0 }, chars: 0, completed: false });
    return { held, tenantHeld };
  };
  // As the agent holds it after its lookup: $75 and $300 per million, with OpenRouter's funding on top.
  const looked = await hold({ input: 75, output: 300 });
  assert.ok(looked.held > 7.5 * USD && looked.held < 9 * USD, `the end user's, about $8.25: ${looked.held}`);
  assert.ok(looked.tenantHeld > 7.5 * USD && looked.tenantHeld < 9 * USD, `the tenant's, about $8.25: ${looked.tenantHeld}`);
  const unknown = await hold();
  assert.ok(unknown.held < USD && unknown.tenantHeld < USD, `the mid-range $3 and $15 with no price: ${JSON.stringify(unknown)}`);
});

test("over the API: the lookup's price reaches an end user's hold, so a dear model is refused where the mid-range price would have started", async t => {
  const list = await server(t);
  const provider = await gateway(t, () => responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Should not be asked." }] }]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_OPENROUTER_API_URL: list });
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true } });
  await r.call("/v1/end-users/person/entries", { body: { kind: "grant", amount: USD / 10, key: "pay" } });
  // About 10,000 tokens of input: $0.75 at the looked-up $75 per million, $0.03 at the mid-range $3. On $0.10, only the second would start.
  const text = "word ".repeat(8_000);
  const dear = (await r.call("/v1/agents", { body: { model: "openrouter/new/dear", keyScope: "hosted", subject: "person", bucket: "b" } })).json.id;
  const refused = await r.prompt(dear, text);
  assert.equal(provider.requests.length, 0, "no call was made");
  assert.equal(refused.outcome.result.stopped, "spend_limit");
  assert.equal(refused.outcome.result.limit, "end_user");
  // With no lookup, the same call starts at the mid-range price.
  const down = (await r.call("/v1/agents", { body: { model: "openrouter/new/down", keyScope: "hosted", subject: "person", bucket: "b" } })).json.id;
  const started = await r.prompt(down, text);
  assert.equal(started.outcome.result.reply, "Should not be asked.");
  assert.equal(provider.requests.length, 1);
});
