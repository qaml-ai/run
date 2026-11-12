import { keyServices, type KeyEnv } from "../security-services.ts";
import { transaction } from "../postgres.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "../auxiliary-usage.ts";
import { publishPending, type WebhookEnv } from "../webhooks.ts";
import { HttpError } from "../errors.ts";
import type { ComputerCharge, ComputerPayer, MeterBilling } from "./meter.ts";

/** The provider name container time is recorded under, with the instance type as its model. */
export const CONTAINER_PROVIDER = "cloudflare";

/**
 * Container time goes through the same accounting as the other platform-paid work (web calls, images): a durable
 * receipt per session, then the usage record with `platform: true` and `kind: "computer"`, so a prepaid tenant is
 * charged and an unbilled one only sees it in its usage. Agent spend limits count it too.
 *
 * A workflow payer (a job of a workflow an API key started, which no agent owns) is its tenant: admission is the
 * tenant's monthly spend limit and prepaid credit (holds count), and the usage is recorded under the workflow's id
 * (usage rows, usage details with the workflow as agent and root, the receipt keyed by the session). No end user is
 * ever charged: a workflow's job has none.
 */
export function meterBilling(env: KeyEnv & WebhookEnv): MeterBilling {
  return {
    async admit(payer: ComputerPayer) {
      const { accounts } = await keyServices(env);
      if (payer.kind === "workflow") {
        const refused = await accounts.runLimit(payer.tenant);
        if (refused) throw typeof refused === "string" ? new HttpError(402, refused, "SPEND_LIMIT") : refused;
        return;
      }
      await admitAuxiliaryUsage(env, payer, true, async () => {
        const refused = await accounts.billing.creditLimit(payer.tenant);
        if (refused) throw refused;
      });
    },
    async charge(charge: ComputerCharge) {
      const { accounts } = await keyServices(env);
      await transaction(env, async sql => {
        if (!await recordAuxiliaryUsage(sql, { tenant: charge.tenant, agent: charge.agent, callId: `computer:${charge.id}`,
          startedAt: charge.startedAt, kind: "computer" }, { costUsd: charge.costUsd, provider: CONTAINER_PROVIDER, model: charge.instance },
          charge.kind === "workflow" ? "workflow" : "agent")) return;
        await accounts.recordUsageIn(sql, charge.tenant, charge.agent, { provider: CONTAINER_PROVIDER, model: charge.instance,
          kind: "computer", platform: true, seconds: charge.seconds, timestamp: charge.endedAt,
          usage: { input: 0, output: 0, cost: { total: charge.costUsd } } });
      });
      await accounts.usageCommitted(charge.tenant);
      await publishPending(env);
    },
  };
}
