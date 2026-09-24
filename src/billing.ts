import { randomUUID } from "node:crypto";
import type { Tenants } from "./tenants.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import type { Storage } from "../shared/storage.ts";
import { HttpError } from "./http.ts";
import { DEFAULT_PRICING, MICROS, purchaseFee, storageCharge, type Pricing } from "./pricing.ts";
import type { Stripe } from "./stripe.ts";

/**
 * Prepaid credit. Tenants with `billing: "prepaid"` (every tenant created by sign-in)
 * pay from a balance: model tokens that ran on the platform's keys, time their agents
 * spend in turns, and storage. Every movement is a row in the append-only
 * `credit_ledger`, in integer micro-USD, under an idempotency key naming its cause,
 * and moves `credit_accounts.balance` in the same statement, so a retried flush, job
 * or webhook never posts twice. A tenant whose balance is spent may not start runs;
 * a turn already running stops after its current response, so the overdraft is
 * bounded by one response and the time around it.
 */
export type BillingMode = "prepaid" | "none";
export type LedgerKind = "grant" | "purchase" | "usage" | "storage" | "adjustment" | "refund";
export const LEDGER_KINDS: LedgerKind[] = ["grant", "purchase", "usage", "storage", "adjustment", "refund"];
export interface LedgerEntry { tenant: string; kind: LedgerKind; amount: number; key: string; metadata?: Record<string, unknown> }
export interface LedgerRow { id: number; kind: LedgerKind; amount: number; metadata: Record<string, unknown>; createdAt: number }

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
      select tenant, kind, amount, key, coalesce(metadata, '{}'), $2 from input
      on conflict (idempotency_key) do nothing
      returning id, tenant, kind, amount, idempotency_key, metadata
    ), moved as (
      insert into credit_accounts (tenant, balance, purchased)
      select tenant, sum(amount), coalesce(sum(amount) filter (where kind in ('purchase', 'refund')), 0) from appended group by tenant
      on conflict (tenant) do update set balance = credit_accounts.balance + excluded.balance, purchased = credit_accounts.purchased + excluded.purchased
    )
    select id, tenant, kind, amount, idempotency_key as key, metadata from appended`, [JSON.stringify(entries), now]);
  return rows;
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
  /** Each tenant's balance and lifetime purchases as last read. */
  private readonly accounts = new Map<string, { balance: number; purchased: number; until: number }>();
  private readonly reads = new Map<string, Promise<{ balance: number; purchased: number }>>();
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
    if (this.tenants.legacy) return "none";
    const cached = this.modes.get(tenant);
    if (cached && cached.until > Date.now()) return cached.mode;
    const row = (await this.db.query("select billing from tenants where id = $1", [tenant])).rows[0];
    const mode: BillingMode = row?.billing === "prepaid" ? "prepaid" : "none";
    this.modes.set(tenant, { mode, until: Date.now() + MODE_CACHE_MS });
    return mode;
  }

  /** The tenant's balance (less what this node has recorded and not yet written) and lifetime purchases, read at most every few seconds. */
  async account(tenant: string): Promise<{ balance: number; purchased: number }> {
    const cached = this.accounts.get(tenant);
    const stored = cached && cached.until > Date.now() ? cached : await this.read(tenant);
    return { balance: stored.balance - (this.options.pending?.(tenant) ?? 0), purchased: stored.purchased };
  }

  private read(tenant: string) {
    let reading = this.reads.get(tenant);
    if (!reading) {
      reading = (async () => {
        await this.options.flush?.();
        const row = (await this.db.query("select balance, purchased from credit_accounts where tenant = $1", [tenant])).rows[0];
        const value = { balance: row?.balance ?? 0, purchased: row?.purchased ?? 0 };
        this.accounts.set(tenant, { ...value, until: Date.now() + BALANCE_CACHE_MS });
        return value;
      })().finally(() => this.reads.delete(tenant));
      this.reads.set(tenant, reading);
    }
    return reading;
  }

  /** Why a prepaid tenant may not start or continue runs: its credit is spent. */
  async creditLimit(tenant: string): Promise<string | undefined> {
    if (await this.mode(tenant) !== "prepaid") return undefined;
    const { balance } = await this.account(tenant);
    if (balance > 0) return undefined;
    return `This tenant's prepaid credit is used up (balance ${usd(balance)}); add credit at ${this.options.publicUrl ?? ""}/console/billing`;
  }

  /** Append entries (see `postLedger`); the balances they move are read afresh next time. */
  async post(entries: LedgerEntry[], sql: Sql = this.db) {
    const appended = await postLedger(sql, entries);
    for (const entry of entries) this.accounts.delete(entry.tenant);
    return appended;
  }

  /** Forget cached balances after entries were appended in a transaction of the caller's. */
  invalidate(tenants: Iterable<string>) { for (const tenant of tenants) this.accounts.delete(tenant); }

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
      month: { since, ...thisMonth },
      recent: (await this.ledger(tenant, { limit: 10 })).entries,
      rates: { agentHour: pricing.agentHour, storageGbMonth: pricing.storageGbMonth, purchaseFeeBps: pricing.purchaseFeeBps, minPurchase: pricing.minPurchase, maxPurchase: pricing.maxPurchase },
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
        { quantity: 1, price_data: { currency: "usd", unit_amount: amount / CENT, product_data: { name: "Agent runtime credit" } } },
        ...(fee ? [{ quantity: 1, price_data: { currency: "usd", unit_amount: fee / CENT, product_data: { name: `Processing fee (${purchaseFeeBps / 100}%)` } } }] : []),
      ],
      success_url: `${page}?checkout=success`, cancel_url: `${page}?checkout=cancelled`,
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
   * journals, volume trees and snapshots, and file chunks, measured by listing
   * Storage. Once a day, on whichever node claims the job first; each tenant's
   * charge is keyed by the day, so a job retried after a crash never charges twice.
   */
  async chargeStorage(storage: Storage, node: string, now = Date.now()) {
    if (!storage.objects) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    const claim = `${node} ${randomUUID()}`;
    await this.db.query("insert into billing_jobs (name) values ('storage') on conflict do nothing");
    const claimed = (await this.db.query(`
      update billing_jobs set claimed_by = $2, claimed_until = now() + $3 * interval '1 millisecond'
      where name = 'storage' and (done_day is null or done_day < $1::date) and (claimed_until is null or claimed_until <= now())
      returning name`, [day, claim, JOB_CLAIM_MS])).rowCount;
    if (!claimed) return false;
    try {
      const bytes = await this.storedBytes(storage);
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

  /** Bytes in Storage per tenant: agents' logs and volumes' by their owners' rows, chunks by their key. */
  async storedBytes(storage: Storage) {
    const byAgent = new Map<string, number>(), byVolume = new Map<string, number>(), byTenant = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, bytes: number) => map.set(key, (map.get(key) ?? 0) + bytes);
    for (const prefix of ["sessions/", "client-sessions/", "volumes/", "chunks/"]) {
      for await (const { key, bytes } of storage.objects!(prefix)) {
        const agent = /^(?:sessions\/|client-sessions\/)(client_[a-f0-9]{40})/.exec(key)?.[1];
        const volume = agent ? undefined : /^volumes\/(vol_[a-f0-9]{24})\//.exec(key)?.[1];
        const tenant = agent || volume ? undefined : /^chunks\/([a-z0-9][a-z0-9-]{0,39})\//.exec(key)?.[1];
        if (agent) add(byAgent, agent, bytes);
        else if (volume) add(byVolume, volume, bytes);
        else if (tenant) add(byTenant, tenant, bytes);
      }
    }
    for (const [table, sizes] of [["agents", byAgent], ["volumes", byVolume]] as const) {
      const ids = [...sizes.keys()];
      for (let index = 0; index < ids.length; index += 1000) {
        const { rows } = await this.db.query(`select id, tenant from ${table} where id = any($1)`, [ids.slice(index, index + 1000)]);
        for (const row of rows) add(byTenant, row.tenant, sizes.get(row.id)!);
      }
    }
    return byTenant;
  }
}
