import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {createHash} from "node:crypto";

import {responses} from "../../provider-fixtures.ts";

import {listen, OPERATOR, OTHER_OPERATOR, toolCall, toolResults} from "../support.ts";

const ALIAS = "camelrun/default", PARTICLE = "particle-ai/particle-1", FLASH = "deepseek/deepseek-v4.1-flash-1017";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

const ALIASED = { ...LOCAL, AGENT_PROVIDER: "camelrun", AGENT_MODEL: "default", AGENT_HOSTING: "inline" };

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
    const { usage, ...delta } = flash(body) as any, generation = `gen-${++generations}`;
    for (const [content, finish_reason] of [[delta, null], [{}, (delta as any).tool_calls ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: generation, object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }], ...(finish_reason && usage ? { usage } : {}) })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { url, requests };
}

const USD = 1_000_000;

contractTest("models", "tests/virtual-models.test.ts:117", "an agent naming no model stores the alias; Particle's outage moves that call to 1017, with history, routing and records on the model that ran", async t => {
  let down = true;
  const provider = await openrouter(t, () => down ? { status: 503 } : { text: "Particle again." }, body =>
    toolResults(body).length ? { role: "assistant", content: "Tool done, from 1017." } : body.messages.some((message: any) => /run the tool/.test(JSON.stringify(message.content))) ? toolCall("codemode", { code: "return 2 + 2" }) : { role: "assistant", content: "From 1017." });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  assert.equal((await r.call("/v1/me")).json.defaultModel, ALIAS);

  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", thinkingLevel: "low" } })).json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, ALIAS);

  const first = await r.prompt(agent, "Hello");
  assert.equal(first.outcome.result.reply, "From 1017.");
  assert.deepEqual(provider.requests.map(request => request.model), [PARTICLE, FLASH], "that one call moved, once");
  const reached = provider.requests[1];
  assert.deepEqual(reached.body.provider, { ignore: ["inference-net", "wafer", "relace", "coreweave"] }, "1017's own routing, reached through the alias");
  assert.equal(reached.body.reasoning?.effort, "low", "the agent's reasoning goes with it");
  assert.ok(Array.isArray(reached.body.messages), "1017's Chat Completions, Particle's Responses before it");
  assert.match(provider.requests[0].path, /responses/);
  assert.equal(first.outcome.result.servedModel ?? first.outcome.servedModel, `openrouter/${FLASH}`);
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, ALIAS, "the agent keeps the name");

  // Internal fallback log fields remain in the source suite.
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

contractTest("models", "tests/virtual-models.test.ts:164", "a request the model would refuse anywhere does not move; a real model never moves", async t => {
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

contractTest("models", "tests/virtual-models.test.ts:185", "a tenant with no OpenRouter key falls to what it holds; an upsert keeps the alias, and naming a model leaves it", async t => {
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

contractTest("models", "tests/virtual-models.test.ts:207", "over the API: Particle's failed attempt releases its end user's hold and costs nothing; only the model that answered is charged", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), ALIASED);
  const provider = await openrouter(t, () => ({ status: 503 }), () => ({ role: "assistant", content: "From 1017.", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }));
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: provider.url } });
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true } });
  await r.call("/v1/end-users/person/entries", { body: { kind: "grant", amount: 5 * USD, key: "pay" } });
  const agent = (await r.call("/v1/agents", { body: { keyScope: "hosted", subject: "person", bucket: "b" } })).json.id;
  const done = await r.prompt(agent, "Hello");
  assert.equal(done.outcome.result.reply, "From 1017.");
  // SQL holds and attempt rows remain in the source suite.
  const ledger = (await r.call("/v1/end-users/person/ledger")).json.entries.filter((entry: any) => entry.kind !== "grant").reduce((total: number, entry: any) => total + entry.amount, 0);
  assert.equal(Number(ledger), -10_000, "the end user pays once");
  const usage = JSON.stringify((await r.call("/v1/usage")).json);
  assert.ok(usage.includes(FLASH) && !usage.includes(PARTICLE), "usage names the model that answered");
  // Internal reconciliation metadata remains in the source suite.
});
