import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Tenants } from "../src/tenants.ts";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

type Reply = { events: object[] } | { status: number; error: object };
/**
 * A tenant's pass-through gateway: records each request as it arrives (path, headers, the provider's
 * native body) and answers with the next scripted reply, SSE events or an HTTP error before any stream.
 */
async function gateway(t: T, reply: (body: any, index: number) => Reply) {
  const requests: { path: string; headers: Record<string, any>; body: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ path: req.url!, headers: req.headers, body });
    const next = reply(body, requests.length - 1);
    if ("status" in next) { res.writeHead(next.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: next.error })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of next.events) res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  return { url: `${url}/agent-runtime/llm`, requests };
}

/** Anthropic Messages events for one response: its content blocks, then its stop reason and usage. */
function anthropic(blocks: object[], stop: string, usage = { input_tokens: 10, output_tokens: 5 }) {
  const events: object[] = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }];
  blocks.forEach((block: any, index) => {
    if (block.type === "thinking") events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    if (block.type === "tool_use") events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    if (block.type === "text") events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  });
  return { events: [...events, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } }, { type: "message_stop" }] };
}

/** OpenAI Responses events for one response of output items, and its usage. */
function responses(items: object[], usage = { input_tokens: 10, output_tokens: 5 }) {
  const events: object[] = [{ type: "response.created", response: { id: "resp_1", status: "in_progress" } }];
  items.forEach((item: any, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: item.type === "message" ? { ...item, content: [] } : item.type === "function_call" ? { ...item, arguments: "" } : item });
    if (item.type === "message") events.push({ type: "response.output_text.delta", output_index, content_index: 0, delta: item.content[0].text });
    if (item.type === "function_call") events.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  return { events: [...events, { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } } }] };
}
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

const tenantsWith = (baseUrl: string, models?: object) => ({ tenants: {
  alice: { tokenSha256: sha(OPERATOR), modelEndpoints: { chiridion: { baseUrl, ...(models ? { models } : {}) } } },
  bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
} });

test("an Anthropic model on a tenant's endpoint gets Anthropic's own request, signatures included, with identity tokens and at no token cost", async t => {
  const endpoint = await gateway(t, (_body, index) => [
    anthropic([{ type: "thinking", thinking: "Adding in code.", signature: "sig-from-anthropic" }, { type: "tool_use", id: "toolu_1", name: "js_exec", input: { code: "return 1 + 1;" } }], "tool_use"),
    anthropic([{ type: "text", text: "It is 2." }], "end_turn", { input_tokens: 1000, output_tokens: 10 }),
  ][index]);
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {}, tenantsWith(endpoint.url));
  for (const model of ["chiridion/unknown-model", "chiridion/", "chiridion/mistral/mistral-large", "chiridion/anthropic/no-such-model"]) assert.equal((await r.call("/v1/agents", { body: { model } })).status, 400, model);
  assert.equal((await r.call("/v1/agents", { token: OTHER_OPERATOR, body: { model: "chiridion/anthropic/claude-opus-5" } })).status, 400, "another tenant's endpoint is unknown to bob");

  const definition = (await r.call("/v1/definitions", { body: { name: "Camel", model: "chiridion/anthropic/claude-opus-5", thinkingLevel: "high" } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id, subject: "u_1", context: { org: "org_9" } } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, "chiridion/anthropic/claude-opus-5");
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "What is 1 + 1?", actor: "u_2" } });
  const record = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the turn");
  assert.equal(record.outcome.result.reply, "It is 2.");
  assert.equal(r.model.bodies.length, 0, "the platform's model is never called");

  // Anthropic's Messages API at <endpoint>/anthropic, as Anthropic's client sends it.
  assert.deepEqual(endpoint.requests.map(request => request.path), ["/agent-runtime/llm/anthropic/v1/messages?beta=true", "/agent-runtime/llm/anthropic/v1/messages?beta=true"]);
  assert.equal(endpoint.requests[0].body.model, "claude-opus-5");
  assert.equal(endpoint.requests[0].body.stream, true);
  const replayed = endpoint.requests[1].body.messages.find((entry: any) => entry.role === "assistant");
  assert.deepEqual(replayed.content[0], { type: "thinking", thinking: "Adding in code.", signature: "sig-from-anthropic" }, "the thinking block goes back with its signature");

  // Each call has a token of its own, as Anthropic's key and in X-Agent-Runtime-Identity, which the endpoint verifies against the runtime's keys.
  const keys = createLocalJWKSet((await r.call("/.well-known/jwks.json", { token: null })).json);
  for (const { headers } of endpoint.requests) assert.equal(headers["x-api-key"], headers["x-agent-runtime-identity"]);
  const tokens = endpoint.requests.map(request => request.headers["x-agent-runtime-identity"]);
  assert.equal(new Set(tokens).size, 2);
  for (const token of tokens) {
    const { payload } = await jwtVerify(token, keys, { issuer: "https://agents.example.test", audience: endpoint.url });
    assert.deepEqual([payload.tenant, payload.agent, payload.sub, payload.act, payload.ctx, payload.definition], ["alice", agent, "u_1", "u_2", { org: "org_9" }, definition.id]);
  }

  // Tokens were counted under the endpoint, and cost nothing.
  const usage = (await r.call("/v1/usage")).json;
  const row = usage.days.flatMap((day: any) => day.models ?? [day]).find((entry: any) => entry.model === "chiridion/anthropic/claude-opus-5");
  assert.ok(row, JSON.stringify(usage));
  assert.deepEqual([row.input, row.cost, row.platformCost], [1010, 0, 0]);
});

test("OpenRouter models on a tenant's endpoint use its Responses API, reasoning carried back, and compact through it", async t => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Let me compute." }], encrypted_content: "opaque-reasoning" };
  const endpoint = await gateway(t, (_body, index) => [
    responses([reasoning, { type: "function_call", id: "fc_1", call_id: "call_calc", name: "js_exec", arguments: JSON.stringify({ code: "return 6 * 7;" }), status: "completed" }]),
    responses([message("42.")], { input_tokens: 3_500, output_tokens: 10 }),
  ][index] ?? responses([message("Summary: the user asked for sums.")]));
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {}, tenantsWith(endpoint.url, { "openrouter/free/tiny": { contextWindow: 4_000, maxTokens: 1_000, reasoning: true } }));
  const models = (await r.call("/v1/models?provider=chiridion")).json;
  assert.deepEqual(models.map((model: any) => [model.id, model.api, model.contextWindow, model.available, model.cost.input]), [["chiridion/openrouter/free/tiny", "openai-responses", 4_000, true, 0]]);

  const agent = (await r.call("/v1/agents", { body: { model: "chiridion/openrouter/free/tiny", thinkingLevel: "high" } })).json.id;
  assert.equal((await r.prompt(agent, "6 times 7?")).outcome.result.reply, "42.");
  const [first, second] = endpoint.requests;
  assert.deepEqual([first.path, first.body.model, first.body.store, first.body.stream], ["/agent-runtime/llm/openrouter/v1/responses", "free/tiny", false, true]);
  assert.equal(first.headers.authorization, `Bearer ${first.headers["x-agent-runtime-identity"]}`);
  assert.deepEqual(second.body.input.find((item: any) => item.type === "reasoning"), reasoning, "the reasoning item goes back whole");

  // The last response filled most of the 4k window: the next turn compacts first, through the endpoint too.
  await r.prompt(agent, "And 6 times 8?");
  const summarizing = endpoint.requests[2];
  assert.equal(summarizing.path, "/agent-runtime/llm/openrouter/v1/responses");
  assert.ok(summarizing.headers["x-agent-runtime-identity"]);
  assert.match(JSON.stringify(summarizing.body.input), /summar/i);
  const usage = (await r.call("/v1/usage")).json;
  assert.ok(usage.days.some((entry: any) => entry.model === "chiridion/openrouter/free/tiny" && entry.kind === "compaction" && entry.cost === 0), JSON.stringify(usage));
});

test("a tenant endpoint's errors end the turn with its message, without retries", async t => {
  const endpoint = await gateway(t, (_body, index) => [
    { status: 402, error: { type: "insufficient_credits", message: "Out of credits for this workspace" } },
    { status: 429, error: { type: "rate_limited", message: "Too many requests for this user" } },
    { status: 503, error: { type: "overloaded_error", message: "Upstream provider failed" } },
  ][index] ?? anthropic([{ type: "text", text: "ok" }], "end_turn"));
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {}, tenantsWith(endpoint.url));
  // OpenRouter's Anthropic models keep its Messages API (at <endpoint>/openrouter/v1/messages, with the query Anthropic's client adds), where they are cached.
  const agent = (await r.call("/v1/agents", { body: { model: "chiridion/openrouter/anthropic/claude-sonnet-5" } })).json.id;
  for (const expected of [/Out of credits for this workspace/, /Too many requests for this user/, /Upstream provider failed/]) {
    const before = endpoint.requests.length;
    const outcome = (await r.prompt(agent, "hello")).outcome;
    assert.match(outcome.result?.error ?? outcome.error, expected);
    assert.equal(endpoint.requests.length, before + 1, "one request, no retry");
  }
  assert.equal(endpoint.requests[0].path, "/agent-runtime/llm/openrouter/v1/messages?beta=true");
  assert.equal(endpoint.requests[0].body.model, "anthropic/claude-sonnet-5");
});

test("model endpoints are checked when the tenants file loads", async () => {
  const load = async (modelEndpoints: unknown) => {
    const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { alice: { tokenSha256: sha(OPERATOR), modelEndpoints } } }) });
    await tenants.reload();
    return tenants.modelEndpoints("alice");
  };
  const ok = { chiridion: { baseUrl: "https://camelai.example/agent-runtime/llm", models: { "openrouter/free/tiny": { contextWindow: 1000, maxTokens: 100, input: ["text", "image"] } } } };
  assert.deepEqual(await load(ok), ok);
  assert.ok(await load({ chiridion: { baseUrl: "http://localhost:8787/agent-runtime/llm" } }));
  for (const endpoints of [
    { openai: { baseUrl: "https://camelai.example/llm" } }, { Bad: { baseUrl: "https://camelai.example/llm" } },
    { chiridion: { baseUrl: "http://camelai.example/llm" } }, { chiridion: { baseUrl: "https://user:pass@camelai.example/llm" } },
    { chiridion: { baseUrl: "https://camelai.example/llm", models: { tiny: { contextWindow: 1, maxTokens: 1 } } } },
    { chiridion: { baseUrl: "https://camelai.example/llm", models: { "mistral/tiny": { contextWindow: 1, maxTokens: 1 } } } },
    { chiridion: { baseUrl: "https://camelai.example/llm", models: { "openrouter/x": { contextWindow: 0, maxTokens: 1 } } } },
    { chiridion: { baseUrl: "https://camelai.example/llm", models: { "openrouter/x": { contextWindow: 1, maxTokens: 1, input: ["audio"] } } } },
  ]) await assert.rejects(load(endpoints), /Tenant alice/, JSON.stringify(endpoints));
});
