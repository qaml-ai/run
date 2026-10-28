import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AgentRuntime } from "../clients/typescript.ts";
import { cluster, fakeModel, token, until } from "./cluster-helpers.ts";
import { otlpReceiver } from "./otlp-receiver.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TELEMETRY_INTERVAL_MS: "100" };

test("a run handed to another node keeps its trace: each node exports the spans it made, the run's span once, under the same ids", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const receiver = await otlpReceiver(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "resumed after the drain" });
  const a = await c.start("a", { ...model.env, ...LOCAL, AGENT_DRAIN_TIMEOUT_MS: "500" });
  const b = await c.start("b", { ...model.env, ...LOCAL });
  const set = await fetch(`${a.url}/v1/telemetry`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: receiver.endpoint, protocol: "http/json" }) });
  assert.equal(set.status, 200, await set.text());

  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "traced-handoff" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("think for a long time", { idempotencyKey: "turn-1", timeoutMs: 60_000 });
  await until(() => model.bodies.length === 1, "A called the model");
  assert.equal(await c.owner(created.session.id), a.url);

  a.child.kill("SIGTERM");
  assert.equal((await once(a.child, "exit"))[0], 0);
  assert.equal((await run).reply, "resumed after the drain");
  assert.equal(await c.owner(created.session.id), b.url);

  const state = await (await fetch(`${b.url}/v1/agents/${created.session.id}/requests/turn-1`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const trace = state.trace;
  assert.ok(trace?.sampled, JSON.stringify(state));
  await until(() => receiver.spans.some(span => span.spanId === trace.spanId), "the run's span, from B");
  const root = receiver.spans.find(span => span.spanId === trace.spanId)!;
  const spans = receiver.spans.filter(span => span.traceId === trace.traceId);
  assert.equal(spans.filter(span => span.spanId === trace.spanId).length, 1, "the run's span is exported once");
  assert.equal(root.attributes["camelrun.run.status"], "completed");
  assert.ok(Number(root.attributes["camelrun.run.resumes"]) >= 1, "it says it was resumed");
  // A's model call was cut off by its drain: exported by A as it shut down, under the same run span.
  const interrupted = spans.find(span => span.name.startsWith("chat") && span.attributes["error.type"] === "interrupted");
  assert.ok(interrupted, `A's interrupted model call: ${JSON.stringify(spans.map(span => span.name))}`);
  assert.equal(interrupted.parentSpanId, trace.spanId);
  // B's model call, which answered.
  const answered = spans.find(span => span.name.startsWith("chat") && span.attributes["gen_ai.response.finish_reasons"]);
  assert.ok(answered);
  assert.equal(answered.parentSpanId, trace.spanId);
  assert.ok(interrupted.start < answered.start);
});
