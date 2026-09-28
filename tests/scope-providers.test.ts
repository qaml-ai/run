import { test } from "node:test";
import assert from "node:assert/strict";
import { providerInput } from "../src/model-providers.ts";
import { resolveModel } from "../src/session-config.ts";
import { anthropic, gateway, responses } from "./provider-fixtures.ts";
import { runtime, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const models = [{ id: "gpt-terra", contextWindow: 200_000, reasoning: true, pricing: { input: 1, output: 4 } }];

test("a custom provider speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages", () => {
  for (const [type, api] of [["openai-completions", "openai-completions"], ["openai-responses", "openai-responses"], ["anthropic-messages", "anthropic-messages"], ["openai-compatible", "openai-completions"]]) {
    const input = providerInput({ type, baseUrl: "https://llm.example.com/v1", models });
    assert.equal(input.type, api, `${type} is stored as ${api}`);
    assert.equal(resolveModel("custom/gpt-terra", undefined, { custom: input }).api, api);
  }
  // A gateway in front of a catalog model: it is called as the catalog calls it (Sonnet 5.5 always reasons), at the declared price.
  const gateway = resolveModel("house/claude-sonnet-5-5", undefined, { house: { type: "anthropic-messages", baseUrl: "https://llm.example.com", models: [{ id: "claude-sonnet-5-5", contextWindow: 100_000 }] } });
  assert.equal(gateway.thinkingLevelMap?.off, null);
  assert.equal(gateway.contextWindow, 100_000);
  assert.deepEqual(gateway.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(gateway.baseUrl, "https://llm.example.com");
  assert.equal(resolveModel("house/claude-sonnet-5-5", undefined, { house: { type: "openai-completions", baseUrl: "https://llm.example.com/v1", models: [{ id: "claude-sonnet-5-5", contextWindow: 100_000 }] } }).thinkingLevelMap, undefined, "only over the API the catalog calls it with");
  assert.throws(() => providerInput({ type: "bedrock-converse", baseUrl: "https://llm.example.com", models }), /type must be one of openai-completions, openai-responses, anthropic-messages/);
});

test("a key scope's providers serve only its agents: each scope its own, shadowing the tenant's of the same name, over every API", async t => {
  const provider = await gateway(t, body => body.input !== undefined
    ? responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Via Responses." }] }])
    : body.max_tokens !== undefined && body.messages && !body.stream_options
      ? anthropic([{ type: "text", text: "Via Messages." }], "end_turn")
      : { events: [] });
  const r = await runtime(t, body => ({ role: "assistant", content: `Tenant provider: ${body.model}` }), LOCAL);
  const put = (path: string, body: object) => r.call(path, { method: "PUT", body });

  // The tenant's own "custom" (Chat Completions), and each org's in its scope.
  assert.equal((await put("/v1/providers/custom", { type: "openai-completions", baseUrl: `${r.model.url}`, apiKey: "sk-tenant", models: [{ id: "gpt-terra", contextWindow: 200_000 }] })).status, 200);
  const orgA = await put("/v1/key-scopes/org_a/model-providers/custom", { type: "openai-responses", baseUrl: `${provider.url}/org-a/openai/v1`, apiKey: "sk-org-a", models });
  assert.equal(orgA.status, 200, orgA.text);
  assert.equal(orgA.json.custom.type, "openai-responses");
  assert.equal(JSON.stringify(orgA.json).includes("sk-org-a"), false, "never its key");
  assert.equal((await put("/v1/key-scopes/org_b/model-providers/claude", { type: "anthropic-messages", baseUrl: `${provider.url}/org-b`, apiKey: "sk-org-b", models: [{ id: "claude-house", contextWindow: 200_000 }] })).status, 200);
  assert.deepEqual((await r.call("/v1/key-scopes/org_a/model-providers")).json.map((entry: any) => entry.id), ["custom"]);

  const made = async (body: object) => r.call("/v1/agents", { body });
  const a = (await made({ keyScope: "org_a", model: "custom/gpt-terra" })).json.id;
  assert.equal((await r.prompt(a, "Hi")).outcome.result.reply, "Via Responses.");
  const sentA = provider.requests.at(-1)!;
  assert.equal(sentA.path, "/agent-runtime/llm/org-a/openai/v1/responses");
  assert.equal(sentA.headers.authorization, "Bearer sk-org-a");
  const b = (await made({ keyScope: "org_b", model: "claude/claude-house" })).json.id;
  assert.equal((await r.prompt(b, "Hi")).outcome.result.reply, "Via Messages.");
  const sentB = provider.requests.at(-1)!;
  assert.match(sentB.path, /^\/agent-runtime\/llm\/org-b\/v1\/messages(\?|$)/);
  assert.equal(sentB.headers["x-api-key"], "sk-org-b");

  // Org isolation: B's agents cannot name A's provider, nor A's B's; B's "custom" is the tenant's.
  const crossed = await made({ keyScope: "org_a", model: "claude/claude-house" });
  assert.equal(crossed.status, 400);
  assert.match(crossed.json.error, /Unknown model "claude\/claude-house"|claude/);
  assert.equal((await made({ model: "claude/claude-house" })).status, 400, "nor an agent with no scope");
  const tenants = (await made({ keyScope: "org_b", model: "custom/gpt-terra" })).json.id;
  assert.equal((await r.prompt(tenants, "Hi")).outcome.result.reply, "Tenant provider: gpt-terra");
  // A model is resolved in the agent's scope when it changes, or in the scope it moves to.
  const a2 = (await made({ keyScope: "org_a", model: "custom/gpt-terra" })).json.id;
  assert.equal((await r.call(`/v1/agents/${a2}/configuration`, { method: "PATCH", body: { model: "claude/claude-house" } })).status, 400, "not in A's scope");
  const moved = await r.call(`/v1/agents/${a2}/configuration`, { method: "PATCH", body: { keyScope: "org_b", model: "claude/claude-house" } });
  assert.equal(moved.status, 202, moved.text);
  const configured = await until(async () => { const record = (await r.call(`/v1/agents/${a2}/requests/${moved.json.id}`)).json; return record.state === "completed" && record; }, "the move");
  assert.equal(configured.error, undefined, JSON.stringify(configured.outcome));
  assert.equal((await r.prompt(a2, "Hi")).outcome.result.reply, "Via Messages.", "now in B's scope, on B's provider");
  // Models list per scope.
  const listed = (await r.call("/v1/models?keyScope=org_a")).json.map((model: any) => model.id);
  assert.ok(listed.includes("custom/gpt-terra") && !listed.includes("claude/claude-house"));

  // Deleting the scope deletes its providers.
  assert.equal((await r.call("/v1/key-scopes/org_b", { method: "DELETE" })).status, 200);
  assert.deepEqual((await r.call("/v1/key-scopes/org_b/model-providers")).json, []);
  assert.equal((await r.call("/v1/key-scopes/org_a/model-providers/custom", { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/key-scopes/org_a/model-providers/custom", { method: "DELETE" })).status, 404);
});
