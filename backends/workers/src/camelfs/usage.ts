import { tierRequest, type TierEnv } from "./tier.ts";
import { meterBilling } from "../computers/meter-billing.ts";
import type { ComputerCharge, ComputerPayer, MeterBilling } from "../computers/meter.ts";
import { hostInstance, HOSTS_PROVIDER, type HostPool, type HostShape } from "../jobs/host-pricing.ts";
import { emitSourceMetric } from "../money-metrics.ts";
import { safeError } from "../observability.ts";
import { transaction, withSql } from "../postgres.ts";
import type { WebhookEnv } from "../webhooks.ts";

export type UsageEnv = TierEnv & WebhookEnv;

// MONEY: the VM payer carries the USD/second rate fixed at admission.
export type VmPayer = ComputerPayer & { rate: number };

export function encodeVmPayer({ tenant, agent, kind, rate }: VmPayer): string {
  return JSON.stringify({ tenant, agent, kind, rate });
}

export function decodeVmPayer(s: string): VmPayer | undefined {
  if (typeof s !== "string") return;
  let payer: Partial<VmPayer> | null;
  try { payer = JSON.parse(s); }
  catch { return; }
  if (!payer || typeof payer !== "object") return;
  const { tenant, agent, kind, rate } = payer;
  if (typeof tenant !== "string" || !tenant || typeof agent !== "string" || !agent ||
      (kind !== undefined && kind !== "workflow") || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return;
  return { tenant, agent, ...(kind === undefined ? {} : { kind }), rate };
}

type UsageEvent = {
  eventId: string;
  ulid: string;
  type: string;
  vm?: string;
  payer: string;
  pool: HostPool;
  shape: Pick<HostShape, "vcpus" | "memoryMiB">;
  from: number;
  to: number;
  final?: boolean;
};
type UsagePage = { events: UsageEvent[]; cursor: string; watermark: number };

export async function pollUsage(env: UsageEnv, request = tierRequest<UsagePage>) {
  const result = await withSql(env, sql => sql.query<{ cursor: string }>("select cursor from camelfs_usage_cursor where k = 0"));
  const after = result.rows[0]?.cursor ?? "";
  const page = await request(env, {
    method: "GET", path: "/v1/usage", query: { after, limit: 1000 }, claims: { sub: "runtime:usage", acc: "r" },
  });
  if (!Array.isArray(page?.events) || typeof page.cursor !== "string" || !Number.isSafeInteger(page.watermark))
    throw new Error("Invalid camelFS usage page");
  const lagMs = Date.now() - page.watermark;
  if (lagMs > 300_000) console.warn(JSON.stringify({ type: "usage_poll_lag", lagMs }));

  // MONEY: journal the whole page and advance the opaque cursor in the same transaction.
  // Non-VM events may have no VM ID. Their original body still goes into the journal.
  await transaction(env, async sql => {
    await sql.query(`insert into camelfs_usage_events (event_id, vm, body)
      select event->>'eventId', coalesce(event->>'vm', ''), event
      from jsonb_array_elements($1::jsonb) as page(event)
      on conflict (event_id) do nothing`, [JSON.stringify(page.events)]);
    await sql.query(`insert into camelfs_usage_cursor (k, cursor, polled_at) values (0, $1, now())
      on conflict (k) do update set cursor = excluded.cursor, polled_at = excluded.polled_at`, [page.cursor]);
  });
}

// MONEY: validate the billable interval and price it in integer milliseconds.
function eventCharge(event: UsageEvent): ComputerCharge | string | undefined {
  if (event.type !== "usage.vm") return `unhandled_type:${event.type}`;
  const payer = decodeVmPayer(event.payer);
  if (!payer) return "bad_payer";
  const { from, to } = event;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return "bad_interval";
  if (to === from) return;
  const durationMs = to - from;
  const { rate, ...owner } = payer;
  return {
    ...owner,
    id: `camelfs:${event.eventId}`,
    instance: hostInstance(event.pool, event.shape),
    startedAt: from,
    endedAt: to,
    seconds: durationMs / 1000,
    costUsd: rate * durationMs / 1000,
  };
}

// MONEY: a retry uses the same receipt ID (meterBilling prefixes it with "computer:").
export async function settleUsage(env: UsageEnv, charge: MeterBilling["charge"] = meterBilling(env, HOSTS_PROVIDER).charge) {
  await withSql(env, async sql => {
    const { rows } = await sql.query<{ event_id: string; vm: string; body: UsageEvent }>(
      `select event_id, vm, body from camelfs_usage_events where settled_at is null
       order by received_at, body->>'ulid', event_id limit 500`,
    );
    for (const { event_id: eventId, vm, body } of rows) {
      const result = eventCharge(body);
      if (typeof result === "string") {
        await sql.query(`update camelfs_usage_events set settled_at = now(), unbillable_reason = $2
          where event_id = $1`, [eventId, result]);
        console.error(JSON.stringify({ type: "usage_unbillable", eventId, vm, reason: result }));
        emitSourceMetric("usage_unbillable", {
          dimensions: { reason: result }, rollups: [["reason"]], metrics: { usage_unbillable: 1 },
        });
        continue;
      }

      let settleError: string | null = null;
      if (result) {
        try {
          await charge(result);
        } catch (error) {
          const status = Number((error as { status?: number })?.status);
          if (status !== 404 && status !== 409) {
            console.error(JSON.stringify({ type: "usage_charge_failed", eventId, vm, final: body.final, error: safeError(error) }));
            continue;
          }
          settleError = String(status);
        }
      }
      await sql.query(`update camelfs_usage_events set settled_at = now(), settle_error = $2 where event_id = $1`,
        [eventId, settleError]);
      if (settleError) console.error(JSON.stringify({ type: "usage_charge_dropped", eventId, vm, final: body.final, reason: settleError }));
      else console.log(JSON.stringify({ type: "usage_settled", eventId, vm, final: body.final }));
    }
  });
}
