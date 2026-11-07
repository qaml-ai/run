import { withSql, type PostgresEnv } from './postgres.ts';

/** The runtime writes this relation; public configuration cannot choose a parent. */
export async function recordChildParent(env: PostgresEnv, tenant: string, child: string, parent: string, run: string, root: string) {
  await withSql(env, sql => sql.query(
    `update agents set header=header::jsonb || jsonb_build_object('parentAgentId',$3::text,'parentRunId',$4::text,'parentRootId',$5::text)
     where tenant=$1 and id=$2 and not revoked
     and (header->>'parentAgentId' is null or (header->>'parentAgentId'=$3 and header->>'parentRunId'=$4))`,
    [tenant, child, parent, run, root],
  ));
}

/**
 * The parent that made this agent and its chain's first, as recorded when it was made: the lineage of a run its parent
 * did not start (one prompted through the API). A child made before the root was recorded is a parent's own (depth 1).
 */
export async function childParent(env: PostgresEnv, tenant: string, child: string): Promise<{ parent: string; root: string } | undefined> {
  const { rows } = await withSql(env, sql => sql.query(
    `select header->>'parentAgentId' as parent, header->>'parentRootId' as root from agents where tenant=$1 and id=$2 and not revoked`,
    [tenant, child],
  ));
  const parent = rows[0]?.parent as string | null | undefined;
  return parent ? { parent, root: (rows[0].root as string | null) ?? parent } : undefined;
}
