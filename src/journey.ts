/** The shared journey policy, with Node's database and transport services. */
import { Journey as CoreJourney, type JourneyOptions as CoreJourneyOptions } from "./core/journey.ts";
import { transaction, type Db } from "./db.ts";
import { readText } from "./http.ts";
import { safeError } from "./metrics.ts";
import { signedHeaders } from "./webhooks.ts";
export * from "./core/journey.ts";
export * from "./journey-app.ts";
export type JourneyOptions = Omit<CoreJourneyOptions, "host">;
export class Journey extends CoreJourney {
  private timers: ReturnType<typeof setInterval>[] = [];
  constructor(options: JourneyOptions) {
    super({ ...options, host: {
      transaction: (db, work) => transaction(db as Db, work),
      readText, safeError, signedHeaders,
    } });
  }
  /** Scans for deliveries and reconciles accounts on timers; Workers run the same two steps from a cron instead. */
  start(intervalMs = 5_000, reconcileMs = 10 * 60_000) {
    if (this.timers.length) return;
    const every = (ms: number, type: string, work: () => Promise<unknown>) => {
      const timer = setInterval(() => void work().catch(error => console.error(JSON.stringify({ type, error: safeError(error) }))), ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(intervalMs, "journey_scan_failed", () => this.send());
    every(reconcileMs, "journey_reconcile_failed", () => this.reconcile());
    void this.reconcile().catch(error => console.error(JSON.stringify({ type: "journey_reconcile_failed", error: safeError(error) })));
  }
  stop() { for (const timer of this.timers) clearInterval(timer); this.timers = []; }
}
