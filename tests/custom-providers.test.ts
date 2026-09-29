import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../clients/typescript.ts";
import { resolveModel } from "../src/session-config.ts";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, until } from "./runtime-server.ts";

/** The fake servers listen on this host, over http: reachable only where the operator allows it. */
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

type Turn = { text?: string; tool?: { name: string; args: unknown }; usage?: { prompt_tokens: number; completion_tokens: number } };
/**
 * A Chat Completions server. `bare` leaves out what small servers leave out: usage in the stream and
 * finish_reason. A tool call's arguments arrive in pieces, as servers stream them.
 */
async function chatServer(t: Parameters<typeof listen>[0], respond: (body: any, index: number) => Turn, options: { bare?: boolean } = {}) {
  const bodies: any[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    headers.push(req.headers);
    const turn = respond(body, bodies.length - 1);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: object, finish: string | null = null, usage?: object) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: options.bare ? null : finish }], ...(usage && !options.bare ? { usage } : {}) })}\n\n`);
    if (turn.tool) {
      const args = JSON.stringify(turn.tool.args);
      send({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: turn.tool.name, arguments: "" } }] });
      for (const piece of [args.slice(0, 4), args.slice(4)]) send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
      send({}, "tool_calls", turn.usage);
    } else {
      send({ role: "assistant", content: turn.text ?? "ok" });
      send({}, "stop", turn.usage);
    }
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, bodies, headers };
}

const provider = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
  type: "openai-completions", baseUrl, apiKey: "sk-custom-secret-1234", headers: { "x-org": "acme" },
  models: [{ id: "llama-4-scout", contextWindow: 131072, maxOutputTokens: 4096, pricing: { input: 50, output: 150 } }], ...extra,
});

test("a tenant's OpenAI-compatible provider: stored sealed, listed with its models, and called with its key and headers", async t => {
  const server = await chatServer(t, () => ({ text: "from the custom server", usage: { prompt_tokens: 10_000, completion_tokens: 10_000 } }));
  const r = await runtime(t, () => ({ role: "assistant", content: "catalog" }), LOCAL);
  const put = (name: string, body: unknown) => r.call(`/v1/providers/${name}`, { method: "PUT", body });

  for (const [name, body] of [
    ["openrouter", provider(server.url)],
    ["groq", provider(server.url)],
    ["Bad_Name", provider(server.url)],
    ["mine", { ...provider(server.url), type: "anthropic-compatible" }],
    ["mine", provider("https://10.0.0.1/v1")],
    ["mine", provider("ftp://example.com")],
    ["mine", provider(server.url, { models: [] })],
    ["mine", provider(server.url, { models: [{ id: "x" }] })],
    ["mine", provider(server.url, { models: [{ id: "x", contextWindow: 8000, input: ["audio"] }] })],
    ["mine", provider(server.url, { models: [{ id: "x", contextWindow: 8000, pricing: { input: -1, output: 0 } }] })],
    ["mine", provider(server.url, { headers: { Authorization: "Bearer y" } })],
  ] as const) assert.equal((await put(name, body)).status, 400, JSON.stringify([name, body]));

  const saved = await put("mine", provider(server.url));
  assert.equal(saved.status, 200, saved.text);
  const listed = (await r.call("/v1/providers")).json.find((entry: any) => entry.id === "mine");
  assert.deepEqual({ ...listed, key: { ...listed.key, setAt: undefined } }, {
    id: "mine", kind: "model", models: 1, apiKey: true, key: { provider: "mine", source: "tenant", last4: "1234", setAt: undefined },
    custom: {
      type: "openai-completions", baseUrl: server.url, headers: ["x-org"],
      models: [{ id: "llama-4-scout", contextWindow: 131072, maxOutputTokens: 4096, input: ["text"], reasoning: false, pricing: { input: 50, output: 150, cacheRead: 0, cacheWrite: 0 } }],
    },
  });
  for (const text of [saved.text, JSON.stringify(listed)]) assert.ok(!text.includes("sk-custom-secret") && !text.includes("acme"), "secrets are never returned");
  const model = (await r.call("/v1/models")).json.find((entry: any) => entry.id === "mine/llama-4-scout");
  assert.deepEqual([model.provider, model.contextWindow, model.maxTokens, model.available, model.cost.output], ["mine", 131072, 4096, true, 150]);

  assert.equal((await r.call("/v1/agents", { body: { model: "mine/unknown-model" } })).status, 400);
  const agent = (await r.call("/v1/agents", { body: { model: "mine/llama-4-scout" } })).json.id;
  const done = await r.prompt(agent, "Hello");
  assert.equal(done.outcome.result.reply, "from the custom server");
  assert.equal(server.headers[0].authorization, "Bearer sk-custom-secret-1234");
  assert.equal(server.headers[0]["x-org"], "acme");
  assert.equal(server.bodies[0].model, "llama-4-scout");
  assert.equal(server.bodies[0].stream, true);
  assert.ok(Math.abs(done.outcome.result.usage.costUsd - 2) < 1e-9, "10,000 tokens each way at the declared pricing");

  // A new key, or a new address, reaches the agent at its next call; a save without apiKey keeps the key.
  await put("mine", { ...provider(server.url), apiKey: "sk-rotated-5678" });
  await r.prompt(agent, "Again");
  assert.equal(server.headers.at(-1)!.authorization, "Bearer sk-rotated-5678");
  const { apiKey: _kept, ...keyless } = provider(server.url);
  await put("mine", keyless);
  await r.prompt(agent, "Kept");
  assert.equal(server.headers.at(-1)!.authorization, "Bearer sk-rotated-5678");

  // A changed declaration reaches an agent configured with the model again.
  const repriced = provider(server.url, { models: [{ id: "llama-4-scout", contextWindow: 131072, pricing: { input: 100, output: 150 } }] });
  await put("mine", repriced);
  const configured = await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body: { model: "mine/llama-4-scout" } });
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${configured.json.id}`)).json.state === "completed", "the configuration");
  assert.ok(Math.abs((await r.prompt(agent, "Repriced")).outcome.result.usage.costUsd - 2.5) < 1e-9);

  // A definition names its models the same way.
  assert.equal((await r.call("/v1/definitions", { body: { name: "Scout", model: "mine/llama-4-scout" } })).status, 201);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Nope", model: "mine/nope" } })).status, 400);

  // Deleted, it is gone: no new agents on it, and its agents' calls fail saying so.
  assert.equal((await r.call("/v1/providers/mine", { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/providers/mine", { method: "DELETE" })).status, 404);
  assert.equal((await r.call("/v1/agents", { body: { model: "mine/llama-4-scout" } })).status, 400);
  const failed = await r.prompt(agent, "Gone?");
  assert.match(failed.outcome.result.error, /mine provider is gone/);
  // Another tenant never sees it.
  assert.equal((await r.call("/v1/providers", { token: OTHER_OPERATOR })).json.some((entry: any) => entry.id === "mine"), false);
});

test("a server without usage or finish_reason (so declared) still runs tools; images reach only a model declared to see them", async t => {
  const server = await chatServer(t, (body, index) => {
    if (body.messages.at(-1).role === "tool") return { text: `tool said ${body.messages.at(-1).content}` };
    return index === 0 ? { tool: { name: "js_exec", args: { code: "return 6 * 7" } } } : { text: "seen" };
  }, { bare: true });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  const models = [
    { id: "text-only", contextWindow: 32768, compat: { supportsUsageInStreaming: false, supportsFinishReason: false, maxTokensField: "max_tokens" } },
    { id: "vision", contextWindow: 32768, input: ["text", "image"], compat: { supportsFinishReason: false } },
  ];
  assert.equal((await r.call("/v1/providers/local", { method: "PUT", body: { type: "openai-completions", baseUrl: server.url, models } })).status, 200, "a server that takes no key");
  const agent = (await r.call("/v1/agents", { body: { model: "local/text-only" } })).json.id;
  const done = await r.prompt(agent, "Compute");
  assert.equal(done.state, "completed", JSON.stringify(done.outcome));
  assert.match(done.outcome.result.reply, /tool said .*42/);
  assert.equal(server.headers[0].authorization, undefined, "no key, no Authorization");
  assert.equal(server.bodies[0].stream_options, undefined, "usage is not asked of a server that has none");
  assert.equal(server.bodies[0].max_tokens, 8192, "max_tokens, at the default for a model that declares no maximum");
  assert.ok(server.bodies[0].tools.some((tool: any) => tool.function.name === "js_exec"));
  assert.equal(done.outcome.result.usage.costUsd, 0, "no pricing, no cost");

  const image = [{ name: "dot.png", data: PNG.toString("base64") }];
  await r.prompt(agent, "What is this?", undefined, { files: image });
  assert.ok(!JSON.stringify(server.bodies.at(-1).messages).includes("image_url"), "a text-only model is told about the image in text");
  const seeing = (await r.call("/v1/agents", { body: { model: "local/vision" } })).json.id;
  await r.prompt(seeing, "What is this?", undefined, { files: image });
  assert.ok(JSON.stringify(server.bodies.at(-1).messages).includes("image_url"), "a model declared to see images is shown it");
});

test("a key scope can bring its own key and endpoint for a custom provider, and spend limits count its declared pricing", async t => {
  const server = await chatServer(t, () => ({ text: "ok", usage: { prompt_tokens: 10_000, completion_tokens: 0 } }));
  const orgs = await chatServer(t, () => ({ text: "org endpoint", usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/providers/mine", { method: "PUT", body: provider(server.url) });
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/mine", { method: "PUT", body: { apiKey: "org-key", baseUrl: orgs.url } })).status, 200);
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/other", { method: "PUT", body: { apiKey: "org-key" } })).status, 400, "only a provider the tenant has");
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/mine", { method: "PUT", body: { headers: { Authorization: "Bearer x" } } })).status, 400, "the key goes in apiKey");
  const scoped = (await r.call("/v1/agents", { body: { model: "mine/llama-4-scout", keyScope: "org_1" } })).json.id;
  assert.equal((await r.prompt(scoped, "Hi")).outcome.result.reply, "org endpoint");
  assert.equal(orgs.headers[0].authorization, "Bearer org-key");

  // 0.50 a call against a limit of 0.75: after two, the next is refused.
  const limited = (await r.call("/v1/agents", { body: { model: "mine/llama-4-scout", spendLimit: { usd: 0.75 } } })).json.id;
  assert.equal((await r.prompt(limited, "One")).outcome.result.usage.costUsd, 0.5);
  await r.prompt(limited, "Two");
  await assert.rejects(r.prompt(limited, "Three"), /402.*spend limit of \$0\.75 \(\$1 spent/);
});

test("deleting a provider takes its key scopes' entries with it: its agents call nothing, anywhere", async t => {
  const server = await chatServer(t, () => ({ text: "ok" }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/providers/mine", { method: "PUT", body: provider(server.url) });
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/mine", { method: "PUT", body: { apiKey: "org-key" } })).status, 200);
  const agent = (await r.call("/v1/agents", { body: { model: "mine/llama-4-scout", keyScope: "org_1" } })).json.id;
  await r.prompt(agent, "Hi");
  const calls = server.bodies.length;
  assert.equal((await r.call("/v1/providers/mine", { method: "DELETE" })).status, 200);
  assert.deepEqual((await r.call("/v1/key-scopes/org_1")).json.providers, [], "the scope's entry for it is gone too");
  const failed = await r.prompt(agent, "Still there?");
  assert.match(failed.outcome.result.error, /mine/);
  assert.equal(server.bodies.length, calls, "nothing was called");
});

test("a custom model is Pi's openai-completions model with the declared window, output cap, pricing and compat", () => {
  const custom = { mine: { type: "openai-completions" as const, baseUrl: "https://llm.example.com/v1", models: [{ id: "org/model:tag", contextWindow: 65536, reasoning: true, input: ["text", "image"] as ("text" | "image")[], pricing: { input: 1, output: 2, cacheRead: 0.1 }, compat: { supportsDeveloperRole: false } }] } };
  const model = resolveModel("mine/org/model:tag", undefined, custom) as any;
  assert.deepEqual({ ...model }, {
    id: "org/model:tag", name: "org/model:tag", provider: "mine", api: "openai-completions", baseUrl: "https://llm.example.com/v1",
    contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  });
  assert.throws(() => resolveModel("mine/other", undefined, custom), /Unknown model "mine\/other"/);
});

test("the SDK manages a tenant's custom providers", async t => {
  const server = await chatServer(t, () => ({ text: "ok" }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const saved = await sdk.setProvider("mine", { type: "openai-completions", baseUrl: server.url, models: [{ id: "m", contextWindow: 8192 }] });
  assert.equal(saved.id, "mine");
  assert.deepEqual((await sdk.providers()).filter(entry => entry.custom).map(entry => entry.id), ["mine"]);
  await sdk.deleteProvider("mine");
  await until(async () => !(await sdk.providers()).some(entry => entry.id === "mine"), "the provider to go");
});
