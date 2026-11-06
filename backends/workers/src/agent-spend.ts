import { HttpError } from "./errors.ts";
import { AGENT_SPEND_SQL, agentSpendMessage, dollars, spendInput, type SpendLimit } from "./agent-spend-policy.ts";
import { transaction, withSql, type PostgresEnv, type Sql } from "./postgres.ts";

export { spendInput, type SpendLimit } from "./agent-spend-policy.ts";
export type AgentSpend = SpendLimit;
export type SpendLimitError = HttpError & { stopLimit: "agent" | "run" };

/** The source table is keyed by agent only. Every public read or mutation checks its tenant first. */
async function owned(sql: Sql, tenant: string, agent: string, lock = false, includeRevoked = false) {
  const row = (await sql.query(
    `select id from agents where id=$1 and tenant=$2${includeRevoked ? "" : " and not revoked"}${lock ? " for update" : ""}`,
    [agent, tenant],
  )).rows[0];
  if (!row) throw new HttpError(404, "Agent not found", "NOT_FOUND");
}

function checked(spend: SpendLimit): SpendLimit {
  if (!Number.isFinite(spend.usd) || spend.usd < 0 || spend.usd > 1_000_000 ||
      !Number.isFinite(spend.spent) || spend.spent < 0 ||
      !Number.isSafeInteger(spend.setAt) || spend.setAt < 0) {
    throw new HttpError(503, "Agent spend limit is unavailable", "SPEND_LIMIT_UNAVAILABLE");
  }
  return spend;
}

async function setCounter(sql: Sql, agent: string, value: unknown, now: number): Promise<SpendLimit | null> {
  const usd = spendInput(typeof value === "number" ? { usd: value } : value);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid agent spend epoch");
  if (usd === null) {
    await sql.query(AGENT_SPEND_SQL.clear, [agent]);
    return null;
  }
  await sql.query(AGENT_SPEND_SQL.set, [agent, usd, now]);
  return { usd, spent: 0, setAt: now };
}

/** An explicit assignment, including the current value, starts the counter again. Omission never calls this. */
export function setAgentSpendLimit(sql: Sql, agent: string, value: number | { usd: number } | null, now?: number): Promise<void>;
export function setAgentSpendLimit(env: PostgresEnv, tenant: string, agent: string, value: unknown, now?: number): Promise<SpendLimit | null>;
export async function setAgentSpendLimit(target: Sql | PostgresEnv, tenantOrAgent: string, agentOrValue: string | number | { usd: number } | null, valueOrNow?: unknown, now = Date.now()): Promise<SpendLimit | null | void> {
  if (!("HYPERDRIVE" in target)) {
    await setCounter(target, tenantOrAgent, agentOrValue, valueOrNow === undefined ? Date.now() : Number(valueOrNow));
    return;
  }
  const env = target, tenant = tenantOrAgent, agent = String(agentOrValue);
  return transaction(env, async sql => {
    await owned(sql, tenant, agent, true);
    return setCounter(sql, agent, valueOrNow, now);
  });
}

/** The unchanged source counter, used only by receipts without provider attempt metering. */
export async function readAgentSpendCounter(env: PostgresEnv, tenant: string, agent: string): Promise<SpendLimit | null> {
  return withSql(env, async sql => {
    await owned(sql, tenant, agent);
    const row = (await sql.query(AGENT_SPEND_SQL.read, [agent])).rows[0];
    return row ? checked({ usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) }) : null;
  });
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
        and coalesce(attempt.context->>'superseded','')=''
    ) + (
      select coalesce(sum((receipt.message->'_workersAuxiliary'->>'costUsd')::double precision),0)
      from pi_usage_receipts as receipt
      where receipt.tenant=$1 and receipt.session_id=limits.agent and receipt.accounted
        and receipt.entry_id<0 and receipt.message ? '_workersAuxiliary'
        and (receipt.message->'_workersAuxiliary'->>'startedAt')::bigint>=limits.set_at
    ) where limits.agent=$2
      and exists(select 1 from agents where agents.id=limits.agent and agents.tenant=$1)
    returning limits.usd,limits.spent,limits.set_at`, [tenant, agent])).rows[0];
  return row ? checked({ usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) }) : null;
}

/** Read at admission and between requests. Never add the same run's usage to these already metered totals. */
export async function readAgentSpendLimit(env: PostgresEnv, tenant: string, agent: string, options: { includeRevoked?: boolean } = {}): Promise<SpendLimit | null> {
  return withSql(env, async sql => {
    // Directory revokes first to block new callers. Its DO still needs the
    // same owned counter while reopening the harness to abort and settle.
    await owned(sql, tenant, agent, false, options.includeRevoked);
    return agentSpend(sql, tenant, agent);
  });
}

export async function runSpend(sql: Sql, tenant: string, agent: string, requestId: string): Promise<number> {
  const row = (await sql.query(`select (
      select coalesce(sum((totals->>'cost')::double precision),0)
      from model_attempts where tenant=$1 and agent=$2 and context->>'requestId'=$3
        and coalesce(context->>'superseded','')=''
    ) + (
      select coalesce(sum((message->'_workersAuxiliary'->>'costUsd')::double precision),0)
      from pi_usage_receipts where tenant=$1 and session_id=$2 and accounted
        and entry_id<0 and message ? '_workersAuxiliary' and message->'_workersAuxiliary'->>'requestId'=$3
    ) as spent`, [tenant, agent, requestId])).rows[0];
  const spent = Number(row.spent);
  if (!Number.isFinite(spent) || spent < 0) throw new HttpError(503, "Run spend is unavailable", "SPEND_LIMIT_UNAVAILABLE");
  return spent;
}

/** Source priority and wording: the agent's limit, then this run's own budget. */
export async function modelSpendLimit(sql: Sql, context: { tenant: string; agent: string; requestId?: string; spendLimit?: number }): Promise<SpendLimitError | undefined> {
  const message = agentSpendMessage(context.agent, await agentSpend(sql, context.tenant, context.agent));
  if (message) return Object.assign(new HttpError(402, message, "SPEND_LIMIT"), { stopLimit: "agent" as const });
  if (context.requestId !== undefined && context.spendLimit !== undefined) {
    const spent = await runSpend(sql, context.tenant, context.agent, context.requestId);
    if (spent >= context.spendLimit)
      return Object.assign(new HttpError(402, `This run has reached its spend limit of ${dollars(context.spendLimit)} (${dollars(spent)} spent)`, "SPEND_LIMIT"), { stopLimit: "run" as const });
  }
}

/** The generation's uncommitted usage belongs only to the limit epoch it started under. */
export function pendingAgentSpend(spend: SpendLimit | null, setAt: number | null | undefined, pendingUsd: number): number {
  if (!Number.isFinite(pendingUsd) || pendingUsd < 0) throw new Error("Invalid pending agent spend");
  return spend && spend.setAt === setAt ? pendingUsd : 0;
}

export function remainingAgentSpend(spend: SpendLimit | null, pendingUsd = 0): number {
  if (!spend) return Infinity;
  checked(spend);
  if (!Number.isFinite(pendingUsd) || pendingUsd < 0) throw new Error("Invalid pending agent spend");
  return Math.max(0, spend.usd - spend.spent - pendingUsd);
}

/** Match the source's 402 and mid-run refusal, including overshoot after a model response. */
export function agentSpendRefusal(agent: string, spend: SpendLimit | null, pendingUsd = 0) {
  if (!spend) return undefined;
  checked(spend);
  if (!Number.isFinite(pendingUsd) || pendingUsd < 0) throw new Error("Invalid pending agent spend");
  const error = agentSpendMessage(agent, { ...spend, spent: spend.spent + pendingUsd });
  return error ? { error, code: "spend_limit" as const, stopped: "spend_limit" as const, limit: "agent" as const } : undefined;
}

export function agentSpendView(spend: SpendLimit | null) {
  return spend ? { usd: spend.usd, spent: spend.spent } : null;
}

/**
 * Only for unmetered receipts, inside settlement's existing idempotency transaction after its duplicate check.
 * Provider-metered requests use agentSpend's authoritative attempt totals instead.
 * Capture setAt in the durable receipt before doing billable work: a late receipt must not
 * charge a replacement limit. The exact source update deliberately ignores a replaced epoch.
 */
export async function writeAgentSpend(sql: Sql, agent: string, setAt: number | null | undefined, costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Invalid agent spend charge");
  if (setAt === null || setAt === undefined || costUsd === 0) return;
  if (!Number.isSafeInteger(setAt) || setAt < 0) throw new Error("Invalid agent spend epoch");
  await sql.query(AGENT_SPEND_SQL.write, [agent, costUsd, setAt]);
}
