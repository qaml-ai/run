import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";
import { otlpReceiver } from "./otlp-receiver.ts";

/** A runtime whose model answers with `respond`, and an Agents client for it. */
async function setup(t: { after(fn: () => Promise<void> | void): void }, respond: Parameters<typeof runtime>[1], env: Record<string, string> = {}) {
  const r = await runtime(t, respond, env);
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  /** An agent made over REST, then held by the simple API. */
  const make = async () => {
    const created = await r.call("/v1/agents", { body: { ttlSeconds: null } });
    assert.equal(created.status, 201, created.text);
    return agents.agent({ id: created.json.id, token: created.json.token, expiresAt: null }, {});
  };
  return { r, agents, make };
}

test("telemetry: set, get, test and clear through the SDK, header values never returned; a traceparent the SDK sends is the run's trace", async t => {
  const receiver = await otlpReceiver(t);
  const { r, agents, make } = await setup(t, () => ({ role: "assistant", content: "traced" }),
    { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TELEMETRY_INTERVAL_MS: "100" });
  const telemetry = agents.runtime.telemetry;
  assert.equal(await telemetry.get(), null, "none set");
  assert.deepEqual(await telemetry.clear(), { deleted: false });

  const set = await telemetry.set({ endpoint: receiver.url, headers: { "x-api-key": "otlp-sdk-secret-value" }, protocol: "http/json", sampleRate: 1, include: { content: false } });
  assert.deepEqual({ ...set, createdAt: 0, updatedAt: 0 }, {
    endpoint: `${receiver.url}/v1/traces`, protocol: "http/json", sampleRate: 1, include: { content: false }, headers: ["x-api-key"],
    createdAt: 0, updatedAt: 0, status: { lastExportAt: null, lastError: null, lastErrorAt: null },
  });
  const got = await telemetry.get();
  assert.deepEqual(got?.headers, ["x-api-key"]);
  assert.ok(!JSON.stringify([set, got]).includes("otlp-sdk-secret-value"), "header values are never returned");

  const tested = await telemetry.test();
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.match(tested.traceId, /^[0-9a-f]{32}$/);
  await until(() => receiver.spans.some(span => span.traceId === tested.traceId), "the test span");
  assert.equal(receiver.requests[0].headers["x-api-key"], "otlp-sdk-secret-value");

  // run(), stream() and the lower-level prompt() each send the caller's trace context.
  const agent = await make();
  const parent = (traceId: string) => `00-${traceId}-00f067aa0ba902b7-01`;
  const traced = [["a".repeat(31) + "1", (traceparent: string) => agent.run("hi", { traceparent })],
    ["b".repeat(31) + "2", (traceparent: string) => agent.stream("hi", { traceparent }).result()],
    ["c".repeat(31) + "3", async (traceparent: string) => { await agent.client.prompt("hi", { traceparent, idempotencyKey: "low-level-traced" }); return { id: "low-level-traced" }; }]] as const;
  for (const [traceId, send] of traced) {
    const run = await send(parent(traceId));
    const record = await agent.client.requestStatus(run.id);
    assert.deepEqual({ ...record.trace, spanId: "" }, { traceId, spanId: "", parentSpanId: "00f067aa0ba902b7", sampled: true }, `${traceId}: the record names the caller's trace`);
    await until(() => receiver.spans.some(span => span.traceId === traceId && span.name.startsWith("invoke_agent")), "the run's span in the caller's trace");
  }
  // A first prompt sent with the create continues the caller's trace too.
  const created = await agents.runtime.upsertAgent("traced-create", { prompt: { text: "hello", requestId: "first-traced" }, traceparent: parent("d".repeat(31) + "4") });
  assert.equal((created.prompt as { trace?: { traceId: string } }).trace?.traceId, "d".repeat(31) + "4");
  const untraced = await agent.run("hi");
  assert.notEqual((await agent.client.requestStatus(untraced.id)).trace?.traceId, undefined, "a run without one starts its own trace");

  assert.deepEqual(await telemetry.clear(), { deleted: true });
  assert.equal(await telemetry.get(), null);
  assert.equal((await agent.client.requestStatus((await agent.run("after")).id)).trace, undefined, "no trace once cleared");
  assert.ok(!r.logs.join("\n").includes("otlp-sdk-secret-value"), "header values never logged");
});
