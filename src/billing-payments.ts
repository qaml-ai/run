import { randomInt, randomUUID } from "node:crypto";
import type { Db, Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { purchaseFee, type Pricing } from "./pricing.ts";
import { Stripe, StripeError, STRIPE_API_VERSION } from "./stripe.ts";

const PURPOSE = "agent-runtime-credit";
const CENT = 10_000;
// Stripe may prune keys after 24 hours. Never repeat an ambiguous create that late.
const SAFE_RETRY_MS = 23 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const stripeId = (value: any): string | undefined => typeof value === "string" ? value : typeof value?.id === "string" ? value.id : undefined;
export interface CheckoutOrder {
  id: string; tenant: string; livemode: boolean; request_id: string; customer: string;
  amount: number; fee: number; currency: string; api_version: string; parameters: Record<string, unknown>;
  session: string | null; invoice: string | null; payment_intent: string | null; url: string | null;
  created_at: number; expires_at: number | null; paid_at: number | null;
}

/** Stripe owns card entry, default-card selection and invoices. This class owns durable request identity. */
export class BillingPayments {
  private readonly db: Db;
  private readonly stripe: Stripe;
  private readonly pricing: Pricing;
  private readonly page: string;
  private portalCheckedUntil = 0;
  constructor(db: Db, stripe: Stripe, pricing: Pricing, publicUrl?: string) {
    this.db = db; this.stripe = stripe; this.pricing = pricing;
    this.page = `${publicUrl ?? ""}/console/billing`;
  }

  private requirePage() {
    let url: URL;
    try { url = new URL(this.page); } catch { throw new HttpError(503, "The billing return URL is not configured"); }
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new HttpError(503, "The billing return URL must use HTTPS");
    }
  }

  /** A durable key per tenant and Stripe environment; network work never holds a balance lock. */
  async customer(tenant: string, create = true): Promise<string | undefined> {
    let row = (await this.db.query("select * from billing_stripe_customers where tenant=$1 and livemode=$2", [tenant, this.stripe.live])).rows[0];
    if (row?.customer) return row.customer;
    const legacy = (await this.db.query("select stripe_customer from credit_accounts where tenant=$1", [tenant])).rows[0]?.stripe_customer;
    if (legacy) {
      let customer;
      try { customer = await this.stripe.get(`/v1/customers/${encodeURIComponent(legacy)}`); }
      catch (error) { if (!(error instanceof StripeError && error.status === 404 && error.code === "resource_missing")) throw error; }
      if (customer && !customer.deleted && customer.livemode === this.stripe.live && customer.metadata?.purpose === PURPOSE && customer.metadata?.tenant === tenant) {
        await this.db.query(`insert into billing_stripe_customers (tenant,livemode,request_id,customer,created_at) values ($1,$2,$3,$4,$5)
          on conflict (tenant,livemode) do update set customer=coalesce(billing_stripe_customers.customer,excluded.customer)`, [tenant, this.stripe.live, randomUUID(), legacy, Date.now()]);
        return (await this.db.query("select customer from billing_stripe_customers where tenant=$1 and livemode=$2", [tenant, this.stripe.live])).rows[0].customer;
      }
    }
    if (!create) return undefined;
    await this.db.query(`insert into billing_stripe_customers (tenant,livemode,request_id,created_at) values ($1,$2,$3,$4) on conflict do nothing`, [tenant, this.stripe.live, randomUUID(), Date.now()]);
    row = (await this.db.query("select * from billing_stripe_customers where tenant=$1 and livemode=$2", [tenant, this.stripe.live])).rows[0];
    if (row.customer) return row.customer;
    if (Date.now() - row.created_at >= SAFE_RETRY_MS) {
      // A duplicate empty Customer cannot charge anyone. Rotate an abandoned
      // create instead of permanently blocking purchases. Fence late responses.
      await this.db.query(`update billing_stripe_customers set request_id=$3,created_at=$4
        where tenant=$1 and livemode=$2 and customer is null and request_id=$5`,
      [tenant, this.stripe.live, randomUUID(), Date.now(), row.request_id]);
      return this.customer(tenant, create);
    }
    const customer = await this.stripe.post("/v1/customers", { name: tenant, metadata: { purpose: PURPOSE, tenant } }, `camelrun:customer:${row.request_id}`);
    if (!/^cus_[A-Za-z0-9_]+$/.test(customer.id) || customer.livemode !== this.stripe.live) throw new HttpError(502, "Unexpected Stripe customer");
    const saved = (await this.db.query(`update billing_stripe_customers set customer=coalesce(customer,$3)
      where tenant=$1 and livemode=$2 and request_id=$4 returning customer`, [tenant, this.stripe.live, customer.id, row.request_id])).rows[0];
    if (!saved) return this.customer(tenant, create);
    if (saved.customer !== customer.id) return this.reconcile("customer_conflict", row.request_id);
    return saved.customer;
  }

  private reconcile(kind: string, id: string): never {
    console.error(JSON.stringify({ type: "billing_reconciliation_required", kind, id }));
    throw new HttpError(409, "This billing request needs reconciliation. Contact support@camelai.com before trying again.");
  }

  async checkout(tenant: string, amount: number, requestId: string = randomUUID()) {
    this.requirePage();
    if (!UUID.test(requestId)) throw new HttpError(400, "requestId must be a UUID");
    let order: CheckoutOrder | undefined = (await this.db.query("select * from billing_checkouts where tenant=$1 and livemode=$2 and request_id=$3", [tenant, this.stripe.live, requestId])).rows[0];
    if (!order) {
      const customer = await this.customer(tenant);
      const fee = purchaseFee(this.pricing, amount), id = randomUUID();
      const metadata = { purpose: PURPOSE, tenant, credit: String(amount), order: id };
      const parameters = {
        mode: "payment", customer, client_reference_id: id, metadata, payment_intent_data: { metadata },
        invoice_creation: { enabled: true, invoice_data: { metadata } },
        integration_identifier: `camelrun-credit-${Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join("")}`,
        line_items: [
          { quantity: 1, price_data: { currency: "usd", unit_amount: amount / CENT, product_data: { name: "camelRun credit" } } },
          ...(fee ? [{ quantity: 1, price_data: { currency: "usd", unit_amount: fee / CENT, product_data: { name: `Processing fee (${this.pricing.purchaseFeeBps / 100}%)` } } }] : []),
        ],
        success_url: `${this.page}?checkout=success&session={CHECKOUT_SESSION_ID}`, cancel_url: `${this.page}?checkout=cancelled`,
      };
      await this.db.query(`insert into billing_checkouts (id,tenant,livemode,request_id,customer,amount,fee,currency,api_version,parameters,created_at)
        values ($1,$2,$3,$4,$5,$6,$7,'usd',$8,$9,$10) on conflict (tenant,livemode,request_id) do nothing`,
      [id, tenant, this.stripe.live, requestId, customer, amount, fee, STRIPE_API_VERSION, JSON.stringify(parameters), Date.now()]);
      order = (await this.db.query("select * from billing_checkouts where tenant=$1 and livemode=$2 and request_id=$3", [tenant, this.stripe.live, requestId])).rows[0];
    }
    if (!order || order.amount !== amount) throw new HttpError(409, "This requestId was already used for a different credit amount");
    if (order.paid_at) throw new HttpError(409, "This purchase is already paid. Refresh your balance.");
    let session;
    if (order.session) session = await this.stripe.get(`/v1/checkout/sessions/${encodeURIComponent(order.session)}`);
    else {
      if (Date.now() - order.created_at >= SAFE_RETRY_MS || order.api_version !== STRIPE_API_VERSION) return this.reconcile("checkout", order.id);
      session = await this.stripe.post("/v1/checkout/sessions", order.parameters, `camelrun:checkout:${order.id}`);
    }
    this.validate(order, session);
    if (session.status !== "open" || !session.url) throw new HttpError(409, "This Checkout session is no longer open. Refresh your balance before starting a new purchase.");
    const result = await this.db.query(`update billing_checkouts set session=$2,url=$3,expires_at=$4 where id=$1 and (session is null or session=$2) returning id`, [order.id, session.id, session.url, session.expires_at * 1000]);
    if (!result.rowCount) return this.reconcile("checkout_conflict", order.id);
    return { id: session.id as string, url: session.url as string, amount: order.amount, fee: order.fee, total: order.amount + order.fee };
  }

  /** Resolve by first-class Stripe id, with the saved order id as the early-webhook fallback. */
  async purchase(session: any): Promise<CheckoutOrder | undefined> {
    const hint = typeof session.metadata?.order === "string" && UUID.test(session.metadata.order) ? session.metadata.order : null;
    const order: CheckoutOrder | undefined = (await this.db.query("select * from billing_checkouts where session=$1 or id=$2::uuid", [typeof session.id === "string" ? session.id : null, hint])).rows[0];
    if (order) { this.validate(order, session); return order; }
    if (session.metadata?.order) throw new HttpError(400, "Unknown billing order");
    const before = (await this.db.query("select created_before from billing_checkout_cutover")).rows[0].created_before;
    if (!Number.isSafeInteger(session.created) || session.created > before || session.livemode !== this.stripe.live) {
      throw new HttpError(400, "Checkout session has no recorded billing order");
    }
    return undefined;
  }

  private validate(order: CheckoutOrder, session: any) {
    if (typeof session.id !== "string" || !session.id.startsWith("cs_") || (order.session && order.session !== session.id)
      || order.livemode !== this.stripe.live || session.livemode !== order.livemode || stripeId(session.customer) !== order.customer
      || session.mode !== "payment" || session.currency !== order.currency || session.amount_total !== (order.amount + order.fee) / CENT
      || session.client_reference_id !== order.id || session.metadata?.order !== order.id) {
      throw new HttpError(400, "Stripe Checkout does not match the recorded purchase");
    }
  }

  async recordPaid(sql: Sql, order: CheckoutOrder, session: any, paymentIntent: string) {
    const invoice = stripeId(session.invoice) ?? null;
    const updated = await sql.query(`update billing_checkouts set session=$2, payment_intent=$3, invoice=coalesce(invoice,$4), paid_at=coalesce(paid_at,$5)
      where id=$1 and (session is null or session=$2) and (payment_intent is null or payment_intent=$3) and (invoice is null or $4::text is null or invoice=$4)
      returning id`, [order.id, session.id, paymentIntent, invoice, Date.now()]);
    if (!updated.rowCount) throw new HttpError(400, "Checkout conflicts with its recorded payment");
  }

  /** Redirect-only card entry. The portal sets the Customer's default payment method itself. */
  async portal(tenant: string, flow: "manage" | "payment_method" = "manage", resumeAutoTopup = false) {
    this.requirePage();
    const configuration = this.stripe.portalConfiguration;
    if (!configuration) throw new HttpError(503, "The billing portal is not configured");
    if (Date.now() >= this.portalCheckedUntil) {
      const config = await this.stripe.get(`/v1/billing_portal/configurations/${configuration}`);
      if (!config.active || config.livemode !== this.stripe.live || config.metadata?.purpose !== PURPOSE
      || !config.features?.payment_method_update?.enabled || !config.features?.invoice_history?.enabled
      || config.features?.subscription_update?.enabled || config.features?.subscription_cancel?.enabled) {
        throw new HttpError(503, "The billing portal configuration does not match this product");
      }
      this.portalCheckedUntil = Date.now()+3*60_000;
    }
    const customer = await this.customer(tenant, flow === "payment_method");
    if (!customer) throw new HttpError(409, "Add credit or set up a payment method first");
    const result = await this.stripe.post("/v1/billing_portal/sessions", {
      customer, configuration, return_url: this.page,
      ...(flow === "payment_method" ? { flow_data: { type: "payment_method_update", after_completion: { type: "redirect", redirect: { return_url: `${this.page}?payment_method=updated${resumeAutoTopup ? "&resume=auto-topup" : ""}` } } } } : {}),
    });
    if (typeof result.url !== "string" || !result.url.startsWith("https://")) throw new HttpError(502, "Unexpected billing portal response");
    return { url: result.url as string };
  }

  async attachInvoice(invoice: any) {
    if (typeof invoice.id !== "string") return;
    const order = (await this.db.query("select * from billing_checkouts where invoice=$1", [invoice.id])).rows[0];
    if (!order) return;
    if (invoice.status !== "paid" || stripeId(invoice.customer) !== order.customer || invoice.livemode !== order.livemode
      || invoice.currency !== order.currency || invoice.total !== (order.amount+order.fee)/CENT) throw new HttpError(400, "Invoice does not match its purchase");
    if (typeof invoice.hosted_invoice_url === "string" && invoice.hosted_invoice_url.startsWith("https://")) {
      await this.db.query("update billing_checkouts set invoice_url=$2 where id=$1", [order.id, invoice.hosted_invoice_url]);
    }
  }

  async refreshInvoices() {
    const orders = (await this.db.query("select * from billing_checkouts where livemode=$1 and paid_at is not null and invoice_url is null order by paid_at desc limit 5", [this.stripe.live])).rows;
    for (const order of orders) {
      try {
        let id = order.invoice;
        if (!id) {
          const session = await this.stripe.get(`/v1/checkout/sessions/${encodeURIComponent(order.session)}`);
          this.validate(order, session);
          id = stripeId(session.invoice);
          if (!id) continue;
          await this.db.query("update billing_checkouts set invoice=$2 where id=$1 and invoice is null", [order.id, id]);
        }
        await this.attachInvoice(await this.stripe.get(`/v1/invoices/${encodeURIComponent(id)}`));
      } catch { console.error(JSON.stringify({ type: "billing_invoice_refresh_failed", order: order.id })); }
    }
  }

  async defaultCard(tenant: string) {
    const customer = await this.customer(tenant, false);
    if (!customer) return null;
    const row = await this.stripe.get(`/v1/customers/${encodeURIComponent(customer)}`, { expand: ["invoice_settings.default_payment_method"] });
    if (row.deleted || row.id !== customer || row.livemode !== this.stripe.live) throw new HttpError(409, "The billing customer needs reconciliation");
    const method = row.invoice_settings?.default_payment_method;
    if (method?.type !== "card" || stripeId(method.customer) !== customer) return null;
    return { customer, id: method.id as string, brand: method.card.brand as string, last4: method.card.last4 as string,
      expMonth: method.card.exp_month as number, expYear: method.card.exp_year as number };
  }

  async paymentMethod(tenant: string) {
    const customerId = await this.customer(tenant, false);
    if (!customerId) return { portal: !!this.stripe.portalConfiguration, customer: false, card: null };
    const customer = await this.stripe.get(`/v1/customers/${encodeURIComponent(customerId)}`, { expand: ["invoice_settings.default_payment_method"] });
    if (customer.deleted || customer.id !== customerId || customer.livemode !== this.stripe.live) throw new HttpError(409, "The billing customer needs reconciliation");
    const method = customer.invoice_settings?.default_payment_method;
    const card = method?.type === "card" && stripeId(method.customer) === customerId ? method.card : null;
    // A returned payment method is display data, never permission to start automatic charges.
    return { portal: !!this.stripe.portalConfiguration, customer: true, card: card ? { brand: card.brand as string, last4: card.last4 as string, expMonth: card.exp_month as number, expYear: card.exp_year as number } : null };
  }
}
