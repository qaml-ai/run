import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Tenants } from "../src/tenants.ts";
import { fakeModel, listen, OPERATOR, OTHER_OPERATOR, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("a tenant's own endpoint serves its agents' models, called with identity tokens and at no token cost", async t => {
  // The tenant's inference proxy: an OpenAI-compatible endpoint that answers with reasoning, a tool call, then text.
  const endpoint = await fakeModel(t, (_body, index) => [
    { reasoning_content: "Adding in code.", ...toolCall("js_exec", { code: "return 1 + 1;" }) },
    { content: "It is 2.", usage: { prompt_tokens: 1000, completion_tokens: 10 } },
  ][index] ?? { content: "ok" });
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {}, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, modelEndpoints: { chiridion: { baseUrl: endpoint.url, models: { "free/tiny": { contextWindow: 32_000, maxTokens: 4_000 } } } } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
  } });
  const models = (await r.call("/v1/models?provider=chiridion")).json;
  assert.deepEqual(models.map((model: any) => [model.id, model.contextWindow, model.available, model.cost.input]), [["chiridion/free/tiny", 32_000, true, 0]]);

  for (const model of ["chiridion/unknown-model", "chiridion/"]) assert.equal((await r.call("/v1/agents", { body: { model } })).status, 400, model);
  assert.equal((await r.call("/v1/agents", { token: OTHER_OPERATOR, body: { model: "chiridion/free/tiny" } })).status, 400, "another tenant's endpoint is unknown to bob");

  // A catalog model's id goes to the endpoint as it is, with the catalog's capabilities.
  const definition = (await r.call("/v1/definitions", { body: { name: "Camel", model: "chiridion/anthropic/claude-opus-5" } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id, subject: "u_1", context: { org: "org_9" } } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, "chiridion/anthropic/claude-opus-5");
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "What is 1 + 1?", actor: "u_2" } });
  const record = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the turn");
  assert.equal(record.outcome.result.reply, "It is 2.");
  assert.equal(r.model.bodies.length, 0, "the platform's model is never called");
  assert.equal(endpoint.bodies.length, 2);
  assert.equal(endpoint.bodies[0].model, "anthropic/claude-opus-5");
  assert.equal(endpoint.bodies[0].stream, true);
  assert.match(toolResults(endpoint.bodies[1]).at(-1), /2/);
  assert.ok(JSON.stringify(endpoint.bodies[1].messages).includes("Adding in code."), "the reasoning came back with the tool call");

  // Each call has a token of its own, which the endpoint verifies against the runtime's keys.
  const keys = createLocalJWKSet((await r.call("/.well-known/jwks.json", { token: null })).json);
  const tokens = endpoint.keys.map(header => header.replace(/^Bearer /, ""));
  assert.equal(new Set(tokens).size, 2);
  for (const token of tokens) {
    const { payload } = await jwtVerify(token, keys, { issuer: "https://agents.example.test", audience: endpoint.url });
    assert.deepEqual([payload.tenant, payload.agent, payload.sub, payload.act, payload.ctx, payload.definition], ["alice", agent, "u_1", "u_2", { org: "org_9" }, definition.id]);
  }

  // Tokens were counted, and cost nothing.
  const usage = (await r.call("/v1/usage")).json;
  const row = usage.days.flatMap((day: any) => day.models ?? [day]).find((entry: any) => entry.model === "chiridion/anthropic/claude-opus-5");
  assert.ok(row, JSON.stringify(usage));
  assert.equal(row.input, 1000);
  assert.equal(row.cost, 0);
  assert.equal(row.platformCost, 0);
});

test("model endpoints are checked when the tenants file loads", async () => {
  const load = async (modelEndpoints: unknown) => {
    const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { alice: { tokenSha256: sha(OPERATOR), modelEndpoints } } }) });
    await tenants.reload();
    return tenants.modelEndpoints("alice");
  };
  const ok = { chiridion: { baseUrl: "https://camelai.example/v1", models: { "free/tiny": { contextWindow: 1000, maxTokens: 100, input: ["text", "image"] } } } };
  assert.deepEqual(await load(ok), ok);
  for (const endpoints of [
    { openai: { baseUrl: "https://camelai.example/v1" } }, { Bad: { baseUrl: "https://camelai.example/v1" } },
    { chiridion: { baseUrl: "http://camelai.example/v1" } }, { chiridion: { baseUrl: "https://user:pass@camelai.example/v1" } },
    { chiridion: { baseUrl: "https://camelai.example/v1", models: { x: { contextWindow: 0, maxTokens: 1 } } } },
    { chiridion: { baseUrl: "https://camelai.example/v1", models: { x: { contextWindow: 1, maxTokens: 1, input: ["audio"] } } } },
  ]) await assert.rejects(load(endpoints), /Tenant alice/, JSON.stringify(endpoints));
});

/** An endpoint that answers each request with the next scripted reply: SSE chunks, or an HTTP error before any stream. */
async function scriptedEndpoint(t: T, replies: ({ chunks: object[] } | { status: number; error: object })[]) {
  const bodies: any[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    const reply = replies[bodies.length - 1] ?? { chunks: [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }] };
    if ("status" in reply) { res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: reply.error })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of reply.chunks) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/agent-runtime/llm/v1`, bodies };
}
const choice = (delta: object, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const endpointTenants = (baseUrl: string) => ({ tenants: { alice: { tokenSha256: sha(OPERATOR), modelEndpoints: { chiridion: { baseUrl } } } } });

test("a tenant endpoint's reasoning signatures go back with the conversation, after a restart too, and its usage is read", async t => {
  const signature = { type: "reasoning.encrypted", id: "call_calc", data: "opaque-signature" };
  const endpoint = await scriptedEndpoint(t, [
    { chunks: [
      choice({ reasoning_content: "Let me compute." }),
      choice({ tool_calls: [{ index: 0, id: "call_calc", type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code: "return 6 * 7;" }) } }] }),
      // Sent once the response is complete, as OpenRouter does.
      choice({ reasoning_details: [signature] }, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 30 } } },
    ] },
    { chunks: [choice({ content: "42." }, "stop")] },
  ]);
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), { AGENT_IDLE_MS: "1000" }, endpointTenants(endpoint.url));
  // A bare catalog id takes that model's capabilities.
  const agent = (await r.call("/v1/agents", { body: { model: "chiridion/claude-sonnet-5" } })).json.id;
  assert.equal((await r.prompt(agent, "6 times 7?")).outcome.result.reply, "42.");
  assert.equal(endpoint.bodies[0].model, "claude-sonnet-5");
  const replayed = (body: any) => body.messages.find((message: any) => message.role === "assistant" && message.tool_calls);
  assert.deepEqual(replayed(endpoint.bodies[1]).reasoning_details, [signature], "the signature goes back with the tool call's turn");

  // Stored in the transcript: once the agent has stopped and starts again, the next request still carries it.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the agent to stop when idle", 10_000);
  await r.prompt(agent, "And 6 times 8?");
  assert.deepEqual(replayed(endpoint.bodies[2]).reasoning_details, [signature]);

  const usage = (await r.call("/v1/usage")).json;
  const row = usage.days.find((entry: any) => entry.model === "chiridion/claude-sonnet-5");
  assert.deepEqual([row.input, row.cacheRead, row.cacheWrite, row.cost], [100, 600, 200, 0]);
});

test("a tenant endpoint's refusal ends the turn with its message, without retries", async t => {
  const endpoint = await scriptedEndpoint(t, [
    { status: 402, error: { message: "Out of credits for this workspace", type: "insufficient_credits", code: "credits" } },
    { status: 429, error: { message: "Too many requests for this user", type: "rate_limited", code: "rate_limit" } },
    { chunks: [choice({ content: "Partial" }), { error: { message: "Upstream provider failed", type: "provider_error", code: 502 } }] },
  ]);
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {}, endpointTenants(endpoint.url));
  const agent = (await r.call("/v1/agents", { body: { model: "chiridion/anthropic/claude-sonnet-5" } })).json.id;
  for (const expected of [/Out of credits for this workspace/, /Too many requests for this user/, /Upstream provider failed/]) {
    const before = endpoint.bodies.length;
    const outcome = (await r.prompt(agent, "hello")).outcome;
    assert.match(outcome.result?.error ?? outcome.error, expected);
    assert.equal(endpoint.bodies.length, before + 1, "one request, no retry");
  }
});
