import { createHash, randomUUID } from "node:crypto";
import { transaction, type Db, type Sql } from "./db.ts";
import type { Billing } from "./billing.ts";
import { stripeId } from "./billing-payments.ts";
import { purchaseFee } from "./pricing.ts";
import { HttpError } from "./http.ts";
import { Stripe, StripeError, STRIPE_API_VERSION } from "./stripe.ts";

const HOUR = 3_600_000, CENT = 10_000;
const active = "state not in ('paid','cancelled')";
type Card = NonNullable<Awaited<ReturnType<NonNullable<Billing["payments"]>["defaultCard"]>>>;
export interface AutoTerms { threshold: number; amount: number; monthlyLimit: number }
const displayCard = (card: Card | null) => card && ({ brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear });
const periodAt = (now: number) => new Date(now).toISOString().slice(0, 7);
const resetsAt = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/** Durable, opt-in invoice payments. No network request is made while holding a database lock. */
export class AutoTopup {
  private readonly db: Db;
  private readonly billing: Billing;
  private readonly stripe: Stripe;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(billing: Billing, stripe: Stripe, now = Date.now) { this.billing = billing; this.db = billing.db; this.stripe = stripe; this.now = now; }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.pump().catch(() => console.error(JSON.stringify({ type: "auto_topup_poll_failed" }))), 5_000); this.timer.unref(); } }
  async stop() { clearInterval(this.timer); this.timer = undefined; await this.running; }
  private async guard(tenant: string) { if (await this.billing.mode(tenant) !== "prepaid") throw new HttpError(400, "Auto top-up is only available for prepaid accounts"); }
  private async lock(sql: Sql, tenant: string) {
    await sql.query("insert into credit_accounts (tenant) values ($1) on conflict do nothing", [tenant]);
    await sql.query("select tenant from credit_accounts where tenant=$1 for update", [tenant]);
  }
  private async settings(sql: Sql, tenant: string) {
    return (await sql.query("select * from billing_auto_settings where tenant=$1 and livemode=$2", [tenant, this.stripe.live])).rows[0]
      ?? { enabled: false, version: 0, threshold: 5e6, amount: 20e6, fee: purchaseFee(this.billing.pricing, 20e6), monthly_limit: 200e6, status: "on" };
  }
  private async amounts(sql: Sql, tenant: string) {
    const rows = (await sql.query(`select state,period,amount+fee as total from billing_auto_attempts where tenant=$1 and livemode=$2 and state <> 'cancelled'`, [tenant, this.stripe.live])).rows;
    const period = periodAt(this.now());
    return { period, used: rows.filter(r => r.period === period && r.state === "paid").reduce((sum, r) => sum + r.total, 0),
      held: rows.filter(r => r.state !== "paid").reduce((sum, r) => sum + r.total, 0) };
  }
  async get(tenant: string) {
    await this.guard(tenant);
    const s = await this.settings(this.db, tenant), sums = await this.amounts(this.db, tenant);
    const attempt = (await this.db.query(`select * from billing_auto_attempts where tenant=$1 and livemode=$2 and ${active}`, [tenant, this.stripe.live])).rows[0];
    const status = s.status === "limit_reached" && sums.used+s.amount+s.fee <= s.monthly_limit ? "on" : s.status;
    return { enabled: s.enabled, state: attempt?.cancel_requested && attempt.state !== "reconcile" ? "cancelling" : attempt?.state ?? (s.enabled ? status : "off"), version: s.version,
      threshold: s.threshold, amount: s.amount, fee: s.fee, total: s.amount+s.fee, monthlyLimit: s.monthly_limit,
      usedThisPeriod: sums.used, held: sums.held, resetsAt: resetsAt(this.now()),
      attempt: attempt ? { id: attempt.id, state: attempt.state, amount: attempt.amount, fee: attempt.fee, total: attempt.amount+attempt.fee,
        card: displayCard(attempt.card), invoiceUrl: attempt.invoice_url, canRetry: attempt.state === "paused_declined" && !attempt.cancel_requested, submitted: !!attempt.submitted_at } : null };
  }
  async quote(tenant: string, terms: AutoTerms) {
    await this.guard(tenant);
    const { threshold, amount, monthlyLimit } = terms;
    const fee = purchaseFee(this.billing.pricing, amount);
    if (![threshold, amount, monthlyLimit].every(n => Number.isSafeInteger(n) && n % CENT === 0)
      || threshold < 1e6 || threshold > 500e6 || amount < this.billing.pricing.minPurchase || amount > this.billing.pricing.maxPurchase
      || monthlyLimit < amount+fee || monthlyLimit > 100_000e6) throw new HttpError(400, "Use whole cents: threshold $1–$500, credit within purchase limits, and a monthly limit covering at least one charge (up to $100,000)");
    const id = randomUUID(), now = this.now();
    await this.db.query(`insert into billing_auto_quotes (id,tenant,livemode,threshold,amount,fee,monthly_limit,created_at,expires_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, tenant, this.stripe.live, threshold, amount, fee, monthlyLimit, now, now+24*HOUR]);
    return this.preview(tenant, id);
  }
  private async findQuote(tenant: string, id?: string) {
    const q = (await this.db.query(`select * from billing_auto_quotes where tenant=$1 and livemode=$2 and ($3::uuid is null or id=$3) order by created_at desc,id desc limit 1`, [tenant, this.stripe.live, id ?? null])).rows[0];
    if (!q || q.expires_at <= this.now()) throw new HttpError(409, "The auto top-up quote expired. Review the settings again.");
    return q;
  }
  private async review(sql: Sql, q: any, card: Card | null) {
    const s = await this.settings(sql, q.tenant), sums = await this.amounts(sql, q.tenant);
    const balance = (await sql.query("select balance from credit_accounts where tenant=$1", [q.tenant])).rows[0]?.balance ?? 0;
    const immediate = balance < q.threshold && sums.held === 0 && sums.used + q.amount+q.fee <= q.monthly_limit;
    const version = createHash("sha256").update(JSON.stringify([q.id, s.version, card?.id, immediate, sums.period, sums.used, sums.held])).digest("hex");
    return { id: q.id as string, version, threshold: q.threshold as number, amount: q.amount as number, fee: q.fee as number,
      total: q.amount+q.fee, monthlyLimit: q.monthly_limit as number, card: displayCard(card), immediate, expiresAt: q.expires_at as number };
  }
  async preview(tenant: string, id?: string) {
    await this.guard(tenant);
    return this.review(this.db, await this.findQuote(tenant, id), await this.billing.payments!.defaultCard(tenant));
  }
  async enable(tenant: string, id: string, version: string, consent: boolean) {
    await this.guard(tenant);
    if (consent !== true) throw new HttpError(400, "Confirm the auto top-up authorization");
    const q = await this.findQuote(tenant, id), card = await this.billing.payments!.defaultCard(tenant);
    await transaction(this.db, async sql => {
      await this.lock(sql, tenant);
      const fresh = (await sql.query("select * from billing_auto_quotes where id=$1 for update", [q.id])).rows[0];
      if (fresh.accepted_at) return; // Retrying acceptance cannot re-enable after a later disable.
      if (!card || fresh.expires_at <= this.now() || (await this.review(sql, fresh, card)).version !== version) throw new HttpError(409, "Auto top-up details changed. Review the quote and confirm again.");
      const s = (await sql.query(`insert into billing_auto_settings (tenant,livemode,enabled,version,threshold,amount,fee,monthly_limit,consent_at)
        values ($1,$2,true,1,$3,$4,$5,$6,$7) on conflict (tenant,livemode) do update set enabled=true,version=billing_auto_settings.version+1,
        threshold=excluded.threshold,amount=excluded.amount,fee=excluded.fee,monthly_limit=excluded.monthly_limit,consent_at=excluded.consent_at,status='on',limit_resets_at=null returning *`,
      [tenant, this.stripe.live, q.threshold, q.amount, q.fee, q.monthly_limit, this.now()])).rows[0];
      await sql.query("update billing_auto_quotes set accepted_at=$2,consent_version=$3,consent_card=$4 where id=$1", [q.id, this.now(), version, displayCard(card)]);
      await this.reserve(sql, tenant, s, card);
    });
    return this.get(tenant);
  }
  async disable(tenant: string) {
    await this.guard(tenant);
    await transaction(this.db, async sql => {
      await this.lock(sql, tenant);
      await sql.query("update billing_auto_settings set enabled=false,version=version+1 where tenant=$1 and livemode=$2", [tenant, this.stripe.live]);
      await sql.query(`update billing_auto_attempts set state='cancelled',lease=null where tenant=$1 and livemode=$2 and ${active} and submitted_at is null`, [tenant, this.stripe.live]);
      await sql.query(`update billing_auto_attempts set cancel_requested=true,cancel_reason=coalesce(cancel_reason,'disabled'),due=$3 where tenant=$1 and livemode=$2 and state in ('paused_declined','paused_no_card')`, [tenant, this.stripe.live, this.now()]);
    });
    return this.get(tenant);
  }
  async retry(tenant: string, id: string) {
    await this.guard(tenant);
    const card = await this.billing.payments!.defaultCard(tenant);
    if (!card) throw new HttpError(409, "Add a default card in Stripe before retrying");
    await transaction(this.db, async sql => {
      await this.lock(sql, tenant);
      const a = (await sql.query("select * from billing_auto_attempts where id=$1 and tenant=$2 and livemode=$3 for update", [id, tenant, this.stripe.live])).rows[0];
      if (!a || a.state !== "paused_declined" || a.cancel_requested || a.customer !== card.customer) throw new HttpError(409, "This top-up is not ready to retry");
      await sql.query("update billing_auto_attempts set state='processing',step='prepare',card=$2,generation=generation+1,step_started_at=null,lease=null,lease_until=0,due=$3 where id=$1", [id, card, this.now()]);
      await sql.query("update billing_email_outbox set state='cancelled' where tenant=$1 and kind='problems' and state='pending' and payload->'data'->>'attempt'=$2", [tenant, id]);
    });
    return this.get(tenant);
  }
  private async emit(sql: Sql, tenant: string, notice: string, data: any, key: string) {
    await sql.query("select billing_emit_event($1,$2,$3,$4,$5)", [tenant, `billing.topup.${notice}`, { ...data, notice, livemode: this.stripe.live }, key, notice === "receipt" ? "receipts" : "problems"]);
  }
  /** Called with the balance lock, both before a provider lookup and at reservation. */
  private async eligible(sql: Sql, tenant: string, s: any) {
    if (!s.enabled || s.status === "paused_expired" || (await sql.query(`select 1 from billing_auto_attempts where tenant=$1 and livemode=$2 and ${active}`, [tenant, this.stripe.live])).rowCount) return false;
    const balance = (await sql.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance;
    if (balance >= s.threshold) return s.status === "paused_no_card";
    const sums = await this.amounts(sql, tenant);
    if (sums.used + s.amount+s.fee > s.monthly_limit) {
      await sql.query("update billing_auto_settings set status='limit_reached',limit_resets_at=$3 where tenant=$1 and livemode=$2", [tenant, this.stripe.live, resetsAt(this.now())]);
      await this.emit(sql, tenant, "limit", { settingsVersion: s.version, used: sums.used, monthlyLimit: s.monthly_limit, total: s.amount+s.fee, resetsAt: resetsAt(this.now()) }, `${s.version}:${sums.period}`);
      return false;
    }
    return true;
  }
  private async reserve(sql: Sql, tenant: string, s: any, card: Card | null) {
    if (!await this.eligible(sql, tenant, s)) return;
    if (!card) {
      if (s.status !== "paused_no_card") await this.emit(sql, tenant, "no_card", { settingsVersion: s.version }, randomUUID());
      await sql.query("update billing_auto_settings set status='paused_no_card' where tenant=$1 and livemode=$2", [tenant, this.stripe.live]);
      return;
    }
    const balance = (await sql.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance;
    const sums = await this.amounts(sql, tenant);
    await sql.query("update billing_auto_settings set status='on',limit_resets_at=null where tenant=$1 and livemode=$2", [tenant, this.stripe.live]);
    if (balance >= s.threshold) return;
    await sql.query(`insert into billing_auto_attempts (id,tenant,livemode,settings_version,period,customer,amount,fee,monthly_limit,threshold,card,api_version,state,step,due,created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'processing','create',$13,$13)`,
    [randomUUID(), tenant, this.stripe.live, s.version, sums.period, card.customer, s.amount, s.fee, s.monthly_limit, s.threshold, card, STRIPE_API_VERSION, this.now()]);
  }
  pump(): Promise<void> { return this.running ??= this.run().finally(() => { this.running = undefined; }); }
  private async run() {
    // Claim before touching Stripe: healthy tenants cost no provider requests, and nodes share scans.
    const rows = (await this.db.query(`with picked as (
      select s.tenant,s.livemode from billing_auto_settings s join credit_accounts c on c.tenant=s.tenant
      where s.enabled and s.livemode=$1 and s.checked_at<=$2::bigint-30000
      and s.status<>'paused_expired' and (s.status<>'limit_reached' or coalesce(s.limit_resets_at,0)<=$2)
      and (c.balance<s.threshold or s.status='paused_no_card')
      and (s.status<>'paused_no_card' or s.checked_at<=$2::bigint-3600000)
      and not exists (select 1 from billing_auto_attempts a where a.tenant=s.tenant and a.livemode=s.livemode and a.state not in ('paid','cancelled'))
      order by s.checked_at,s.tenant limit 10 for update of s skip locked)
      update billing_auto_settings s set checked_at=$2 from picked p where s.tenant=p.tenant and s.livemode=p.livemode returning s.tenant`, [this.stripe.live, this.now()])).rows;
    await Promise.all(rows.map(async ({ tenant }) => {
      try {
        if (await this.billing.mode(tenant) !== "prepaid") return;
        if (!await transaction(this.db, async sql => { await this.lock(sql, tenant); return this.eligible(sql, tenant, await this.settings(sql, tenant)); })) return;
        const card = await this.billing.payments!.defaultCard(tenant);
        await transaction(this.db, async sql => { await this.lock(sql, tenant); await this.reserve(sql, tenant, await this.settings(sql, tenant), card); });
      } catch { console.error(JSON.stringify({ type: "auto_topup_account_check_failed", tenant })); }
    }));
    const attempts = (await this.db.query(`with picked as (select id from billing_auto_attempts where livemode=$1 and ${active} and state <> 'reconcile'
      and due<=$2 and lease_until<=$2 order by due,id limit 5 for update skip locked)
      update billing_auto_attempts a set lease=gen_random_uuid(),lease_until=$2+60000 from picked where a.id=picked.id returning a.*`, [this.stripe.live, this.now()])).rows;
    await Promise.all(attempts.map(async a => {
      try { await this.process(a); }
      catch (error) {
        console.error(JSON.stringify({ type: "auto_topup_step_failed", attempt: a.id, step: a.step, code: error instanceof StripeError ? error.code : undefined }));
        await this.db.query("update billing_auto_attempts set due=$3,lease_until=0,lease=null where id=$1 and lease=$2", [a.id, a.lease, this.now()+30_000]);
      }
    }));
    await this.billing.payments!.refreshInvoices();
  }
  /** Advance immediately while ready, persisting and renewing the lease before each external step. */
  private async process(a: any): Promise<void> {
    if (!(await this.db.query(`update billing_auto_attempts set lease_until=$3 where id=$1 and lease=$2 and ${active} returning id`, [a.id, a.lease, this.now()+60_000])).rowCount) return;
    if (a.api_version !== STRIPE_API_VERSION) return this.transition(a, "reconcile");
    if (!a.cancel_requested && a.state === "action_required" && a.action_expires_at != null && a.action_expires_at <= this.now()) {
      // Persist the reason before touching Stripe: recovery must still pause after a lost void response or a settling payment.
      a = (await this.db.query(`update billing_auto_attempts set cancel_requested=true,cancel_reason='expired' where id=$1 and lease=$2 and ${active} returning *`, [a.id, a.lease])).rows[0];
      if (!a) return;
    }
    if (a.cancel_requested) return this.cancelInvoice(a);
    if (!a.submitted_at) {
      const ok = await transaction(this.db, async sql => {
        await this.lock(sql, a.tenant);
        const s = await this.settings(sql, a.tenant);
        if (!s.enabled) { await sql.query("update billing_auto_attempts set state='cancelled',lease=null where id=$1 and lease=$2", [a.id, a.lease]); return false; }
        return !!(await sql.query("update billing_auto_attempts set submitted_at=$3 where id=$1 and lease=$2 and state='processing' returning id", [a.id, a.lease, this.now()])).rowCount;
      });
      if (!ok) return;
    }
    const start = a.step_started_at ?? this.now();
    if (!a.step_started_at) await this.db.query("update billing_auto_attempts set step_started_at=$3 where id=$1 and lease=$2", [a.id, a.lease, start]);
    if (["create", "credit", "fee", "pay"].includes(a.step) && this.now()-start >= 23*HOUR) {
      if (a.step === "pay") {
        const invoice = await this.stripe.get(`/v1/invoices/${a.invoice}`);
        if (this.owns(a, invoice) && invoice.total === (a.amount+a.fee)/CENT && invoice.currency === "usd" && invoice.status === "paid") return this.observe(a, invoice);
      }
      return this.transition(a, "reconcile");
    }
    const key = `camelrun:topup:${a.id}:${a.step}:${a.generation}`;
    const total = (a.amount+a.fee)/CENT;
    const metadata = { purpose: "agent-runtime-auto-topup", attempt: a.id, tenant: a.tenant };
    if (a.step === "create") {
      const invoice = await this.stripe.post("/v1/invoices", { customer: a.customer, currency: "usd", auto_advance: false,
        collection_method: "charge_automatically", pending_invoice_items_behavior: "exclude", discounts: "", default_tax_rates: "", metadata }, key);
      if (!this.owns(a, invoice)) return this.transition(a, "reconcile");
      return this.advance(a, "credit", { invoice: invoice.id });
    }
    if (a.step === "credit" || a.step === "fee") {
      const amount = a.step === "credit" ? a.amount : a.fee;
      if (amount) {
        const item = await this.stripe.post("/v1/invoiceitems", { customer: a.customer, invoice: a.invoice, currency: "usd", amount: amount/CENT,
          discountable: false, description: a.step === "credit" ? "camelRun credit (auto top-up)" : "Processing fee", metadata }, key);
        if (stripeId(item.invoice) !== a.invoice || item.amount !== amount/CENT) return this.transition(a, "reconcile");
      }
      return this.advance(a, a.step === "credit" ? "fee" : "finalize");
    }
    const invoice = await this.stripe.get(`/v1/invoices/${a.invoice}`);
    if (!this.owns(a, invoice) || invoice.total !== total || invoice.currency !== "usd" || invoice.auto_advance !== false) return this.transition(a, "reconcile");
    if (a.step === "finalize") {
      if (invoice.status === "draft") {
        if (invoice.starting_balance !== 0) return this.transition(a, "reconcile");
        await this.stripe.post(`/v1/invoices/${a.invoice}/finalize`, { auto_advance: false }, key);
      }
      return this.advance(a, "prepare");
    }
    if (a.step === "prepare") {
      if (invoice.status !== "open") return this.observe(a, invoice);
      const card = await this.billing.payments!.defaultCard(a.tenant);
      if (!card) return this.transition(a, "paused_no_card", invoice);
      if (card.customer !== a.customer) return this.transition(a, "reconcile");
      return this.advance(a, "pay", { card });
    }
    if (a.step === "pay") {
      if (invoice.status !== "open") return this.observe(a, invoice);
      if (invoice.amount_due !== total) return this.transition(a, "reconcile");
      try { await this.stripe.post(`/v1/invoices/${a.invoice}/pay`, { payment_method: a.card.id, off_session: true }, key); }
      catch (error) { if (!(error instanceof StripeError && (error.status === 402 || error.code === "resource_missing"))) throw error; }
      return this.advance(a, "observe");
    }
    return this.observe(a, invoice);
  }
  private owns(a: any, invoice: any) {
    return typeof invoice.id === "string" && invoice.id.startsWith("in_") && (!a.invoice || invoice.id === a.invoice)
      && stripeId(invoice.customer) === a.customer && invoice.livemode === this.stripe.live
      && invoice.metadata?.purpose === "agent-runtime-auto-topup" && invoice.metadata?.attempt === a.id;
  }
  private async observe(a: any, invoice: any) {
    const payments = await this.stripe.get("/v1/invoice_payments", { invoice: a.invoice, limit: 100, expand: ["data.payment.payment_intent.payment_method"] });
    const rows = payments.data ?? [], total = (a.amount+a.fee)/CENT;
    if (payments.has_more || rows.length !== 1) return this.transition(a, "reconcile", invoice);
    const payment = rows[0], pi = payment.payment?.payment_intent;
    if (payment.payment?.type !== "payment_intent" || !pi || typeof pi !== "object" || typeof pi.id !== "string" || !pi.id.startsWith("pi_") || stripeId(payment.invoice) !== a.invoice
      || stripeId(pi.customer) !== a.customer || pi.livemode !== this.stripe.live || pi.amount !== total || pi.currency !== "usd") return this.transition(a, "reconcile", invoice);
    if (invoice.status === "paid") {
      const method = pi.payment_method;
      const actualCard = method?.type === "card" ? { brand: method.card.brand, last4: method.card.last4, expMonth: method.card.exp_month, expYear: method.card.exp_year }
        : stripeId(method) === a.card.id ? displayCard(a.card) : null;
      if (payment.status !== "paid" || payment.amount_paid !== total || invoice.amount_paid !== total || pi.status !== "succeeded" || pi.amount_received !== total) return this.transition(a, "reconcile", invoice);
      await transaction(this.db, async sql => {
        await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-runtime-payment:${pi.id}`]);
        await this.lock(sql, a.tenant);
        const fresh = (await sql.query(`select * from billing_auto_attempts where id=$1 and lease=$2 and ${active} for update`, [a.id, a.lease])).rows[0];
        if (!fresh) return;
        const invoiceUrl = this.invoiceUrl(invoice);
        await this.billing.fulfillPurchase(sql, { tenant: a.tenant, kind: "purchase", amount: a.amount, key: `purchase:auto:${a.id}`,
          metadata: { autoTopup: true, attempt: a.id, invoice: a.invoice, invoiceUrl, paymentIntent: pi.id, paid: total, currency: "usd", card: actualCard } }, pi.id);
        await sql.query("update billing_auto_attempts set state='paid',paid_at=$2,payment_intent=$3,invoice_url=$4,lease=null,lease_until=0 where id=$1", [a.id, this.now(), pi.id, invoiceUrl]);
        const sums = await this.amounts(sql, a.tenant), balance = (await sql.query("select balance from credit_accounts where tenant=$1", [a.tenant])).rows[0].balance;
        await this.emit(sql, a.tenant, "receipt", { attempt: a.id, amount: a.amount, fee: a.fee, total: a.amount+a.fee, card: actualCard, balance, used: sums.used, monthlyLimit: a.monthly_limit, invoiceUrl }, a.id);
        await sql.query("update billing_email_outbox set state='cancelled' where tenant=$1 and kind='problems' and state='pending' and payload->'data'->>'attempt'=$2", [a.tenant, a.id]);
      });
      this.billing.invalidate([a.tenant]);
      return;
    }
    if (invoice.status !== "open") return this.transition(a, "reconcile", invoice);
    if (pi.status === "requires_action") return this.transition(a, "action_required", invoice);
    if (pi.status === "requires_payment_method") {
      const card = await this.billing.payments!.defaultCard(a.tenant);
      if (a.state === "paused_no_card" && card) return this.advance(a, "prepare", { generation: a.generation+1 });
      return this.transition(a, card ? "paused_declined" : "paused_no_card", invoice);
    }
    if (pi.status === "processing" || pi.status === "succeeded") return this.transition(a, "processing", invoice);
    return this.transition(a, "reconcile", invoice);
  }
  private invoiceUrl(invoice: any) { return typeof invoice.hosted_invoice_url === "string" && invoice.hosted_invoice_url.startsWith("https://") ? invoice.hosted_invoice_url : null; }
  private async advance(a: any, step: string, fields: { invoice?: string; card?: Card; generation?: number } = {}): Promise<void> {
    const next = (await this.db.query(`update billing_auto_attempts set step=$3,state='processing',step_started_at=null,invoice=coalesce($4,invoice),card=coalesce($5,card),generation=coalesce($6,generation),due=$7,lease_until=$7::bigint+60000 where id=$1 and lease=$2 and ${active} returning *`,
    [a.id, a.lease, step, fields.invoice ?? null, fields.card ?? null, fields.generation ?? null, this.now()])).rows[0];
    if (a.state === "paused_no_card") await this.db.query("update billing_email_outbox set state='cancelled' where tenant=$1 and kind='problems' and state='pending' and payload->'data'->>'attempt'=$2", [a.tenant, a.id]);
    if (next) await this.process(next);
  }
  private async transition(a: any, state: string, invoice?: any) {
    if (state === "reconcile") console.error(JSON.stringify({ type: "billing_reconciliation_required", kind: "auto_topup", attempt: a.id, step: a.step }));
    await transaction(this.db, async sql => {
      await this.lock(sql, a.tenant);
      const fresh = (await sql.query(`update billing_auto_attempts set state=$3,invoice_url=coalesce($4,invoice_url),due=$5,lease_until=0,lease=null,action_expires_at=case when $3='action_required' then coalesce(action_expires_at,$6) else action_expires_at end
        where id=$1 and lease=$2 and ${active} returning id`, [a.id, a.lease, state, invoice ? this.invoiceUrl(invoice) : null, this.now()+(state === "processing" ? 30_000 : HOUR), this.now()+24*HOUR])).rows[0];
      if (!fresh || a.state === state || state === "processing") return;
      const notice = state === "paused_declined" ? "declined" : state === "paused_no_card" ? "no_card" : state === "action_required" ? "action_required" : "reconcile";
      await this.emit(sql, a.tenant, notice, { attempt: a.id, generation: a.generation, total: a.amount+a.fee, card: displayCard(a.card), invoiceUrl: invoice ? this.invoiceUrl(invoice) : a.invoice_url }, `${a.id}:${a.generation}:${state}`);
    });
  }
  private async cancelInvoice(a: any): Promise<void> {
    const invoice = await this.stripe.get(`/v1/invoices/${a.invoice}`);
    if (!this.owns(a, invoice) || invoice.total !== (a.amount+a.fee)/CENT || invoice.currency !== "usd") return this.transition(a, "reconcile", invoice);
    if (invoice.status === "paid") return this.observe(a, invoice);
    if (invoice.amount_paid !== 0) return this.transition(a, "reconcile", invoice);
    if (invoice.status !== "void") {
      if (invoice.status !== "open") return this.transition(a, "reconcile", invoice);
      const payments = await this.stripe.get("/v1/invoice_payments", { invoice: a.invoice, limit: 100, expand: ["data.payment.payment_intent"] });
      if (payments.has_more) return this.transition(a, "reconcile", invoice);
      for (const p of payments.data ?? []) {
        const pi = p.payment?.payment_intent;
        if (p.payment?.type !== "payment_intent" || stripeId(p.invoice) !== a.invoice || stripeId(pi?.customer) !== a.customer
          || pi?.livemode !== this.stripe.live || pi?.currency !== "usd" || pi?.amount !== (a.amount+a.fee)/CENT) return this.transition(a, "reconcile", invoice);
        if (["processing", "succeeded"].includes(pi.status)) return this.transition(a, "processing", invoice); // Retain the hold while settling.
        if (!["requires_payment_method", "requires_action", "canceled"].includes(pi.status)) return this.transition(a, "reconcile", invoice);
      }
      const voided = await this.stripe.post(`/v1/invoices/${a.invoice}/void`, {}, `camelrun:topup:${a.id}:void`);
      if (!this.owns(a, voided) || voided.status !== "void" || voided.amount_paid !== 0) return this.transition(a, "reconcile", voided);
    }
    await transaction(this.db, async sql => {
      await this.lock(sql, a.tenant);
      const cancelled = await sql.query(`update billing_auto_attempts set state='cancelled',lease=null,lease_until=0 where id=$1 and lease=$2 and ${active} returning id`, [a.id, a.lease]);
      if (cancelled.rowCount && a.cancel_reason === "expired") {
        await sql.query("update billing_auto_settings set status='paused_expired',version=version+1 where tenant=$1 and livemode=$2", [a.tenant, this.stripe.live]);
      }
    });
  }
  /** Called after a committed usage flush; only the database is on its critical path. */
  async balanceChanged(tenants: Iterable<string>) {
    const ids = [...tenants]; if (!ids.length) return;
    await this.db.query(`update billing_auto_settings s set checked_at=0 from credit_accounts c where s.tenant=c.tenant and s.tenant=any($1::text[]) and s.livemode=$2 and s.enabled
      and s.status not in ('paused_no_card','paused_expired') and (s.status<>'limit_reached' or coalesce(s.limit_resets_at,0)<=$3) and c.balance<s.threshold`, [ids, this.stripe.live, this.now()]);
    if (this.timer) void this.pump().catch(() => console.error(JSON.stringify({ type: "auto_topup_poll_failed" })));
  }
  /** An authenticated portal return wakes paused work without authorizing a new retry. */
  async refresh(tenant: string) {
    await this.guard(tenant);
    await this.db.query("update billing_auto_settings set checked_at=0 where tenant=$1 and livemode=$2", [tenant, this.stripe.live]);
    await this.db.query(`update billing_auto_attempts set due=$3 where tenant=$1 and livemode=$2 and state in ('paused_no_card','action_required','paused_declined')`, [tenant, this.stripe.live, this.now()]);
    return this.get(tenant);
  }
  async wake(invoice: string) { await this.db.query(`update billing_auto_attempts set due=$3 where invoice=$1 and livemode=$2 and ${active} and state <> 'reconcile'`, [invoice, this.stripe.live, this.now()]); }
}
