import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * End-user credits: a tenant's own users as billing subjects. An end user is an agent's or a call's `subject` (who it
 * acts for, in the tenant's app). A tenant that enables them has each of its users' model, audio and image spend
 * metered and enforced here: first from the daily free allowance of the bucket a run spends from (`builder`, `bot:42`),
 * then from the user's paid balance, which the tenant credits (after its own payment flow) and which usage debits, with
 * the tenant's markup, within the user's daily credit limit.
 *
 * Amounts are integer micro-USD. Allowances count raw cost (what a call costs the tenant); the balance, its ledger
 * amounts and the daily limit count what the user is charged (raw cost with the markup). Every change to a user's money
 * locks their `end_users` row first, so changes to one user's money never interleave, on any node. What a user spent
 * is kept per UTC day and bucket (`end_user_days`), apart from the allowances: changing an allowance changes only the
 * cap, never what was spent.
 */

/** Integer micro-USD: 1 USD = 1,000,000. */
export const MICROS = 1_000_000;
/** The bucket of a run or call that names none. */
export const DEFAULT_BUCKET = "default";
/** The most a single amount (an allowance, a limit, an entry) may be: $1,000,000. */
const MAX_AMOUNT = 1_000_000 * MICROS;
const BUCKET_NAME = /^[A-Za-z0-9_.:@/-]{1,100}$/;
/** An allowance's key: a bucket, a prefix of buckets (`bot:*`), or every bucket (`*`). */
const ALLOWANCE_KEY = /^(?:[A-Za-z0-9_.:@/-]{1,100}\*?|\*)$/;
const END_USER_ID = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
export const ENTRY_KINDS = ["grant", "refund", "adjustment"] as const;
export type EntryKind = typeof ENTRY_KINDS[number];
export type LedgerKind = EntryKind | "usage";

/** Allowances per UTC day, in raw micro-USD, by bucket, bucket prefix (`bot:*`) or `*`. */
export type Allowances = Record<string, number>;
export type EndUserSettings = {
  enabled: boolean; allowances: Allowances;
  /** The most each user's paid spend may be per UTC day (charged micro-USD); null: none. */
  dailyLimit: number | null;
  /** Added to the raw cost of paid spend, in basis points. */
  markupBps: number;
  /** end_user.balance.low fires when a balance falls below this; null: never. */
  lowBalance: number | null;
  updatedAt: number | null;
};
export const DEFAULT_SETTINGS: Readonly<EndUserSettings> = Object.freeze({ enabled: false, allowances: {}, dailyLimit: null, markupBps: 0, lowBalance: null, updatedAt: null });
export type LedgerEntry = {
  id: number; kind: LedgerKind; amount: number; raw: number; allowance: number; bucket: string | null; key: string;
  reference: string | null; metadata: Record<string, unknown>; balanceAfter: number; createdAt: number;
};
/** One bucket's day: its allowance, what was spent from it and from the balance, what calls in flight hold, and what is left. */
export type BucketDay = { bucket: string; allowance: number; allowanceSpent: number; paidSpent: number; held: number; allowanceLeft: number };

/** A bucket's name as a run or call gives it. */
export function bucketInput(value: unknown, what = "bucket"): string {
  if (typeof value !== "string" || !BUCKET_NAME.test(value)) throw new HttpError(400, `${what} must be 1–100 characters of letters, digits and _ . : @ / -`);
  return value;
}

/** An end user's id: a subject, 1–200 characters. */
export function endUserInput(value: unknown): string {
  if (!END_USER_ID(value)) throw new HttpError(400, "An end user's id is its subject: a string of 1–200 characters");
  return value;
}

const amountInput = (value: unknown, what: string, { min = 0, nullable = false } = {}): number | null => {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > MAX_AMOUNT) {
    throw new HttpError(400, `${what} must be an integer number of micro-USD from ${min} to ${MAX_AMOUNT}${nullable ? ", or null" : ""}`);
  }
  return value;
};

/** Allowances as given: `{bucket | "prefix*" | "*": micro-USD}`; `removable` allows null to remove a key. */
function allowancesInput(value: unknown, removable: boolean): Record<string, number | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "allowances must be an object of bucket (or \"prefix*\", or \"*\") to micro-USD per day");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new HttpError(400, "allowances may have at most 100 keys");
  return Object.fromEntries(entries.map(([key, amount]) => {
    if (!ALLOWANCE_KEY.test(key)) throw new HttpError(400, `allowances: "${key}" is not a bucket, a "prefix*" or "*"`);
    return [key, amountInput(amount, `allowances["${key}"]`, { nullable: removable })];
  }));
}

/**
 * A bucket's daily allowance: the user's overrides merged over the tenant's, key by key; then the bucket's own key, else
 * the longest prefix (`bot:*`) it starts with, else `*`, else none.
 */
export function allowanceFor(tenant: Allowances, own: Allowances, bucket: string): number {
  const merged = { ...tenant, ...own };
  if (Object.hasOwn(merged, bucket)) return merged[bucket];
  let best: string | undefined;
  for (const key of Object.keys(merged)) {
    if (key === "*" || !key.endsWith("*") || !bucket.startsWith(key.slice(0, -1))) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? merged[best] : merged["*"] ?? 0;
}

/** Raw cost with the markup: what the user is charged for `raw`, rounded up. */
export function marked(raw: number, markupBps: number): number {
  return raw <= 0 ? 0 : Math.ceil(raw * (10_000 + markupBps) / 10_000);
}
/** The raw cost `charged` pays for at the markup, rounded down: the inverse of `marked`. */
export function unmarked(charged: number, markupBps: number): number {
  return charged <= 0 ? 0 : Math.floor(charged * 10_000 / (10_000 + markupBps));
}

/** The UTC day of `at`, as YYYY-MM-DD. */
export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

const settingsView = (row: any): EndUserSettings => row ? {
  enabled: row.enabled, allowances: row.allowances ?? {}, dailyLimit: row.daily_limit === null ? null : Number(row.daily_limit),
  markupBps: row.markup_bps, lowBalance: row.low_balance === null ? null : Number(row.low_balance), updatedAt: Number(row.updated_at),
} : { ...DEFAULT_SETTINGS, allowances: {} };

const entryView = (row: any): LedgerEntry => ({
  id: Number(row.id), kind: row.kind, amount: Number(row.amount), raw: Number(row.raw), allowance: Number(row.allowance), bucket: row.bucket,
  // A tenant's entry shows its own key; the runtime's usage keys (`attempt:…`, `charge:…`) show as they are.
  key: row.idempotency_key.startsWith("entry:") ? row.idempotency_key.slice(6) : row.idempotency_key, reference: row.reference, metadata: row.metadata ?? {}, balanceAfter: Number(row.balance_after), createdAt: Number(row.created_at),
});

/** An end user's row, made if it is not there yet, locked for the rest of the transaction. */
export async function lockEndUser(sql: Sql, tenant: string, id: string, now = Date.now()) {
  await sql.query("insert into end_users (tenant, id, created_at, updated_at) values ($1, $2, $3, $3) on conflict (tenant, id) do nothing", [tenant, id, now]);
  return (await sql.query("select * from end_users where tenant = $1 and id = $2 for update", [tenant, id])).rows[0];
}

export class EndUserCredits {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  /** The tenant's settings; the defaults (not enabled) when it never set any. */
  async settings(tenant: string, sql: Sql = this.db): Promise<EndUserSettings> {
    return settingsView((await sql.query("select * from end_user_settings where tenant = $1", [tenant])).rows[0]);
  }

  /** Change the tenant's settings: fields left out keep their current values. */
  async setSettings(tenant: string, input: Record<string, unknown>): Promise<EndUserSettings> {
    const known = ["enabled", "allowances", "dailyLimit", "markupBps", "lowBalance"];
    const unknown = Object.keys(input).find(key => !known.includes(key));
    if (unknown) throw new HttpError(400, `Unknown setting ${unknown}: settings are ${known.join(", ")}`);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    const allowances = input.allowances === undefined ? undefined : allowancesInput(input.allowances, false);
    const dailyLimit = input.dailyLimit === undefined ? undefined : amountInput(input.dailyLimit, "dailyLimit", { nullable: true });
    const lowBalance = input.lowBalance === undefined ? undefined : amountInput(input.lowBalance, "lowBalance", { nullable: true });
    if (input.markupBps !== undefined && (typeof input.markupBps !== "number" || !Number.isSafeInteger(input.markupBps) || input.markupBps < 0 || input.markupBps > 100_000)) {
      throw new HttpError(400, "markupBps must be an integer from 0 to 100000 (basis points: 2500 is +25%)");
    }
    const current = await this.settings(tenant);
    const next = {
      enabled: input.enabled as boolean | undefined ?? current.enabled, allowances: allowances ?? current.allowances,
      dailyLimit: dailyLimit === undefined ? current.dailyLimit : dailyLimit, markupBps: input.markupBps as number | undefined ?? current.markupBps,
      lowBalance: lowBalance === undefined ? current.lowBalance : lowBalance,
    };
    const row = (await this.db.query(`
      insert into end_user_settings (tenant, enabled, allowances, daily_limit, markup_bps, low_balance, updated_at) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (tenant) do update set enabled = excluded.enabled, allowances = excluded.allowances, daily_limit = excluded.daily_limit,
        markup_bps = excluded.markup_bps, low_balance = excluded.low_balance, updated_at = excluded.updated_at
      returning *`, [tenant, next.enabled, JSON.stringify(next.allowances), next.dailyLimit, next.markupBps, next.lowBalance, Date.now()])).rows[0];
    return settingsView(row);
  }

  /** The tenant's end users, by id, a page at a time (`after`: the last id of the previous page). */
  async list(tenant: string, options: { limit?: number; after?: string } = {}) {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50) || 50, 1), 200);
    const { rows } = await this.db.query(`select id, balance, created_at, updated_at from end_users where tenant = $1 and ($2::text is null or id > $2) order by id limit $3`,
      [tenant, options.after ?? null, limit + 1]);
    const page = rows.slice(0, limit).map(row => ({ id: row.id as string, balance: Number(row.balance), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
    return { endUsers: page, ...(rows.length > limit ? { next: page.at(-1)!.id } : {}) };
  }

  /**
   * An end user as they stand now: their balance, what calls in flight hold of it, their limits, and today's spend by
   * bucket (each bucket spent from or held for today, each the tenant or user names exactly, and `buckets` asked for).
   * One never seen is shown at zero, with the tenant's allowances; reading never makes one.
   */
  async get(tenant: string, id: string, buckets: string[] = [], now = Date.now()) {
    endUserInput(id);
    const day = utcDay(now);
    const [settings, user, days, holds] = await Promise.all([
      this.settings(tenant),
      this.db.query("select * from end_users where tenant = $1 and id = $2", [tenant, id]).then(result => result.rows[0]),
      this.db.query("select bucket, allowance_spent, paid_spent from end_user_days where tenant = $1 and end_user = $2 and day = $3", [tenant, id, day]).then(result => result.rows),
      this.db.query("select bucket, sum(allowance)::bigint as allowance, sum(paid)::bigint as paid from end_user_holds where tenant = $1 and end_user = $2 and expires_at > $3 group by bucket", [tenant, id, now]).then(result => result.rows),
    ]);
    const own: Allowances = user?.allowances ?? {};
    const names = new Set<string>([...days.map(row => row.bucket), ...holds.map(row => row.bucket), ...buckets.map(bucket => bucketInput(bucket)),
      ...[...Object.keys(settings.allowances), ...Object.keys(own)].filter(key => !key.endsWith("*"))]);
    const today: BucketDay[] = [...names].sort().map(bucket => {
      const spent = days.find(row => row.bucket === bucket), held = holds.find(row => row.bucket === bucket);
      const allowance = allowanceFor(settings.allowances, own, bucket);
      const allowanceSpent = Number(spent?.allowance_spent ?? 0), paidSpent = Number(spent?.paid_spent ?? 0);
      const heldAllowance = Number(held?.allowance ?? 0), heldPaid = Number(held?.paid ?? 0);
      return { bucket, allowance, allowanceSpent, paidSpent, held: heldAllowance + heldPaid, allowanceLeft: Math.max(0, allowance - allowanceSpent - heldAllowance) };
    });
    const ownLimit = user && user.daily_limit !== null ? Number(user.daily_limit) : null;
    const dailyLimit = ownLimit ?? settings.dailyLimit;
    const paidSpent = days.reduce((total, row) => total + Number(row.paid_spent), 0);
    const heldPaid = holds.reduce((total, row) => total + Number(row.paid), 0);
    const balance = Number(user?.balance ?? 0);
    return {
      id, enabled: settings.enabled, balance, held: heldPaid,
      /** What paid spend may still take today: the balance less holds, within the daily limit. */
      available: Math.max(0, Math.min(balance - heldPaid, dailyLimit === null ? Infinity : dailyLimit - paidSpent - heldPaid)),
      dailyLimit, markupBps: settings.markupBps, overrides: { allowances: own, dailyLimit: ownLimit },
      today: { day, paidSpent, buckets: today },
      createdAt: user ? Number(user.created_at) : null, updatedAt: user ? Number(user.updated_at) : null,
    };
  }

  /**
   * Set a user's own overrides: `allowances` merged key by key into theirs (a key set to null is removed), and their
   * `dailyLimit` (null: the tenant's). Makes the user if they are new. Never touches what they spent.
   */
  async update(tenant: string, id: string, input: Record<string, unknown>) {
    endUserInput(id);
    const unknown = Object.keys(input).find(key => key !== "allowances" && key !== "dailyLimit");
    if (unknown) throw new HttpError(400, `Unknown field ${unknown}: an end user's overrides are allowances and dailyLimit`);
    const allowances = input.allowances === undefined ? undefined : allowancesInput(input.allowances, true);
    const dailyLimit = input.dailyLimit === undefined ? undefined : amountInput(input.dailyLimit, "dailyLimit", { nullable: true });
    await transaction(this.db, async sql => {
      const user = await lockEndUser(sql, tenant, id);
      const merged: Allowances = { ...user.allowances };
      for (const [key, value] of Object.entries(allowances ?? {})) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      if (Object.keys(merged).length > 100) throw new HttpError(400, "An end user may have at most 100 allowance overrides");
      await sql.query("update end_users set allowances = $3, daily_limit = $4, updated_at = $5 where tenant = $1 and id = $2",
        [tenant, id, JSON.stringify(merged), dailyLimit === undefined ? user.daily_limit : dailyLimit, Date.now()]);
    });
    return this.get(tenant, id);
  }

  /** A user's ledger, newest first, a page at a time (`before`: an entry id, the previous page's `next`). */
  async ledger(tenant: string, id: string, options: { limit?: number; before?: number } = {}) {
    endUserInput(id);
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50) || 50, 1), 200);
    const { rows } = await this.db.query(`select * from end_user_ledger where tenant = $1 and end_user = $2 and ($3::bigint is null or id < $3) order by id desc limit $4`,
      [tenant, id, options.before ?? null, limit + 1]);
    const entries = rows.slice(0, limit).map(entryView);
    return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.id } : {}) };
  }

  /**
   * Post the tenant's own entry to a user's ledger: a `grant` adds `amount` (a payment, a gift), a `refund` takes it
   * back (money returned to the user), an `adjustment` moves the balance by a signed `amount`. `key` makes it
   * idempotent: the same key again with the same entry returns the first (`replayed`), with another entry is a 409.
   */
  async post(tenant: string, id: string, input: Record<string, unknown>): Promise<{ entry: LedgerEntry; replayed: boolean }> {
    endUserInput(id);
    const unknown = Object.keys(input).find(key => !["kind", "amount", "key", "reference", "metadata"].includes(key));
    if (unknown) throw new HttpError(400, `Unknown field ${unknown}: an entry is kind, amount, key, reference and metadata`);
    const kind = input.kind as EntryKind;
    if (!ENTRY_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${ENTRY_KINDS.join(", ")}`);
    const amount = kind === "adjustment" ? amountInput(input.amount, "amount", { min: -MAX_AMOUNT })! : amountInput(input.amount, "amount", { min: 1 })!;
    if (amount === 0) throw new HttpError(400, "amount must not be 0");
    if (typeof input.key !== "string" || !input.key.trim() || input.key.length > 255) throw new HttpError(400, "key is the entry's idempotency key (a payment's id, say): a string of 1–255 characters");
    if (input.reference !== undefined && (typeof input.reference !== "string" || input.reference.length > 500)) throw new HttpError(400, "reference must be a string of at most 500 characters");
    if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata) || Buffer.byteLength(JSON.stringify(input.metadata)) > 4096)) {
      throw new HttpError(400, "metadata must be an object of at most 4 KB of JSON");
    }
    const moved = kind === "refund" ? -amount : amount;
    // Tenant entries' keys never meet the runtime's own (usage: `attempt:…`, `charge:…`).
    const key = `entry:${input.key}`;
    return transaction(this.db, async sql => {
      const user = await lockEndUser(sql, tenant, id);
      const existing = (await sql.query("select * from end_user_ledger where tenant = $1 and idempotency_key = $2", [tenant, key])).rows[0];
      if (existing) {
        const same = existing.end_user === id && existing.kind === kind && Number(existing.amount) === moved && (existing.reference ?? undefined) === input.reference;
        if (!same) throw new HttpError(409, "This key was used for another entry", "IDEMPOTENCY_CONFLICT");
        return { entry: entryView(existing), replayed: true };
      }
      const entry = await appendEntry(sql, { tenant, endUser: id, kind, amount: moved, key, reference: (input.reference as string | undefined) ?? null, metadata: (input.metadata as Record<string, unknown> | undefined) ?? {} }, Number(user.balance));
      return { entry, replayed: false };
    });
  }
}

/**
 * Append an entry and move the user's balance by its amount, with the user's row locked (`lockEndUser`) and its balance
 * as it was (`balance`). A key already in the ledger is never appended again: callers look for it first.
 */
export async function appendEntry(sql: Sql, entry: { tenant: string; endUser: string; kind: LedgerKind; amount: number; raw?: number; allowance?: number; bucket?: string | null; key: string; reference?: string | null; metadata?: Record<string, unknown> }, balance: number, now = Date.now()): Promise<LedgerEntry> {
  const after = balance + entry.amount;
  const row = (await sql.query(`
    insert into end_user_ledger (tenant, end_user, kind, amount, raw, allowance, bucket, idempotency_key, reference, metadata, balance_after, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (tenant, idempotency_key) do nothing returning *`,
  [entry.tenant, entry.endUser, entry.kind, entry.amount, entry.raw ?? 0, entry.allowance ?? 0, entry.bucket ?? null, entry.key, entry.reference ?? null, JSON.stringify(entry.metadata ?? {}), after, now])).rows[0];
  if (!row) throw new Error(`Ledger key ${entry.key} was posted already`);
  if (entry.amount) await sql.query("update end_users set balance = $3, updated_at = $4 where tenant = $1 and id = $2", [entry.tenant, entry.endUser, after, now]);
  return entryView(row);
}
