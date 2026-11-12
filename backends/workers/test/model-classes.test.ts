import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { resolveModel, routeModel, virtualChain, virtualModelReferences } from "../src/model-policy.ts";
import { getModel, getModels, tierCost, withOpenRouterHosts } from "../src/model-catalog.ts";
import { listModels } from "../src/catalog-policy.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { withSettings } from "../src/model-settings.ts";
import { FlexWait, flexFallbackDeltaUsd, flexWaitMs } from "../src/model-flex-wait.ts";
import { callFetch } from "../src/model-call-fetch.ts";
import { servedTier } from "../src/model-attempt-stream.ts";
import { usageEvent } from "../src/webhook-policy.ts";
import type { ModelRetryEvent } from "../src/model-replay-retry.ts";

const CARBON = "google/gemini-4-carbon", EMBER = "meta/muse-ember", FLASH = "deepseek/deepseek-v4.1-flash-1017";
const tier = (model: Model<Api> | undefined) => (model as { serviceTier?: string } | undefined)?.serviceTier;
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

const priced = (usage: Record<string, unknown>, id: string) => (platformUsage(usage, "openrouter", id).usage as { cost: { total: number } }).cost.total;
test("camelrun/fast and camelrun/strong are virtual models; camelrun/default is as it was", () => {
  assert.deepEqual(virtualModelReferences(), ["camelrun/default", "camelrun/fast", "camelrun/strong"]);
  // default: the same two members, with no service tier on either (nothing new is sent for them).
  const defaults = virtualChain("camelrun/default")!;
  assert.deepEqual(defaults.map(model => `${model.provider}/${model.id}`), [`openrouter/${EMBER}`, `openrouter/${FLASH}`]);
  assert.ok(defaults.every(model => !Object.hasOwn(model, "serviceTier")));
  assert.deepEqual(virtualChain("camelrun/fast")!.map(model => [`${model.provider}/${model.id}`, tier(model)]), [[`openrouter/${EMBER}`, undefined]]);
  assert.deepEqual(virtualChain("camelrun/strong")!.map(model => [`${model.provider}/${model.id}`, tier(model)]), [[`openrouter/${CARBON}`, "flex"], [`openrouter/${CARBON}`, "default"]]);
  const strong = resolveModel("camelrun/strong");
  assert.deepEqual([strong.provider, strong.id, (strong as { virtual?: string }).virtual, tier(strong)], ["openrouter", CARBON, "camelrun/strong", "flex"]);
  assert.equal(strong.api, "openai-responses", "Gemini on OpenRouter's Responses API, as every non-Anthropic, non-DeepSeek model");
  assert.equal(strong.maxTokens, 65_536, "room for high-effort reasoning; Vertex's US and EU endpoints serve it");
  const listed = listModels("camelrun");
  assert.deepEqual(listed.map(model => [model.id, model.routes, model.serviceTiers]), [
    ["camelrun/default", [`openrouter/${EMBER}`, `openrouter/${FLASH}`], undefined],
    ["camelrun/fast", [`openrouter/${EMBER}`], undefined],
    ["camelrun/strong", [`openrouter/${CARBON}`, `openrouter/${CARBON}`], ["flex", "default"]],
  ]);
});

test("strong routes: flex first, the default tier after a flex failure, sticky for the turn", () => {
  const strong = resolveModel("camelrun/strong");
  const [flex, standard] = virtualChain("camelrun/strong")!;
  assert.equal(tier(routeModel(strong, { reason: "user" })), "flex");
  assert.equal(tier(routeModel(strong, { reason: "retry", failed: flex })), "default");
  assert.equal(routeModel(strong, { reason: "retry", failed: standard }), undefined, "the default tier failing ends the chain");
  assert.equal(tier(routeModel(strong, { reason: "continuation", previous: standard })), "default", "the rest of the turn stays on the default tier");
  assert.equal(tier(routeModel(strong, { reason: "user", previous: standard })), "flex", "the next message tries flex again");
  // An assistant message names no tier: it is the first member of that model (Node's fallback path).
  assert.equal(tier(routeModel(strong, { reason: "retry", failed: { provider: "openrouter", model: CARBON } })), "default");
  // camelrun/default routes exactly as before.
  const alias = resolveModel("camelrun/default");
  assert.equal(routeModel(alias, { reason: "retry", failed: { provider: "openrouter", id: EMBER } })?.id, FLASH);
  assert.equal(routeModel(alias, { reason: "continuation", previous: { provider: "openrouter", model: FLASH } })?.id, FLASH);
});

test("only a member with a service tier sends service_tier; every other OpenRouter payload is unchanged", () => {
  const payload = { model: "x", input: [] };
  for (const model of [...getModels("openrouter"), ...virtualChain("camelrun/default")!, ...virtualChain("camelrun/fast")!]) {
    const sent = withOpenRouterHosts(model, { ...payload, model: model.id }) as Record<string, unknown>;
    assert.ok(!("service_tier" in sent), `${model.id} sends no service_tier`);
    assert.deepEqual(withOpenRouterHosts(model, { ...payload, model: model.id }, "deny"), withOpenRouterHosts({ ...model }, { ...payload, model: model.id }, "deny"));
  }
  // Without filters a payload for any other model is the same object (nothing added).
  const ember = getModel("openrouter", EMBER)!;
  const same = { model: EMBER };
  assert.equal(withOpenRouterHosts(ember, same), same);
  const [flex, standard] = virtualChain("camelrun/strong")!;
  assert.deepEqual(withOpenRouterHosts(flex, { model: CARBON }), { model: CARBON, service_tier: "flex" });
  assert.deepEqual(withOpenRouterHosts(standard, { model: CARBON }), { model: CARBON, service_tier: "default" });
  // With a data policy: the filter and the tier, never order, sort or a :floor variant.
  const denied = withOpenRouterHosts(flex, { model: CARBON }, "deny") as Record<string, any>;
  assert.deepEqual(denied, { model: CARBON, provider: { data_collection: "deny" }, service_tier: "flex" });
  assert.ok(!("order" in denied.provider) && !("sort" in denied.provider));
});

test("a response is priced at the tier that served it; other models ignore serviceTier", () => {
  assert.deepEqual(tierCost("openrouter", CARBON, "flex"), { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0.09375 });
  assert.equal(tierCost("openrouter", CARBON, "default"), undefined);
  assert.equal(tierCost("openrouter", EMBER, "flex"), undefined);
  assert.equal(tierCost("anthropic", CARBON, "flex"), undefined);
  assert.deepEqual(getModel("openrouter", CARBON)!.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0.1875 });
  const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
  assert.equal(priced({ ...tokens, serviceTier: "flex" }, CARBON), 6.05);
  assert.equal(priced({ ...tokens, serviceTier: "default" }, CARBON), 12.1);
  assert.equal(priced(tokens, CARBON), 12.1, "no tier said: the default tier's price");
  const ember = priced(tokens, EMBER);
  assert.equal(priced({ ...tokens, serviceTier: "flex" }, EMBER), ember);
  assert.equal(flexFallbackDeltaUsd(getModel("openrouter", CARBON)!, { ...usage(), ...tokens, serviceTier: "default" } as never), 6.05);
  assert.equal(flexFallbackDeltaUsd(getModel("openrouter", EMBER)!, { ...usage(), ...tokens } as never), undefined);
});

test("the served tier is read from the response, recorded on usage and priced", async () => {
  for (const line of [
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "gen-1", service_tier: "flex", usage: { cost: 0.01 } } })}`,
    `data: ${JSON.stringify({ id: "gen-1", service_tier: "flex", choices: [] })}`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { service_tier: "standard" } })}`,
  ]) {
    const sink: { serviceTier?: string } = {};
    const fetcher = callFetch(sink, { base: async () => new Response(`${line}\n\n`, { status: 200 }) });
    await (await fetcher("https://openrouter.ai/api/v1/responses", {})).text();
    assert.equal(sink.serviceTier, line.includes("standard") ? "default" : "flex", line);
  }
  const [flex] = virtualChain("camelrun/strong")!;
  const message = { role: "assistant", content: [], usage: { ...usage(), input: 1_000_000, output: 1_000_000 } } as unknown as AssistantMessage;
  servedTier(flex, message, "flex");
  assert.equal((message.usage as any).requestedServiceTier, "flex");
  assert.equal((message.usage as any).serviceTier, "flex");
  assert.equal(message.usage.cost.total, 6);
  const fellBack = { role: "assistant", content: [], usage: { ...usage(), input: 1_000_000, cost: { ...usage().cost, total: 2, input: 2 } } } as unknown as AssistantMessage;
  servedTier(flex, fellBack, "default");
  assert.equal(fellBack.usage.cost.total, 2, "the default tier keeps the model's own price");
  const ember = { role: "assistant", content: [], usage: usage() } as unknown as AssistantMessage;
  servedTier(getModel("openrouter", EMBER)!, ember, undefined);
  assert.deepEqual(ember.usage, usage(), "a call that asked no tier and heard none is untouched");
  const event = usageEvent("t", "a", { provider: "openrouter", model: CARBON, kind: "response", usage: { input: 1, serviceTier: "flex" } } as never)!;
  assert.equal(event.data.serviceTier, "flex");
  assert.ok(!("serviceTier" in usageEvent("t", "a", { provider: "openrouter", model: EMBER, kind: "response", usage: { input: 1 } } as never)!.data));
});

test("flex wait: backs off within its window, then says it is spent", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const events: ModelRetryEvent[] = [];
  const wait = new FlexWait(20_000, event => { events.push(event); }, () => now, () => 1);
  const error = { role: "assistant", content: [], stopReason: "error", provider: "openrouter", model: CARBON, errorMessage: "429 Resource exhausted: flex capacity" } as unknown as AssistantMessage;
  for (const delay of [2_000, 4_000, 8_000, 6_000]) {
    const decision = wait.retry(error);
    await Promise.resolve();
    t.mock.timers.tick(delay);
    now += delay;
    assert.equal(await decision, true);
  }
  assert.equal(await wait.retry(error), false, "the 20 s window is spent");
  assert.deepEqual(events.filter(event => event.type === "auto_retry_start").map(event => (event as { delayMs: number }).delayMs), [2_000, 4_000, 8_000, 6_000]);
  assert.deepEqual(events.at(-1), { type: "auto_retry_end", success: false, attempt: 4, finalError: error.errorMessage, failure: { errorClass: "rate_limit", providerStatus: 429, retryable: true, model: `openrouter/${CARBON}` } });
  assert.equal(flexWaitMs({}), 30_000);
  assert.equal(flexWaitMs({ AGENT_FLEX_WAIT_SECONDS: "180" }), 180_000);
  assert.equal(flexWaitMs({ AGENT_FLEX_WAIT_SECONDS: "180" }, 600), 600_000, "a request's own wait wins (a workflow's)");
  assert.equal(flexWaitMs({ AGENT_FLEX_WAIT_SECONDS: "nonsense" }), 30_000);
  assert.equal(flexWaitMs({}, 0), 0);
});

/** A provider that answers each call from `script` (an error message, or text), recording what it was asked. */
type Step = string | { error: string };
function scriptedProvider(script: Step[] | ((model: Model<Api>) => Step)) {
  const calls: { model: string; tier?: string; payload: Record<string, unknown>; context: any }[] = [];
  const stream = (model: Model<Api>, context: unknown, options: any) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const payload = await options.onPayload?.({ model: model.id, input: [] }, model) as Record<string, unknown>;
      calls.push({ model: model.id, tier: tier(model), payload, context });
      const step = typeof script === "function" ? script(model) : script.shift() ?? "unscripted";
      const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: { ...usage(), input: 1_000_000, output: 1_000_000 }, timestamp: Date.now() } as AssistantMessage;
      if (step === "LENGTH") {
        const message = { ...base, content: [{ type: "thinking", thinking: "" }], stopReason: "length" } as AssistantMessage;
        output.push({ type: "done", reason: "length", message } as never); output.end(message);
      } else if (typeof step === "object") {
        const error = { ...base, content: [], stopReason: "error", errorMessage: step.error } as AssistantMessage;
        output.push({ type: "error", reason: "error", error }); output.end(error);
      } else {
        const message = { ...base, content: [{ type: "text", text: step }], stopReason: "stop" } as AssistantMessage;
        output.push({ type: "done", reason: "stop", message }); output.end(message);
      }
    })();
    return output;
  };
  return { calls, provider: { stream, streamSimple: stream } as any };
}

async function call(model: string, script: Step[] | ((model: Model<Api>) => Step), settings: Record<string, unknown> = {}, env: Record<string, string> = {}, history: unknown[] = []) {
  const { calls, provider } = scriptedProvider(script);
  const retries: ModelRetryEvent[] = [];
  const configured = withSettings(provider, {
    settings: async () => ({ model, ...settings }) as never, credentials: async () => ({ apiKey: "fixture" }), onRetryEvent: event => { retries.push(event); },
  }, env as never);
  const events = [];
  for await (const event of configured.stream(resolveModel(model), { messages: [{ role: "user", content: "hi", timestamp: 1 }, ...history] } as never, {})) events.push(event);
  return { calls, retries, last: events.at(-1) as any };
}

test("strong asks flex, waits for flex capacity within its window, then the default tier takes the call", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  // Flex answers at once.
  let run = await call("camelrun/strong", ["on flex"]);
  assert.deepEqual(run.calls.map(c => [c.model, c.tier, c.payload.service_tier]), [[CARBON, "flex", "flex"]]);
  assert.equal(run.last.type, "done");
  // Flex full once, then answers: asked again on flex, no fallback.
  run = await call("camelrun/strong", [{ error: "429 Resource has been exhausted (flex)" }, "on flex"], { flexWaitSeconds: 0.05 });
  assert.deepEqual(run.calls.map(c => c.payload.service_tier), ["flex", "flex"]);
  assert.equal(run.last.type, "done");
  assert.deepEqual(run.retries.map(event => event.type), ["auto_retry_start", "auto_retry_end"]);
  assert.ok(!logs.some(line => line.includes("model_flex_fallback")));
  // Flex full through the window: the default tier answers, and the move is logged with its cost over flex.
  run = await call("camelrun/strong", model => tier(model) === "flex" ? { error: "503 flex capacity unavailable" } : "on default", { flexWaitSeconds: 0.05 });
  assert.equal(run.calls.at(-1)!.payload.service_tier, "default");
  assert.ok(run.calls.slice(0, -1).every(c => c.payload.service_tier === "flex") && run.calls.length >= 2);
  assert.equal(run.last.type, "done");
  assert.equal(run.last.message.content[0].text, "on default");
  const fallback = JSON.parse(logs.find(line => line.includes('"model_flex_fallback"'))!);
  assert.equal(fallback.to, `openrouter/${CARBON}`);
  assert.equal(fallback.toTier, "default");
  const cost = JSON.parse(logs.find(line => line.includes('"model_flex_fallback_cost"'))!);
  assert.equal(cost.deltaUsd, 6, "1M in and 1M out at $2/$10 against $1/$5");
  // A refusal flex would give anywhere (a bad request) neither waits nor moves.
  run = await call("camelrun/strong", [{ error: "400 Invalid request: bad tool schema" }], { flexWaitSeconds: 5 });
  assert.equal(run.calls.length, 1);
  assert.equal(run.last.type, "error");
  assert.equal(run.retries.length, 0);
  // A wait of 0 moves at once.
  run = await call("camelrun/strong", [{ error: "429 flex" }, "on default"], { flexWaitSeconds: 0 });
  assert.deepEqual(run.calls.map(c => c.payload.service_tier), ["flex", "default"]);
});

test("every other model's calls are unchanged: no service_tier, no flex wait", async () => {
  for (const model of ["camelrun/default", "camelrun/fast", `openrouter/${EMBER}`, `openrouter/${FLASH}`, `openrouter/${CARBON}`]) {
    const run = await call(model, ["ok"]);
    assert.equal(run.calls.length, 1, model);
    assert.ok(!("service_tier" in run.calls[0].payload), `${model} sends no service_tier`);
    assert.equal(run.last.type, "done");
  }
  // camelrun/default still moves to its next member at once on a 429, with no wait.
  const started = Date.now();
  const run = await call("camelrun/default", [{ error: "429 Rate limit exceeded" }, "ok"], {}, { AGENT_FLEX_WAIT_SECONDS: "60" });
  assert.deepEqual(run.calls.map(c => c.model), [EMBER, FLASH]);
  assert.equal(run.retries.length, 0);
  assert.ok(Date.now() - started < 1_000);
  // A real model named directly with a tier-less 429 ends the call as before.
  const real = await call(`openrouter/${CARBON}`, [{ error: "429 Rate limit exceeded" }]);
  assert.equal(real.calls.length, 1);
  assert.equal(real.last.type, "error");
});

test("flex asked and not served is logged once as model_flex_unhonored; flex served, errors and the default tier are not", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const [flex, standard] = virtualChain("camelrun/strong")!;
  const reply = (stopReason = "stop") => ({ role: "assistant", content: [], stopReason, usage: usage() } as unknown as AssistantMessage);
  const ignored = reply();
  servedTier(flex, ignored, "default");
  servedTier(flex, ignored, "default");
  servedTier(flex, reply(), undefined);
  servedTier(flex, reply(), "flex");
  servedTier(flex, reply("error"), "default");
  servedTier(standard, reply(), "default");
  servedTier(getModel("openrouter", EMBER)!, reply(), "default");
  const unhonored = logs.filter(line => line.includes("model_flex_unhonored")).map(line => JSON.parse(line));
  assert.deepEqual(unhonored, [
    { type: "model_flex_unhonored", provider: "openrouter", model: CARBON, servedTier: "default" },
    { type: "model_flex_unhonored", provider: "openrouter", model: CARBON, servedTier: null },
  ]);
});

test("every member failing: the request fails with the last member's own error, the log names each member's, and Pi's retry starts at the head again", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const { calls, provider } = scriptedProvider(model => tier(model) === "flex" ? { error: "503 flex capacity unavailable" } : { error: "502 Provider returned error: upstream reset" });
  const configured = withSettings(provider, { settings: async () => ({ model: "camelrun/strong", flexWaitSeconds: 0 }) as never, credentials: async () => ({ apiKey: "fixture" }) }, {} as never);
  const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never;
  const ask = async () => { let last: any; for await (const event of configured.stream(resolveModel("camelrun/strong"), context, {})) last = event; return last; };
  const first = await ask();
  assert.equal(first.type, "error");
  assert.equal(first.error.errorMessage, "502 Provider returned error: upstream reset", "the last member's error, never a bare 'exhausted'");
  const failed = JSON.parse(logs.find(line => line.includes('"virtual_model_chain_failed"'))!);
  assert.deepEqual(failed.failures, [
    { member: `openrouter/${CARBON} (flex)`, error: "503 flex capacity unavailable" },
    { member: `openrouter/${CARBON} (default)`, error: "502 Provider returned error: upstream reset" },
  ]);
  // Pi retries the request (its backoff, its bound): the chain starts again at flex rather than refusing.
  const again = await ask();
  assert.equal(again.type, "error");
  assert.deepEqual(calls.map(c => c.tier), ["flex", "default", "flex", "default"]);
  assert.ok(logs.some(line => line.includes('"virtual_model_chain_restart"')));
  // camelrun/default: the same, its members by name.
  logs.splice(0);
  const plain = scriptedProvider(() => ({ error: "429 Rate limit exceeded" }));
  const aliased = withSettings(plain.provider, { settings: async () => ({ model: "camelrun/default" }) as never, credentials: async () => ({ apiKey: "fixture" }) }, {} as never);
  for await (const _ of aliased.stream(resolveModel("camelrun/default"), context, {})) { /* drain */ }
  assert.deepEqual(JSON.parse(logs.find(line => line.includes('"virtual_model_chain_failed"'))!).failures.map((f: { member: string }) => f.member), [`openrouter/${EMBER}`, `openrouter/${FLASH}`]);
});

test("an answer cut off at its output limit is passed through as truncated (stop: length), logged, and never walks the chain", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const run = await call("camelrun/strong", ["LENGTH"]);
  assert.equal(run.last.type, "done");
  assert.equal(run.last.message.stopReason, "length");
  assert.deepEqual(run.calls.map(c => c.tier), ["flex"], "the default tier is not asked: it has the same limit");
  const cut = JSON.parse(logs.find(line => line.includes('"model_output_cut"'))!);
  assert.deepEqual([cut.model, cut.maxTokens, cut.answered], [`openrouter/${CARBON}`, 65_536, false]);
  assert.ok(!logs.some(line => line.includes("virtual_model_chain")));
});

test("Gemini refusing reasoning another provider produced: the same member again, once, without the history's encrypted reasoning; the chain goes on", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const REFUSED = { error: "openrouter API error (400): Provider returned error: Gemini models require OpenRouter reasoning details to be preserved in each request." };
  // A turn flex served: a signed thought and a tool call with its own signature, and its result.
  const history = [
    { role: "assistant", api: "openai-completions", provider: "openrouter", model: "google/gemini-4-carbon", stopReason: "toolUse", timestamp: 2, usage: usage(),
      content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify([{ type: "reasoning.encrypted", data: "AI-STUDIO" }]) },
        { type: "thinking", thinking: "look at a.go", thinkingSignature: "sig" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.go" }, thoughtSignature: "ts" }] },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "package main" }], isError: false, timestamp: 3 },
  ];
  // Flex down (the eval's stall), the default tier refuses the replay, then answers without it.
  const run = await call("camelrun/strong", [{ error: "Model stream stalled: sent nothing for 45s mid-response (timed out)" }, REFUSED, "read it"], {}, { AGENT_FLEX_WAIT_SECONDS: "0" }, history);
  assert.equal(run.last.type, "done", JSON.stringify(run.last));
  assert.deepEqual(run.calls.map(entry => entry.tier), ["flex", "default", "default"]);
  const assistant = (entry: (typeof run.calls)[number]) => entry.context.messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant(run.calls[1]!).content.length, 3, "the first default call carried the signed history");
  const stripped = assistant(run.calls[2]!).content;
  assert.deepEqual(stripped, [{ type: "thinking", thinking: "look at a.go" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.go" } }], "signatures gone, the thought's text and the call kept");
  assert.ok(logs.some(line => line.includes('"model_reasoning_replay_dropped"')));
  // The same agent's later calls drop it up front: no refused request first.
  {
    const { calls, provider } = scriptedProvider(["first answer after a refusal", "second answer"]);
    const scripted = [REFUSED.error];
    const refusing = { ...provider, stream: (model: Model<Api>, context: unknown, options: any) => {
      if (scripted.length) {
        const output = createAssistantMessageEventStream();
        const error = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: usage(), timestamp: Date.now(), content: [], stopReason: "error", errorMessage: scripted.shift() } as AssistantMessage;
        queueMicrotask(() => { output.push({ type: "error", reason: "error", error }); output.end(error); });
        return output;
      }
      return provider.stream(model, context, options);
    } };
    const configured = withSettings({ ...refusing, streamSimple: refusing.stream } as never, { settings: async () => ({ model: "openrouter/google/gemini-4-carbon" }) as never, credentials: async () => ({ apiKey: "fixture" }) }, {} as never);
    const ask = async () => { const events = []; for await (const event of configured.stream(resolveModel("openrouter/google/gemini-4-carbon"), { messages: [{ role: "user", content: "hi", timestamp: 1 }, ...history] } as never, {})) events.push(event); return events.at(-1) as any; };
    assert.equal((await ask()).type, "done");
    assert.equal((await ask()).type, "done");
    assert.equal(calls.length, 2, "the refusal, then one call each");
    for (const entry of calls) assert.ok(entry.context.messages.find((message: any) => message.role === "assistant").content.every((block: any) => !block.thinkingSignature && !block.thoughtSignature));
    assert.equal(logs.filter(line => line.includes('"model_reasoning_replay_dropped"')).length, 2, "the first call's drop above, and this agent's one; none for its second call");
  }
  // Refused again after the drop: a failure of the member like any other, never a loop.
  const twice = await call("camelrun/strong", [REFUSED, REFUSED, REFUSED, REFUSED], {}, { AGENT_FLEX_WAIT_SECONDS: "0" }, history);
  assert.equal(twice.last.type, "error");
  assert.ok(twice.calls.length <= 4, JSON.stringify(twice.calls.map(entry => entry.tier)));
});
