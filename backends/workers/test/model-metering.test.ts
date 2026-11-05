import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { meterProvider, applyModelReceipt } from "../src/model-metering.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import { RENEW_MS } from "../src/model-attempt-stream.ts";
import { postLedger } from "../src/billing.ts";
import { testDatabase } from "./billing-database.ts";
import { until } from "./billing-listen.ts";

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
test("model accounting serializes stream progress, heartbeat and terminal receipt", async t => {
  const { db, url } = await testDatabase();
  await db.query("insert into tenants(id,billing,created_at) values('meter-test','prepaid',$1)", [Date.now()]);
  await postLedger(db, [{ tenant: "meter-test", kind: "purchase", amount: 100_000_000, key: "meter-funding" }]);
  const env = { HYPERDRIVE: { connectionString: url }, AGENT_TENANTS_JSON: JSON.stringify({ tenants: {}, platformKeys: { openrouter: "fixture-key" } }) };
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
  const metered = meterProvider(provider, env, async () => ({ tenant: "meter-test", agent: "agent-fixture", platform: true }), receipt => applyModelReceipt(env, receipt).then(() => {}));
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
  assert.equal(Number((await db.query("select count(*) from credit_holds")).rows[0].count), 0);
});
