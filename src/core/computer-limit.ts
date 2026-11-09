import type { Sql } from './host.ts';
import { HttpError } from './http-error.ts';

export const COMPUTER_LIMIT = { default: 4, max: 64 } as const;
export const COMPUTER_LIMIT_REACHED = 'This agent tree has reached its concurrent computer limit. Use computer: "share" or wait for a child to finish and release its machine.';
export function computerLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > COMPUTER_LIMIT.max) throw new HttpError(400, 'computerLimit must be an integer from 1 to 64');
  return value as number;
}
/** A permit is reserved in the same transaction as the root lock, before provider I/O. */
export async function reserveComputer(sql: Sql, tenant: string, agent: string, machine: string, expiresAt: number, now = Date.now(), tenantDefault?: number) {
  const chain = (await sql.query(`with recursive lineage as (
    select id,header,0 as depth from agents where tenant=$1 and id=$2
    union all select a.id,a.header,l.depth+1 from agents a join lineage l on a.id=coalesce(l.header->'parent'->>'agentId',l.header->>'parentAgentId') where a.tenant=$1 and l.depth<64
  ) select id,header from lineage order by depth desc limit 1`, [tenant, agent])).rows[0];
  const root = chain?.id ?? agent;
  await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-limit:${tenant}:${root}`]);
  const own = computerLimit(chain?.header?.config?.computerLimit);
  const defaults = (await sql.query('select limits from tenants where id=$1', [tenant])).rows[0]?.limits;
  const limit = own ?? computerLimit(tenantDefault ?? defaults?.computerLimit) ?? COMPUTER_LIMIT.default;
  const existing = (await sql.query('select 1 from computer_slots where tenant=$1 and machine=$2 and expires_at>$3', [tenant, machine, now])).rowCount;
  if (!existing) {
    const used = Number((await sql.query(`with recursive descendants as (
      select id,header,0 as depth from agents where tenant=$1 and id=$2
      union all select a.id,a.header,d.depth+1 from agents a join descendants d on coalesce(a.header->'parent'->>'agentId',a.header->>'parentAgentId')=d.id where a.tenant=$1 and d.depth<64
    ), running as (
      select machine from computer_slots where tenant=$1 and root=$2 and expires_at>$3
      union select connection from managed_computers where tenant=$1 and agent in (select id from descendants) and ended_at is null and deadline>$3 and not exists (select 1 from computer_slots s where s.tenant=$1 and s.machine=managed_computers.connection)
      union select connection from computer_leases where tenant=$1 and agent in (select id from descendants) and state in ('starting','active','uncertain','closing') and expires_at>$3 and not exists (select 1 from computer_slots s where s.tenant=$1 and s.machine=computer_leases.connection)
    ) select count(*) as n from running`, [tenant, root, now])).rows[0].n);
    if (used >= limit) throw new HttpError(409, COMPUTER_LIMIT_REACHED, 'COMPUTER_LIMIT');
  }
  await sql.query('insert into computer_slots(tenant,machine,root,expires_at) values($1,$2,$3,$4) on conflict(tenant,machine) do update set root=excluded.root,expires_at=greatest(computer_slots.expires_at,excluded.expires_at)', [tenant, machine, root, expiresAt]);
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
