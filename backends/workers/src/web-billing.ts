import { keyServices, type KeyEnv } from "./security-services.ts";
import { transaction } from "./postgres.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "./auxiliary-usage.ts";
import { HttpError } from "./errors.ts";
import { publishPending, type WebhookEnv } from "./webhooks.ts";
import type { BuiltinScope } from "./agent-builtins.ts";
import type { UsageRecord } from "./web-policy-host.ts";
import { EndUserCredits, settleUsage, utcDay } from "./end-user-credits.ts";
import { digest } from "./api-contract.ts";

/** Every web request rechecks credit, including calls made inside one codemode execution. */
export async function admitWebUsage(env: KeyEnv, scope: BuiltinScope, platform: boolean) {
  const { accounts } = await keyServices(env);
  await admitAuxiliaryUsage(env, scope, platform, async () => {
    const refused = await accounts.billing.creditLimit(scope.tenant);
    if (refused) throw refused;
  });
}

/** Use the source accounting path so platform prices, workspaces and ledger metadata agree. */
export async function recordWebUsage(env: KeyEnv & WebhookEnv, scope: BuiltinScope, usage: UsageRecord) {
  if (!scope.callId || scope.startedAt === undefined) throw new HttpError(503, "Web call identity is unavailable");
  const { accounts } = await keyServices(env);
  const now = Date.now(), raw = Math.round(usage.usage.cost.total * 1_000_000);
  const chargeKey = `charge:web:${await digest(JSON.stringify([scope.agent, scope.requestId, scope.callId]))}`;
  await transaction(env, async sql => {
    if (!await recordAuxiliaryUsage(sql, { tenant: scope.tenant, agent: scope.agent, requestId: scope.requestId,
      callId: scope.callId!, startedAt: scope.startedAt!, kind: usage.model as "web_search" | "x_search" | "web_fetch" },
    { costUsd: usage.usage.cost.total, provider: usage.provider, model: usage.model })) return;
    await accounts.recordUsageIn(sql, scope.tenant, scope.agent, { ...usage,
      ...(scope.requestId ? { requestId: scope.requestId } : {}), ...(scope.keyScope ? { keyScope: scope.keyScope } : {}),
      ...(scope.identity ? { identity: scope.identity } : {}), ...(scope.actor ? { actor: scope.actor } : {}) });
    // Web calls hold no estimate in src/. Settle their actual cost through the
    // same allowance, markup, lot and write-off policy, with the tenant receipt.
    if (scope.identity?.subject && raw > 0 && (await new EndUserCredits(accounts.db).settings(scope.tenant, sql)).enabled) {
      await settleUsage(sql, { tenant: scope.tenant, endUser: scope.identity.subject, bucket: scope.bucket ?? "default",
        day: utcDay(now), raw, key: chargeKey,
        metadata: { call: usage.searches ? "web_search" : usage.renders ? "web_fetch" : "tool", agent: scope.agent,
          ...(usage.provider ? { provider: usage.provider } : {}), ...(scope.requestId ? { requestId: scope.requestId } : {}) } }, now);
    }
  });
  await accounts.usageCommitted(scope.tenant);
  await publishPending(env);
}
