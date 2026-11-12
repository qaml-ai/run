// A guard on every Durable Object's alarm against hot loops: an object whose alarm keeps re-arming itself for at once
// (an outbox row that never leaves, a deleted agent woken every second, a retry floored at now + 1 ms) spins, burns
// requests and starves its other work. The bug class recurred; this makes production degrade instead of spin, and lets
// tests fail on it (test/fixture.ts fails a test whose worker logged alarm_hot_loop).

/** More than `fires` alarms within `windowMs` is a hot loop; the next alarm is then moved to at least `floorMs` from now. */
export const ALARM_HOT_LOOP = Object.freeze({ windowMs: 10_000, fires: 20, floorMs: 1_000 });

type Host = { alarm?: (...args: any[]) => unknown };
type State = { storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">; id?: { toString(): string } };

const GUARDED = Symbol("camelRun.alarmGuarded");

/**
 * Wrap `object`'s alarm handler (a method, or one a lifecycle installed on the instance, configurable but not writable,
 * as the agents SDK installs it). Each fire is counted; past the limit the object is hot, and after each handler an
 * alarm due sooner than `floorMs` from now is moved there, until a whole window passes with no such re-arm;
 * `alarm_hot_loop` is logged once per window. With `test`, a handler that leaves its alarm due at or before now (an
 * immediate re-fire with nothing new to do) also logs `alarm_rearm_due`, for tests to find. The handler's own errors
 * propagate; the guard's never do. Wraps once: a second call leaves the guard in place.
 */

export function guardAlarms(object: Host, ctx: State, name: string, options: { test?: boolean; now?: () => number } = {}) {
  const handler = object.alarm;
  // Wrapped once: a second call (a subclass, a lifecycle installed twice) leaves the guard it finds.
  if (typeof handler !== "function" || (handler as { [GUARDED]?: true })[GUARDED]) return;
  const now = options.now ?? Date.now;
  const fires: number[] = [];
  let reported = -Infinity;
  // Hot from the trip until a whole window passes with no sub-second re-arm: the floor stays while the loop does, so a
  // persistent spinner runs at one fire a second, not in bursts each time its fast fires age out of the window.
  let hot = false, lastFast = -Infinity;
  const guardedAlarm = async function guardedAlarm(...args: unknown[]) {
    const at = now();
    fires.push(at);
    while (fires.length && fires[0]! <= at - ALARM_HOT_LOOP.windowMs) fires.shift();
    try { return await handler.apply(object, args); }
    finally {
      if (fires.length > ALARM_HOT_LOOP.fires) hot = true;
      if (hot || options.test) {
        try {
          const next = await ctx.storage.getAlarm(), end = now(), floor = end + ALARM_HOT_LOOP.floorMs;
          // A re-arm for sooner than a second from now: what a loop does. One full window without any ends it.
          if (next !== null && next < floor) lastFast = at;
          else if (hot && at - lastFast >= ALARM_HOT_LOOP.windowMs) { hot = false; fires.length = 0; }
          if (hot) {
            const floored = next !== null && next < floor;
            if (floored) await ctx.storage.setAlarm(floor);
            if (at - reported >= ALARM_HOT_LOOP.windowMs) {
              reported = at;
              console.error(JSON.stringify({ type: "alarm_hot_loop", object: name, id: ctx.id?.toString() ?? null, fires: fires.length, windowMs: ALARM_HOT_LOOP.windowMs, next, floored }));
            }
          } else if (options.test && next !== null && next <= end) {
            // Which lifecycle jobs are due (an agents-SDK object's queue), to find who re-armed it for now.
            let due: unknown;
            try { due = (ctx.storage as { sql?: SqlStorage }).sql?.exec("SELECT id, capability, fn, time FROM cf_agents_jobs WHERE time <= ? ORDER BY time LIMIT 5", end + 2).toArray(); } catch { /* no queue */ }
            console.error(JSON.stringify({ type: "alarm_rearm_due", object: name, id: ctx.id?.toString() ?? null, next, at: end, ...(due ? { due } : {}) }));
          }
        } catch (error) {
          console.error(JSON.stringify({ type: "alarm_guard_failed", object: name, error: error instanceof Error ? error.name : "unknown" }));
        }
      }
    }
  };
  Object.defineProperty(guardedAlarm, GUARDED, { value: true });
  Object.defineProperty(object, "alarm", { configurable: true, writable: true, value: guardedAlarm });
}
