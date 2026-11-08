import { withSql, type PostgresEnv } from './postgres.ts';
import { MULTI_AGENT_LIMITS } from './multi-agent-policy.ts';

/** A sub-agent's place in its chain as its parent made it: its depth, its chain's limit and its chain (its parent last). */
export type ChildPlace = { payer?: string; depth: number; maxDepth: number; chain: string[] };

/** The runtime writes this relation; public configuration cannot choose a parent. */
export async function recordChildParent(env: PostgresEnv, tenant: string, child: string, parent: string, run: string, place: ChildPlace) {
  await withSql(env, sql => sql.query(
    `update agents set header=header::jsonb || jsonb_build_object('parentAgentId',$3::text,'parentRunId',$4::text,'parentPlace',$5::jsonb)
     where tenant=$1 and id=$2 and not revoked
     and (header->>'parentAgentId' is null or (header->>'parentAgentId'=$3 and header->>'parentRunId'=$4))`,
    [tenant, child, parent, run, JSON.stringify(place)],
  ));
}

/**
 * The place a sub-agent the runtime made was made at, for a turn of its signed into no chain (one a notification or
 * message of the runtime's started): undefined for any other agent. One made before its place was recorded has its parent alone.
 */
export async function madePlace(env: PostgresEnv, tenant: string, child: string): Promise<ChildPlace | undefined> {
  const { rows } = await withSql(env, sql => sql.query(
    `select header->>'parentAgentId' as parent, header->'parentPlace' as place from agents where tenant=$1 and id=$2 and not revoked`,
    [tenant, child],
  ));
  const parent = rows[0]?.parent as string | null | undefined;
  if (!parent) return undefined;
  const place = rows[0].place as ChildPlace | null;
  return place ?? { depth: 1, maxDepth: MULTI_AGENT_LIMITS.depthCeiling, chain: [parent] };
}

/** The parent that made this agent (delegate, spawn_agent), as recorded when it was made: undefined for any other agent. */
export async function childParent(env: PostgresEnv, tenant: string, child: string): Promise<string | undefined> {
  const { rows } = await withSql(env, sql => sql.query(
    `select header->>'parentAgentId' as parent from agents where tenant=$1 and id=$2 and not revoked`,
    [tenant, child],
  ));
  return (rows[0]?.parent as string | null | undefined) ?? undefined;
}
