import { DurableObject } from "cloudflare:workers";
import { guardAlarms } from "../alarm-guard.ts";
import { withMoneyMetrics } from "../money-metrics.ts";
import { failure, type MetricsEnv } from "../observability.ts";
import { tierConfigured } from "./tier.ts";
import { pollUsage, settleUsage, type UsageEnv } from "./usage.ts";

type PollerEnv = UsageEnv & MetricsEnv;

export type UsagePollerBinding = {
  CAMELFS_URL?: string;
  CAMELFS_USAGE: DurableObjectNamespace<CamelfsUsagePoller>;
};

const POLL_MS = 20_000;

export async function startUsagePoller(env: UsagePollerBinding) {
  if (tierConfigured(env)) await env.CAMELFS_USAGE.getByName("usage").start();
}

export class CamelfsUsagePoller extends DurableObject<PollerEnv> {
  private running = false;

  constructor(ctx: DurableObjectState, env: PollerEnv) {
    super(ctx, env);
    guardAlarms(this, ctx, "CamelfsUsagePoller", { test: env.TEST_MODE === "1" });
  }

  async start() {
    if (!tierConfigured(this.env)) return;
    // getAlarm returns null inside an alarm handler until it re-arms.
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.running && await this.ctx.storage.getAlarm() === null)
        await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    });
  }

  async alarm() {
    if (!tierConfigured(this.env)) {
      console.log(JSON.stringify({ type: "usage_poll_disabled" }));
      return;
    }
    this.running = true;
    try {
      await withMoneyMetrics(this.env, async () => {
        await pollUsage(this.env).catch(error => failure(this.env, "usage_poll_failed", error));
        await settleUsage(this.env);
      });
    } finally {
      try { await this.ctx.storage.setAlarm(Date.now() + POLL_MS); }
      finally { this.running = false; }
    }
  }
}
