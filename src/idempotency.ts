import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

/** How long a key's answer is kept, as Stripe keeps them. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** The largest body a request with a key may send: past it, 413 before it is read whole. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * `Idempotency-Key` on a POST, as Stripe's: the first request with a key runs, and its success is kept
 * for a day; a retry with the same method, path and body gets that answer again (marked
 * `Idempotent-Replayed: true`), and anything else with the key a 409. A failure is not kept, so a retry
 * runs again. A retry while the first still runs is a 409, until the first has held the key for
 * `lockMs` (it died mid-way, say): then the retry takes it over. Keys are the tenant's own.
 *
 * `skip` names routes whose own idempotency the key already is (an agent's key, a prompt's request id);
 * `secret` routes answer with a secret shown only once (a token, a signing secret, a signed link): their
 * answer is never kept, and a retry of a key that succeeded is a 409.
 */
export function idempotency(options: { db: () => Db; tenant: (c: Context) => string; skip: (path: string) => boolean; secret: (path: string) => boolean; lockMs?: number }) {
  const lockMs = options.lockMs ?? 120_000;
  return async (c: Context, next: Next) => {
    const key = c.req.header("idempotency-key");
    if (c.req.method !== "POST" || key === undefined || options.skip(c.req.path)) return next();
    if (!key || key.length > 255) throw new HttpError(400, "Idempotency-Key must be 1–255 characters");
    const tenant = options.tenant(c);
    const db = options.db();
    const fingerprint = await fingerprintOf(c);
    const now = Date.now();
    await db.query("delete from idempotency_keys where tenant = $1 and key = $2 and created_at < $3", [tenant, key, now - IDEMPOTENCY_TTL_MS]);
    let taken = (await db.query("insert into idempotency_keys (tenant, key, fingerprint, created_at) values ($1, $2, $3, $4) on conflict do nothing", [tenant, key, fingerprint, now])).rowCount;
    if (!taken) {
      const row = (await db.query("select fingerprint, status, body, content_type, created_at from idempotency_keys where tenant = $1 and key = $2", [tenant, key])).rows[0];
      if (!row) throw new HttpError(409, "A request with this Idempotency-Key just finished; retry", "IDEMPOTENCY_IN_PROGRESS");
      if (row.status === null && Number(row.created_at) < now - lockMs) {
        // The request holding the key has not finished in all this time: it died. This one takes the key over.
        taken = (await db.query("update idempotency_keys set fingerprint = $3, created_at = $4 where tenant = $1 and key = $2 and status is null and created_at = $5",
          [tenant, key, fingerprint, now, row.created_at])).rowCount;
        if (!taken) throw new HttpError(409, "A request with this Idempotency-Key is still running; retry", "IDEMPOTENCY_IN_PROGRESS");
      } else {
        if (row.status === null) throw new HttpError(409, "A request with this Idempotency-Key is still running; retry", "IDEMPOTENCY_IN_PROGRESS");
        if (row.fingerprint !== fingerprint) throw new HttpError(409, "This Idempotency-Key was sent with another request: a key is for one method, path and body", "IDEMPOTENCY_CONFLICT");
        if (row.body === null) throw new HttpError(409, "The request with this Idempotency-Key already completed, and its secret is shown once: it is not answered again", "IDEMPOTENCY_CONFLICT");
        return new Response(row.body, { status: row.status, headers: { "Content-Type": row.content_type ?? "application/json", "Idempotent-Replayed": "true" } });
      }
    }
    let kept = false;
    try {
      await next();
      const response = c.res;
      if (response.ok) {
        // A secret shown once is never stored: the key only records that its request succeeded.
        const body = options.secret(c.req.path) || !response.body ? null : await response.clone().text();
        await db.query("update idempotency_keys set status = $3, body = $4, content_type = $5 where tenant = $1 and key = $2 and created_at = $6",
          [tenant, key, response.status, body, body === null ? null : response.headers.get("content-type"), now]);
        kept = true;
      }
    } finally {
      // Only its own hold: a retry may have taken the key over (see `lockMs`).
      if (!kept) await db.query("delete from idempotency_keys where tenant = $1 and key = $2 and status is null and created_at = $3", [tenant, key, now]).catch(() => {});
    }
  };
}

/** The request's method, path and body, hashed as the body streams; a body past MAX_BODY_BYTES is a 413. */
async function fingerprintOf(c: Context) {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  const digest = createHash("sha256").update(`${c.req.method} ${c.req.path}\n`);
  const body = c.req.raw.body ? c.req.raw.clone().body : null;
  let bytes = 0;
  for await (const chunk of (body ?? []) as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
    digest.update(chunk);
  }
  return digest.digest("hex");
}

/** Forget keys older than a day. */
export async function expireIdempotencyKeys(db: Db, now = Date.now()) {
  await db.query("delete from idempotency_keys where created_at < $1", [now - IDEMPOTENCY_TTL_MS]);
}
