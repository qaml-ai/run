import { keyServices, type KeyEnv } from "./security-services.ts";
import { transaction } from "./postgres.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "./auxiliary-usage.ts";
import { HttpError } from "./errors.ts";
import { publishPending, type WebhookEnv } from "./webhooks.ts";
import type { BuiltinScope } from "./agent-builtins.ts";
import type { UsageRecord } from "./web-policy-host.ts";
import { utcDay, EndUserCredits } from "./end-user-credits.ts";
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
  const chargeKey = `charge:web:${await digest(JSON.stringify([scope.agent, scope.requestId, scope.callId]))}`;
  await transaction(env, async sql => {
    if (!await recordAuxiliaryUsage(sql, { tenant: scope.tenant, agent: scope.agent, requestId: scope.requestId,
      callId: scope.callId!, startedAt: scope.startedAt!, kind: usage.model as "web_search" | "x_search" | "web_fetch" },
    { costUsd: usage.usage.cost.total, provider: usage.provider, model: usage.model })) return;
    if (scope.identity?.subject) await new EndUserCredits(accounts.db).debit(scope.tenant, scope.identity.subject, scope.bucket ?? "default",
      usage.usage.cost.total, chargeKey, { call: usage.searches ? "web_search" : usage.renders ? "web_fetch" : "tool", agent: scope.agent,
        ...(usage.provider ? { provider: usage.provider } : {}), ...(scope.requestId ? { requestId: scope.requestId } : {}), usageDay: utcDay(scope.startedAt!) },
      { sql });
    await accounts.recordUsageIn(sql, scope.tenant, scope.agent, { ...usage, bucket: scope.bucket,
      ...(scope.requestId ? { requestId: scope.requestId } : {}), ...(scope.keyScope ? { keyScope: scope.keyScope } : {}),
      ...(scope.identity ? { identity: scope.identity } : {}), ...(scope.actor ? { actor: scope.actor } : {}) });

  });
  await accounts.usageCommitted(scope.tenant);
  await publishPending(env);
}
