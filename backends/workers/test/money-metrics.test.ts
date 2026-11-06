import assert from "node:assert/strict";
import test from "node:test";
import { creditRefused, deliveryLine, recordEventMetrics, withMoneyMetrics, writeMetricLine } from "../src/money-metrics.ts";

function fixture() {
  const points: any[] = [], logs: string[] = [];
  return { points, logs, env: { METRICS: { writeDataPoint: (point: unknown) => points.push(point) } as unknown as AnalyticsEngineDataset } };
}

test("source money event metrics reach structured logs and Analytics Engine", () => {
  const f = fixture(), log = console.log;
  console.log = line => f.logs.push(String(line));
  try {
    withMoneyMetrics(f.env, () => recordEventMetrics([
      { id: "start", type: "run.started", tenant: "metric-tenant", created: 1, data: { resumes: 1 } },
      { id: "complete", type: "run.completed", tenant: "metric-tenant", created: 2, data: { stopped: "input_required" } },
      { id: "failed", type: "run.failed", tenant: "metric-tenant", created: 3, data: { error: "timeout", uncertain: true } },
      { id: "usage", type: "usage.recorded", tenant: "metric-tenant", created: 4, host: "fixture", data: { provider: "fixture", model: "test/model", input: 3, output: 2, cost: { usd: 0.25 } } },
    ]));
  } finally { console.log = log; }
  const values = Object.fromEntries(f.points.map(point => [point.indexes[0], point.doubles[0]]));
  assert.equal(values.RunsStarted, 1);
  assert.equal(values.RunsResumed, 1);
  assert.equal(values.RunsCompleted, 1);
  assert.equal(values.RunsFailedByClass, 1);
  assert.equal(values.ModelCostUsd, 0.25);
  assert.equal(values.ModelUsageEvents, 1);
  assert.ok(f.points.every(point => point.blobs[7] === "metric-tenant"));
  assert.deepEqual(f.logs.map(line => JSON.parse(line).type), ["run_events", "run_failed", "model_cost"]);
});

test("concurrent financial work keeps its Analytics binding across awaits", async () => {
  const a = fixture(), b = fixture(), log = console.log;
  console.log = () => {};
  try {
    await Promise.all([
      withMoneyMetrics(a.env, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        writeMetricLine(deliveryLine({ kind: "usage", tenant: "a", event: "a", attempts: 1, lagMs: 10 }));
      }),
      withMoneyMetrics(b.env, async () => {
        await Promise.resolve();
        writeMetricLine(deliveryLine({ kind: "endpoint", tenant: "b", event: "b", attempts: 2, lagMs: 20 }));
      }),
    ]);
  } finally { console.log = log; }
  assert.equal(a.points.find(point => point.indexes[0] === "WebhookDeliveryLagMs").doubles[0], 10);
  assert.equal(b.points.find(point => point.indexes[0] === "WebhookDeliveryLagMs").doubles[0], 20);
  assert.equal(a.points.length, 3);
  assert.equal(b.points.length, 3);
});

test("delivery failures are private and credit refusals retain source structured logs", () => {
  const f = fixture(), log = console.log;
  console.log = line => f.logs.push(String(line));
  try {
    withMoneyMetrics(f.env, () => {
      writeMetricLine(deliveryLine({ kind: "endpoint", tenant: "a", event: "failed", attempts: 1, lagMs: 1, error: "network failure with private response text" }));
      creditRefused("metrics-credit-tenant", { reason: "limit" }, "model_call");
    });
  } finally { console.log = log; }
  assert.equal(f.points[0].indexes[0], "WebhooksFailed");
  assert.ok(!f.logs.join("\n").includes("private response text"));
  assert.equal(JSON.parse(f.logs[1]).type, "limit_hit");
  assert.equal(JSON.parse(f.logs[1]).limit, "END_USER_CREDIT");
});
