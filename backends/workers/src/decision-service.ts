import { recordUsageDetails } from '../../../shared/usage-details.ts';
import { applyWorkspaceUsage } from './workspaces.ts';
import { DecisionRuntime, type DecisionContext } from './decision-runtime.ts';
import { resolveProviderKey, type ProviderKeyEnv } from './model-credentials.ts';
import { transaction, withSql } from './postgres.ts';
import { accrueUsage, BillingSpendable } from './billing-sql.ts';
import { enqueueEvents, webhookEvent, type WebhookEnv } from './webhooks.ts';
import { HttpError } from './errors.ts';
import type { UsageRecord } from './policy-host.ts';
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from './auxiliary-usage.ts';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
export type DecisionEnv = ProviderKeyEnv & WebhookEnv & {
  TEST_MODEL?: string; TEST_MODE?: string; AGENT_DECISIONS_URL?: string;
  /** Synthetic fixture keys only, installed by the compatibility harness. */
  TEST_DECISION_KEYS?: string;
};
type FixtureKeys = { tenants: Record<string, { apiKeys?: Record<string, string>; platformKeys?: boolean }>; platformKeys?: Record<string, string> };
async function key(env: DecisionEnv, tenant: string, scope: string | undefined, provider: string) {
  if (env.TEST_MODEL === '1' && env.TEST_MODE === '1' && env.TEST_DECISION_KEYS) {
    const fixture = JSON.parse(env.TEST_DECISION_KEYS) as FixtureKeys;
    const own = fixture.tenants[tenant]?.apiKeys?.[provider];
    if (own) return { apiKey: own, platform: false };
    const shared = fixture.platformKeys?.[provider];
    if (fixture.tenants[tenant]?.platformKeys !== false && shared) return { apiKey: shared, platform: true };
    return undefined;
  }
  const own = await resolveProviderKey(env, tenant, provider, scope);
  return own?.apiKey ? { apiKey: own.apiKey, platform: own.platform } : undefined;
}

/** Records the same decision model key and question count as src/accounts.ts. */
export async function recordDecision(env: DecisionEnv, context: DecisionContext, usage: UsageRecord, agentId = '', requestId?: string) {
  const charge = usage.platform ? Math.ceil(usage.usage.cost.total * 1_000_000) : 0;
  const now = usage.timestamp;
  await transaction(env, async sql => {
    // A real platform key must come with the money track's admission and hold
    // integration. This adapter's platform credentials are local fixtures only.
    if (usage.platform && !(env.TEST_MODEL === '1' && env.TEST_MODE === '1')) throw new HttpError(503, 'Platform decision billing is not configured');
    if (agentId) {
      if (!context.callId || context.startedAt === undefined) throw new HttpError(503, 'Decision call identity is unavailable');
      if (!await recordAuxiliaryUsage(sql, { tenant: context.tenant, agent: agentId, requestId, callId: context.callId, startedAt: context.startedAt, kind: 'decision' }, { costUsd: usage.usage.cost.total, provider: usage.provider, model: usage.model })) return;
    }
    await sql.query('select tenant from credit_accounts where tenant=$1 for update', [context.tenant]);
    if (charge > 0) {
      if (await new BillingSpendable().spendable(context.tenant, sql) < charge) throw new HttpError(402, 'Insufficient credit', 'INSUFFICIENT_CREDIT');
      await accrueUsage(sql, [{ tenant: context.tenant, amount: charge, metadata: { decision: charge, decisions: usage.decisions ?? 0 } }], now);
    }
    await sql.query(`insert into usage(tenant,day,model,responses,input,output,cost,platform_responses,platform_cost) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict(tenant,day,model) do update set responses=usage.responses+excluded.responses,input=usage.input+excluded.input,output=usage.output+excluded.output,cost=usage.cost+excluded.cost,platform_responses=usage.platform_responses+excluded.platform_responses,platform_cost=usage.platform_cost+excluded.platform_cost`,
      [context.tenant, new Date(now).toISOString().slice(0, 10), `decision:${usage.provider}/${usage.model}`, usage.decisions ?? 0, usage.usage.input, usage.usage.output, usage.usage.cost.total, usage.platform ? 1 : 0, charge / 1_000_000]);
    const attributed = { tenant: context.tenant, agent: agentId, requestId, endUser: context.identity?.subject ?? null,
      timestamp: now, day: new Date(now).toISOString().slice(0, 10), model: `decision:${usage.provider}/${usage.model}`,
      responses: usage.decisions ?? 0, input: usage.usage.input, output: usage.usage.output, cacheRead: 0, cacheWrite: 0,
      cost: usage.usage.cost.total, platformResponses: usage.platform ? 1 : 0, platformCost: charge / 1_000_000 };
    await recordUsageDetails(sql, [attributed]);
    await applyWorkspaceUsage(sql, [attributed]);
    await enqueueEvents(sql, [webhookEvent('usage.recorded', context.tenant, { agentId: agentId || null, requestId: requestId ?? null, subject: context.identity?.subject ?? null, actor: context.actor ?? null, context: context.identity?.context ?? null, keyScope: context.keyScope ?? null, provider: usage.provider, model: usage.model, kind: 'decision', input: usage.usage.input, output: usage.usage.output, cacheRead: 0, cacheWrite: 0, decisions: usage.decisions ?? 0, cost: { usd: usage.usage.cost.total, source: 'catalog' }, at: now })]);
  });
}
export function decisionService(env: DecisionEnv, context: (api?: ToolExecutionApi) => Promise<DecisionContext>, record?: (context: DecisionContext, usage: UsageRecord) => Promise<void>) {
  return new DecisionRuntime({ key: (tenant, scope, provider) => key(env, tenant, scope, provider), context, record: record ?? ((context, usage) => recordDecision(env, context, usage)), testUrl: env.AGENT_DECISIONS_URL, testMode: env.TEST_MODEL === '1' && env.TEST_MODE === '1', admit: async context => {
    const credentials = await key(env, context.tenant, context.keyScope, 'openrouter');
    if (credentials?.platform && !(env.TEST_MODEL === '1' && env.TEST_MODE === '1')) throw new HttpError(503, 'Platform decision billing is not configured');
    if (context.agent) await admitAuxiliaryUsage(env, { tenant: context.tenant, agent: context.agent, requestId: context.requestId, spendLimit: context.spendLimit });
    if (credentials?.platform && await withSql(env, sql => new BillingSpendable().spendable(context.tenant, sql)) <= 0) throw new HttpError(402, 'Insufficient credit', 'INSUFFICIENT_CREDIT');
  } });
}
