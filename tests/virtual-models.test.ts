import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { listModels } from "../src/catalog.ts";
import { configuredModel, defaultModels } from "../src/model.ts";
import { isModelUnavailable } from "../src/model-errors.ts";
import { withModelFallback } from "../src/model-fallback.ts";
import { resolveModel } from "../src/session-config.ts";
import { currentModel, modelReference, routeModel, virtualChain } from "../src/virtual-models.ts";
import { responses } from "./provider-fixtures.ts";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, toolCall, toolResults } from "./runtime-server.ts";

const ALIAS = "camelrun/default", PARTICLE = "particle-ai/particle-1", FLASH = "deepseek/deepseek-v4.1-flash-1017";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const ALIASED = { ...LOCAL, AGENT_PROVIDER: "camelrun", AGENT_MODEL: "default", AGENT_HOSTING: "inline" };

test("camelrun/default is a chain, its head as an agent holds it, and the runtime's default with nothing set", () => {
  assert.deepEqual(virtualChain(ALIAS)!.map(model => `${model.provider}/${model.id}`), [`openrouter/${PARTICLE}`, `openrouter/${FLASH}`]);
  const selection = resolveModel(ALIAS);
  assert.deepEqual([selection.provider, selection.id, modelReference(selection)], ["openrouter", PARTICLE, ALIAS]);
  assert.equal(modelReference(configuredModel({})), ALIAS);
  assert.equal(modelReference(configuredModel(ALIASED)), ALIAS);
  assert.equal(modelReference(configuredModel({ AGENT_PROVIDER: "openrouter", AGENT_MODEL: FLASH })), `openrouter/${FLASH}`, "prod's env today: no move until it changes");
  assert.equal(modelReference(resolveModel(`openrouter/${PARTICLE}`)), `openrouter/${PARTICLE}`, "a real model is itself");
  assert.throws(() => resolveModel("camelrun/nothing"), /Unknown model/);
  // An agent stored earlier takes what the name stands for now.
  assert.equal(currentModel({ ...resolveModel(ALIAS), id: "something/old" }).id, PARTICLE);
  const real = resolveModel(`openrouter/${FLASH}`);
  assert.equal(currentModel(real), real);
  // Those with no OpenRouter key go on down the list as before.
  assert.deepEqual(defaultModels(configuredModel({}), undefined).map(modelReference), [ALIAS, "azure/deepseek-v4.1-flash", "anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "amazon-bedrock/global.anthropic.claude-sonnet-5-5"]);
  const listed = listModels().find(model => model.id === ALIAS)!;
  assert.deepEqual(listed.routes, [`openrouter/${PARTICLE}`, `openrouter/${FLASH}`]);
  assert.deepEqual([listed.provider, listed.modelId, listed.contextWindow], ["camelrun", "default", 1_048_576]);
  assert.ok(listModels("camelrun").length === 1 && !listModels("openrouter").some(model => model.id === ALIAS));
});

test("route: a message starts at the head, a continuation stays on previous, a retry moves past failed and ends", () => {
  const selection = resolveModel(ALIAS);
  const id = (reason: Parameters<typeof routeModel>[1]) => routeModel(selection, reason)?.id;
  assert.equal(id({ reason: "user" }), PARTICLE);
  assert.equal(id({ reason: "user", previous: { provider: "openrouter", model: FLASH } }), PARTICLE, "a recovered head takes the next message");
  assert.equal(id({ reason: "direct" }), PARTICLE);
  assert.equal(id({ reason: "continuation", previous: { provider: "openrouter", model: FLASH } }), FLASH);
  assert.equal(id({ reason: "continuation", previous: { provider: "anthropic", model: "claude-sonnet-5-5" } }), PARTICLE, "history from a model outside the chain");
  assert.equal(id({ reason: "retry", failed: { provider: "openrouter", id: PARTICLE } }), FLASH);
  assert.equal(id({ reason: "retry", failed: { provider: "openrouter", id: FLASH } }), undefined);
  const real = resolveModel(`openrouter/${FLASH}`);
  assert.equal(routeModel(real, { reason: "user" }), real);
  assert.equal(routeModel(real, { reason: "retry", failed: { provider: "openrouter", id: FLASH } }), undefined);
});

test("unavailable means the model or provider can't take it now, never what it would refuse anywhere", () => {
  for (const errorMessage of ["503 Service Unavailable", "502 Provider returned error", "500 internal server error", "429 Rate limit exceeded", "404 No endpoints found for particle-ai/particle-1", "404 No allowed providers are available", "Connection error: fetch failed", "Request timed out", "Model stream stalled: openrouter/x sent nothing within 60s of the request (timed out before its first token)"]) {
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

/** One OpenRouter: Particle on its Responses API as told, DeepSeek on Chat Completions. */
async function openrouter(t: Parameters<typeof runtime>[0], particle: () => { status?: number; message?: string; text?: string }, flash: (body: any) => object) {
  const requests: { model: string; path: string; body: any }[] = [];
  let generations = 0;
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ model: body.model, path: req.url!, body });
    if (body.model === PARTICLE) {
      const answer = particle();
      if (answer.status) { res.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: answer.message ?? "Provider down", code: answer.status } })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer.text ?? "From Particle." }] }]).events) res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = flash(body), generation = `gen-${++generations}`;
    for (const [content, finish_reason] of [[delta, null], [{}, (delta as any).tool_calls ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: generation, object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { url, requests };
}

test("an agent naming no model stores the alias; Particle's outage moves that call to 1017, with history, routing and records on the model that ran", async t => {
  let down = true;
  const provider = await openrouter(t, () => down ? { status: 503 } : { text: "Particle again." }, body =>
    toolResults(body).length ? { role: "assistant", content: "Tool done, from 1017." } : body.messages.some((message: any) => /run the tool/.test(JSON.stringify(message.content))) ? toolCall("js_exec", { code: "return 2 + 2" }) : { role: "assistant", content: "From 1017." });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  assert.equal((await r.call("/v1/me")).json.defaultModel, ALIAS);

  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", thinkingLevel: "low" } })).json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, ALIAS);

  const first = await r.prompt(agent, "Hello");
  assert.equal(first.outcome.result.reply, "From 1017.");
  assert.deepEqual(provider.requests.map(request => request.model), [PARTICLE, FLASH], "that one call moved, once");
  const reached = provider.requests[1];
  assert.deepEqual(reached.body.provider, { ignore: ["inference-net", "wafer"] }, "1017's own routing, reached through the alias");
  assert.equal(reached.body.reasoning?.effort, "low", "the agent's reasoning goes with it");
  assert.ok(Array.isArray(reached.body.messages), "1017's Chat Completions, Particle's Responses before it");
  assert.match(provider.requests[0].path, /responses/);
  assert.equal(first.outcome.result.servedModel ?? first.outcome.servedModel, `openrouter/${FLASH}`);
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, ALIAS, "the agent keeps the name");

  const fallbackLine = () => r.logs.map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(line => line.type === "model_fallback" && line.Reason === "unavailable");
  for (const started = Date.now(); !fallbackLine() && Date.now() - started < 5_000; await new Promise(resolve => setTimeout(resolve, 50)));
  const fallback = fallbackLine();
  assert.deepEqual([fallback?.From, fallback?.To, fallback?.ModelFallbacks, fallback?.errorClass, fallback?.tenant], [`openrouter/${PARTICLE}`, `openrouter/${FLASH}`, 1, "provider_5xx", "alice"]);
  const usage = (await r.call("/v1/usage")).json;
  const models = JSON.stringify(usage);
  assert.ok(models.includes(FLASH), "usage names the model that ran");
  assert.ok(!models.includes(ALIAS), "never the alias");

  // Within a turn it stays where it moved: the tool's result goes back to 1017, not through Particle again.
  provider.requests.length = 0;
  const tool = await r.prompt(agent, "Please run the tool");
  assert.equal(tool.outcome.result.reply, "Tool done, from 1017.");
  assert.deepEqual(provider.requests.map(request => request.model), [PARTICLE, FLASH, FLASH]);
  assert.ok(JSON.stringify(provider.requests.at(-1)!.body.messages).includes("From 1017."), "the earlier answers carry over");

  // Recovered: the next message is Particle's, over a history 1017 wrote.
  down = false;
  provider.requests.length = 0;
  const back = await r.prompt(agent, "Hi again");
  assert.equal(back.outcome.result.reply, "Particle again.");
  assert.deepEqual(provider.requests.map(request => request.model), [PARTICLE]);
  assert.ok(JSON.stringify(provider.requests[0].body.input).includes("Tool done, from 1017."), "history survives the move back");
});

test("a request the model would refuse anywhere does not move; a real model never moves", async t => {
  let answer: { status: number; message?: string } = { status: 400, message: "Invalid request: bad tool schema" };
  const provider = await openrouter(t, () => answer, () => ({ role: "assistant", content: "From 1017." }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted" } })).json.id;
  const refused = await r.prompt(agent, "Hello");
  assert.deepEqual(provider.requests.map(request => request.model), [PARTICLE], "a bad request stays, and fails");
  assert.ok(JSON.stringify(refused.outcome).includes("bad tool schema"));

  // Named outright, the real model has no chain: an outage is Pi's to retry on it (asked, not waited out here).
  answer = { status: 503 };
  provider.requests.length = 0;
  const real = (await r.call("/v1/agents", { body: { keyScope: "hosted", model: `openrouter/${PARTICLE}` } })).json.id;
  assert.equal((await r.call(`/v1/agents/${real}`)).json.model, `openrouter/${PARTICLE}`);
  await r.call(`/v1/agents/${real}/prompt`, { body: { text: "Hello" } });
  for (const started = Date.now(); !provider.requests.length && Date.now() - started < 10_000; await new Promise(resolve => setTimeout(resolve, 50)));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(provider.requests.length && provider.requests.every(request => request.model === PARTICLE), "no failover for a model named outright");
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
