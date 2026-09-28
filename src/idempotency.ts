import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

/** How long a key's answer is kept, as Stripe keeps them. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/**
 * `Idempotency-Key` on a POST, as Stripe's: the first request with a key runs, and its success is kept
 * for a day; a retry with the same method, path and body gets that answer again (marked
 * `Idempotent-Replayed: true`), and anything else with the key a 409. A failure is not kept, so a retry
 * runs again, and a retry while the first still runs is a 409. Keys are the tenant's own. `skip` names
 * routes whose own idempotency the key already is (an agent's key, a prompt's request id).
 */
export function idempotency(database: () => Db, tenantOf: (c: Context) => string, skip: (method: string, path: string) => boolean) {
  return async (c: Context, next: Next) => {
    const key = c.req.header("idempotency-key");
    if (c.req.method !== "POST" || key === undefined || skip(c.req.method, c.req.path)) return next();
    if (!key || key.length > 255) throw new HttpError(400, "Idempotency-Key must be 1–255 characters");
    const tenant = tenantOf(c);
    const db = database();
    const body = c.req.raw.body ? Buffer.from(await c.req.raw.clone().arrayBuffer()) : Buffer.alloc(0);
    const fingerprint = createHash("sha256").update(`${c.req.method} ${c.req.path}\n`).update(body).digest("hex");
    const now = Date.now();
    await db.query("delete from idempotency_keys where tenant = $1 and key = $2 and created_at < $3", [tenant, key, now - IDEMPOTENCY_TTL_MS]);
    const taken = await db.query("insert into idempotency_keys (tenant, key, fingerprint, created_at) values ($1, $2, $3, $4) on conflict do nothing", [tenant, key, fingerprint, now]);
    if (!taken.rowCount) {
      const row = (await db.query("select fingerprint, status, body, content_type from idempotency_keys where tenant = $1 and key = $2", [tenant, key])).rows[0];
      if (!row) throw new HttpError(409, "A request with this Idempotency-Key just finished; retry");
      if (row.fingerprint !== fingerprint) throw new HttpError(409, "This Idempotency-Key was sent with another request: a key is for one method, path and body");
      if (row.status === null) throw new HttpError(409, "A request with this Idempotency-Key is still running; retry");
      return new Response(row.body, { status: row.status, headers: { "Content-Type": row.content_type ?? "application/json", "Idempotent-Replayed": "true" } });
    }
    let kept = false;
    try {
      await next();
      const response = c.res;
      if (response.ok && response.body) {
        await db.query("update idempotency_keys set status = $3, body = $4, content_type = $5 where tenant = $1 and key = $2",
          [tenant, key, response.status, await response.clone().text(), response.headers.get("content-type")]);
        kept = true;
      }
    } finally {
      if (!kept) await db.query("delete from idempotency_keys where tenant = $1 and key = $2 and status is null", [tenant, key]).catch(() => {});
    }
  };
}

/** Forget keys older than a day. */
export async function expireIdempotencyKeys(db: Db, now = Date.now()) {
  await db.query("delete from idempotency_keys where created_at < $1", [now - IDEMPOTENCY_TTL_MS]);
}
