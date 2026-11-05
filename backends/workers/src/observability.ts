import { errorClass, safeError, metricLine } from './metrics-policy.ts';
export { errorClass, safeError };
export type MetricsEnv = { METRICS?: AnalyticsEngineDataset };
/** One point per metric: stable names/dimensions, never request bodies or raw errors. */
export function metric(env: MetricsEnv, type: string, values: Record<string, number | [number, 'Count' | 'Milliseconds' | 'Bytes' | 'None']>, dimensions: Record<string, string> = {}) {
  const metrics = Object.fromEntries(Object.entries(values).map(([name,value]) => [name, typeof value === 'number' && name.endsWith('Ms') ? [value,'Milliseconds'] as [number,'Milliseconds'] : value]));
  console.log(metricLine(type, { dimensions, rollups: [[]], metrics }, 'workers'));
  for (const [name, value] of Object.entries(values)) {
    env.METRICS?.writeDataPoint({ indexes: [name], blobs: [name, type, dimensions.Outcome ?? '', dimensions.ErrorClass ?? '', dimensions.Provider ?? '', dimensions.Model ?? '', dimensions.Kind ?? ''], doubles: [Array.isArray(value) ? value[0] : value] });
  }
}
export function failure(env: MetricsEnv, type: string, error: unknown) {
  console.error(JSON.stringify({ type, error: safeError(error) }));
  metric(env, type, { PlatformFailures: 1 }, { ErrorClass: errorClass(error instanceof Error ? error.message : '') });
}
