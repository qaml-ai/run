import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, reasoningFloor } from "../src/pi-catalog.ts";
import { anthropic, gateway } from "./provider-fixtures.ts";
import { runtime } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

test("a model that always reasons is called with its least reasoning when an agent asks for none, and as asked otherwise", async t => {
  // As Anthropic and OpenRouter answer Claude Sonnet 5.5: thinking turned off is refused.
  const provider = await gateway(t, body => body.thinking?.type === "disabled"
    ? { status: 400, error: { type: "invalid_request_error", message: "Reasoning is mandatory for this endpoint and cannot be disabled." } }
    : anthropic([{ type: "text", text: "Reasoned." }], "end_turn"));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  await r.call("/v1/key-scopes/hosted/providers/anthropic", { method: "PUT", body: { apiKey: "sk-ant", baseUrl: `${provider.url}/anthropic` } });
  for (const model of ["openrouter/anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5-5"]) {
    const agent = (await r.call("/v1/agents", { body: { model, keyScope: "hosted" } })).json.id;
    assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Reasoned.", model);
    const sent = provider.requests.at(-1)!.body;
    assert.deepEqual([sent.thinking?.type, sent.output_config?.effort], ["adaptive", "low"], model);
  }
  const asked = (await r.call("/v1/agents", { body: { model: "anthropic/claude-sonnet-5-5", keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  await r.prompt(asked, "Hi");
  assert.equal(provider.requests.at(-1)!.body.output_config?.effort, "high");
});

test("which models always reason: Sonnet 5.5 everywhere, Sonnet 5 nowhere, and an agent's copy of a model before its entry said so", () => {
  assert.equal(reasoningFloor(getModel("openrouter", "anthropic/claude-sonnet-5.5")!), "low");
  assert.equal(reasoningFloor(getModel("anthropic", "claude-sonnet-5-5")!), "minimal");
  assert.equal(reasoningFloor(getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5")!), "minimal");
  assert.equal(reasoningFloor(getModel("anthropic", "claude-sonnet-5")!), undefined);
  const { thinkingLevelMap: _map, ...older } = getModel("anthropic", "claude-sonnet-5-5")!;
  assert.equal(reasoningFloor({ ...older, thinkingLevelMap: { xhigh: "xhigh" } } as never), "minimal");
});

test("a run whose first model call is refused fails with the provider's error, on every API, before its stream or in it", async t => {
  const message = "Reasoning is mandatory for this endpoint and cannot be disabled.";
  // Refused with an HTTP error, then within a stream that began (OpenRouter's way for Anthropic's models).
  const provider = await gateway(t, (_body, index) => index % 2 === 0
    ? { status: 400, error: { type: "invalid_request_error", message } }
    : { events: [{ type: "error", error: { type: "invalid_request_error", message } }] });
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  await r.call("/v1/key-scopes/hosted/providers/anthropic", { method: "PUT", body: { apiKey: "sk-ant", baseUrl: `${provider.url}/anthropic` } });
  for (const model of ["openrouter/anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5", "openrouter/openai/gpt-6-luna"]) {
    const agent = (await r.call("/v1/agents", { body: { model, keyScope: "hosted" } })).json.id;
    for (const how of ["HTTP", "stream"]) {
      const done = await r.prompt(agent, "Hi");
      assert.match(done.outcome.result.error ?? "", /Reasoning is mandatory/, `${model}, ${how}: ${JSON.stringify(done.outcome)}`);
    }
  }
});
