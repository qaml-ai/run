import { randomUUID } from "node:crypto";
import type { Tenants } from "./tenants.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import type { Storage } from "../shared/storage.ts";
import { HttpError } from "./http.ts";
import { DEFAULT_PRICING, MICROS, storageCharge, usageTier, type Pricing } from "./pricing.ts";
import { busyCount, tierLimit, type BusyLimit } from "./busy-agents.ts";
import type { Stripe } from "./stripe.ts";
import { AutoTopup } from "./auto-topup.ts";
import { BillingPayments, stripeId } from "./billing-payments.ts";
import { CardCredit, CARD_CHECK } from "./card-credit.ts";
import type { StorageUsage } from "./storage-usage.ts";

/**
 * Prepaid credit. Tenants with `billing: "prepaid"` (every tenant created by sign-in)
 * pay from a balance: model tokens that ran on the platform's keys, time their agents
 * spend in turns, and storage. Every movement is in `credit_ledger`, in integer
 * micro-USD, under an idempotency key naming its cause, and moves
 * `credit_accounts.balance` in the same statement, so a retried flush, job or webhook
 * never posts twice and the ledger always sums to the balance. Entries are appended
 * and never change, except usage: each tenant's usage charges accrue into one entry
 * per UTC hour (see `accrueUsage`). A tenant whose balance is spent may not start runs;
 * a turn already running stops after its current response, so the overdraft is
 * bounded by one response and the time around it.
 */
export type BillingMode = "prepaid" | "none";
export type LedgerKind = "grant" | "purchase" | "usage" | "storage" | "adjustment" | "refund";
export const LEDGER_KINDS: LedgerKind[] = ["grant", "purchase", "usage", "storage", "adjustment", "refund"];
export interface LedgerEntry { tenant: string; kind: LedgerKind; amount: number; key: string; metadata?: Record<string, unknown> }
export interface LedgerRow { id: number; kind: LedgerKind; amount: number; metadata: Record<string, unknown>; createdAt: number }
/** `cardCheck`: verifying a card would unlock this much starting credit (src/card-credit.ts). */
export interface StartingCredit { status: "granted" | "not_eligible" | "not_granted" | "not_applicable"; amount: number; cardCheck?: { amount: number } }
/** What a usage flush charges a tenant: `amount` micro-USD spent, and its breakdown (numbers, summed over the hour). */
export interface UsageCharge { tenant: string; amount: number; metadata: Record<string, number> }
/** What limits a tenant's runs: its balance, what it ever bought (none: on free credit), its usage charges in the last hour, and whether a payment of its is disputed. */
type Account = { balance: number; purchased: number; lastHour: number; disputed: boolean };
/** A Stripe dispute closed with one of these leaves the money with us: its debit is restored. */
const DISPUTE_RESTORED = ["won", "warning_closed", "prevented"];

/** Debits on other nodes count toward a tenant's balance within this long. */
const BALANCE_CACHE_MS = 5_000;
/** A self-serve tenant's billing mode changes only by hand; re-read it this often. */
const MODE_CACHE_MS = 60_000;
/** A claimed billing job whose node died is taken again after this long. */
const JOB_CLAIM_MS = 60 * 60_000;
const usd = (amount: number) => `${amount < 0 ? "-" : ""}$${(Math.abs(amount) / MICROS).toFixed(2)}`;
/** Marks checkout sessions this runtime created: the Stripe account also serves other products, whose events are ignored. */
const PURPOSE = "agent-runtime-credit";
const CENT = 10_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Append the entries whose keys are new and move their tenants' balances, in one
 * statement (so inside or outside a transaction it is all or nothing). Returns the
 * entries appended; a key already in the ledger is skipped.
 */
export async function postLedger(sql: Sql, entries: LedgerEntry[], now = Date.now()): Promise<(LedgerEntry & { id: number })[]> {
  if (!entries.length) return [];
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amount)) throw new Error("Ledger amounts are integer micro-USD");
    if (!LEDGER_KINDS.includes(entry.kind)) throw new Error(`Unknown ledger kind ${entry.kind}`);
  }
  const { rows } = await sql.query(`
    with input as (
      select * from jsonb_to_recordset($1::jsonb) as t(tenant text, kind text, amount bigint, key text, metadata jsonb)
    ), appended as (
      insert into credit_ledger (tenant, kind, amount, idempotency_key, metadata, created_at)
      select tenant, kind, amount, key, coalesce(metadata, '{}'), $2 from input order by tenant, key
      on conflict (idempotency_key) do nothing
      returning id, tenant, kind, amount, idempotency_key, metadata
    ), moved as (
      insert into credit_accounts (tenant, balance, purchased)
      select tenant, sum(amount), coalesce(sum(amount) filter (where kind in ('purchase', 'refund')), 0) from appended group by tenant order by tenant
      on conflict (tenant) do update set balance = credit_accounts.balance + excluded.balance, purchased = credit_accounts.purchased + excluded.purchased
    )
    select id, tenant, kind, amount, idempotency_key as key, metadata from appended`, [JSON.stringify(entries), now]);
  return rows;
}

/**
 * Debit usage charges and add them to each tenant's usage entry for the current UTC
 * hour (key `usage:<tenant>:<hour>`): the hour's first flush creates it, later ones
 * add to its amount and to the numbers in its metadata, so the ledger has one usage
 * row per tenant per hour, not one per flush, and still sums to the balance. The same
 * statement counts the spend by minute (`credit_spend_minutes`), which the free hourly
 * limit reads as a sliding hour. It is not idempotent by itself: a usage flush runs it
 * in the transaction that records its batch id, so a retried flush applies once.
 * Concurrent flushes for a tenant queue on its entry's row lock, then add up.
 */
export async function accrueUsage(sql: Sql, charges: UsageCharge[], now = Date.now()) {
  if (!charges.length) return;
  for (const charge of charges) if (!Number.isSafeInteger(charge.amount) || charge.amount <= 0) throw new Error("Usage charges are positive integer micro-USD");
  const hour = new Date(Math.floor(now / HOUR) * HOUR).toISOString();
  await sql.query(`
    with input as (
      select * from jsonb_to_recordset($1::jsonb) as t(tenant text, amount bigint, metadata jsonb)
    ), accrued as (
      -- In tenant order, so flushes on different nodes lock rows in the same order.
      insert into credit_ledger as entry (tenant, kind, amount, idempotency_key, metadata, created_at)
      select tenant, 'usage', -amount, 'usage:' || tenant || ':' || $2, metadata || jsonb_build_object('hour', $2::text), $3 from input order by tenant
      on conflict (idempotency_key) do update set amount = entry.amount + excluded.amount, metadata = (
        select jsonb_object_agg(key, case
          when jsonb_typeof(entry.metadata -> key) = 'number' and jsonb_typeof(excluded.metadata -> key) = 'number'
          then to_jsonb((entry.metadata ->> key)::numeric + (excluded.metadata ->> key)::numeric) else value end)
        from jsonb_each(entry.metadata || excluded.metadata))
    ), spent as (
      insert into credit_spend_minutes (tenant, minute, amount) select tenant, $4, amount from input order by tenant
      on conflict (tenant, minute) do update set amount = credit_spend_minutes.amount + excluded.amount
    )
    insert into credit_accounts (tenant, balance) select tenant, -amount from input order by tenant
    on conflict (tenant) do update set balance = credit_accounts.balance + excluded.balance`,
  [JSON.stringify(charges), hour, Date.parse(hour), Math.floor(now / MINUTE)]);
}

export interface BillingOptions {
  db: Db;
  tenants: Tenants;
  pricing?: Pricing;
  /** Where the console is, for the message that asks for a top-up. */
  publicUrl?: string;
  /** Debits this node recorded and has not written yet (Accounts' pending usage). */
  pending?: (tenant: string) => number;
  /** Write pending usage, before a balance is read. */
  flush?: () => Promise<void>;
  /** Credit purchases through Stripe Checkout; without it, credit only comes from grants and adjustments. */
  stripe?: Stripe;
  /** Busy agents at once for a tenant that is not prepaid and has no `maxAgents` of its own (AGENT_MAX_AGENTS_PER_TENANT; default 4). */
  maxAgentsPerTenant?: number;
}

export class Billing {
  readonly db: Db;
  readonly tenants: Tenants;
  readonly pricing: Pricing;
  private readonly options: BillingOptions;
  readonly payments?: BillingPayments;
  readonly autoTopup?: AutoTopup;
  readonly cardCredit?: CardCredit;
  /** Each tenant's balance, lifetime purchases and usage spend in the last hour, as last read. */
  private readonly accounts = new Map<string, Account & { until: number }>();
  private readonly reads = new Map<string, Promise<Account>>();
  private readonly modes = new Map<string, { mode: BillingMode; maxStorageBytes?: number; agentCreatesPerMinute?: number; runsPerMinute?: number; maxRunResponses?: number; maxRunSeconds?: number; until: number }>();

  constructor(options: BillingOptions) {
    this.options = options;
    this.db = options.db;
    this.tenants = options.tenants;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
    if (options.stripe) {
      this.payments = new BillingPayments(this.db, options.stripe, this.pricing, options.publicUrl);
      this.autoTopup = new AutoTopup(this, options.stripe);
      this.cardCredit = new CardCredit(this, options.stripe, options.publicUrl);
    }
  }

  /** Admin tenants are billed as their entry says (unbilled by default); tenants created by sign-in as their row says. */
  async mode(tenant: string): Promise<BillingMode> {
    return this.tenants.billing(tenant) ?? (await this.row(tenant)).mode;
  }

  /** A self-serve tenant's billing mode and the limits set for it (`tenants.limits`), re-read at most every minute. */
  private async row(tenant: string) {
    const cached = this.modes.get(tenant);
    if (cached && cached.until > Date.now()) return cached;
    const row = (await this.db.query("select billing, limits from tenants where id = $1", [tenant])).rows[0];
    const set = (key: string) => Number.isSafeInteger(row?.limits?.[key]) ? { [key]: row.limits[key] as number } : {};
    const entry: { mode: BillingMode; maxStorageBytes?: number; agentCreatesPerMinute?: number; runsPerMinute?: number; maxRunResponses?: number; maxRunSeconds?: number; until: number } = {
      mode: (row?.billing === "prepaid" ? "prepaid" : "none") as BillingMode, ...set("maxStorageBytes"), ...set("agentCreatesPerMinute"), ...set("runsPerMinute"),
      ...set("maxRunResponses"), ...set("maxRunSeconds"), until: Date.now() + MODE_CACHE_MS,
    };
    this.modes.set(tenant, entry);
    return entry;
  }

  /** Forget a self-serve tenant's mode and limits as read, after the operator changed them. */
  forgetLimits(tenant: string) { this.modes.delete(tenant); }

  /** A self-serve tenant's own per-minute rate limit (`tenants.limits`), if the operator set one; admin tenants' are in the tenants file. */
  async rateLimit(tenant: string, limit: "agentCreates" | "runs"): Promise<number | undefined> {
    if (this.tenants.billing(tenant)) return undefined;
    return (await this.row(tenant))[limit === "runs" ? "runsPerMinute" : "agentCreatesPerMinute"];
  }

  /**
   * The most one run of the tenant's agents may take, as set for it: an admin tenant's entry (`maxRunResponses`,
   * `maxRunSeconds`; absent, no limit), else for a self-serve tenant `tenants.limits` (absent: undefined, the runtime's).
   */
  async runLimits(tenant: string): Promise<{ maxResponses?: number; maxSeconds?: number }> {
    if (this.tenants.has(tenant)) return this.tenants.runLimits(tenant);
    const row = await this.row(tenant);
    return { maxResponses: row.maxRunResponses, maxSeconds: row.maxRunSeconds };
  }

  /**
   * How many bytes the tenant may store in all, or undefined for no limit; throws 402 when a prepaid tenant's credit is
   * spent, since storage is charged daily and a spent balance cannot pay for more. The limit is the one set for the
   * tenant (its tenants-file entry's `maxStorageGb`, else `tenants.limits`), else for a prepaid tenant the plan's: free
   * credit's, or once it has bought credit, the paid one. Unbilled tenants have none unless one is set.
   */
  async storageLimit(tenant: string): Promise<number | undefined> {
    const admin = this.tenants.maxStorageBytes(tenant);
    const row = this.tenants.billing(tenant) ? undefined : await this.row(tenant);
    const set = admin ?? row?.maxStorageBytes;
    if ((this.tenants.billing(tenant) ?? row?.mode) !== "prepaid") return set;
    const { balance, purchased } = await this.account(tenant);
    if (balance <= 0) throw new HttpError(402, `This account is out of credit (balance ${usd(balance)}), so it cannot store more files`, "INSUFFICIENT_CREDIT");
    return set ?? (purchased > 0 ? this.pricing.maxStorageBytes : this.pricing.free.maxStorageBytes);
  }

  /** The tenant's account, with what this node has recorded and not yet written counted in, read at most every few seconds. */
  async account(tenant: string): Promise<Account> {
    const cached = this.accounts.get(tenant);
    const stored = cached && cached.until > Date.now() ? cached : await this.read(tenant);
    const pending = this.options.pending?.(tenant) ?? 0;
    return { balance: stored.balance - pending, purchased: stored.purchased, lastHour: stored.lastHour + pending, disputed: stored.disputed };
  }

  private read(tenant: string) {
    let reading = this.reads.get(tenant);
    if (!reading) {
      reading = (async () => {
        await this.options.flush?.();
        const { rows: [row] } = await this.db.query(`
          select balance, purchased, (select coalesce(sum(amount), 0) from credit_spend_minutes where tenant = $1 and minute >= $2) as last_hour,
            exists (select 1 from billing_disputes where tenant = $1 and not closed) as disputed
          from (select $1::text as tenant) as t left join credit_accounts using (tenant)`, [tenant, Math.floor((Date.now() - HOUR) / MINUTE)]);
        const value = { balance: row.balance ?? 0, purchased: row.purchased ?? 0, lastHour: Number(row.last_hour), disputed: row.disputed };
        this.accounts.set(tenant, { ...value, until: Date.now() + BALANCE_CACHE_MS });
        return value;
      })().finally(() => this.reads.delete(tenant));
      this.reads.set(tenant, reading);
    }
    return reading;
  }

  /**
   * Why a prepaid tenant may not start or continue runs: one of its payments is disputed (402 until the
   * dispute closes), its credit is spent (402), or, on free credit, it has spent the free hourly allowance
   * (429 until the hour's spend ages out).
   * The messages state the fact and nothing to buy: they reach whoever called, through the API,
   * the SDKs, chat channels and MCP clients such as ChatGPT, where an upsell does not belong. The
   * console and billing emails say where to add credit themselves.
   */
  async creditLimit(tenant: string): Promise<HttpError | undefined> {
    if (await this.mode(tenant) !== "prepaid") return undefined;
    const { balance, purchased, lastHour, disputed } = await this.account(tenant);
    if (disputed) return new HttpError(402, "A payment for this account's credit is disputed with the card issuer, so runs cannot start until the dispute is resolved");
    if (balance <= 0) return new HttpError(402, `This account is out of credit (balance ${usd(balance)}), so runs cannot start`);
    const allowance = this.pricing.free.hourlySpend;
    if (purchased <= 0 && lastHour >= allowance) {
      return new HttpError(429, `This account has reached its spending limit on free credit: ${usd(lastHour)} in the last hour, of ${usd(allowance)} an hour; try again later`);
    }
    return undefined;
  }

  /** Whether a prepaid tenant has never bought credit (or had it all refunded): it has the free limits. */
  async onFreeCredit(tenant: string) {
    return await this.mode(tenant) === "prepaid" && (await this.account(tenant)).purchased <= 0;
  }

  /**
   * How many agents `tenant` may have busy at once across the fleet: its tenants-file entry's `maxAgents`, else
   * the operator's `maxBusyAgents` for a self-serve tenant (`tenants.limits`), else for a prepaid tenant its usage
   * tier's, else the deployment's. The tier comes from what the tenant has paid,
   * read from its account row (in `sql`, the caller's transaction) each time, so a payment applies at once.
   */
  async busyLimit(tenant: string, sql: Sql = this.db): Promise<BusyLimit> {
    const own = this.tenants.maxAgents(tenant);
    if (own !== undefined) return { limit: own, source: "tenant" };
    // A self-serve tenant's row (the operator's maxBusyAgents, and its mode) and what it has paid, read together and afresh.
    const { rows: [row] } = await sql.query(`
      select t.billing, t.limits -> 'maxBusyAgents' as max_busy, a.purchased from (select $1::text as id) as x
      left join tenants t on t.id = x.id left join credit_accounts a on a.tenant = x.id`, [tenant]);
    if (!this.tenants.billing(tenant) && Number.isSafeInteger(row.max_busy) && row.max_busy > 0) return { limit: row.max_busy, source: "tenant" };
    if ((this.tenants.billing(tenant) ?? (row.billing === "prepaid" ? "prepaid" : "none")) !== "prepaid") return { limit: this.options.maxAgentsPerTenant ?? 4, source: "default" };
    const paid = Number(row.purchased ?? 0);
    const { tier, next } = usageTier(this.pricing.tiers, paid);
    return tierLimit(tier, next, paid);
  }

  /** Append entries (see `postLedger`); the balances they move are read afresh next time. */
  async post(entries: LedgerEntry[], sql: Sql = this.db) {
    const appended = await postLedger(sql, entries);
    for (const entry of entries) this.accounts.delete(entry.tenant);
    return appended;
  }

  /** Forget cached balances after entries were appended in a transaction of the caller's. */
  invalidate(tenants: Iterable<string>) { for (const tenant of tenants) this.accounts.delete(tenant); }

  /** Called inside the signup/support transaction, under the identity's advisory lock. */
  async recordStartingCredit(sql: Sql, signup: { tenant: string; githubId: number; signupAt: number; created: boolean; githubCreatedAt?: number; minAccountAgeMs?: number }) {
    const { tenant, githubId, signupAt, created, githubCreatedAt, minAccountAgeMs } = signup;
    if ((await sql.query("select 1 from starting_credit_decisions where github_id = $1", [githubId])).rowCount) return;
    // This also covers awards made before the decision table was introduced.
    const prior = (await sql.query("select id, tenant, amount from credit_ledger where idempotency_key = $1 and kind = 'grant'", [`grant:github:${githubId}`])).rows[0];
    const amount = created ? this.pricing.startingGrant : prior?.amount ?? 0;
    if (created && amount > 0 && !prior && (minAccountAgeMs === undefined || !Number.isSafeInteger(minAccountAgeMs) || minAccountAgeMs < 0)) {
      throw new Error("Starting credit is not configured; contact support");
    }
    const eligible = created && amount > 0 && githubCreatedAt !== undefined && signupAt - githubCreatedAt >= minAccountAgeMs!;
    const decision = prior || !created ? "legacy" : amount === 0 ? "disabled" : eligible ? "eligible" : "ineligible";
    let entry = !prior && eligible ? (await postLedger(sql, [{
      tenant, kind: "grant", amount, key: `grant:github:${githubId}`, metadata: { reason: "Starting credit" },
    }]))[0] : prior;
    // An older writer may have posted the same key during a rolling deployment.
    if (!entry && eligible) entry = (await sql.query("select id, tenant, amount from credit_ledger where idempotency_key = $1 and kind = 'grant'", [`grant:github:${githubId}`])).rows[0];
    await sql.query(`insert into starting_credit_decisions
      (github_id, tenant, decision, offered_amount, minimum_account_age_ms, github_created_at, signup_at, decided_at, grant_ledger_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [githubId, entry?.tenant ?? tenant, decision, amount, created ? minAccountAgeMs ?? null : null,
      created ? githubCreatedAt ?? null : null, signupAt, Date.now(), entry?.id ?? null]);
  }

  /** Only the public outcome and the amount actually awarded, never policy inputs or support notes. */
  async startingCredit(tenant: string): Promise<StartingCredit> {
    const row = (await this.db.query(`select t.billing, d.decision, coalesce(l.amount, card.amount) as amount
      from tenants t left join starting_credit_decisions d on d.github_id = t.github_id and d.tenant = t.id
      left join credit_ledger l on l.id = d.grant_ledger_id and l.tenant = t.id
      left join card_checks c on c.tenant = t.id and c.granted
      left join credit_ledger card on card.id = c.grant_ledger_id and card.tenant = t.id
      where t.id = $1`, [tenant])).rows[0];
    if (!row || row.billing !== "prepaid") return { status: "not_applicable", amount: 0 };
    if (row.amount > 0) return { status: "granted", amount: row.amount };
    const cardCheck = await this.cardCredit?.available(tenant) ? { cardCheck: { amount: this.pricing.startingGrant } } : {};
    return { status: row.decision === "disabled" ? "not_applicable" : row.decision === "ineligible" ? "not_eligible" : "not_granted", amount: 0, ...cardCheck };
  }

  /** An operator-approved exception uses the same identity key as an automatic signup award. */
  async grantStartingCredit(tenant: string, amount: number, reason: string, by: string): Promise<LedgerRow> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, "Starting credit must be a positive integer amount in micro-USD");
    if (!reason.trim()) throw new HttpError(400, "A reason is required");
    const identity = (await this.db.query("select github_id from tenants where id = $1", [tenant])).rows[0];
    if (!identity?.github_id) throw new HttpError(400, "This tenant has no GitHub identity for a starting-credit grant");
    const result = await transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`starting-credit:${identity.github_id}`]);
      const account = (await sql.query("select billing, created_at from tenants where id = $1 and github_id = $2 for update", [tenant, identity.github_id])).rows[0];
      if (!account || account.billing !== "prepaid") throw new HttpError(400, "This tenant is not billed with prepaid credit");
      if ((await sql.query("select 1 from card_checks where tenant = $1 and granted", [tenant])).rowCount) throw new HttpError(409, "This tenant already unlocked starting credit with a card check");
      await this.recordStartingCredit(sql, { tenant, githubId: identity.github_id, signupAt: account.created_at, created: false });
      const decision = (await sql.query("select tenant from starting_credit_decisions where github_id = $1", [identity.github_id])).rows[0];
      if (decision.tenant !== tenant) throw new HttpError(409, "This GitHub identity already has a starting-credit decision for another tenant");
      const key = `grant:github:${identity.github_id}`;
      const previous = (await sql.query("select * from credit_ledger where idempotency_key = $1", [key])).rows[0];
      if (previous && (previous.tenant !== tenant || previous.amount !== amount || previous.kind !== "grant")) {
        throw new HttpError(409, "This GitHub identity already has a different starting-credit grant");
      }
      if (!previous) {
        const [entry] = await postLedger(sql, [{ tenant, kind: "grant", amount, key, metadata: { reason: "Starting credit" } }]);
        await sql.query("update starting_credit_decisions set grant_ledger_id = $2, granted_by = $3, support_note = $4 where github_id = $1", [identity.github_id, entry.id, by, reason.trim()]);
      } else {
        await sql.query("update starting_credit_decisions set grant_ledger_id = $2 where github_id = $1 and grant_ledger_id is null", [identity.github_id, previous.id]);
      }
      const row = (await sql.query("select id, kind, amount, metadata, created_at from credit_ledger where idempotency_key = $1", [key])).rows[0];
      return { id: row.id, kind: row.kind, amount: row.amount, metadata: row.metadata, createdAt: row.created_at };
    });
    this.invalidate([tenant]);
    return result;
  }

  /** A page of the tenant's ledger, newest first: entries before the id `before`. */
  async ledger(tenant: string, options: { before?: number; limit?: number } = {}): Promise<{ entries: LedgerRow[]; next?: number }> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const { rows } = await this.db.query(`
      select l.id, l.kind, l.amount, l.metadata || case when c.invoice_url is null then '{}'::jsonb else jsonb_build_object('invoiceUrl',c.invoice_url) end as metadata, l.created_at from credit_ledger l
      left join billing_checkouts c on l.metadata->>'order'=c.id::text and c.tenant=l.tenant
      where l.tenant = $1 and ($2::bigint is null or l.id < $2) order by l.id desc limit $3`, [tenant, options.before ?? null, limit + 1]);
    const entries = rows.slice(0, limit).map(row => ({ id: row.id, kind: row.kind, amount: row.amount, metadata: row.metadata, createdAt: row.created_at }));
    return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.id } : {}) };
  }

  /** What GET /v1/billing shows: the balance, this month's movements by kind, recent entries and the rates. */
  async summary(tenant: string) {
    await this.options.flush?.();
    const mode = await this.mode(tenant);
    const { balance, purchased } = await this.account(tenant);
    const month = new Date().toISOString().slice(0, 7);
    const since = Date.parse(`${month}-01T00:00:00Z`);
    const { rows } = await this.db.query("select kind, sum(amount) as amount from credit_ledger where tenant = $1 and created_at >= $2 group by kind", [tenant, since]);
    const thisMonth = Object.fromEntries(LEDGER_KINDS.map(kind => [kind, Number(rows.find(row => row.kind === kind)?.amount ?? 0)])) as Record<LedgerKind, number>;
    const pricing = this.pricing;
    const [limit, busy] = await Promise.all([this.busyLimit(tenant), busyCount(this.db, tenant)]);
    return {
      billing: mode, balance, purchased, freeCredit: mode === "prepaid" && purchased <= 0, checkout: !!this.options.stripe,
      busyAgents: { busy, ...limit },
      startingCredit: mode === "prepaid" ? await this.startingCredit(tenant) : { status: "not_applicable" as const, amount: 0 },
      month: { since, ...thisMonth },
      recent: (await this.ledger(tenant, { limit: 10 })).entries,
      rates: { agentHour: pricing.agentHour, storageGbMonth: pricing.storageGbMonth, openrouterCreditMultiplier: pricing.openrouterCreditMultiplier, purchaseFeeBps: pricing.purchaseFeeBps, minPurchase: pricing.minPurchase, maxPurchase: pricing.maxPurchase, webSearch: { ...pricing.webSearch }, webRender: pricing.webRender },
    };
  }

  // Purchases -----------------------------------------------------------------

  /**
   * A Stripe Checkout session buying `amount` of credit (whole cents), with the fee as a
   * line of its own. The credit is added when Stripe reports the payment (`webhook`).
   */
  async checkout(tenant: string, amount: number, requestId?: string) {
    const stripe = this.options.stripe;
    if (!stripe) throw new HttpError(503, "Credit purchases are not configured on this runtime");
    if (await this.mode(tenant) !== "prepaid") throw new HttpError(400, "This tenant is not billed with prepaid credit");
    const { minPurchase, maxPurchase } = this.pricing;
    if (!Number.isSafeInteger(amount) || amount % CENT || amount < minPurchase || amount > maxPurchase) {
      throw new HttpError(400, `Buy between ${usd(minPurchase)} and ${usd(maxPurchase)} of credit, in whole cents`);
    }
    return this.payments!.checkout(tenant, amount, requestId);
  }

  async portal(tenant: string, flow: "manage" | "payment_method", resumeAutoTopup = false) {
    if (!this.payments) throw new HttpError(503, "Stripe billing is not configured");
    if (await this.mode(tenant) !== "prepaid") throw new HttpError(400, "This tenant is not billed with prepaid credit");
    return this.payments.portal(tenant, flow, resumeAutoTopup);
  }

  async paymentMethod(tenant: string) {
    if (!this.payments) return { portal: false, customer: false, card: null };
    if (await this.mode(tenant) !== "prepaid") throw new HttpError(400, "This tenant is not billed with prepaid credit");
    return this.payments.paymentMethod(tenant);
  }

  /**
   * A Stripe webhook: a paid checkout adds the credit bought (not the fee), once per
   * session; a refund removes credit in proportion to the amount refunded, once per
   * refunded total; a dispute (`dispute`) removes the disputed share until it closes. Events for anything this
   * runtime did not sell are acknowledged and ignored.
   */
  async webhook(payload: string, signature: string | undefined): Promise<{ handled: string }> {
    const stripe = this.options.stripe;
    if (!stripe) throw new HttpError(404, "Credit purchases are not configured on this runtime");
    const event = stripe.verify(payload, signature);
    if (!event) throw new HttpError(400, "Invalid Stripe signature");
    if (event.livemode !== undefined && event.livemode !== stripe.live) return { handled: "ignored" };
    const object = event.data?.object ?? {};
    if (event.type === "checkout.session.completed" && object.mode === "setup" && object.metadata?.purpose === CARD_CHECK) {
      await this.cardCredit!.settle(object);
      return { handled: "card check" };
    }
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (object.metadata?.purpose !== PURPOSE) return { handled: "ignored" };
      if (object.payment_status !== "paid") return { handled: "awaiting payment" };
      const order = await this.payments!.purchase(object);
      const tenant = order?.tenant ?? object.metadata.tenant, amount = order?.amount ?? Number(object.metadata.credit);
      if (typeof tenant !== "string" || !Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, "Checkout session without a tenant or credit amount");
      if (typeof object.id !== "string") throw new HttpError(400, "Checkout session without an id");
      const paymentIntent = stripeId(object.payment_intent);
      if (order && !paymentIntent) throw new HttpError(400, "Paid Checkout has no payment intent");
      const posted = await transaction(this.db, async sql => {
        if (order) await this.payments!.recordPaid(sql, order, object, paymentIntent!);
        const purchase: LedgerEntry = { tenant, kind: "purchase", amount, key: `purchase:${object.id}`,
          metadata: { session: object.id, paymentIntent: paymentIntent ?? null, paid: object.amount_total ?? null, currency: object.currency ?? null, ...(order ? { order: order.id, invoice: stripeId(object.invoice) ?? null } : {}) } };
        const appended = await this.fulfillPurchase(sql, purchase, paymentIntent ?? object.id);
        if (typeof object.customer === "string") await sql.query("update credit_accounts set stripe_customer = coalesce(stripe_customer, $2) where tenant = $1", [tenant, object.customer]);
        return appended;
      });
      this.invalidate(posted.map(entry => entry.tenant));
      console.log(JSON.stringify({ type: "credit_purchased", tenant, amount, session: object.id }));
      return { handled: "purchase" };
    }
    if (event.type.startsWith("invoice.") && typeof object.id === "string") {
      await this.autoTopup?.wake(object.id);
      if (event.type === "invoice.paid") await this.payments?.attachInvoice(object);
    }
    if (event.type === "charge.refunded") return { handled: await this.refund(object) };
    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") return { handled: await this.dispute(object, event.type === "charge.dispute.closed") };
    return { handled: "ignored" };
  }

  /** Shared settlement for Checkout and automatic invoices. Caller owns the transaction. */
  async fulfillPurchase(sql: Sql, purchase: LedgerEntry, paymentIntent: string) {
    await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-runtime-payment:${paymentIntent}`]);
    const prior = (await sql.query("select tenant,amount,metadata from credit_ledger where idempotency_key=$1", [purchase.key])).rows[0];
    const same = (await sql.query("select idempotency_key from credit_ledger where kind='purchase' and metadata->>'paymentIntent'=$1", [paymentIntent])).rows[0];
    if (same && same.idempotency_key !== purchase.key) throw new HttpError(400, "Payment is already attached to another purchase");
    if (prior && (prior.tenant !== purchase.tenant || prior.amount !== purchase.amount || prior.metadata.paymentIntent !== purchase.metadata?.paymentIntent)) throw new HttpError(400, "Purchase conflicts with its recorded payment");
    if (prior) purchase = { ...purchase, metadata: prior.metadata };
    const refunds = await this.refundEntries(sql, purchase, paymentIntent);
    await sql.query("update billing_disputes set tenant = $2 where payment_intent = $1 and tenant is null", [paymentIntent, purchase.tenant]);
    const disputes = await this.disputeEntries(sql, purchase, paymentIntent, refunds);
    return postLedger(sql, [purchase, ...refunds, ...disputes]);
  }

  /**
   * A card dispute (chargeback) on a credit purchase, kept by payment intent like a refund until its purchase is
   * known. While it is open the disputed share of the purchase's credit is debited (a `refund` entry keyed by the
   * dispute), the tenant may not start runs (`creditLimit`) and its auto top-up is turned off, so a stolen card's
   * credit cannot be spent or the card charged again. Closed in our favour (`DISPUTE_RESTORED`), the debit is
   * reversed; lost, it stands. A closed dispute never reopens, whatever order Stripe delivers its events in.
   */
  private async dispute(dispute: { id?: string; charge?: unknown; payment_intent?: unknown; amount?: number; currency?: string; status?: string; reason?: string }, closed: boolean) {
    const paymentIntent = stripeId(dispute.payment_intent);
    if (typeof dispute.id !== "string" || !paymentIntent) return "ignored";
    if (!Number.isSafeInteger(dispute.amount) || dispute.amount! <= 0 || typeof dispute.status !== "string") throw new HttpError(400, "Invalid dispute");
    const result = await transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-runtime-payment:${paymentIntent}`]);
      const now = Date.now();
      const stored = await sql.query(`insert into billing_disputes (id, payment_intent, charge, amount, currency, status, reason, closed, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        on conflict (id) do update set status = case when billing_disputes.closed then billing_disputes.status else excluded.status end,
          closed = billing_disputes.closed or excluded.closed, updated_at = excluded.updated_at
        where billing_disputes.payment_intent = excluded.payment_intent returning id`,
      [dispute.id, paymentIntent, stripeId(dispute.charge) ?? null, dispute.amount, dispute.currency ?? null, dispute.status, dispute.reason ?? null, closed, now]);
      if (!stored.rowCount) throw new HttpError(400, "Dispute conflicts with its recorded payment");
      const purchase = (await sql.query("select tenant, amount, metadata from credit_ledger where kind = 'purchase' and metadata->>'paymentIntent' = $1", [paymentIntent])).rows[0];
      if (!purchase) return undefined;
      await sql.query("update billing_disputes set tenant = $2 where payment_intent = $1 and tenant is null", [paymentIntent, purchase.tenant]);
      return { tenant: purchase.tenant as string, posted: await postLedger(sql, await this.disputeEntries(sql, purchase, paymentIntent)) };
    });
    if (!result) {
      console.error(JSON.stringify({ type: "billing_dispute_unmatched", dispute: dispute.id, paymentIntent, status: dispute.status }));
      return "pending dispute";
    }
    this.invalidate([result.tenant]);
    console.error(JSON.stringify({ type: closed ? "billing_dispute_closed" : "billing_dispute_opened", tenant: result.tenant, dispute: dispute.id, status: dispute.status, amount: dispute.amount, reason: dispute.reason ?? null }));
    if (!closed) await this.autoTopup?.disable(result.tenant).catch(error => console.error(JSON.stringify({ type: "billing_dispute_auto_topup", tenant: result.tenant, error: String(error) })));
    return closed ? "dispute closed" : "dispute";
  }

  /**
   * The ledger entries a purchase's disputes call for and are not yet in it: each dispute's debit, the disputed
   * share of the credit bought (no more than refunds, `pending` among them, left), unless it closed in our favour
   * before any debit; and the debit's reversal once it has.
   */
  private async disputeEntries(sql: Sql, purchase: { tenant: string; amount: number; metadata?: Record<string, unknown> }, paymentIntent: string, pending: LedgerEntry[] = []): Promise<LedgerEntry[]> {
    const disputes = (await sql.query("select * from billing_disputes where payment_intent = $1 order by id", [paymentIntent])).rows;
    if (!disputes.length) return [];
    const posted = new Map((await sql.query("select idempotency_key, amount from credit_ledger where kind = 'refund' and metadata->>'paymentIntent' = $1", [paymentIntent])).rows.map(row => [row.idempotency_key as string, Number(row.amount)]));
    let remaining = purchase.amount + [...posted.values(), ...pending.map(entry => entry.amount)].reduce((sum, amount) => sum + amount, 0);
    const entries: LedgerEntry[] = [];
    for (const dispute of disputes) {
      const restored = dispute.closed && DISPUTE_RESTORED.includes(dispute.status);
      let debit = posted.get(`dispute:${dispute.id}`);
      if (debit === undefined && !restored) {
        const paid = typeof purchase.metadata?.paid === "number" && purchase.metadata.paid > 0 ? purchase.metadata.paid : dispute.amount;
        const target = Number((BigInt(purchase.amount) * BigInt(Math.min(dispute.amount, paid)) * 2n + BigInt(paid)) / (BigInt(paid) * 2n));
        const amount = Math.min(Math.max(0, remaining), target);
        if (amount > 0) {
          debit = -amount;
          remaining -= amount;
          entries.push({ tenant: purchase.tenant, kind: "refund", amount: debit, key: `dispute:${dispute.id}`, metadata: { dispute: dispute.id, paymentIntent, reason: dispute.reason } });
        }
      }
      if (restored && debit && !posted.has(`dispute-reversed:${dispute.id}`)) {
        entries.push({ tenant: purchase.tenant, kind: "refund", amount: -debit, key: `dispute-reversed:${dispute.id}`, metadata: { dispute: dispute.id, paymentIntent, status: dispute.status } });
      }
    }
    return entries;
  }

  /** Keep cumulative refunds even when their purchase has not arrived. All writers serialize by payment intent. */
  private async refund(charge: { id: string; payment_intent?: string; amount: number; amount_refunded: number; currency?: string; metadata?: Record<string, string> }) {
    if (typeof charge.payment_intent !== "string" || typeof charge.id !== "string") return "ignored";
    if (charge.metadata?.purpose && ![PURPOSE, "agent-runtime-auto-topup"].includes(charge.metadata.purpose)) return "ignored";
    if (!Number.isSafeInteger(charge.amount) || charge.amount <= 0 || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount) {
      throw new HttpError(400, "Invalid cumulative refund amount");
    }
    const posted = await transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-runtime-payment:${charge.payment_intent}`]);
      const prior = (await sql.query("select * from billing_stripe_refunds where charge=$1", [charge.id])).rows[0];
      if (prior && (prior.payment_intent !== charge.payment_intent || prior.amount !== charge.amount || (prior.currency && charge.currency && prior.currency !== charge.currency))) throw new HttpError(400, "Refund conflicts with its recorded charge");
      const stored = await sql.query(`insert into billing_stripe_refunds (charge,payment_intent,amount,refunded,currency,updated_at) values ($1,$2,$3,$4,$5,$6)
        on conflict (charge) do update set refunded=greatest(billing_stripe_refunds.refunded,excluded.refunded), currency=coalesce(billing_stripe_refunds.currency,excluded.currency), updated_at=excluded.updated_at
        where billing_stripe_refunds.payment_intent=excluded.payment_intent and billing_stripe_refunds.amount=excluded.amount
          and (billing_stripe_refunds.currency is null or excluded.currency is null or billing_stripe_refunds.currency=excluded.currency)
        returning charge`,
      [charge.id, charge.payment_intent, charge.amount, charge.amount_refunded, charge.currency ?? null, Date.now()]);
      if (!stored.rowCount) throw new HttpError(400, "Refund conflicts with its recorded charge");
      const purchase = (await sql.query("select tenant, amount, metadata from credit_ledger where kind = 'purchase' and metadata->>'paymentIntent' = $1", [charge.payment_intent])).rows[0];
      if (!purchase) return undefined;
      return postLedger(sql, await this.refundEntries(sql, purchase, charge.payment_intent!));
    });
    if (!posted) return "pending refund";
    this.invalidate(posted.map(entry => entry.tenant));
    return "refund";
  }

  private async refundEntries(sql: Sql, purchase: { tenant: string; amount: number; metadata?: Record<string, unknown> }, paymentIntent: string): Promise<LedgerEntry[]> {
    const refunds = (await sql.query("select * from billing_stripe_refunds where payment_intent=$1 order by charge", [paymentIntent])).rows;
    const applied = (await sql.query("select metadata->>'charge' as charge, -sum(amount) as amount from credit_ledger where kind='refund' and metadata->>'paymentIntent'=$1 group by metadata->>'charge'", [paymentIntent])).rows;
    let remaining = Math.max(0, purchase.amount - applied.reduce((sum, row) => sum + Number(row.amount), 0));
    const entries: LedgerEntry[] = [];
    for (const refund of refunds) {
      if ((purchase.metadata?.currency && refund.currency && purchase.metadata.currency !== refund.currency)
        || (typeof purchase.metadata?.paid === "number" && purchase.metadata.paid !== refund.amount)) {
        console.error(JSON.stringify({ type: "billing_reconciliation_required", kind: "refund_mismatch", charge: refund.charge, paymentIntent }));
        throw new HttpError(400, "Refund amount or currency does not match purchase");
      }
      const already = Number(applied.find(row => row.charge === refund.charge)?.amount ?? 0);
      // BigInt keeps rounding exact even for large valid cumulative totals.
      const target = Number((BigInt(purchase.amount) * BigInt(refund.refunded) * 2n + BigInt(refund.amount)) / (BigInt(refund.amount) * 2n));
      const amount = Math.min(remaining, Math.max(0, target - already));
      if (!amount) continue;
      remaining -= amount;
      entries.push({ tenant: purchase.tenant, kind: "refund", amount: -amount, key: `refund:${refund.charge}:${refund.refunded}`,
        metadata: { charge: refund.charge, paymentIntent, refunded: refund.refunded } });
    }
    return entries;
  }

  // Storage -------------------------------------------------------------------

  /**
   * Charge prepaid tenants for one UTC day of what they store: agent transcripts and
   * journals, volume trees and snapshots, and file chunks, as `usage` tracks them (see
   * StorageUsage). Once a day, on whichever node claims the job first; each tenant's
   * charge is keyed by the day, so a job retried after a crash never charges twice.
   * The job first reconciles the tracked totals with a full listing when they cannot be
   * trusted alone: Storage that does not meter every write (single-host logs), no
   * reconciliation yet (tracking starts from one), or `reconcileDays` since the last
   * (0: only those two cases).
   */
  async chargeStorage(storage: Storage, usage: StorageUsage, node: string, options: { now?: number; reconcileDays?: number } = {}) {
    const now = options.now ?? Date.now();
    // The free hourly limit reads the last hour of spend by minute; older minutes are done with.
    await this.db.query("delete from credit_spend_minutes where minute < $1", [Math.floor((now - 2 * HOUR) / MINUTE)]);
    if (!storage.metered && !storage.objects) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    const claim = `${node} ${randomUUID()}`;
    await this.db.query("insert into billing_jobs (name) values ('storage') on conflict do nothing");
    const claimed = (await this.db.query(`
      update billing_jobs set claimed_by = $2, claimed_until = now() + $3 * interval '1 millisecond'
      where name = 'storage' and (done_day is null or done_day < $1::date) and (claimed_until is null or claimed_until <= now())
      returning name`, [day, claim, JOB_CLAIM_MS])).rowCount;
    if (!claimed) return false;
    try {
      const reconciled = (await this.db.query("select to_char(done_day, 'YYYY-MM-DD') as day from billing_jobs where name = 'storage-reconcile'")).rows[0]?.day as string | undefined;
      const every = options.reconcileDays ?? 7;
      const due = !storage.metered || !reconciled || (every > 0 && Date.parse(day) - Date.parse(reconciled) >= every * 86_400_000);
      if (due && storage.objects) await usage.reconcile(storage, { now });
      else await usage.flush();
      const bytes = await usage.tenantBytes();
      const [year, month] = day.split("-").map(Number);
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const entries: LedgerEntry[] = [];
      for (const [tenant, stored] of bytes) {
        const amount = storageCharge(this.pricing, stored, days);
        if (amount > 0 && await this.mode(tenant) === "prepaid") entries.push({ tenant, kind: "storage", amount: -amount, key: `storage:${tenant}:${day}`, metadata: { day, bytes: stored } });
      }
      for (let index = 0; index < entries.length; index += 500) await this.post(entries.slice(index, index + 500));
      // Flushes older than a day can no longer be retried.
      await this.db.query("delete from usage_flushes where created_at < now() - interval '1 day'");
      await this.db.query("update billing_jobs set done_day = $1::date, claimed_by = null, claimed_until = null where name = 'storage' and claimed_by = $2", [day, claim]);
      console.log(JSON.stringify({ type: "storage_charged", day, tenants: entries.length, bytes: [...bytes.values()].reduce((sum, value) => sum + value, 0) }));
      return true;
    } catch (error) {
      await this.db.query("update billing_jobs set claimed_by = null, claimed_until = null where name = 'storage' and claimed_by = $1", [claim]).catch(() => {});
      throw error;
    }
  }
}
