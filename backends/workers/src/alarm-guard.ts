// A guard on every Durable Object's alarm against hot loops: an object whose alarm keeps re-arming itself for at once
// (an outbox row that never leaves, a deleted agent woken every second, a retry floored at now + 1 ms) spins, burns
// requests and starves its other work. The bug class recurred; this makes production degrade instead of spin, and lets
// tests fail on it (test/fixture.ts fails a test whose worker logged alarm_hot_loop).

/** More than `fires` alarms within `windowMs` is a hot loop; the next alarm is then moved to at least `floorMs` from now. */
export const ALARM_HOT_LOOP = Object.freeze({ windowMs: 10_000, fires: 20, floorMs: 1_000 });

type Host = { alarm?: (...args: any[]) => unknown };
type State = { storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">; id?: { toString(): string } };

/**
 * Wrap `object`'s alarm handler (a method, or one a lifecycle installed on the instance). Each fire is counted; past the
 * limit, after the handler, an alarm due sooner than `floorMs` from now is moved there and `alarm_hot_loop` is logged
 * (once per window). With `test`, a handler that leaves its alarm due at or before now (an immediate re-fire with
 * nothing new to do) also logs `alarm_rearm_due`, for tests to find. Call once, after the handler exists.
 */
export function guardAlarms(object: Host, ctx: State, name: string, options: { test?: boolean; now?: () => number } = {}) {
  const handler = object.alarm;
  if (typeof handler !== "function") return;
  const now = options.now ?? Date.now;
  const fires: number[] = [];
  let reported = -Infinity;
  Object.defineProperty(object, "alarm", {
    configurable: true, writable: true,
    value: async function guardedAlarm(...args: unknown[]) {
      const at = now();
      fires.push(at);
      while (fires.length && fires[0]! <= at - ALARM_HOT_LOOP.windowMs) fires.shift();
      try { return await handler.apply(object, args); }
      finally {
        const hot = fires.length > ALARM_HOT_LOOP.fires;
        if (hot || options.test) {
          try {
            const next = await ctx.storage.getAlarm(), end = now();
            if (hot) {
              const floor = end + ALARM_HOT_LOOP.floorMs, floored = next !== null && next < floor;
              if (floored) await ctx.storage.setAlarm(floor);
              if (at - reported >= ALARM_HOT_LOOP.windowMs) {
                reported = at;
                console.error(JSON.stringify({ type: "alarm_hot_loop", object: name, id: ctx.id?.toString() ?? null, fires: fires.length, windowMs: ALARM_HOT_LOOP.windowMs, next, floored }));
              }
            } else if (next !== null && next <= end) {
              console.error(JSON.stringify({ type: "alarm_rearm_due", object: name, id: ctx.id?.toString() ?? null, next, at: end }));
            }
          } catch (error) {
            console.error(JSON.stringify({ type: "alarm_guard_failed", object: name, error: error instanceof Error ? error.name : "unknown" }));
          }
        }
      }
    },
  });
}
