import { digest } from "./api-contract.ts";
import { withSql, type PostgresEnv } from "./postgres.ts";

/** A deleted keyed agent leaves a tombstone; its key names a fresh generation. */
export async function resolveAgentKey(env: PostgresEnv, tenant: string, key: string): Promise<string> {
  if (/^client_[a-f0-9]{40}$/.test(key)) return key;
  const live = await withSql(env, sql => sql.query("SELECT id FROM agents WHERE tenant=$1 AND NOT revoked AND header->>'key'=$2 LIMIT 1", [tenant, key]));
  if (live.rows[0]) return live.rows[0].id;
  let id = `client_${(await digest(`${tenant}:${key}`)).slice(0, 40)}`;
  for (;;) {
    const previous = await withSql(env, sql => sql.query("SELECT revoked FROM agents WHERE id=$1 AND tenant=$2", [id, tenant]));
    if (!previous.rows[0]?.revoked) return id;
    id = `client_${(await digest(`${tenant}:${key}:${id}`)).slice(0, 40)}`;
  }
}
