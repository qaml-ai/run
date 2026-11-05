import { HttpError } from "./errors.ts";
import { AGENT_SPEND_SQL, agentSpendMessage, spendInput, type SpendLimit } from "./agent-spend-policy.ts";
import { transaction, withSql, type PostgresEnv, type Sql } from "./postgres.ts";

export { spendInput, type SpendLimit } from "./agent-spend-policy.ts";

/** The source table is keyed by agent only. Every public read or mutation checks its tenant first. */
async function owned(sql: Sql, tenant: string, agent: string, lock = false) {
  const row = (await sql.query(
    `select id from agents where id=$1 and tenant=$2 and not revoked${lock ? " for update" : ""}`,
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

/** An explicit assignment, including the current value, starts the counter again. Omission never calls this. */
export async function setAgentSpendLimit(env: PostgresEnv, tenant: string, agent: string, value: unknown, now = Date.now()): Promise<SpendLimit | null> {
  const usd = spendInput(value);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid agent spend epoch");
  return transaction(env, async sql => {
    await owned(sql, tenant, agent, true);
    if (usd === null) {
      await sql.query(AGENT_SPEND_SQL.clear, [agent]);
      return null;
    }
    await sql.query(AGENT_SPEND_SQL.set, [agent, usd, now]);
    return { usd, spent: 0, setAt: now };
  });
}

/** Read at admission and between model requests. A database failure must not become an unlimited budget. */
export async function readAgentSpendLimit(env: PostgresEnv, tenant: string, agent: string): Promise<SpendLimit | null> {
  return withSql(env, async sql => {
    await owned(sql, tenant, agent);
    const row = (await sql.query(AGENT_SPEND_SQL.read, [agent])).rows[0];
    return row ? checked({ usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) }) : null;
  });
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
 * Call only inside settlement's existing idempotency transaction, after its duplicate check.
 * Capture setAt in the durable receipt before doing billable work: a late receipt must not
 * charge a replacement limit. The exact source update deliberately ignores a replaced epoch.
 */
export async function writeAgentSpend(sql: Sql, agent: string, setAt: number | null | undefined, costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Invalid agent spend charge");
  if (setAt === null || setAt === undefined || costUsd === 0) return;
  if (!Number.isSafeInteger(setAt) || setAt < 0) throw new Error("Invalid agent spend epoch");
  await sql.query(AGENT_SPEND_SQL.write, [agent, costUsd, setAt]);
}
