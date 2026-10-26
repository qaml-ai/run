import { clock, random } from "./node-context.ts";

/** Sustained pressure, with one jitter per node; a refused attempt retries without restarting the window. */
export class MemoryRetirement {
  private since?: number;
  private checking = false;
  private retryAt = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly windowMs: number;

  private readonly options: {
    ms: number;
    high: () => boolean;
    acquire: () => Promise<boolean>;
    retire: (heldMs: number) => Promise<void | boolean>;
    failed: (error: unknown) => void;
  };

  constructor(options: MemoryRetirement["options"]) {
    this.options = options;
    this.windowMs = options.ms + Math.floor(random().float() * 600_001);
  }

  start() {
    if (!this.options.ms || this.timer || this.stopped) return;
    this.timer = clock().setInterval(() => void this.check(), 1_000);
    this.timer.unref();
  }

  stop() { this.stopped = true; clock().clearInterval(this.timer); }

  private async check() {
    if (this.stopped) return;
    if (!this.options.high()) { this.since = undefined; return; }
    this.since ??= clock().monotonic();
    if (clock().monotonic() < this.retryAt || this.checking || clock().monotonic() - this.since < this.windowMs) return;
    const since = this.since;
    this.checking = true;
    try {
      if (!await this.options.acquire()) { this.retryAt = clock().monotonic() + 30_000; return; }
      // The guard is committed: finish leaving even if pressure falls during acquisition.
      const heldMs = clock().monotonic() - since;
      if (await this.options.retire(heldMs) === false) this.retryAt = clock().monotonic() + 30_000;
      else this.stop();
    } catch (error) { this.retryAt = clock().monotonic() + 30_000; this.options.failed(error); }
    finally { this.checking = false; }
  }
}
