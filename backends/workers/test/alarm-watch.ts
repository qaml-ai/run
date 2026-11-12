/**
 * A watch on a Durable Object's alarm in a unit harness with a simulated clock, the test-side twin of
 * src/alarm-guard.ts. It fails the test (throws, from the harness's alarm driver) when an alarm ends with its alarm
 * armed for at or before now (an immediate re-fire with nothing new), or when it fires more than `fires` times within
 * `windowMs` of simulated time with no external event in between (a landing, a request: `external()`).
 */
import { ALARM_HOT_LOOP } from "../src/alarm-guard.ts";

export class AlarmWatch {
  private fires: number[] = [];
  private last: number | null = null;
  private readonly name: string;
  private readonly limits: { windowMs: number; fires: number };
  constructor(name: string, limits: { windowMs: number; fires: number } = ALARM_HOT_LOOP) { this.name = name; this.limits = limits; }
  /** Something from outside happened (a landing, a request, a wake): what follows is not the alarm feeding itself. */
  external() { this.fires = []; }
  /** Run one alarm at simulated time `now`. */
  async fire<T>(now: number, run: () => Promise<T>): Promise<T> {
    this.fires.push(now);
    this.fires = this.fires.filter(at => at > now - this.limits.windowMs);
    if (this.fires.length > this.limits.fires)
      throw new Error(`${this.name}: alarm hot loop, ${this.fires.length} fires within ${this.limits.windowMs} ms of simulated time with nothing else happening`);
    // The alarm that fires is used up (as on workerd): only what this run arms is left.
    this.last = null;
    const result = await run();
    // What the alarm left armed when it ended (an alarm set and moved within one run is fine: the last one counts).
    if (this.last !== null && this.last <= now)
      throw new Error(`${this.name}: its alarm left itself armed for ${this.last}, at or before now (${now}): an immediate re-fire with nothing new`);
    return result;
  }
  /** The object set its alarm for `at` (null: none). */
  armed(at: number | null) { this.last = at; }
}
