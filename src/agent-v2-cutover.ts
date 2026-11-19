import { transaction, type Db } from "./db.ts";

/** Fence new v1 runs only after accepted work is durably idle. The caller holds application edits
 * and other ingress during the final copy and route publication. */
export function fenceV1Agent(db: Db, tenant: string, agent: string, operation: string) {
  return transaction(db, async sql => {
    // Keep this lock key compatible with BusyAgents.hold on already deployed v1 nodes.
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`busy-agents:${tenant}`]);
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
          and not exists (select from agent_inputs i where i.agent = a.id)
          and not exists (select from agent_children c where c.parent = a.id and c.state = 'running')
          and not exists (select from agent_children c where c.child = a.id and c.state = 'running')
          and not exists (select from schedules s where s.agent = a.id)
          and not exists (select from channel_agents c where c.agent = a.id)
          and not exists (select from agent_triggers t where t.agent = a.id and t.disabled_at is null)
          and not exists (select from voice_calls v where v.agent = a.id and v.tenant = a.tenant and v.state <> 'ended')
        )
      on conflict (tenant, agent) do update set operation = excluded.operation
      where agent_v2_cutovers.operation = excluded.operation`, [agent, tenant, operation, Date.now()]);
    return rowCount === 1;
  });
}

/** Undo a fence owned by this operation before it has published a v2 route. */
export async function unfenceV1Agent(db: Db, tenant: string, agent: string, operation: string) {
  const { rowCount } = await db.query(
    "delete from agent_v2_cutovers where agent = $1 and tenant = $2 and operation = $3",
    [agent, tenant, operation],
  );
  return rowCount === 1;
}
