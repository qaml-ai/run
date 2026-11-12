// The workflow object's one alarm (workflow-object.ts): when it is due, and what it runs. Kept apart from the object
// so it can be tested without the Workers runtime.

/** After a concern failed, the alarm comes back no sooner than this (as the runner's own alarm), so it cannot spin. */
export const ALARM_FAILURE_FLOOR_MS = 30_000;

/** The one alarm: the earliest of the times given (null or undefined: that one needs none), or none. */
export function alarmAt(...times: (number | null | undefined)[]): number | undefined {
  const set = times.filter((time): time is number => typeof time === "number");
  return set.length ? Math.min(...set) : undefined;
}

/**
 * Run the alarm's concerns in order, each isolated: one that throws is logged and the ones after it still run. Then,
 * whatever happened, `next()` says when the alarm must come back and `arm` sets it (after a failure, no sooner than
 * `ALARM_FAILURE_FLOOR_MS` from `now`). The alarm never rests on the platform's few retries of a handler that threw.
 */
export async function runAlarm(options: {
  concerns: [name: string, work: () => unknown][];
  next(): Promise<number | undefined>;
  arm(at: number): Promise<void>;
  log(concern: string, error: unknown): void;
  now?(): number;
}): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  try {
    for (const [name, work] of options.concerns) {
      try { await work(); }
      catch (error) { failed.push(name); options.log(name, error); }
    }
  } finally {
    let next: number | undefined;
    try { next = await options.next(); }
    catch (error) { failed.push("next"); options.log("next", error); next = (options.now?.() ?? Date.now()) + ALARM_FAILURE_FLOOR_MS; }
    if (next !== undefined) await options.arm(failed.length ? Math.max(next, (options.now?.() ?? Date.now()) + ALARM_FAILURE_FLOOR_MS) : next);
  }
  return { failed };
}
