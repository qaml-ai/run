import { HttpError } from "./errors.ts";
import { modelSpendLimit } from "./agent-spend.ts";
import { withSql, type PostgresEnv, type Sql } from "./postgres.ts";

export type AuxiliaryCall = {
  tenant: string;
  agent: string;
  requestId?: string;
  /** Pi's durable tool call ID, including the run ID if the provider reuses call IDs. */
  callId: string;
  kind: "decision" | "web_search" | "x_search" | "web_fetch" | "image" | "transcription" | "computer";
  /** Captured before the external call, so a late answer cannot charge a reset budget. */
  startedAt: number;
};
export type AuxiliaryCost = { costUsd: number; provider?: string; model?: string };

/**
 * Check before sending any external request. A platform call must first acquire
 * its existing billing hold; absence of that integration is a refusal, not free use.
 */
export async function admitAuxiliaryUsage(env: PostgresEnv, call: Omit<AuxiliaryCall, "callId" | "kind" | "startedAt"> & { spendLimit?: number }, platform = false, admitPlatform?: () => Promise<void>) {
  await withSql(env, async sql => {
    const owned = (await sql.query("select id from agents where id=$1 and tenant=$2 and not revoked", [call.agent, call.tenant])).rows[0];
    if (!owned) throw new HttpError(404, "Agent not found", "NOT_FOUND");
    const limit = await modelSpendLimit(sql, call);
    if (limit) throw limit;
  });
  if (platform) {
    if (!admitPlatform) throw new HttpError(503, "Platform auxiliary usage requires billing admission", "BILLING_UNAVAILABLE");
    await admitPlatform();
  }
}

async function entryId(call: AuxiliaryCall) {
  const data = new TextEncoder().encode(JSON.stringify([call.kind, call.requestId ?? null, call.callId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  // Source transcript entry IDs are nonnegative. Reserve the negative half of
  // the same existing receipt keyspace, checking the full identity on conflict.
  let value = 0n;
  for (const byte of digest.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  return String(-((value & ((1n << 63n) - 1n)) || 1n));
}

/**
 * Add raw tool cost to the existing durable accounting journal. Call from the
 * SAME transaction as the tool's charge and usage writes, and only write those
 * when true is returned. Already-accounted receipts never enter the model outbox.
 */
export async function recordAuxiliaryUsage(sql: Sql, call: AuxiliaryCall, cost: AuxiliaryCost, owner: "agent" | "workflow" = "agent"): Promise<boolean> {
  if (!call.callId || call.callId.length > 500 || !Number.isSafeInteger(call.startedAt) || call.startedAt < 0 ||
      !Number.isFinite(cost.costUsd) || cost.costUsd < 0) throw new HttpError(400, "Invalid auxiliary usage receipt");
  const message = { _workersAuxiliary: {
    kind: call.kind, callId: call.callId, requestId: call.requestId ?? null, startedAt: call.startedAt,
    costUsd: cost.costUsd, provider: cost.provider ?? null, model: cost.model ?? null,
  } };
  const id = await entryId(call);
  // An agent's receipt needs the agent; a workflow's (owner "workflow": `agent` is its id, which no agents row has) is
  // keyed the same way, so a charge made again under the same call finds it.
  const inserted = await sql.query(`insert into pi_usage_receipts(session_id,entry_id,tenant,message,accounted)
    select $1,$2,$3,$4,true where $5 or exists(select 1 from agents where id=$1 and tenant=$3)
    on conflict(session_id,entry_id) do nothing returning entry_id`, [call.agent, id, call.tenant, JSON.stringify(message), owner === "workflow"]);
  if (inserted.rowCount) return true;
  const previous = (await sql.query("select tenant,message from pi_usage_receipts where session_id=$1 and entry_id=$2", [call.agent, id])).rows[0];
  if (!previous) throw new HttpError(404, "Agent not found", "NOT_FOUND");
  const prior = previous.message?._workersAuxiliary;
  // Replayed tasks can reopen after the clock has moved; the first durable
  // receipt keeps the original epoch. Identity and cost must still match.
  if (previous.tenant !== call.tenant || !prior || Object.keys(message._workersAuxiliary).filter(key => key !== "startedAt").some(key => prior[key] !== message._workersAuxiliary[key as keyof typeof message._workersAuxiliary]))
    throw new HttpError(409, "Auxiliary usage receipt changed", "IDEMPOTENCY_CONFLICT");
  return false;
}

/** Public run usage keeps the raw tool subtotals alongside the model token cost. */
export async function auxiliaryUsageCosts(env: PostgresEnv, tenant: string, agent: string, requestId: string) {
  return withSql(env, async sql => {
    const row = (await sql.query(`select
      coalesce(sum((message->'_workersAuxiliary'->>'costUsd')::double precision) filter(where message->'_workersAuxiliary'->>'kind'='decision'),0) as decision,
      coalesce(sum((message->'_workersAuxiliary'->>'costUsd')::double precision) filter(where message->'_workersAuxiliary'->>'kind'='image'),0) as image,
      coalesce(sum((message->'_workersAuxiliary'->>'costUsd')::double precision) filter(where message->'_workersAuxiliary'->>'kind'='transcription'),0) as transcription,
      coalesce(sum((message->'_workersAuxiliary'->>'costUsd')::double precision) filter(where message->'_workersAuxiliary'->>'kind' in ('web_search','x_search','web_fetch')),0) as web
      from pi_usage_receipts where tenant=$1 and session_id=$2 and accounted and entry_id<0
      and message ? '_workersAuxiliary' and message->'_workersAuxiliary'->>'requestId'=$3`, [tenant, agent, requestId])).rows[0];
    return { decisionCostUsd: Number(row.decision), imageCostUsd: Number(row.image), webCostUsd: Number(row.web), transcriptionCostUsd: Number(row.transcription) };
  });
}

export const auxiliaryRunCosts = auxiliaryUsageCosts;
