import { test } from "node:test";
import assert from "node:assert/strict";
import { callSettings, getModel, temperatureRefusal } from "../src/pi-catalog.ts";
import { modelSettingsRefusal } from "../src/session-config.ts";
import { anthropic, gateway, responses } from "./provider-fixtures.ts";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const model = (provider: string, id: string) => getModel(provider, id)!;

test("which models take a temperature: none that refuses one, always reasons, or reasons at the agent's thinking level", () => {
  for (const [provider, id] of [["anthropic", "claude-opus-4-7"], ["anthropic", "claude-opus-5-5"], ["anthropic", "claude-sonnet-5-5"], ["anthropic", "claude-fable-5-1"],
    ["amazon-bedrock", "us.anthropic.claude-opus-5"], ["openrouter", "anthropic/claude-opus-4.7"]]) {
    assert.match(temperatureRefusal(model(provider, id), "off") ?? "", /refuses one/, `${provider}/${id}`);
  }
  for (const [provider, id] of [["anthropic", "claude-fable-5"], ["openai", "gpt-5"], ["openai", "o3"]]) {
    assert.match(temperatureRefusal(model(provider, id), "off") ?? "", /always reasons/, `${provider}/${id}`);
  }
  for (const [provider, id] of [["anthropic", "claude-sonnet-5"], ["anthropic", "claude-haiku-4-5"], ["openai", "gpt-5.5"], ["openai", "gpt-4.1"], ["amazon-bedrock", "us.anthropic.claude-sonnet-5"]]) {
    assert.equal(temperatureRefusal(model(provider, id), "off"), undefined, `${provider}/${id}`);
  }
  assert.match(temperatureRefusal(model("anthropic", "claude-sonnet-5"), "high") ?? "", /thinkingLevel high/);
  assert.equal(temperatureRefusal(model("openai", "gpt-4.1"), "high"), undefined, "a model that does not reason ignores the level");

  const sonnet = model("anthropic", "claude-sonnet-5");
  assert.equal(modelSettingsRefusal(sonnet, { maxOutputTokens: sonnet.maxTokens, temperature: 0.3 }), undefined);
  assert.match(modelSettingsRefusal(sonnet, { maxOutputTokens: sonnet.maxTokens + 1 }) ?? "", /at most 128000 for anthropic\/claude-sonnet-5/);
  assert.match(modelSettingsRefusal(sonnet, { temperature: 0, thinkingLevel: "low" }) ?? "", /takes no temperature while it reasons/);
  assert.equal(modelSettingsRefusal(sonnet, { temperature: null, thinkingLevel: "low" }), undefined);

  // On a call: within the model's maximum, and no temperature where the call cannot take it.
  assert.deepEqual(callSettings(sonnet, { maxOutputTokens: 1_000_000, temperature: 0.2 }, undefined), { maxTokens: sonnet.maxTokens, temperature: 0.2 });
  assert.deepEqual(callSettings(sonnet, { maxOutputTokens: 500, temperature: 0.2 }, "medium"), { maxTokens: 500 });
  assert.deepEqual(callSettings(model("anthropic", "claude-opus-5"), { temperature: 0.2 }, undefined), {});
  assert.deepEqual(callSettings(sonnet, {}, undefined), {});
});

test("an agent's maxOutputTokens and temperature go on its model calls, are refused where its model takes none, and stay its own", async t => {
  const provider = await gateway(t, body => body.model.startsWith("claude")
    ? anthropic([{ type: "text", text: "Messages." }], "end_turn")
    : responses([{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Responses.", annotations: [] }] }]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/anthropic", { method: "PUT", body: { apiKey: "sk-ant", baseUrl: `${provider.url}/anthropic` } });
  await r.call("/v1/key-scopes/hosted/providers/openai", { method: "PUT", body: { apiKey: "sk-oai", baseUrl: `${provider.url}/openai` } });
  const create = (body: object) => r.call("/v1/agents", { body: { keyScope: "hosted", ...body } });
  const configure = async (agent: string, body: object) => {
    const accepted = await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body });
    if (accepted.status !== 202) return accepted;
    return { status: 202, json: await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the configuration") };
  };

  // Anthropic Messages: max_tokens and temperature as given.
  const claude = await create({ model: "anthropic/claude-sonnet-5", maxOutputTokens: 1000, temperature: 0.2 });
  assert.equal(claude.status, 201, claude.text);
  assert.equal((await r.prompt(claude.json.id, "Hi")).outcome.result.reply, "Messages.");
  let sent = provider.requests.at(-1)!.body;
  assert.deepEqual([sent.max_tokens, sent.temperature], [1000, 0.2]);
  const detail = (await r.call(`/v1/agents/${claude.json.id}`)).json;
  assert.deepEqual([detail.maxOutputTokens, detail.temperature], [1000, 0.2]);

  // OpenAI Responses: max_output_tokens and temperature.
  const gpt = await create({ model: "openai/gpt-4.1", maxOutputTokens: 2000, temperature: 1.5 });
  assert.equal(gpt.status, 201, gpt.text);
  assert.equal((await r.prompt(gpt.json.id, "Hi")).outcome.result.reply, "Responses.");
  sent = provider.requests.at(-1)!.body;
  assert.deepEqual([sent.max_output_tokens, sent.temperature], [2000, 1.5]);

  // Refused when the agent is made: a model that takes no temperature, or one reasoning at its level; more than the model writes; out of range.
  for (const [body, error] of [
    [{ model: "anthropic/claude-opus-5", temperature: 0.5 }, /anthropic\/claude-opus-5 takes no temperature/],
    [{ model: "openai/gpt-5", temperature: 0.5 }, /always reasons/],
    [{ model: "anthropic/claude-sonnet-5", thinkingLevel: "high", temperature: 0.5 }, /while it reasons \(thinkingLevel high\)/],
    [{ model: "anthropic/claude-sonnet-5", maxOutputTokens: 128_001 }, /at most 128000/],
    [{ model: "anthropic/claude-sonnet-5", temperature: 2.5 }, /temperature/],
    [{ model: "anthropic/claude-sonnet-5", maxOutputTokens: 0 }, /maxOutputTokens/],
  ] as const) {
    const refused = await create(body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.json.error, error, JSON.stringify(body));
  }

  // Refused when a configuration change would leave it asking for what its model takes no more.
  for (const body of [{ model: "anthropic/claude-opus-5" }, { thinkingLevel: "medium" }, { maxOutputTokens: 200_000 }]) {
    const refused = await configure(claude.json.id, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  // Together with removing the temperature, the same change is taken; the calls then carry none.
  const moved = await configure(claude.json.id, { thinkingLevel: "medium", temperature: null, maxOutputTokens: 4000 });
  assert.equal(moved.json.outcome?.error, undefined, JSON.stringify(moved.json));
  await r.prompt(claude.json.id, "Again");
  sent = provider.requests.at(-1)!.body;
  assert.equal(sent.temperature, undefined);
  // Sonnet 5 thinks adaptively: its thinking counts toward max_tokens (a model on a thinking budget gets the budget on top).
  assert.deepEqual([sent.thinking?.type, sent.max_tokens], ["adaptive", 4000]);
  const after = (await r.call(`/v1/agents/${claude.json.id}`)).json;
  assert.deepEqual([after.maxOutputTokens, after.temperature], [4000, null]);
  const cleared = await configure(claude.json.id, { maxOutputTokens: null });
  assert.equal(cleared.json.outcome?.error, undefined);
  assert.equal((await r.call(`/v1/agents/${claude.json.id}`)).json.maxOutputTokens, null);

  // An upsert with another temperature is another configuration.
  const first = await r.call("/v1/agents", { body: { keyScope: "hosted", model: "anthropic/claude-sonnet-5", temperature: 0.1 }, headers: { "Idempotency-Key": "settings-upsert" } });
  const same = await r.call("/v1/agents", { body: { keyScope: "hosted", model: "anthropic/claude-sonnet-5", temperature: 0.1 }, headers: { "Idempotency-Key": "settings-upsert" } });
  const other = await r.call("/v1/agents", { body: { keyScope: "hosted", model: "anthropic/claude-sonnet-5", temperature: 0.7 }, headers: { "Idempotency-Key": "settings-upsert" } });
  assert.equal(first.json.configHash, same.json.configHash);
  assert.notEqual(first.json.configHash, other.json.configHash);
  await until(async () => (await r.call(`/v1/agents/${first.json.id}/requests/${other.json.reconfigured.id}`)).json.state === "completed", "the upsert");
  assert.equal((await r.call(`/v1/agents/${first.json.id}`)).json.temperature, 0.7);
});

test("a definition's maxOutputTokens and temperature: its agents take them, an agent's own stay when it is applied, and a stateless run takes them too", async t => {
  const provider = await gateway(t, () => anthropic([{ type: "text", text: "Defined." }], "end_turn"));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/anthropic", { method: "PUT", body: { apiKey: "sk-ant", baseUrl: `${provider.url}/anthropic` } });

  const refused = await r.call("/v1/definitions", { body: { name: "opus", model: "anthropic/claude-opus-5", temperature: 0.4 } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /takes no temperature/);
  assert.equal((await r.call("/v1/definitions", { body: { name: "hot", model: "anthropic/claude-sonnet-5", temperature: 3 } })).status, 400);

  const definition = (await r.call("/v1/definitions", { body: { name: "writer", model: "anthropic/claude-sonnet-5", maxOutputTokens: 3000, temperature: 0.4 } })).json;
  assert.deepEqual([definition.maxOutputTokens, definition.temperature], [3000, 0.4]);
  const plain = (await r.call("/v1/agents", { body: { definition: definition.id, keyScope: "hosted" } })).json.id;
  const own = (await r.call("/v1/agents", { body: { definition: definition.id, keyScope: "hosted", temperature: 0.9 } })).json.id;
  await r.prompt(plain, "Hi");
  assert.deepEqual([provider.requests.at(-1)!.body.max_tokens, provider.requests.at(-1)!.body.temperature], [3000, 0.4]);
  await r.prompt(own, "Hi");
  assert.deepEqual([provider.requests.at(-1)!.body.max_tokens, provider.requests.at(-1)!.body.temperature], [3000, 0.9]);

  // A new revision applies to both, but the agent's own temperature stays its own.
  const applied = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { maxOutputTokens: 1500, temperature: 0.1, apply: "all" } });
  assert.equal(applied.status, 200, applied.text);
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 2), "the apply");
  const views = await Promise.all([plain, own].map(async id => (await r.call(`/v1/agents/${id}`)).json));
  assert.deepEqual(views.map(view => [view.maxOutputTokens, view.temperature]), [[1500, 0.1], [1500, 0.9]]);
  // A revision that turns thinking on: the agent's own temperature no longer applies, and its calls leave it out.
  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { temperature: null, thinkingLevel: "low", apply: "all" } });
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 3), "the apply");
  const done = await r.prompt(own, "Hi");
  assert.equal(done.outcome.result.reply, "Defined.");
  assert.equal(provider.requests.at(-1)!.body.temperature, undefined);

  // A stateless run: given directly, or from the definition.
  const run = await r.call("/v1/runs", { body: { input: "Write.", model: "anthropic/claude-sonnet-5", keyScope: "hosted", maxOutputTokens: 700, temperature: 0, wait: true } });
  assert.equal(run.json.status, "completed", run.text);
  assert.deepEqual([provider.requests.at(-1)!.body.max_tokens, provider.requests.at(-1)!.body.temperature], [700, 0]);
  const runRefused = await r.call("/v1/runs", { body: { input: "Write.", model: "openai/o3", keyScope: "hosted", temperature: 0.5 } });
  assert.equal(runRefused.status, 400);
  assert.match(runRefused.json.error, /always reasons/);
});

test("the TypeScript SDK sends maxOutputTokens and temperature when it makes, configures and runs agents", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const last = () => r.model.bodies.at(-1);
  const agent = await agents.upsert("settings", { instructions: "Be brief.", maxOutputTokens: 300, temperature: 0.3 });
  await agent.run("hi");
  assert.deepEqual([last().max_completion_tokens ?? last().max_tokens, last().temperature], [300, 0.3]);
  await agent.configure({ temperature: null });
  await agent.run("again");
  assert.equal(last().temperature, undefined);
  const run = await agents.run({ instructions: "Be brief.", input: "once", temperature: 0.6, maxOutputTokens: 200 });
  assert.equal(run.text, "ok");
  assert.deepEqual([last().max_completion_tokens ?? last().max_tokens, last().temperature], [200, 0.6]);
});
