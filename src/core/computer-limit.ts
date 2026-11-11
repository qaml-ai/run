import type { Sql } from './host.ts';
import { HttpError } from './http-error.ts';

export const COMPUTER_LIMIT = { default: 4, max: 64 } as const;
export const COMPUTER_LIMIT_REACHED = 'This agent tree has reached its concurrent computer limit. Use computer: "share" or wait for a child to finish and release its machine.';
export const COMPUTER_TOOL_LIMIT_REACHED = 'This agent tree already runs its limit of machines. Use computer "share" for new sub-agents, or wait until one finishes.';
export function computerToolError(error: unknown): unknown {
  return (error as { code?: string })?.code === 'COMPUTER_LIMIT'
    ? new HttpError(409, COMPUTER_TOOL_LIMIT_REACHED, 'COMPUTER_LIMIT') : error;
}
export function computerLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > COMPUTER_LIMIT.max) throw new HttpError(400, 'computerLimit must be an integer from 1 to 64');
  return value as number;
}
/**
 * The root of an agent's tree as stored when it was made: its header's `rootOwner` (the owner model), else the chain
 * older code stored with its parent (Node's `parent.chain`, Workers' `parentPlace.chain`), else its parent. Read, never
 * found by walking `agents`.
 */
export const STORED_ROOT = (agents: string) => `coalesce(${agents}.header->'rootOwner'->>'id', ${agents}.header->'parent'->'chain'->>0,
  ${agents}.header->'parentPlace'->'chain'->>0, ${agents}.header->'parent'->>'agentId', ${agents}.header->>'parentAgentId', ${agents}.id)`;

/** A permit is reserved in the same transaction as the root lock, before provider I/O. */
export async function reserveComputer(sql: Sql, tenant: string, agent: string, machine: string, expiresAt: number, now = Date.now(), tenantDefault?: number) {
  const root = (await sql.query(`select ${STORED_ROOT('a')} as root from agents a where a.tenant=$1 and a.id=$2`, [tenant, agent])).rows[0]?.root as string | undefined ?? agent;
  await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-limit:${tenant}:${root}`]);
  // The tree's own limit is its root agent's (a workflow root has none: the tenant's applies).
  const rootHeader = (await sql.query('select header from agents where tenant=$1 and id=$2', [tenant, root])).rows[0]?.header;
  const own = computerLimit(rootHeader?.config?.computerLimit);
  const defaults = (await sql.query('select limits from tenants where id=$1', [tenant])).rows[0]?.limits;
  const limit = own ?? computerLimit(tenantDefault ?? defaults?.computerLimit) ?? COMPUTER_LIMIT.default;
  // The slot ledger is authoritative. Import pre-ledger sessions only from this tree, and let expired slots stop counting.
  // Reconcile only this tree's ended sessions, without touching provider APIs. A newer reservation is fenced
  // from an older session's end, and in-flight traffic cannot lose its permit.
  await sql.query(`update computer_slots s set expires_at=0 where s.tenant=$1 and s.root=$2
    and s.expires_at>0 and (s.in_flight=0 or s.busy_until<=$3) and (
      exists(select 1 from managed_computers m where m.tenant=s.tenant and m.connection=s.machine and m.ended_at>s.acquired_at)
      or exists(select 1 from computer_leases l where l.tenant=s.tenant and l.connection=s.machine and l.closed_at>s.acquired_at)
    ) and not exists(select 1 from managed_computers m where m.tenant=s.tenant and m.connection=s.machine and m.ended_at is null)
      and not exists(select 1 from computer_leases l where l.tenant=s.tenant and l.connection=s.machine and l.state<>'closed')`, [tenant, root, now]);
  // Pre-ledger sessions of this tree: the tenant's live sessions whose agent's stored root is this one.
  await sql.query(`with legacy as (
    select m.connection as machine,m.deadline as expires_at from managed_computers m join agents a on a.tenant=m.tenant and a.id=m.agent
      where m.tenant=$1 and m.ended_at is null and m.deadline>$3 and ${STORED_ROOT('a')}=$2
    union all select l.connection,l.expires_at from computer_leases l join agents a on a.tenant=l.tenant and a.id=l.agent
      where l.tenant=$1 and l.state in ('starting','active','uncertain','closing') and l.expires_at>$3 and ${STORED_ROOT('a')}=$2
  ) insert into computer_slots(tenant,machine,root,expires_at)
    select $1,machine,$2,max(expires_at) from legacy group by machine on conflict(tenant,machine) do nothing`, [tenant, root, now]);
  const existing = (await sql.query('select 1 from computer_slots where tenant=$1 and machine=$2 and expires_at>$3', [tenant, machine, now])).rowCount;
  if (!existing) {
    const used = Number((await sql.query('select count(*) as n from computer_slots where tenant=$1 and root=$2 and expires_at>$3', [tenant, root, now])).rows[0].n);
    if (used >= limit) throw new HttpError(409, COMPUTER_LIMIT_REACHED, 'COMPUTER_LIMIT');
  }
  await sql.query('insert into computer_slots(tenant,machine,root,expires_at,acquired_at) values($1,$2,$3,$4,$5) on conflict(tenant,machine) do update set root=excluded.root,acquired_at=case when computer_slots.expires_at<=$5 then $5 else computer_slots.acquired_at end,expires_at=greatest(computer_slots.expires_at,excluded.expires_at)', [tenant, machine, root, expiresAt, now]);
}
export async function releaseComputer(sql: Sql, tenant: string, machine: string) {
  await sql.query('delete from computer_slots where tenant=$1 and machine=$2', [tenant, machine]);
}
/** A provider-observed stopped/saved machine keeps its marker, but occupies no slot. */
export async function suspendComputer(sql: Sql, tenant: string, machine: string, now = Date.now()) {
  await sql.query("insert into computer_slots(tenant,machine,root,expires_at) values($1,$2,'',0) on conflict(tenant,machine) do update set expires_at=0,in_flight=0,busy_until=0 where computer_slots.in_flight=0 or computer_slots.busy_until<=$3", [tenant, machine, now]);
}
/** Fence provider observations while traffic is starting or resuming a machine. */
export async function beginComputerUse(sql: Sql, tenant: string, machine: string, until: number) {
  await sql.query("update computer_slots set in_flight=in_flight+1,busy_until=greatest(busy_until,$3) where tenant=$1 and machine=$2", [tenant, machine, until]);
}
export async function endComputerUse(sql: Sql, tenant: string, machine: string) {
  await sql.query("update computer_slots set in_flight=greatest(0,in_flight-1) where tenant=$1 and machine=$2", [tenant, machine]);
}
