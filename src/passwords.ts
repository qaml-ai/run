import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * Email and password sign-in. A tenant has a password when an operator sets one (`PUT /v1/tenants/{id}/password`,
 * `infra/tenant.sh set-password`), or, where account mail is configured, when someone signs up, adds one on the
 * Account page or resets it through a link mailed to the address (src/email-accounts.ts). Passwords are hashed with
 * scrypt, a random salt each, and the parameters are kept with the hash, so they can be raised later without
 * invalidating what is stored.
 */
const COST = { N: 1 << 15, r: 8, p: 1 };
const KEY_BYTES = 32;
/** Room for N = 2^17 (128 * N * r bytes), the most a stored hash may ask for. */
const MAX_MEMORY = 256 * 1024 * 1024;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

const derive = (password: string, salt: Buffer, cost: ScryptOptions & { N: number }) => new Promise<Buffer>((resolve, reject) =>
  scrypt(password.normalize("NFC"), salt, KEY_BYTES, { ...cost, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key)));

/** `scrypt$N$r$p$salt$key`, salt and key base64url. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Whether `password` is the one `stored` was made from, compared in constant time. */
export async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (scheme !== "scrypt" || !salt || !key || ![cost.N, cost.r, cost.p].every(Number.isSafeInteger) || cost.N > 1 << 17 || cost.r > 16 || cost.p > 4) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), cost);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A sign-in address, as stored and compared: trimmed and lowercased. */
export function normalizeEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/** Common passwords long enough to pass the length check, lowercased (src/common-passwords.txt says where they are from). */
const COMMON = new Set(readFileSync(new URL("./common-passwords.txt", import.meta.url), "utf8").split("\n").filter(line => line && !line.startsWith("#")));

/**
 * A password someone chooses for themselves: the length `checkPassword` asks for, not one of the most common passwords
 * nor the address it is for. No rules on what characters it has.
 */
export function checkNewPassword(value: unknown, email?: string): string {
  const password = checkPassword(value);
  const lower = password.normalize("NFC").toLowerCase();
  if (COMMON.has(lower) || (email && lower === email)) throw new HttpError(400, "That password is too common; choose another");
  return password;
}

export function checkPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD) {
    throw new HttpError(400, `A password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
  return value;
}

export class Passwords {
  private readonly db: Db;
  /** Hashed against when the address is unknown, so that takes as long as a wrong password. */
  private readonly decoy = hashPassword(randomBytes(24).toString("base64url"));
  constructor(db: Db) { this.db = db; }

  /** The tenant `email` signs in to with `password`, if it is that tenant's password. Unknown addresses take as long. */
  async verify(email: string, password: string): Promise<string | undefined> {
    const row = (await this.db.query("select tenant, hash from tenant_passwords where email = $1", [email])).rows[0] as { tenant: string; hash: string } | undefined;
    const matches = await verifyPassword(password, row?.hash ?? await this.decoy);
    return row && matches ? row.tenant : undefined;
  }

  /** The address `tenant` signs in with, if it has a password. */
  async email(tenant: string): Promise<string | undefined> {
    return (await this.db.query("select email from tenant_passwords where tenant = $1", [tenant])).rows[0]?.email;
  }

  /** Set `tenant`'s sign-in address and password, ending its password sessions. Another tenant's address is refused. */
  async set(tenant: string, email: string, password: string) {
    const hash = await hashPassword(password);
    try {
      await this.db.query(`insert into tenant_passwords (tenant, email, hash, set_at) values ($1, $2, $3, $4)
        on conflict (tenant) do update set email = excluded.email, hash = excluded.hash, set_at = excluded.set_at`, [tenant, email, hash, Date.now()]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new HttpError(409, "Another account signs in with this email address");
      throw error;
    }
    return this.endSessions(tenant);
  }

  /** Change `tenant`'s password if `current` is it, ending its other password sessions (`keep`, the session's hash, stays). */
  async change(tenant: string, current: string, next: string, keep?: string) {
    const row = (await this.db.query("select hash from tenant_passwords where tenant = $1", [tenant])).rows[0] as { hash: string } | undefined;
    if (!row) throw new HttpError(404, "This account has no password");
    if (!await verifyPassword(current, row.hash)) throw new HttpError(403, "The current password is wrong");
    // Only if no one changed it meanwhile.
    const { rowCount } = await this.db.query("update tenant_passwords set hash = $3, set_at = $4 where tenant = $1 and hash = $2", [tenant, row.hash, await hashPassword(next), Date.now()]);
    if (!rowCount) throw new HttpError(409, "The password changed meanwhile; try again");
    return this.endSessions(tenant, keep);
  }

  /** Remove `tenant`'s password, ending its password sessions. */
  async clear(tenant: string) {
    const cleared = !!(await this.db.query("delete from tenant_passwords where tenant = $1", [tenant])).rowCount;
    return { cleared, signedOut: await this.endSessions(tenant) };
  }

  private async endSessions(tenant: string, keep?: string) {
    return (await this.db.query("delete from console_sessions where tenant = $1 and method = 'password' and sha256 is distinct from $2", [tenant, keep ?? null])).rowCount ?? 0;
  }
}
