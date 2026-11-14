import { EndUserCredits } from "../src/end-user-credits.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { meterProvider, applyModelReceipt } from "../src/model-metering.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import { RENEW_MS } from "../src/model-attempt-stream.ts";
import { postLedger } from "../src/billing.ts";
import { testDatabase } from "./billing-database.ts";
import { until } from "./billing-listen.ts";
import { withSettings } from "../src/model-settings.ts";
import { resolveModel } from "../src/model-policy.ts";
import { stream as completions, streamSimple as simpleCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses, streamSimple as simpleResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as messages, streamSimple as simpleMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Api, Model } from "@earendil-works/pi-ai";

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("metered fetch APIs preserve tenant gateway and custom provider routing", async t => {
  const { db, url } = await testDatabase();
  await db.query("insert into tenants(id,billing,created_at) values('meter-routing','prepaid',$1)", [Date.now()]);
  await postLedger(db, [{ tenant: "meter-routing", kind: "purchase", amount: 100_000_000, key: "routing-funding" }]);
  const env = { HYPERDRIVE: { connectionString: url }, AGENT_TENANTS_JSON: '{"tenants":{}}',
    // DNS is not part of this test; the final transport is intercepted below.
    AGENT_OUTBOUND_ALLOW_ORIGINS: "https://192.0.2.1,https://192.0.2.2",
  } as any;
  const protocols = [
    { api: "openai-completions", provider: "openai", root: "https://api.openai.com/v1", path: "/chat/completions", stream: completions, simple: simpleCompletions },
    { api: "openai-responses", provider: "openai", root: "https://api.openai.com/v1", path: "/responses", stream: responses, simple: simpleResponses },
    { api: "anthropic-messages", provider: "anthropic", root: "https://api.anthropic.com", path: "/v1/messages", stream: messages, simple: simpleMessages },
  ] as const;
  for (const protocol of protocols) for (const route of ["gateway", "custom", "openrouter"] as const) {
    for (const method of ["stream", "streamSimple"] as const) await t.test(`${protocol.api} ${route} ${method}`, async () => {
      const provider = route === "custom" ? "review-custom" : route === "openrouter" ? "openrouter" : protocol.provider;
      const baseUrl = route === "custom" ? "https://192.0.2.2/api" : "https://192.0.2.1/tenant/provider";
      // OpenRouter's Messages root is /api, while its provider root is /api/v1.
      // This catches accidental double rebasing, including the /v1 path segment.
      const root = route === "custom" ? baseUrl : route === "openrouter"
        ? protocol.api === "anthropic-messages" ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1"
        : protocol.root;
      const model = { id: "review-routing-fixture", name: "Routing fixture", provider, api: protocol.api, baseUrl: root,
        contextWindow: 32768, maxTokens: 128, reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
      const credential = { baseUrl, apiKey: "sk-routing-fixture-key", headers: { "x-tenant-route": "fixture" }, platform: false };
      let resolutions = 0;
      const customProviders = route === "custom" ? { [provider]: { type: protocol.api, baseUrl, models: [{ id: model.id, contextWindow: model.contextWindow }] } } : undefined;
      const selected = customProviders ? resolveModel(`${provider}/${model.id}`, undefined, customProviders) : model;
      const upstream = { id: provider, name: provider, getModels: () => [selected], auth: {},
        stream: protocol.stream, streamSimple: protocol.simple } as any;
      const metered = meterProvider(upstream, env,
        async () => ({ tenant: "meter-routing", agent: "routing-agent", platform: false }),
        receipt => applyModelReceipt(env, receipt).then(() => {}));
      const configured = withSettings(metered, {
        credentials: async () => { resolutions++; return credential; }, customProviders,
      }, env);
      const requests: { url: string; headers: Headers; body: any }[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        requests.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        // A terminal provider response is sufficient: the regression is where
        // the real protocol client sends its HTTP request through metering.
        return Response.json({ error: { message: "routing fixture response" } }, { status: 400 });
      };
      const output = configured[method](selected,
        { messages: [{ role: "user", content: "routing fixture", timestamp: Date.now() }] },
        { fetch: fetcher, maxTokens: 16 });
      const events = [];
      for await (const event of output) events.push(event);
      assert.equal(requests.length, 1);
      const sent = new URL(requests[0].url);
      const path = route === "openrouter" && protocol.api === "anthropic-messages" ? "/messages" : protocol.path;
      assert.equal(`${sent.origin}${sent.pathname}`, `${baseUrl}${path}`);
      assert.equal(requests[0].headers.get("x-tenant-route"), "fixture");
      assert.equal(requests[0].body.model, model.id);
      assert.equal(resolutions, 1, "metering keeps the credential resolved for this request");
      assert.equal(events.at(-1)?.type, "error");
      assert.match((events.at(-1) as any).error.errorMessage, /routing fixture response/);
    });
  }
  assert.equal(Number((await db.query("select count(*) from model_attempts where tenant='meter-routing'")).rows[0].count), 18);
});

test("model accounting serializes stream progress, heartbeat and terminal receipt", async t => {
  const { db, url } = await testDatabase();
  await db.query("insert into tenants(id,billing,created_at) values('meter-test','prepaid',$1)", [Date.now()]);
  await postLedger(db, [{ tenant: "meter-test", kind: "purchase", amount: 100_000_000, key: "meter-funding" }]);
  const env = { HYPERDRIVE: { connectionString: url }, AGENT_TENANTS_JSON: JSON.stringify({ tenants: {}, platformKeys: { openrouter: "fixture-key" } }) };
  const credits = new EndUserCredits(db);
  await credits.setSettings("meter-test", { enabled: true });
  await credits.post("meter-test", "person", { kind: "grant", amount: 100_000_000, key: "fund-person" });
  let heartbeat: (() => void) | undefined;
  t.mock.method(globalThis, "setInterval", (fn: () => void, delay: number) => {
    assert.equal(delay, RENEW_MS / 4);
    heartbeat = fn;
    return 0 as any;
  });
  const now = Date.now();
  let elapsed = 0;
  t.mock.method(Date, "now", () => now + elapsed);
  const original = ModelAttempts.prototype.event;
  let active = 0, maximum = 0, progress = 0, release: (() => void) | undefined;
  const firstProgress = new Promise<void>(resolve => { release = resolve; });
  const observed: string[] = [];
  t.mock.method(ModelAttempts.prototype, "event", async function (this: ModelAttempts, ...args: Parameters<ModelAttempts["event"]>) {
    active++; maximum = Math.max(maximum, active);
    observed.push(args[4].type);
    try {
      if (args[4].type === "progress" && ++progress === 1) await firstProgress;
      return await original.apply(this, args);
    } finally { active--; }
  });
  const source = createAssistantMessageEventStream();
  let started = false;
  let callOptions: any;
  const provider = { id: "openrouter", name: "fake", getModels: () => [],
    stream: (_model: unknown, _context: unknown, options: any) => { started = true; callOptions = options; return source; }, streamSimple: () => source } as any;
  const model = { id: "test-model", provider: "openrouter", api: "openai-completions", maxTokens: 8192,
    contextWindow: 32768,
    cost: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 } } as any;
  const metered = meterProvider(provider, env, async () => ({ tenant: "meter-test", agent: "agent-fixture", subject: "person", platform: true }), receipt => applyModelReceipt(env, receipt).then(() => {}));
  const output = metered.stream(model, { messages: [] }, { fetch: async () => new Response('{"id":"gen-serialized"}') });
  const done = (async () => { for await (const _event of output) { /* drain */ } })();
  await until(() => started && !!heartbeat, "model begin");
  elapsed = RENEW_MS;
  heartbeat!();
  await until(() => progress === 1, "renewal accounting");
  const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
    content: [{ type: "text", text: "x".repeat(8192) }], usage: { input: 1, output: 4096, cacheRead: 0, cacheWrite: 0, totalTokens: 4097,
      cost: { input: 0.000001, output: 0.04096, cacheRead: 0, cacheWrite: 0, total: 0.040961 } } } as any;
  source.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
  heartbeat!();
  const generation = callOptions.fetch('https://fake.invalid').then((response: Response) => response.text());
  await turn(); await turn();
  assert.equal(maximum, 1, "generation, heartbeat and chunks share the in-flight accounting write");
  release!();
  source.push({ type: "done", reason: "stop", message });
  await generation;
  await done;
  assert.equal(maximum, 1);
  assert.equal(observed.at(-1), "finish");
  assert.equal(progress, 1, "source coalesces heartbeat and chunk renewal");
  assert.ok(observed.includes("generation"));
  assert.equal(Number((await db.query("select count(*) from end_user_holds")).rows[0].count), 0);
});
