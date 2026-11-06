import { AsyncLocalStorage } from "node:async_hooks";
import { metricLine, safeError } from "./metrics-policy.ts";
import type { MetricsEnv } from "./observability.ts";
export { recordEventMetrics, deliveryLine } from "./money-event-metrics.ts";
export { creditRefused } from "./money-limit-metrics.ts";

const context = new AsyncLocalStorage<MetricsEnv>();

/** Call at Worker/DO entry points. Awaited and detached continuations retain the
 * originating binding without sharing one request's environment with another. */
export function withMoneyMetrics<T>(env: MetricsEnv, action: () => T): T {
  return context.run(env, action);
}

export function emitSourceMetric(type: string, line: Parameters<typeof metricLine>[1]) {
  writeMetricLine(metricLine(type, line, "workers"));
}

/** Keep source metric names and structured logs, then publish the same values to
 * Analytics Engine. The first seven blob positions match observability.ts;
 * Tenant is appended for source money metrics that have that dimension. */
export function writeMetricLine(line: string) {
  let value: Record<string, any>;
  try { value = JSON.parse(line); }
  catch { console.log(line); return; }
  // Delivery failures can include a provider's raw error. The log gets the same
  // bounded class/facts as other Workers failures, never that provider text.
  if (value.error !== undefined) value.error = safeError(value.error);
  console.log(JSON.stringify(value));
  const dataset = context.getStore()?.METRICS;
  if (!dataset) return;
  const names = new Set<string>();
  for (const group of value._aws?.CloudWatchMetrics ?? [])
    for (const metric of group.Metrics ?? [])
      if (typeof metric.Name === "string") names.add(metric.Name);
  for (const name of names) {
    if (typeof value[name] !== "number" || !Number.isFinite(value[name])) continue;
    try {
      dataset.writeDataPoint({
        indexes: [name],
        blobs: [name, value.type ?? "", value.Outcome ?? "", value.ErrorClass ?? "", value.Provider ?? "", value.Model ?? "", value.Kind ?? "", value.Tenant ?? ""],
        doubles: [value[name]],
      });
    } catch (error) {
      // Observability must not roll back an already-written financial event.
      console.error(JSON.stringify({ type: "metric_write_failed", metric: name, error: safeError(error) }));
    }
  }
}
