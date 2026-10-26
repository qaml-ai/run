import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { azureChatCredentials, azureOpenAIConfig } from "../src/azure-openai.ts";
import { getModel } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { micros } from "../src/pricing.ts";
import { responses } from "./provider-fixtures.ts";
import { listen, runtime, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OWN = "own-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    // An operator's tenant that keeps to its own keys: no platform models, Azure's included.
    own: { tokenSha256: sha(OWN), apiKeys: { openrouter: "fixture-model-key" }, platformKeys: false },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
  },
  platformKeys: { openrouter: "fixture-platform-model-key" },
};
const KEY = "azure-test-key-0123456789";
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

type Reply = { events: object[] } | { status: number; error: object; headers?: Record<string, string> };
/** Azure OpenAI's v1 API at /openai/v1: records each request (path, api-key, Authorization, body) and answers the next scripted reply. */
async function fakeAzure(t: T, reply: (body: any, index: number) => Reply) {
  const requests: { path: string; apiKey?: string; authorization?: string; body: any }[] = [];
  const base = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, ...(req.headers["api-key"] ? { apiKey: String(req.headers["api-key"]) } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), body });
    const next = reply(body, requests.length - 1);
    if ("status" in next) return void res.writeHead(next.status, { "Content-Type": "application/json", ...next.headers }).end(JSON.stringify({ error: next.error }));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of next.events) res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  return { base, requests };
}

async function start(t: T, reply: (body: any, index: number) => Reply, models = "gpt-6-sol=sol-eastus2,gpt-6-luna") {
  const azure = await fakeAzure(t, reply);
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0",
    AGENT_AZURE_OPENAI_ENDPOINT: azure.base, AGENT_AZURE_OPENAI_API_KEY: KEY, AGENT_AZURE_OPENAI_MODELS: models,
    // Chat only: images and transcription stay on OpenAI.
    AGENT_AZURE_IMAGE_DEPLOYMENT: "", AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT: "",
  }, tenantsFile);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(10), reason: "test" }, token: OPS })).status, 201);
  return { r, azure };
}

test("Azure chat deployments: a map of catalog model to deployment, or the environment's `id=deployment,id` text; models the catalog lacks are left out", () => {
  const config = (models: unknown) => azureOpenAIConfig({ endpoint: "https://camel.openai.azure.com", apiKey: "k", models }, "x")!;
  assert.equal(config(undefined).models, undefined, "none by default");
  assert.deepEqual(config("gpt-6-sol=sol-eastus2, gpt-6-luna").models, { "gpt-6-sol": "sol-eastus2", "gpt-6-luna": "gpt-6-luna" });
  assert.deepEqual(config({ "gpt-6.1-sol": "sol61" }).models, { "gpt-6.1-sol": "sol61" });
  assert.deepEqual(config({ "gpt-6.1-terra": "terra61" }).models, { "gpt-6.1-terra": "terra61" });
  assert.deepEqual(config("gpt-6.1-terra").models, { "gpt-6.1-terra": "gpt-6.1-terra" });
  // Not an azure model on the Responses API (a typo, an OpenAI-only model, DeepSeek on Azure's completions API): left out.
  assert.deepEqual(config("gpt-6-sol,gpt-6-sun,deepseek-v4-pro").models, { "gpt-6-sol": "gpt-6-sol" });
  assert.equal(config("gpt-6-sun").models, undefined);
  for (const bad of ["gpt-6-sol=", "gpt-6-sol=a/b", ["gpt-6-sol"], { "gpt-6-sol": 1 }]) assert.throws(() => config(bad), /x: /, JSON.stringify(bad));
  assert.deepEqual(azureChatCredentials(config("gpt-6-sol")), { apiKey: "k", baseUrl: "https://camel.openai.azure.com/openai/v1", deployments: { "gpt-6-sol": "gpt-6-sol" } });
});

test("an azure model is priced as OpenAI's of the same id, long-context tier included (Azure's Global Standard prices)", () => {
  for (const id of ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.5", "gpt-5.4"]) {
    assert.deepEqual(getModel("azure", id)!.cost, getModel("openai", id)!.cost, id);
    assert.ok(getModel("azure", id)!.cost.tiers?.length, `${id} has its long-context tier`);
  }
  assert.deepEqual(getModel("azure", "gpt-6-sol")!.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] });
  // Billed on the platform's key at those prices: gpt-5.5 (1.05M tokens on Azure) above 272k input at the long-context rates.
  const long = (platformUsage({ input: 300_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, "azure", "gpt-5.5").usage as unknown as { cost: { total: number } }).cost;
  assert.ok(Math.abs(long.total - (300_000 * 10 + 1_000 * 45) / 1e6) < 1e-12, String(long.total));
  assert.equal(getModel("azure", "deepseek-v4-pro")!.cost.input, 1.925, "a model OpenAI lacks keeps Pi's price");
});

test("a tenant on the platform's keys runs azure models the platform deploys, through the deployment, billed at the catalog's price", async t => {
  const usage = { input_tokens: 2_000, output_tokens: 300, input_tokens_details: { cached_tokens: 1_200 } };
  const { r, azure } = await start(t, (body, index) => body.tool_choice
    ? responses([{ type: "function_call", id: "fc_2", call_id: "call_out", name: body.tool_choice.name, arguments: JSON.stringify({ yes: true }), status: "completed" }], usage)
    : index === 0
    ? responses([{ type: "function_call", id: "fc_1", call_id: "call_1", name: "js_exec", arguments: JSON.stringify({ code: "return 6 * 7;" }), status: "completed" }], usage)
    : responses([message(`Azure says ${body.model}.`)], usage));

  // Listed with the catalog's facts; available only where deployed, and only to a tenant on the platform's keys.
  const listed = (await r.call("/v1/models?provider=azure", { token: PAYG })).json;
  const sol = listed.find((model: any) => model.id === "azure/gpt-6-sol");
  assert.deepEqual([sol.available, sol.api, sol.reasoning, sol.contextWindow, sol.cost.input, sol.toolCallStreaming], [true, "azure-openai-responses", true, 272_000, 2, "unknown"]);
  const terra = listed.find((model: any) => model.id === "azure/gpt-6.1-terra");
  assert.deepEqual([terra.available, terra.api, terra.contextWindow, terra.cost.input], [false, "azure-openai-responses", 272_000, 1]);
  assert.deepEqual(listed.filter((model: any) => model.available).map((model: any) => model.id).sort(), ["azure/gpt-6-luna", "azure/gpt-6-sol"]);
  assert.deepEqual((await r.call("/v1/models?provider=azure&available=true", { token: OWN })).json, []);
  const provider = (await r.call("/v1/providers", { token: PAYG })).json.find((entry: any) => entry.id === "azure");
  assert.deepEqual([provider.apiKey, provider.key?.source], [false, "platform"], "the platform's, not a tenant's to set");
  assert.equal((await r.call("/v1/providers", { token: OWN })).json.find((entry: any) => entry.id === "azure").key, null);

  const agent = await r.call("/v1/agents", { body: { model: "azure/gpt-6-sol" }, token: PAYG });
  assert.equal(agent.status, 201, agent.text);
  const outcome = (await r.prompt(agent.json.id, "What is 6 * 7?", PAYG)).outcome;
  assert.equal(outcome.result.reply, "Azure says sol-eastus2.");
  // Azure's v1 Responses API: the key as api-key, never a bearer token; the deployment as the body's model.
  assert.equal(azure.requests.length, 2, "the tool call, then the answer");
  for (const request of azure.requests) {
    assert.deepEqual([request.path, request.apiKey, request.authorization, request.body.model, request.body.stream], ["/openai/v1/responses?api-version=v1", KEY, undefined, "sol-eastus2", true]);
  }
  assert.ok(azure.requests[1].body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_1"), "the tool's result went back");
  assert.ok(azure.requests[0].body.prompt_cache_key, "prompt caching keyed by the agent");

  // Structured output: final_output forced by name, as on OpenAI's Responses API.
  const structured = await r.prompt(agent.json.id, "Yes?", PAYG, { output: { schema: { type: "object", properties: { yes: { type: "boolean" } }, required: ["yes"] } } });
  assert.deepEqual(structured.outcome.result.output, { yes: true }, JSON.stringify(structured.outcome));
  assert.deepEqual(azure.requests.at(-1)!.body.tool_choice, { type: "function", name: "final_output" });

  // Each response at gpt-6-sol's price (800 input, 1,200 cached, 300 output each), charged to the tenant's credit.
  const cost = (800 * 2 + 1_200 * 0.2 + 300 * 10) / 1e6;
  const n = azure.requests.length;
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === micros(10) - n * micros(cost), "the responses charged");
  const recorded = await until(async () => { const usage = (await r.call("/v1/usage", { token: PAYG })).json; return usage.totals.platformResponses === n && usage; }, "the usage recorded");
  assert.deepEqual([recorded.totals.input, recorded.totals.cacheRead, recorded.totals.output], [n * 800, n * 1_200, n * 300]);
  assert.ok(Math.abs(recorded.totals.platformCost - n * cost) < 1e-9, JSON.stringify(recorded.totals));
  assert.match(JSON.stringify(recorded), /azure/);

  // An agent's spend limit counts Azure's responses as any other's.
  const limited = await r.call("/v1/agents", { body: { model: "azure/gpt-6-luna", spendLimit: { usd: 0.000001 } }, token: PAYG });
  assert.equal(limited.status, 201, limited.text);
  await r.prompt(limited.json.id, "Hi", PAYG);
  assert.equal(azure.requests.at(-1)!.body.model, "gpt-6-luna", "a model alone is deployed under its own name");
  const again = await r.call(`/v1/agents/${limited.json.id}/prompt`, { body: { text: "Again" }, token: PAYG });
  assert.deepEqual([again.status, again.json.code], [402, "SPEND_LIMIT"], again.text);
});

test("an azure model without a deployment, a refused key, a missing deployment and a rate limit each end the run with Azure's reason", async t => {
  const { r, azure } = await start(t, body => body.input.at(-1)?.content?.[0]?.text === "401" ? { status: 401, error: { code: "401", message: "Access denied due to invalid subscription key or wrong API endpoint." } }
    : body.input.at(-1)?.content?.[0]?.text === "404" ? { status: 404, error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }
    : body.input.at(-1)?.content?.[0]?.text === "429" ? { status: 429, error: { code: "429", message: "Requests to the Responses API have exceeded the rate limit." }, headers: { "Retry-After": "1" } }
    : responses([message("ok")]));
  // A model the platform has not deployed: refused when configured, and a run on it says why before calling Azure.
  const agent = (await r.call("/v1/agents", { body: { model: "azure/gpt-6-sol" }, token: PAYG })).json.id;
  const refused = await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body: { model: "azure/gpt-5.5" }, token: PAYG });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /No azure deployment is configured for azure\/gpt-5\.5.*GET \/v1\/models\?available=true/);
  const undeployed = await r.call("/v1/agents", { body: { model: "azure/gpt-5.5" }, token: PAYG });
  assert.equal(undeployed.status, 201, undeployed.text);
  const before = azure.requests.length;
  const record = await r.prompt(undeployed.json.id, "Hi", PAYG);
  assert.equal(record.outcome.result.code, "model_key_missing", JSON.stringify(record));
  assert.match(record.error, /No azure deployment is configured for azure\/gpt-5\.5 on this runtime/);
  // Nor one of Azure's that is not on its Responses API, which no deployment can name.
  const deepseek = (await r.call("/v1/agents", { body: { model: "azure/deepseek-v4-pro" }, token: PAYG })).json.id;
  assert.equal((await r.prompt(deepseek, "Hi", PAYG)).outcome.result.code, "model_key_missing");
  assert.equal(azure.requests.length, before, "Azure was not called");
  // A tenant that keeps to its own keys has no azure model.
  const own = (await r.call("/v1/agents", { body: { model: "azure/gpt-6-sol" }, token: OWN })).json.id;
  assert.equal((await r.prompt(own, "Hi", OWN)).outcome.result.code, "model_key_missing");

  const failure = async (text: string) => {
    const record = await r.prompt(agent, text, PAYG);
    return { code: record.outcome.result?.code, error: String(record.error ?? record.outcome.result?.error) };
  };
  // A refused key is the platform's to fix, not the tenant's: no model_key_invalid remedy pointing at its own keys.
  const invalid = await failure("401");
  assert.notEqual(invalid.code, "model_key_invalid");
  assert.match(invalid.error, /^Azure OpenAI API error \(401\): .*invalid subscription key/);
  assert.match((await failure("404")).error, /^Azure OpenAI API error \(404\): .*DeploymentNotFound/);
  // Rate limited: retried as any provider's 429 is, then the run ends with Azure's words.
  const calls = azure.requests.length;
  assert.match((await failure("429")).error, /^Azure OpenAI API error \(429\): .*exceeded the rate limit/);
  assert.ok(azure.requests.length > calls + 1, "retried");
  assert.equal((await r.prompt(agent, "Hi", PAYG)).outcome.result.reply, "ok", "the agent goes on once Azure answers");
  assert.ok(!r.logs.some(line => line.includes(KEY)), "the key is never logged");
});

test("scripts/azure-models-check.ts makes one minimal call per configured deployment and reports Azure's answer, never the key", async t => {
  const azure = await fakeAzure(t, body => body.model === "missing" ? { status: 404, error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } } : responses([message("ok")], { input_tokens: 12, output_tokens: 2 }));
  const run = (models: string, extra: string[] = []) => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../scripts/azure-models-check.ts", import.meta.url)), ...extra], {
    env: { PATH: process.env.PATH, AGENT_AZURE_OPENAI_ENDPOINT: azure.base, AGENT_AZURE_OPENAI_API_KEY: KEY, AGENT_AZURE_OPENAI_MODELS: models },
  }).then(done => ({ code: 0, stdout: done.stdout, stderr: done.stderr }), (error: any) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }));

  const dry = await run("gpt-6-sol=sol-eastus2", ["--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(azure.requests.length, 0);
  const ok = await run("gpt-6-sol=sol-eastus2,gpt-6-luna=missing");
  assert.equal(ok.code, 1, "a deployment failed");
  const lines = ok.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => [line.model, line.deployment, !!line.ok]), [["azure/gpt-6-sol", "sol-eastus2", true], ["azure/gpt-6-luna", "missing", false]]);
  assert.deepEqual(lines[0].usage, { input: 12, output: 2, cacheRead: 0, usd: (12 * 2 + 2 * 10) / 1e6 });
  assert.match(lines[1].error, /deployment for this resource does not exist/);
  assert.deepEqual(azure.requests.map(request => [request.body.model, request.body.max_output_tokens, request.apiKey]), [["sol-eastus2", 16, KEY], ["missing", 16, KEY]]);
  assert.ok(!ok.stdout.includes(KEY) && !ok.stderr.includes(KEY));
});
