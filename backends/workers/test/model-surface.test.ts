import assert from "node:assert/strict";
import test from "node:test";
import { configuration } from "../src/api-contract.ts";
import { resolveModel, routeModel, modelHeadersInput, runLimitsInput } from "../src/model-policy.ts";
import { callSettings } from "../src/model-catalog.ts";
import { boundedModel } from "../src/model-context.ts";
import { importedHistory } from "../src/history-policy.ts";
import { providerInput, providerName } from "../src/provider-policy.ts";
import { outputInput, schemaAccepts } from "../src/output-validation.ts";
import { openProviderSecret, sealProviderSecret } from "../src/model-credentials.ts";
import { configuredModel, defaultModels } from "../src/default-model-policy.ts";

test("default candidates preserve virtual names and reject misspelled operator fallbacks", () => {
  assert.equal(configuredModel({}).virtual, "camelrun/default");
  const defaults = defaultModels(resolveModel("camelrun/default"), "anthropic/claude-sonnet-5-5");
  assert.equal(defaults[0].virtual, "camelrun/default");
  assert.equal(defaults[1].provider, "anthropic");
  assert.throws(() => defaultModels(defaults[0], "openrouter/missing/no-model"), /AGENT_MODEL_FALLBACKS/);
});

test("configuration validates prompt, human input and exclusive lifetimes", () => {
  assert.throws(() => configuration({systemPrompt:" "},"test/echo"), /1–32000/);
  assert.throws(() => configuration({systemPromptAppend:"x".repeat(32001)},"test/echo"), /32000/);
  assert.throws(() => configuration({humanInput:{onExpire:"silence"}},"test/echo"), /onExpire/);
  assert.throws(() => configuration({humanInput:{expiresInSeconds:59}},"test/echo"), /expiresInSeconds/);
  assert.throws(() => configuration({ttlSeconds:3600,idleTtlSeconds:600},"test/echo"), /not both/);
  const idle = configuration({idleTtlSeconds:600,humanInput:{onExpire:"resume"}},"test/echo");
  assert.equal(idle.ttlSeconds,600);
  assert.equal(idle.config.idleTtlSeconds,600);
  assert.deepEqual(idle.config.humanInput,{onExpire:"resume"});
});

test("configuration retains provider settings, imports history and rejects reserved headers", () => {
  assert.throws(() => configuration({ modelOverride: { cost: { input: 0 } } }, "test/echo"), /Unknown agent field: modelOverride/);
  const { config } = configuration({ maxOutputTokens: 300, temperature: 0.3, dataCollection: "deny", language: "pt-br", modelHeaders: { "cf-aig-metadata": "fixture" }, runLimits: { contextTokens: 24000, maxResponses: 3 }, importMessages: { format: "openai-chat", messages: [{ role: "user", content: "Remember Ada" }, { role: "assistant", content: "Hello" }] } }, "test/echo");
  assert.equal(config.language, "pt-BR");
  assert.equal(config.maxOutputTokens, 300);
  assert.equal(config.temperature, 0.3);
  assert.deepEqual(config.runLimits, { contextTokens: 24000, maxResponses: 3 });
  assert.deepEqual(importedHistory(config.initialMessages as never).messages.map(message => message.role), ["user", "assistant"]);
  assert.throws(() => modelHeadersInput({ Authorization: "secret" }), /runtime sets/);
  assert.throws(() => runLimitsInput({ contextTokens: 19999 }), /at least 20000/);
  assert.throws(() => configuration({ initialMessages: [{ role: "robot" }] }, "test/echo"), /INVALID_HISTORY/);
});
test("configuration keeps attached tools, normalizes delegation, and clears optional model settings", () => {
  const tool = { name: "sum", inputSchema: { type: "object", properties: { a: { type: "number" } } } };
  const { config } = configuration({ mcp: { tools: [tool] }, builtins: ["delegate"], delegate: { agents: ["helper"], maxDepth: 3 }, temperature: null, maxOutputTokens: null }, "test/echo");
  assert.deepEqual(config.mcp?.tools, [tool]);
  assert.deepEqual(config.delegate?.agents, [{ name: "helper", definition: "helper" }]);
  assert.ok(config.builtins?.includes("delegate"));
  assert.equal(config.temperature, null);
  assert.equal(configuration({spendLimit:null}, "test/echo").config.spendLimit, null);
  assert.deepEqual(configuration({webSearch:{providers:["brave","exa"]}},"test/echo").config.webSearch,{providers:["brave","exa"]});
  assert.throws(() => configuration({webSearch:{providers:["brave","brave"]}},"test/echo"), /each once/);
  const limited = configuration({delegate:{maxParallel:3,maxDepth:1}},"test/echo").config;
  assert.equal(limited.builtins, undefined);
  assert.deepEqual(limited.delegate,{maxParallel:3,maxDepth:1});
  assert.throws(() => configuration({ delegate: { agents: ["helper"] } }, "test/echo"), /need the delegate or agents builtin/);
  assert.throws(() => configuration({ builtins: ["schedule", "schedule"] }, "test/echo"), /repeated builtin/);
  assert.throws(() => configuration({builtins:["agents"],delegate:{maxParallel:3}},"test/echo"), /needs delegate/);
});

test("custom providers use the exact declaration and credential policy", async () => {
  const input = {type:"openai-completions",baseUrl:"https://example.com/v1/",models:[{id:"mine",contextWindow:32768}]};
  assert.equal(providerInput(input).baseUrl,"https://example.com/v1");
  assert.throws(() => providerName("openai"), /already a provider/);
  assert.throws(() => providerInput({...input,headers:{Authorization:"untrusted"}}), /cannot set/);
  assert.throws(() => providerInput({...input,models:[{id:"mine",contextWindow:32768,maxOutputTokens:40000}]}), /at most its context/);
  const env = {API_TOKEN:"disposable-unit-fixture",TEST_MODE:"1"} as never;
  const secret = await sealProviderSecret(env,"tenant:provider","test-value");
  assert.equal(await openProviderSecret(env,"tenant:provider",secret),"test-value");
  await assert.rejects(openProviderSecret(env,"another-tenant:provider",secret));
  await assert.rejects(sealProviderSecret({API_TOKEN:"not-test"} as never,"scope","x"), /not configured/);
});

test("structured output checks shapes while refusing unsafe schema input", () => {
  const output = outputInput({schema:{$schema:"https://json-schema.org/draft/2020-12/schema",type:"object",properties:{answer:{type:"string",pattern:"^(a+)+$"}},required:["answer"],additionalProperties:false}});
  assert.equal(output.schema.$schema,undefined);
  assert.equal(schemaAccepts(output.schema,{answer:"a".repeat(10000)+"!"}),true, "tenant regex is never run on a model answer");
  assert.equal(schemaAccepts(output.schema,{answer:1}),false);
  assert.equal(schemaAccepts(output.schema,{answer:"a",extra:1}),false);
  assert.throws(() => outputInput({schema:{type:"array"}}), /must describe an object/);
  assert.throws(() => outputInput({schema:{type:"object",properties:{answer:{type:"string",pattern:"("}}}}), /not a JSON Schema/);
});
test("OpenRouter pass-through and virtual routes use shared ECS policy", () => {
  const novel = resolveModel("openrouter/new-vendor/future-model");
  assert.equal(novel.id, "new-vendor/future-model");
  assert.equal(novel.api, "openai-responses");
  assert.equal(resolveModel("openrouter/anthropic/future-model").api, "anthropic-messages");
  const selection = resolveModel("camelrun/default");
  const first = routeModel(selection, { reason: "user" })!;
  const next = routeModel(selection, { reason: "retry", failed: { provider: first.provider, id: first.id } })!;
  assert.notEqual(first.id, next.id);
  assert.equal(routeModel(selection, { reason: "continuation", previous: { provider: next.provider, id: next.id } })?.id, next.id);
  assert.throws(() => resolveModel("unknown/model"), /Unknown model/);
  assert.deepEqual(callSettings({ ...novel, reasoning:false, maxTokens:1024 }, { maxOutputTokens:2048, temperature:0.3 }, "off"), {maxTokens:1024,temperature:0.3});
});

test("native Pi compaction sees the agent context cap without mutating the catalog", () => {
  const model = resolveModel("openrouter/new-vendor/future-model");
  assert.equal(boundedModel(model, 24000).contextWindow, 24000);
  assert.equal(boundedModel(model, model.contextWindow * 2).contextWindow, model.contextWindow);
  assert.equal(model.contextWindow, 128000);
});

test("agent configuration preserves platform mount markers and the shared mount limit", () => {
  assert.deepEqual(configuration({mounts:[{workspace:true,path:"/scratch"}]},"test/echo").config.mounts,[{workspace:true,path:"/scratch"}]);
  assert.deepEqual(configuration({mounts:[{workspace:false}]},"test/echo").config.mounts,[{workspace:false}]);
  assert.throws(() => configuration({mounts:[{workspace:false,path:"/scratch"}]},"test/echo"), /Invalid workspace/);
  assert.throws(() => configuration({mounts:[{workspace:true,volumeId:"other"}]},"test/echo"), /Invalid workspace/);
  assert.throws(() => configuration({mounts:Array.from({length:17},()=>({workspace:false}))},"test/echo"), /At most 16/);
  assert.throws(() => configuration({remount:"yes"},"test/echo"), /remount must be/);
});
