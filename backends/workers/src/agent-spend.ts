import type { Sql } from './postgres.ts';
import { HttpError } from './errors.ts';

export type AgentSpend = { usd: number; spent: number; setAt: number };
export type SpendLimitError = HttpError & { stopLimit: 'agent' | 'run' };
const dollars = (usd: number) => `$${Number(usd.toFixed(6))}`;

/** Source setSpendLimit SQL: explicitly setting even the same value resets it. */
export async function setAgentSpendLimit(sql: Sql, agent: string, usd: number | null, setAt = Date.now()): Promise<void> {
  if (usd === null) await sql.query("delete from agent_spend_limits where agent = $1", [agent]);
  else await sql.query("insert into agent_spend_limits (agent, usd, spent, set_at) values ($1, $2, 0, $3) on conflict (agent) do update set usd = excluded.usd, spent = 0, set_at = excluded.set_at", [agent, usd, setAt]);
}

/**
 * Attempts are the durable cost journal on Workers. Read their raw model cost,
 * including compaction, rather than prepaid funding or active-agent charges.
 * Recomputing makes duplicate settlement and reconciliation corrections safe.
 */
export async function agentSpend(sql: Sql, tenant: string, agent: string): Promise<AgentSpend | null> {
  const row = (await sql.query(`update agent_spend_limits as limits set spent = (
      select coalesce(sum((attempt.totals->>'cost')::double precision),0)
      from model_attempts as attempt
      where attempt.tenant=$1 and attempt.agent=limits.agent and attempt.started_at>=limits.set_at
    ) where limits.agent=$2
      and exists(select 1 from agents where agents.id=limits.agent and agents.tenant=$1)
    returning limits.usd,limits.spent,limits.set_at`, [tenant, agent])).rows[0];
  return row ? { usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) } : null;
}

export async function runSpend(sql: Sql, tenant: string, agent: string, requestId: string): Promise<number> {
  const row = (await sql.query(`select coalesce(sum((totals->>'cost')::double precision),0) as spent
    from model_attempts where tenant=$1 and agent=$2 and context->>'requestId'=$3`, [tenant, agent, requestId])).rows[0];
  return Number(row.spent);
}

/** Source priority and wording: the agent's limit, then this run's own budget. */
export async function modelSpendLimit(sql: Sql, context: { tenant: string; agent: string; requestId?: string; spendLimit?: number }): Promise<SpendLimitError | undefined> {
  const spend = await agentSpend(sql, context.tenant, context.agent);
  if (spend && spend.spent >= spend.usd)
    return Object.assign(new HttpError(402, `This agent has reached its spend limit of ${dollars(spend.usd)} (${dollars(spend.spent)} spent since it was set); raise it with PATCH /v1/agents/${context.agent}/configuration {"spendLimit": {"usd": …}}`, 'SPEND_LIMIT'), { stopLimit: 'agent' as const });
  if (context.requestId !== undefined && context.spendLimit !== undefined) {
    const spent = await runSpend(sql, context.tenant, context.agent, context.requestId);
    if (spent >= context.spendLimit)
      return Object.assign(new HttpError(402, `This run has reached its spend limit of ${dollars(context.spendLimit)} (${dollars(spent)} spent)`, 'SPEND_LIMIT'), { stopLimit: 'run' as const });
  }
}
