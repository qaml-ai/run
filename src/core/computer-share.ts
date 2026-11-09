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
/**
 * Whether an agent has a computer of its own kind (the Workers native one): it shares its parent's (a row with an
 * owner), or its configuration declares `computer` (`declared`: its definition's, or the one its parent gave it). A
 * NULL owner is none, whatever is declared. Nothing else gives an agent a computer: not the deployment offering them.
 */
export async function hasComputer(sql: Sql, tenant: string, agent: string, declared: boolean): Promise<boolean> {
  const row = (await sql.query("select owner from computer_shares where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
  return row ? row.owner !== null : declared;
}
export const NO_COMPUTER = "This agent has no computer: add `computer` to its definition";
export async function disableComputer(sql: Sql, tenant: string, child: string) {
  await sql.query("insert into computer_shares(tenant,agent,owner) values($1,$2,null) on conflict (agent) do nothing", [tenant, child]);
}
export const SHARED_COMPUTER_CONTROL = "This machine belongs to your parent agent: you can't start, stop or replace it. Finish your task and report back if it needs to change.";
export const SHARED_COMPUTER_STOPPED = "Your parent's machine is stopped. Finish your task and report back to your parent.";
