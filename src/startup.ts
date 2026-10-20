/** Startup timings contain stage names and durations only: never configuration or credentials.
 * Diagnostics use stderr so stdout still starts with the listening record for process launchers.
 */
export async function startupStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await work();
  console.error(JSON.stringify({ type: "startup_stage", stage, ms: Math.round(performance.now() - started), uptimeMs: Math.round(process.uptime() * 1_000) }));
  return value;
}
