// Short-lived runtime tokens for the git service: `<base64url(json)>.<base64url(hmac-sha256)>`. The volume object
// (or the runtime's job dispatcher) mints them with the shared key; the service verifies them with no lookup.
//   repo   the one repo the token opens
//   scope  read  -> info/refs + git-upload-pack + blob/tree reads
//          write -> read + git-receive-pack (pushes), limited to `refs` when set (a job's own branch)
//          admin -> write + the server-side API (create, refs CAS, commit, merge, gc, delete)
//   exp    unix seconds
//   refs   optional ref prefixes a write may touch (`refs/heads/job/abc`), enforced by the pre-receive hook
import { createHmac, timingSafeEqual } from "node:crypto";

export type Scope = "read" | "write" | "admin";
export type Claims = { repo: string; scope: Scope; exp: number; refs?: string[] };

const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString("base64url");
const sign = (key: string, body: string) => createHmac("sha256", key).update(body).digest();

export function mintToken(key: string, claims: Claims): string {
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(sign(key, body))}`;
}

const RANK: Record<Scope, number> = { read: 0, write: 1, admin: 2 };

/** The claims when `token` is genuine, unexpired, for `repo`, and at least `need`; null otherwise. */
export function verifyToken(key: string, token: string | null, repo: string, need: Scope, now = Date.now() / 1000): Claims | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(key, body), given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: Claims;
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (claims.exp < now || claims.repo !== repo || RANK[claims.scope] < RANK[need]) return null;
  return claims;
}

/** Bearer, or basic auth with the token as the password (what `git` sends from a credential helper). */
export function tokenFrom(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [kind, value] = authorization.split(" ");
  if (/^bearer$/i.test(kind)) return value ?? null;
  if (/^basic$/i.test(kind)) return Buffer.from(value ?? "", "base64").toString().split(":").slice(1).join(":") || null;
  return null;
}
