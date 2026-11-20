import { createHmac } from "node:crypto";
import type { Sql } from "./db.ts";
import { HttpError } from "./http-error.ts";
import { expired, hash, validId, validSessionId } from "./v1-client-state.ts";

type CredentialRow = {
  tenant: string | null;
  key: string | null;
  rotation: number | null;
  config_hash: string | null;
  digest: string | null;
  expires_at: number | null;
  revoked: boolean;
  run: boolean;
};

/** The id of the agent `create` makes for a tenant's idempotency key. */
export function agentId(tenant: string, key: string) {
  return `client_${hash(`${tenant}:${key}`).slice(0, 40)}`;
}

/**
 * An agent's token: derived from its tenant and key (with the key's generation) until it is rotated, then from its
 * id and how many times it was, so rotating makes a new one even for an agent made without a key.
 */
export function agentToken(secret: string, tenant: string, scoped: string, id: string, rotation = 0) {
  return createHmac("sha256", secret).update(rotation ? `client-rotated:${tenant}:${id}:${rotation}` : `client-v2:${tenant}:${scoped}`).digest("hex");
}

/**
 * An existing agent's credentials, by its id or the key it was made with, without touching its configuration (an
 * upsert would set it to what the caller passes). The token is the one `create` gave: derived from the key and its
 * generation, so only an agent made with a key has one to give again; or, once rotated (`rotateToken`), the latest.
 */
export async function v1AgentCredentials(
  db: Pick<Sql, "query">, secret: string, tenant: string, ref: string,
  options: { localProvisionHash?: (id: string) => string | undefined; verifyDigest?: boolean } = {},
): Promise<{ id: string; token: string; expiresAt: number | null; configHash?: string }> {
  // A purged agent's tombstone still holds the ID for its key's generation.
  const live = async (id: string) => (await db.query<CredentialRow>(`select tenant, header->>'key' as key,
    (header->>'tokenRotation')::int as rotation, header->>'provisionHash' as config_hash, header->>'digest' as digest,
    expires_at, revoked, header->'run' is not null as run from agents where id = $1`, [id])).rows[0];
  const expiry = (row: CredentialRow) => row.expires_at === null ? null : Number(row.expires_at);
  // A stateless run's session is no agent: it has no credentials to give.
  const alive = (row: CredentialRow) => row.tenant === tenant && !row.revoked && !row.run && !expired(expiry(row));
  const found = (id: string, scoped: string, row: CredentialRow) => {
    const token = agentToken(secret, tenant, scoped, id, row.rotation ?? 0);
    if (options.verifyDigest && hash(token) !== row.digest) throw new HttpError(503, "Agent credentials are unavailable");
    const configHash = options.localProvisionHash?.(id) ?? row.config_hash;
    return { id, token, expiresAt: expiry(row), ...(configHash ? { configHash } : {}) };
  };
  if (validSessionId(ref)) {
    const row = await live(ref);
    if (row && alive(row)) {
      if (row.rotation) return found(ref, "", row);
      if (!row.key) throw new HttpError(409, "AGENT_KEYLESS: this agent was made without a key, so its token is only what its create answered");
      // Its generation: the key's agents before it were deleted or expired.
      for (let generation = 0; generation < 10_000; generation++) {
        const scoped = `${row.key}${generation ? `#${generation}` : ""}`;
        if (agentId(tenant, scoped) === ref) return found(ref, scoped, row);
      }
    }
  }
  if (validId(ref)) {
    for (let generation = 0; ; generation++) {
      const scoped = `${ref}${generation ? `#${generation}` : ""}`, id = agentId(tenant, scoped);
      const row = await live(id);
      if (!row) break;
      if (alive(row)) return found(id, scoped, row);
    }
  }
  throw new HttpError(404, "No agent has this id or key");
}
