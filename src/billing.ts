import { randomUUID } from "node:crypto";
import type { Tenants } from "./tenants.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import type { Storage } from "../shared/storage.ts";
import { HttpError } from "./http.ts";
import { DEFAULT_PRICING, MICROS, purchaseFee, storageCharge, type Pricing } from "./pricing.ts";
import type { Stripe } from "./stripe.ts";
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
export interface StartingCredit { status: "granted" | "not_eligible" | "not_granted" | "not_applicable"; amount: number }
/** What a usage flush charges a tenant: `amount` micro-USD spent, and its breakdown (numbers, summed over the hour). */
export interface UsageCharge { tenant: string; amount: number; metadata: Record<string, number> }
/** What limits a tenant's runs: its balance, what it ever bought (none: on free credit), and its usage charges in the last hour. */
type Account = { balance: number; purchased: number; lastHour: number };

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
}

export class Billing {
  readonly db: Db;
  readonly tenants: Tenants;
  readonly pricing: Pricing;
  private readonly options: BillingOptions;
  /** Each tenant's balance, lifetime purchases and usage spend in the last hour, as last read. */
  private readonly accounts = new Map<string, Account & { until: number }>();
  private readonly reads = new Map<string, Promise<Account>>();
  private readonly modes = new Map<string, { mode: BillingMode; until: number }>();

  constructor(options: BillingOptions) {
    this.options = options;
    this.db = options.db;
    this.tenants = options.tenants;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
  }

  /** Admin tenants are billed as their entry says (unbilled by default); tenants created by sign-in as their row says. */
  async mode(tenant: string): Promise<BillingMode> {
    const admin = this.tenants.billing(tenant);
    if (admin) return admin;
    const cached = this.modes.get(tenant);
    if (cached && cached.until > Date.now()) return cached.mode;
    const row = (await this.db.query("select billing from tenants where id = $1", [tenant])).rows[0];
    const mode: BillingMode = row?.billing === "prepaid" ? "prepaid" : "none";
    this.modes.set(tenant, { mode, until: Date.now() + MODE_CACHE_MS });
    return mode;
  }

  /** The tenant's account, with what this node has recorded and not yet written counted in, read at most every few seconds. */
  async account(tenant: string): Promise<Account> {
    const cached = this.accounts.get(tenant);
    const stored = cached && cached.until > Date.now() ? cached : await this.read(tenant);
    const pending = this.options.pending?.(tenant) ?? 0;
    return { balance: stored.balance - pending, purchased: stored.purchased, lastHour: stored.lastHour + pending };
  }

  private read(tenant: string) {
    let reading = this.reads.get(tenant);
    if (!reading) {
      reading = (async () => {
        await this.options.flush?.();
        const { rows: [row] } = await this.db.query(`
          select balance, purchased, (select coalesce(sum(amount), 0) from credit_spend_minutes where tenant = $1 and minute >= $2) as last_hour
          from (select $1::text as tenant) as t left join credit_accounts using (tenant)`, [tenant, Math.floor((Date.now() - HOUR) / MINUTE)]);
        const value = { balance: row.balance ?? 0, purchased: row.purchased ?? 0, lastHour: Number(row.last_hour) };
        this.accounts.set(tenant, { ...value, until: Date.now() + BALANCE_CACHE_MS });
        return value;
      })().finally(() => this.reads.delete(tenant));
      this.reads.set(tenant, reading);
    }
    return reading;
  }

  /**
   * Why a prepaid tenant may not start or continue runs: its credit is spent (402), or, on
   * free credit, it has spent the free hourly allowance (429 until the hour's spend ages out).
   */
  async creditLimit(tenant: string): Promise<HttpError | undefined> {
    if (await this.mode(tenant) !== "prepaid") return undefined;
    const { balance, purchased, lastHour } = await this.account(tenant);
    const where = `${this.options.publicUrl ?? ""}/console/billing`;
    if (balance <= 0) return new HttpError(402, `Not enough credit to start this run (balance ${usd(balance)}). Add credit at ${where}`);
    const allowance = this.pricing.free.hourlySpend;
    if (purchased <= 0 && lastHour >= allowance) {
      return new HttpError(429, `Free credit allows ${usd(allowance)} of usage per hour, and this tenant has used ${usd(lastHour)} in the last hour; retry later, or buy credit at ${where} to lift the limit`);
    }
    return undefined;
  }

  /** Agents a tenant on free credit may have hosted at once on each node; undefined once it has bought credit (or is not prepaid). */
  async agentLimit(tenant: string): Promise<number | undefined> {
    if (await this.mode(tenant) !== "prepaid") return undefined;
    return (await this.account(tenant)).purchased > 0 ? undefined : this.pricing.free.maxAgents;
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
    const row = (await this.db.query(`select t.billing, d.decision, l.amount
      from tenants t left join starting_credit_decisions d on d.github_id = t.github_id and d.tenant = t.id
      left join credit_ledger l on l.id = d.grant_ledger_id and l.tenant = t.id
      where t.id = $1`, [tenant])).rows[0];
    if (!row || row.billing !== "prepaid") return { status: "not_applicable", amount: 0 };
    if (row.amount > 0) return { status: "granted", amount: row.amount };
    return { status: row.decision === "disabled" ? "not_applicable" : row.decision === "ineligible" ? "not_eligible" : "not_granted", amount: 0 };
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
      select id, kind, amount, metadata, created_at from credit_ledger
      where tenant = $1 and ($2::bigint is null or id < $2) order by id desc limit $3`, [tenant, options.before ?? null, limit + 1]);
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
    return {
      billing: mode, balance, freeCredit: mode === "prepaid" && purchased <= 0, checkout: !!this.options.stripe,
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
  async checkout(tenant: string, amount: number) {
    const stripe = this.options.stripe;
    if (!stripe) throw new HttpError(503, "Credit purchases are not configured on this runtime");
    if (await this.mode(tenant) !== "prepaid") throw new HttpError(400, "This tenant is not billed with prepaid credit");
    const { minPurchase, maxPurchase, purchaseFeeBps } = this.pricing;
    if (!Number.isSafeInteger(amount) || amount % CENT || amount < minPurchase || amount > maxPurchase) {
      throw new HttpError(400, `Buy between ${usd(minPurchase)} and ${usd(maxPurchase)} of credit, in whole cents`);
    }
    const fee = purchaseFee(this.pricing, amount);
    const customer = await this.customer(tenant);
    const page = `${this.options.publicUrl ?? ""}/console/billing`;
    const metadata = { purpose: PURPOSE, tenant, credit: String(amount) };
    const session = await stripe.post<{ id: string; url: string }>("/v1/checkout/sessions", {
      mode: "payment", customer, client_reference_id: tenant, metadata, payment_intent_data: { metadata },
      line_items: [
        { quantity: 1, price_data: { currency: "usd", unit_amount: amount / CENT, product_data: { name: "camelRun credit" } } },
        ...(fee ? [{ quantity: 1, price_data: { currency: "usd", unit_amount: fee / CENT, product_data: { name: `Processing fee (${purchaseFeeBps / 100}%)` } } }] : []),
      ],
      // Stripe fills in the session id, so the console can wait for this purchase rather than any.
      success_url: `${page}?checkout=success&session={CHECKOUT_SESSION_ID}`, cancel_url: `${page}?checkout=cancelled`,
    });
    return { id: session.id, url: session.url, amount, fee, total: amount + fee };
  }

  /** The tenant's Stripe customer, created at its first checkout. */
  private async customer(tenant: string): Promise<string> {
    const row = (await this.db.query("select stripe_customer from credit_accounts where tenant = $1", [tenant])).rows[0];
    if (row?.stripe_customer) return row.stripe_customer;
    // Concurrent first checkouts send the same idempotency key, so Stripe makes one customer.
    const created = await this.options.stripe!.post<{ id: string }>("/v1/customers", { name: tenant, metadata: { purpose: PURPOSE, tenant } }, `agent-runtime-customer:${tenant}`);
    const { rows } = await this.db.query(`
      insert into credit_accounts (tenant, stripe_customer) values ($1, $2)
      on conflict (tenant) do update set stripe_customer = coalesce(credit_accounts.stripe_customer, excluded.stripe_customer)
      returning stripe_customer`, [tenant, created.id]);
    return rows[0].stripe_customer;
  }

  /**
   * A Stripe webhook: a paid checkout adds the credit bought (not the fee), once per
   * session; a refund removes credit in proportion to the amount refunded, once per
   * refunded total. Events for anything this runtime did not sell are acknowledged and ignored.
   */
  async webhook(payload: string, signature: string | undefined): Promise<{ handled: string }> {
    const stripe = this.options.stripe;
    if (!stripe) throw new HttpError(404, "Credit purchases are not configured on this runtime");
    const event = stripe.verify(payload, signature);
    if (!event) throw new HttpError(400, "Invalid Stripe signature");
    const object = event.data?.object ?? {};
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (object.metadata?.purpose !== PURPOSE) return { handled: "ignored" };
      if (object.payment_status !== "paid") return { handled: "awaiting payment" };
      const tenant = object.metadata.tenant, amount = Number(object.metadata.credit);
      if (typeof tenant !== "string" || !Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, "Checkout session without a tenant or credit amount");
      await this.post([{
        tenant, kind: "purchase", amount, key: `purchase:${object.id}`,
        metadata: { session: object.id, paymentIntent: object.payment_intent ?? null, paid: object.amount_total ?? null, currency: object.currency ?? null },
      }]);
      if (typeof object.customer === "string") await this.db.query("update credit_accounts set stripe_customer = coalesce(stripe_customer, $2) where tenant = $1", [tenant, object.customer]);
      console.log(JSON.stringify({ type: "credit_purchased", tenant, amount, session: object.id }));
      return { handled: "purchase" };
    }
    if (event.type === "charge.refunded") return { handled: await this.refund(object) };
    return { handled: "ignored" };
  }

  /** Bring a purchase's refunds up to the charge's refunded total; concurrent deliveries for one charge take turns. */
  private async refund(charge: { id: string; payment_intent?: string; amount: number; amount_refunded: number }) {
    if (typeof charge.payment_intent !== "string" || !(charge.amount > 0)) return "ignored";
    const posted = await transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-runtime-refund:${charge.id}`]);
      const purchase = (await sql.query("select tenant, amount from credit_ledger where kind = 'purchase' and metadata->>'paymentIntent' = $1", [charge.payment_intent])).rows[0];
      if (!purchase) return undefined;
      const refunded = -Number((await sql.query("select coalesce(sum(amount), 0) as sum from credit_ledger where kind = 'refund' and metadata->>'charge' = $1", [charge.id])).rows[0].sum);
      const target = Math.round(purchase.amount * Math.min(1, charge.amount_refunded / charge.amount));
      if (target <= refunded) return [];
      return postLedger(sql, [{
        tenant: purchase.tenant, kind: "refund", amount: refunded - target, key: `refund:${charge.id}:${charge.amount_refunded}`,
        metadata: { charge: charge.id, paymentIntent: charge.payment_intent, refunded: charge.amount_refunded },
      }]);
    });
    if (!posted) return "ignored";
    this.invalidate(posted.map(entry => entry.tenant));
    return "refund";
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
