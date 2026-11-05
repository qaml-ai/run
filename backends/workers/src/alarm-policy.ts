/**
 * Workers alarm evaluation only: no timer, Analytics Engine query or notification
 * destination is installed here. Thresholds mirror Terraform; tests check drift.
 * The repository calls the metric alarm file observability.tf, not metrics.tf.
 */
export type AlarmState = 'firing' | 'ok' | 'insufficient';
type Selection = { metric: string; dimensions?: Record<string, string> };
type Signal =
  | { kind: 'stat'; select: Selection; statistic: 'Sum' | 'Maximum' | 'Minimum' | 'p90' }
  | { kind: 'sum'; select: Selection[] }
  | { kind: 'turn_failure_rate' }
  | { kind: 'top_tenant_spend' };
export type AlarmRule = {
  id: string; source: 'alarms.tf' | 'observability.tf';
  periodSeconds: number; periods: number; threshold: number;
  comparison: 'GreaterThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanThreshold';
  missing: 'notBreaching'; signal: Signal;
  /** Terraform may use a log-filter alias; the selector keeps src/metrics.ts names. */
  sourceMetric?: string;
  /** false means its source metric/dimensions are not instrumented on Workers. */
  wired: boolean; gap?: string;
};
const stat = (metric: string, statistic: 'Sum' | 'Maximum' | 'Minimum' | 'p90' = 'Sum', dimensions?: Record<string,string>): Signal => ({ kind: 'stat', select: { metric, ...(dimensions ? { dimensions } : {}) }, statistic });
const rule = (id: string, periodSeconds: number, periods: number, threshold: number, signal: Signal, gap?: string, source: AlarmRule['source'] = 'observability.tf', comparison: AlarmRule['comparison'] = 'GreaterThanOrEqualToThreshold'): AlarmRule => ({ id, source, periodSeconds, periods, threshold, signal, comparison, missing: 'notBreaching', wired: !gap, ...(gap ? { gap } : {}) });

/** These are policy defaults from Terraform, not deployed notification rules. */
export const PLATFORM_ALARMS: readonly AlarmRule[] = [
  rule('turn_failures', 900, 2, .4, { kind: 'turn_failure_rate' }, undefined, 'observability.tf', 'GreaterThanThreshold'),
  rule('model_rate_limited', 300, 1, 10, { kind: 'sum', select: [
    { metric: 'ModelErrors', dimensions: { ErrorClass: 'rate_limit' } },
    { metric: 'ModelErrors', dimensions: { ErrorClass: 'overloaded' } },
  ] }, 'ModelErrors by ErrorClass is not emitted by the Workers model loop'),
  rule('runs_uncertain', 300, 1, 1, stat('RunsUncertain'), 'Workers restart recovery does not emit RunsUncertain'),
  rule('model_reasoning_replay', 300, 1, 1, stat('ModelErrors', 'Sum', { ErrorClass: 'reasoning_replay' }), 'ModelErrors by ErrorClass is not emitted by the Workers model loop'),
  rule('first_token_slow', 300, 3, 60000, stat('TimeToFirstTokenMs', 'p90'), 'Workers turns do not emit TimeToFirstTokenMs', 'observability.tf', 'GreaterThanThreshold'),
  rule('webhook_lag', 300, 2, 600000, stat('WebhookOldestPendingMs', 'Maximum'), undefined, 'observability.tf', 'GreaterThanThreshold'),
  rule('model_spend', 3600, 1, 100, stat('ModelCostUsd'), 'Workers usage settlement does not emit ModelCostUsd', 'observability.tf', 'GreaterThanThreshold'),
  rule('tenant_model_spend', 3600, 1, 50, { kind: 'top_tenant_spend' }, 'Workers usage settlement does not emit ModelCostUsd with Tenant', 'observability.tf', 'GreaterThanThreshold'),
  rule('model_billing_errors', 900, 1, 2, stat('ModelBillingFailures', 'Sum', { KeyOwner: 'platform' }), 'Workers does not emit ModelBillingFailures by KeyOwner'),
  rule('database_pool_waiting', 60, 5, 0, stat('dbWaiting', 'Maximum'), 'Hyperdrive has no node-postgres pool waiting gauge', 'observability.tf', 'GreaterThanThreshold'),
  rule('quota_rejected', 300, 1, 1, stat('QuotaRejected'), 'Workers admission does not emit QuotaRejected', 'alarms.tf'),
  { ...rule('webhook_failed', 300, 2, 10, stat('WebhooksFailed'), 'Webhook delivery counts exist; the source alarm also requires webhook_scan_failed counts', 'alarms.tf'), sourceMetric: 'WebhookFailed' },
  rule('end_user_fallback', 300, 1, 1, stat('EndUserFallback'), 'Workers end-user pricing does not emit EndUserFallback', 'alarms.tf'),
  rule('model_usage_missing', 300, 1, 10, stat('ModelUsageMissing'), 'Workers model usage does not emit ModelUsageMissing', 'alarms.tf'),
];

/** These need external infrastructure signals, not invented Worker samples. */
export const EXTERNAL_PLATFORM_ALARMS = {
  alb_unhealthy_hosts: 'Workers has no Application Load Balancer targets',
  alb_5xx: 'Workers has no Application Load Balancer; edge 5xx monitoring is not configured',
  target_5xx: 'Workers HTTP 5xx monitoring is not configured',
  database_cpu_credits: 'RDS CPU credit data is outside Analytics Engine',
  database_memory: 'RDS free memory data is outside Analytics Engine',
  healthz: 'An external Workers health probe and notification destination are not configured',
} as const;

export type MetricPoint = { metric: string; value: number; dimensions?: Readonly<Record<string,string>> };
/** One complete query window; points are original observations, not duplicate metric rollups. */
export type MetricBucket = { start: number; periodSeconds: number; points: readonly MetricPoint[] };
export type AlarmEvaluation = { id: string; state: AlarmState; values: (number | null)[]; reason?: string };

function selected(points: readonly MetricPoint[], selection: Selection) {
  return points.filter(point => point.metric === selection.metric && Object.entries(selection.dimensions ?? {}).every(([name,value]) => point.dimensions?.[name] === value)).map(point => point.value);
}
const sum = (values: readonly number[]) => values.reduce((total,value) => total + value, 0);
function value(signal: Signal, points: readonly MetricPoint[]): number | undefined {
  if (signal.kind === 'sum') return sum(signal.select.flatMap(select => selected(points,select)));
  if (signal.kind === 'turn_failure_rate') {
    const total = sum(selected(points, { metric: 'Turns' }));
    return total >= 5 ? sum(selected(points, { metric: 'Turns', dimensions: { Outcome: 'failed' } })) / total : 0;
  }
  if (signal.kind === 'top_tenant_spend') {
    const totals = new Map<string,number>();
    for (const point of points) if (point.metric === 'ModelCostUsd' && point.dimensions?.Tenant) {
      totals.set(point.dimensions.Tenant, (totals.get(point.dimensions.Tenant) ?? 0) + point.value);
    }
    return totals.size ? [...totals.values()].reduce((largest,value) => Math.max(largest,value)) : undefined;
  }
  const samples = selected(points, signal.select);
  if (!samples.length) return undefined;
  if (signal.statistic === 'Sum') return sum(samples);
  if (signal.statistic === 'Maximum') return samples.reduce((largest,value) => Math.max(largest,value));
  if (signal.statistic === 'Minimum') return samples.reduce((smallest,value) => Math.min(smallest,value));
  // Query input must retain individual observations for percentile alarms.
  samples.sort((a,b) => a-b);
  return samples[Math.ceil(samples.length * .9) - 1];
}

/**
 * Evaluate the last complete windows. A supplied empty bucket is known no data
 * (Terraform's notBreaching); an absent bucket means the query/ingestion is not
 * known complete and cannot be called healthy. Missing instrumentation is never OK.
 */
export function evaluateAlarm(rule: AlarmRule, buckets: readonly MetricBucket[], now = Date.now()): AlarmEvaluation {
  const result = (state: AlarmState, values: (number|null)[], reason?: string): AlarmEvaluation => ({ id: rule.id, state, values, ...(reason ? { reason } : {}) });
  if (!rule.wired) return result('insufficient', [], rule.gap ?? 'Metric is not wired');
  const duration = rule.periodSeconds * 1000, end = Math.floor(now / duration) * duration;
  const values: (number|null)[] = [];
  for (let n = rule.periods; n > 0; n--) {
    const start = end - n * duration;
    const found = buckets.filter(bucket => bucket.start === start && bucket.periodSeconds === rule.periodSeconds);
    if (found.length !== 1) return result('insufficient', values, 'Missing or duplicate complete query bucket');
    const points = found[0].points;
    if (points.some(point => !Number.isFinite(point.value))) return result('insufficient', values, 'Non-finite metric observation');
    values.push(value(rule.signal, points) ?? null);
  }
  const breached = values.every(value => value !== null && (rule.comparison === 'GreaterThanThreshold' ? value > rule.threshold : rule.comparison === 'LessThanThreshold' ? value < rule.threshold : value >= rule.threshold));
  return result(breached ? 'firing' : 'ok', values);
}

export function evaluatePlatformAlarms(buckets: readonly MetricBucket[], now = Date.now()) {
  return PLATFORM_ALARMS.map(rule => evaluateAlarm(rule, buckets, now));
}
