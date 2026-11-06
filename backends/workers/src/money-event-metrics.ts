// Generated from src/metrics.ts; source function bodies are unchanged.

// Run node backends/workers/scripts/reuse-money-metrics.mjs --check to check source drift.

import type { WebhookEvent } from "./webhook-policy.ts";

import { errorClass, metricLine } from "./metrics-policy.ts";

import { emitSourceMetric as emit } from "./money-metrics.ts";

const metricService = "workers";

export function recordEventMetrics(events: WebhookEvent[]) {
  const runs = new Map<string, Record<string, number>>();
  const failures = new Map<string, number>();
  const costs = new Map<string, { usd: number; events: number; input: number; cacheRead: number; cacheWrite: number; output: number }>();
  for (const event of events) {
    const data = event.data as any;
    if (event.type === "usage.recorded") {
      const key = JSON.stringify([event.tenant, String(data.provider ?? "unknown"), String(data.model ?? "unknown"), event.host ?? "unknown"]);
      const cost = costs.get(key) ?? { usd: 0, events: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      cost.usd += Number(data.cost?.usd) || 0;
      cost.events++;
      cost.input += Number(data.input) || 0;
      cost.cacheRead += Number(data.cacheRead) || 0;
      cost.cacheWrite += Number(data.cacheWrite) || 0;
      cost.output += Number(data.output) || 0;
      costs.set(key, cost);
      continue;
    }
    if (!event.type.startsWith("run.")) continue;
    const counts = runs.get(event.tenant) ?? {};
    const add = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
    if (event.type === "run.started") { add("RunsStarted"); if (data.resumes) add("RunsResumed"); }
    if (event.type === "run.completed") { add("RunsCompleted"); if (data.stopped === "input_required") add("RunsInputRequired"); if (data.stopped === "spend_limit") add("RunsSpendLimited"); if (data.stopped === "turn_limit") add("RunsTurnLimited"); }
    if (event.type === "run.failed") {
      add("RunsFailed");
      if (data.uncertain) add("RunsUncertain");
      const key = JSON.stringify([event.tenant, errorClass(String(data.error ?? "error"))]);
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
    runs.set(event.tenant, counts);
  }
  for (const [tenant, counts] of runs) {
    emit("run_events", { dimensions: { Tenant: tenant }, rollups: [[], ["Tenant"]], metrics: counts });
  }
  for (const [key, count] of failures) {
    const [tenant, error] = JSON.parse(key);
    emit("run_failed", { dimensions: { Tenant: tenant, ErrorClass: error }, rollups: [["ErrorClass"], ["Tenant", "ErrorClass"]], metrics: { RunsFailedByClass: count } });
  }
  for (const [key, cost] of costs) {
    const [tenant, provider, model, host] = JSON.parse(key);
    // Its tokens and the host that served them (OpenRouter's, else "unknown") are fields, not dimensions: counts and
    // names only, so $/1M and cache hits by host read from logs. inputTokens is uncached input, as Pi counts it.
    emit("model_cost", {
      dimensions: { Tenant: tenant, Provider: provider, Model: model }, rollups: [[], ["Tenant"], ["Provider", "Model"]],
      metrics: { ModelCostUsd: [Math.round(cost.usd * 1e6) / 1e6, "None"], ModelUsageEvents: cost.events },
      properties: { host, inputTokens: cost.input, cacheReadTokens: cost.cacheRead, cacheWriteTokens: cost.cacheWrite, outputTokens: cost.output },
    });
  }
}

export function deliveryLine(delivery: { kind: "endpoint" | "usage"; tenant: string; event: string; attempts: number; lagMs: number; error?: string }, service = metricService) {
  const { kind, tenant, event, attempts, lagMs, error } = delivery;
  const properties = { tenant, event, attempts, ...(error !== undefined ? { error } : {}) };
  return error !== undefined
    ? metricLine("webhook_failed", { dimensions: { Kind: kind }, rollups: [[], ["Kind"]], metrics: { WebhooksFailed: 1 }, properties }, service)
    : metricLine("webhook_delivered", {
      dimensions: { Kind: kind }, rollups: [[], ["Kind"]],
      metrics: { WebhooksDelivered: 1, WebhookDeliveryLagMs: [lagMs, "Milliseconds"], WebhookAttempts: attempts }, properties,
    }, service);
}

