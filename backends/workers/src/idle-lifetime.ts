import type { ControlEnv } from "./control.ts";
import { withSql } from "./postgres.ts";

type Configuration = {
  id: string;
  tenantId: string;
  revision: number;
  expiresAt: number | null;
  config: { idleTtlSeconds?: number | null };
};

/** Match stillUsed in src/client-sessions.ts: write only after half the idle lifetime. */
export function nextIdleExpiry(configuration: Configuration, now = Date.now()) {
  const lifetime = (configuration.config.idleTtlSeconds ?? 0) * 1000;
  return lifetime > 0 && configuration.expiresAt !== null &&
    configuration.expiresAt > now && configuration.expiresAt - now <= lifetime / 2
    ? now + lifetime : undefined;
}

/** Postgres owns the public expiry; the object's copy follows the same revision. */
export async function refreshIdleLifetime(env: ControlEnv, storage: DurableObjectStorage, configuration: Configuration) {
  const expiry = nextIdleExpiry(configuration);
  if (expiry === undefined) return;
  const result = await withSql(env, sql => sql.query(
    `update agents set expires_at=greatest(expires_at,$4),
       header=jsonb_set(header::jsonb,'{expiresAt}',to_jsonb(greatest(expires_at,$4)))::json
     where id=$1 and tenant=$2 and revision=$3 and not revoked
     returning expires_at`,
    [configuration.id, configuration.tenantId, configuration.revision, expiry],
  ));
  if (!result.rows.length) return;
  const expiresAt = Number(result.rows[0].expires_at);
  await storage.transaction(async tx => {
    const current = await tx.get<Configuration>("configuration");
    if (current?.revision === configuration.revision) {
      current.expiresAt = expiresAt;
      await tx.put("configuration", current);
    }
  });
  configuration.expiresAt = expiresAt;
}
