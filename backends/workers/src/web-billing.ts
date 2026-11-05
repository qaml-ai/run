import { keyServices, type KeyEnv } from "./security-services.ts";
import { transaction } from "./postgres.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "./auxiliary-usage.ts";
import { HttpError } from "./errors.ts";
import { publishPending, type WebhookEnv } from "./webhooks.ts";
import type { BuiltinScope } from "./agent-builtins.ts";
import type { UsageRecord } from "./web-policy-host.ts";

/** Every web request rechecks credit, including calls made inside one codemode execution. */
export async function admitWebUsage(env: KeyEnv, scope: BuiltinScope, platform: boolean) {
  const { accounts } = await keyServices(env);
  await admitAuxiliaryUsage(env, scope, platform, async () => {
    const refused = await accounts.runLimit(scope.tenant);
    if (refused) throw typeof refused === "string" ? new HttpError(402, refused, "SPEND_LIMIT") : refused;
  });
}

/** Use the source accounting path so platform prices, workspaces and ledger metadata agree. */
export async function recordWebUsage(env: KeyEnv & WebhookEnv, scope: BuiltinScope, usage: UsageRecord) {
  if (!scope.callId || scope.startedAt === undefined) throw new HttpError(503, "Web call identity is unavailable");
  const { accounts } = await keyServices(env);
  await transaction(env, async sql => {
    if (!await recordAuxiliaryUsage(sql, { tenant: scope.tenant, agent: scope.agent, requestId: scope.requestId,
      callId: scope.callId!, startedAt: scope.startedAt!, kind: usage.model as "web_search" | "x_search" | "web_fetch" },
    { costUsd: usage.usage.cost.total, provider: usage.provider, model: usage.model })) return;
    await accounts.recordUsageIn(sql, scope.tenant, scope.agent, { ...usage,
      ...(scope.requestId ? { requestId: scope.requestId } : {}), ...(scope.keyScope ? { keyScope: scope.keyScope } : {}) });
  });
  await accounts.usageCommitted(scope.tenant);
  await publishPending(env);
}
