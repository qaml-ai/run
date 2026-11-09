import type { Sql } from "./host.ts";

/** Shares are flattened so grandchildren use the same owner and machine. */
export async function computerOwner(sql: Sql, tenant: string, agent: string): Promise<string> {
  return (await sql.query("select owner from computer_shares where tenant=$1 and agent=$2", [tenant, agent])).rows[0]?.owner ?? agent;
}
export async function shareComputer(sql: Sql, tenant: string, parent: string, child: string) {
  const owner = await computerOwner(sql, tenant, parent);
  await sql.query("insert into computer_shares(tenant,agent,owner) values($1,$2,$3) on conflict (agent) do nothing", [tenant, child, owner]);
}
/** A missing row is an independent agent; a NULL owner explicitly opts out. */
export async function computerDisabled(sql: Sql, tenant: string, agent: string): Promise<boolean> {
  const row = (await sql.query("select owner from computer_shares where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
  return !!row && row.owner === null;
}
export async function disableComputer(sql: Sql, tenant: string, child: string) {
  await sql.query("insert into computer_shares(tenant,agent,owner) values($1,$2,null) on conflict (agent) do nothing", [tenant, child]);
}
export const SHARED_COMPUTER_CONTROL = "This is the parent's machine. A sharing child cannot start, stop or replace it; ask the parent to manage its machine.";
