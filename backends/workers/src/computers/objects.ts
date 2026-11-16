import { DurableObject } from "cloudflare:workers";
import { releaseComputer } from "../../../../src/core/computer-limit.ts";
import { guardAlarms } from "../alarm-guard.ts";
import { withSql } from "../postgres.ts";
import type { KeyEnv } from "../security-services.ts";
import type { WebhookEnv } from "../webhooks.ts";
import { COMPUTER_LIMITS } from "./egress.ts";
import { ComputerMeter } from "./meter.ts";
import { meterBilling } from "./meter-billing.ts";

type Env = KeyEnv & WebhookEnv;
export type ComputerDrainBinding = { COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer> };

const RETRY_MS = 60_000;
const STOP_INTENT = "computer:retire-stop";
type StopIntent = { at: number; cpu?: number };

async function finalCpuUsec(container: Container): Promise<number | undefined> {
  try {
    const read = await container.exec(["cat", "/sys/fs/cgroup/cpu.stat"], {
      signal: AbortSignal.timeout(5_000), stdout: "pipe", stderr: "ignore",
    });
    const decoder = new TextDecoder();
    const reader = read.stdout?.getReader();
    let text = "", size = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); return undefined; }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    if (await read.exitCode) return undefined;
    const usage = /^usage_usec (\d+)$/m.exec(text)?.[1];
    return usage === undefined ? undefined : Number(usage);
  } catch {
    // The previous meter readings and rates still account for the session if the last reading is unavailable.
    return undefined;
  }
}

// Keep the deployed class name and its container binding until old sessions have stopped and settled. This class
// only drains existing objects. Cloudflare's class deletion migration would also erase the meter's unsettled charges.
export class ContainerComputer extends DurableObject<Env> {
  private draining?: Promise<{ settled: boolean }>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    guardAlarms(this, ctx, "ContainerComputer");
  }

  drain(): Promise<{ settled: boolean }> {
    return this.draining ??= this.retire().finally(() => { this.draining = undefined; });
  }

  /** Agent deletion may erase its old snapshot handles only after its usage has settled. */
  async purge(): Promise<{ settled: boolean }> {
    const status = await this.drain();
    if (status.settled) await this.ctx.storage.deleteAll();
    return status;
  }

  async alarm() {
    await this.drain();
  }

  private async retire(): Promise<{ settled: boolean }> {
    const { storage, container } = this.ctx;
    const meter = new ComputerMeter({
      store: storage,
      billing: meterBilling(this.env),
      idleMs: COMPUTER_LIMITS.idleSeconds.default * 1000,
      schedule: at => storage.setAlarm(at),
      retainRejected: true,
    });
    try {
      let stop = await storage.get<StopIntent>(STOP_INTENT);
      if (container?.running) {
        if (!stop) {
          const cpu = await finalCpuUsec(container);
          // MONEY: Persist the stop time and CPU sample before a destroy can outlive this invocation.
          stop = { at: Date.now(), cpu };
          await storage.put(STOP_INTENT, stop);
        }
        if (container.running) await container.destroy();
      }
      if (stop) {
        await meter.stopped(stop.cpu, stop.at);
        await storage.delete(STOP_INTENT);
      } else {
        await meter.alarm(false);
      }
      const permit = await storage.get<{ tenant: string; machine: string }>("computer:permit");
      if (permit) {
        await withSql(this.env, sql => releaseComputer(sql, permit.tenant, permit.machine));
        await storage.delete("computer:permit");
      }
      const settled = await meter.settled();
      if (settled) await storage.deleteAlarm();
      return { settled };
    } catch (error) {
      await storage.setAlarm(Date.now() + RETRY_MS);
      throw error;
    }
  }
}
