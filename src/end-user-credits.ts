import { randomUUID } from "node:crypto";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { enqueueEvents, webhookEvent } from "./webhooks.ts";

/**
 * End-user credits: a tenant's own users as billing subjects. An end user is an agent's or a call's `subject` (who it
 * acts for, in the tenant's app). A tenant that enables them has each of its users' model, audio and image spend
 * metered and enforced here: first from the daily free allowance of the bucket a run spends from (`builder`, `bot:42`),
 * then from the user's paid balance, which the tenant credits (after its own payment flow) and which usage debits, with
 * the tenant's markup, within the user's daily credit limit and the bucket's own daily limit on paid spend, if it has one.
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
  /**
   * The most each bucket may charge a user's balance per UTC day (charged micro-USD), keyed as allowances are: a bot's
   * (`bot:*`) at 0 spends its allowance and never the balance. A bucket with no key: only `dailyLimit`.
   */
  bucketLimits: Allowances;
  /** Added to the raw cost of paid spend, in basis points. */
  markupBps: number;
  /** end_user.balance.low fires when a balance falls below this; null: never. */
  lowBalance: number | null;
  updatedAt: number | null;
};
export const DEFAULT_SETTINGS: Readonly<EndUserSettings> = Object.freeze({ enabled: false, allowances: {}, bucketLimits: {}, dailyLimit: null, markupBps: 0, lowBalance: null, updatedAt: null });
export type LedgerEntry = {
  id: number; kind: LedgerKind; amount: number; raw: number; allowance: number; bucket: string | null; key: string;
  reference: string | null; metadata: Record<string, unknown>; balanceAfter: number; createdAt: number;
};
/**
 * One bucket's day: its allowance, what was spent from it and from the balance, what calls in flight hold, what is left
 * of the allowance, and its own limit on paid spend (null: none).
 */
export type BucketDay = { bucket: string; allowance: number; allowanceSpent: number; paidSpent: number; held: number; allowanceLeft: number; paidLimit: number | null };

export const LEDGER_KINDS: readonly LedgerKind[] = [...ENTRY_KINDS, "usage"];
/** How a ledger read is narrowed (`EndUserCredits.ledger`): times are epoch ms, `to` exclusive. */
export type LedgerQuery = { limit?: number; before?: number; kinds?: LedgerKind[]; from?: number; to?: number; bucket?: string; moved?: boolean };
/** Which days a per-day read covers (`EndUserCredits.days`): UTC days as YYYY-MM-DD, `to` exclusive. */
export type DaysQuery = { from?: string; to?: string; bucket?: string; limit?: number };
/**
 * An end user's UTC day: by bucket, what the allowance paid (`freeRaw`, raw cost) and what the balance paid
 * (`paidCharged`, charged with the markup), and their totals; and what the tenant's own entries moved that day, in balance
 * units: `granted`, `refunded` (positive: what was taken back), `adjusted` (signed), and how many there were (`entries`).
 */
export type EndUserDay = {
  day: string; freeRaw: number; paidCharged: number; granted: number; refunded: number; adjusted: number; entries: number;
  buckets: { bucket: string; freeRaw: number; paidCharged: number }[];
};
/** The most days one per-day read may span. */
export const MAX_DAYS = 366;
/** The UTC day `days` after `day` (YYYY-MM-DD; negative: before). */
export const dayAfter = (day: string, days: number) => utcDay(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);
/** A UTC day as given: YYYY-MM-DD, a real date. */
export function dayInput(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || utcDay(Date.parse(`${value}T00:00:00Z`)) !== value) {
    throw new HttpError(400, `${what} must be a UTC day, YYYY-MM-DD`);
  }
  return value;
}

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

/** Allowances (or bucket limits, `what`) as given: `{bucket | "prefix*" | "*": micro-USD}`; `removable` allows null to remove a key. */
function allowancesInput(value: unknown, removable: boolean, what = "allowances"): Record<string, number | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${what} must be an object of bucket (or "prefix*", or "*") to micro-USD per day`);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new HttpError(400, `${what} may have at most 100 keys`);
  return Object.fromEntries(entries.map(([key, amount]) => {
    if (!ALLOWANCE_KEY.test(key)) throw new HttpError(400, `${what}: "${key}" is not a bucket, a "prefix*" or "*"`);
    return [key, amountInput(amount, `${what}["${key}"]`, { nullable: removable })];
  }));
}

/** `overrides` merged into `current` key by key, a null removing a key; at most 100 keys. */
function mergeKeys(current: Allowances, overrides: Record<string, number | null> | undefined, what: string): Allowances {
  const merged: Allowances = { ...current };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  if (Object.keys(merged).length > 100) throw new HttpError(400, `At most 100 ${what} keys`);
  return merged;
}

/**
 * A bucket's daily allowance: the user's overrides merged over the tenant's, key by key; then the bucket's own key, else
 * the longest prefix (`bot:*`) it starts with, else `*`, else none.
 */
export function allowanceFor(tenant: Allowances, own: Allowances, bucket: string): number {
  return keyedFor({ ...tenant, ...own }, bucket) ?? 0;
}

/** A bucket's own daily limit on paid spend (charged), found as its allowance is; null: it has none. */
export function bucketLimitFor(tenant: Allowances, own: Allowances, bucket: string): number | null {
  return keyedFor({ ...tenant, ...own }, bucket) ?? null;
}

function keyedFor(merged: Allowances, bucket: string): number | undefined {
  if (Object.hasOwn(merged, bucket)) return merged[bucket];
  let best: string | undefined;
  for (const key of Object.keys(merged)) {
    if (key === "*" || !key.endsWith("*") || !bucket.startsWith(key.slice(0, -1))) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? merged[best] : merged["*"];
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
  enabled: row.enabled, allowances: row.allowances ?? {}, bucketLimits: row.bucket_limits ?? {}, dailyLimit: row.daily_limit === null ? null : Number(row.daily_limit),
  markupBps: row.markup_bps, lowBalance: row.low_balance === null ? null : Number(row.low_balance), updatedAt: Number(row.updated_at),
} : { ...DEFAULT_SETTINGS, allowances: {}, bucketLimits: {} };

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

  /**
   * Change the tenant's settings: fields left out keep their current values. `allowances` and `bucketLimits`, when given,
   * replace the whole map (PUT); with `merge` (PATCH) they are merged into it key by key, a key set to null removed.
   *
   * One statement writes only the columns sent, and merges a PATCH's keys into the map as the row stands when the write
   * takes it (never as read before), so concurrent writers (several nodes, an admin tool, a script) never undo each
   * other's fields or keys: of two writes to the same field or key, the later one wins.
   */
  async setSettings(tenant: string, input: Record<string, unknown>, { merge = false } = {}): Promise<EndUserSettings> {
    const known = ["enabled", "allowances", "bucketLimits", "dailyLimit", "markupBps", "lowBalance"];
    const unknown = Object.keys(input).find(key => !known.includes(key));
    if (unknown) throw new HttpError(400, `Unknown setting ${unknown}: settings are ${known.join(", ")}`);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    const allowances = input.allowances === undefined ? undefined : allowancesInput(input.allowances, merge);
    const bucketLimits = input.bucketLimits === undefined ? undefined : allowancesInput(input.bucketLimits, merge, "bucketLimits");
    const dailyLimit = input.dailyLimit === undefined ? undefined : amountInput(input.dailyLimit, "dailyLimit", { nullable: true });
    const lowBalance = input.lowBalance === undefined ? undefined : amountInput(input.lowBalance, "lowBalance", { nullable: true });
    if (input.markupBps !== undefined && (typeof input.markupBps !== "number" || !Number.isSafeInteger(input.markupBps) || input.markupBps < 0 || input.markupBps > 100_000)) {
      throw new HttpError(400, "markupBps must be an integer from 0 to 100000 (basis points: 2500 is +25%)");
    }
    // An insert (no row yet) takes the defaults for what was not sent; an update sets only what was. A map's keys merge
    // in SQL: `(column || set) - removed`. Postgres takes the row before evaluating the update, so a writer queued behind
    // another merges into what that one wrote.
    const params: unknown[] = [tenant, Date.now()];
    const param = (value: unknown) => `$${params.push(value)}`;
    const sets: string[] = [], limits: string[] = [];
    const values: Record<string, string> = { enabled: "false", allowances: "'{}'::jsonb", bucket_limits: "'{}'::jsonb", daily_limit: "null", markup_bps: "0", low_balance: "null" };
    const column = (name: string, value: unknown) => {
      values[name] = param(value);
      sets.push(`${name} = excluded.${name}`);
    };
    const map = (name: string, given: Record<string, number | null> | undefined) => {
      if (!given) return;
      const set = JSON.stringify(Object.fromEntries(Object.entries(given).filter(([, amount]) => amount !== null)));
      if (!merge) return column(name, set);
      const removed = Object.keys(given).filter(key => given[key] === null);
      values[name] = `${param(set)}::jsonb`;
      const merged = `(s.${name} || ${values[name]}) - ${param(removed)}::text[]`;
      sets.push(`${name} = ${merged}`);
      limits.push(`(select count(*) from jsonb_object_keys(${merged})) <= 100`);
    };
    if (input.enabled !== undefined) column("enabled", input.enabled);
    map("allowances", allowances);
    map("bucket_limits", bucketLimits);
    if (dailyLimit !== undefined) column("daily_limit", dailyLimit);
    if (input.markupBps !== undefined) column("markup_bps", input.markupBps);
    if (lowBalance !== undefined) column("low_balance", lowBalance);
    const names = Object.keys(values);
    const row = (await this.db.query(`
      insert into end_user_settings as s (tenant, ${names.join(", ")}, updated_at) values ($1, ${names.map(name => values[name]).join(", ")}, $2)
      on conflict (tenant) do update set ${[...sets, "updated_at = excluded.updated_at"].join(", ")}
      ${limits.length ? `where ${limits.join(" and ")}` : ""}
      returning *`, params)).rows[0];
    // No row: the row is there, and a PATCH would take one of its maps past 100 keys. Nothing was written.
    if (!row) throw new HttpError(400, "At most 100 keys in allowances, and 100 in bucketLimits");
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
    const own: Allowances = user?.allowances ?? {}, ownLimits: Allowances = user?.bucket_limits ?? {};
    const names = new Set<string>([...days.map(row => row.bucket), ...holds.map(row => row.bucket), ...buckets.map(bucket => bucketInput(bucket)),
      ...[...Object.keys(settings.allowances), ...Object.keys(own), ...Object.keys(settings.bucketLimits), ...Object.keys(ownLimits)].filter(key => !key.endsWith("*"))]);
    const today: BucketDay[] = [...names].sort().map(bucket => {
      const spent = days.find(row => row.bucket === bucket), held = holds.find(row => row.bucket === bucket);
      const allowance = allowanceFor(settings.allowances, own, bucket);
      const allowanceSpent = Number(spent?.allowance_spent ?? 0), paidSpent = Number(spent?.paid_spent ?? 0);
      const heldAllowance = Number(held?.allowance ?? 0), heldPaid = Number(held?.paid ?? 0);
      return { bucket, allowance, allowanceSpent, paidSpent, held: heldAllowance + heldPaid, allowanceLeft: Math.max(0, allowance - allowanceSpent - heldAllowance), paidLimit: bucketLimitFor(settings.bucketLimits, ownLimits, bucket) };
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
      dailyLimit, markupBps: settings.markupBps, overrides: { allowances: own, bucketLimits: ownLimits, dailyLimit: ownLimit },
      today: { day, paidSpent, buckets: today },
      createdAt: user ? Number(user.created_at) : null, updatedAt: user ? Number(user.updated_at) : null,
    };
  }

  /**
   * Set a user's own overrides: `allowances` and `bucketLimits` merged key by key into theirs (a key set to null is
   * removed), and their `dailyLimit` (null: the tenant's). Makes the user if they are new. Never touches what they spent.
   */
  async update(tenant: string, id: string, input: Record<string, unknown>) {
    endUserInput(id);
    const unknown = Object.keys(input).find(key => !["allowances", "bucketLimits", "dailyLimit"].includes(key));
    if (unknown) throw new HttpError(400, `Unknown field ${unknown}: an end user's overrides are allowances, bucketLimits and dailyLimit`);
    const allowances = input.allowances === undefined ? undefined : allowancesInput(input.allowances, true);
    const bucketLimits = input.bucketLimits === undefined ? undefined : allowancesInput(input.bucketLimits, true, "bucketLimits");
    const dailyLimit = input.dailyLimit === undefined ? undefined : amountInput(input.dailyLimit, "dailyLimit", { nullable: true });
    await transaction(this.db, async sql => {
      const user = await lockEndUser(sql, tenant, id);
      await sql.query("update end_users set allowances = $3, bucket_limits = $4, daily_limit = $5, updated_at = $6 where tenant = $1 and id = $2",
        [tenant, id, JSON.stringify(mergeKeys(user.allowances, allowances, "allowance")), JSON.stringify(mergeKeys(user.bucket_limits, bucketLimits, "bucket limit")),
          dailyLimit === undefined ? user.daily_limit : dailyLimit, Date.now()]);
    });
    return this.get(tenant, id);
  }

  /**
   * A user's ledger, newest first, a page at a time (`before`: an entry id, the previous page's `next`), narrowed by kind,
   * a time range on `createdAt` (`to` exclusive), bucket, and `moved` (only entries that moved the balance: usage the
   * allowance paid for in full is left out). The filters combine with each other and with paging.
   */
  async ledger(tenant: string, id: string, options: LedgerQuery = {}) {
    endUserInput(id);
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50) || 50, 1), 200);
    const where = ["tenant = $1", "end_user = $2"], params: unknown[] = [tenant, id];
    const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
    if (options.before !== undefined) add("id < ?", options.before);
    if (options.kinds?.length) {
      const kinds = [...new Set(options.kinds)];
      if (kinds.some(kind => !LEDGER_KINDS.includes(kind))) throw new HttpError(400, `kind must be any of ${LEDGER_KINDS.join(", ")}`);
      add("kind = any(?::text[])", kinds);
      // Said literally too, so that a history without usage can be read from the user's few other entries, however much usage they have.
      if (!kinds.includes("usage")) where.push("kind <> 'usage'");
    }
    if (options.from !== undefined) add("created_at >= ?", options.from);
    if (options.to !== undefined) add("created_at < ?", options.to);
    if (options.bucket !== undefined) add("bucket = ?", bucketInput(options.bucket));
    if (options.moved) where.push("amount <> 0");
    params.push(limit + 1);
    const { rows } = await this.db.query(`select * from end_user_ledger where ${where.join(" and ")} order by id desc limit $${params.length}`, params);
    const entries = rows.slice(0, limit).map(entryView);
    return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.id } : {}) };
  }

  /**
   * A user's spend and credit per UTC day, newest first, days with neither left out, `limit` days a page (`next`: pass it
   * as `to`). Per day and bucket, what the allowance paid (`freeRaw`, raw cost) and what the balance paid (`paidCharged`,
   * with the markup), as kept per day and bucket (a call counts on the day it began); and what the tenant's own entries
   * moved that day (grants, refunds, adjustments, in balance units). With `bucket`: that bucket's spend alone, and no
   * entries, which belong to no bucket. One statement: the days' rows by their key, and the user's entries but usage.
   */
  async days(tenant: string, id: string, options: DaysQuery = {}, now = Date.now()): Promise<{ days: EndUserDay[]; next?: string }> {
    endUserInput(id);
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 31) || 31, 1), 100);
    const to = options.to === undefined ? dayAfter(utcDay(now), 1) : dayInput(options.to, "to");
    const from = options.from === undefined ? dayAfter(to, -MAX_DAYS) : dayInput(options.from, "from");
    if (from >= to) throw new HttpError(400, "from must be a day before to (to is exclusive)");
    if (dayAfter(from, MAX_DAYS) < to) throw new HttpError(400, `Ask for at most ${MAX_DAYS} days at a time`);
    const bucket = options.bucket === undefined ? null : bucketInput(options.bucket);
    const { rows } = await this.db.query(`
      with spent as (
        select day, bucket, allowance_spent, paid_spent from end_user_days
        where tenant = $1 and end_user = $2 and day >= $3::date and day < $4::date and ($5::text is null or bucket = $5) and (allowance_spent <> 0 or paid_spent <> 0)
      ), credited as (
        select (to_timestamp(created_at / 1000.0) at time zone 'UTC')::date as day,
          coalesce(sum(amount) filter (where kind = 'grant'), 0)::bigint as granted, coalesce(-sum(amount) filter (where kind = 'refund'), 0)::bigint as refunded,
          coalesce(sum(amount) filter (where kind = 'adjustment'), 0)::bigint as adjusted, count(*)::int as entries
        from end_user_ledger
        where tenant = $1 and end_user = $2 and kind <> 'usage' and $5::text is null and created_at >= $6 and created_at < $7
        group by 1
      ), picked as (
        select day from spent union select day from credited order by day desc limit $8
      )
      select to_char(p.day, 'YYYY-MM-DD') as day, s.bucket, s.allowance_spent, s.paid_spent, c.granted, c.refunded, c.adjusted, c.entries
      from picked p left join spent s on s.day = p.day left join credited c on c.day = p.day
      order by p.day desc, s.bucket`,
    [tenant, id, from, to, bucket, Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`), limit + 1]);
    const days: EndUserDay[] = [];
    for (const row of rows) {
      let day = days.at(-1);
      if (!day || day.day !== row.day) {
        day = { day: row.day, freeRaw: 0, paidCharged: 0, granted: Number(row.granted ?? 0), refunded: Number(row.refunded ?? 0), adjusted: Number(row.adjusted ?? 0), entries: Number(row.entries ?? 0), buckets: [] };
        days.push(day);
      }
      if (row.bucket === null) continue;
      const freeRaw = Number(row.allowance_spent), paidCharged = Number(row.paid_spent);
      day.buckets.push({ bucket: row.bucket, freeRaw, paidCharged });
      day.freeRaw += freeRaw;
      day.paidCharged += paidCharged;
    }
    const page = days.slice(0, limit);
    return { days: page, ...(days.length > limit ? { next: page.at(-1)!.day } : {}) };
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
      // A refund returns credit the user has: at most their balance, less what calls in flight hold of it.
      if (kind === "refund") {
        const held = Number((await sql.query("select coalesce(sum(paid), 0)::bigint as paid from end_user_holds where tenant = $1 and end_user = $2 and expires_at > $3", [tenant, id, Date.now()])).rows[0].paid);
        const refundable = Math.max(0, Number(user.balance) - held);
        if (amount > refundable) {
          throw new HttpError(409, `A refund may return at most the balance not held by calls in flight: ${dollars(refundable)} (balance ${dollars(Number(user.balance))}); post an adjustment to correct a balance`, "INSUFFICIENT_BALANCE", { refundable });
        }
      }
      const entry = await appendEntry(sql, { tenant, endUser: id, kind, amount: moved, key, reference: (input.reference as string | undefined) ?? null, metadata: (input.metadata as Record<string, unknown> | undefined) ?? {} }, Number(user.balance));
      return { entry, replayed: false };
    });
  }

  // Enforcement -------------------------------------------------------------

  /** Whether the tenant meters its end users. */
  async enabled(tenant: string): Promise<boolean> {
    return (await this.db.query("select enabled from end_user_settings where tenant = $1", [tenant])).rows[0]?.enabled === true;
  }

  /**
   * Hold up to `want` (raw micro-USD) for a call `id` of `endUser` in `bucket`: from what is left of the bucket's
   * allowance today, then from the balance (marked up) within the daily limit, after every other hold. At least `min`
   * must be held, else the call is refused. Undefined: the tenant does not meter its end users.
   */
  async reserve(tenant: string, endUser: string, bucket: string, call: { id: string; want: number; min: number }, now = Date.now()): Promise<Reserved | undefined> {
    if (!await this.enabled(tenant)) return undefined;
    // A call that costs nothing (a model priced at zero) holds nothing, and is never refused.
    if (!(call.want > 0)) return { hold: { id: call.id, raw: 0, allowance: 0, paid: 0 } };
    return transaction(this.db, async sql => {
      const user = await lockEndUser(sql, tenant, endUser, now);
      // Expired holds go, and this call's own from an earlier try (a begin delivered again) is taken afresh.
      await sql.query("delete from end_user_holds where tenant = $1 and end_user = $2 and (expires_at <= $3 or id = $4)", [tenant, endUser, now, call.id]);
      const left = await room(sql, tenant, user, await this.settings(tenant, sql), bucket, now);
      const taken = split(call.want, left);
      if (taken.raw < Math.max(1, Math.min(call.min, call.want))) return { refused: await refused(sql, tenant, user, bucket, left, now) };
      await sql.query("insert into end_user_holds (id, tenant, end_user, bucket, day, allowance, paid, expires_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [call.id, tenant, endUser, bucket, left.day, taken.allowance, taken.paid, now + HOLD_MS, now]);
      return { hold: { id: call.id, ...taken } };
    });
  }

  /**
   * Hold up to `want` more (raw) for a call already holding some (`reserve`), as its cost grows while it streams; its
   * hold lives HOLD_MS from now. Nothing more to hold: refused, and the call stops where it is.
   */
  async extend(tenant: string, endUser: string, bucket: string, id: string, want: number, now = Date.now()): Promise<Reserved> {
    return transaction(this.db, async sql => {
      const user = await lockEndUser(sql, tenant, endUser, now);
      // More of a call's hold comes from the day it began (the day its cost is posted to), even after midnight: never from
      // the next day's allowance, which would then be granted again to the calls of that day.
      const began = (await sql.query("select h.day, a.started_at from (select $1::uuid as id) i left join end_user_holds h on h.id = i.id left join model_attempts a on a.id = i.id", [id])).rows[0];
      const day = began?.day ? dayText(began.day) : began?.started_at ? utcDay(Number(began.started_at)) : utcDay(now);
      const left = await room(sql, tenant, user, await this.settings(tenant, sql), bucket, now, day);
      const taken = split(Math.max(0, want), left);
      if (taken.raw <= 0) return { refused: await refused(sql, tenant, user, bucket, left, now) };
      const updated = await sql.query("update end_user_holds set allowance = allowance + $2, paid = paid + $3, expires_at = $4 where id = $1", [id, taken.allowance, taken.paid, now + HOLD_MS]);
      // A hold that expired (its call went quiet for HOLD_MS) is held again from here; one its call settled already is
      // not: the call is over.
      if (!updated.rowCount && (await sql.query("select 1 from model_attempts where id = $1 and totals is not null", [id])).rowCount) return { hold: { id, raw: 0, allowance: 0, paid: 0 } };
      if (!updated.rowCount) {
        await sql.query("insert into end_user_holds (id, tenant, end_user, bucket, day, allowance, paid, expires_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [id, tenant, endUser, bucket, left.day, taken.allowance, taken.paid, now + HOLD_MS, now]);
      }
      return { hold: { id, ...taken } };
    });
  }

  /**
   * Hold `usd` of `endUser`'s credit for work that is not a model call (audio to transcribe, images), before it is sent:
   * all of it, or a 402 END_USER_CREDIT. Settle it with what the work cost, or release it if none was done. Undefined:
   * the tenant does not meter its end users.
   */
  async hold(tenant: string, endUser: string, bucket: string, usd: number, call: string, metadata: Record<string, unknown> = {}): Promise<CreditHold | undefined> {
    const id = randomUUID(), want = Math.ceil(usd * MICROS);
    const reserved = await this.reserve(tenant, endUser, bucket, { id, want, min: want });
    if (!reserved) return undefined;
    if (reserved.refused) throw creditError(reserved.refused);
    return {
      settle: usd => this.settleHold(tenant, endUser, bucket, id, Math.round(usd * MICROS), `${call}:${id}`, { call, ...metadata }),
      release: () => this.release(id),
    };
  }

  /** Keep a call's hold another HOLD_MS from now: a call still streaming, slowly, that needs no more of it yet. */
  async renew(tenant: string, endUser: string, id: string, now = Date.now()) {
    await transaction(this.db, async sql => {
      await lockEndUser(sql, tenant, endUser, now);
      await sql.query("update end_user_holds set expires_at = $2 where id = $1 and expires_at > $3", [id, now + HOLD_MS, now]);
    });
  }

  /** Give a hold back without spending it (a call that never went out). */
  async release(id: string) {
    await this.db.query("delete from end_user_holds where id = $1", [id]);
  }

  /**
   * Why `endUser` may not start more work in `bucket` now: nothing left of the bucket's allowance today and no paid room
   * (balance, daily limit), after holds. Undefined when they may, or the tenant does not meter its end users. A read,
   * for refusing a run before it starts: the hold its first call takes is what decides.
   */
  async refusal(tenant: string, endUser: string, bucket: string, now = Date.now()): Promise<CreditRefusal | undefined> {
    if (!await this.enabled(tenant)) return undefined;
    const user = (await this.db.query("select * from end_users where tenant = $1 and id = $2", [tenant, endUser])).rows[0]
      ?? { id: endUser, balance: 0, allowances: {}, bucket_limits: {}, daily_limit: null };
    const left = await room(this.db, tenant, user, await this.settings(tenant), bucket, now);
    return left.allowanceLeft > 0 || left.paidRoom > 0 ? undefined : refusal(endUser, bucket, left);
  }

  /**
   * Debit what a call cost (`raw`) that held nothing beforehand (a web search, a tool search's ranking), at once, once per
   * `key`. Its usage counts against the allowance and the balance as any call's does, and may take the balance below
   * zero: such calls cost cents, and they are refused once the user has nothing left (`refusal`).
   */
  async charge(tenant: string, endUser: string, bucket: string, raw: number, key: string, metadata: Record<string, unknown> = {}, now = Date.now()) {
    if (!(raw > 0) || !await this.enabled(tenant)) return;
    await transaction(this.db, async sql => {
      if ((await sql.query("select 1 from end_user_ledger where tenant = $1 and idempotency_key = $2", [tenant, key])).rowCount) return;
      await settleUsage(sql, { tenant, endUser, bucket, day: utcDay(now), raw, key, metadata }, now);
    });
  }

  /** Settle a hold that is not a model attempt's (a transcription, images): what the call cost (`raw`), posted once per `key`. */
  async settleHold(tenant: string, endUser: string, bucket: string, hold: string, raw: number, key: string, metadata: Record<string, unknown> = {}, now = Date.now()) {
    await transaction(this.db, async sql => {
      const day = (await sql.query("select day from end_user_holds where id = $1", [hold])).rows[0]?.day;
      if ((await sql.query("select 1 from end_user_ledger where tenant = $1 and idempotency_key = $2", [tenant, key])).rowCount) {
        await sql.query("delete from end_user_holds where id = $1", [hold]);
        return;
      }
      await settleUsage(sql, { tenant, endUser, bucket, day: day ? dayText(day) : utcDay(now), hold, raw, key, metadata }, now);
    });
  }
}

/** How long a call's hold lasts without a word from it: a call that streams extends it as it goes (`extend`). */
export const HOLD_MS = 10 * 60_000;

/** Credit held for work that is not a model call: settled with what it cost (USD), or released. */
export type CreditHold = { settle(usd: number): Promise<void>; release(): Promise<void> };

/** An end user's credit refusing work before it starts: 402, END_USER_CREDIT, with whose, which bucket and why. */
export function creditError(refused: CreditRefusal) {
  return new HttpError(402, refused.message, "END_USER_CREDIT", { endUser: refused.endUser, bucket: refused.bucket, reason: refused.reason });
}

/**
 * Why an end user's call was refused: their balance (nothing left of the bucket's allowance and none paid), their daily
 * limit, or the bucket's own daily limit on paid spend.
 */
export type CreditRefusal = { endUser: string; bucket: string; reason: CreditReason; message: string };
/**
 * Why an end user's credit refused or stopped work, the one list every path names (a 402's, a run's result, run.failed,
 * voice.session.ended's endUserReason): the balance, their daily credit limit, or the bucket's own daily limit on paid
 * spend. More may be added; code that meets one it does not know treats it as a credit refusal of no particular kind.
 */
export const CREDIT_REASONS = ["balance", "daily_limit", "bucket_limit"] as const;
export type CreditReason = typeof CREDIT_REASONS[number];
/** What a call holds: raw micro-USD in all, of which `allowance` from the bucket's allowance, and `paid` (charged) from the balance. */
export type Hold = { id: string; raw: number; allowance: number; paid: number };
export type Reserved = { hold: Hold; refused?: undefined } | { refused: CreditRefusal; hold?: undefined };

/** What an end user may still spend now in a bucket: its allowance left (raw), and room on the balance (charged). */
type Room = { day: string; allowance: number; allowanceLeft: number; paidRoom: number; bound: CreditRefusal["reason"]; balance: number; dailyLimit: number | null; bucketLimit: number | null; markupBps: number };

const dayText = (day: unknown) => day instanceof Date ? day.toISOString().slice(0, 10) : String(day).slice(0, 10);
const dollars = (micros: number) => `${micros < 0 ? "-" : ""}$${(Math.abs(micros) / MICROS).toFixed(2)}`;

/**
 * What `user` (their row, locked or as read) may still spend in `bucket` today: the bucket's allowance less what was
 * spent and what holds of that day (`day`: today, unless a call that began before midnight asks) take of it; and the balance less every hold, within the daily limit less what was paid
 * and held today, and within the bucket's own limit less what it paid and holds today.
 */
async function room(sql: Sql, tenant: string, user: any, settings: EndUserSettings, bucket: string, now: number, day = utcDay(now)): Promise<Room> {
  const [{ rows: days }, { rows: holds }] = await Promise.all([
    sql.query("select bucket, allowance_spent, paid_spent from end_user_days where tenant = $1 and end_user = $2 and day = $3", [tenant, user.id, day]),
    sql.query("select bucket, day, allowance, paid from end_user_holds where tenant = $1 and end_user = $2 and expires_at > $3", [tenant, user.id, now]),
  ]);
  const allowance = allowanceFor(settings.allowances, user.allowances ?? {}, bucket);
  const spent = Number(days.find(row => row.bucket === bucket)?.allowance_spent ?? 0);
  const paidToday = days.reduce((total, row) => total + Number(row.paid_spent), 0);
  const heldAllowance = holds.filter(row => row.bucket === bucket && dayText(row.day) === day).reduce((total, row) => total + Number(row.allowance), 0);
  const heldPaid = holds.reduce((total, row) => total + Number(row.paid), 0);
  const heldPaidToday = holds.filter(row => dayText(row.day) === day).reduce((total, row) => total + Number(row.paid), 0);
  const dailyLimit = user.daily_limit !== null && user.daily_limit !== undefined ? Number(user.daily_limit) : settings.dailyLimit;
  const bucketLimit = bucketLimitFor(settings.bucketLimits, user.bucket_limits ?? {}, bucket);
  const bucketPaid = Number(days.find(row => row.bucket === bucket)?.paid_spent ?? 0)
    + holds.filter(row => row.bucket === bucket && dayText(row.day) === day).reduce((total, row) => total + Number(row.paid), 0);
  const balance = Number(user.balance);
  const byBalance = balance - heldPaid;
  const byLimit = dailyLimit === null ? Infinity : dailyLimit - paidToday - heldPaidToday;
  const byBucket = bucketLimit === null ? Infinity : bucketLimit - bucketPaid;
  const least = Math.min(byBalance, byLimit, byBucket);
  return {
    day, allowance, allowanceLeft: Math.max(0, allowance - spent - heldAllowance), paidRoom: Math.max(0, least),
    bound: least === byBucket ? "bucket_limit" : least === byBalance ? "balance" : "daily_limit", balance, dailyLimit, bucketLimit, markupBps: settings.markupBps,
  };
}

/** `want` (raw) split as it is spent: from the allowance first, the rest from the balance at the markup, within `room`. */
function split(want: number, room: Room): Omit<Hold, "id"> {
  const allowance = Math.min(want, room.allowanceLeft);
  const rest = want - allowance;
  const paid = Math.min(marked(rest, room.markupBps), room.paidRoom);
  return { raw: allowance + Math.min(rest, unmarked(paid, room.markupBps)), allowance, paid };
}

function refusal(endUser: string, bucket: string, room: Room): CreditRefusal {
  const free = room.allowance <= 0 ? `"${bucket}" has no free allowance`
    : room.allowanceLeft > 0 ? `${dollars(room.allowanceLeft)} is left of the free ${dollars(room.allowance)} for "${bucket}" today`
    : `the free ${dollars(room.allowance)} for "${bucket}" today is used up`;
  const out = room.allowanceLeft > 0 || room.paidRoom > 0 ? "has too little credit left for this call" : "is out of credit";
  return room.bound === "daily_limit"
    ? { endUser, bucket, reason: "daily_limit", message: `This end user reached their daily credit limit of ${dollars(room.dailyLimit ?? 0)}, and ${free}` }
    : room.bound === "bucket_limit"
      ? { endUser, bucket, reason: "bucket_limit", message: room.bucketLimit ? `This end user reached the daily limit of ${dollars(room.bucketLimit)} of paid credit for "${bucket}", and ${free}` : `"${bucket}" spends no paid credit, and ${free}` }
      : { endUser, bucket, reason: "balance", message: `This end user ${out}: ${free}, and their balance is ${dollars(room.balance)}` };
}

/** What a call has posted to its user's ledger: its raw cost, the part the allowance covered, and what the balance paid. */
export type Posted = { raw: number; allowance: number; paid: number };
export const NOTHING_POSTED: Readonly<Posted> = Object.freeze({ raw: 0, allowance: 0, paid: 0 });

/**
 * Post what a call cost its end user: `raw` in all, of which `previous` was posted before (a corrected cost posts the
 * difference). More: from what is left of the bucket's allowance on the call's `day` (its own `hold`, released here, no
 * longer counting against it), the rest charged to the balance at the markup. Less: the balance is refunded first, then
 * the allowance. In the caller's transaction, which this locks the user in; returns what the call has posted now.
 */
export async function settleUsage(sql: Sql, call: { tenant: string; endUser: string; bucket: string; day: string; raw: number; key: string; hold?: string; previous?: Posted; metadata?: Record<string, unknown> }, now = Date.now()): Promise<Posted> {
  const { tenant, endUser, bucket, day } = call;
  const previous = call.previous ?? NOTHING_POSTED;
  const user = await lockEndUser(sql, tenant, endUser, now);
  if (call.hold) await sql.query("delete from end_user_holds where id = $1", [call.hold]);
  const raw = Math.max(0, Math.round(call.raw));
  if (raw === previous.raw) return previous;
  const settings = (await sql.query("select * from end_user_settings where tenant = $1", [tenant])).rows[0];
  const markupBps = Number(settings?.markup_bps ?? 0);
  let allowance: number, paid: number;
  if (raw > previous.raw) {
    const allowed = allowanceFor(settings?.allowances ?? {}, user.allowances ?? {}, bucket);
    const [{ rows: [spent] }, { rows: [held] }] = await Promise.all([
      sql.query("select allowance_spent from end_user_days where tenant = $1 and end_user = $2 and day = $3 and bucket = $4", [tenant, endUser, day, bucket]),
      sql.query("select coalesce(sum(allowance), 0)::bigint as allowance from end_user_holds where tenant = $1 and end_user = $2 and bucket = $3 and day = $4 and expires_at > $5", [tenant, endUser, bucket, day, now]),
    ]);
    const more = raw - previous.raw;
    const before = Number(spent?.allowance_spent ?? 0);
    const covered = Math.min(more, Math.max(0, allowed - before - Number(held.allowance)));
    allowance = previous.allowance + covered;
    paid = previous.paid + marked(more - covered, markupBps);
    // The bucket's allowance for the day is used up with this call: said once per user, bucket and day.
    if (allowed > 0 && before < allowed && before + covered >= allowed) {
      await exhausted(sql, tenant, endUser, { bucket, reason: "allowance", day, allowance: allowed, balance: Number(user.balance) - (paid - previous.paid) }, `allowance:${tenant}:${endUser}:${bucket}:${day}`);
    }
    // So is the bucket's own limit on paid spend: once per user, bucket and day.
    const bucketLimit = bucketLimitFor(settings?.bucket_limits ?? {}, user.bucket_limits ?? {}, bucket);
    if (bucketLimit !== null && paid > previous.paid) {
      const before = Number((await sql.query("select paid_spent from end_user_days where tenant = $1 and end_user = $2 and day = $3 and bucket = $4", [tenant, endUser, day, bucket])).rows[0]?.paid_spent ?? 0);
      if (before < bucketLimit && before + paid - previous.paid >= bucketLimit) {
        await exhausted(sql, tenant, endUser, { bucket, reason: "bucket_limit", day, bucketLimit, balance: Number(user.balance) - (paid - previous.paid) }, `bucket_limit:${tenant}:${endUser}:${bucket}:${day}`);
      }
    }
    // So is the daily limit on paid spend: once per user and day.
    const limit = user.daily_limit !== null && user.daily_limit !== undefined ? Number(user.daily_limit) : settings?.daily_limit !== null && settings?.daily_limit !== undefined ? Number(settings.daily_limit) : null;
    if (limit !== null && paid > previous.paid) {
      const today = Number((await sql.query("select coalesce(sum(paid_spent), 0)::bigint as paid from end_user_days where tenant = $1 and end_user = $2 and day = $3", [tenant, endUser, day])).rows[0].paid);
      if (today < limit && today + paid - previous.paid >= limit) {
        await exhausted(sql, tenant, endUser, { bucket, reason: "daily_limit", day, dailyLimit: limit, balance: Number(user.balance) - (paid - previous.paid) }, `daily_limit:${tenant}:${endUser}:${day}`);
      }
    }
  } else {
    // Less: what the balance paid is refunded first, at the rate it was paid at (the markup may have changed since), and
    // never more than it paid; then the allowance.
    allowance = Math.min(raw, previous.allowance);
    const paidRaw = previous.raw - previous.allowance;
    paid = paidRaw > 0 ? Math.min(previous.paid, Math.ceil((raw - allowance) * previous.paid / paidRaw)) : 0;
  }
  await sql.query(`insert into end_user_days (tenant, end_user, day, bucket, allowance_spent, paid_spent) values ($1, $2, $3, $4, $5, $6)
    on conflict (tenant, end_user, day, bucket) do update set allowance_spent = end_user_days.allowance_spent + excluded.allowance_spent, paid_spent = end_user_days.paid_spent + excluded.paid_spent`,
  [tenant, endUser, day, bucket, allowance - previous.allowance, paid - previous.paid]);
  await appendEntry(sql, {
    tenant, endUser, kind: "usage", amount: previous.paid - paid, raw: raw - previous.raw, allowance: allowance - previous.allowance, bucket, key: call.key,
    metadata: { ...call.metadata, day, ...(markupBps ? { markupBps } : {}) },
  }, Number(user.balance), now);
  return { raw, allowance, paid };
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
  if (entry.amount) {
    await sql.query("update end_users set balance = $3, updated_at = $4 where tenant = $1 and id = $2", [entry.tenant, entry.endUser, after, now]);
    await balanceNotices(sql, entry.tenant, entry.endUser, balance, after, entry.bucket ?? null, entry.kind === "refund");
  }
  return entryView(row);
}

/**
 * The webhooks a balance's move fires, in the transaction that moves it: end_user.balance.low as it falls below the
 * tenant's `lowBalance`, end_user.credit.exhausted (reason balance) as it reaches zero. Each fires once until the balance
 * rises past it again (its flag on the user's row, which the caller holds locked). A refund (money given back, the user
 * leaving) crosses them silently: no alert to top them up again, and none until a grant lifts the balance back past.
 */
async function balanceNotices(sql: Sql, tenant: string, endUser: string, before: number, after: number, bucket: string | null, silent = false) {
  const [{ rows: [user] }, { rows: [settings] }] = await Promise.all([
    sql.query("select low_notified, depleted_notified from end_users where tenant = $1 and id = $2", [tenant, endUser]),
    sql.query("select low_balance from end_user_settings where tenant = $1", [tenant]),
  ]);
  const threshold = settings?.low_balance === null || settings?.low_balance === undefined ? null : Number(settings.low_balance);
  let low: boolean = user.low_notified, depleted: boolean = user.depleted_notified;
  if (threshold !== null && after < threshold && before >= threshold && !low) {
    if (!silent) await enqueueEvents(sql, [webhookEvent("end_user.balance.low", tenant, { endUser, balance: after, threshold, previousBalance: before })]);
    low = true;
  } else if (threshold === null || after >= threshold) low = false;
  if (after <= 0 && before > 0 && !depleted) {
    if (!silent) await enqueueEvents(sql, [webhookEvent("end_user.credit.exhausted", tenant, { endUser, reason: "balance", bucket, balance: after, day: utcDay(Date.now()) })]);
    depleted = true;
  } else if (after > 0) depleted = false;
  if (low !== user.low_notified || depleted !== user.depleted_notified) {
    await sql.query("update end_users set low_notified = $3, depleted_notified = $4 where tenant = $1 and id = $2", [tenant, endUser, low, depleted]);
  }
}

/** end_user.credit.exhausted, once per `key` (a bucket's allowance for a day, the daily limit for a day). */
async function exhausted(sql: Sql, tenant: string, endUser: string, data: Record<string, unknown>, key: string) {
  await enqueueEvents(sql, [webhookEvent("end_user.credit.exhausted", tenant, { endUser, ...data }, key)]);
}

/**
 * A call refused for the user's credit (their row locked): why, and its webhook. With no balance left (not merely all of
 * it held), end_user.credit.exhausted fires once until they are credited again, as when a debit takes the balance to
 * zero; at the daily limit, once a day.
 */
async function refused(sql: Sql, tenant: string, user: any, bucket: string, room: Room, now: number): Promise<CreditRefusal> {
  const said = refusal(user.id, bucket, room);
  if (said.reason === "daily_limit") {
    await exhausted(sql, tenant, user.id, { bucket, reason: "daily_limit", day: room.day, dailyLimit: room.dailyLimit, balance: room.balance }, `daily_limit:${tenant}:${user.id}:${room.day}`);
  } else if (said.reason === "bucket_limit") {
    await exhausted(sql, tenant, user.id, { bucket, reason: "bucket_limit", day: room.day, bucketLimit: room.bucketLimit, balance: room.balance }, `bucket_limit:${tenant}:${user.id}:${bucket}:${room.day}`);
  } else if (!user.depleted_notified && room.balance <= 0) {
    await enqueueEvents(sql, [webhookEvent("end_user.credit.exhausted", tenant, { endUser: user.id, reason: "balance", bucket, balance: room.balance, day: room.day })]);
    await sql.query("update end_users set depleted_notified = true, updated_at = $3 where tenant = $1 and id = $2", [tenant, user.id, now]);
  }
  return said;
}
