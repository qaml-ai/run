import type { Sql } from "./db.ts";

/**
 * Whether Postgres records `agent` as gone for good: deleted (revoked), purged (a tombstone), or past its expiry. Only
 * that durable fact counts: an agent that is busy, suspended, evicted, locked or moving between nodes is not gone, and
 * a delivery to it is retried. With `expiry: false`, expiry does not count. With `missing`, an agent with no row at all is gone too: say so only for an agent known
 * to have existed (its row is never deleted, only tombstoned, save by a create undone before the agent started), never
 * for one whose row may not be committed yet (a child being made).
 */
export async function agentGone(db: Sql, agent: string, options: { missing?: boolean; expiry?: boolean } = {}, now = Date.now()): Promise<boolean> {
  const row = (await db.query("select revoked, purged_at, expires_at from agents where id = $1", [agent])).rows[0];
  if (!row) return !!options.missing;
  // `expiry: false`: Postgres's expires_at is written lazily and can lag a live agent's own, so where nothing else (a
  // refused delivery) says the agent is gone, only its deletion counts.
  return !!row.revoked || row.purged_at !== null || (options.expiry !== false && row.expires_at !== null && Number(row.expires_at) <= now);
}

/** The one line a sender logs when it drops a delivery because its target agent is gone (`agentGone`). */
export function deliveryDropped(fields: Record<string, unknown>) {
  console.error(JSON.stringify({ type: "delivery_dropped_agent_gone", ...fields }));
}
