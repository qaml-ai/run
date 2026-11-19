import { transaction, type Db } from "./db.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import type { ClosedV1InputWitness } from "./agent-v2-input-witness.ts";

export const AGENT_V2_PUBLISHED = "agent_v2_published";

/** Fence new v1 runs only after accepted work is durably idle. The caller holds application edits
 * and other ingress during the final copy and route publication. */
export function fenceV1Agent(db: Db, tenant: string, agent: string, operation: string, closedInputs?: ClosedV1InputWitness) {
  return transaction(db, async sql => {
    // Keep this lock key compatible with BusyAgents.hold on already deployed v1 nodes.
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`busy-agents:${tenant}`]);
    if (closedInputs && !await closedInputs.matchesLockedSource(sql, tenant, agent)) return false;
    // pending_runs stays set until unload has persisted the final cursor. A cleared busy slot
    // alone is too early, and an expired node lease alone says nothing about durable work.
    const { rowCount } = await sql.query(`
      insert into agent_v2_cutovers (agent, tenant, operation)
      select a.id, a.tenant, $3 from agents a
      where a.id = $1 and a.tenant = $2 and not a.revoked and a.purged_at is null
        and (a.expires_at is null or a.expires_at > $4)
        and (
          not a.pending_runs
          and not exists (
            select from busy_agents b join runtime_nodes n on n.node = b.node and n.session = b.session
            where b.agent = a.id and b.tenant = a.tenant and n.expires_at > now()
          )
          -- A settled input can still be between recording the answer and admitting its continuation.
          and ($5::boolean or not exists (select from agent_inputs i where i.agent = a.id))
          and not exists (select from agent_children c where c.parent = a.id and c.state = 'running')
          and not exists (select from agent_children c where c.child = a.id and c.state = 'running')
          and not exists (select from schedules s where s.agent = a.id)
          and not exists (select from channel_agents c where c.agent = a.id)
          and not exists (select from agent_triggers t where t.agent = a.id and t.disabled_at is null)
          and not exists (select from voice_calls v where v.agent = a.id and v.tenant = a.tenant and v.state <> 'ended')
        )
      on conflict (tenant, agent) do update set operation = excluded.operation
      where agent_v2_cutovers.operation = excluded.operation`, [agent, tenant, operation, Date.now(), !!closedInputs]);
    return rowCount === 1;
  });
}

/** Undo a fence owned by this operation before it has published a v2 route. */
export async function unfenceV1Agent(db: Db, tenant: string, agent: string, operation: string) {
  const { rowCount } = await db.query(
    `delete from agent_v2_cutovers where agent = $1 and tenant = $2 and operation = $3
      and not exists (select 1 from agent_v2_routes where agent = $1 and tenant = $2)`,
    [agent, tenant, operation],
  );
  return rowCount === 1;
}

/** Publish the verified destination of one cutover. The operation must still own the fence.
 * A published route is immutable, and its foreign key prevents reopening admission on v1. */
export function publishV2AgentRoute(
  db: Db,
  source: { tenant: string; agent: string; operation: string },
  destination: { tenant: string; agent: string },
  archive: RequestRecord[],
  closedInputs?: ClosedV1InputWitness,
) {
  return transaction(db, async sql => {
    if (closedInputs) {
      if (!closedInputs.includesRequiredReceipts(archive)) return false;
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`busy-agents:${source.tenant}`]);
      if (!await closedInputs.matchesLockedSource(sql, source.tenant, source.agent)) return false;
    }
    const key = [source.tenant, source.agent, source.operation];
    const fence = await sql.query(`
      select 1 from agent_v2_cutovers where tenant = $1 and agent = $2 and operation = $3 for update`, key);
    if (fence.rowCount !== 1) return false;
    const { rowCount } = await sql.query(`
      insert into agent_v2_routes (tenant, agent, destination_tenant, destination_agent, event_base)
      select tenant, id, $3, $4, greatest(last_cursor, reserved_cursor, $5)
      from agents a where tenant = $1 and id = $2
        and ($6::boolean or not exists (select from agent_inputs i where i.agent = a.id))
      on conflict (tenant, agent) do update set destination_agent = excluded.destination_agent
      where agent_v2_routes.destination_tenant = excluded.destination_tenant
        and agent_v2_routes.destination_agent = excluded.destination_agent`,
    [source.tenant, source.agent, destination.tenant, destination.agent, Date.now() * 1000, !!closedInputs]);
    if (rowCount === 1) {
      const archiveKey = [source.tenant, source.agent, JSON.stringify(archive)];
      if (closedInputs) {
        await sql.query(`insert into agent_v2_receipt_archives (tenant, agent, receipts, inputs) values ($1, $2, $3::jsonb, $4::jsonb)
          on conflict (tenant, agent) do nothing`, [...archiveKey, JSON.stringify(closedInputs.archivedInputs)]);
      } else {
        await sql.query(`insert into agent_v2_receipt_archives (tenant, agent, receipts) values ($1, $2, $3::jsonb)
          on conflict (tenant, agent) do nothing`, archiveKey);
      }
      await sql.query("select pg_notify($1, $2)", [AGENT_V2_PUBLISHED, source.agent]);
    }
    return rowCount === 1;
  });
}
