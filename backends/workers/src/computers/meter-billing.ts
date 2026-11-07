import { keyServices, type KeyEnv } from "../security-services.ts";
import { transaction } from "../postgres.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "../auxiliary-usage.ts";
import { publishPending, type WebhookEnv } from "../webhooks.ts";
import type { ComputerCharge, ComputerPayer, MeterBilling } from "./meter.ts";

/** The provider name container time is recorded under, with the instance type as its model. */
export const CONTAINER_PROVIDER = "cloudflare";

/**
 * Container time goes through the same accounting as the other platform-paid work (web calls, images): a durable
 * receipt per session, then the usage record with `platform: true` and `kind: "computer"`, so a prepaid tenant is
 * charged and an unbilled one only sees it in its usage. Agent spend limits count it too.
 */
export function meterBilling(env: KeyEnv & WebhookEnv): MeterBilling {
  return {
    async admit(payer: ComputerPayer) {
      const { accounts } = await keyServices(env);
      await admitAuxiliaryUsage(env, payer, true, async () => {
        const refused = await accounts.billing.creditLimit(payer.tenant);
        if (refused) throw refused;
      });
    },
    async charge(charge: ComputerCharge) {
      const { accounts } = await keyServices(env);
      await transaction(env, async sql => {
        if (!await recordAuxiliaryUsage(sql, { tenant: charge.tenant, agent: charge.agent, callId: `computer:${charge.id}`,
          startedAt: charge.startedAt, kind: "computer" }, { costUsd: charge.costUsd, provider: CONTAINER_PROVIDER, model: charge.instance })) return;
        await accounts.recordUsageIn(sql, charge.tenant, charge.agent, { provider: CONTAINER_PROVIDER, model: charge.instance,
          kind: "computer", platform: true, seconds: charge.seconds, timestamp: charge.endedAt,
          usage: { input: 0, output: 0, cost: { total: charge.costUsd } } });
      });
      await accounts.usageCommitted(charge.tenant);
      await publishPending(env);
    },
  };
}
