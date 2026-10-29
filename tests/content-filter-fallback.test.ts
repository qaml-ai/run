import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contentFilterFallbacks } from "../src/model.ts";
import { isContentFilterBlock } from "../src/model-errors.ts";
import { withContentFilterFallback } from "../src/content-filter-fallback.ts";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { recordModelFallback, setMetricSink } from "../src/metrics.ts";
import { micros } from "../src/pricing.ts";
import { lastUser, listen, runtime, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OPS = "ops-operator-token-at-least-24-chars";
const BARE = "bare-operator-token-at-least-24-chars";
const PAYG = "payg-operator-token-at-least-24-chars";
const KEY = "azure-test-key-0123456789";
/** What Azure answered on 2026-10-29 when Prompt Shields blocked DeepSeek's response: a 400 whose body is the stream's last chunk. */
const BLOCKED = { object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "content_filter", index: 0,
  content_filter_results: { error: { code: "content_filter", message: "Response content blocked by label 'Jailbreak'." } } }] };
const chunk = (delta: object, finish_reason: string | null = null) => ({ id: "chatcmpl_flash", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
const usage = { id: "chatcmpl_flash", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100_000, completion_tokens: 1_000 } };
/** What Azure's usage above costs at Flash's catalog price. */
const AZURE_COST = (100_000 * 0.3 + 1_000 * 1.2) / 1e6;

/** Azure's Chat Completions for the deployment: by the prompt's text, a block (as a 400, or mid-stream), another error, or an answer. */
async function fakeAzure(t: T) {
  const requests: any[] = [];
  const base = await listen(t, async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push(body);
    const said = lastUser(body);
    if (said.startsWith("blocked-400")) return void res.writeHead(400, { "Content-Type": "text/event-stream" }).end(`data: ${JSON.stringify(BLOCKED)}\n\n`);
    if (said.startsWith("missing")) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = said.startsWith("blocked-stream")
      // Part of an answer, then the filter's stop.
      ? [chunk({ role: "assistant", content: "Here is part" }), { ...chunk({}, "content_filter"), choices: [{ ...BLOCKED.choices[0] }] }, usage]
      : [chunk({ role: "assistant", content: "from azure" }), chunk({}, "stop"), usage];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { base, requests };
}

async function start(t: T) {
  const azure = await fakeAzure(t);
  // OpenRouter, as the hosted key scope reaches it: refuses a prompt that asks it to, answers the rest.
  const r = await runtime(t, body => lastUser(body).includes("refused-too")
    ? { httpStatus: 400, message: "Request blocked: finish_reason content_filter" }
    : { role: "assistant", content: "from openrouter", usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0",
    AGENT_AZURE_OPENAI_ENDPOINT: azure.base, AGENT_AZURE_OPENAI_API_KEY: KEY, AGENT_AZURE_OPENAI_MODELS: "deepseek-v4.1-flash=DeepSeek-V4.1-Flash",
    AGENT_AZURE_IMAGE_DEPLOYMENT: "", AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT: "",
  }, { tenants: {
    // An unbilled operator's tenant on the platform's Azure, as chiridion's is, and one with no OpenRouter key anywhere.
    ops: { tokenSha256: sha(OPS), apiKeys: {} },
    bare: { tokenSha256: sha(BARE), apiKeys: {} },
    // A prepaid account, which pays for the platform's Azure calls from its credit.
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
  } });
  assert.equal((await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: r.model.url }, token: OPS })).status, 200);
  const made = await r.call("/v1/agents", { body: { model: "azure/deepseek-v4.1-flash", keyScope: "hosted" }, token: OPS });
  assert.equal(made.status, 201, made.text);
  return { r, azure, agent: made.json.id as string };
}

test("a response Azure's content filter blocks is asked once more on OpenRouter's DeepSeek, leaving only the answer in history", { timeout: 120_000 }, async t => {
  const { r, azure, agent } = await start(t);

  // Blocked as a 400: OpenRouter's DeepSeek answers instead, on the hosted scope's key.
  const done = await r.prompt(agent, "blocked-400: fix my build", OPS);
  assert.equal(done.error, undefined, JSON.stringify(done));
  assert.equal(done.outcome.result.reply, "from openrouter");
  assert.equal(done.outcome.result.servedModel, "openrouter/deepseek/deepseek-v4.1-flash-1017:nitro");
  assert.equal(azure.requests.length, 1);
  assert.equal(r.model.bodies.length, 1);
  assert.equal(r.model.bodies[0].model, "deepseek/deepseek-v4.1-flash-1017:nitro");
  assert.equal(r.model.keys[0], "Bearer sk-or");
  let history = (await r.call(`/v1/agents/${agent}/history`, { token: OPS })).json.messages;
  assert.deepEqual(history.map((message: any) => [message.role, message.provider, message.stopReason]), [["user", undefined, undefined], ["assistant", "openrouter", "stop"]], "the blocked attempt left no entry");
  // Its usage is OpenRouter's, on the scope's key: not the platform's.
  const usage = await until(async () => {
    const lines = r.logs.filter(line => line.includes('"type":"model_cost"') && line.includes('"Provider":"openrouter"')).map(line => JSON.parse(line));
    return lines.length && lines;
  }, "the fallback's usage");
  assert.equal(usage[0].Model, "deepseek/deepseek-v4.1-flash-1017:nitro");

  // The next request is Azure's again.
  assert.equal((await r.prompt(agent, "hello", OPS)).outcome.result.reply, "from azure");
  assert.equal(azure.requests.length, 2);
  assert.equal(r.model.bodies.length, 1);

  // Blocked after part of an answer streamed: the whole response is asked again, and only the fallback's stays.
  const streamed = await r.prompt(agent, "blocked-stream: and the tests", OPS);
  assert.equal(streamed.outcome.result.reply, "from openrouter", JSON.stringify(streamed));
  assert.equal(r.model.bodies.length, 2);
  history = (await r.call(`/v1/agents/${agent}/history`, { token: OPS })).json.messages;
  assert.ok(!JSON.stringify(history).includes("Here is part"), "the blocked partial is not history");
  assert.ok(!history.some((message: any) => message.stopReason === "error"));

  // Once per request: a fallback that fails too ends the run with its own error, without going back to Azure.
  const twice = await r.prompt(agent, "blocked-400 refused-too", OPS);
  assert.match(String(twice.error), /Request blocked/);
  assert.equal(r.model.bodies.length, 3);
  assert.equal(azure.requests.length, 4);

  // Another failure is not a content filter's: it ends the run without OpenRouter.
  const missing = await r.prompt(agent, "missing", OPS);
  assert.match(String(missing.error), /DeploymentNotFound/);
  assert.equal(r.model.bodies.length, 3);
});

test("an agent with no key for the fallback's provider ends as the content filter ended it", { timeout: 120_000 }, async t => {
  const { r, azure } = await start(t);
  const made = await r.call("/v1/agents", { body: { model: "azure/deepseek-v4.1-flash" }, token: BARE });
  assert.equal(made.status, 201, made.text);
  const blocked = await r.prompt(made.json.id, "blocked-400", BARE);
  assert.match(String(blocked.error), /content_filter/);
  assert.equal(blocked.outcome.result.modelError?.errorClass, "refusal");
  assert.equal(azure.requests.length, 1);
  assert.equal(r.model.bodies.length, 0);
});

test("both attempts are billed as their own: the blocked Azure call from the platform's credit, the fallback on the scope's key", { timeout: 120_000 }, async t => {
  const { r } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(10), reason: "test" }, token: OPS })).status, 201);
  assert.equal((await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: r.model.url }, token: PAYG })).status, 200);
  const agent = (await r.call("/v1/agents", { body: { model: "azure/deepseek-v4.1-flash", keyScope: "hosted" }, token: PAYG })).json.id;
  const done = await r.prompt(agent, "blocked-stream: go on", PAYG);
  assert.equal(done.outcome.result.reply, "from openrouter", JSON.stringify(done));
  const usage = await until(async () => { const usage = (await r.call("/v1/usage", { token: PAYG })).json; return usage.totals.responses >= 2 && usage; }, "both attempts' usage");
  // The blocked call, with what Azure reported it took, on the platform's key at Flash's catalog price; the fallback on the scope's key.
  const days = usage.days.map((day: any) => [day.model, day.input, day.output, day.platformResponses]);
  assert.deepEqual(days.sort(), [["azure/deepseek-v4.1-flash", 100_000, 1_000, 1], ["openrouter/deepseek/deepseek-v4.1-flash-1017:nitro", 10, 2, 0]]);
  assert.equal((await r.call("/v1/billing", { token: PAYG })).json.balance, micros(10) - micros(AZURE_COST), "only the platform's Azure call is charged to credit");
});

test("a content filter's block is told from the model's own refusal and from other errors", () => {
  assert.ok(isContentFilterBlock({ errorMessage: `400 data: ${JSON.stringify(BLOCKED)}` }));
  assert.ok(isContentFilterBlock({ errorMessage: "Provider finish_reason: content_filter" }));
  assert.ok(isContentFilterBlock({ errorMessage: "400 The response was filtered", rawStopReason: "content_filter" }));
  assert.ok(isContentFilterBlock({ errorMessage: '400 {"error":{"code":"content_filter","innererror":{"code":"ResponsibleAIPolicyViolation"}}}' }));
  assert.ok(!isContentFilterBlock({ errorMessage: "The model refused to answer" }));
  assert.ok(!isContentFilterBlock({ errorMessage: "429 Rate limit reached" }));
  assert.ok(!isContentFilterBlock({ errorMessage: undefined }));
});

test("AGENT_CONTENT_FILTER_FALLBACKS: from=to pairs of catalog models on different providers; empty for none", () => {
  const defaults = contentFilterFallbacks(undefined);
  assert.deepEqual([...defaults].map(([from, to]) => [from, `${to.provider}/${to.id}`]), [["azure/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4.1-flash-1017:nitro"]]);
  assert.equal(contentFilterFallbacks("").size, 0);
  assert.throws(() => contentFilterFallbacks("azure/deepseek-v4.1-flash"), /is not from=to/);
  assert.throws(() => contentFilterFallbacks("azure/deepseek-v4.1-flash=azure/deepseek-v4-pro"), /stays on azure/);
  assert.throws(() => contentFilterFallbacks("azure/deepseek-v4.1-flash=openrouter/nope/never"), /Unknown model/);
});

test("a fallback is counted as model_fallback, by its models and reason, with its tenant and agent", t => {
  const lines: string[] = [];
  setMetricSink(line => lines.push(line));
  t.after(() => setMetricSink());
  recordModelFallback({ tenant: "ops", agent: "a1", from: "azure/deepseek-v4.1-flash", to: "openrouter/deepseek/deepseek-v4.1-flash-1017:nitro", reason: "content_filter" });
  const line = JSON.parse(lines[0]);
  assert.deepEqual([line.type, line.From, line.To, line.Reason, line.ModelFallbacks, line.tenant, line.agent],
    ["model_fallback", "azure/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4.1-flash-1017:nitro", "content_filter", 1, "ops", "a1"]);
  assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [["Reason"], ["From", "To", "Reason"]]);
});

/** A pi-ai stream of `text` from `provider`, ending as `ending` says: a stop, or an error with that text. */
function scripted(provider: string, text: string, ending: { error?: string } = {}) {
  const message = (content: string, extra: Partial<AssistantMessage> = {}) => ({ role: "assistant", content: content ? [{ type: "text", text: content }] : [], api: "openai-completions", provider, model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0, ...extra }) as AssistantMessage;
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message("") });
  if (text) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message(text) });
  const end = message(text, ending.error ? { stopReason: "error", errorMessage: ending.error } : {});
  stream.push(ending.error ? { type: "error", reason: "error", error: end } : { type: "done", reason: "stop", message: end });
  stream.end();
  return stream;
}
async function drain(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
  const events: string[] = [];
  for await (const event of stream) events.push(`${event.type}${event.type === "text_delta" ? `:${event.delta}` : ""}`);
  return { events, result: await stream.result() };
}

test("withContentFilterFallback: a block, even after part of an answer, is answered by the fallback's stream; anything else passes as it was", async () => {
  const calls: string[] = [];
  const hooks = { blocked: () => calls.push("blocked"), unavailable: () => calls.push("unavailable"), aborted: () => false };
  const fallback = () => { calls.push("fallback"); return scripted("openrouter", "instead"); };

  const swapped = await drain(await withContentFilterFallback(scripted("azure", "Here is part", { error: "Provider finish_reason: content_filter" }), fallback, hooks));
  assert.deepEqual(swapped.events, ["start", "text_delta:Here is part", "start", "text_delta:instead", "done"], "the fallback's start begins the response again");
  assert.deepEqual([swapped.result.provider, swapped.result.stopReason, swapped.result.content], ["openrouter", "stop", [{ type: "text", text: "instead" }]]);
  assert.deepEqual(calls.splice(0), ["blocked", "fallback"]);

  for (const ending of [{}, { error: "429 Rate limit reached" }, { error: "The model refused to answer" }]) {
    const passed = await drain(await withContentFilterFallback(scripted("azure", "hi", ending), fallback, hooks));
    assert.equal(passed.result.provider, "azure");
    assert.equal(passed.result.errorMessage, ending.error);
  }
  assert.deepEqual(calls, [], "no fallback for an answer or another error");

  // No credentials for the fallback: the block is the response.
  const unavailable = await drain(await withContentFilterFallback(scripted("azure", "", { error: '400 {"code":"content_filter"}' }), () => { throw new Error("No openrouter API key"); }, hooks));
  assert.deepEqual([unavailable.result.provider, unavailable.result.errorMessage], ["azure", '400 {"code":"content_filter"}']);
  assert.deepEqual(calls.splice(0), ["blocked", "unavailable"]);

  // An aborted request is not asked again.
  const aborted = await drain(await withContentFilterFallback(scripted("azure", "", { error: "Provider finish_reason: content_filter" }), fallback, { ...hooks, aborted: () => true }));
  assert.equal(aborted.result.provider, "azure");
  assert.deepEqual(calls, []);
});
