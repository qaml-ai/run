import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, reasoningFloor } from "../src/pi-catalog.ts";
import { anthropic, gateway } from "./provider-fixtures.ts";
import { runtime } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
/** The effort a request asks for: Pi gives a model with mid-conversation effort (Sonnet 5.5) its level as the latest system message's. */
const effort = (body: any) => body.messages.findLast((message: any) => message.output_config)?.output_config.effort ?? body.output_config?.effort;

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
    const done = await r.prompt(agent, "Hi");
    assert.equal(done.outcome.result.reply, "Reasoned.", model);
    assert.equal(done.error, undefined, "a run that answered has no error on top");
    const sent = provider.requests.at(-1)!.body;
    assert.deepEqual([sent.thinking?.type, effort(sent)], ["adaptive", "low"], model);
  }
  const asked = (await r.call("/v1/agents", { body: { model: "anthropic/claude-sonnet-5-5", keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  await r.prompt(asked, "Hi");
  assert.equal(effort(provider.requests.at(-1)!.body), "high");
});

test("which models always reason: Sonnet and Haiku 5.5 everywhere, Sonnet 5 nowhere, and an agent's copy of a model before its entry said so", () => {
  assert.equal(reasoningFloor(getModel("openrouter", "anthropic/claude-sonnet-5.5")!), "low");
  // Pi's Anthropic entry has no minimal level (Anthropic's efforts start at low).
  assert.equal(reasoningFloor(getModel("anthropic", "claude-sonnet-5-5")!), "low");
  assert.equal(reasoningFloor(getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5")!), "minimal");
  // On Bedrock, read from the Anthropic entry: Haiku 5.5's profiles too, and a base id names its global profile.
  for (const id of ["global.anthropic.claude-haiku-5-5", "us.anthropic.claude-haiku-5-5", "anthropic.claude-haiku-5-5"]) {
    assert.equal(reasoningFloor(getModel("amazon-bedrock", id)!), "minimal", id);
  }
  assert.equal(getModel("amazon-bedrock", "anthropic.claude-haiku-5-5")!.id, "global.anthropic.claude-haiku-5-5");
  assert.equal(getModel("amazon-bedrock", "anthropic.claude-opus-4-1-20250805-v1:0")!.id, "us.anthropic.claude-opus-4-1-20250805-v1:0", "no global profile: the US one");
  assert.equal(reasoningFloor(getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5")!), undefined);
  assert.equal(reasoningFloor(getModel("anthropic", "claude-sonnet-5")!), undefined);
  const { thinkingLevelMap: _map, ...older } = getModel("anthropic", "claude-sonnet-5-5")!;
  assert.equal(reasoningFloor({ ...older, thinkingLevelMap: { xhigh: "xhigh" } } as never), "low");
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
      // On top of the request too, as the API and a browser token's reader see it: a failed run reads as failed.
      assert.match(done.error ?? "", /Reasoning is mandatory/, `${model}, ${how}`);
      const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: {} })).json;
      for (const reader of [undefined, token]) {
        const seen = (await r.call(`/v1/agents/${agent}/state`, { token: reader })).json.requests.find((request: { id: string }) => request.id === done.id);
        assert.match(seen.error ?? "", /Reasoning is mandatory/, `${model}, ${how}, ${reader ? "browser" : "API"}`);
        assert.match(seen.outcome.error ?? seen.outcome.result.error, /Reasoning is mandatory/);
      }
    }
  }
});
