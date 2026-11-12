import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { listModels } from "../src/catalog.ts";
import { getModels, withOpenRouterHosts } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { configuredModel, defaultModels } from "../src/model.ts";
import { isModelUnavailable } from "../src/model-errors.ts";
import { withModelFallback } from "../src/model-fallback.ts";
import { Accounts } from "../src/accounts.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import { Tenants } from "../src/tenants.ts";
import { resolveModel } from "../src/session-config.ts";
import { passthroughModel } from "../src/openrouter-model.ts";
import { askedTier, currentModel, modelReference, routeModel, virtualChain, virtualMember } from "../src/virtual-models.ts";
import { testDatabase } from "./database.ts";
import { responses } from "./provider-fixtures.ts";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, toolCall, toolResults } from "./runtime-server.ts";

const ALIAS = "camelrun/default", EMBER = "meta/muse-ember", FLASH = "deepseek/deepseek-v4.1-flash-1017";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const ALIASED = { ...LOCAL, AGENT_PROVIDER: "camelrun", AGENT_MODEL: "default", AGENT_HOSTING: "inline" };

const priced = (usage: Record<string, unknown>, id: string) => (platformUsage(usage, "openrouter", id).usage as { cost: { total: number } }).cost.total;
test("camelrun/default is a chain, its head as an agent holds it, and the runtime's default with nothing set", () => {
  assert.deepEqual(virtualChain(ALIAS)!.map(model => `${model.provider}/${model.id}`), [`openrouter/${EMBER}`, `openrouter/${FLASH}`]);
  const selection = resolveModel(ALIAS);
  assert.deepEqual([selection.provider, selection.id, modelReference(selection)], ["openrouter", EMBER, ALIAS]);
  assert.equal(modelReference(configuredModel({})), ALIAS);
  assert.equal(modelReference(configuredModel(ALIASED)), ALIAS);
  assert.equal(modelReference(configuredModel({ AGENT_PROVIDER: "openrouter", AGENT_MODEL: FLASH })), `openrouter/${FLASH}`, "prod's env today: no move until it changes");
  assert.equal(modelReference(resolveModel(`openrouter/${EMBER}`)), `openrouter/${EMBER}`, "a real model is itself");
  assert.throws(() => resolveModel("camelrun/nothing"), /Unknown model/);
  // An agent stored earlier takes what the name stands for now.
  assert.equal(currentModel({ ...resolveModel(ALIAS), id: "something/old" }).id, EMBER);
  const real = resolveModel(`openrouter/${FLASH}`);
  assert.equal(currentModel(real), real);
  // Those with no OpenRouter key go on down the list as before.
  assert.deepEqual(defaultModels(configuredModel({}), undefined).map(modelReference), [ALIAS, "azure/deepseek-v4.1-flash", "anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "amazon-bedrock/global.anthropic.claude-sonnet-5-5"]);
  const listed = listModels().find(model => model.id === ALIAS)!;
  assert.deepEqual(listed.routes, [`openrouter/${EMBER}`, `openrouter/${FLASH}`]);
  assert.deepEqual([listed.provider, listed.modelId, listed.contextWindow], ["camelrun", "default", 1_048_576]);
  assert.deepEqual(listModels("camelrun").map(model => model.id), [ALIAS, "camelrun/fast", "camelrun/strong"]);
  assert.ok(!listModels("openrouter").some(model => model.id === ALIAS));
});

test("camelrun/fast and camelrun/strong: strong asks Gemini 4 Carbon on flex, then the default tier; only it sends service_tier", () => {
  const CARBON = "google/gemini-4-carbon";
  const tiers = (reference: string) => virtualChain(reference)!.map(model => [`${model.provider}/${model.id}`, (model as { serviceTier?: string }).serviceTier]);
  assert.deepEqual(tiers("camelrun/fast"), [[`openrouter/${EMBER}`, undefined]]);
  assert.deepEqual(tiers("camelrun/strong"), [[`openrouter/${CARBON}`, "flex"], [`openrouter/${CARBON}`, "default"]]);
  assert.ok(virtualChain(ALIAS)!.every(model => !Object.hasOwn(model, "serviceTier")), "camelrun/default's members are as they were");
  const [flex, standard] = virtualChain("camelrun/strong")!;
  const strong = resolveModel("camelrun/strong");
  assert.equal((routeModel(strong, { reason: "retry", failed: flex }) as { serviceTier?: string }).serviceTier, "default");
  // Node's fallback names the failed model by its message, which carries no tier: the first member of the model.
  assert.equal((routeModel(strong, { reason: "retry", failed: { provider: "openrouter", model: CARBON } }) as { serviceTier?: string }).serviceTier, "default");
  assert.equal(routeModel(strong, { reason: "retry", failed: standard }), undefined);
  // Node names a response's member by the tier its request asked (askedTier): a continuation after the move stays on the
  // default tier, and the default tier's failure has no successor (so it is not superseded).
  const answered = (requestedServiceTier: string) => ({ provider: "openrouter", model: CARBON, ...askedTier({ usage: { requestedServiceTier, serviceTier: "default" } }) });
  assert.equal((routeModel(strong, { reason: "continuation", previous: answered("default") }) as { serviceTier?: string }).serviceTier, "default");
  assert.equal((routeModel(strong, { reason: "continuation", previous: answered("flex") }) as { serviceTier?: string }).serviceTier, "flex");
  assert.equal(routeModel(strong, { reason: "retry", failed: answered("default") }), undefined);
  assert.equal((routeModel(strong, { reason: "retry", failed: answered("flex") }) as { serviceTier?: string }).serviceTier, "default");
  assert.deepEqual(askedTier({ usage: {} }), {});
  assert.deepEqual(withOpenRouterHosts(flex, { model: CARBON }), { model: CARBON, service_tier: "flex" });
  for (const model of [...getModels("openrouter"), ...virtualChain(ALIAS)!]) assert.ok(!("service_tier" in (withOpenRouterHosts(model, { model: model.id }, "deny") as object)), model.id);
  const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
  assert.equal(priced({ ...tokens, serviceTier: "flex" }, CARBON), 6.05);
  assert.equal(priced({ ...tokens, serviceTier: "default" }, CARBON), 12.1);
  assert.equal(priced({ ...tokens, serviceTier: "flex" }, EMBER), priced(tokens, EMBER));
  assert.deepEqual(listModels("camelrun").find(model => model.id === "camelrun/strong")!.serviceTiers, ["flex", "default"]);
});

test("route: a message starts at the head, a continuation stays on previous, a retry moves past failed and ends", () => {
  const selection = resolveModel(ALIAS);
  const id = (reason: Parameters<typeof routeModel>[1]) => routeModel(selection, reason)?.id;
  assert.equal(id({ reason: "user" }), EMBER);
  assert.equal(id({ reason: "user", previous: { provider: "openrouter", model: FLASH } }), EMBER, "a recovered head takes the next message");
  assert.equal(id({ reason: "direct" }), EMBER);
  assert.equal(id({ reason: "continuation", previous: { provider: "openrouter", model: FLASH } }), FLASH);
  assert.equal(id({ reason: "continuation", previous: { provider: "anthropic", model: "claude-sonnet-5-5" } }), EMBER, "history from a model outside the chain");
  assert.equal(id({ reason: "retry", failed: { provider: "openrouter", id: EMBER } }), FLASH);
  assert.equal(id({ reason: "retry", failed: { provider: "openrouter", id: FLASH } }), undefined);
  const real = resolveModel(`openrouter/${FLASH}`);
  assert.equal(routeModel(real, { reason: "user" }), real);
  assert.equal(routeModel(real, { reason: "retry", failed: { provider: "openrouter", id: FLASH } }), undefined);
});

test("unavailable means the model or provider can't take it now, never what it would refuse anywhere", () => {
  for (const errorMessage of ["503 Service Unavailable", "502 Provider returned error", "500 internal server error", "429 Rate limit exceeded", "404 No endpoints found for meta/muse-ember", "404 No allowed providers are available", "Connection error: fetch failed", "Request timed out", "Model stream stalled: openrouter/x sent nothing within 60s of the request (timed out before its first token)"]) {
    assert.equal(isModelUnavailable({ errorMessage }), true, errorMessage);
  }
  for (const errorMessage of ["400 Invalid request: bad tool schema", "400 This model's maximum context length is 1048576 tokens", "401 Unauthorized", "402 Insufficient credits", "The model refused to answer", undefined]) {
    assert.equal(isModelUnavailable({ errorMessage }), false, String(errorMessage));
  }
});

const scripted = (provider: string, text: string, error?: string) => {
  const stream = createAssistantMessageEventStream();
  const base = { role: "assistant", content: [] as any[], api: "x", provider, model: provider, usage: {}, stopReason: "stop", timestamp: 0 } as any;
  stream.push({ type: "start", partial: base });
  if (text) { base.content.push({ type: "text", text }); stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: base }); }
  if (error) stream.push({ type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage: error } });
  else stream.push({ type: "done", reason: "stop", message: base });
  stream.end();
  return stream;
};

test("a model that fails before any output moves; one that has started streaming stays failed", async () => {
  const moves = (message: any, partial: any) => isModelUnavailable(message) && !partial?.content.length;
  const hooks = { moves, blocked: () => {}, unavailable: () => {}, aborted: () => false };
  const moved = await (await withModelFallback(scripted("a", "", "503 down"), () => scripted("b", "ok"), hooks)).result();
  assert.equal(moved.provider, "b");
  const started = await (await withModelFallback(scripted("a", "partly", "503 down"), () => scripted("b", "ok"), hooks)).result();
  assert.deepEqual([started.provider, started.errorMessage], ["a", "503 down"], "existing retry logic decides");
  const refused = await (await withModelFallback(scripted("a", "", "400 bad"), () => scripted("b", "ok"), hooks)).result();
  assert.equal(refused.provider, "a");
});

/** One OpenRouter: Ember on its Responses API as told, DeepSeek on Chat Completions. */
async function openrouter(t: Parameters<typeof runtime>[0], ember: () => { status?: number; message?: string; text?: string }, flash: (body: any) => object) {
  const requests: { model: string; path: string; body: any }[] = [];
  let generations = 0;
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ model: body.model, path: req.url!, body });
    if (body.model === EMBER) {
      const answer = ember();
      if (answer.status) { res.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: answer.message ?? "Provider down", code: answer.status } })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer.text ?? "From Ember." }] }]).events) res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const { usage, ...delta } = flash(body) as any, generation = `gen-${++generations}`;
    for (const [content, finish_reason] of [[delta, null], [{}, (delta as any).tool_calls ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: generation, object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }], ...(finish_reason && usage ? { usage } : {}) })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { url, requests };
}

test("an agent naming no model stores the alias; Ember's outage moves that call to 1017, with history, routing and records on the model that ran", async t => {
  let down = true;
  const provider = await openrouter(t, () => down ? { status: 503 } : { text: "Ember again." }, body =>
    toolResults(body).length ? { role: "assistant", content: "Tool done, from 1017." } : body.messages.some((message: any) => /run the tool/.test(JSON.stringify(message.content))) ? toolCall("codemode", { code: "return 2 + 2" }) : { role: "assistant", content: "From 1017." });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  assert.equal((await r.call("/v1/me")).json.defaultModel, ALIAS);

  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", thinkingLevel: "low" } })).json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, ALIAS);

  const first = await r.prompt(agent, "Hello");
  assert.equal(first.outcome.result.reply, "From 1017.");
  assert.deepEqual(provider.requests.map(request => request.model), [EMBER, FLASH], "that one call moved, once");
  const reached = provider.requests[1];
  assert.deepEqual(reached.body.provider, { ignore: ["inference-net", "wafer", "relace", "coreweave"] }, "1017's own routing, reached through the alias");
  assert.equal(reached.body.reasoning?.effort, "low", "the agent's reasoning goes with it");
  assert.ok(Array.isArray(reached.body.messages), "1017's Chat Completions, Ember's Responses before it");
  assert.match(provider.requests[0].path, /responses/);
  assert.equal(first.outcome.result.servedModel ?? first.outcome.servedModel, `openrouter/${FLASH}`);
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, ALIAS, "the agent keeps the name");

  const fallbackLine = () => r.logs.map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(line => line.type === "model_fallback" && line.Reason === "unavailable");
  for (const started = Date.now(); !fallbackLine() && Date.now() - started < 5_000; await new Promise(resolve => setTimeout(resolve, 50)));
  const fallback = fallbackLine();
  assert.deepEqual([fallback?.From, fallback?.To, fallback?.ModelFallbacks, fallback?.errorClass, fallback?.tenant], [`openrouter/${EMBER}`, `openrouter/${FLASH}`, 1, "provider_5xx", "alice"]);
  const usage = (await r.call("/v1/usage")).json;
  const models = JSON.stringify(usage);
  assert.ok(models.includes(FLASH), "usage names the model that ran");
  assert.ok(!models.includes(ALIAS), "never the alias");

  // Within a turn it stays where it moved: the tool's result goes back to 1017, not through Ember again.
  provider.requests.length = 0;
  const tool = await r.prompt(agent, "Please run the tool");
  assert.equal(tool.outcome.result.reply, "Tool done, from 1017.");
  assert.deepEqual(provider.requests.map(request => request.model), [EMBER, FLASH, FLASH]);
  assert.ok(JSON.stringify(provider.requests.at(-1)!.body.messages).includes("From 1017."), "the earlier answers carry over");

  // Recovered: the next message is Ember's, over a history 1017 wrote.
  down = false;
  provider.requests.length = 0;
  const back = await r.prompt(agent, "Hi again");
  assert.equal(back.outcome.result.reply, "Ember again.");
  assert.deepEqual(provider.requests.map(request => request.model), [EMBER]);
  assert.ok(JSON.stringify(provider.requests[0].body.input).includes("Tool done, from 1017."), "history survives the move back");
});

test("a request the model would refuse anywhere does not move; a real model never moves", async t => {
  let answer: { status: number; message?: string } = { status: 400, message: "Invalid request: bad tool schema" };
  const provider = await openrouter(t, () => answer, () => ({ role: "assistant", content: "From 1017." }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted" } })).json.id;
  const refused = await r.prompt(agent, "Hello");
  assert.deepEqual(provider.requests.map(request => request.model), [EMBER], "a bad request stays, and fails");
  assert.ok(JSON.stringify(refused.outcome).includes("bad tool schema"));

  // Named outright, the real model has no chain: an outage is Pi's to retry on it (asked, not waited out here).
  answer = { status: 503 };
  provider.requests.length = 0;
  const real = (await r.call("/v1/agents", { body: { keyScope: "hosted", model: `openrouter/${EMBER}` } })).json.id;
  assert.equal((await r.call(`/v1/agents/${real}`)).json.model, `openrouter/${EMBER}`);
  await r.call(`/v1/agents/${real}/prompt`, { body: { text: "Hello" } });
  for (const started = Date.now(); !provider.requests.length && Date.now() - started < 10_000; await new Promise(resolve => setTimeout(resolve, 50)));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(provider.requests.length && provider.requests.every(request => request.model === EMBER), "no failover for a model named outright");
});

test("a tenant with no OpenRouter key falls to what it holds; an upsert keeps the alias, and naming a model leaves it", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    byok: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { anthropic: "fixture-model-key" } },
  } });
  assert.equal((await r.call("/v1/me", { token: OTHER_OPERATOR })).json.defaultModel, "anthropic/claude-sonnet-5-5");
  const available = (await r.call("/v1/models?available=true", { token: OTHER_OPERATOR })).json;
  assert.ok(!available.some((model: any) => model.id === ALIAS), "not on an Anthropic key alone");
  assert.ok((await r.call("/v1/models?available=true")).json.some((model: any) => model.id === ALIAS));
  const made = (await r.call("/v1/agents", { body: { name: "one" }, headers: { "Idempotency-Key": "keep" } })).json;
  assert.equal((await r.call(`/v1/agents/${made.id}`)).json.model, ALIAS);
  const applied = async (request: string) => { for (const started = Date.now(); (await r.call(`/v1/agents/${made.id}/requests/${request}`)).json.state !== "completed"; await new Promise(resolve => setTimeout(resolve, 50))) assert.ok(Date.now() - started < 10_000); };
  await applied((await r.call("/v1/agents", { body: { name: "two" }, headers: { "Idempotency-Key": "keep" } })).json.reconfigured.id);
  assert.equal((await r.call(`/v1/agents/${made.id}`)).json.model, ALIAS);
  await applied((await r.call("/v1/agents", { body: { name: "two", model: `openrouter/${FLASH}` }, headers: { "Idempotency-Key": "keep" } })).json.reconfigured.id);
  assert.equal((await r.call(`/v1/agents/${made.id}`)).json.model, `openrouter/${FLASH}`);
  await applied((await r.call("/v1/agents", { body: { name: "two", model: ALIAS }, headers: { "Idempotency-Key": "keep" } })).json.reconfigured.id);
  assert.equal((await r.call(`/v1/agents/${made.id}`)).json.model, ALIAS, "and back by name");
});

const USD = 1_000_000;

test("over the API: Ember's failed attempt releases its end user's hold and costs nothing; only the model that answered is charged", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  const provider = await openrouter(t, () => ({ status: 503 }), () => ({ role: "assistant", content: "From 1017.", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }));
  const holds = async () => Number((await r.db.query("select count(*) n from end_user_holds")).rows[0].n);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true } });
  await r.call("/v1/end-users/person/entries", { body: { kind: "grant", amount: 5 * USD, key: "pay" } });
  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", subject: "person", bucket: "b" } })).json.id;
  const done = await r.prompt(agent, "Hello");
  assert.equal(done.outcome.result.reply, "From 1017.");
  assert.equal(await holds(), 0, "no hold outlives the turn");
  const rows = (await r.db.query("select model, end_user_raw, end_user_paid from model_attempts order by started_at")).rows;
  assert.deepEqual(rows.map(row => [row.model, Number(row.end_user_raw)]), [[EMBER, 0], [FLASH, 10_000]], "an attempt for each, and only the one that answered costs anything");
  const ledger = (await r.db.query("select coalesce(sum(amount), 0)::bigint as total from end_user_ledger where end_user = 'person' and kind <> 'grant'")).rows[0].total;
  assert.equal(Number(ledger), -10_000, "the end user pays once");
  const usage = JSON.stringify((await r.call("/v1/usage")).json);
  assert.ok(usage.includes(FLASH) && !usage.includes(EMBER), "usage names the model that answered");
  const superseded = (await r.db.query("select context->>'superseded' as why from model_attempts where model = $1", [EMBER])).rows[0].why;
  assert.equal(superseded, "unavailable", "the host says so, so a later reconcile counts no response for it");
});

test("the books for a move: a failed attempt's hold goes as it ends, the next holds at its own price, and reconciling the failure never charges it", async () => {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: "a".repeat(64), billing: "prepaid" } }, platformKeys: { openrouter: "fixture" } }) });
  await tenants.reload();
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', $1, $1)", [100 * USD]);
  const service = new EndUserCredits(db);
  await service.setSettings("payg", { enabled: true });
  await service.post("payg", "person", { kind: "grant", amount: USD, key: "pay" });
  const attempts = new ModelAttempts(db, new Accounts({ tenants, db }), undefined, 0, undefined, service);
  const keyHash = createHash("sha256").update("fixture").digest("hex");
  const begin = (id: string, model: string) => attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model, kind: "response", at: Date.now(), keyHash,
    estimate: { inputTokens: 100_000, maxOutputTokens: 2_048, rates: { input: 0, output: 0 } }, endUser: { id: "person", bucket: "b" } } as never);
  const held = async () => Number((await db.query("select coalesce(sum(paid + allowance), 0)::bigint as n from end_user_holds")).rows[0].n);
  const balance = async () => Number((await db.query("select balance from credit_accounts where tenant = 'payg'")).rows[0].balance);

  const failed = randomUUID(), answered = randomUUID();
  await begin(failed, EMBER);
  const atEmber = await held();
  assert.ok(atEmber > 0);
  await attempts.event("payg", "agent", true, true, { type: "finish", id: failed, usage: { input: 0, output: 0 }, chars: 0, completed: false, superseded: "unavailable" });
  assert.equal(await held(), 0, "the failed attempt's hold is gone");
  assert.equal(await balance(), 100 * USD, "and nothing is charged");

  await begin(answered, FLASH);
  assert.ok(await held() > atEmber, "1017 holds at its own, dearer price");
  await attempts.event("payg", "agent", true, true, { type: "finish", id: answered, usage: { input: 100, output: 10, providerCost: 0.01, providerCreditCost: 0 }, chars: 40, completed: true });
  assert.equal(await held(), 0);
  const charged = 100 * USD - await balance();
  assert.ok(charged > 0, "the tenant pays for the answer");

  await db.query("update model_attempts set updated_at = 0, next_check_at = 0 where id = $1", [failed]);
  await attempts.reconcile();
  assert.equal(100 * USD - await balance(), charged, "reconciling the failed attempt charges nothing");
  const rows = (await db.query("select model, charge, end_user_raw from model_attempts order by started_at, model")).rows;
  const of = (model: string) => rows.find(row => row.model === model)!;
  assert.deepEqual([Number(of(EMBER).charge), Number(of(EMBER).end_user_raw)], [0, 0]);
  assert.ok(Number(of(FLASH).charge) > 0 && Number(of(FLASH).end_user_raw) > 0);
  assert.deepEqual((await db.query("select model from usage where tenant = 'payg'")).rows.map(row => row.model).filter(model => model.includes("ember")), []);
});

test("a member the catalog lacks passes through, as any OpenRouter model does; only other providers' must be in the catalog", () => {
  const member = virtualMember(["openrouter", "new/released-today"]) as any;
  assert.deepEqual([member.id, member.provider, member.api, member.passthrough, member.contextWindow], ["new/released-today", "openrouter", "openai-responses", true, 128_000]);
  assert.equal((virtualMember(["openrouter", EMBER]) as any).passthrough, undefined);
  assert.throws(() => virtualMember(["anthropic", "no-such-model"]), /not in the catalog/);
  // An agent's head as stored, its lookup's values kept: a real chain head is the catalog's now, whatever the agent stored.
  const looked = { ...passthroughModel(EMBER), passthrough: undefined, contextWindow: 400_000, virtual: ALIAS };
  assert.equal(currentModel(looked).contextWindow, 1_048_576);
  assert.equal(currentModel({ ...resolveModel(ALIAS), id: "gone/old" }).id, EMBER);
});

test("strong: Gemini's reasoning from flex is refused on the default tier's other provider; the call is made again without it", async t => {
  // Turn 1 calls a tool on flex, with encrypted reasoning. Its continuation finds flex down, moves to the default tier,
  // and that provider refuses reasoning another provider produced (probed 2026-11-12): made again without it, answered.
  const requests: { tier?: string; details: boolean }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    // Carbon is called on Responses: its encrypted reasoning goes back as a reasoning item.
    const details = body.input.some((item: any) => item.type === "reasoning" && item.encrypted_content);
    const results = body.input.some((item: any) => item.type === "function_call_output");
    requests.push({ tier: body.service_tier, details });
    const fail = (status: number, message: string) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message, code: status } }));
    if (results && body.service_tier === "flex") return fail(503, "No flex capacity");
    if (results && details) return fail(400, "Provider returned error: Gemini models require OpenRouter reasoning details to be preserved in each request.");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const items = results ? [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Read it: package main.", annotations: [] }] }]
      : [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "SIGNED-BY-AI-STUDIO" },
        { type: "function_call", id: "fc_1", call_id: "call_read", name: "codemode", arguments: JSON.stringify({ code: "return 'package main'" }), status: "completed" }];
    for (const event of responses(items).events) res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: url } });
  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", model: "camelrun/strong", thinkingLevel: "low" } })).json.id;
  const run = await r.prompt(agent, "Read the file");
  assert.equal(run.outcome.result.reply, "Read it: package main.", JSON.stringify(run.outcome));
  // Turn 1 on flex, signed; the continuation on flex (down); the default tier refusing the other provider's reasoning; made again without it.
  assert.deepEqual(requests.map(request => request.details), [false, true, true, false], JSON.stringify(requests));
  assert.deepEqual(requests.map(request => request.tier === "flex"), [true, true, false, false], JSON.stringify(requests));
  assert.ok(r.logs.some(line => line.includes('"model_reasoning_replay_dropped"')), "logged");

  // Later calls drop it up front: the history keeps the signature, and asking with it first would be refused every call.
  requests.length = 0;
  const again = await r.prompt(agent, "Read it again");
  assert.equal(again.outcome.result.reply, "Read it: package main.", JSON.stringify(again.outcome));
  assert.deepEqual(requests.map(request => request.details), requests.map(() => false), JSON.stringify(requests));
  assert.equal(r.logs.filter(line => line.includes('"model_reasoning_replay_dropped"')).length, 1, "no second refusal");
});

test("strong's members wait for a first token within a budget for their input; other classes and an agent's own limit are unchanged", async () => {
  const { streamTimeouts } = await import("../src/model-stream.ts");
  const [flex, standard] = virtualChain("camelrun/strong")!;
  for (const member of [flex, standard]) assert.deepEqual((member as { firstTokenBudget?: unknown }).firstTokenBudget, { baseMs: 30_000, perKTokensMs: 400 });
  for (const reference of ["camelrun/fast", "camelrun/default"]) assert.ok(virtualChain(reference)!.every(member => !("firstTokenBudget" in member)), reference);
  assert.equal(streamTimeouts(flex, undefined, undefined, undefined, 12_000).firstTokenMs, 34_800);
  assert.equal(streamTimeouts(flex, undefined, undefined, undefined, 150_000).firstTokenMs, 90_000);
  assert.equal(streamTimeouts(flex, undefined, undefined, undefined, 1_000_000).firstTokenMs, 120_000);
  assert.equal(streamTimeouts(flex, undefined, { firstTokenSeconds: 200 }, undefined, 12_000).firstTokenMs, 200_000);
});

test("strong: flex that sends no first token in time is given up on, and the default tier answers the same call", async t => {
  const requests: (string | undefined)[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body.service_tier);
    // Flex hangs: headers and nothing more, as a stalled upstream does.
    if (body.service_tier === "flex") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of responses([{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "From the default tier.", annotations: [] }] }]).events)
      res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: url } });
  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", model: "camelrun/strong", thinkingLevel: "low", runLimits: { firstTokenSeconds: 1 } } })).json.id;
  const run = await r.prompt(agent, "Say hello");
  assert.equal(run.outcome.result.reply, "From the default tier.", JSON.stringify(run.outcome));
  assert.deepEqual(requests, ["flex", "default"]);
});
