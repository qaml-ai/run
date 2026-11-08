import { withSql, type PostgresEnv } from './postgres.ts';

/** The runtime writes this relation; public configuration cannot choose a parent. */
export async function recordChildParent(env: PostgresEnv, tenant: string, child: string, parent: string, run: string) {
  await withSql(env, sql => sql.query(
    `update agents set header=header::jsonb || jsonb_build_object('parentAgentId',$3::text,'parentRunId',$4::text)
     where tenant=$1 and id=$2 and not revoked
     and (header->>'parentAgentId' is null or (header->>'parentAgentId'=$3 and header->>'parentRunId'=$4))`,
    [tenant, child, parent, run],
  ));
}

/** The parent that made this agent (delegate, spawn_agent), as recorded when it was made: undefined for any other agent. */
export async function childParent(env: PostgresEnv, tenant: string, child: string): Promise<string | undefined> {
  const { rows } = await withSql(env, sql => sql.query(
    `select header->>'parentAgentId' as parent from agents where tenant=$1 and id=$2 and not revoked`,
    [tenant, child],
  ));
  return (rows[0]?.parent as string | null | undefined) ?? undefined;
}
