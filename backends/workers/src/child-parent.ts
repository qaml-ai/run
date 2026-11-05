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
